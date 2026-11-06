//! BIGRESULT C and D (06 Nov 2026): a tool result longer than the cap is cut at a character
//! boundary, as Claude Code cuts one at 50,000 characters, and on Kimberlite the whole is kept in
//! the chat's own spill folder, which a later `file_read` of the named path reads back.

use super::*;

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

/// The cap on one tool result and, on Kimberlite, the chat's folder for the whole of a cut one.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ResultCap {
    pub max_chars:  usize,          // `run.tool_result_max`; 0 cuts nothing
    pub spill:      Option<Spill>,  // none in the tab: the cut says the whole was not kept
}

/// A chat's spill folder, made by the runner, and the most its files may hold together.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Spill {
    pub dir:        PathBuf,    // absolute, the chat's own
    pub max_bytes:  u64,        // `run.spill_chat_max`
}

/// The names of the files the per-chat cap dropped, one a line, in the chat's folder.
const DROPPED: &str = "dropped.log"; // fixed: the folder's own record, never a spill
/// The ending every spill file has, and nothing else in the folder.
const SPILL_EXT: &str = ".txt"; // fixed: the spill's own naming

// The cut line's fixed words, which [`ResultCap::cut_of`] reads back for the page.
const CUT_HEAD: &str = " result cut: the first ";   // fixed: the cut line's own format
const CUT_OF:   &str = " of ";                      // fixed: the cut line's own format
const CUT_UNIT: &str = " characters";               // fixed: the cut line's own format

/// The engine's limits (`src/limits.jdat`), compiled in.
const LIMITS: &str = include_str!("../limits.jdat");

impl ResultCap {

    /// The tab's cap: `run.tool_result_max` from the engine's limits, and no spill.
    pub fn tab() -> Outcome<Self> {
        let d = res!(Dat::decode_string(LIMITS));
        let run = res!(d.map_get_map(&Dat::Str(fmt!("run"))));
        let n = res!(run.map_get_u64(&Dat::Str(fmt!("tool_result_max"))));
        Ok(Self { max_chars: n as usize, spill: None })
    }

    /// The characters shown and the whole's, read off the cut line [`ResultCap::cut`] ended
    /// `text` with, or `None` where it was not cut.
    pub fn cut_of(text: &str) -> Option<(usize, usize)> {
        let at = text.rfind("\n\n[")?;
        let line = &text[at..];
        let rest = &line[line.find(CUT_HEAD)? + CUT_HEAD.len()..];
        let (shown, rest) = rest.split_once(CUT_OF)?;
        let (whole, _) = rest.split_once(CUT_UNIT)?;
        Some((shown.parse().ok()?, whole.parse().ok()?))
    }

    /// `out` as the conversation gets it: a text result over `max_chars` cut, with one line naming
    /// where the whole is (or that it was not kept).  A result carrying an image is not cut, as
    /// Claude Code cuts only one with no image content.
    pub fn cut(&self, tool: &str, out: MessageContent) -> MessageContent {
        let text = match &out {
            MessageContent::Text(s) => s,
            MessageContent::Parts(_) => return out,
        };
        if self.max_chars == 0 || engine_rule_off("result_spill") {
            return out;
        }
        let end = match text.char_indices().nth(self.max_chars) {
            Some((i, _)) => i,
            None         => return out,
        };
        let chars = text.chars().count();
        let mut kept = text[..end].to_string();
        // A stranger's envelope opened in the part kept is closed, or every later result would
        // read as the stranger's words.
        if kept.matches(UNTRUSTED_OPEN).count() > kept.matches(UNTRUSTED_CLOSE).count() {
            kept.push('\n');
            kept.push_str(UNTRUSTED_CLOSE);
        }
        let note = match &self.spill {
            None    => fmt!(" are shown, and the whole was not kept. Ask for less: a narrower \
                command, a pattern, or an offset.]"),
            Some(s) => match s.keep(tool, text) {
                Ok(p)   => fmt!(" are shown. The whole, {} bytes, is in {}: read it with file_read \
                    and an offset, or search it with a command.]", text.len(), p.display()),
                Err(e)  => fmt!(" are shown, and the whole was not kept: {}]", e.plain()),
            },
        };
        kept.push_str(&fmt!("\n\n[{}{}{}{}{}{}", tool, CUT_HEAD, self.max_chars, CUT_OF, chars,
            CUT_UNIT));
        kept.push_str(&note);
        MessageContent::Text(kept)
    }

