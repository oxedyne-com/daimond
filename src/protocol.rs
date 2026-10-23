//! WS protocol types for Daimond — JDAT serialisation.
//!
//! All messages between the browser and Steel use the existing syntax
//! protocol with JDAT values.  This module defines the command and
//! response types and their JDAT conversion functions.

use crate::tools::CallOutcome;

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_jdat::prelude::*;
use oxedyne_fe2o3_sbj::share;

use std::cell::RefCell;


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
    pub fn elision(&self, why: Dropped) -> String {
        match why {
            Dropped::ToFit => fmt!(
                "[image {} ({}, {} bytes) was dropped to fit the context window; read it again if \
                 you need to look at it]", self.source, self.media.mime(), self.data.len()),
            // Deliberately NOT "read it again": on this endpoint that is a loop, and the whole
            // point is that this model will never see the picture however often it is fetched.
            // It is told not to describe it, because the failure a missing image invites is a
            // confident description of something nobody showed it.
            Dropped::Unseeable => fmt!(
                "[image {} ({}, {} bytes) was left out because this model cannot be shown \
                 pictures. Do not describe what it looks like -- you have not seen it. Say so, \
                 and read it with \"as\":\"base64\" if you need its bytes to embed it]",
                self.source, self.media.mime(), self.data.len()),
            // The three below name WHERE the verdict came from, so that a model which repeats
            // them to the owner repeats a fact and not a guess about its own eyes.
            Dropped::Listed => fmt!(
                "[image {} ({}, {} bytes) was left out because the provider's model list shows \
                 this model as text-only. Do not describe what it looks like -- you have not \
                 seen it. Tell the owner, and that an image model under Workers, images fixes \
                 it; read it with \"as\":\"base64\" if you need its bytes]",
                self.source, self.media.mime(), self.data.len()),
            Dropped::Refused => fmt!(
                "[image {} ({}, {} bytes) was left out because the provider refused the request \
                 that carried it, though its model list shows this model takes pictures: a fault \
                 in the request or the route, not blindness. Do not describe what it looks like. \
                 Say it was refused and not that you cannot see; try a smaller picture]",
                self.source, self.media.mime(), self.data.len()),
            // The model sees: it is the picture's size the provider would not take, so the
            // words say that and ask for a smaller one, never that the model is blind.
            Dropped::TooLarge => fmt!(
                "[image {} ({}, {} bytes) was left out because it is too large for the provider \
                 to take; that is no sign you cannot see pictures. Do not describe what it looks \
                 like -- you have not seen it. Tell the owner the picture was too large, and that \
                 a smaller one will do]",
                self.source, self.media.mime(), self.data.len()),
            Dropped::Unconfirmed => fmt!(
                "[image {} ({}, {} bytes) was not sent: Daimond cannot confirm that this model \
                 reads pictures, as its provider's model list does not say. That is a gap in \
                 Daimond and no proof that you cannot see. Do not describe what it looks like -- \
                 you have not seen it. Tell the owner, and that choosing the model from the \
                 provider's list or an image model under Workers, images fixes it; read it with \
                 \"as\":\"base64\" if you need its bytes]",
                self.source, self.media.mime(), self.data.len()),
        }
    }
}

