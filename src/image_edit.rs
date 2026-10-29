//! `image_edit`: a picture and an instruction to an image-output model, the result landing as a
//! new file (UNBLOCK-9, D-20261014-06 "colourise Rozina.jpg").
//!
//! The decisions are made and tested here: the request body, the default out path, what the
//! reply carries and the sentence the model is given.  The transport is the host's
//! (`HostNet::image_model` and `HostNet::openrouter_images`): the tab posts straight to
//! OpenRouter as `ocr` does, the runner through its own OCR keys, and neither ever reaches the
//! gateway, so the gateway sees no picture and no key.
//!
//! The reply shape was settled by one live call on 26 Oct 2026
//! (`black-forest-labs/flux-3-image-klein`): `{"created":0,"data":[{"b64_json":"…",
//! "media_type":"image/jpeg"}],"usage":{…,"cost":0.009,…}}`.  A provider error comes back as
//! `{"error":{"message":"…","code":422,…}}`, and its message may echo the input picture's base64,
//! so only its head is ever quoted.

use crate::llm::{
    extract_json_f64,
    extract_json_string,
    json_escape,
};
use crate::protocol::ImageMedia;

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_text::base64;

/// The model an image edit runs on, and its catalogue price in words (empty where unknown).
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ImageModel {
    pub id:    String,
    pub price: String,
}

/// What a reply gave: the picture, or the sentence saying why there is none.
#[derive(Clone, Debug, PartialEq)]
pub enum ImageReply {
    Made { bytes: Vec<u8>, media: Option<ImageMedia>, cost: Option<f64> },
    Refused(String),
}

const ERROR_QUOTE_MAX: usize = 200; // a provider's message is cut here: it may echo the picture

/// The Image API body: one input picture as a `data:` URL, the instruction as the prompt, and
/// the result asked for inline so no second fetch is needed.
pub fn body(model: &str, instruction: &str, data_url: &str) -> String {
    fmt!(
        r#"{{"model":"{}","prompt":"{}","input_references":[{{"type":"image_url","image_url":{{"url":"{}"}}}}],"response_format":"b64_json"}}"#,
        json_escape(model), json_escape(instruction), json_escape(data_url))
}

/// The out path the model did not name: a sibling `<stem>.<slug>.<ext>`, so his original is
/// never the file written.  The slug is the instruction's first word with an `-ise`/`-ize`
/// ending taken off ("colourise" gives `colour`), else `edit`.  The extension is the source's
/// where it is one the services return (JPEG, PNG, WebP), else `png`.
pub fn default_out(path: &str, instruction: &str) -> String {
    let (dir, file) = match path.rfind('/') {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None    => ("", path),
    };
    let (stem, ext) = match file.rfind('.') {
        Some(i) if i > 0 => (&file[..i], file[i + 1..].to_ascii_lowercase()),
        _                => (file, String::new()),
    };
    let ext = match ext.as_str() {
        "jpg" | "jpeg" | "png" | "webp" => ext,
        _                               => fmt!("png"),
    };
    fmt!("{}{}.{}.{}", dir, stem, slug(instruction), ext)
}

/// The instruction's first word, lower case, letters and digits only, at most 24 of them.
fn slug(instruction: &str) -> String {
    let word: String = instruction.split(|c: char| !c.is_alphanumeric())
        .find(|w| !w.is_empty())
        .unwrap_or("")
        .to_lowercase()
        .chars()
        .take(24)
        .collect();
    let cut = ["ise", "ize"].iter().find_map(|end| {
        word.strip_suffix(end).filter(|s| s.chars().count() >= 4).map(|s| s.to_string())
    });
    match cut {
        Some(s)                => s,
        None if word.is_empty() => fmt!("edit"),
        None                   => word,
    }
}

/// What the Image API answered: `data[0].b64_json` decoded, with what the bytes are and what the
/// call cost where the reply says; or a sentence for an error, an empty reply or a link.
pub fn parse(raw: &str, model: &str) -> ImageReply {
    if let Some(at) = raw.find("\"error\"") {
        let said = extract_json_string(&raw[at..], "message").unwrap_or_default();
        let head: String = said.chars().take(ERROR_QUOTE_MAX).collect();
        return ImageReply::Refused(fmt!(
            "image_edit: {} refused the picture: {}{}", model, head,
            if said.chars().count() > ERROR_QUOTE_MAX { "…" } else { "" }));
    }
    let b64 = extract_json_string(raw, "b64_json").unwrap_or_default();
    if b64.is_empty() {
        let why = match extract_json_string(raw, "url") {
            Some(_) => "sent a link to the picture rather than the picture",
            None    => "returned no picture",
        };
        return ImageReply::Refused(fmt!(
            "image_edit: {} {}, so nothing was written. Try another image model.", model, why));
    }
    let bytes = match base64::decode(&b64) {
        Ok(b)  => b,
        Err(_) => return ImageReply::Refused(fmt!(
            "image_edit: {}'s picture could not be decoded, so nothing was written.", model)),
    };
    let declared = extract_json_string(raw, "media_type");
    let media = match picture(&bytes, declared.as_deref()) {
        Ok(m)       => m,
        Err(why)    => return ImageReply::Refused(fmt!("image_edit: {}'s reply {}, so nothing was \
            written. Try another image model.", model, why)),
    };
    let cost = raw.find("\"usage\"").and_then(|at| extract_json_f64(&raw[at..], "cost"));
    ImageReply::Made { media: Some(media), bytes, cost }
}