    /// A `file_read` of a path in the chat's spill folder, answered from it: the page asked for,
    /// a stranger's content enveloped again, or why the file is not there.  `None` for any other
    /// path, which the file tools answer.
    pub fn read<H: Host>(&self, args: &str, ctx: &ToolContext<H>) -> Option<String> {
        let s = match &self.spill {
            Some(s) => s,
            None    => return None,
        };
        let raw = extract_json_string(args, "path")?;
        let name = s.name_of(&raw)?;
        let at = s.dir.join(&name);
        match fs::read(&at) {
            Ok(b)   => {
                let text = String::from_utf8_lossy(&b).into_owned();
                let stranger = text.contains(UNTRUSTED_OPEN);
                let view = Tool::read_view_of(args, &raw, stranger, &text, None);
                Some(Tool::mark_if_from(ctx, &raw, stranger, view))
            },
            Err(_)  => Some(match s.was_dropped(&name) {
                true    => fmt!("{} was dropped: the chat's spill keeps the newest results within \
                    run.spill_chat_max ({} bytes). Run the call again for what it held.",
                    raw, s.max_bytes),
                false   => fmt!("{} is not in this chat's spill: it was swept with the chat, or \
                    never kept. Run the call again for what it held.", raw),
            }),
        }
    }
}

impl Spill {

    /// The file name `raw` names in this folder, or `None` where it names anywhere else.
    fn name_of(&self, raw: &str) -> Option<String> {
        if !raw.starts_with('/') || raw.split('/').any(|c| c == "..") {
            return None;
        }
        let dir = normalise(&self.dir.to_string_lossy());
        let rest = normalise(raw).strip_prefix(&dir)?.strip_prefix('/')?.to_string();
        match !rest.is_empty() && !rest.contains('/') && rest.ends_with(SPILL_EXT) {
            true    => Some(rest),
            false   => None,
        }
    }

    fn was_dropped(&self, name: &str) -> bool {
        match fs::read_to_string(self.dir.join(DROPPED)) {
            Ok(t)   => t.lines().any(|l| l == name),
            Err(_)  => false,
        }
    }

    /// Keeps `text`, the whole of `tool`'s result, as a new file, after dropping the oldest files
    /// until it fits in `max_bytes` beside the rest.  Each dropped name is recorded, so a later
    /// read of it is told why it is gone.
    pub fn keep(&self, tool: &str, text: &str) -> Outcome<PathBuf> {
        let size = text.len() as u64;
        if size > self.max_bytes {
            return Err(err!("it is {} bytes, over the chat's whole spill of {} bytes \
                (run.spill_chat_max).", size, self.max_bytes; Excessive, Input));
        }
        res!(make_private(&self.dir));
        let mut files: Vec<(String, u64)> = Vec::new();
        if let Ok(rd) = fs::read_dir(&self.dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.ends_with(SPILL_EXT) {
                    files.push((name, e.metadata().map(|m| m.len()).unwrap_or(0)));
                }
            }
        }
        // The names begin with the time, zero-padded, so their order is their age.
        files.sort();
        let mut total: u64 = files.iter().map(|f| f.1).sum();
        let mut dropped = Vec::new();
        for (name, n) in files {
            if total.saturating_add(size) <= self.max_bytes {
                break;
            }
            if fs::remove_file(self.dir.join(&name)).is_ok() {
                total = total.saturating_sub(n);
                dropped.push(name);
            }
        }
        if !dropped.is_empty() {
            let mut log = res!(private_file(&self.dir.join(DROPPED), true));
            res!(log.write_all(fmt!("{}\n", dropped.join("\n")).as_bytes()));
        }
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let tool: String = tool.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '-' }).collect();
        let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis()).unwrap_or(0);
        loop {
            let name = fmt!("{:015}-{}-{}{}", ms, SEQ.fetch_add(1, Ordering::Relaxed), tool, SPILL_EXT);
            let at = self.dir.join(&name);
            match private_file(&at, false) {
                Ok(mut f)   => {
                    res!(f.write_all(text.as_bytes()));
                    return Ok(at);
                },
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e)      => return Err(err!(e, "The spill file '{}' could not be made.",
                    at.display(); IO, File, Write)),
            }
        }
    }
}

/// Makes `d`, his alone.
fn make_private(d: &Path) -> Outcome<()> {
    let mut b = fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700); // fixed: his alone
    match b.create(d) {
        Ok(())  => Ok(()),
        Err(e)  => Err(err!(e, "The chat's spill folder '{}' could not be made.", d.display();
            IO, File, Write)),
    }
}

/// A new file (or, with `append`, the end of one) at `at`, his alone.
fn private_file(at: &Path, append: bool) -> std::io::Result<fs::File> {
    let mut o = fs::OpenOptions::new();
    match append {
        true    => o.append(true).create(true),
        false   => o.write(true).create_new(true),
    };
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600); // fixed: his alone
    o.open(at)
}