/// Why a picture came out of a message.
///
/// The two reasons want different words and the difference is load-bearing, so they are a type
/// rather than a boolean: one says "ask again", the other says "asking again will not help".
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Dropped {
    /// Elided to fit the context window. The picture is still there to be fetched.
    ToFit,
    /// The endpoint will not take pictures at all, so fetching it again changes nothing.
    Unseeable,
    /// The provider's model list shows the model as text-only.
    Listed,
    /// The provider refused a request that carried one, though its list shows the model sees.
    Refused,
    /// Nothing says the model reads pictures: the list is silent and the model is unknown.
    Unconfirmed,
    TooLarge,   // refused for its size; the model may well see
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

    /// The same content with `lead` and a blank line in front of its words.
    ///
    /// The lead goes before the first text part, so a picture keeps its place among the words.
    /// Content with no text in it, a picture alone, has no words to be put in front of, so the
    /// lead becomes a text part of its own at the head.
    pub fn led_by(&self, lead: &str) -> Self {
        match self {
            Self::Text(s) => Self::Text(fmt!("{}\n\n{}", lead, s)),
            Self::Parts(parts) => {
                let mut out = parts.clone();
                let first = out.iter_mut().find_map(|p| match p {
                    ContentPart::Text(t)  => Some(t),
                    ContentPart::Image(_) => None,
                });
                match first {
                    Some(t) => *t = fmt!("{}\n\n{}", lead, t),
                    None    => out.insert(0, ContentPart::Text(lead.to_string())),
                }
                Self::Parts(out)
            },
        }
    }

    /// The same content with `tail` added straight after its last text, no separator: the app's
    /// notes on a tool result carry their own leading newline.  Content with no text in it gets
    /// `tail` as a text part of its own at the end.
    pub fn trailed_by(&self, tail: &str) -> Self {
        match self {
            Self::Text(s) => Self::Text(fmt!("{}{}", s, tail)),
            Self::Parts(parts) => {
                let mut out = parts.clone();
                let last = out.iter_mut().rev().find_map(|p| match p {
                    ContentPart::Text(t)  => Some(t),
                    ContentPart::Image(_) => None,
                });
                match last {
                    Some(t) => t.push_str(tail),
                    None    => out.push(ContentPart::Text(tail.to_string())),
                }
                Self::Parts(out)
            },
        }
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
    pub fn without_images(&self, why: Dropped) -> Self {
        match self {
            Self::Text(_) => self.clone(),
            Self::Parts(parts) => Self::parts(parts.iter().map(|p| match p {
                ContentPart::Text(t)  => ContentPart::Text(t.clone()),
                ContentPart::Image(i) => ContentPart::Text(i.elision(why)),
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


/// Whether a tool result goes out whole or as the stub it was first sent as (r578d), and when it
/// was shortened.  See [`ChatMessage::as_retired`].
///
/// **When matters (r578f, QA r578e C1/C2, D-20261020-11).**  Past the line a conversation is
/// shortened once and then appends until the summary, and a fold keeps its newest messages exactly
/// as they were, marks and all.  A mark carried through a fold is not a shortening of the folded
/// conversation, so it is told apart from one made since; see `compact::shortened`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Retired {
    No,		// sent whole
    Now,	// sent short, retired since the conversation last folded
    Before,	// sent short, retired before a fold that kept it
}

/// A single message in a conversation, mirroring the OpenAI API format.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChatMessage {
    System { content: MessageContent },
    User { content: MessageContent, pre: String, mid: String, opens: bool },	// `pre`: the app's note; `mid`: the transcript row; empty for none; `opens`: see `opening`
    /// Assistant turn, with whatever tool calls it asked for.
    ///
    /// The calls are part of the message and are persisted with it.  They used to be
    /// dropped on the way to storage, which made a reloaded session illegal rather than
    /// merely lossy: the assistant turn came back bare and the `tool` replies that
    /// followed it answered nothing, and an OpenAI-compatible provider rejects that
    /// outright on every subsequent turn.
    Assistant { content: MessageContent, tool_calls: Vec<ToolCall> },
    /// Tool call result returned to the LLM.
    Tool { tool_call_id: String, content: MessageContent, post: String, retired: Retired },	// `post`: the app's notes after the result, empty for none; `retired`: see `as_retired`
}

impl ChatMessage {

    /// A system message.  One call, because the common case is a bare string.
    pub fn system<C: Into<MessageContent>>(content: C) -> Self {
        Self::System { content: content.into() }
    }

    /// A user message.
    pub fn user<C: Into<MessageContent>>(content: C) -> Self {
        Self::User { content: content.into(), pre: String::new(), mid: String::new(), opens: false }
    }

    /// A user message that carries an app note beside the person's words.
    pub fn user_noted<C: Into<MessageContent>>(content: C, pre: String) -> Self {
        Self::User { content: content.into(), pre, mid: String::new(), opens: false }
    }

    /// The same message tied to the transcript row it was said as, by that row's id.  Every other
    /// role, and an empty id, comes back unchanged.
    ///
    /// The page pairs its transcript with this list by the id and never by the words, because two
    /// turns can say the same thing ("continue", twice) and a pairing by text then files one
    /// turn's place under the other's.
    pub fn marked(self, mid: String) -> Self {
        match self {
            Self::User { content, pre, opens, .. } if !mid.is_empty() =>
                Self::User { content, pre, mid, opens },
            other => other,
        }
    }

    /// The same user message marked as the one a turn opened with; every other role comes back
    /// unchanged.
    ///
    /// **Structure, never text** (r578d, QA-B B1).  A conversation holds user messages the person
    /// never typed: a Diamond turn ends with the app's own notes ("this turn changed N files",
    /// the reconcile line, a failed load proof), and an interjection lands mid-turn.  Counting
    /// those as turns put `compact::prior_end`'s boundary on the app's last note, so "keep the
    /// last turn whole" retired the turn just finished.  Only the message a turn is run on is
    /// marked, where it is pushed, and the mark travels with it through the store and the page.
    pub fn opening(self) -> Self {
        match self {
            Self::User { content, pre, mid, .. } => Self::User { content, pre, mid, opens: true },
            other => other,
        }
    }

    /// The message a transcript row is, as the page seeds a conversation from it: a person's
    /// words with the app's note `pre` and the row's id `mid`, or an assistant's prose; any other
    /// role is `None` (the system prompt is prepended per request, never stored, and a tool row
    /// carries no call id to pair).  The one reading of a row, shared by the tab
    /// (`DaimondApp::append_message`, `DaimondApp::restore`) and a runner's child seeding an
    /// errand's thread, so both send the model the same history.  A transcript's user rows are
    /// what turns were run on, so each is marked as opening one (r578d; see
    /// [`ChatMessage::opening`]); [`ChatMessage::of_row_opening`] says otherwise for a row the
    /// page knows no turn was run on.
    pub fn of_row(role: &str, content: String, pre: String, mid: String) -> Option<Self> {
        Self::of_row_opening(role, content, pre, mid, true)
    }

    /// [`ChatMessage::of_row`], a user row opening a turn only where `opens`: false for an
    /// interjection or the app's own note (QA r578d-B B3), which would otherwise put
    /// `compact::prior_end`'s boundary on it.
    pub fn of_row_opening(role: &str, content: String, pre: String, mid: String, opens: bool)
        -> Option<Self>
    {
        match role {
            "user"      => Some(Self::user_noted(content, pre).marked(mid).opening_if(opens)),
            "assistant" => Some(Self::assistant(content)),
            _           => None,
        }
    }

    /// [`ChatMessage::opening`] where `opens`, else the message unchanged: for a row the page
    /// rebuilds, which says itself whether a turn was run on it (QA r578d-B B3).
    pub fn opening_if(self, opens: bool) -> Self {
        if opens { self.opening() } else { self }
    }

    /// Did a turn open with this message?  See [`ChatMessage::opening`].
    pub fn opens_turn(&self) -> bool {
        matches!(self, Self::User { opens: true, .. })
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
        Self::Tool { tool_call_id, content: content.into(), post: String::new(), retired: Retired::No }
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
            Self::User { content, pre, mid, opens } => {
                m.insert(dat!("role"), dat!("user"));
                if *opens {
                    m.insert(dat!("opens"), Dat::Bool(true));
                }
                m.insert(dat!("content"), content.to_dat());
                // Written only when there is a note, so an ordinary message's map is the shape
                // it always was and a reader of an older snapshot sees nothing new.  Beside the
                // words and never in them: that is what keeps the app's note from being read
                // back later as something the person said.
                if !pre.is_empty() {
                    m.insert(dat!("pre"), dat!(pre.clone()));
                }
                if !mid.is_empty() {
                    m.insert(dat!("mid"), dat!(mid.clone()));
                }
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
            Self::Tool { tool_call_id, content, post, retired } => {
                m.insert(dat!("role"), dat!("tool"));
                // Only where it was, so a result never sent short is the map an r578c build wrote,
                // and one retired since the last fold the map an r578e build wrote.
                match retired {
                    Retired::No     => {},
                    Retired::Now    => { m.insert(dat!("retired"), Dat::Bool(true)); },
                    Retired::Before => {
                        m.insert(dat!("retired"), Dat::Bool(true));
                        m.insert(dat!("folded"), Dat::Bool(true));
                    },
                }
                m.insert(dat!("tool_call_id"), dat!(tool_call_id.clone()));
                m.insert(dat!("content"), content.to_dat());
                // Only where there is one, so an unnoted result is the map an r577 build wrote.
                if !post.is_empty() {
                    m.insert(dat!("post"), dat!(post.clone()));
                }
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
            "user" => {
                // Absent is a message with no note, and every snapshot written before the field
                // existed.  A `pre` that is not text is dropped rather than refusing the message,
                // as an unreadable image part is: half a conversation read back is worth more
                // than an error, and a lost note is the cheaper of the two losses.
                let pre = match m.get(&dat!("pre")) {
                    Some(Dat::Str(s)) => s.clone(),
                    _                 => String::new(),
                };
                let mid = match m.get(&dat!("mid")) {
                    Some(Dat::Str(s)) => s.clone(),
                    _                 => String::new(),
                };
                let opens = matches!(m.get(&dat!("opens")), Some(Dat::Bool(true)));
                Ok(Self::User { content, pre, mid, opens })
            }
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
                let post = match m.get(&dat!("post")) {
                    Some(Dat::Str(s)) => s.clone(),
                    _ => String::new(),
                };
                let retired = match (m.get(&dat!("retired")), m.get(&dat!("folded"))) {
                    (Some(Dat::Bool(true)), Some(Dat::Bool(true)))  => Retired::Before,
                    (Some(Dat::Bool(true)), _)                      => Retired::Now,
                    _                                               => Retired::No,
                };
                Ok(Self::Tool { tool_call_id, content, post, retired })
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

    /// The app's note on a user message: empty for none, and for every other role.
    pub fn pre(&self) -> &str {
        match self {
            Self::User { pre, .. } => pre,
            _                      => "",
        }
    }

    /// The app's notes after a tool result: empty for none, and for every other role.
    pub fn post(&self) -> &str {
        match self {
            Self::Tool { post, .. } => post,
            _                       => "",
        }
    }

    /// The same tool result with `line` added to the end of its notes; every other role comes
    /// back unchanged.
    pub fn noted_after(self, line: &str) -> Self {
        match self {
            Self::Tool { tool_call_id, content, post, retired } =>
                Self::Tool { tool_call_id, content, post: fmt!("{}{}", post, line), retired },
            other => other,
        }
    }

    /// The same tool result marked as sent in its retired form from now on; every other role comes
    /// back unchanged.  The content is NOT touched: the stored conversation keeps every word
    /// (daimond_rulings.md §17), and the mark is what lets every later request send the same stub,
    /// byte for byte, instead of the whole result again.  See `compact::restub`.
    ///
    /// A result already marked keeps its mark, so one carried through a fold stays carried.
    pub fn as_retired(self) -> Self {
        match self {
            Self::Tool { tool_call_id, content, post, retired: Retired::No } =>
                Self::Tool { tool_call_id, content, post, retired: Retired::Now },
            other => other,
        }
    }

    /// The same message as a fold keeps it: a result retired since the last fold now counts as
    /// retired before this one.  See [`Retired`].
    pub fn as_folded(self) -> Self {
        match self {
            Self::Tool { tool_call_id, content, post, retired: Retired::Now } =>
                Self::Tool { tool_call_id, content, post, retired: Retired::Before },
            other => other,
        }
    }

    /// Is this a tool result already sent in its retired form?  See [`ChatMessage::as_retired`].
    pub fn is_retired(&self) -> bool {
        matches!(self, Self::Tool { retired: Retired::Now | Retired::Before, .. })
    }

    /// Was this tool result retired since the conversation last folded?  See [`Retired`].
    pub fn retired_since_fold(&self) -> bool {
        matches!(self, Self::Tool { retired: Retired::Now, .. })
    }

    /// The transcript row a user message was said as: empty for none, and for every other role.
    pub fn mid(&self) -> &str {
        match self {
            Self::User { mid, .. } => mid,
            _                      => "",
        }
    }

    /// What this message carries, whole.
    pub fn content(&self) -> &MessageContent {
        match self {
            Self::System { content }
            | Self::User { content, .. }
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
            Self::User { pre, mid, opens, .. } =>
                Self::User { content, pre: pre.clone(), mid: mid.clone(), opens: *opens },
            Self::Assistant { tool_calls, .. } =>
                Self::Assistant { content, tool_calls: tool_calls.clone() },
            Self::Tool { tool_call_id, post, retired, .. } =>
                Self::Tool { tool_call_id: tool_call_id.clone(), content, post: post.clone(),
                    retired: *retired },
        }
    }
}


/// The conversation as a provider is sent it: each user message's app note, a blank line, then
/// the person's words; and each tool result's words, then its notes (`post`, r578).
///
/// **THE ONE PLACE A NOTE BECOMES TEXT.**  The session keeps `pre` and `content` apart, so the
/// transcript, the store and an export show only what the person typed, and this is where the two
/// are put together, once, for the request.  [`crate::llm::LlmClient`] calls it ahead of every
/// provider's body builder and no builder reads `pre` itself, so a provider cannot be added that
/// joins it twice or forgets to.
///
/// With no note anywhere the slice comes back as it came, uncopied, and the request is the very
/// bytes it was before notes existed.
///
/// # Arguments
/// * `msgs` - The conversation, oldest first, system message included.
pub fn join_notes(msgs: &[ChatMessage]) -> std::borrow::Cow<'_, [ChatMessage]> {
    if msgs.iter().all(|m| m.pre().is_empty() && m.post().is_empty()) {
        return std::borrow::Cow::Borrowed(msgs);
    }
    std::borrow::Cow::Owned(msgs.iter().map(|m| match m {
        ChatMessage::User { content, pre, mid, opens } if !pre.is_empty() =>
            ChatMessage::User { content: content.led_by(pre), pre: String::new(), mid: mid.clone(),
                opens: *opens },
        ChatMessage::Tool { tool_call_id, content, post, retired } if !post.is_empty() =>
            ChatMessage::Tool { tool_call_id: tool_call_id.clone(), content: content.trailed_by(post),
                post: String::new(), retired: *retired },
        other => other.clone(),
    }).collect())
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Session                                                        │
// └───────────────────────────────────────────────────────────────┘

/// The OpenRouter host a conversation is pinned to, for the model it was pinned under.
///
/// Asking OpenRouter for the host that answered the last round keeps the provider's prompt
/// cache warm: a hop to another host is a full-prompt miss (r578, 6% of in-turn rounds).  The
/// model is kept beside the host because a pin is only good for the model it was taken
/// under, so a model change makes it no pin at all.  See `LlmClient::settle_pin`.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HostPin {
    pub model:  String,
    pub host:   String,                                 // OpenRouter's display name, verbatim
}

pub const PIN_KEY: &str = "host_pin";               // no r577 reader decodes it, so loads unpinned there

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
    pub pin:                 Option<HostPin>,       // the conversation's OpenRouter host
}

impl Session {

    /// Read a session a turn may be holding, failing rather than panicking.
    ///
    /// A `RefCell` borrow taken while a turn holds the session mutably panics, and in
    /// the browser a panic poisons the whole engine.  A read that loses that race (an
    /// export from a run's end, say, while a killed turn's call is still in flight) is
    /// only a read that failed (check_final G1, the stray `export_session` panic).
    pub fn read_held<R, F: FnOnce(&Session) -> R>(cell: &RefCell<Session>, f: F) -> Outcome<R> {
        match cell.try_borrow() {
            Ok(s)  => Ok(f(&s)),
            Err(_) => Err(err!(
                "The session is held by a turn in flight, so it cannot be read now.";
                Invalid, Conflict)),
        }
    }

    /// Change a session a turn may be holding, failing rather than panicking, as
    /// [`Session::read_held`] reads one (check_last: `restore`, `restore_session` and
    /// `append_message` called in the window before a hung turn's poison).
    pub fn write_held<R, F: FnOnce(&mut Session) -> R>(cell: &RefCell<Session>, f: F) -> Outcome<R> {
        match cell.try_borrow_mut() {
            Ok(mut s)   => Ok(f(&mut s)),
            Err(_)      => Err(err!(
                "The session is held by a turn in flight, so it cannot be changed now.";
                Invalid, Conflict)),
        }
    }

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
            pin: None,
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
        if let Some(p) = &self.pin {
            let mut pm = DaticleMap::new();
            pm.insert(dat!("model"), dat!(p.model.clone()));
            pm.insert(dat!("host"),  dat!(p.host.clone()));
            m.insert(dat!(PIN_KEY), Dat::Map(pm));
        }
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
        // Optional as the two above are, and a malformed one is no pin rather than a refusal:
        // the worst it costs is one round on whichever host OpenRouter picks.
        let pin = match m.get(&dat!(PIN_KEY)) {
            Some(Dat::Map(pm)) => match (pm.get(&dat!("model")), pm.get(&dat!("host"))) {
                (Some(Dat::Str(model)), Some(Dat::Str(host))) if !host.is_empty() =>
                    Some(HostPin { model: model.clone(), host: host.clone() }),
                _ => None,
            },
            _ => None,
        };
        Ok(Self {
            id, name, created_at, model, messages,
            prompt_tokens, completion_tokens, last_prompt_tokens,
            cached_tokens, cost_usd, pin,
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
///
/// **TWO CALLERS SINCE 2026-08-28, and that is why it lives here rather than beside the restore.**
/// [`crate::wasm::app::DaimondApp::restore_session`] repairs a conversation coming back from the
/// store, and [`crate::agent::Agent`] repairs the round it is abandoning when a tool call dies on
/// the road: same rule, same edits, and the two must not be allowed to differ.  They did differ
/// for as long as only the first existed -- a live session held whatever the turn left in it, and
/// only a reload put it right.
///
/// # Arguments
/// * `msgs` - The conversation to repair, oldest first.
pub fn pair_up(msgs: Vec<ChatMessage>) -> Vec<ChatMessage> {
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
                    if let ChatMessage::Tool { tool_call_id, content, post, retired } = &msgs[k] {
                        if kept.iter().any(|tc| &tc.id == tool_call_id) {
                            out.push(ChatMessage::Tool {
                                tool_call_id: tool_call_id.clone(),
                                content:      content.clone(),
                                post:         post.clone(),
                                retired:      *retired,
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

// ┌───────────────────────────────────────────────────────────────┐
// │ Agent events                                                   │
// └───────────────────────────────────────────────────────────────┘

/// Events emitted by the agent loop, sent to the client over WS.
#[derive(Clone, Debug)]
pub enum AgentEvent {
    /// Streamed LLM response text (a token or chunk).
    Text(String),
    /// The agent is invoking a tool (name + raw JSON args).
    ToolCall { id: String, name: String, args: String },
    /// A tool returned a result: its name, the reply text, and what the call came to.
    ///
    /// The outcome travels because the tool layer is the only place that knows it.  It used to be
    /// flattened into the reply's opening word and read back out of the prose by four separate
    /// consumers, each with its own reading -- so a refusal, whose sentence opens "Refused" rather
    /// than "Error", was drawn as a completed step, journalled as a success and reported to the
    /// Optimiser as a tool that had worked.  A daimon has nothing to check that against, and
    /// reports the turn done.
    ///
    /// `class` is where a destructive call's path sat -- [`crate::tools::PathClass::wire`], empty
    /// for any other call -- so the lens can say how far a delete reached without the path.
    /// `paused` is the pause node that refused the call ([`crate::tools::paused_node`]), empty
    /// for any other call, so the page names the control without reading the sentence back.
    ToolResult { name: String, result: String, outcome: CallOutcome, class: String, paused: String },
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
    ///
    /// `model` and `sp` say who wrote the summary -- the model as sent and the fingerprint of the
    /// compactor's instructions -- and are empty where the fold shortened without summarising.
    ///
    /// `cut` is where the fold cut and `summarised` whether a summary was asked for, so the feed
    /// can tell a fold that freed the history from one that re-summarised a note.
    Compacted {
        folded:     usize,
        kept:       usize,
        note:       String,
        structured: bool,
        model:      String,
        sp:         String,
        cut:        usize,
        summarised: bool,
    },
    /// A picture could not be put in front of this model.
    ///
    /// Its own variant and not an error: the turn goes on without the picture.  The app did
    /// something, it is lossy, and the user is entitled to see it as an act -- the same reasoning
    /// as [`Compacted`](Self::Compacted).
    ///
    /// It says WHICH model, because that is the fact anybody acting on this has to have: the
    /// worker that is re-routed by it needs to name the model it left, and a conversation that
    /// cannot be re-routed at all needs to name the model that would not look.
    Unseeable { images: usize, model: String, source: String },
    /// A tool call is being made again because the ROAD failed under it, not the far end.
    ///
    /// Its own variant and not [`Text`](Self::Text), for the reason [`Compacted`](Self::Compacted)
    /// is: this is something the APP is doing.  The model did not say it and -- the whole point
    /// of the mechanism -- will never read it.  A road failure that reached the model as a tool
    /// result is what produced "I can't get through to the web right now to look this up" on a
    /// real iPhone, so nothing about one may enter the conversation.
    ///
    /// It exists because the alternative is silence.  The ladder can climb for up to two minutes,
    /// and a turn retrying quietly is indistinguishable from a turn that has hung -- which is the
    /// one thing a spinner cannot say.  The provider ladder already prints its own banner
    /// (`[daimond: …; retrying in …]`, src/llm.rs); this is the same courtesy one layer down, in
    /// a form the page can draw as furniture rather than as prose.
    Roading { name: String, attempt: u32, of: u32, wait_ms: u64 },
    /// The provider has taken the request and shown nothing for `secs` seconds.
    ///
    /// Raised every half of the stream idle ceiling while it lasts, so a page can say who it is
    /// waiting on instead of drawing a spinner that cannot be told from a hang.  Keep-alive
    /// comments do not end it: only text, reasoning or a call fragment does.  `provider` is the
    /// upstream OpenRouter named, or empty.  Added with the r540 model-stall fix.
    Wait { model: String, provider: String, secs: u64 },
    /// A round got no data at all and was given up on.
    ///
    /// `retried` says whether it is being asked again (with `provider` left out where OpenRouter
    /// can be told so) or this is the second silence and the turn ends with a plain error.
    /// Both are the APP's doing and never reach the model.
    Stall { model: String, provider: String, secs: u64, retried: bool },
    /// The turn reached its round limit and carried on anyway, rather than ending there.
    ///
    /// Its own variant for the reason [`Compacted`](Self::Compacted) has one, and it is the same
    /// reason: this is something the APP did to the turn, between two rounds, and the model
    /// neither said it nor is ever told about it.  A turn that silently ran to six hundred rounds
    /// would be indistinguishable, in the record and on the bill, from four turns the user asked
    /// for -- and the one figure anybody chasing the cost of a long turn needs is how many of
    /// those hundred-and-fifty-round legs there were.
    ///
    /// It rides beside the forced fold rather than replacing it: the fold at the cap still runs,
    /// and is still drawn, because the next leg re-sends whatever it left.
    ///
    /// `n` counts from one and never exceeds `compact::MAX_CONTINUATIONS`; `rounds_so_far` is the
    /// whole turn's count, legs included, not this leg's.
    Continued { n: usize, rounds_so_far: usize },
    /// The provider stopped generating because the reply reached the output limit.
    ///
    /// Said outright rather than inferred.  A tool call cut at the limit arrives as
    /// malformed JSON, so the browser had to guess truncation from arguments that would
    /// not parse -- a guess that is right in practice and cannot see a plain text reply
    /// cut short, which is the case with no other symptom at all.
    ///
    /// It is not an error.  The request succeeded; a setting was reached.
    Truncated,
    /// The provider's own trace facts for one round: an id to ask it about afterwards, and
    /// the finish-reason words behind [`Truncated`](Self::Truncated) and every other ending.
    ///
    /// Its own variant and emitted once per round unconditionally, next to the tool-call and
    /// text events a round produces -- not folded onto [`Ended`](Self::Ended), because the
    /// round this matters for is not always the turn's last one, and not onto
    /// [`Truncated`](Self::Truncated), which fires only when a cut happened and this fires
    /// whether or not one did.
    ///
    /// Added 2026-09-15 (proposal 15): a round that answered nothing left nobody anything to
    /// ask OpenRouter about -- no id, no `finish_reason`, no upstream provider name -- so a
    /// cut or a silent stop could not be traced back to the provider's own logs.
    ///
    /// Every field is empty where the endpoint or the dialect sends none of them (the
    /// Anthropic dialect sends none); an empty `gen_id` is not itself news; see
    /// `ChatOnceResponse` in `src/llm.rs` for where each is read off the wire.
    RoundMeta {
        gen_id:               String,
        finish_reason:        String,
        native_finish_reason: String,
        provider:             String,
        // Set when the round ended because the stream went quiet past `stream_idle_ms`
        // rather than because the provider said it was done; see `ChatOnceResponse::stalled`
        // in `src/llm.rs`.
        stalled:              bool,
        // The round's timing facts (U3a RM, UNBLOCK-16): body bytes read, milliseconds to the
        // first of them, the longest quiet after it (the quiet before the end included), and
        // the round's length from its first request.  A worker's liveness limit is tuned from
        // them; see `ChatOnceResponse::bytes` in `src/llm.rs`.
        bytes:                u64,
        first_ms:             u64,
        gap_ms:               u64,
        ms:                   u64,
        // THIS round's own usage, not the turn's running total: the lens `round` row is built
        // from them, because the page's `live_*` getters belong to whichever app it asks and
        // a daimon's turn runs on another (r578 U3).
        prompt_tokens:        u64,
        cached_tokens:        u64,
        // The round's output and its host speed (D-20261020-10): output tokens, milliseconds to
        // the first token that grew the reply (keep-alives are bytes, not tokens), and from
        // there to the end; see `ChatOnceResponse::tok_ms` in `src/llm.rs`.
        completion_tokens:    u64,
        tok_ms:               u64,
        gen_ms:               u64,
    },
    /// A chunk of the model's own reasoning, as it arrives.
    ///
    /// Its own variant and not [`Text`](Self::Text), because the two are different KINDS of
    /// content on the wire -- the provider sends `thinking` blocks and `text` blocks, and a
    /// page that ran them together could never fold one and stream the other.  The user pays
    /// for these tokens and they decide the answer, so drawing none of them was the app
    /// holding something back that was already bought.
    ///
    /// Delivered as it ARRIVES, one delta per event, from the moment the model starts
    /// thinking.  It used to be sent whole at the end of the round, on the reasoning that a
    /// shut tile has nothing for a stream to fill -- which was true of the tile and wrong
    /// about the wait.  A GLM round measured on 2026-08-28 spent 230 of its 300 output
    /// tokens reasoning, and a DeepSeek round spent 84 seconds and 1.8 MB on it; all of
    /// that was time the page had nothing to show, because the one thing happening was the
    /// thing being held back.  So the tile opens as the first delta lands and fills while
    /// the round runs.  A reader who wants none of it collapses it, and it stays collapsed.
    ///
    /// Consecutive events belong to ONE tile.  The page appends them to the tile it is
    /// filling and closes it off when anything else is drawn, so a round's working is one
    /// disclosure and not four hundred.
    ///
    /// Empty for every endpoint that does not return reasoning, which is most of them.  The
    /// tokens are billed either way, so a provider that thinks and says nothing costs the
    /// same and shows nothing -- that is the provider's doing and the tile simply does not
    /// appear.
    Thinking(String),
    /// How the turn ended, and what its tool log came to.
    ///
    /// Always emitted, on every path out of a turn, and drawn as FURNITURE -- one quiet line
    /// in the register of a timestamp.  That is not decoration: an app that appends a warning
    /// to every turn teaches its reader to skip the one that mattered, which is the failure
    /// this exists to prevent.  `dev/CONTRACT_CLAIMS.md` §3 binds the drawing to it, and
    /// `TurnEnding::unaccounted` is the only thing that promotes the line to a notice.
    ///
    /// It exists because a model announced work and then ended its turn having done none, the
    /// spinner stopped -- correctly, the turn HAD ended -- and the owner was left with no way
    /// to tell that from a turn that finished.  Three endings were explained before this and
    /// every other one was silence.
    ///
    /// `missing` is paths a completed call SAID it left on the store and which are not there,
    /// read off the call's arguments and never off the model's words.
    Ended {
        how:       String,      // answered | stopped | capped | silent | failed | malformed | reasoned_only
        offered:   usize,       // tools this turn was allowed to call
        rounds:    usize,
        calls:     usize,
        refused:   usize,
        failed:    usize,
        missing:   Vec<String>,
        malformed: usize,       // rounds re-sent because a tool call arrived as text
        reasoned:  usize,       // rounds re-sent because a reply reasoned and answered nothing
        why:       String,      // `blocked` beside `failed`, else empty; see `TurnEnd::why`
        said:      String,      // the plain sentence a blocked turn ends on, else empty
        touched:   Vec<String>, // paths completed calls left, at most 40 then "+k more"
    },
    /// A tool call arrived as TEXT, in the model's own native call syntax, with no JSON
    /// `tool_calls` beside it.
    ///
    /// Its own variant for the reason [`Compacted`](Self::Compacted) has one: this is
    /// something the APP noticed and acted on between two rounds, and the model neither
    /// said it nor is told about it in these words.
    ///
    /// It exists because the failure was SILENT.  On 2026-09-14 a round came back carrying
    /// `…</arg_key><arg_value>daimonfold</arg_value>…</tool_call>` as its content, the turn
    /// ended `answered` with `calls: 0`, the page drew the markup as prose with every tag
    /// stripped out of it, and nothing anywhere -- not one console line, not one lens row --
    /// said a tool call had been lost.
    ///
    /// `recovered` says whether the fragment held a whole call that was rebuilt and run.  A
    /// recovered leak costs nothing and is reported anyway: it is still the provider getting
    /// the wire wrong, and a fault that fixes itself quietly is a fault nobody measures.
    Leaked { fragment: String, recovered: bool },
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
            Self::Thinking(text) => {
                m.insert(dat!("type"), dat!("thinking"));
                m.insert(dat!("content"), dat!(text.clone()));
            }
            Self::Ended { how, offered, rounds, calls, refused, failed, missing, malformed, reasoned, why, said, touched } => {
                m.insert(dat!("type"),      dat!("ended"));
                m.insert(dat!("how"),       dat!(how.clone()));
                m.insert(dat!("offered"),   Dat::U64(*offered as u64));
                m.insert(dat!("rounds"),    Dat::U64(*rounds  as u64));
                m.insert(dat!("calls"),     Dat::U64(*calls   as u64));
                m.insert(dat!("refused"),   Dat::U64(*refused as u64));
                m.insert(dat!("failed"),    Dat::U64(*failed  as u64));
                m.insert(dat!("malformed"), Dat::U64(*malformed as u64));
                m.insert(dat!("reasoned"),  Dat::U64(*reasoned as u64));
                m.insert(dat!("missing"),
                    Dat::List(missing.iter().map(|p| dat!(p.clone())).collect()));
                m.insert(dat!("touched"),
                    Dat::List(touched.iter().map(|p| dat!(p.clone())).collect()));
                if !why.is_empty() {
                    m.insert(dat!("why"),   dat!(why.clone()));
                    m.insert(dat!("said"),  dat!(said.clone()));
                }
            }
            Self::Leaked { fragment, recovered } => {
                m.insert(dat!("type"),      dat!("leaked"));
                m.insert(dat!("fragment"),  dat!(fragment.clone()));
                m.insert(dat!("recovered"), Dat::Bool(*recovered));
            }
            Self::ToolCall { name, args, .. } => {
                m.insert(dat!("type"), dat!("tool_call"));
                m.insert(dat!("name"), dat!(name.clone()));
                m.insert(dat!("args"), dat!(args.clone()));
            }
            Self::ToolResult { name, result, outcome, class, paused } => {
                m.insert(dat!("type"), dat!("tool_result"));
                m.insert(dat!("name"), dat!(name.clone()));
                m.insert(dat!("content"), dat!(result.clone()));
                m.insert(dat!("outcome"), dat!(outcome.wire()));
                if !class.is_empty() {
                    m.insert(dat!("class"), dat!(class.clone()));
                }
                if !paused.is_empty() {
                    m.insert(dat!("paused"), dat!(paused.clone()));
                }
            }
            Self::Interjected(text) => {
                m.insert(dat!("type"), dat!("interjected"));
                m.insert(dat!("content"), dat!(text.clone()));
            }
            Self::Compacted { folded, kept, note, model, sp, cut, summarised, .. } => {
                m.insert(dat!("type"), dat!("compacted"));
                m.insert(dat!("cut"), Dat::U64(*cut as u64));
                m.insert(dat!("summarised"), Dat::Bool(*summarised));
                m.insert(dat!("folded"), Dat::U64(*folded as u64));
                m.insert(dat!("kept"), Dat::U64(*kept as u64));
                m.insert(dat!("content"), dat!(note.clone()));
                if !model.is_empty() {
                    m.insert(dat!("model"), dat!(model.clone()));
                    m.insert(dat!("sp"), dat!(sp.clone()));
                }
            }
            Self::Unseeable { images, model, source } => {
                m.insert(dat!("type"), dat!("unseeable"));
                m.insert(dat!("images"), Dat::U64(*images as u64));
                m.insert(dat!("model"), dat!(model.clone()));
                m.insert(dat!("source"), dat!(source.clone()));
            }
            Self::Roading { name, attempt, of, wait_ms } => {
                m.insert(dat!("type"),    dat!("roading"));
                m.insert(dat!("name"),    dat!(name.clone()));
                m.insert(dat!("attempt"), Dat::U64(*attempt as u64));
                m.insert(dat!("of"),      Dat::U64(*of      as u64));
                m.insert(dat!("wait_ms"), Dat::U64(*wait_ms));
            }
            Self::Wait { model, provider, secs } => {
                m.insert(dat!("type"),     dat!("wait"));
                m.insert(dat!("model"),    dat!(model.clone()));
                m.insert(dat!("provider"), dat!(provider.clone()));
                m.insert(dat!("secs"),     Dat::U64(*secs));
            }
            Self::Stall { model, provider, secs, retried } => {
                m.insert(dat!("type"),     dat!("stall"));
                m.insert(dat!("model"),    dat!(model.clone()));
                m.insert(dat!("provider"), dat!(provider.clone()));
                m.insert(dat!("secs"),     Dat::U64(*secs));
                m.insert(dat!("retried"),  Dat::Bool(*retried));
            }
            Self::Continued { n, rounds_so_far } => {
                m.insert(dat!("type"), dat!("continued"));
                m.insert(dat!("n"), Dat::U64(*n as u64));
                m.insert(dat!("rounds"), Dat::U64(*rounds_so_far as u64));
            }
            Self::Truncated => {
                m.insert(dat!("type"), dat!("truncated"));
            }
            Self::RoundMeta { gen_id, finish_reason, native_finish_reason, provider, stalled,
                bytes, first_ms, gap_ms, ms, prompt_tokens, cached_tokens,
                completion_tokens, tok_ms, gen_ms } => {
                m.insert(dat!("type"), dat!("round_meta"));
                m.insert(dat!("gen"),      dat!(gen_id.clone()));
                m.insert(dat!("finish"),   dat!(finish_reason.clone()));
                m.insert(dat!("nfinish"),  dat!(native_finish_reason.clone()));
                m.insert(dat!("provider"), dat!(provider.clone()));
                m.insert(dat!("stalled"),  Dat::Bool(*stalled));
                m.insert(dat!("b"),        Dat::U64(*bytes));
                m.insert(dat!("f"),        Dat::U64(*first_ms));
                m.insert(dat!("g"),        Dat::U64(*gap_ms));
                m.insert(dat!("ms"),       Dat::U64(*ms));
                m.insert(dat!("p"),        Dat::U64(*prompt_tokens));
                m.insert(dat!("ca"),       Dat::U64(*cached_tokens));
                m.insert(dat!("o"),        Dat::U64(*completion_tokens));
                m.insert(dat!("tf"),       Dat::U64(*tok_ms));
                m.insert(dat!("gm"),       Dat::U64(*gen_ms));
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
// │ The Diamond pack                                               │
// └───────────────────────────────────────────────────────────────┘

/// What a pack is, which decides what an importer may do with it.
///
/// The whole difference between the two doors: a `Diamond` is written OVER the id it names, and
/// whatever stood there is deleted first ([`crate::wasm::diamond::import_diamond`]); a `Template`
/// is opened as a NEW Diamond whatever id it names.  A reader that could not tell them apart would
/// eventually take one for the other, and one of those two mistakes destroys the Diamond the pack
/// happened to be named after.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PackKind {
    Diamond,    // a whole Diamond, id and all
    Template,   // a shape to open as a new one
}

impl PackKind {

    /// The word this kind travels as.
    pub fn wire(&self) -> &'static str {
        match self {
            Self::Diamond   => "diamond",
            Self::Template  => "template",
        }
    }

    /// What a pack says it is.
    ///
    /// Read from the head of the pack -- everything before the `files` map -- and not from the
    /// whole of it, because a file called `kind` inside `files` would be a key of exactly the shape
    /// [`crate::llm::extract_json_string`] is looking for.  A pack that says nothing is a whole
    /// Diamond: nothing that predates this field could pack anything else.
    pub fn of(json: &str) -> Self {
        let head = match json.find("\"files\":") {
            Some(i) => &json[..i],
            None    => json,
        };
        match crate::llm::extract_json_string(head, PACK_KIND).as_deref() {
            Some(w) if w == Self::Template.wire()   => Self::Template,
            _                                       => Self::Diamond,
        }
    }
}

// The key a pack says its kind under.  Absent means [`PackKind::Diamond`].
pub const PACK_KIND: &str = "kind";

// The key a template carries its display name under.
pub const PACK_NAME: &str = "name";

/// The JSON a whole Diamond travels in, between two devices and inside a share.
///
/// # A file that is not text used to be destroyed on the way out
///
/// Every file went through `String::from_utf8_lossy`, which is not a lenient decoding but a
/// REPLACEMENT: each byte sequence that is not valid UTF-8 becomes U+FFFD and the original bytes are
/// gone.  A PNG came out the far end as a PNG-shaped ruin of about the right size, so a share could
/// not carry a picture in either direction and neither end reported a fault.  That is why the
/// encoding lives here, target-agnostic, where a test can put real bytes in and compare what comes
/// out -- `wasm::diamond` is compiled only for the browser and nothing native could reach it.
///
/// # Two maps, because of what an older build does with a pack it does not understand
///
/// `import_diamond` reads `files` and ignores what it does not know, so a device that has not been
/// updated lays every text file down exactly as before and simply does not receive the pictures --
/// which is what it does today, minus the corruption.  A scheme that tagged entries inside `files`
/// would have had the old importer write the base64 TEXT into the file.
///
/// # Arguments
/// * `id` - The Diamond's id, which becomes a directory name on arrival.
/// * `touched` - When anything under it last changed, repeated at the top level so a carrier can
///   tell two copies apart without opening a file inside the pack.
/// * `files` - Every file under the Diamond's directory, by its path relative to it.
pub fn pack_diamond(id: &str, touched: u64, files: &[(String, Vec<u8>)]) -> String {
    pack(id, touched, PackKind::Diamond, "", files)
}

/// The same pack, said to be a template and carrying the display name.
///
/// The name travels at the top level because `.daimond/meta.json` does not travel at all (see
/// [`template_carries`]), and a Diamond that arrived with no name would be a tile with nothing on
/// it but a cog.  It is the same place `fe2o3_sbj`'s share format keeps it, and for the same
/// reason.
///
/// # Arguments
/// * `id` - Where the template came from.  Provenance and nothing else: [`PackKind::Template`]
///   says an importer must mint its own.
/// * `name` - What to call the Diamond the template opens as.
pub fn pack_template(
    id:      &str,
    touched: u64,
    name:    &str,
    files:   &[(String, Vec<u8>)],
)
    -> String
{
    pack(id, touched, PackKind::Template, name, files)
}

fn pack(
    id:      &str,
    touched: u64,
    kind:    PackKind,
    name:    &str,
    files:   &[(String, Vec<u8>)],
)
    -> String
{
    // Sorted, so two packs of an unchanged Diamond are the same bytes and a caller comparing states
    // sees no change where there is none.
    let mut sorted: Vec<&(String, Vec<u8>)> = files.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut text = Vec::new();
    let mut binary = Vec::new();
    for (path, bytes) in sorted {
        match std::str::from_utf8(bytes) {
            // Valid UTF-8 round-trips through JSON exactly, so it goes as itself and a pack stays
            // readable by a person.
            Ok(s)  => text.push(fmt!("\"{}\":\"{}\"",
                crate::llm::json_escape(path), crate::llm::json_escape(s))),
            Err(_) => binary.push(fmt!("\"{}\":\"{}\"",
                crate::llm::json_escape(path), oxedyne_fe2o3_text::base64::encode(bytes))),
        }
    }
    // A whole Diamond says nothing, so a pack from a build that predates this field is byte for
    // byte what it always was -- which matters, because the sync compares a Diamond's pack with the
    // one it last sent and a new constant field would make every Diamond on every device look
    // changed once.  Absence is unambiguous in the other direction too: nothing before this could
    // pack anything but a whole Diamond.
    let head = match kind {
        PackKind::Diamond  => String::new(),
        PackKind::Template => fmt!(",\"{}\":\"{}\",\"{}\":\"{}\"",
            PACK_KIND, kind.wire(), PACK_NAME, crate::llm::json_escape(name)),
    };
    fmt!(
        "{{\"id\":\"{}\",\"touched\":{}{},\"files\":{{{}}},\"{}\":{{{}}}}}",
        crate::llm::json_escape(id), touched, head, text.join(","), PACK_BINARY, binary.join(","),
    )
}

/// The key the files that are not text travel under.
pub const PACK_BINARY: &str = "binary";

// ┌───────────────────────────────────────────────────────────────┐
// │ What a pack will weigh, without building it                    │
// └───────────────────────────────────────────────────────────────┘

// The JSON an entry costs beyond its path and its content: two pairs of quotes,
// a colon and a comma.
pub const PACK_ENTRY_OVERHEAD: u64 = 6;

/// How one file's bytes are weighed when a pack is estimated ahead of being
/// built.
///
/// Not a guess about content -- a guess about PUNCTUATION, which is the only
/// thing [`json_escape`](crate::llm::json_escape) charges for. A quote, a
/// backslash, a newline, a tab or a return costs two bytes instead of one, and a
/// control character six. Everything else, multibyte included, travels as
/// itself.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Weigh {
	Base64,		// not text, so `ceil(n/3) * 4` exactly -- an arithmetic fact, not an estimate
	Quoted,		// three for two: JSON, where every quote doubles
	Markup,		// five for four: attribute-dense but newline-broken
	Prose,		// nine for eight: punctuation is rare in it
}

/// How a file with this path will be carried, judged from its extension alone.
///
/// **Unknown means [`Weigh::Quoted`]**, the heaviest of the four, so a file kind
/// nobody has classified is never weighed lighter than it might travel.
fn weigh(path: &str) -> Weigh {
	let ext = match path.rfind('.') {
		// A dot in a directory name is not this file's extension.
		Some(at) if !path[at..].contains('/')	=> &path[at + 1..],
		_					=> return Weigh::Quoted,
	};
	match ext {
		"html" | "htm"					=> Weigh::Markup,
		"md" | "txt"					=> Weigh::Prose,
		// A Diamond's own patches, and the shapes a worker leaves beside them.
		// Anything not named here that is nonetheless binary is weighed as
		// quoted text instead, which is heavier than base64 and so still safe.
		"jpatch" | "hpatch"				=> Weigh::Base64,
		"png" | "jpg" | "jpeg" | "gif" | "webp"		=> Weigh::Base64,
		"pdf" | "zip" | "docx" | "xlsx" | "pptx"	=> Weigh::Base64,
		"wasm" | "woff" | "woff2" | "ttf" | "otf"	=> Weigh::Base64,
		"mp3" | "mp4" | "m4a" | "webm" | "mov"		=> Weigh::Base64,
		// `.json`, `.jsonl`, the extensionless log, and everything unrecognised.
		_						=> Weigh::Quoted,
	}
}

/// What one file will weigh inside a pack, from its path and its size on disk.
///
/// **This is the estimate `export_size` spends a sync budget against, and every
/// file used to be weighed at four bytes for three as though it travelled
/// base64.** That figure was wrong in both directions at once, which is why it
/// is now four figures and not one.
///
/// TOO HEAVY FOR MARKUP, WHICH IS THE BULK OF A DIAMOND. Valid UTF-8 travels as
/// ITSELF through JSON, so what escaping adds to a page is a few per cent, not
/// thirty-three. Over the 78 HTML files in this repository the cost runs from
/// 1.025x to 1.126x, median 1.056x; over its markdown, at most 1.026x. The cost
/// of the old figure was not theoretical: thirteen Diamonds at the page ceiling
/// with five edits each, weighed that way, admitted five where the pack itself
/// admitted seven -- two Diamonds refused a sync they would have fitted, and
/// told the user they had been left behind.
///
/// FIVE-FOR-FOUR AND NOT NINE-FOR-EIGHT, because nine-for-eight was tried and
/// fails: `www/console/index.html` escapes at 1.1262x and comes out twenty-nine
/// bytes short of what the pack charges for it, which is the one direction this
/// may not be wrong in. The margin over the worst real file is the price of the
/// answer being safe, and it is why the estimate still reads high for a page
/// that escapes as lightly as a capp's.
///
/// TOO LIGHT FOR JSON, WHICH NOBODY HAD NOTICED. A JSON file is dense in quotes
/// and every one of them doubles. `lanes/diet.json` in the shipped capp measures
/// 1.302x and `{"a":"b"}` measures 1.47x, so four-for-three was never a margin
/// there -- it was an under-estimate, and the test that found it is
/// `test_json_is_weighed_heavier_than_base64_because_every_quote_doubles`.
/// Three-for-two covers both.
///
/// AND NOT ACTUALLY BASE64 EITHER, because base64 rounds up to a multiple of
/// four and pads: eight bytes cost twelve, where four-for-three said ten. The
/// binary figure is now the arithmetic rather than a ratio.
///
/// AN ESTIMATE, NOT A PROOF. What it has to be right about is the direction a
/// REFUSAL points: a Diamond this says will not fit is never built, so that
/// answer has to hold. One it lets through is measured again exactly, against
/// the pack that actually travels, so an over-optimistic answer costs one
/// Diamond materialised and dropped -- which is what every Diamond cost before
/// this existed -- and never a parcel over the door.
pub fn packed_weight(path: &str, size: u64) -> u64 {
	let bytes = match weigh(path) {
		// `ceil(n / 3) * 4`, which is what base64 of n bytes is.
		Weigh::Base64	=> size.saturating_add(2) / 3 * 4,
		Weigh::Quoted	=> size.saturating_mul(3) / 2,
		Weigh::Markup	=> size.saturating_mul(5) / 4,
		Weigh::Prose	=> size.saturating_mul(9) / 8,
	};
	bytes.saturating_add(path.len() as u64).saturating_add(PACK_ENTRY_OVERHEAD)
}


/// The bytes of one file from a pack's `binary` map.
///
/// One function, so the browser's importer and the test that proves a picture survives are decoding
/// by the same rule.  A value that is not base64 is refused rather than written as whatever decoded:
/// half a picture over a good one is the corruption this exists to remove, and it would arrive
/// looking like a successful sync.
pub fn unpack_binary(path: &str, body: &str) -> Outcome<Vec<u8>> {
    Ok(res!(oxedyne_fe2o3_text::base64::decode(body).map_err(|e| err!(e,
        "The file '{}' in a Diamond export is not valid base64, so its bytes cannot be recovered.",
        path; Invalid, Input, Decode))))
}

// ┌───────────────────────────────────────────────────────────────┐
// │ A template: the shape without the contents                     │
// └───────────────────────────────────────────────────────────────┘

// The path prefixes a template drops, over and above the ones the share format already refuses.
//
// `log/` is a capp's ENTRIES.  It is refused by name rather than by inspection because that is
// where the shipped Log Life page puts what its user records, and `cappNeverDelivered` in
// `www/js/daimond.js` already refuses a served template the same path from the other direction.
// One rule, in the two places that have to agree about it.
const TEMPLATE_DROP_PREFIXES: [&str; 1] = ["log/"];

// The exact paths a template drops.
//
// `crystal.json` is the Diamond's MEMORY -- what its folds accumulated -- and `crystal.md` is the
// same memory before the migration.  `transcript.md` is a conversation kept whole.  A bare `log`
// is the file form of the prefix above.
// `triggers.json` is dropped for a reason of its own, and it is the only entry here that is
// not about the sender's privacy: a trigger is automation that fires WITHOUT anybody pressing
// anything, so a template carrying one would start work on a stranger's machine because they
// opened a file.  Disarming rather than dropping was considered and refused: `on: false` does
// NOT disarm a trigger -- the pause tree is the authority and a trigger left in the file stays
// armed under it -- so a template that carried one and claimed it was off would be worse than
// one that carries none.  The receiver sets up their own, which is a sentence of documentation
// and not a data problem.
//
// IT IS IN `share::REFUSED_EXACT` AS WELL NOW, and so is `STATE.md`, which is why neither is
// listed in the array any longer: `template_carries` walks that list first, so both are already
// refused by the time this one is reached.  The argument stays here in words and the enforcement
// moved to the format, where a receiver's exposure does not depend on which build sent it.
const TEMPLATE_DROP_EXACT: [&str; 4] = ["crystal.json", "crystal.md", "transcript.md", "log"];

/// Does a template carry this file?
///
/// The rule is DROP A KNOWN LIST AND KEEP THE REST, which is the way round it has to be: a capp
/// keeps its data beside itself, in folders this build has never heard of, and a template built
/// from a list of what to keep would silently lose whichever folder the refinement was in.  That is
/// the failure `cappManifest` exists to avoid on the delivery side.
///
/// Five of the drops are `fe2o3_sbj`'s and are not invented here -- `.daimond/`, `versions/`, the
/// `capp.json` delivery record, `triggers.json` and `STATE.md` -- so an unsealed template and a
/// sealed share refuse the same paths for the same stated reasons and the two cannot drift.  The
/// last two moved to the format on 2026-09-15, having been this file's alone: a template refused
/// armed automation and a share carried it, which is the same file going to the same person by a
/// different door.  What this adds is the memory, the kept conversation and a capp's entries,
/// because a share is a copy of a Diamond for one named person and a template is its shape for
/// anybody at all.
///
/// # Arguments
/// * `rel` - The path relative to the Diamond's own directory.
pub fn template_carries(rel: &str) -> bool {
    for prefix in share::REFUSED_PREFIXES {
        if rel.starts_with(prefix) {
            return false;
        }
    }
    if share::refused_exact(rel).is_some() {
        return false;
    }
    for prefix in TEMPLATE_DROP_PREFIXES.iter() {
        if rel.starts_with(prefix) {
            return false;
        }
    }
    !TEMPLATE_DROP_EXACT.contains(&rel)
}

/// What of a Diamond's directory goes into a template.
///
/// `with_conversation` is the door back to a complete copy: everything travels, exactly as
/// [`pack_diamond`] would have carried it, and the pack is still a [`PackKind::Template`], so it
/// still opens as a new Diamond rather than over the one it came from.
pub fn template_files(
    files:             &[(String, Vec<u8>)],
    with_conversation: bool,
)
    -> Vec<(String, Vec<u8>)>
{
    files.iter()
        .filter(|(rel, _)| with_conversation || template_carries(rel))
        .cloned()
        .collect()
}

// The files inside a Diamond that name it by id, and so have to be readdressed when a copy opens
// under a new one.
//
// Both are the app's own records rather than anybody's content, and neither is in a shape-only
// template at all -- they arrive only with `with_conversation`.  The log's `delta_ref` holds a
// PATH written when the fold was applied, which is what `rewrite_delta_refs` exists for on the
// move between Diamond roots; a link's ends are `diamond:<id>` and `file:diamonds/<id>/...`.  Left
// alone, every stored delta and every link in a complete copy would point at the directory it was
// copied from.
const TEMPLATE_RETARGET: [&str; 2] = [".daimond/log", ".daimond/links.jsonl"];

/// One file of a template, readdressed from the id it was packed under to the one it is landing at.
///
/// Only the two files that carry an id are touched, and only where they are text.  A blanket
/// search and replace over everything would reach a page's prose and a picture's bytes, where the
/// id is not a reference to anything.
pub fn retarget(
    rel:    &str,
    body:   Vec<u8>,
    old_id: &str,
    new_id: &str,
)
    -> Vec<u8>
{
    if old_id == new_id || old_id.is_empty() || !TEMPLATE_RETARGET.contains(&rel) {
        return body;
    }
    let text = match String::from_utf8(body) {
        Ok(t)  => t,
        Err(e) => return e.into_bytes(),        // not text: no reference here to readdress
    };
    text
        .replace(&fmt!("diamonds/{}/", old_id), &fmt!("diamonds/{}/", new_id))
        .replace(&fmt!("diamond:{}", old_id), &fmt!("diamond:{}", new_id))
        .into_bytes()
}

// How many ids are tried before an import gives up.
//
// A collision needs two ids minted in the same millisecond by the same counter, so one retry would
// almost certainly do.  The figure is what turns "almost certainly" into a bounded loop that fails
// loudly, rather than a guess that fails silently over somebody's Diamond.
const FRESH_ID_TRIES: usize = 32;

/// An id no Diamond in `taken` is using.
///
/// This is what stops an imported template writing over a Diamond that is already there.  The
/// pack's id is NOT consulted: a template says where it came from, and a Log Life template imported
/// by the person who made it would otherwise land on the Log Life it was made from and delete it.
/// That is the shape this project has already lost a user's tags to.
///
/// # Arguments
/// * `taken` - Every id the store already holds.
pub fn fresh_id(taken: &[String]) -> Outcome<String> {
    fresh_id_from(taken, generate_session_id)
}

/// [`fresh_id`], with the mint named, so a test can hand it one that collides on purpose.
pub fn fresh_id_from(taken: &[String], mint: fn() -> String) -> Outcome<String> {
    for _ in 0..FRESH_ID_TRIES {
        let id = mint();
        if !taken.iter().any(|t| t == &id) {
            return Ok(id);
        }
    }
    Err(err!(
        "{} ids were minted for an imported template and every one of them was already a Diamond \
        on this device, so the import stopped rather than write over one.", FRESH_ID_TRIES;
        Conflict, Data))
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

    /// A picture put into a Diamond pack comes out of it BYTE FOR BYTE.
    ///
    /// This is the test the corruption escaped for want of. `export_diamond` ran every file through
    /// `String::from_utf8_lossy`, which replaces each byte sequence that is not valid UTF-8 with
    /// U+FFFD -- so a PNG arrived at the far end at roughly the right size, shaped like a PNG, and
    /// would not open. Neither end reported a fault, because as far as either could see the file had
    /// travelled. Run against that code this fails on the very first assertion: the pack's `files`
    /// map holds the picture's path and its bytes are not the picture's.
    #[test]
    fn test_the_models_working_travels_as_its_own_kind_and_not_as_text() {
        // The wire name is the whole contract with the page: `type: "thinking"` is what
        // decides whether a chunk is drawn in the answer or in a shut tile beside it. It is
        // asserted here rather than left to the browser, because a reasoning block that
        // arrived typed as `text` would be appended to the reply -- the model's working
        // mistaken for what it said, and then stored and sent back as if it had said it.
        let m = AgentEvent::Thinking(fmt!("1071 = 2 x 462 + 147")).to_datmap();
        assert_eq!(m.get(&dat!("type")), Some(&dat!("thinking")),
            "reasoning did not travel as its own kind");
        assert_eq!(m.get(&dat!("content")), Some(&dat!("1071 = 2 x 462 + 147")),
            "the working was not carried whole");
        // And it is NOT the same shape as an answer, which is the distinction the page
        // depends on. A single map with both spellings would be indistinguishable.
        let t = AgentEvent::Text(fmt!("1071 = 2 x 462 + 147")).to_datmap();
        assert_ne!(t.get(&dat!("type")), m.get(&dat!("type")),
            "an answer and the working behind it are the same kind on the wire");
    }

    #[test]
    fn test_a_picture_survives_a_diamond_pack() {
        let png = doc_png();
        assert!(std::str::from_utf8(&png).is_err(), "the fixture has to be bytes that are not text");
        let files = vec![
            // No braces in it: the files map is found below by brace matching, and a `}` inside a
            // string value would cut the search short and make the check that follows vacuous.
            ("notes.txt".to_string(), b"a \"quoted\" word\nand a \\ backslash\n".to_vec()),
            ("img/one.png".to_string(), png.clone()),
        ];
        let pack = pack_diamond("d1", 42, &files);

        // The picture is NOT in `files`, because `files` is the text map and an older importer
        // would write whatever is there straight to disk. Located by brace matching rather than by
        // `extract_json_string`, which reads a STRING value and would answer nothing for an object
        // -- and a check that can only pass is not a check.
        let at = pack.find("\"files\":{").expect("the pack has no files map");
        let end = pack[at..].find('}').expect("the files map does not close") + at;
        let text_map = &pack[at..end];
        assert!(text_map.contains("notes.txt"),
            "the text file is not in the text map, so this test is looking in the wrong place: {}",
            text_map);
        assert!(!text_map.contains("img/one.png"),
            "a binary file was put in the text map, where an older build would write it as text");
        assert!(pack.contains(&fmt!("\"{}\":{{\"img/one.png\"", PACK_BINARY)),
            "the picture is not in the binary map: {}", pack);

        // And it IS recoverable, exactly.
        let body = crate::llm::extract_json_string(&pack, "img/one.png")
            .expect("the pack does not carry the picture at all");
        let back = unpack_binary("img/one.png", &body).expect("the picture's base64 must decode");
        assert_eq!(back, png, "the picture did not survive the round trip");

        // The text file still travels as text, and its escaping survives.
        let note = crate::llm::extract_json_string(&pack, "notes.txt")
            .expect("the pack does not carry the text file");
        assert_eq!(note.as_bytes(), files[0].1.as_slice(),
            "a text file's own quotes did not survive the pack");
    }

    /// The pack is the same bytes twice over, so a carrier comparing states sees no change where
    /// there is none.
    #[test]
    fn test_a_pack_of_an_unchanged_diamond_is_the_same_bytes() {
        let files = vec![
            ("b.txt".to_string(), b"second".to_vec()),
            ("a.png".to_string(), vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00]),
        ];
        let one = pack_diamond("d1", 7, &files);
        let mut other = files.clone();
        other.reverse();
        assert_eq!(one, pack_diamond("d1", 7, &other),
            "the order the directory walk happened to return changed the pack");
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
        let out = c.without_images(Dropped::ToFit);
        assert!(!out.has_image());
        let t = out.as_text();
        assert!(t.contains("here it is"), "the prose was lost: {}", t);
        assert!(t.contains("shots/a.png"), "the file was not named: {}", t);
        assert!(t.contains("read it again"), "the model was not told what to do: {}", t);

        // The other reason, which must NOT say that -- on an endpoint that will not take
        // pictures, "read it again" is a loop, and the two reasons are a type precisely so
        // that one cannot be told to do the thing that cannot help.
        let blind = c.without_images(Dropped::Unseeable);
        let b = blind.as_text();
        assert!(b.contains("here it is"), "the prose was lost: {}", b);
        assert!(b.contains("shots/a.png"), "the file was not named: {}", b);
        assert!(!b.contains("read it again"), "it was told to retry a read that cannot help: {}", b);
        assert!(b.contains("cannot be shown"), "it was not told why: {}", b);
        assert!(b.contains("Do not describe"),
            "nothing stopped it describing a picture it never saw: {}", b);
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

    // ── The app's note on a user message (`pre`) ─────────────────────────────

    const NOTE: &str = "[Daimond: the user rated your answer of 10:04 \u{2212}1 (long): \"just give me the command\".]";

    /// The store keeps the note and the person's words as two things, so a reload cannot turn
    /// the note into something the person said.
    #[test]
    fn test_a_user_message_s_note_stays_apart_from_its_words_in_the_store() {
        let msg = ChatMessage::user_noted("Now fix the lexer.".to_string(), NOTE.to_string());
        let m = msg.to_datmap();
        assert_eq!(Some(&dat!("Now fix the lexer.")), m.get(&dat!("content")),
            "the note leaked into the words: {:?}", m);
        assert_eq!(Some(&dat!(NOTE)), m.get(&dat!("pre")), "the note was not stored: {:?}", m);
        let back = ChatMessage::from_datmap(&m).expect("read back");
        assert_eq!(msg, back);
        assert_eq!(NOTE, back.pre());
        assert_eq!("Now fix the lexer.", back.text());
    }

    /// A message with no note writes the map it always wrote, and a snapshot from before the
    /// field existed reads back with none.
    #[test]
    fn test_a_user_message_with_no_note_writes_no_pre_and_an_old_one_reads_none() {
        let plain = ChatMessage::user("hello".to_string());
        assert!(plain.to_datmap().get(&dat!("pre")).is_none(), "an empty note was written");
        let noted_empty = ChatMessage::user_noted("hello".to_string(), String::new());
        assert_eq!(plain.to_datmap(), noted_empty.to_datmap());
        let mut old = DaticleMap::new();
        old.insert(dat!("role"), dat!("user"));
        old.insert(dat!("content"), dat!("hello"));
        let back = ChatMessage::from_datmap(&old).expect("an older snapshot reads");
        assert_eq!("", back.pre());
        assert_eq!(plain, back);
        // A note on any other role is not a thing: the map's `pre` is read for a user only.
        let mut odd = DaticleMap::new();
        odd.insert(dat!("role"), dat!("assistant"));
        odd.insert(dat!("content"), dat!("hi"));
        odd.insert(dat!("pre"), dat!(NOTE));
        assert_eq!("", ChatMessage::from_datmap(&odd).expect("reads").pre());
    }

    /// A user message keeps the transcript row it was said as through the store, a note's join
    /// and an elision, so the page can pair two prompts with the same words by id (check_fix3 F1).
    #[test]
    fn test_a_user_message_keeps_its_row_id_through_the_store_and_the_join() {
        let msg = ChatMessage::user_noted("continue".to_string(), NOTE.to_string())
            .marked("u5".to_string());
        assert_eq!("u5", msg.mid());
        let m = msg.to_datmap();
        assert_eq!(Some(&dat!("u5")), m.get(&dat!("mid")), "the id was not stored: {:?}", m);
        let back = ChatMessage::from_datmap(&m).expect("read back");
        assert_eq!(msg, back);
        assert_eq!("u5", join_notes(&[msg.clone()])[0].mid(), "the join dropped the id");
        assert_eq!("u5", msg.with_content(MessageContent::from("x".to_string())).mid());
        // No id writes no field, and only a user message takes one.
        assert!(ChatMessage::user("continue".to_string()).marked(String::new())
            .to_datmap().get(&dat!("mid")).is_none());
        assert_eq!("", ChatMessage::assistant("a".to_string()).marked("u5".to_string()).mid());
    }

    /// A turn's opening keeps its mark through the store, the join, an elision and an id, and
    /// only a user message takes one (r578d, QA-B B1).
    #[test]
    fn test_a_turns_opening_keeps_its_mark_through_the_store_and_the_join() {
        let msg = ChatMessage::user_noted("go".to_string(), NOTE.to_string()).opening()
            .marked("u7".to_string());
        assert!(msg.opens_turn());
        let back = ChatMessage::from_datmap(&msg.to_datmap()).expect("read back");
        assert_eq!(msg, back);
        assert!(join_notes(&[msg.clone()])[0].opens_turn(), "the join dropped the mark");
        assert!(msg.with_content(MessageContent::from("x".to_string())).opens_turn());
        assert!(ChatMessage::user("note".to_string()).to_datmap().get(&dat!("opens")).is_none());
        assert!(!ChatMessage::assistant("a".to_string()).opening().opens_turn());
    }

    /// A rebuilt row opens a turn only where the page says it did: an app note or an
    /// interjection appended or restored from prose is not a turn (QA r578d-B B3).
    #[test]
    fn test_a_rebuilt_row_opens_a_turn_only_where_the_page_says_so() {
        let note = ChatMessage::user("agents not started".to_string()).opening_if(false);
        assert!(!note.opens_turn(), "the app's note was marked as a turn");
        let turn = ChatMessage::user_noted("go".to_string(), NOTE.to_string())
            .marked("u9".to_string()).opening_if(true);
        assert!(turn.opens_turn());
        assert_eq!("u9", turn.mid(), "the mark dropped the id");
        assert!(!ChatMessage::assistant("a".to_string()).opening_if(true).opens_turn());
    }

    /// The elision a fold makes keeps the note with the message it belongs to.
    #[test]
    fn test_replacing_a_user_message_s_content_keeps_its_note() {
        let msg = ChatMessage::user_noted("words".to_string(), NOTE.to_string());
        let shorter = msg.with_content(MessageContent::text("w"));
        assert_eq!(NOTE, shorter.pre());
        assert_eq!("w", shorter.text());
    }

    /// The join: the note, a blank line, then the words, for each shape of content, and once.
    #[test]
    fn test_a_user_message_s_pre_is_joined_ahead_of_its_words() {
        let msgs = vec![
            ChatMessage::system("sys".to_string()),
            ChatMessage::user("earlier".to_string()),
            ChatMessage::assistant("ok".to_string()),
            ChatMessage::user_noted("Now fix the lexer.".to_string(), NOTE.to_string()),
        ];
        let sent = join_notes(&msgs);
        assert_eq!(msgs.len(), sent.len());
        assert_eq!(fmt!("{}\n\nNow fix the lexer.", NOTE), sent[3].text());
        assert_eq!("", sent[3].pre(), "the note is joined, so it is not also carried");
        assert_eq!("earlier", sent[1].text(), "a message with no note is untouched");
        assert_eq!(msgs[0], sent[0]);
        assert_eq!(msgs[2], sent[2]);
        // The conversation the session holds is not changed by sending it.
        assert_eq!("Now fix the lexer.", msgs[3].text());
        assert_eq!(NOTE, msgs[3].pre());

        // With an image the note goes in front of the words and the picture stays in place.
        let img = ImagePart::new(ImageMedia::Png, doc_png(), "shots/a.png".to_string());
        let pictured = vec![ChatMessage::user_noted(MessageContent::parts(vec![
            ContentPart::Text("look at this".to_string()),
            ContentPart::Image(img.clone()),
        ]), NOTE.to_string())];
        let sent = join_notes(&pictured);
        match sent[0].content() {
            MessageContent::Parts(parts) => {
                assert_eq!(2, parts.len());
                assert_eq!(ContentPart::Text(fmt!("{}\n\nlook at this", NOTE)), parts[0]);
                assert_eq!(ContentPart::Image(img.clone()), parts[1]);
            },
            other => panic!("the picture was lost in the join: {:?}", other),
        }
        // A picture with no words has nothing to be joined to, so the note leads on its own.
        let bare = vec![ChatMessage::user_noted(MessageContent::parts(vec![
            ContentPart::Image(img.clone()),
        ]), NOTE.to_string())];
        match join_notes(&bare)[0].content() {
            MessageContent::Parts(parts) => {
                assert_eq!(ContentPart::Text(NOTE.to_string()), parts[0]);
                assert_eq!(ContentPart::Image(img), parts[1]);
            },
            other => panic!("the picture was lost in the join: {:?}", other),
        }
    }

    /// With no note anywhere the conversation is handed back as it came, not copied.
    #[test]
    fn test_a_conversation_with_no_note_is_not_copied_to_send_it() {
        let msgs = vec![
            ChatMessage::user("a".to_string()),
            ChatMessage::user_noted("b".to_string(), String::new()),
        ];
        assert!(matches!(join_notes(&msgs), std::borrow::Cow::Borrowed(_)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── A row's opening mark (QA r578d-B B3, EP-6 F6L) ──

    /// The page rebuilds an interjection or the app's own note with `opens` false, and a turn
    /// the person ran with true; `of_row` is a row a turn was run on.  The mark is what
    /// `compact::prior_end` counts turns by, so it is pinned here by behaviour, not spelling.
    #[test]
    fn of_row_opening_marks_only_a_row_a_turn_was_run_on() {
        let row = |role: &str, opens: bool| ChatMessage::of_row_opening(role,
            "words".to_string(), String::new(), "m1".to_string(), opens);
        let note = row("user", false);
        assert!(note.is_some(), "a user row is a message");
        assert_eq!(note.map(|m| m.opens_turn()), Some(false),
            "an interjection or app note never opens a turn");
        assert_eq!(row("user", true).map(|m| m.opens_turn()), Some(true), "a user row does");
        assert_eq!(ChatMessage::of_row("user", "words".to_string(), String::new(),
            String::new()).map(|m| m.opens_turn()), Some(true), "of_row opens");
        assert_eq!(row("assistant", true).map(|m| m.opens_turn()), Some(false),
            "only a user message opens");
        assert!(row("tool", true).is_none(), "a tool row is not seeded");
    }

    // ── A held session ──

    #[test]
    fn read_held_fails_rather_than_panics_under_a_turn() {
        let cell = RefCell::new(Session::new("s".to_string(), "n".to_string(), "m".to_string()));
        {
            let _turn = cell.borrow_mut();			// a turn in flight
            assert!(Session::read_held(&cell, |s| s.messages.len()).is_err());
        }
        assert_eq!(Session::read_held(&cell, |s| s.messages.len()).ok(), Some(0));
    }

    #[test]
    fn write_held_fails_rather_than_panics_under_a_turn() {
        let cell = RefCell::new(Session::new("s".to_string(), "n".to_string(), "m".to_string()));
        {
            let _turn = cell.borrow();			// even a read in flight refuses a write
            assert!(Session::write_held(&cell, |s| s.prompt_tokens = 7).is_err());
        }
        assert!(Session::write_held(&cell, |s| s.prompt_tokens = 7).is_ok());
        assert_eq!(Session::read_held(&cell, |s| s.prompt_tokens).ok(), Some(7));
    }

    // ── What a pack will weigh, without building it ──

    /// The shipped Log Life capp page, and the heaviest-escaping HTML in this
    /// repository -- 1.126x, against a median of 1.056x over its 78 HTML files.
    /// A factor that holds for the worst one holds for the rest.
    const CAPP_PAGE:  &str = include_str!("../www/capps/lifelog/crystal.html");
    const DENSE_HTML: &str = include_str!("../www/console/index.html");

    /// What a pack really charges for one file: the pack with it, less the pack
    /// without it.
    ///
    /// Measured through [`pack_diamond`] rather than by a second copy of its
    /// rules, because a test that re-implements the thing it is checking agrees
    /// with the bug as readily as with the code.
    fn charged(path: &str, body: &[u8]) -> u64 {
        let with = pack_diamond("d", 1, &[(path.to_string(), body.to_vec())]);
        let without = pack_diamond("d", 1, &[]);
        (with.len() - without.len()) as u64
    }

    /// **The property the sync budget rests on.** A file the estimate weighs is
    /// never weighed lighter than the pack will charge for it -- so a Diamond
    /// the estimate refuses really would not have fitted, and that Diamond is
    /// the one that is never built.
    #[test]
    fn test_no_file_is_weighed_lighter_than_the_pack_charges_for_it() {
        let log = b"{\"id\":\"a\",\"ts\":1,\"kind\":\"fold\",\"note\":\"a \\\"quoted\\\" thing\"}\n";
        let cases: Vec<(&str, &[u8])> = vec![
            ("crystal.html",              CAPP_PAGE.as_bytes()),
            ("versions/0021.html",        DENSE_HTML.as_bytes()),
            ("crystal.json",              br#"{"title":"A crystal","notes":["one","two"]}"#),
            ("crystal.md",                b"# A crystal\n\nWords, a \"quote\", and a tab\there.\n"),
            (".daimond/log",              log),
            (".daimond/links.jsonl",      br#"{"from":"a","to":"b","rel":"cites"}"#),
            ("versions/0022.hpatch",      &[0u8, 0xff, 0x41, 0x0a, 0x22, 0x5c, 0x7f, 0x80]),
            ("notes.txt",                 b"plain words, and a newline\n"),
            ("worker/shot.png",           &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            ("worker/no_extension",       b"could be anything at all"),
            ("worker/asset.png",          &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
            ("odd.dir.name/inside.html",  b"<p>a dot in the directory is not the file's</p>"),
        ];
        for (path, body) in cases {
            let want = charged(path, body);
            let got = packed_weight(path, body.len() as u64);
            assert!(
                got >= want,
                "'{}' is weighed at {} and the pack charges {}, so a Diamond holding it could be \
                refused a parcel it would have fitted", path, got, want);
        }
    }

    /// **The consequence, stated as the thing the user loses.** A capp Diamond at
    /// the page ceiling, weighed the old way, was refused parcels it would have
    /// fitted. The test is not how close the estimate is; it is how many
    /// Diamonds a 4 MiB budget admits.
    #[test]
    fn test_more_diamonds_fit_the_parcel_than_the_old_weighing_admitted() {
        // A Diamond at the page ceiling with a handful of edits: the live page,
        // two keyframes, the patches between them, the memory and its snapshots.
        let page = CAPP_PAGE.len() as u64 * 5;               // roughly the 512 KiB ceiling
        let mut files: Vec<(String, u64)> = vec![
            ("crystal.html".to_string(),      page),
            ("versions/0001.html".to_string(), page),
            ("crystal.json".to_string(),      15_000),
            ("versions/0001.json".to_string(), 15_000),
            (".daimond/log".to_string(),      4_000),
        ];
        for v in 2..=6u64 {
            files.push((fmt!("versions/{:04}.hpatch", v), 900));
            files.push((fmt!("versions/{:04}.jpatch", v), 300));
        }
        let one_new: u64 = files.iter().map(|(p, n)| packed_weight(p, *n)).sum();
        let one_old: u64 = files.iter()
            .map(|(p, n)| n.saturating_mul(4) / 3 + p.len() as u64).sum();
        // What the pack really charges for the same set, measured through it.
        let bodies: Vec<(String, Vec<u8>)> = files.iter().map(|(p, n)| {
            let body = if p.ends_with(".html") {
                CAPP_PAGE.as_bytes().iter().cycle().take(*n as usize).cloned().collect()
            } else if p.ends_with("patch") {
                (0..*n).map(|i| (i % 251) as u8).collect()
            } else {
                let mut b = Vec::new();
                while (b.len() as u64) < *n { b.extend_from_slice(br#"{"k":"v","j":"w"},"#); }
                b.truncate(*n as usize);
                b
            };
            (p.clone(), body)
        }).collect();
        let one_real = (pack_diamond("d", 1, &bodies).len()
            - pack_diamond("d", 1, &[]).len()) as u64;
        let budget = 4u64 * 1024 * 1024;
        let fits = |each: u64| if each == 0 { 0 } else { budget / each };
        assert!(
            one_new >= one_real,
            "the new weighing is optimistic: {} against a real {}", one_new, one_real);
        assert!(
            fits(one_new) > fits(one_old),
            "the same store admits {} Diamonds under the new weighing and {} under the old, so \
            nothing was recovered (real {})", fits(one_new), fits(one_old), fits(one_real));
        assert_eq!(
            fits(one_new), fits(one_real),
            "the new weighing admits {} where the pack itself admits {}",
            fits(one_new), fits(one_real));
    }

    /// **The half nobody had noticed.** Four-for-three was not a margin for
    /// JSON, it was an under-estimate: every quote doubles, so a quote-dense
    /// object costs more than base64 of the same bytes would.
    #[test]
    fn test_json_is_weighed_heavier_than_base64_because_every_quote_doubles() {
        let dense = br#"{"a":"b","c":"d","e":"f","g":"h","i":"j","k":"l"}"#;
        let want = charged("crystal.json", dense);
        let base64ish = dense.len() as u64 * 4 / 3 + "crystal.json".len() as u64;
        assert!(
            want > base64ish,
            "quote-dense JSON was expected to cost more than four for three; it charged {} where \
            four for three is {}", want, base64ish);
        assert!(
            packed_weight("crystal.json", dense.len() as u64) >= want,
            "weighed {} against a charge of {}",
            packed_weight("crystal.json", dense.len() as u64), want);
    }

    /// Base64 rounds up to a multiple of four and pads, so four-for-three is
    /// short for every length that is not a multiple of three.
    #[test]
    fn test_a_patch_is_weighed_by_the_arithmetic_of_base64_and_not_by_a_ratio() {
        for n in 1..=64usize {
            let body: Vec<u8> = (0..n).map(|i| if i == 0 { 0xff } else { (i % 251) as u8 }).collect();
            let want = charged("versions/0002.hpatch", &body);
            let got = packed_weight("versions/0002.hpatch", n as u64);
            assert!(got >= want, "{} bytes weighed {} against a charge of {}", n, got, want);
        }
    }

    /// A file kind nobody has classified is weighed heavily, so a new one
    /// arriving in a Diamond cannot quietly be under-weighed.
    ///
    /// The two roads to that answer are both walked: an extension the match
    /// does not know, and a name with no extension for it to read at all. The
    /// first list here was all of the second kind, which left the arm that
    /// actually decides an unknown EXTENSION covered by nothing -- found by
    /// `dev/breakproof_deltalog.sh`, which changed that arm and watched this
    /// test stay green.
    #[test]
    fn test_an_unknown_kind_is_weighed_at_the_heavy_figure() {
        let n = 30_000u64;
        let heavy = n * 4 / 3;
        let paths = [
            // An extension the match does not know.
            "worker/data.sqlite", "worker/thing.bin", "crystal.json",
            ".daimond/links.jsonl", "worker/notes.rtf",
            // And no extension to read.
            "worker/thing", ".daimond/log", "a.b/c",
            // A known-binary kind, which must still not come out under base64.
            "worker/thing.wasm",
        ];
        for path in paths {
            let got = packed_weight(path, n);
            assert!(
                got >= heavy,
                "'{}' is weighed at {} and an unclassified file must be weighed at least {}",
                path, got, heavy);
        }
    }

    #[test]
    fn test_chat_message_roundtrip() {
        let msg = ChatMessage::user("Hello".to_string());
        let dm = msg.to_datmap();
        let msg2 = ChatMessage::from_datmap(&dm).unwrap();
        assert_eq!(msg, msg2);
    }

    /// A tool result's notes travel with it through the store, and a map from a build that never
    /// wrote one (or a map carrying a key this build does not know) still reads.
    #[test]
    fn test_appendonly_a_tool_post_note_survives_the_store_and_its_absence_reads_empty() {
        let msg = ChatMessage::tool("call_9".to_string(), MessageContent::text("42"))
            .noted_after("\n[turn state: round 3]");
        assert_eq!("\n[turn state: round 3]", msg.post());
        let dm = msg.to_datmap();
        let back = match ChatMessage::from_datmap(&dm) {
            Ok(m)  => m,
            Err(e) => panic!("the noted result did not read back: {}", e),
        };
        assert_eq!(msg, back, "the note was lost in the store");
        assert_eq!("42", back.text(), "the note leaked into the result itself");
        // An r577 map: no `post`, and a key this build has never heard of.
        let mut old = ChatMessage::tool("call_9".to_string(), MessageContent::text("42")).to_datmap();
        assert!(old.get(&dat!("post")).is_none(), "an unnoted result grew a key");
        old.insert(dat!("later"), dat!("a key from a newer build"));
        match ChatMessage::from_datmap(&old) {
            Ok(m)  => assert_eq!("", m.post()),
            Err(e) => panic!("a map with an unknown key was refused: {}", e),
        }
        // And the join sends the note after the words, once, leaving the stored copy apart.
        let msgs = vec![msg.clone()];
        let sent = join_notes(&msgs);
        assert_eq!("42\n[turn state: round 3]", sent[0].text());
        assert_eq!("", sent[0].post());
        // A turn's notes are kept by an elision of the result, which rewrites only its content.
        assert_eq!(msg.post(), msg.with_content(MessageContent::text("x")).post());
    }

    #[test]
    fn test_chat_message_tool_roundtrip() {
        let msg = ChatMessage::Tool {
            tool_call_id: "call_123".to_string(),
            content: MessageContent::text("42"),
            post: String::new(),
            retired: Retired::No,
        };
        let dm = msg.to_datmap();
        let msg2 = ChatMessage::from_datmap(&dm).unwrap();
        assert_eq!(msg, msg2);
    }

    #[test]
    fn test_a_retired_mark_and_its_fold_survive_the_store_00() {
        // r578f: a reload past the line reads the same once-state the turn left.
        for (m, since) in [
            (ChatMessage::tool(fmt!("c1"), fmt!("body")), false),
            (ChatMessage::tool(fmt!("c2"), fmt!("body")).as_retired(), true),
            (ChatMessage::tool(fmt!("c3"), fmt!("body")).as_retired().as_folded(), false),
        ] {
            let back = match ChatMessage::from_datmap(&m.to_datmap()) {
                Ok(b)  => b,
                Err(e) => panic!("{}", e),
            };
            assert_eq!(m, back);
            assert_eq!(since, back.retired_since_fold(), "{:?}", back);
        }
        // A fold does not unmark: a result sent short goes out short again.
        assert!(ChatMessage::tool(fmt!("c4"), fmt!("b")).as_retired().as_folded().is_retired());
        assert!(!ChatMessage::tool(fmt!("c5"), fmt!("b")).as_folded().is_retired());
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

    #[test]
    fn test_session_pin_round_trips_and_an_r577_reader_ignores_it_00() {
        let mut s = Session::new("s1".to_string(), "Pinned".to_string(), "z-ai/glm-5.3".to_string());
        s.pin = Some(HostPin { model: "z-ai/glm-5.3".to_string(), host: "InferenceNet".to_string() });
        let m = s.to_datmap();
        let back = match Session::from_datmap(&m) {
            Ok(v)  => v,
            Err(e) => panic!("a pinned session did not load: {}", e),
        };
        assert_eq!(back.pin, s.pin, "the pin did not survive the round trip");
        // An r577 reader decodes by these keys alone, each with an `_ =>` fallback, so a key
        // outside them is never read.  The pin must be such a key and touch none of them.
        const R577_KEYS: [&str; 10] = ["id", "name", "created_at", "model", "messages",
            "prompt_tokens", "completion_tokens", "last_prompt_tokens", "cached_tokens", "cost_usd"];
        let mut bare = s.clone();
        bare.pin = None;
        let unpinned = bare.to_datmap();
        let mut extra = Vec::new();
        for (k, v) in m.iter() {
            match unpinned.get(k) {
                Some(w) => assert_eq!(v, w, "the pin changed an r577 field: {:?}", k),
                None    => extra.push(k.clone()),
            }
        }
        assert_eq!(extra, vec![dat!(PIN_KEY)], "the pin is not one key of its own");
        assert!(!R577_KEYS.contains(&PIN_KEY), "the pin's key is one an r577 reader reads");
        // A map with no pin -- every r577 save -- loads unpinned.
        let old = match Session::from_datmap(&unpinned) {
            Ok(v)  => v,
            Err(e) => panic!("an unpinned session did not load: {}", e),
        };
        assert_eq!(old.pin, None);
        // A malformed pin is no pin, never a refused session.
        let mut odd = unpinned.clone();
        odd.insert(dat!(PIN_KEY), dat!("InferenceNet"));
        let odd = match Session::from_datmap(&odd) {
            Ok(v)  => v,
            Err(e) => panic!("a malformed pin refused the session: {}", e),
        };
        assert_eq!(odd.pin, None);
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
            post:         String::new(),
            retired:      Retired::No,
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
            structured: true, model: fmt!("glm-5"), sp: fmt!("sp1:0123abcd"),
            cut: 41, summarised: true,
        };
        let dm = ev.to_datmap();
        assert_eq!(dm.get(&dat!("type")), Some(&dat!("compacted")));
        assert_eq!(dm.get(&dat!("folded")), Some(&Dat::U64(41)));
        assert_eq!(dm.get(&dat!("kept")), Some(&Dat::U64(7)));
        assert_eq!(dm.get(&dat!("content")), Some(&dat!("Folded 41 earlier messages.")));
        // And who wrote the summary, for the product record the notice carries.
        assert_eq!(dm.get(&dat!("model")), Some(&dat!("glm-5")));
        assert_eq!(dm.get(&dat!("sp")), Some(&dat!("sp1:0123abcd")));
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


// ┌───────────────────────────────────────────────────────────────┐
// │ Template tests                                                 │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
mod template_tests {
    use super::*;

    /// A Log Life Diamond as one is on disk after a year of use.
    ///
    /// Every path here is one something in this codebase really writes: the page and the seeded
    /// tables come from `CAPP_TEMPLATES.lifelog`, `log/` is where the shipped page puts what its
    /// user records, `transcript.md` is what "Keep as a Diamond" writes, and the three under
    /// `.daimond/` are the store's own. The bodies stand in for content, but each is distinctive
    /// enough that a test can say whether it travelled.
    fn log_life() -> Vec<(String, Vec<u8>)> {
        vec![
            (fmt!("crystal.html"),                  b"<p>Log Life</p>".to_vec()),
            (fmt!("crystal.json"),                  b"{\"summary\":\"I weigh 84kg\"}".to_vec()),
            (fmt!("index.json"),                    b"{\"v\":2}".to_vec()),
            (fmt!("lanes/gym.json"),                b"{\"lane\":\"gym\"}".to_vec()),
            (fmt!("cat/gym.json"),                  b"{\"squat\":1}".to_vec()),
            (fmt!("triggers.json"),                 b"{\"actions\":[]}".to_vec()),
            (fmt!("capp.json"),                     b"{\"capp\":\"lifelog\"}".to_vec()),
            (fmt!("log/2026-08-21.json"),           b"{\"ate\":\"two eggs\"}".to_vec()),
            (fmt!("transcript.md"),                 b"# what I told it about my heart".to_vec()),
            (fmt!("versions/0007.json"),            b"{\"summary\":\"I weighed 91kg\"}".to_vec()),
            (fmt!("versions/0007.html"),            b"<p>older page</p>".to_vec()),
            (fmt!(".daimond/meta.json"),            b"{\"name\":\"Log Life\"}".to_vec()),
            (fmt!(".daimond/log"),                  b"{\"task\":\"my blood results\"}".to_vec()),
            (fmt!(".daimond/links.jsonl"),          b"{\"from\":\"diamond:d1\"}".to_vec()),
            (fmt!(".daimond/deltas/0007.md"),       b"user: I have been drinking".to_vec()),
        ]
    }

    // The paths a template must carry, and the paths it must not.
    //
    // Named here rather than inline so the two directions are read together: a rule that keeps
    // everything passes the first list, and a rule that keeps nothing passes the second.
    const KEPT: [&str; 4] = [
        "crystal.html", "index.json", "lanes/gym.json", "cat/gym.json",
    ];
    const DROPPED: [&str; 11] = [
        // Automation, and the only entry here dropped for the RECEIVER's sake rather than
        // the sender's: a trigger fires without anybody pressing anything.
        "triggers.json",
        "crystal.json", "capp.json", "log/2026-08-21.json", "transcript.md",
        "versions/0007.json", "versions/0007.html",
        ".daimond/meta.json", ".daimond/log", ".daimond/links.jsonl", ".daimond/deltas/0007.md",
    ];

    /// A TEMPLATE CARRIES NO MESSAGES, and no memory, and no entries.
    ///
    /// Asserted against the PACK's bytes rather than against the filtered list, because the pack is
    /// what leaves the device: a filter that dropped a file and a packer that put it back would
    /// pass a test on the list and still send the user's life log. Each dropped path is named in
    /// the failure, so the assertion says which one escaped.
    #[test]
    fn test_a_template_carries_no_conversation_no_memory_and_no_entries() {
        let files = log_life();
        let kept  = template_files(&files, false);
        let pack  = pack_template("d1", 42, "Log Life", &kept);

        for path in DROPPED.iter() {
            assert!(!pack.contains(path),
                "a template carried '{}', which is the owner's own record and not the shape of \
                 anything: {}", path, pack);
        }
        // And the bodies, not only the paths: a pack that named no file and carried the bytes
        // anyway would pass the loop above.
        for body in ["I weigh 84kg", "two eggs", "my heart", "I weighed 91kg", "blood results",
                     "been drinking"].iter() {
            assert!(!pack.contains(body),
                "a template carried the words '{}' out of the owner's Diamond: {}", body, pack);
        }
        // The other direction, so this cannot be passed by a template that carries nothing at all.
        for path in KEPT.iter() {
            assert!(pack.contains(path),
                "a template did not carry '{}', without which it is not the Diamond it is a \
                 template of: {}", path, pack);
        }
    }

    /// The classification, path by path, as the table in the brief has it.
    #[test]
    fn test_each_path_falls_on_the_side_it_was_classified_on() {
        for path in KEPT.iter() {
            assert!(template_carries(path), "'{}' is shape and was dropped", path);
        }
        for path in DROPPED.iter() {
            assert!(!template_carries(path), "'{}' is contents and was carried", path);
        }
        // `capp.json` is refused AT THE ROOT and nowhere else, which is the distinction
        // `fe2o3_sbj` draws: one inside a folder of the user's own making is ordinary data.
        assert!(template_carries("recipes/capp.json"),
            "a file that merely shares a name with the delivery record was dropped");
        // A bare `log` file is the file form of the `log/` prefix, and `logbook.md` is not.
        assert!(!template_carries("log"), "the entries file was carried");
        assert!(template_carries("logbook.md"), "a file whose name begins with 'log' was dropped");
    }

    /// The door back to a complete copy carries everything -- and is still a template.
    #[test]
    fn test_the_conversation_door_carries_everything_and_is_still_a_template() {
        let files = log_life();
        let all   = template_files(&files, true);
        assert_eq!(all.len(), files.len(), "a complete copy left something behind");
        let pack = pack_template("d1", 42, "Log Life", &all);
        for (path, _) in files.iter() {
            assert!(pack.contains(path.as_str()), "a complete copy did not carry '{}'", path);
        }
        assert_eq!(PackKind::Template, PackKind::of(&pack),
            "a complete copy did not say it was a template, so it would be imported OVER the \
             Diamond it was copied from");
    }

    /// A template and a whole Diamond are distinguishable, and a whole Diamond's pack is exactly
    /// the bytes it always was.
    #[test]
    fn test_a_pack_says_which_kind_it_is() {
        let files = vec![(fmt!("crystal.html"), b"<p>x</p>".to_vec())];
        let whole = pack_diamond("d1", 42, &files);
        assert_eq!(PackKind::Diamond, PackKind::of(&whole));
        assert!(!whole.contains(PACK_KIND),
            "a whole Diamond's pack grew a field, so every Diamond on every device would look \
             changed to the sync once: {}", whole);

        let tmpl = pack_template("d1", 42, "Log Life", &files);
        assert_eq!(PackKind::Template, PackKind::of(&tmpl));
        assert!(tmpl.contains("\"name\":\"Log Life\""),
            "a template did not carry what to call the Diamond it opens as: {}", tmpl);

        // The kind is read from the HEAD of the pack. A Diamond holding a file called `kind` must
        // not be able to say what kind of pack it is in.
        let sneaky = pack_diamond("d1", 42, &vec![(fmt!("kind"), b"template".to_vec())]);
        assert_eq!(PackKind::Diamond, PackKind::of(&sneaky),
            "a file inside the Diamond decided what kind of pack it was travelling in: {}", sneaky);
    }

    /// What a colliding mint answers, so the retry below has something that collides.
    fn always_taken() -> String { fmt!("d1") }

    /// The first two ids are already Diamonds and the third is not.
    fn third_time_lucky() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        fmt!("d{}", N.fetch_add(1, Ordering::Relaxed) + 1)
    }

    /// AN EXISTING DIAMOND IS NEVER WRITTEN OVER.
    ///
    /// The pack's own id is in `taken`, which is the case that matters: the person most likely to
    /// open a Log Life template is the one whose Log Life it was made from.
    #[test]
    fn test_an_existing_diamond_is_never_written_over() {
        let taken: Vec<String> = vec![fmt!("d1"), fmt!("d2"), fmt!("19fb11892cdc")];
        let id = fresh_id(&taken).expect("an id had to be minted");
        assert!(!taken.contains(&id),
            "an imported template was to be written at '{}', where there is already a Diamond", id);
        assert_ne!(fmt!("d1"), id, "an imported template took the id the pack named");

        // The retry itself, with a mint that is made to collide. Two ids are already Diamonds, so
        // a `fresh_id` that minted once and hoped would answer 'd1' and destroy it.
        let id = fresh_id_from(&taken, third_time_lucky).expect("the third id was free");
        assert_eq!(fmt!("d3"), id, "the mint was not tried again after it collided");

        // And a mint that never gets clear of the store FAILS, rather than answering an id that is
        // taken. Silence here would be a deletion.
        assert!(fresh_id_from(&taken, always_taken).is_err(),
            "an id that is already a Diamond was answered as a fresh one");
    }

    /// Two imports in a row do not land on each other.
    #[test]
    fn test_two_templates_opened_in_a_row_get_different_ids() {
        let one = fresh_id(&[]).expect("an id had to be minted");
        let two = fresh_id(&[one.clone()]).expect("a second id had to be minted");
        assert_ne!(one, two, "two templates opened in a row took the same id");
    }

    /// A complete copy's records point at the Diamond it landed in, not the one it came from.
    #[test]
    fn test_a_complete_copy_is_readdressed_to_where_it_landed() {
        let log = b"{\"delta_ref\":\"diamonds/d1/.daimond/deltas/0007.md\"}".to_vec();
        let out = retarget(".daimond/log", log, "d1", "d9");
        assert_eq!("{\"delta_ref\":\"diamonds/d9/.daimond/deltas/0007.md\"}",
            String::from_utf8_lossy(&out),
            "a stored delta still points at the Diamond the copy was made from");

        let links = b"{\"from\":\"diamond:d1\",\"to\":\"file:diamonds/d1/lanes/gym.json\"}".to_vec();
        let out = retarget(".daimond/links.jsonl", links, "d1", "d9");
        assert!(!String::from_utf8_lossy(&out).contains("d1"),
            "a link still names the Diamond the copy was made from: {}",
            String::from_utf8_lossy(&out));

        // And NOTHING ELSE is rewritten. A page that mentions the id is prose, not a reference,
        // and a picture is not text at all.
        let page = b"<p>made in diamonds/d1/</p>".to_vec();
        assert_eq!(page.clone(), retarget("crystal.html", page, "d1", "d9"),
            "a search and replace reached a file that holds no reference");
    }

    /// EXPORT A TEMPLATE, OPEN IT, AND THE ORIGINAL IS UNTOUCHED.
    ///
    /// The store is a list of workspace-relative paths and their bytes, which is what OPFS holds;
    /// `wasm::diamond` is compiled only for the browser, so the walk and the writes are simulated
    /// here over the same pure functions the browser calls -- `template_files` to choose,
    /// `pack_template` to pack, `fresh_id` to mint, `retarget` to readdress.
    #[test]
    fn test_a_template_round_trip_leaves_the_original_alone() {
        let mut store: Vec<(String, Vec<u8>)> = log_life().into_iter()
            .map(|(rel, body)| (fmt!("diamonds/d1/{}", rel), body))
            .collect();
        let before = store.clone();

        // Export.
        let files = log_life();
        let kept  = template_files(&files, false);
        let pack  = pack_template("d1", 42, "Log Life", &kept);
        assert_eq!(PackKind::Template, PackKind::of(&pack));

        // Open. The id is minted against what the store already holds, and never taken from the
        // pack.
        let taken: Vec<String> = vec![fmt!("d1")];
        let new_id = fresh_id(&taken).expect("an id had to be minted");
        assert_ne!(fmt!("d1"), new_id, "the template landed on the Diamond it was made from");
        for (rel, body) in kept.iter() {
            let bytes = retarget(rel, body.clone(), "d1", &new_id);
            // An UPSERT, because that is what a write to a path does: an import that reused the
            // pack's id would land on the original's files and replace them, and a store that
            // merely appended would hide exactly the loss this test is here to catch.
            let at = fmt!("diamonds/{}/{}", new_id, rel);
            match store.iter().position(|(p, _)| *p == at) {
                Some(i) => store[i] = (at, bytes),
                None    => store.push((at, bytes)),
            }
        }

        // The original, byte for byte, still there.
        for (path, body) in before.iter() {
            let found = store.iter().find(|(p, _)| p == path);
            match found {
                Some((_, now)) => assert_eq!(body, now,
                    "the original Diamond's '{}' was rewritten by an import", path),
                None => panic!("the original Diamond lost '{}' to an import", path),
            }
        }
        // Nothing new on disk means every write landed on a path that was already there, which is
        // what an import that took the pack's id does: it replaces the original file by file.
        assert!(store.len() > before.len(),
            "the import added no file to the store, so it wrote over the Diamond it came from");

        // The new Diamond has the shape.
        let home = fmt!("diamonds/{}/", new_id);
        let mine: Vec<&String> = store.iter().map(|(p, _)| p).filter(|p| p.starts_with(&home))
            .collect();
        for path in KEPT.iter() {
            assert!(mine.iter().any(|p| p.ends_with(path)),
                "the new Diamond has no '{}', so it is not the Diamond it is a template of", path);
        }
        for path in DROPPED.iter() {
            assert!(!mine.iter().any(|p| p.ends_with(path)),
                "the new Diamond arrived holding '{}', out of somebody else's Diamond", path);
        }
    }
}