/// What `bytes` are, where they are a whole picture of the type their leading bytes name and of
/// the type `declared` (a `Content-Type` or `media_type`) names, if any; else why not, as a
/// clause (R3 QA-a F1: a linked body that is not a picture never lands).  PNG, JPEG and GIF are
/// decoded in full; WebP, which fe2o3 does not decode, has its RIFF container walked to the end.
pub fn picture(bytes: &[u8], declared: Option<&str>) -> Result<ImageMedia, String> {
    let media = match ImageMedia::sniff(bytes) {
        Some(m) => m,
        None    => return Err(String::from("was not a picture")),
    };
    if let Some(d) = declared {
        let d = d.split(';').next().unwrap_or("").trim();
        let named = d.eq_ignore_ascii_case(media.mime())
            || (media == ImageMedia::Jpeg && d.eq_ignore_ascii_case("image/jpg"));
        if !named {
            return Err(fmt!("was declared {:?} but holds {}", d, media.mime()));
        }
    }
    let whole = match media {
        ImageMedia::Png     => oxedyne_fe2o3_graphics::png::decode(bytes).is_ok(),
        ImageMedia::Jpeg    => oxedyne_fe2o3_graphics::jpeg::decode(bytes).is_ok(),
        ImageMedia::Gif     => oxedyne_fe2o3_graphics::gif::decode(bytes).is_ok(),
        ImageMedia::WebP    => webp_whole(bytes),
    };
    match whole {
        true    => Ok(media),
        false   => Err(fmt!("held {} that would not decode", media.mime())),
    }
}

/// Is `b` a whole WebP container: `RIFF` sized to the byte, `WEBP`, its first chunk an image's
/// (`VP8 ` with the key frame's start code, `VP8L` with its signature, or `VP8X`), and every
/// chunk inside the size?
fn webp_whole(b: &[u8]) -> bool {
    let le = |i: usize| b.get(i..i + 4).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]]) as usize);
    if b.len() < 20 || &b[0..4] != b"RIFF" || &b[8..12] != b"WEBP" || le(4) != Some(b.len() - 8) {
        return false;
    }
    let first = &b[12..16];
    let ok_first = match first {
        b"VP8 " => b.get(23..26) == Some(&[0x9d, 0x01, 0x2a][..]),
        b"VP8L" => b.get(20) == Some(&0x2f),
        b"VP8X" => true,
        _       => false,
    };
    if !ok_first {
        return false;
    }
    let mut at = 12;
    while at < b.len() {
        let size = match le(at + 4) {
            Some(n) => n,
            None    => return false,
        };
        // fixed: RIFF pads each chunk to an even length.
        at = match (at + 8).checked_add(size + (size & 1)) {
            Some(n) => n,
            None    => return false,
        };
    }
    at == b.len()
}

/// The `https` address a reply's picture is linked at, where it carries a link and no picture:
/// the one reply the runner fetches before parsing, as `ocr.js`'s `inlined` does on the tab.
pub fn linked(raw: &str) -> Option<String> {
    if raw.contains("\"error\"") || !extract_json_string(raw, "b64_json").unwrap_or_default().is_empty() {
        return None;
    }
    extract_json_string(raw, "url").filter(|u| u.starts_with("https://"))
}

/// The reply `raw` again with the linked picture's `bytes` carried inline, in the one shape
/// [`parse`] reads, its cost kept.
pub fn inlined(raw: &str, bytes: &[u8]) -> String {
    let cost = raw.find("\"usage\"").and_then(|at| extract_json_f64(&raw[at..], "cost"));
    match cost {
        Some(c) => fmt!(r#"{{"data":[{{"b64_json":"{}"}}],"usage":{{"cost":{}}}}}"#, base64::encode(bytes), c),
        None    => fmt!(r#"{{"data":[{{"b64_json":"{}"}}]}}"#, base64::encode(bytes)),
    }
}

/// The sentence a landed edit is reported with: where, from what, by which model, and its cost.
pub fn made_line(src: &str, out: &str, model: &ImageModel, bytes: usize, cost: Option<f64>,
    media: Option<ImageMedia>) -> String
{
    let mut s = fmt!("Made {} from {} with {} ({} bytes", out, src, model.id, bytes);
    if !model.price.is_empty() {
        s.push_str(&fmt!("; listed at {}", model.price));
    }
    if let Some(c) = cost {
        s.push_str(&fmt!("; this call cost ${:.3}", c));
    }
    s.push_str(").");
    // The name was chosen before the reply; say so when the bytes are another format.
    let ext = out.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if let Some(m) = media {
        let fits = match m {
            ImageMedia::Jpeg => ext == "jpg" || ext == "jpeg",
            ImageMedia::Png  => ext == "png",
            ImageMedia::WebP => ext == "webp",
            ImageMedia::Gif  => ext == "gif",
        };
        if !fits {
            s.push_str(&fmt!(" The model returned {} bytes under that name.", m.mime()));
        }
    }
    s
}

#[cfg(test)]
#[path = "../tests/unit/image_edit/tests.rs"]
mod tests;
