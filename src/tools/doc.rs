use super::*;

// ┌───────────────────────────────────────────────────────────────┐
// │ A crystal that does not parse                                  │
// └───────────────────────────────────────────────────────────────┘

// Where the scan stopped, and why.
pub(super) type JsonFault = (usize, String);

// The index after the value, or the fault.
pub(super) type JsonScan  = std::result::Result<usize, JsonFault>;

// How deep the scan goes before it calls the nesting a fault.
pub(super) const JSON_DEPTH_MAX: usize = 256;

// `?` is not used in this codebase, so a failed step returns its fault by hand.
macro_rules! scan {
    ($e:expr) => {
        match $e {
            Ok(v)  => v,
            Err(f) => return Err(f),
        }
    };
}

// A strict reader of RFC 8259 text over characters, built to refuse exactly what `JSON.parse`
// refuses.  The browser is the reader that matters: it is what draws the crystal and what the
// owner's panel asks, and a crystal it cannot parse is shown as raw text and drawn as nothing.
pub(super) struct JsonReader<'a> {
    pub(super) c: &'a [char],
}

impl<'a> JsonReader<'a> {
    pub(super) fn at(&self, i: usize) -> Option<char> {
        self.c.get(i).copied()
    }

    // JSON whitespace is these four and no other; a byte order mark or a no-break space is not.
    pub(super) fn ws(&self, mut i: usize) -> usize {
        while let Some(' ') | Some('\t') | Some('\n') | Some('\r') = self.at(i) {
            i += 1;
        }
        i
    }

    // The text stopped before the thing being read was complete.
    pub(super) fn ended(&self, inside: &str) -> JsonFault {
        (self.c.len(), fmt!("the text ends inside {}", inside))
    }

    // A character that cannot start or continue the thing being read.
    pub(super) fn stray(&self, i: usize, want: &str) -> JsonFault {
        match self.at(i) {
            Some('\u{feff}') => (i, fmt!("a byte order mark (U+FEFF) before the JSON; save the \
                file as UTF-8 without one")),
            Some(c)          => {
                let mut shown = String::new();
                excerpt_char(&mut shown, c);
                (i, fmt!("unexpected character '{}', expected {}", shown, want))
            },
            None             => (i, fmt!("the text ends where {} was expected", want)),
        }
    }

    pub(super) fn top(&self, i: usize) -> JsonScan {
        match self.at(i) {
            Some('{')        => {},
            Some('\u{feff}') => return Err(self.stray(i, "an opening brace")),
            Some(_)          => return Err((i, fmt!("the crystal must be one JSON object, opening \
                with '{{'"))),
            None             => return Err(self.ended("nothing")),
        }
        let end = scan!(self.object(i, 1));
        let rest = self.ws(end);
        if rest < self.c.len() {
            return Err((rest, fmt!("extra text after the JSON object, which must be the whole \
                file")));
        }
        Ok(rest)
    }

    pub(super) fn value(&self, i: usize, depth: usize, inside: &str) -> JsonScan {
        if depth > JSON_DEPTH_MAX {
            return Err((i, fmt!("nested more than {} levels deep", JSON_DEPTH_MAX)));
        }
        match self.at(i) {
            None            => Err(self.ended(inside)),
            Some('"')       => self.string(i),
            Some('{')       => self.object(i, depth + 1),
            Some('[')       => self.array(i, depth + 1),
            Some('-')       => self.number(i),
            Some(c) if c.is_ascii_digit() => self.number(i),
            Some('t')       => self.literal(i, "true"),
            Some('f')       => self.literal(i, "false"),
            Some('n')       => self.literal(i, "null"),
            Some(_)         => Err(self.stray(i, "a value")),
        }
    }

    pub(super) fn literal(&self, i: usize, word: &str) -> JsonScan {
        let n = word.chars().count();
        let same = self.c.len() >= i + n
            && self.c[i..i + n].iter().copied().eq(word.chars());
        if same {
            Ok(i + n)
        } else {
            Err((i, fmt!("expected true, false or null")))
        }
    }

    pub(super) fn digits(&self, mut i: usize) -> usize {
        while let Some(c) = self.at(i) {
            if !c.is_ascii_digit() {
                break;
            }
            i += 1;
        }
        i
    }

    // A digit must stand at `i`, or the number is incomplete.
    pub(super) fn need_digit(&self, i: usize, after: &str) -> std::result::Result<(), JsonFault> {
        match self.at(i) {
            Some(c) if c.is_ascii_digit() => Ok(()),
            Some(c)                       => Err((i, fmt!("expected a digit after {}, found '{}'",
                after, c.escape_default()))),
            None                          => Err((i, fmt!("the text ends where a digit should \
                follow {}", after))),
        }
    }

    pub(super) fn number(&self, mut i: usize) -> JsonScan {
        if self.at(i) == Some('-') {
            i += 1;
            scan!(self.need_digit(i, "the minus sign"));
        }
        if self.at(i) == Some('0') {
            i += 1;
            if let Some(c) = self.at(i) {
                if c.is_ascii_digit() {
                    return Err((i, fmt!("a number may not have a leading zero")));
                }
            }
        } else {
            i = self.digits(i);
        }
        if self.at(i) == Some('.') {
            i += 1;
            scan!(self.need_digit(i, "the decimal point"));
            i = self.digits(i);
        }
        if let Some('e') | Some('E') = self.at(i) {
            i += 1;
            if let Some('+') | Some('-') = self.at(i) {
                i += 1;
            }
            scan!(self.need_digit(i, "the exponent"));
            i = self.digits(i);
        }
        Ok(i)
    }

    // `i` is the opening quote.
    pub(super) fn string(&self, i: usize) -> JsonScan {
        let mut j = i + 1;
        loop {
            let c = match self.at(j) {
                Some(c) => c,
                // The last character is where the string was still being read.
                None    => return Err((self.c.len().saturating_sub(1),
                    fmt!("the text ends inside a string"))),
            };
            if c == '"' {
                return Ok(j + 1);
            }
            if (c as u32) < 0x20 {
                return Err((j, fmt!("a raw line break, tab or other control character inside a \
                    string; write it as \\n, \\t or \\u00XX")));
            }
            if c != '\\' {
                j += 1;
                continue;
            }
            match self.at(j + 1) {
                None                                       => return Err((self.c.len()
                    .saturating_sub(1), fmt!("the text ends inside a string"))),
                Some('"') | Some('\\') | Some('/') | Some('b')
                | Some('f') | Some('n') | Some('r') | Some('t') => j += 2,
                Some('u')                                  => {
                    let hex = (1..=4).all(|k| match self.at(j + 1 + k) {
                        Some(h) => h.is_ascii_hexdigit(),
                        None    => false,
                    });
                    if !hex {
                        return Err((j, fmt!("a \\u escape needs four hexadecimal digits")));
                    }
                    j += 6;
                },
                Some(e)                                    => return Err((j, fmt!(
                    "an unknown escape '\\{}' in a string; the escapes are \\\" \\\\ \\/ \\b \\f \
                    \\n \\r \\t and \\uXXXX", e.escape_default()))),
            }
        }
    }

    // `i` is the opening brace.
    pub(super) fn object(&self, i: usize, depth: usize) -> JsonScan {
        let mut j = self.ws(i + 1);
        if self.at(j) == Some('}') {
            return Ok(j + 1);
        }
        loop {
            match self.at(j) {
                None      => return Err(self.ended("an object")),
                Some('"') => {},
                Some(_)   => return Err(self.stray(j, "a key in double quotes")),
            }
            j = scan!(self.string(j));
            j = self.ws(j);
            match self.at(j) {
                None      => return Err(self.ended("an object")),
                Some(':') => {},
                Some(_)   => return Err(self.stray(j, "':' after the key")),
            }
            j = self.ws(j + 1);
            j = scan!(self.value(j, depth, "an object"));
            j = self.ws(j);
            match self.at(j) {
                None      => return Err(self.ended("an object")),
                Some('}') => return Ok(j + 1),
                Some(',') => {
                    let comma = j;
                    j = self.ws(j + 1);
                    if self.at(j) == Some('}') {
                        return Err((comma, fmt!("a trailing comma before the closing brace")));
                    }
                },
                Some(_)   => return Err(self.stray(j, "',' or '}' after a value")),
            }
        }
    }

    // `i` is the opening bracket.
    pub(super) fn array(&self, i: usize, depth: usize) -> JsonScan {
        let mut j = self.ws(i + 1);
        if self.at(j) == Some(']') {
            return Ok(j + 1);
        }
        loop {
            j = scan!(self.value(j, depth, "an array"));
            j = self.ws(j);
            match self.at(j) {
                None      => return Err(self.ended("an array")),
                Some(']') => return Ok(j + 1),
                Some(',') => {
                    let comma = j;
                    j = self.ws(j + 1);
                    if self.at(j) == Some(']') {
                        return Err((comma, fmt!("a trailing comma before the closing bracket")));
                    }
                },
                Some(_)   => return Err(self.stray(j, "',' or ']' after a value")),
            }
        }
    }
}

// A character as it reads inside a one-line excerpt.
pub(super) fn excerpt_char(out: &mut String, c: char) {
    match c {
        '\n'     => out.push_str("\\n"),
        '\r'     => out.push_str("\\r"),
        '\t'     => out.push_str("\\t"),
        '\u{feff}' => out.push_str("\\uFEFF"),
        c if (c as u32) < 0x20 => out.push_str(&fmt!("\\u{:04X}", c as u32)),
        c        => out.push(c),
    }
}

/// Why a crystal's text is not one JSON object the browser would parse, or nothing where it is.
///
/// A strict scanner that refuses what `JSON.parse` refuses: a byte order mark, a truncated file,
/// a raw line break inside a string, a trailing comma, single quotes, text after the object,
/// anything but an object at the top.  **Blank text is not a fault**, because a new Diamond is
/// created with an empty `crystal.json` and the page reads that as `{}`.
///
/// The reason carries the line, the column (1-based, in characters) and a one-line excerpt with
/// the place marked `<HERE>`, because a daimon given only "invalid JSON" went looking for the
/// cause in the page for fourteen minutes while the file it had written was cut short.
///
/// # Arguments
/// * `text` - The crystal exactly as it sits, or will sit, on disk.
pub fn crystal_json_fault(text: &str) -> Option<String> {
    crystal_json_fault_at(text).map(|(_, f)| f)
}

/// [`crystal_json_fault`], with the BYTE offset of the place it names, for a caller that has to
/// cut the text round it.
pub(super) fn crystal_json_fault_at(text: &str) -> Option<(usize, String)> {
    let chars: Vec<char> = text.chars().collect();
    let rd = JsonReader { c: &chars };
    let start = rd.ws(0);
    if start >= chars.len() {
        return None;
    }
    let (at, why) = match rd.top(start) {
        Ok(_)  => return None,
        Err(f) => f,
    };
    let at = at.min(chars.len());
    let (mut line, mut col) = (1usize, 1usize);
    for c in &chars[..at] {
        if *c == '\n' {
            line += 1;
            col   = 1;
        } else {
            col  += 1;
        }
    }
    let mut near = String::new();
    for c in &chars[at.saturating_sub(30)..at] {
        excerpt_char(&mut near, *c);
    }
    near.push_str("<HERE>");
    for c in &chars[at..(at + 20).min(chars.len())] {
        excerpt_char(&mut near, *c);
    }
    let byte = chars[..at].iter().map(|c| c.len_utf8()).sum();
    Some((byte, fmt!("{}, at line {}, column {} (character {}), near \"{}\"",
        why, line, col, at + 1, near)))
}

/// The refusal a write of an invalid `crystal.json` earns, or nothing.
///
/// The doors that take text from a daimon -- `file_write` and `file_edit` -- ask this beside
/// [`diamond_cap_refusal`], because a crystal that does not parse is shown to its owner as raw
/// text and drawn by the probe as an empty crystal, and until now nothing said so to the turn
/// that wrote it.  A blank crystal is a Diamond's starting state and is let through.
///
/// # Arguments
/// * `path` - The workspace-relative path being written.
/// * `new_text` - What the write would leave on disk.
pub fn crystal_invalid_refusal(path: &str, new_text: &str) -> Option<String> {
    if !is_crystal_data_path(path) {
        return None;
    }
    let fault = match crystal_json_fault(new_text) {
        Some(f) => f,
        None    => return None,
    };
    Some(refusal_line(&fmt!(
        "crystal.json is not valid JSON: {} -- so this write was NOT made and the file on disk \
        is as it was. Write the complete crystal again as ONE JSON object: a line break inside \
        a string is \\n, there is no byte order mark, and no comma comes before a closing \
        brace or bracket.", fault)))
}

/// What `file_edit` says of a crystal it would leave invalid, naming a crystal that was invalid
/// before the edit.
///
/// An edit that mends one place in a crystal broken in two is refused like any other, and the
/// bare "not valid JSON" gave a daimon no reason to think its own hunk was fine and the file was
/// already broken elsewhere -- so it went looking for the fault in what it had just written.
///
/// The place to mend is `now`, the fault the edit would leave, in the edited text's lines;
/// `was` is background.  Pointing at `was` sent a daimon whose edit had mended it back to that
/// place, and one that obeyed re-sent the same edit to its round cap (r541 QA A2, F2).
///
/// # Arguments
/// * `path` - The workspace-relative path being edited.
/// * `old_text` - The file as the edit found it.
/// * `new_text` - What the edit would leave on disk.
pub fn crystal_edit_refusal(path: &str, old_text: &str, new_text: &str) -> Option<String> {
    if !is_crystal_data_path(path) {
        return None;
    }
    let now = match crystal_json_fault(new_text) {
        Some(f) => f,
        None    => return None,
    };
    let was = match crystal_json_fault(old_text) {
        Some(f) => f,
        None    => return crystal_invalid_refusal(path, new_text),
    };
    Some(refusal_line(&fmt!(
        "crystal.json was already invalid before this edit ({}), and the edit would leave it not \
        valid JSON ({}) -- so this edit was NOT made and the file on disk is as it was. \
        Mend the place named last, which is where the text as this edit leaves it breaks, in the \
        same edit, or write the complete crystal again as ONE JSON object.", was, now)))
}

/// What `capture` with `in:"crystal"` says when it has nothing real to draw.
///
/// In words, and opening as a refusal does, so that the turn reads "nothing was drawn" and the
/// ledger does not book a picture that was never taken.  The probe used to draw an empty
/// stand-in and describe it, which sent a daimon looking for a layout fault in a page that was
/// never given its data.
///
/// # Arguments
/// * `why` - What could not be read, in a clause that follows "because".
pub(super) fn crystal_unreadable_line(why: &str) -> String {
    refusal_line(&fmt!(
        "capture with in:\"crystal\" drew nothing, because {}. No page was drawn from an empty \
        stand-in, so there is nothing to judge. Mend crystal.json (file_write of one valid JSON \
        object), then capture again.", why.trim_end_matches('.')))
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Hot and cold                                                   │
// └───────────────────────────────────────────────────────────────┘

/// The core keys that are hot whatever a crystal says.
///
/// `title` and `summary` are the schema's own answer to "what is this", which is the question a
/// daimon asks on every round; a crystal that made them cold would be a crystal whose standing
/// context said nothing at all.
///
/// **`open` WAS THE THIRD AND IS GONE FROM THE SCHEMA** (2026-09-15, `dev/CRYSTAL_CONTRACT.md`
/// §12): what is outstanding is [`REQUIREMENTS_FILE`]'s, ranked and ticked and checked against
/// the work a turn did, and two lists of the same thing is one list nobody trusts.  A crystal
/// that still carries the key after its Diamond's one-off migration is carried through as an
/// unknown key by the never-drop rule, and is cold like every other.
pub(super) const CRYSTAL_ALWAYS_HOT: [&str; 2] = ["title", "summary"];

/// One row of the outline a daimon is shown in place of the cold body.
#[derive(Debug, Clone, PartialEq)]
pub struct CrystalOutlineRow {
    pub key:     String,	// `sections` for a section, else the top-level key
    pub heading: String,	// the section's heading; empty for a plain key
    pub bytes:   usize,		// what it weighs as JSON
    pub hot:     bool,		// whether it rides in the prompt
}

/// A crystal as the prompt carries it: the hot text, and an outline of everything.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CrystalSplit {
    /// The JSON the system message carries -- the hot keys and the flagged sections, or the
    /// whole crystal when it was small enough to ride whole.
    pub hot:         String,
    /// Whether `hot` is the whole crystal, in which case the outline says nothing new.
    pub whole:       bool,
    /// Every section and every non-core key, with its size and whether it is hot.
    pub outline:     Vec<CrystalOutlineRow>,
    pub hot_bytes:   usize,
    pub total_bytes: usize,
    pub fault:       Option<String>,	// why the RAW text is not JSON the browser parses, if it is not
    /// Whether `hot` is an EXCERPT: a crystal over `hot_cap` that would not decode, cut to its
    /// start and the place of the fault so that it costs no more than a split would.  Never the
    /// text to write back.
    pub excerpt:     bool,
}

/// Whether a decoded section carries `"hot": true`, or the `!` spelling of it.
///
/// The flag is the JSON way to mark a JSON object, and a heading prefix would leak into the
/// rendered page and into a `to_markdown` round-trip.  The prefix is accepted all the same,
/// because a model that drops an unfamiliar key while rewriting a heading is a model this app
/// has already watched do exactly that with `facts`.
pub(super) fn crystal_hot_flag(sec: &Dat) -> bool {
    let m = match sec {
        Dat::Map(m) => m,
        _           => return false,
    };
    if let Some(v) = m.get(&Dat::Str(fmt!("hot"))) {
        if matches!(v, Dat::Bool(true)) {
            return true;
        }
    }
    match m.get(&Dat::Str(fmt!("heading"))) {
        Some(Dat::Str(h)) => h.trim_start().starts_with('!'),
        _                 => false,
    }
}

/// A section's heading, or empty where it has none.
pub(super) fn crystal_heading(sec: &Dat) -> String {
    match sec {
        Dat::Map(m) => match m.get(&Dat::Str(fmt!("heading"))) {
            Some(Dat::Str(h)) => h.clone(),
            _                 => String::new(),
        },
        _ => String::new(),
    }
}

/// What one decoded value weighs as JSON, or 0 where it cannot be encoded.
pub(super) fn crystal_bytes(d: &Dat) -> usize {
    d.json().map(|s| s.len()).unwrap_or(0)
}

/// Split a crystal into the part the prompt carries and an outline of the rest.
///
/// **TOTAL, and that is the property that matters.**  A crystal that will not parse -- one a
/// daimon left half-written, which is exactly the turn that must be able to mend it -- comes back
/// whole, with an empty outline, rather than as an error; the caller pushes the same bytes it
/// pushed before this function existed.  Only a decode that runs out of depth or bytes fails, and
/// the one caller that can be refused by that is the write door, which then says nothing about a
/// hot part it could not measure.
///
/// A crystal whose WHOLE text fits `hot_cap` rides whole, which is every small crystal: of
/// twenty-three seen in one live store, twenty-two were between 0.5 and 2 KB.
///
/// The outline's order is the DECODER'S, which is alphabetical rather than the order the keys sit
/// in the file, because that is what the map it decodes into gives back.  Sections keep their own
/// order, which is the one a reader cares about.
///
/// # Arguments
/// * `json` - The crystal exactly as it sits on disk.
/// * `hot_cap` - The ceiling the hot part is measured against.
pub fn crystal_split(json: &str, hot_cap: usize) -> Outcome<CrystalSplit> {
    // The fault of the RAW text, asked once and carried on every shape of answer.  The decoder
    // below is lenient -- it reads a trailing comma, a comment, a raw line break, a byte order
    // mark -- so a split that has decoded says nothing about whether the browser can parse the
    // file, and the prompt used to tell only a crystal that rode whole.
    let fault = crystal_json_fault(json);
    let whole_split = |bytes: usize| CrystalSplit {
        hot:         json.to_string(),
        whole:       true,
        outline:     Vec::new(),
        hot_bytes:   bytes,
        total_bytes: bytes,
        fault:       fault.clone(),
        excerpt:     false,
    };
    let total = json.len();
    if total <= hot_cap {
        return Ok(whole_split(total));
    }
    let cfg = crate::agent::compact::json_cfg();
    let map = match Dat::decode_string_with_config(crystal_decode_text(json), &cfg) {
        Ok(Dat::Map(m)) => m,
        // Not one object, or not JSON at all, and too big to ride whole: its start and the place
        // of the fault, no more than a split would cost.  It went whole until 16 Oct, with no
        // ceiling at all, so a legacy crystal past the total cap rode every round (d1z0-check §3).
        // Valid JSON this decoder refuses -- a duplicate key, a lone surrogate, deep nesting --
        // passes the scanner and the browser, so it rides whole as before (d1z0c-check §2).
        _ if fault.is_none() => return Ok(whole_split(total)),
        _               => {
            let at = crystal_json_fault_at(json).map(|(at, _)| at);
            let hot = crystal_excerpt(json, at, hot_cap);
            return Ok(CrystalSplit {
                hot_bytes:   hot.len(),
                hot,
                whole:       false,
                outline:     Vec::new(),
                total_bytes: total,
                fault,
                excerpt:     true,
            });
        },
    };

    let mut outline: Vec<CrystalOutlineRow> = Vec::new();
    let mut hot_map = map.clone();
    // Every key but the always-hot ones and `sections` leaves the hot part and gains a line.
    let mut cold_keys: Vec<String> = Vec::new();
    for (k, v) in &map {
        let name = match k {
            Dat::Str(s) => s.clone(),
            _           => continue,
        };
        if CRYSTAL_ALWAYS_HOT.contains(&name.as_str()) || name == "sections" {
            continue;
        }
        outline.push(CrystalOutlineRow {
            key:     name.clone(),
            heading: String::new(),
            bytes:   crystal_bytes(v),
            hot:     false,
        });
        cold_keys.push(name);
    }
    for name in &cold_keys {
        hot_map.remove(&Dat::Str(name.clone()));
    }
    // And the sections, which are the half a daimon chooses between.
    if let Some(Dat::List(secs)) = map.get(&Dat::Str(fmt!("sections"))) {
        let mut kept: Vec<Dat> = Vec::new();
        for sec in secs {
            let hot = crystal_hot_flag(sec);
            outline.push(CrystalOutlineRow {
                key:     fmt!("sections"),
                heading: crystal_heading(sec),
                bytes:   crystal_bytes(sec),
                hot,
            });
            if hot {
                kept.push(sec.clone());
            }
        }
        if kept.is_empty() {
            hot_map.remove(&Dat::Str(fmt!("sections")));
        } else {
            hot_map.insert(Dat::Str(fmt!("sections")), Dat::List(kept));
        }
    }
    let hot = match Dat::Map(hot_map).json() {
        Ok(t)  => t,
        // Decoded and would not re-encode. Nothing can be said about the split, so the crystal
        // rides whole rather than the daimon losing it.
        Err(_) => return Ok(whole_split(total)),
    };
    Ok(CrystalSplit {
        hot_bytes:   hot.len(),
        hot,
        whole:       false,
        outline,
        total_bytes: total,
        fault,
        excerpt:     false,
    })
}

/// A crystal too big to ride whole and too broken to split, cut to at most `cap` bytes: its start,
/// then a window round byte `at`, the place of the fault, with each gap marked by its size.
///
/// The start is what says which Diamond this is, and the window is what the daimon has to mend;
/// what lies between is reachable with `file_read`.  Without a place (a text the scanner passes
/// and the decoder still refuses) it is the start alone.
///
/// # Arguments
/// * `json` - The crystal exactly as it sits on disk.
/// * `at` - The byte offset of the fault, where there is one.
/// * `cap` - The most the excerpt may weigh, markers included.
pub(super) fn crystal_excerpt(json: &str, at: Option<usize>, cap: usize) -> String {
    // What one gap marker can weigh: the words, two ellipses and a twenty-digit count.
    const MARK: usize = 64;
    let floor = |mut i: usize| {
        i = i.min(json.len());
        while !json.is_char_boundary(i) {
            i -= 1;
        }
        i
    };
    let gap = |n: usize| fmt!("\n…[{} bytes not shown]…\n", n);
    let total = json.len();
    let budget = cap.saturating_sub(2 * MARK);
    let at = match at {
        Some(a) if cap >= 2 * MARK && budget > 0 => a.min(total),
        // The start alone, its marker included in the cap; under a cap too small for even the
        // marker, the start bare.
        _ => {
            let mark = gap(total).len();
            if mark >= cap {
                return json[..floor(cap)].to_string();
            }
            let end = floor(cap - mark);
            return fmt!("{}{}", &json[..end], gap(total - end));
        },
    };
    let head = floor(budget / 4);
    let window = budget - head;
    // Two thirds of the window before the fault: what led up to it is what explains it.
    let mut start = at.saturating_sub(window * 2 / 3).max(head);
    let end = floor((start + window).min(total));
    if end == total {
        start = total.saturating_sub(window).max(head);
    }
    // Rounded UP to a character, so the window never grows past its share.
    while start < total && !json.is_char_boundary(start) {
        start += 1;
    }
    let start = start.min(end);
    let mut out = String::new();
    if start <= head {
        out.push_str(&json[..end]);
    } else {
        out.push_str(&json[..head]);
        out.push_str(&gap(start - head));
        out.push_str(&json[start..end]);
    }
    if end < total {
        out.push_str(&gap(total - end));
    }
    out
}

/// The crystal's text as the decoder is given it: trimmed, and without a byte order mark.
///
/// Rust's `trim` leaves U+FEFF alone, so the decoder read it as part of the first key and a
/// crystal saved with one lost its `title` from the hot part.  The mark is a fault, named
/// beside the hot part by [`CrystalSplit::fault`]; it is not a reason to hide what follows it.
pub(super) fn crystal_decode_text(json: &str) -> &str {
    json.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// The standing block `compose_daimon` pushes into the system message.
///
/// **THE ORDER IS THE CONTRACT** (`dev/CRYSTAL_CONTRACT.md` §12): the hot crystal, then
/// `REQUIREMENTS.md` whole, then `STATE.md` whole, then the tail of `DECISIONS.md`, then the
/// outline of what is cold.  What this Diamond IS comes before what is to do, what is to do
/// before where things are, and the outline last because it is a menu rather than a fact.
///
/// For a whole crystal the first part is exactly the sentence it has always been, so nothing
/// changes for the Diamonds that were never near the ceiling.  For a split one it is the hot
/// JSON, the outline, and the one sentence that says how to move a section between the two --
/// which is the only place that can be said with the Diamond's own sizes in it.
///
/// # Arguments
/// * `s` - The crystal as [`crystal_split`] left it.
/// * `files` - The three files as the turn found them; [`Standing::default`] where a Diamond has
///   none yet, which says nothing rather than three empty headings.
pub fn crystal_prompt_text(s: &CrystalSplit, files: &Standing) -> String {
    crystal_prompt_for(s, files, true)
}

/// The same block, for a reader that is or is not the crystal's keeper.
///
/// **A WORKER IS NOT THE KEEPER.**  The daimon that dispatched it is told to mend a crystal that
/// does not parse; a worker handed the same "MUST FIX before you end the turn" obeys it from a
/// snapshot taken at dispatch, and writes its repair over whatever the daimon has added since --
/// with no conflict, because the worker never read the file the stale-write guard compares
/// against.  A worker is told the fact and told to leave the file alone.
///
/// # Arguments
/// * `s` - The crystal as [`crystal_split`] left it.
/// * `files` - As for [`crystal_prompt_text`].
/// * `keeper` - Whether the reader is the daimon that owns the crystal and may mend it.
pub fn crystal_prompt_for(s: &CrystalSplit, files: &Standing, keeper: bool) -> String {
    crystal_text(s, files, keeper, true)
}

/// The crystal alone, as a turn's note carries it in its own block (r578): the hot part, its
/// fault and the outline of the rest, without the three standing files, which ride in blocks of
/// their own.  `files` still sets the hot room the outline names.
pub fn crystal_block_for(s: &CrystalSplit, files: &Standing, keeper: bool) -> String {
    crystal_text(s, files, keeper, false)
}

pub(super) fn crystal_text(s: &CrystalSplit, files: &Standing, keeper: bool, with_files: bool) -> String {
    let standing = if with_files { files.prompt_text() } else { String::new() };
    // The fault of the RAW text, whichever shape the prompt takes.  A crystal that rides whole is
    // the turn that has to mend it, and the one place a daimon is sure to look; a split one is
    // told too, because the decoder behind the split is lenient and the hot part it shows is a
    // clean re-encoding that hides the break.  Nothing else tells it: the owner's panel shows the
    // file as raw text and the page draws nothing from it.
    let fault = match &s.fault {
        None                  => String::new(),
        Some(_) if !keeper    => fmt!(
            "\n\nThe crystal.json this was read from is not valid JSON. The daimon that sent you \
            mends it; do not write crystal.json yourself."),
        Some(f) if s.excerpt  => fmt!(
            "\n\nMUST FIX before you end the turn: the crystal.json on disk is not valid JSON \
            -- {}. The owner's panel is showing it as raw text and the page draws nothing \
            from it. What is above is only an excerpt: do not write the crystal again from it, \
            which would drop everything not shown. file_read crystal.json and mend it in place \
            with file_edit, at the place named.", f),
        Some(f) if s.whole    => fmt!(
            "\n\nMUST FIX before you end the turn: the crystal.json above is not valid JSON \
            -- {}. The owner's panel is showing it as raw text and the page draws nothing \
            from it. Write the whole crystal again as one JSON object.", f),
        Some(f)               => fmt!(
            "\n\nMUST FIX before you end the turn: the crystal.json on disk is not valid JSON \
            -- {}. The owner's panel is showing it as raw text and the page draws nothing \
            from it. What is above is only the hot part, re-encoded and so valid-looking: do not \
            write the crystal again from it, which would drop the cold sections. file_read \
            crystal.json and mend it in place with file_edit, at the place named.", f),
    };
    if s.whole {
        return fmt!("\n\nCurrent crystal.json:\n{}{}{}", s.hot, fault, standing);
    }
    if s.excerpt {
        return fmt!(
            "\n\nCurrent crystal.json — an EXCERPT ({} of {} bytes): it does not parse and is \
            too big to ride whole, so this is its start and the part round the fault:\n{}{}{}",
            s.hot_bytes, s.total_bytes, s.hot, fault, standing);
    }
    let mut out = fmt!(
        "\n\nCurrent crystal.json — the HOT part ({} of {} bytes; the rest is reachable, not \
        gone):\n{}{}{}\n\nThe cold part of the crystal, by section (crystal_read fetches one; \
        recall searches all of it and everything this conversation has folded):\n",
        s.hot_bytes, s.total_bytes, s.hot, fault, standing);
    for row in &s.outline {
        if row.heading.is_empty() {
            out.push_str(&fmt!("- {} — {} bytes\n", row.key, row.bytes));
        } else {
            out.push_str(&fmt!("- \"{}\" — {} bytes{}\n",
                row.heading, row.bytes, if row.hot { " (hot)" } else { "" }));
        }
    }
    let room = crystal_hot_room(files.hot_bytes());
    out.push_str(&fmt!(
        "A section you need in front of you on every round gets \"hot\": true; the hot part may \
        not exceed {} bytes", room));
    if s.hot_bytes > room {
        out.push_str(&fmt!(
            ", and this one is already {} over it — shorten the summary or take the flag off a \
            section", s.hot_bytes - room));
    }
    out.push_str(".\n");
    out
}

/// One section's body, by heading: exact first, then a unique case-folded match.
///
/// `None` where the crystal will not parse, where it has no sections, or where the heading names
/// none or names several -- and the caller says which, because "there is no such section" and
/// "there are two of them" are different news for a model about to try again.
///
/// # Arguments
/// * `json` - The crystal as it sits on disk.
/// * `heading` - The heading as the model wrote it.
pub fn crystal_section(json: &str, heading: &str) -> Outcome<Option<String>> {
    let cfg = crate::agent::compact::json_cfg();
    let map = match Dat::decode_string_with_config(crystal_decode_text(json), &cfg) {
        Ok(Dat::Map(m)) => m,
        _               => return Ok(None),
    };
    let secs = match map.get(&Dat::Str(fmt!("sections"))) {
        Some(Dat::List(v)) => v.clone(),
        _                  => return Ok(None),
    };
    let want = heading.trim();
    let body_of = |sec: &Dat| -> String {
        match sec {
            Dat::Map(m) => match m.get(&Dat::Str(fmt!("body"))) {
                Some(Dat::Str(b)) => b.clone(),
                Some(other)       => other.json().unwrap_or_default(),
                None              => String::new(),
            },
            _ => String::new(),
        }
    };
    for sec in &secs {
        if crystal_heading(sec).trim() == want {
            return Ok(Some(body_of(sec)));
        }
    }
    let folded = want.to_lowercase();
    let mut hit: Option<String> = None;
    for sec in &secs {
        if crystal_heading(sec).trim().to_lowercase() == folded {
            if hit.is_some() {
                return Ok(None);	// two headings, so the model must say which
            }
            hit = Some(body_of(sec));
        }
    }
    Ok(hit)
}

/// One top-level key of a crystal, as pretty JSON.
///
/// Any key, not merely a core one: the keys worth reaching for by name are often exactly the ones
/// this build has never heard of, because a model or a page put them there.
///
/// # Arguments
/// * `json` - The crystal as it sits on disk.
/// * `key` - The top-level key wanted.
pub fn crystal_key(json: &str, key: &str) -> Outcome<Option<String>> {
    let cfg = crate::agent::compact::json_cfg();
    let map = match Dat::decode_string_with_config(crystal_decode_text(json), &cfg) {
        Ok(Dat::Map(m)) => m,
        _               => return Ok(None),
    };
    match map.get(&Dat::Str(key.trim().to_string())) {
        Some(v) => Ok(Some(res!(v.json_to_lines("  ")))),
        None    => Ok(None),
    }
}

/// The compiled half of a `recall` query, for the caller that searches the FOLDS.
///
/// The fold half of `recall` is answered by the agent, which has the session; the crystal half is
/// answered here.  One answer in two halves has to mean one query, so this is what crosses the
/// seam -- the compiled pattern and the three numbers -- rather than the raw arguments, which
/// would be compiled twice and could then disagree.
pub struct RecallQuery {
	re:         Regex,
	pub before: usize,
	pub after:  usize,
	pub limit:  usize,
}

impl RecallQuery {
	/// Does this line match?
	///
	/// A line the matcher could not decide answers no, which is `scan_file`'s own rule: what it
	/// costs is one line left out of an answer, and the alternative is one pathological line
	/// taking the whole search down with it.
	pub fn matches(&self, line: &str) -> bool {
		self.re.is_match(line).unwrap_or(false)
	}
}

/// Compile a `recall` call's arguments, [`search_opts`]'s own way.
///
/// # Arguments
/// * `args` - The raw tool arguments.
pub fn recall_query(args: &str) -> Outcome<RecallQuery> {
	let opts = res!(search_opts(args));
	Ok(RecallQuery { re: opts.re, before: opts.before, after: opts.after, limit: opts.limit })
}

/// The activity record's part of `recall` (UNBLOCK-11): every device's file merged and searched
/// as one text under [`crate::activity::ACTIVITY_DIR`], with `file_search`'s own matcher. The
/// prompt carries only the newest [`crate::activity::PROMPT_CAP`] bytes of it, and says that
/// `recall` reaches the rest; this is that reach.
///
/// # Arguments
/// * `files` - The text of every activity file of the Diamond.
/// * `now` - The time, ms since the epoch, by which the record is shed.
/// * `opts` - The compiled query.
/// * `stats` - Running totals, carried on from the crystal half.
/// * `out` - The lines found so far, appended to.
///
/// # Returns
/// Whether the search may go on (`false` once the limit is reached).
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn recall_activity(
    files: &[String],
    now:   i64,
    opts:  &SearchOpts,
    stats: &mut SearchStats,
    out:   &mut Vec<String>,
)
    -> Outcome<bool>
{
    let text = crate::activity::recall_text(&crate::activity::merge(files, now));
    if text.is_empty() {
        return Ok(true);
    }
    stats.files += 1;
    let lines = all_numbered(&text);
    scan_file(opts, crate::activity::ACTIVITY_DIR, &lines, stats, out)
}

/// The daimon chat's transcript hits, as the page's `DaimondTranscript.search` answered them
/// (a JSON array of `{mid, ts, role, excerpt}`), each as one `transcript:<role>:<ts>: <excerpt>`
/// line, up to the query's limit. The page did the matching, with the same arguments.
///
/// # Arguments
/// * `json` - The page's answer.
/// * `limit` - The most lines `out` may hold.
/// * `out` - The lines found so far, appended to.
pub(super) fn recall_transcript_lines(json: &str, limit: usize, out: &mut Vec<String>) {
    let cfg = crate::agent::compact::json_cfg();
    let items = match Dat::decode_string_with_config(json.to_string(), &cfg) {
        Ok(Dat::List(items)) => items,
        _                    => return,
    };
    for item in items {
        if out.len() >= limit {
            return;
        }
        let one = match item.json() {
            Ok(j)  => j,
            Err(_) => continue,
        };
        let excerpt = extract_json_string(&one, "excerpt").unwrap_or_default();
        if excerpt.trim().is_empty() {
            continue;
        }
        let role = extract_json_string(&one, "role").unwrap_or_else(|| fmt!("message"));
        let ts = extract_json_number(&one, "ts").unwrap_or(0);
        let flat: String = excerpt.split_whitespace().collect::<Vec<_>>().join(" ");
        out.push(fmt!("transcript:{}:{}: {}", role, ts, flat));
    }
}

/// Every line of a crystal that `opts` matches, in `file_search`'s own report form.
///
/// **The SAME matcher, and that is the whole of why it is here rather than written fresh.**  A
/// `recall` that compiled its own regex would eventually disagree with `file_search` about what a
/// pattern means -- about case, about `fixed`, about a backtracking line -- and the one thing a
/// model cannot recover from is two search tools that answer differently about the same text.
/// So the pattern arrives compiled by [`search_opts`] and the matching is [`scan_file`]'s.
///
/// What is searched is the crystal as PROSE: each section's body under its heading, and each
/// value of every other key.  Not the JSON text, because a match on `"heading":` is a match on
/// punctuation, and the line numbers of a pretty-printed object mean nothing to anybody.
///
/// # Arguments
/// * `json` - The crystal as it sits on disk.
/// * `opts` - The compiled query, from [`search_opts`].
/// * `stats` - Running totals, so the notes can say what was and was not reached.
pub(super) fn recall_crystal(json: &str, opts: &SearchOpts, stats: &mut SearchStats)
    -> Outcome<Vec<String>>
{
    let mut out: Vec<String> = Vec::new();
    let cfg = crate::agent::compact::json_cfg();
    let map = match Dat::decode_string_with_config(crystal_decode_text(json), &cfg) {
        Ok(Dat::Map(m)) => m,
        // A crystal that will not parse is still text worth searching, and the daimon that has
        // to mend it is the one most likely to be searching it.
        _ => {
            stats.files += 1;
            let lines = all_numbered(json);
            res!(scan_file(opts, "crystal", &lines, stats, &mut out));
            return Ok(out);
        },
    };
    // Sections first, because a heading is what a model will quote back.
    if let Some(Dat::List(secs)) = map.get(&Dat::Str(fmt!("sections"))) {
        for sec in secs {
            let head = crystal_heading(sec);
            let body = match sec {
                Dat::Map(m) => match m.get(&Dat::Str(fmt!("body"))) {
                    Some(Dat::Str(b)) => b.clone(),
                    Some(other)       => other.json().unwrap_or_default(),
                    None              => String::new(),
                },
                _ => String::new(),
            };
            stats.files += 1;
            let lines = all_numbered(&body);
            let disp  = fmt!("crystal:{}", if head.is_empty() { "(no heading)" } else { &head });
            if !res!(scan_file(opts, &disp, &lines, stats, &mut out)) {
                return Ok(out);
            }
        }
    }
    for (k, v) in &map {
        let name = match k {
            Dat::Str(n) => n.clone(),
            _           => continue,
        };
        if name == "sections" {
            continue;
        }
        let text = match v {
            Dat::Str(t) => t.clone(),
            other       => other.json_to_lines("  ").unwrap_or_default(),
        };
        stats.files += 1;
        let lines = all_numbered(&text);
        if !res!(scan_file(opts, &fmt!("crystal:{}", name), &lines, stats, &mut out)) {
            return Ok(out);
        }
    }
    Ok(out)
}

// ┌───────────────────────────────────────────────────────────────┐
// │ A crystal that was markdown                                    │
// └───────────────────────────────────────────────────────────────┘

/// One `## ` heading of a crystal and the text under it.
#[derive(Debug, Clone, PartialEq)]
pub struct CrystalSection {
    /// The heading text, verbatim, without its `## ` marker.  Empty for the one section a
    /// document with no headings at all becomes.
    pub heading: String,
    /// Everything under the heading, verbatim, its own trailing newline included.
    pub body:    String,
}

/// A crystal's core shape: what `crystal.json` holds after a markdown crystal is converted.
///
/// The three keys the migration can produce, in the order the schema lists them.  A crystal may
/// carry more -- `facts`, `open`, `links`, and anything a model adds -- and nothing here invents
/// them, because a migration that guessed at structure it was never given would be reshaping the
/// user's words rather than moving them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CrystalData {
    /// The document's opening `# ` heading; empty when it had none.
    pub title:    String,
    /// The text between the title and the first `## `, verbatim.
    pub summary:  String,
    /// Each `## ` and its text, in document order.
    pub sections: Vec<CrystalSection>,
}

impl CrystalData {

    /// Render back to markdown -- the exact inverse of [`crystal_from_markdown`]'s split.
    ///
    /// THIS IS THE HALF THAT MAKES THE MIGRATION PROVABLE.  It is not a pretty-printer and must
    /// never become one: every byte it emits is either a marker the split consumed or text the
    /// split kept verbatim, so `crystal_from_markdown(md).to_markdown() == md` for every input.
    /// A renderer that tidied whitespace, or added a blank line between sections, would make that
    /// false and the migration would start rewriting people's crystals.
    pub fn to_markdown(&self) -> String {
        let mut out = String::new();
        if !self.title.is_empty() {
            out.push_str("# ");
            out.push_str(&self.title);
            out.push('\n');
        }
        out.push_str(&self.summary);
        for s in &self.sections {
            // An empty heading is the no-headings case, which owns the whole document and has no
            // marker of its own to put back.
            if !s.heading.is_empty() {
                out.push_str("## ");
                out.push_str(&s.heading);
                out.push('\n');
            }
            out.push_str(&s.body);
        }
        out
    }

    /// Serialise as the `crystal.json` a migration writes.
    ///
    /// A key with nothing in it is left out rather than written empty, so a Diamond that had only
    /// prose does not arrive carrying an empty title it never had.  Everything the schema does not
    /// name is absent for the same reason.
    ///
    /// Laid out one key to a line, because a person reads this in the raw-JSON editor and a model
    /// edits it with `file_edit`; both do better with something they can point at.
    pub fn to_json(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if !self.title.is_empty() {
            parts.push(fmt!("  \"title\": \"{}\"", json_escape(&self.title)));
        }
        if !self.summary.is_empty() {
            parts.push(fmt!("  \"summary\": \"{}\"", json_escape(&self.summary)));
        }
        if !self.sections.is_empty() {
            let items: Vec<String> = self.sections.iter().map(|s| fmt!(
                "    {{ \"heading\": \"{}\", \"body\": \"{}\" }}",
                json_escape(&s.heading), json_escape(&s.body),
            )).collect();
            parts.push(fmt!("  \"sections\": [\n{}\n  ]", items.join(",\n")));
        }
        if parts.is_empty() {
            return fmt!("{{}}");
        }
        fmt!("{{\n{}\n}}", parts.join(",\n"))
    }
}

/// Whether a line opens or closes a fenced code block.
///
/// Toggling on this is what stops a `## ` inside a fence being read as a heading.  The
/// round-trip would survive that mistake -- the pieces rejoin to the same bytes either way -- so
/// nothing about losslessness catches it; what it produces is a section whose body opens with a
/// dangling fence, which every renderer downstream then gets wrong.
///
/// # Arguments
/// * `line` - One line, without its terminator.
pub(super) fn is_code_fence(line: &str) -> bool {
    let t = line.trim();
    t.starts_with("```") || t.starts_with("~~~")
}

/// Split a markdown crystal into the core shape, per the schema's stated rules.
///
/// Offsets throughout, never `lines()`: every byte between two markers is carried verbatim, which
/// is what lets [`CrystalData::to_markdown`] put the document back together exactly.
pub(super) fn split_markdown(md: &str) -> CrystalData {
    let mut title       = String::new();
    let mut summary_at  = 0usize;                       // where the summary starts
    let mut heads: Vec<(usize, usize, usize)> = Vec::new(); // (line start, text start, line end)
    let mut fenced      = false;
    let mut at          = 0usize;
    while at < md.len() {
        let rest = &md[at..];
        let len  = rest.find('\n').map(|i| i + 1).unwrap_or(rest.len());
        let line = &md[at..at + len];
        let bare = line.strip_suffix('\n').unwrap_or(line);
        if is_code_fence(bare) {
            fenced = !fenced;
        } else if !fenced {
            // The title is the FIRST line or nothing.  A `# ` further down is somebody's
            // sub-heading, and hoisting it would move text the user put after it to before it.
            if at == 0 {
                if let Some(text) = bare.strip_prefix("# ") {
                    if !text.trim().is_empty() {
                        title      = text.to_string();
                        summary_at = at + len;
                    }
                }
            }
            // A bare `## ` with nothing after it is not a heading, because a section with an
            // empty heading is how the no-headings case is spelled and the renderer drops the
            // marker for it.  Left in the body, it survives.
            if let Some(text) = bare.strip_prefix("## ") {
                if !text.trim().is_empty() {
                    heads.push((at, at + 3, at + len));
                }
            }
        }
        at += len;
    }

    let summary_to = heads.first().map(|h| h.0).unwrap_or(md.len());
    let summary    = md[summary_at..summary_to].to_string();
    let mut sections: Vec<CrystalSection> = Vec::new();
    for (i, (_, text_at, line_end)) in heads.iter().enumerate() {
        let body_to = heads.get(i + 1).map(|h| h.0).unwrap_or(md.len());
        let raw     = &md[*text_at..*line_end];
        sections.push(CrystalSection {
            heading: raw.strip_suffix('\n').unwrap_or(raw).to_string(),
            body:    md[*line_end..body_to].to_string(),
        });
    }
    // No headings at all becomes one section with an empty heading, per the schema.  Not a bare
    // summary: a summary is what a title is followed BY, and there is no title here.
    if title.is_empty() && sections.is_empty() {
        return CrystalData {
            title:    String::new(),
            summary:  String::new(),
            sections: vec![CrystalSection { heading: String::new(), body: summary }],
        };
    }
    CrystalData { title, summary, sections }
}

/// Convert a markdown crystal into the core shape, LOSSLESSLY.
///
/// The rules are the schema's: the first `# ` heading becomes the title, the text up to the first
/// `## ` becomes the summary, and each `## ` and its text becomes a section.
///
/// **The property is losslessness, and it is enforced here rather than asserted about here.**  The
/// split is rendered straight back and compared with what came in, and anything that does not
/// match byte for byte goes into one section verbatim instead.  So a shape nobody anticipated --
/// a file that ends on a heading with no newline, a document whose `# ` is on the fourth line,
/// something not yet imagined -- costs the user their structure and never one byte of their words.
/// The alternative was to enumerate the awkward shapes and handle them, which is the same
/// arrangement with a list that is one shape short.
///
/// Lives in `tools.rs` rather than beside the store it serves because `mod wasm` is
/// `#[cfg(target_arch = "wasm32")]`, so the round-trip test would never have run on the host --
/// a proof that cannot fail is not a proof.
///
/// # Arguments
/// * `md` - The crystal as markdown, exactly as it sits on disk.
pub fn crystal_from_markdown(md: &str) -> CrystalData {
    // Nothing stays nothing.  A new Diamond's crystal is an empty file, and it should arrive as an
    // empty object rather than as a section holding no text.
    if md.is_empty() {
        return CrystalData::default();
    }
    let split = split_markdown(md);
    if split.to_markdown() == md {
        return split;
    }
    CrystalData {
        title:    String::new(),
        summary:  String::new(),
        sections: vec![CrystalSection { heading: String::new(), body: md.to_string() }],
    }
}

/// Daimond's own directory in the workspace: the skills, the config -- the rules about what a
/// skill may do.  A turn running under a skill's declaration is fenced out of it.
pub const DAIMOND_DIR: &str = ".daimond/";

// The skills index
pub const SKILLS_DIR: &str	= ".daimond/skills/";	// where installed skills live
pub const CRYSTAL_STARTER_PATH: &str = ".daimond/starters/crystal.html"; // the page a daimon forks (K4)
pub const SKILL_MANIFEST: &str	= "SKILL.md";		// the one file that declares one

/// One hole in a read deny, as [`ToolContext::read_grants`] lists them.  Each holds an
/// already-normalised path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum ReadGrant {
    /// A [`Bound::MayRead`] carve-out: everything at or beneath the path.
    Under(String),
    /// The skills disclosure, [`is_skills_disclosure`]: a shape, not one path.
    Skills,
    /// One file and nothing beside it.
    Exact(String),
}

/// Is this one of the few paths inside Daimond's own directory that a fenced turn may still read?
///
/// **Three shapes and no more**: the skills directory itself, so a listing can name what is
/// installed, and each skill's declaration in either form, `.daimond/skills/<name>/SKILL.md` or
/// the flat `.daimond/skills/<name>.md` the installer writes.  Not a README, not a second file in
/// a skill's folder, not the config beside them, and no write anywhere -- only
/// [`ToolContext::may_read`] consults this.
///
/// It is spelled as an exact shape rather than as a [`Bound::MayRead`] prefix on purpose.  A prefix
/// on the skills directory is the obvious way to write the grant and it opens every file every
/// skill ships, which is most of what the fence around [`DAIMOND_DIR`] exists to keep shut.  So the
/// hole is cut to the two paths that answer the question, and a path one segment deeper is refused.
///
/// The reason it exists at all, from a transcript.  A daimon asked to list its skills was refused,
/// fell back to two stale paths out of its standing instructions -- one of which did not exist in
/// that workspace -- and then stated a conclusion about the directory it had been refused: that a
/// named skill "has not been copied into the skills directory, so it is not reachable".  It could
/// not know that.  It had never seen the directory.  A fence that leaves an agent answering from a
/// substitute for the evidence has moved the failure rather than prevented it.
///
/// Only `.daimond` is at issue.  A skill tree the user keeps elsewhere -- `notes/skills`, say -- is
/// an ordinary part of the workspace and was always readable.
pub(crate) fn is_skills_disclosure(path: &str) -> bool {
    let p   = normalise(path);
    let idx = normalise(SKILLS_DIR);
    if p == idx {
        return true; // the index itself, which is what "what skills have I got?" asks for
    }
    let rest = match p.strip_prefix(&fmt!("{}/", idx)) {
        Some(r) => r,
        None    => return false,
    };
    // Exactly `<name>/SKILL.md`: one segment for the skill, then its declaration; or the flat
    // `<name>.md` the installer writes (`skills::install_path`), for a name it would write --
    // never the folder's README (lead ruling on the WALK check, D1).  `normalise` has already
    // resolved `..`, so `<name>/../../config.jdat` arrived here spelled as `.daimond/
    // config.jdat` and never reached the prefix test above.
    match rest.split_once('/') {
        Some((_, file)) => file == SKILL_MANIFEST,
        None            => crate::skills::is_flat_declaration(rest),
    }
}

/// One prefix rule bounding what a turn may touch, checked at the single dispatch door in
/// [`Tool::execute`].
///
/// Two shapes of rule, because there are two shapes of problem.
///
/// A skill's bound is a DENY-LIST with one carve-out: a bounded turn is fenced out of Daimond's own
/// directory, and let back in to exactly one place -- the skill's own folder, whose shipped
/// references are part of the skill.  The carve-out grants reading and never writing, so a skill
/// can quote its own reference document and still cannot rewrite its own `uses` line.
///
/// A Diamond's bound is an ALLOW-LIST: its daimon may reach the files in that Diamond's workspace
/// and nothing else at all.  That is a different guarantee and needs the opposite default -- a
/// deny-list is only as complete as the list of things someone remembered to deny, and the thing
/// this has to survive is a turn that has read a stranger's words and been told to go looking.
///
/// The two compose, and the allow-list wins.  A turn can be both scoped to a Diamond and running
/// under a skill, and then it may touch what BOTH permit: inside the Diamond's workspace, and not
/// inside Daimond's own directory.  [`compose`] is where that happens and it is the only correct
/// way to put a second bound on a turn -- assigning one over another deletes the other in silence,
/// which is what `hand/REVIEW.md` §1.12 was.
///
/// [`Bound::Toolkit`] is a third thing again -- a grant of a toolchain ON THE MACHINE, which no
/// file tool can address -- and it is here because it is one more thing the user decided about this
/// turn, not because it is a prefix rule.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum Bound {
    /// Nothing under this workspace-relative prefix may be written, moved onto, or deleted.
    NoWrite(String),
    /// Nothing under this workspace-relative prefix may be read.
    NoRead(String),
    /// ...except here.  A prefix a bounded turn may always read, whatever a [`Bound::NoRead`]
    /// says: the skill's own directory.  Reading only -- this grants no write.
    ///
    /// It does not escape an [`Bound::OnlyUnder`]: a carve-out in a deny-list is a hole punched in
    /// a fence, and the allow-list is a different fence entirely.
    MayRead(String),
    /// Nothing OUTSIDE these prefixes may be read or written.
    ///
    /// The presence of a single rule of this kind turns the bound into an allow-list for BOTH
    /// verbs.  A path that is under none of them is refused whatever else the bound says.
    ///
    /// **Nothing in this build produces one**, and the reason is the rule below it: a scope fences
    /// writing and running, never reading, so the only thing that fences a read is a deny --
    /// [`Bound::NoRead`] on Daimond's own directory.  See [`Bound::OnlyWriteUnder`], which is what
    /// [`diamond_bounds`] emits for every place the user marked in.
    ///
    /// It is kept rather than deleted because both doors, [`compose`] and [`fence_spec`] enforce it
    /// exactly as they always did, and it is the shape a surface that genuinely wants a read fence
    /// would ask for -- a Diamond the user marks *"may not look outside"*, say, or a skill run on a
    /// borrowed workspace.  Deleting it would leave that surface to reinvent the intersection rules
    /// in [`compose`], which are the part of this file it would be worst to write twice.
    OnlyUnder(String),
    /// Nothing OUTSIDE these prefixes may be WRITTEN, and reading is not restricted at all.
    ///
    /// **This is what a scope IS, on every surface: a chat, a chat's worker and a Diamond's daimon
    /// alike.**  [`diamond_bounds`] emits one per place the user marked in, and [`chat_bounds`] is
    /// that same function.  The VERB decides the reach, and not the surface:
    ///
    /// * **Reading is free**, within what the user has already opened -- and no further.  The outer
    ///   edge is the root the file tools resolve against, which is the folder the user opened or
    ///   their own OPFS namespace, and it is enforced where a path becomes components rather than
    ///   here: `crate::wasm::opfs::split_components` refuses an absolute path and a `..` that would
    ///   climb out, [`crate::workspace::Workspace::resolve`] does the same on native, and neither
    ///   consults a [`Bound`] at all.  So *"summarise these ten files"* does not require attaching
    ///   ten files first, and a worker reading what the conversation could already read is equal
    ///   reach rather than greater -- a person asked the question either way.
    /// * **Writing goes where the user marked.**  That is the verb that alters a disk, and the mark
    ///   is the whole of the permission: inside it nothing interrupts anybody.
    /// * **A command counts as a write.**  There is no way to look at an `argv` and say whether it
    ///   will alter anything -- that is the whole reason the fence exists rather than a list of safe
    ///   programs -- so a command runs where writing is allowed and nowhere else.  A turn whose
    ///   write allow-list names no place ON THE MACHINE gets no fence and runs nothing.
    /// * **An unattended worker reads freely too**, which is the answer a reviewer will stop at, so
    ///   it is written down: an `unsupervised` agent is not fenced out of reading.  It reaches
    ///   exactly what the conversation that dispatched it reaches, which is the point of dispatching
    ///   one, and it is [`ToolContext::net_risk`] that answers the fear underneath the question --
    ///   an unattended actor loses the network on a clean turn as well as a dirty one, so a worker
    ///   that reads widely cannot also post what it read.
    ///
    /// **[`fence_spec`] reads this rule exactly as it reads [`Bound::OnlyUnder`]: the verb is NOT
    /// split at the machine, and a command's fence is unchanged by any of the above.**  The rule is
    /// not *"reading is free"* flat; it is **reading is free where Daimond can see what is read**.
    /// A file tool names one path and hands back its text, with the taint, the egress check and the
    /// untrusted envelope all still around it.  A command is opaque, and a command that could read
    /// the whole grant while writing into its own folder is an exfiltration path with two legs:
    /// read anything, copy it into the marked folder, and the daimon reads the marked folder and
    /// has the network.  So the mark is the whole of a command's reach.  See [`fence_spec`], where
    /// the same argument sits beside the code, and `dev/verify_scope.mjs`, where the kernel proves
    /// it.
    ///
    /// The history, because the argument has now been had twice and both halves of it are right.
    /// This was the chat's rule until 2026-08-12, when [`chat_bounds`] was made to delegate to
    /// [`diamond_bounds`] and this variant silently lost its only producer: nobody decided to fence
    /// a chat's reading, it fell out of a delegation, and `dev/verify_chatfence.mjs` failed against
    /// its own stated thesis for a day.  What the delegation got RIGHT, and what survives, is that
    /// the chat ITSELF is fenced and not merely the workers it dispatches -- on 2026-08-11 a daimon
    /// in an ordinary chat edited two files of the user's own book to work around a compiler
    /// limitation, in a directory under no version control, and no worker was involved.  So the
    /// surface distinction is gone and the verb distinction is back: one rule, both surfaces, both
    /// doors.
    ///
    /// **What Landlock leaves visible.**  A command's fence stops it opening, listing, writing,
    /// creating or removing anything outside the mark, but Landlock does not govern path metadata:
    /// `stat`, `access` and `readlink` on a path beyond the mark still answer, so a command can
    /// learn that a name exists and its size and times, though never its contents or a directory's
    /// entries.
    OnlyWriteUnder(String),
    /// A toolchain the user granted this Diamond (see [`Toolkit`]).
    ///
    /// The odd one out, and deliberately so.  Every other rule here is a workspace-relative prefix
    /// the file tools test a path against; this one names paths ON THE MACHINE, which no file tool
    /// can address -- `file_read` is jailed to the workspace and a compiler is not in it.  So
    /// [`ToolContext::may_read`] and [`ToolContext::may_write`] ignore it, and it reaches only
    /// [`fence_spec`], where a command's fence is built.
    ///
    /// It rides here rather than in a field of [`ToolContext`] because it is the same kind of thing
    /// as its neighbours -- something the user decided about this turn -- and because a rule the
    /// caller must remember to copy into a second place is a rule that gets dropped.
    Toolkit(Toolkit),
    /// Nothing at all: no path may be read or written, and no command may run.
    ///
    /// The answer to a scope that was asked for and could not be expressed -- a Diamond whose
    /// directory arrived as the empty string, an attachment list of nothing but `.` and `..`.  Every
    /// other rule here is a prefix, and the empty prefix is the one value that inverts them:
    /// [`under`] reads it as every path there is, and [`fence_spec`] resolves it to the granted root
    /// itself.  So a scope with no places left in it does not become an allow-list that allows
    /// everything; it becomes this, and the turn fails closed and loudly.
    ///
    /// Never composed with anything: its presence anywhere in a bound list decides the whole list.
    Nowhere,
    // No path through a secret-named entry may be read or written, at any depth, whether or not
    // it existed when the bounds were drawn (see [`secret_path`]).  A deny, composed as one.
    // Kimberlite's whole-home bounds carry it; the command fence gets the names from a walk.
    NoSecretNames,
}

/// The bounds a turn running under a skill's declaration runs with.
///
/// Fenced out of Daimond's own directory both ways, and let back in to read the skills' own shipped
/// files.  Both halves are needed and neither is enough: without the write fence a skill could
/// rewrite its own declaration and escape on the next invocation; without the read fence it could
/// read *another* skill's directory, which is none of its business; and without the carve-out a
/// skill could not read the reference document it shipped, which makes shipping it pointless.
///
/// # Arguments
/// * `skill_dirs` - The workspace-relative directories of the skills this turn runs under.
pub fn skill_bounds(skill_dirs: &[String]) -> Vec<Bound> {
    let mut out = vec![
        Bound::NoWrite(DAIMOND_DIR.to_string()),
        Bound::NoRead(DAIMOND_DIR.to_string()),
        // The skills index BY NAME, which the deny above already covers.  It is stated a second
        // time because the disclosure in [`is_skills_disclosure`] opens the deny above it and this
        // one is what stops it here: a turn running under someone's declaration sees the skill it
        // is running and no other, which is the sentence three paragraphs up.  A daimon reaches
        // the index because its scope denies Daimond's directory and nothing narrower.
        Bound::NoRead(SKILLS_DIR.to_string()),
    ];
    for dir in skill_dirs {
        // A carve-out is a hole punched at ONE named folder.  A directory that normalises away is
        // the empty string, and a hole of that size is the whole fence: `under(p, "")` is true, so
        // every other skill's declaration -- and the config that says what a skill may do -- would
        // read as carved out.  A skill that named nothing is granted nothing.
        let p = normalise(dir);
        if p.is_empty() {
            continue;
        }
        out.push(Bound::MayRead(p));
    }
    out
}

/// The bounds a chat runs with -- its own turn and every worker it dispatches: **writing and
/// running confined to the chat's workspace, reading free**.
///
/// **The same shape as [`diamond_bounds`], because a chat has a workspace the way a Diamond has
/// one.**  It delegates rather than restating, so the two cannot drift: a chat fenced by a second
/// copy of this reasoning would be fenced by whichever copy someone last remembered to edit, and
/// the only difference between the surfaces is what fills the arguments.
///
/// The delegation is also where the reading went, once.  A chat used to be unfenced and its WORKERS
/// fenced on the write verb alone; on 2026-08-12 this function was made to delegate, and since
/// [`diamond_bounds`] fenced both verbs the whole surface silently lost free reading -- a decision
/// nobody made.  Both halves are now true at once: the conversation is fenced as its workers are
/// (2026-08-11, when a chat's own turn edited two files of the user's book uninvited), and the
/// fence is on the verb (see [`Bound::OnlyWriteUnder`]).  The remedy the user asked for is a
/// WORKING DIRECTORY and not a permission dialog: mark a folder into the workspace, and inside it
/// nothing interrupts you.  The mark IS the permission, and this is where that sentence is
/// enforced.
///
/// **What the workspace is NOT is everything the paperclip attached.**  An attachment carries two
/// independent things and only one of them reaches here.  Note and Read are a COST decision about
/// what goes into the prompt -- Note names a path so the user need not type it, Read pulls the
/// contents in -- they are mutually exclusive, they are both reading, and neither grants any reach.
/// The workspace mark is separate and orthogonal: a path can be in the workspace *and* Read.  A
/// caller that passed its whole attachment list here would have made Note into a grant of WRITING
/// and RUNNING, which is what `dev/ATTACH_CONTRACT.md` §6 has always said it must not be -- and is
/// the whole of what the mark grants now that reading was never the paperclip's to give.
///
/// `scratch` is the chat's own working folder under [`CHAT_ROOT`] -- always in the workspace and
/// always writable, so an agent has somewhere to put what it produces without the user answering a
/// question first, exactly as a Diamond's own directory is.  **By the FILE TOOLS, which is where
/// that promise is kept**: it is browser storage, so it is not a directory a command can run in and
/// it is not in the fence [`fence_spec`] builds.  Granting it there named a path no browser makes
/// on disk, and the hand -- rightly refusing a grant it cannot resolve -- then refused every root
/// beside it, so every `run` in every chat failed.  `workspace` are the paths the user
/// marked into this chat's workspace.  `read_only` are those of them to be consulted rather than
/// edited; there is no control for that on the chat surface yet, and the argument is here so that
/// when one arrives it plugs into the rule [`diamond_bounds`] already enforces instead of inventing
/// a second idea.
///
/// A scope with no places at all is [`Bound::Nowhere`], for the reason [`diamond_bounds`] gives:
/// the empty prefix is not a folder but every folder.
///
/// # Arguments
/// * `scratch` - The chat's own working directory, workspace-relative.
/// * `workspace` - The paths the user marked into this chat's workspace.
/// * `read_only` - Which of them may be read but not written.
pub fn chat_bounds(scratch: &str, workspace: &[String], read_only: &[String]) -> Vec<Bound> {
    diamond_bounds(scratch, workspace, read_only)
}

/// The bounds a Diamond's daimon runs with: **it may write and run in its own workspace and
/// nowhere else, and it may read anywhere the user already opened.**
///
/// The verb decides, and [`Bound::OnlyWriteUnder`] is where that decision is written out in full --
/// including why the fence a COMMAND runs inside does not split the verb, and why an unattended
/// worker reads freely too.  Read it before changing anything here.
///
/// `own_dir` is the Diamond's own directory (`diamonds/<id>`), which is always in scope and always
/// writable -- a daimon that could reach nothing until the user attached something could not even
/// keep its own crystal, and "somewhere to work" must never be a question the user has to answer
/// before starting.
///
/// `attached` are the workspace-relative files and directories the user has put in this Diamond's
/// workspace.  `read_only` are those of them the user attached to be consulted rather than edited;
/// they are expressed as a write allow plus a write fence, because that is exactly what they are and
/// it needs no third kind of rule.  They stay in the write allow-list rather than being dropped from
/// it, and that is load-bearing in one place: [`start_dir`] picks a turn's starting directory out of
/// that list, so a Diamond whose only attachment is read-only still has somewhere on the machine to
/// run -- which `dev/verify_diamondcwd.mjs` asserts.
///
/// An EMPTY result would mean an unbounded turn -- [`ToolContext::may_write`] treats no bounds as no
/// restriction -- so this never returns empty: `own_dir` is always present.
///
/// A path that normalises away is DROPPED rather than kept, and a scope left with no places at all
/// becomes [`Bound::Nowhere`].  This is the whole of the guard, and it is worth saying why it is
/// needed: the empty string is not a folder but every folder.  `under(p, "")` is true for every
/// path, and [`fence_spec`] resolves an empty prefix to the granted root itself, so a Diamond whose
/// directory arrived empty -- an id read before it was known, a caller that passed the wrong
/// variable -- was fenced to the whole grant.  That is the failure this function exists to prevent,
/// arriving through the function itself.
///
/// # Arguments
/// * `own_dir` - The Diamond's own directory, workspace-relative.
/// * `attached` - Paths in this Diamond's workspace.
/// * `read_only` - Which of `attached` may be read but not written.
pub fn diamond_bounds(own_dir: &str, attached: &[String], read_only: &[String]) -> Vec<Bound> {
    let mut out: Vec<Bound> = Vec::new();
    // How many real places the scope names.  Counted rather than inferred from `out.len()`, which
    // the deny rules below would make non-zero whatever the caller passed.
    let mut places = 0usize;
    let own = normalise(own_dir);
    if !own.is_empty() {
        out.push(Bound::OnlyWriteUnder(own.clone()));
        places += 1;
    }
    for path in attached {
        let p = normalise(path);
        if p.is_empty() {
            continue;
        }
        out.push(Bound::OnlyWriteUnder(p));
        places += 1;
    }
    for path in read_only {
        // In the scope, and fenced against writing. A path in `read_only` that is not also in
        // `attached` is still in the scope by this, which is deliberate: the caller should not have
        // to list a thing twice to say "consult this, do not edit it".
        let p = normalise(path);
        if p.is_empty() {
            continue;
        }
        out.push(Bound::OnlyWriteUnder(p.clone()));
        out.push(Bound::NoWrite(p));
        places += 1;
    }
    if places == 0 {
        // A scope was asked for and none could be expressed.  The deny rules alone would leave a
        // turn with no write allow-list, which means NO restriction on writing -- the opposite of
        // what was asked.
        return vec![Bound::Nowhere];
    }
    // Daimond's own directory is out of bounds inside a Diamond too, and this is the ONLY rule here
    // that fences a read: attaching `.daimond` would otherwise hand a daimon the rules about what
    // agents may do, and now that reading is free everywhere else, the deny is the whole of what
    // stops it. It is a deny rather than a hole in an allow-list precisely so that it does not
    // depend on the scope naming anything.
    out.push(Bound::NoWrite(DAIMOND_DIR.to_string()));
    out.push(Bound::NoRead(DAIMOND_DIR.to_string()));
    // THE RECORD IS NOT THE TURN'S TO WRITE -- this Diamond's, or any other's, or any chat's,
    // whatever a mark covers.  That is not a bound in this list: it is [`is_keeper_record`],
    // which `ToolContext::may_write` asks of every bounded turn.
    out
}

/// The folders inside a keeper's home (`diamonds/<id>/`, `chats/<id>/`) that are Daimond's record
/// of it rather than its work: the version store, and the store directory -- the log, the
/// metadata, the retained deltas, the link sidecar, the retired decisions, and whatever is added
/// there next.  Kept by the store, never by a file tool.  `.red` is the store directory's old name.
///
/// **Deny by default, since 2026-09-23.**  This was a list of five files, and the link sidecar
/// was not on it: an audit's daimon appended a `holds` line to its own sidecar naming a folder the
/// user had never granted, and `Files.bounds` handed the folder back as a write mark on the next
/// turn.  A list of names protects what its author remembered; the next record file added would
/// have been writable the day it shipped.  So the whole directory is the record, and a file a
/// turn may write inside it has to be named in [`KEEPER_WRITABLE`].
pub const KEEPER_RECORD: [&str; 3] = ["versions", ".daimond", ".red"];

/// The files inside a keeper's record that a turn may write, each named on purpose.  None: the
/// link tools write the sidecar through a door of their own that stamps what a model asserted and
/// checks the owner by id ([`Tool::link_owner_refusal`]), and the store writes the rest itself.
pub const KEEPER_WRITABLE: [&str; 0] = [];

/// The files at the top of a keeper's home that are its record too, though they sit beside its
/// work: his words log, which a fold files and `recall` reads (CCP3 F1).  A turn that could write
/// it could take his words out of everything the model reaches while the notice says they are kept
/// word for word, so no tool, page or run writes it; the store does.
pub const KEEPER_LOGS: [&str; 1] = [crate::agent::compact::WORDS_FILE];

/// A path as the deny rules compare it: canonical, NFC, lowercase.
///
/// **Only for a rule that REFUSES.**  A disk that folds case or normalises Unicode (macOS, Windows)
/// holds `Code/KEEP.md` and `code/keep.md` as one file, so a deny compared byte for byte leaks
/// there; folded, it refuses both spellings everywhere, which on a disk that tells them apart only
/// refuses a little more.  An allow compared this way would do the opposite -- grant a folder the
/// user never marked -- so the allow-lists never fold.
///
/// The dotless `ı` (U+0131) and the dotted `İ` (U+0130) fold to `i` before the lowercase (U3a
/// QRFIX2): whether a disk's upcase table aliases `.daımond` to `.daimond` is not settled, and
/// refusing it costs only a name nobody writes.  Same rule as every fold here: it only refuses more.
pub fn fold(path: &str) -> String {
    oxedyne_fe2o3_text::unicode::norm::nfc(&normalise(path)).chars()
        .map(|c| if c == '\u{131}' || c == '\u{130}' { 'i' } else { c })
        .collect::<String>()
        .to_lowercase()
}

/// Is `path` part of a keeper's record -- any Diamond's or any chat's (see [`KEEPER_RECORD`])?
///
/// Asked of every bounded turn by [`ToolContext::may_write`], whatever its marks cover: a mark on
/// `diamonds` would otherwise let a turn write another Diamond's version store or its links.  A
/// user's own folder named `versions` is not caught: it is under no keeper's home.
/// Names that, wherever they sit in a tree, are read by what runs as him later: a Claude Code or
/// Daimond session started there reads its instructions, settings, hooks and MCP servers (F3-1,
/// from the runner's FENCE-2b list).
pub const PER_TREE: &[&str] = &["CLAUDE.md", "AGENTS.md", "DAIMOND.md", ".mcp.json", ".claude"];

/// Does `path` reach what runs as him later: is any of its components, folded, a [`PER_TREE`]
/// name or `.git` (whose config and hooks name programs git runs, and whose file in a linked
/// worktree says where they are)?  Judged by name, so it holds whether or not the path exists.
pub fn runs_as_him(path: &str) -> bool {
    let p = fold(&normalise(path));
    p.split('/').any(|c| c == ".git" || PER_TREE.iter().any(|n| fold(n) == c))
}

pub fn is_keeper_record(path: &str) -> bool {
    let p = fold(path);
    for root in [STORE_ROOT, CHAT_ROOT] {
        let rest = match p.strip_prefix(root).and_then(|r| r.strip_prefix('/')) {
            Some(r) => r,
            None    => continue,
        };
        let inner = match rest.split_once('/') {
            Some((id, inner)) if !id.is_empty() => inner,
            _                                   => continue,
        };
        if KEEPER_WRITABLE.iter().any(|w| inner == *w) {
            return false;
        }
        if KEEPER_RECORD.iter().any(|rec| inner == *rec || inner.starts_with(&fmt!("{}/", rec))) {
            return true;
        }
        if KEEPER_LOGS.iter().any(|log| inner == fold(log)) {
            return true;
        }
    }
    false
}

/// The first place in an allow-list that is a directory on the machine, or the empty string when
/// there is none.
///
/// The one answer to *"where does this scope start?"*, shared by everything that has to start
/// somewhere: [`ToolContext::default_cwd`] for a command, and [`crate::wasm::pty::pty_request`] for
/// a terminal.  They asked it separately until 2026-08-13, and the terminal's answer was "wherever
/// the panel said", which is the Diamond's own directory -- so every terminal was refused as
/// starting outside its own fence while the command beside it started in the attached folder and
/// ran.  One function, so the two cannot drift again.
///
/// **A path naming Daimond's own store is skipped.**  A Diamond's own directory and a chat's
/// scratch live in the browser's storage whatever folder is open (see [`is_store_path`]), so
/// `<granted-root>/diamonds/<id>` is a directory the hand cannot canonicalise: starting anything
/// there names a path the user never chose and fails for a reason that points at the wrong thing.
/// A Diamond therefore starts in its first ATTACHED path, and one with no attachment has nowhere
/// on the machine to start at all -- which the callers say in those words rather than sending the
/// hand a directory it will not find.
///
/// # Arguments
/// * `bounds` - The turn's [`Bound`] rules, in the order they were declared.
pub fn start_dir(bounds: &[Bound]) -> String {
    for b in bounds {
        // Both allow-lists, because both name places work could belong in -- a Diamond's
        // attachments and a chat's.
        let p = match b {
            Bound::OnlyUnder(p) | Bound::OnlyWriteUnder(p) => p,
            _ => continue,
        };
        let n = normalise(p);
        if !n.is_empty() && !is_store_path(&n) {
            return n;
        }
    }
    String::new()
}

/// The first attached folder a turn may WRITE, workspace-relative, or empty when it has none.
///
/// The verify tree, chosen apart from [`start_dir`] (QA A F1, 11 Oct 2026).  `run` may start in a
/// folder attached only to consult, because a command there is still fenced read-only; a verifier
/// may not, because its result is reported as THIS Diamond's verification and a consulted folder
/// is another tree's code.  A folder under a [`Bound::NoWrite`] is consulted, however it was
/// listed, and Daimond's own store is skipped for the reason [`start_dir`] gives.
///
/// # Arguments
/// * `bounds` - The turn's [`Bound`] rules, in the order they were declared.
pub fn writable_dir(bounds: &[Bound]) -> String {
    let ro: Vec<String> = bounds.iter()
        .filter_map(|b| match b { Bound::NoWrite(p) => Some(normalise(p)), _ => None })
        .collect();
    for b in bounds {
        let p = match b {
            Bound::OnlyUnder(p) | Bound::OnlyWriteUnder(p) => p,
            _ => continue,
        };
        let n = normalise(p);
        if !n.is_empty() && !is_store_path(&n) && !ro.iter().any(|r| under(&n, r)) {
            return n;
        }
    }
    String::new()
}


// ── outline: what a file HOLDS, in about a kilobyte ──────────────────
//
// A model that does not know a file has two ways in today: read it, which costs a peek and
// tells it only about the head, or search it for a name it does not yet have. Neither answers
// "what is in here", which is the question a coding turn asks first -- and the answer is a
// hundredth of the file's size, so paying the file's size for it is the whole of the waste.
//
// Written as prefix tests on the trimmed line rather than as a regex per line. A regex over
// 47,000 lines is perfectly affordable; the prefix tests are deterministic, and a test that says
// exactly which spellings are recognised is a test somebody can read.

/// Nesting levels shown below the top when a call does not say.
pub(super) const OUTLINE_DEPTH_DEFAULT: usize = 1;

/// The deepest nesting a call may ask for.
pub(super) const OUTLINE_DEPTH_MAX: usize = 6;

/// Rows returned when a call does not say.
pub(super) const OUTLINE_ROWS_DEFAULT: usize = 400;

/// The most rows one call returns.
pub(super) const OUTLINE_ROWS_MAX: usize = 2_000;

/// The heading kinds, by level.
pub(super) const OUTLINE_HEADINGS: [&str; 6] = ["h1", "h2", "h3", "h4", "h5", "h6"];

/// The languages `outline` can read.
#[derive(Clone, Copy, PartialEq)]
pub(super) enum OutlineLang {
    Rust,
    Js,
    Py,
    Md,
    Typ,
}

impl OutlineLang {
    /// The language this path's extension names, or `None` for one no scanner reads.
    pub(super) fn of(path: &str) -> Option<Self> {
        let leaf = path.rsplit('/').next().unwrap_or(path);
        let ext = match leaf.rsplit_once('.') {
            Some((_, e)) => e.to_ascii_lowercase(),
            None         => return None,
        };
        match ext.as_str() {
            "rs"                                            => Some(Self::Rust),
            "js" | "mjs" | "cjs" | "ts" | "tsx" | "jsx"     => Some(Self::Js),
            "py"                                            => Some(Self::Py),
            "md"                                            => Some(Self::Md),
            "typ"                                           => Some(Self::Typ),
            _                                               => None,
        }
    }
}

/// One item an outline found.
pub(super) struct OutlineItem {
    pub(super) start: usize,
    pub(super) end:   usize,
    // The RAW indentation level, made relative to the shallowest item when the rows are
    // rendered: a file wrapped in an IIFE -- which `www/js/daimond.js` is -- has nothing at
    // column zero, and an outline that called all of it depth 1 would show nothing by default.
    pub(super) level: usize,
    pub(super) kind:  &'static str,
    pub(super) name:  String,
}

/// What one `outline` call asked for.
pub(super) struct OutlineOpts {
    pub(super) depth: usize,
    pub(super) name:  Option<Regex>,
    pub(super) skip:  usize,
    pub(super) limit: usize,
}

/// Read the outline arguments, compiling the name filter.
pub(super) fn outline_opts(args: &str) -> Outcome<OutlineOpts> {
    let name = match extract_json_string(args, "name").filter(|n| !n.trim().is_empty()) {
        Some(n) => Some(res!(Regex::with_case(&n, false).map_err(|e| err!(e,
            "outline: 'name' is not a regular expression this build can read. Fix the pattern, \
            or leave it out to see every item."; Invalid, Input)))),
        None    => None,
    };
    Ok(OutlineOpts {
        depth: uint_arg(args, "depth", OUTLINE_DEPTH_DEFAULT, OUTLINE_DEPTH_MAX),
        name,
        skip:  uint_arg(args, "offset", 0, usize::MAX),
        limit: uint_arg(args, "limit", OUTLINE_ROWS_DEFAULT, OUTLINE_ROWS_MAX).max(1),
    })
}

/// How deeply a line is indented, a tab or four spaces to the level.
pub(super) fn indent_level(line: &str) -> usize {
    let mut tabs   = 0usize;
    let mut spaces = 0usize;
    for c in line.chars() {
        match c {
            '\t' => tabs += 1,
            ' '  => spaces += 1,
            _    => break,
        }
    }
    tabs + spaces / 4
}

/// Is this the whole of an identifier and nothing else?
pub(super) fn is_ident(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
        && !s.chars().next().unwrap_or('1').is_ascii_digit()
}

/// The identifier at the head of `s`, empty where there is none.
pub(super) fn head_ident(s: &str) -> String {
    let t = s.trim_start();
    // `static mut X` and `let mut x` both put a modifier where the name goes.
    let t = t.strip_prefix("mut ").unwrap_or(t).trim_start();
    t.chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
        .collect()
}

/// The words that put a brace on a line without declaring anything.
pub(super) const JS_NOT_A_NAME: [&str; 11] = [
    "if", "for", "while", "switch", "catch", "function", "return", "else", "do", "try", "with"];

/// One Rust item, where the line declares one.
pub(super) fn rust_item(t: &str, level: usize) -> Option<(&'static str, String, usize)> {
    if t.starts_with("//") || t.starts_with("#[") || t.starts_with("#!") {
        return None;
    }
    let mut rest = t;
    // The modifiers, stripped until nothing more comes off, so `pub(crate) async unsafe fn`
    // reaches the keyword the same way `fn` does.
    loop {
        let before = rest;
        for p in ["pub ", "async ", "unsafe ", "default ", "extern ", "\"C\" "] {
            if let Some(r) = rest.strip_prefix(p) {
                rest = r.trim_start();
            }
        }
        if rest.starts_with("pub(") {
            if let Some(i) = rest.find(')') {
                rest = rest[i + 1..].trim_start();
            }
        }
        if rest == before {
            break;
        }
    }
    if let Some(r) = rest.strip_prefix("macro_rules!") {
        let name = head_ident(r);
        return if name.is_empty() { None } else { Some(("macro", name, level)) };
    }
    for (kw, kind) in [
        ("fn ",     "fn"),
        ("struct ", "struct"),
        ("enum ",   "enum"),
        ("trait ",  "trait"),
        ("type ",   "type"),
        ("const ",  "const"),
        ("static ", "static"),
        ("mod ",    "mod"),
    ] {
        if let Some(r) = rest.strip_prefix(kw) {
            let name = head_ident(r);
            return if name.is_empty() { None } else { Some((kind, name, level)) };
        }
    }
    // An impl block's NAME is the text of its head, because "impl" alone says nothing and the
    // trait and the type together are what a reader is looking for.
    if rest.starts_with("impl")
        && rest.as_bytes().get(4).map_or(true, |b| !b.is_ascii_alphanumeric() && *b != b'_')
    {
        let head = rest.split(" where").next().unwrap_or(rest);
        let head = head.split('{').next().unwrap_or(head);
        return Some(("impl", head.trim().to_string(), level));
    }
    None
}

/// One JavaScript or TypeScript item, where the line declares one.
pub(super) fn js_item(t: &str, level: usize) -> Option<(&'static str, String, usize)> {
    if t.starts_with("//") || t.starts_with("*") || t.starts_with("/*") {
        return None;
    }
    let mut rest = t;
    for p in ["export default ", "export ", "declare ", "public ", "private ", "static "] {
        if let Some(r) = rest.strip_prefix(p) {
            rest = r.trim_start();
        }
    }
    for p in ["async function ", "function "] {
        if let Some(r) = rest.strip_prefix(p) {
            let name = head_ident(r);
            return if name.is_empty() { None } else { Some(("fn", name, level)) };
        }
    }
    if let Some(r) = rest.strip_prefix("class ") {
        let name = head_ident(r);
        return if name.is_empty() { None } else { Some(("class", name, level)) };
    }
    for (kw, kind) in [("const ", "const"), ("let ", "let"), ("var ", "var")] {
        if let Some(r) = rest.strip_prefix(kw) {
            let name = head_ident(r);
            if name.is_empty() {
                return None;
            }
            // A binding is an ITEM only where it holds something with a body: a function, an
            // arrow or an object. `var n = 3` is a value, and an outline of every value is a
            // second copy of the file.
            let after = match r.find('=') {
                Some(i) => r[i + 1..].trim_start(),
                None    => return None,
            };
            if after.starts_with("function") || after.starts_with("async")
                || after.starts_with('{') || r.contains("=>")
            {
                return Some((kind, name, level));
            }
            return None;
        }
    }
    // Object and class members, which is how `Workers.dispatch` is found: it is a property of an
    // object literal and nothing at column zero declares it.
    if level >= 1 {
        if let Some(i) = rest.find(':') {
            let name  = rest[..i].trim();
            let after = rest[i + 1..].trim_start();
            if is_ident(name)
                && (after.starts_with("function") || after.starts_with("async")
                    || after.contains("=>"))
            {
                return Some(("method", name.to_string(), level));
            }
        }
        if rest.ends_with('{') {
            if let Some(i) = rest.find('(') {
                let name = rest[..i].trim();
                let name = name.strip_prefix("async ").unwrap_or(name).trim();
                if is_ident(name) && !JS_NOT_A_NAME.contains(&name) {
                    return Some(("method", name.to_string(), level));
                }
            }
        }
    }
    None
}

/// One Python item, where the line declares one.
pub(super) fn py_item(t: &str, level: usize) -> Option<(&'static str, String, usize)> {
    for p in ["async def ", "def "] {
        if let Some(r) = t.strip_prefix(p) {
            let name = head_ident(r);
            return if name.is_empty() { None } else { Some(("fn", name, level)) };
        }
    }
    if let Some(r) = t.strip_prefix("class ") {
        let name = head_ident(r);
        return if name.is_empty() { None } else { Some(("class", name, level)) };
    }
    None
}

/// One Markdown heading, where the line is one.
pub(super) fn md_item(t: &str, _level: usize) -> Option<(&'static str, String, usize)> {
    let hashes = t.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 || !t[hashes..].starts_with(' ') {
        return None;
    }
    Some((OUTLINE_HEADINGS[hashes - 1], t[hashes..].trim().to_string(), hashes - 1))
}

/// One Typst heading or binding, where the line is one.
pub(super) fn typ_item(t: &str, level: usize) -> Option<(&'static str, String, usize)> {
    let eq = t.chars().take_while(|c| *c == '=').count();
    if eq >= 1 && eq <= 6 && t[eq..].starts_with(' ') {
        return Some((OUTLINE_HEADINGS[eq - 1], t[eq..].trim().to_string(), eq - 1));
    }
    if let Some(r) = t.strip_prefix("#let ") {
        let name = head_ident(r);
        return if name.is_empty() { None } else { Some(("let", name, level)) };
    }
    None
}

/// One file's outline, fed a line at a time.
///
/// An item's range ends where the next item of the same or a shallower level begins, minus one;
/// what is still open at the end closes at the file's last line. That rule is a stack, which is
/// why this is a scan rather than a pass over a list.
pub(super) struct OutlineScan {
    pub(super) lang:  OutlineLang,
    pub(super) items: Vec<OutlineItem>,
    /// Indices into `items` of the items still open, shallowest first.
    pub(super) open:  Vec<usize>,
    /// Whether the scan is inside a fenced block, whose contents are not this file's headings.
    pub(super) fence: bool,
    pub(super) total: usize,
}

impl OutlineScan {
    pub(super) fn new(lang: OutlineLang) -> Self {
        Self { lang, items: Vec::new(), open: Vec::new(), fence: false, total: 0 }
    }

    pub(super) fn feed(&mut self, n: usize, line: &str) {
        self.total = n;
        let t = line.trim_start();
        if matches!(self.lang, OutlineLang::Md | OutlineLang::Typ) && t.starts_with("```") {
            self.fence = !self.fence;
            return;
        }
        if self.fence {
            return;
        }
        let level = indent_level(line);
        let found = match self.lang {
            OutlineLang::Rust => rust_item(t, level),
            OutlineLang::Js   => js_item(t, level),
            OutlineLang::Py   => py_item(t, level),
            OutlineLang::Md   => md_item(t, level),
            OutlineLang::Typ  => typ_item(t, level),
        };
        let (kind, name, level) = match found {
            Some(x) => x,
            None    => return,
        };
        // Everything at this level or deeper ended on the line before this one.
        while let Some(&i) = self.open.last() {
            if self.items[i].level >= level {
                self.items[i].end = n.saturating_sub(1).max(self.items[i].start);
                self.open.pop();
            } else {
                break;
            }
        }
        self.items.push(OutlineItem { start: n, end: n, level, kind, name });
        self.open.push(self.items.len() - 1);
    }

    /// The items, and the file's last line number.
    pub(super) fn finish(mut self) -> (Vec<OutlineItem>, usize) {
        let last = self.total;
        for i in self.open.drain(..) {
            self.items[i].end = last.max(self.items[i].start);
        }
        (self.items, last)
    }
}

/// What `outline` says about a file whose extension no scanner reads.
pub(super) fn outline_no_scanner(path: &str) -> String {
    let ext = path.rsplit('/').next().unwrap_or(path)
        .rsplit_once('.').map(|(_, e)| fmt!(".{}", e)).unwrap_or_else(|| fmt!("no extension"));
    fmt!(
        "[outline] no scanner for '{}'. It reads Rust, JavaScript/TypeScript, Python, Markdown \
        and Typst. file_search with the query '^\\S' lists the lines of this file that start at \
        column 0, which is the nearest thing.\n", ext)
}

/// The rows of an outline, as the model reads them.
///
/// # Arguments
/// * `lines` - The file's last line number.
/// * `bytes` - The whole file's length.
pub(super) fn outline_report(
    path:  &str,
    lines: usize,
    bytes: usize,
    items: &[OutlineItem],
    opts:  &OutlineOpts,
)
    -> String
{
    // Relative to the shallowest item, not to column zero: see `OutlineItem::level`.
    let base = items.iter().map(|i| i.level).min().unwrap_or(0);
    let kept: Vec<&OutlineItem> = items.iter()
        .filter(|i| i.level - base <= opts.depth)
        .filter(|i| match &opts.name {
            Some(re) => re.is_match(&i.name).unwrap_or(false),
            None     => true,
        })
        .collect();
    if kept.is_empty() {
        return fmt!(
            "[outline] {} -- {} lines, {} bytes; no item at depth {} or less{}. Raise 'depth', \
            or drop 'name'.\n",
            path, lines, bytes, opts.depth,
            match &opts.name { Some(_) => " matching 'name'", None => "" });
    }
    let shown: Vec<&&OutlineItem> = kept.iter().skip(opts.skip).take(opts.limit).collect();
    let from = opts.skip + 1;
    let to   = opts.skip + shown.len();
    let mut out = fmt!(
        "[outline] {} -- {} lines, {} bytes; {} item(s) at depth {} or less, rows {}-{}. Ranges \
        end where the next item begins.",
        path, lines, bytes, kept.len(), opts.depth, from, to);
    if to < kept.len() {
        out.push_str(&fmt!(" Next: {{\"path\":\"{}\",\"offset\":{}}}", json_escape(path), to));
    }
    out.push('\n');
    for i in &shown {
        for _ in 0..(i.level - base) {
            out.push_str("  ");
        }
        out.push_str(&fmt!("{}-{}\t{}\t{}\n", i.start, i.end, i.kind, i.name));
    }
    truncate_output(&mut out, MAX_OUTPUT);
    out
}

/// The plain-English account of what a search did and did not look at.
///
/// Always present, matches or none: a search that skipped four hundred files and found nothing
/// has not established that there is nothing to find, and saying so is the difference between an
/// answer and a guess.
///
/// # Arguments
/// * `opts` - What the call asked for.
/// * `stats` - What the walk actually did.
/// * `budget` - The entry budget, which says whether the tree was walked to the end.
/// * `start` - Where the walk began, as the caller wrote it.
pub(super) fn search_notes(
    opts:   &SearchOpts,
    stats:  &SearchStats,
    budget: &WalkBudget,
    start:  &str,
)
    -> String
{
    let mut out = fmt!(
        "\n[file_search] {} match(es) in {} file(s); {} file(s) searched.",
        stats.matched, stats.hit_files, stats.files);
    // First among the notices, because it is the one that changes how every other line is to be
    // read: "no matches" under a stopped walk means "none where it looked", not "none here".
    out.push_str(&budget.notice("file_search", start,
        "Narrow it and ask again: set 'path' to a directory further down -- the walk had got as \
        far as the one named above -- or pass a 'glob' so fewer files are opened. Paging with \
        'offset' will NOT reach past this point, because the later files were never opened at \
        all."));
    let mut missed: Vec<String> = Vec::new();
    if stats.skipped > 0 {
        missed.push(fmt!(
            "{} director(ies) named {} (pass \"all\":true to search them too, or name one in \
            'path' or 'glob' to search just that one)",
            stats.skipped, opts.walk.passed_over().join(", ")));
    }
    if stats.too_big > 0 {
        missed.push(fmt!(
            "{} file(s) larger than {} bytes, on the machine half of the walk",
            stats.too_big, SEARCH_MACHINE_MAX_FILE));
    }
    if stats.binary > 0 {
        missed.push(fmt!("{} file(s) that are not text", stats.binary));
    }
    if stats.filtered > 0 {
        missed.push(fmt!("{} file(s) the glob excluded", stats.filtered));
    }
    if stats.refused > 0 {
        missed.push(fmt!("{} file(s) out of bounds for this turn", stats.refused));
    }
    if stats.undecided > 0 {
        missed.push(fmt!(
            "{} line(s) on which this pattern exhausted the matcher, so whether they match is \
            UNKNOWN rather than no", stats.undecided));
    }
    if !missed.is_empty() {
        out.push_str(&fmt!("\n[file_search] NOT searched: {}.", missed.join("; ")));
    }
    // Not a "not searched" line: the line WAS searched, and what is partial is the report of it.
    if stats.cut_lines > 0 {
        out.push_str(&fmt!(
            "\n[file_search] {} line(s) longer than {} bytes were matched on their first {} \
            bytes.", stats.cut_lines, SEARCH_LINE_MAX_BYTES, SEARCH_LINE_MAX_BYTES));
    }
    // See `glob_output`: an empty result from a directory the caller named for itself has to say
    // that it was looked in, or it reads as a directory that is not there.
    let named = opts.walk.by_name();
    if !named.is_empty() {
        out.push_str(&fmt!(
            "\n[file_search] SEARCHED by name: {} -- normally passed over, searched here because \
            you named it.", named.join(", ")));
    }
    if stats.capped {
        let at = if stats.by_bytes {
            fmt!("about {} bytes of matching lines", opts.bytes)
        } else {
            fmt!("the {}-match limit", opts.limit)
        };
        out.push_str(&fmt!(
            "\n[file_search] STOPPED at {}, so there are more matches than are shown and later \
            files were never opened. Narrow the search with \"glob\" or \"path\" -- the usual \
            answer -- or page on with \"offset\":{}, or raise \"limit\" (up to {}).",
            at, opts.skip + stats.matched, SEARCH_MATCHES_MAX));
    } else if opts.skip > 0 {
        out.push_str(&fmt!(
            "\n[file_search] this is the page beginning at match {}; the whole search found {}.",
            opts.skip + 1, stats.seen));
    }
    out.push('\n');
    out
}

/// One path a `file_glob` walk found.
pub(super) struct GlobHit {
    /// Workspace-relative path.
    pub(super) path: String,
    /// Nanoseconds since the epoch at which it was last written, and `None` where THIS path's
    /// backend does not record one.  Nanoseconds rather than seconds because a build writes many
    /// files in one second and "most recent first" would then be alphabetical order wearing a
    /// disguise.
    ///
    /// Per hit and not per call.  A walk with a real folder open crosses two filesystems -- the
    /// user's disk, which stamps its files, and the sandbox the Diamond's own store stays in,
    /// which may not (see `wasm::opfs::resolve_root`) -- so "is there a time for this" has one
    /// answer per path and no answer for the call.
    pub(super) when: Option<u64>,
}

/// What a `file_glob` line puts where the time goes when there is none.
///
/// One spelling, because the result explains it once and then repeats it per path; two spellings
/// would leave the explanation describing a marker that is not the one printed.
pub(super) const GLOB_NO_TIME: &str = "unknown";

/// Format milliseconds since the Unix epoch as an ISO-8601 UTC timestamp, to the second.
///
/// The proleptic Gregorian era arithmetic, which is exact and needs no calendar behind it on
/// either target -- the browser build has no clock crate and the native one should not disagree
/// with it about a date.
///
/// # Arguments
/// * `ms` - Milliseconds since 1970-01-01T00:00:00Z.
pub(super) fn iso8601_utc(ms: u64) -> String {
    let secs	= ms / 1_000;
    let tod	= secs % 86_400;			// Second of the day.
    // Shift the epoch to 0000-03-01 so that a leap day falls at the END of a cycle and every
    // month before it has a fixed length.
    let z	= (secs / 86_400) as i64 + 719_468;
    let era	= z.div_euclid(146_097);		// 400-year cycle.
    let doe	= z.rem_euclid(146_097);		// Day of the era.
    let yoe	= (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy	= doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp	= (5 * doy + 2) / 153;			// Month, counting from March.
    let day	= doy - (153 * mp + 2) / 5 + 1;
    let month	= if mp < 10 { mp + 3 } else { mp - 9 };
    let year	= yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    fmt!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, tod / 3_600, (tod / 60) % 60, tod % 60)
}

/// `ms` as the browser's `Date.prototype.toISOString` writes it, to the millisecond, so a sentence
/// the runner says for the tab names a time in the tab's own form.
pub fn iso8601_utc_ms(ms: u64) -> String {
    let s = iso8601_utc(ms);
    fmt!("{}.{:03}Z", s.trim_end_matches('Z'), ms % 1_000)
}


// ── What a search asks for, and what comes back ─────────────────────
//
// The result shape is `dev/SEARCH_CONTRACT.md` §4, and it is written down there rather than here
// because three halves read it: Rust in the gateway produces it, JavaScript in the browser parses
// it, and this renders it into the model's context.  A field invented on one side of that seam is
// a field the other two have never heard of.

/// The address a search leaves through, which is what the egress gate names.
///
/// NOT the engine's own host, and it cannot be: which engine answers is the user's setting,
/// resolved by the JavaScript half, so the wasm genuinely does not know where the query ends up --
/// and that ignorance is the feature.  What it does know is that the query leaves through
/// Daimond's own gateway, so that is the address, and the QUERY rides beside it as the detail,
/// because the query is the thing actually going out.
pub(super) const SEARCH_ENDPOINT: &str = "/api/web/search";

/// Which body of material a search asks for.
///
/// An enum rather than the bare wire string, so the three values the schema advertises, the three
/// the dispatch accepts and the three a refusal lists are one list.  Whether a given engine can
/// answer a kind is the engine's own business and it says so itself; nothing here guesses for it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchKind {
    /// The web at large.
    Web,
    /// News, where the engine keeps a news index.
    News,
    /// Scholarly work.
    Academic,
}

impl SearchKind {

    /// Every kind, in the order the schema offers them.
    pub fn all() -> [Self; 3] {
        [Self::Web, Self::News, Self::Academic]
    }

    /// The wire name: the same string in the tool argument, the gateway request and the setting.
    pub fn id(&self) -> &'static str {
        match self {
            Self::Web      => "web",
            Self::News     => "news",
            Self::Academic => "academic",
        }
    }

    /// Read a kind from its wire name.
    pub fn from_id(s: &str) -> Option<Self> {
        Self::all().into_iter().find(|k| k.id() == s)
    }

    /// The accepted names as a refusal can read them out, built from [`all`](SearchKind::all) so
    /// a fourth kind could never be accepted and then left out of the sentence that lists them.
    pub fn names() -> String {
        let ids: Vec<String> = Self::all().iter().map(|k| fmt!("'{}'", k.id())).collect();
        ids.join(", ")
    }
}

/// One search result: the four fields of the contract's §4 schema and nothing else.
///
/// `age` is whatever freshness the engine reported, verbatim and unparsed -- engines disagree
/// about what it means, and a wrong date is worse than no date.  `snippet` and `age` may be
/// empty; `title` and `url` may not, and a result missing either is dropped by the parser rather
/// than passed on empty.
#[derive(Clone, Debug, Default)]
pub struct SearchHit {
    /// The result's headline, as the engine wrote it.
    pub title: String,
    /// Where it points.
    pub url: String,
    /// The engine's extract, which may be empty.
    pub snippet: String,
    /// Freshness as the engine reported it, unparsed.
    pub age: String,
}

/// What one search came back with.
#[derive(Clone, Debug, Default)]
pub struct SearchAnswer {
    /// Which engine answered, by its contract id.
    pub engine: String,
    /// What was asked.  **Ours, not the response's echo of it** -- see
    /// [`crate::wasm::web::search`].
    pub query: String,
    /// The results, in the engine's own order.
    pub results: Vec<SearchHit>,
}

/// What the document panel says it drew, when a file was shown to the user.
///
/// Filled by [`crate::wasm::doc::show`] from the verdict `www/js/viewer.js` returns, and read
/// only by [`Tool::show_result`].  It lives here rather than in the wasm edge for the reason
/// [`SearchAnswer`] does: the shape is the tool's, the transport is the edge's, and the English
/// composed from it is target-agnostic and therefore testable on a build with no browser in it.
///
/// **Nothing here is decided in Rust.**  Which formats have a viewer, and which of them a given
/// file falls to, is one table in `viewer.js`, and this carries its answer across rather than
/// holding a second copy that would drift the first time a format changed tier -- at which point
/// the model would promise a picture over a hex dump, to a user who cannot see the disagreement.
#[derive(Clone, Debug, Default)]
pub struct Shown {
    /// Which tier drew it: `doc`, `image`, `audio`, `video`, `frame`, `json`, `table`,
    /// `markdown`, `editor`, `hex` or `empty`.
    pub tier: String,
    /// The format's variant name, e.g. `Pdf`.
    pub media: String,
    /// The format's English label, e.g. `PDF document`.
    pub label: String,
    /// How many bytes the file holds.
    pub size: u64,
    /// Which page a paged document was actually opened at, or `None` for the top.
    ///
    /// **What the panel used, not what the tool asked for**, and the two differ: a show with no
    /// page named leaves a document where it was last aimed, so a rebuilt PDF comes back in the
    /// reader's place rather than at page 1.  A model told its own argument back would say "page
    /// 1" to somebody looking at page 214.
    pub page: Option<u32>,
    /// Whether the name and the leading bytes disagree about what this file is.
    pub disagree: bool,
    /// The format the NAME claims, as a label, when the two disagree.
    pub named: String,
    /// The format the BYTES show, as a label, when the two disagree.
    pub found: String,
    /// Whether the file actually reached the screen.
    ///
    /// False when the conversation that asked is not the one the user is in, which the panel
    /// answers rather than this side: only the page knows which Diamond is in view.  The file is
    /// held and shown when the user next opens that Diamond, so this is "not yet" and never "not
    /// possible" -- a distinction [`show_result`](Tool::show_result) has to keep, because a model
    /// that reads a refusal as a limit of the app reports the limit to the user and stops trying.
    pub shown: bool,
    pub asker: String, // the device the turn was asked from, when it runs here for it, else empty
}

// ── Social: the panel a daimon could not reach ──────────────────────
//
// **This is the second instance of the defect class [`Tool::FileShow`] is written under**, and
// it is written down here rather than only there because the first one was read as being about
// PDFs.  It is not.  The rule is:
//
//	every surface a user can reach needs a way for the daimon to reach it, or the daimon
//	will eventually deny that the surface exists.
//
// On 2026-08-24 two real daimons, on two accounts and two different models, were each asked to
// do their own side of the Social panel's work -- one to report a defect, one to find that
// report and agree with it.  Neither could, because not one of the thirty-three tool variants
// touched `/api/improve` or `/api/post` and `crate::prompts` did not contain the word
// "proposal".  What both then did is the finding:
//
//	one spent five calls, reached for `web_open` and `web_fetch`, was told the account has
//	no web credits, wrote its report into a scratch file and told the user to open
//	"Daimond's feedback/issue reporting interface (typically accessible from a menu in the
//	app)" and paste it in.  That interface is the Social panel, and it had just failed to
//	find it;
//
//	the other spent eighteen calls and thirty-two tool results searching the workspace for
//	"where the Social panel stores its reports", reached for `web_fetch` at `127.0.0.1`
//	(refused: not publicly routable) and then at this project's GitHub issues page, and
//	finished by telling the user "The gateway isn't running."  The gateway was running.
//
// Two daimons, two wrong explanations, neither about the real cause.  Both resolved "I have no
// tool for this" into "the app cannot do this", exactly as the rule predicts.
//
// ── THE TWO HALVES ARE NOT THE SAME QUESTION ─────────────────────────
//
// The owner ruled on 2026-08-24, given the choice between read-only, read-plus-ask, and full
// access:
//
//	A daimon can see what is on Social and Improve immediately.  That is information, and
//	it stops it denying the feature exists.  Publishing or voting goes through the same
//	consent step the network already uses: it asks, he approves, it acts.  Nothing goes out
//	unseen.
//
// So [`Tool::SocialRead`] asks nobody anything, and [`Tool::SocialSend`] asks every time.  They
// are two variants and not one tool with a verb, because a single schema entry whose gating
// depended on an argument would present the model with one door and two behaviours -- and the
// model reads the schema, not this comment.

/// One view of the Social panel, named as the panel's own chips name it.
///
/// The wire names are the `data-view` attributes in `www/index.html`, so the word the model
/// writes is the word on the control a person presses.  A sixth chip is added here and is then
/// offered, refused and listed by the three functions below rather than in three places.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SocialView {
    // The forge
    Proposals,	// everything anybody has asked for, newest first
    Proposal,	// one of them in full, with its discussion
    // This device
    Notes,		// what has been written here and not sent
    // The relay
    Messages,	// what people have sent this account
    People,		// who this account can reach
    // The feed -- other people's words, held by Oxedyne in the clear (feed plan §6)
    Feed,		// posts from who this account follows and is approved by
}

impl SocialView {

    /// Every view, in the order the schema offers them.
    pub fn all() -> [Self; 6] {
        [Self::Proposals, Self::Proposal, Self::Notes, Self::Messages, Self::People, Self::Feed]
    }

    /// The wire name: the same string in the tool argument, the driver request and the panel's
    /// own `data-view` attribute.
    pub fn id(&self) -> &'static str {
        match self {
            Self::Proposals	=> "proposals",
            Self::Proposal	=> "proposal",
            Self::Notes		=> "notes",
            Self::Messages	=> "messages",
            Self::People	=> "people",
            Self::Feed		=> "feed",
        }
    }

    /// Read a view from its wire name.
    pub fn from_id(s: &str) -> Option<Self> {
        Self::all().into_iter().find(|v| v.id() == s)
    }

    /// The accepted names as a refusal can read them out, built from [`all`](SocialView::all) so
    /// a sixth view could never be accepted and then left out of the sentence that lists them.
    pub fn names() -> String {
        let ids: Vec<String> = Self::all().iter().map(|v| fmt!("'{}'", v.id())).collect();
        ids.join(", ")
    }
}

/// One act on the Social panel that other people can see.
///
/// All three are public, all three carry the user's voice, and none of the three can be taken
/// back by the app -- which is why they share a tool and a gate rather than being spread across
/// the read tool by an argument.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SocialAct {
    Propose,	// open a proposal on the forge
    Vote,		// for or against one that is open, or take a vote back
    Comment,	// say something on one
    FeedPost,	// publish to this account's own followers (feed plan §6)
}

impl SocialAct {

    /// Every act, in the order the schema offers them.
    pub fn all() -> [Self; 4] {
        [Self::Propose, Self::Vote, Self::Comment, Self::FeedPost]
    }

    /// The wire name, shared by the tool argument and the driver request.
    pub fn id(&self) -> &'static str {
        match self {
            Self::Propose	=> "propose",
            Self::Vote		=> "vote",
            Self::Comment	=> "comment",
            Self::FeedPost	=> "feed_post",
        }
    }

    /// Read an act from its wire name.
    pub fn from_id(s: &str) -> Option<Self> {
        Self::all().into_iter().find(|a| a.id() == s)
    }

    /// The accepted names as a refusal can read them out.
    pub fn names() -> String {
        let ids: Vec<String> = Self::all().iter().map(|a| fmt!("'{}'", a.id())).collect();
        ids.join(", ")
    }
}

/// Which way a vote goes, in the words the control uses rather than the forge's integers.
///
/// The panel's vote control is a pair of buttons that stay pressed, and pressing the pressed one
/// takes the vote back -- so there really are three states and `withdraw` is one of them, not a
/// deletion bolted on.  [`wire`](Vote::wire) is where they become the forge's `d`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Vote {
    For,		// d=1
    Against,	// d=-1
    Withdraw,	// d=0, and only meaningful where this voice has already voted
}

impl Vote {

    /// Every direction, in the order the schema offers them.
    pub fn all() -> [Self; 3] {
        [Self::For, Self::Against, Self::Withdraw]
    }

    /// The wire name in the tool argument.
    pub fn id(&self) -> &'static str {
        match self {
            Self::For		=> "for",
            Self::Against	=> "against",
            Self::Withdraw	=> "withdraw",
        }
    }

    /// The forge's own `d`, which is what the panel puts on the wire.
    pub fn wire(&self) -> i8 {
        match self {
            Self::For		=> 1,
            Self::Against	=> -1,
            Self::Withdraw	=> 0,
        }
    }

    /// Read a direction from its wire name.
    pub fn from_id(s: &str) -> Option<Self> {
        Self::all().into_iter().find(|v| v.id() == s)
    }

    /// The accepted names as a refusal can read them out.
    pub fn names() -> String {
        let ids: Vec<String> = Self::all().iter().map(|v| fmt!("'{}'", v.id())).collect();
        ids.join(", ")
    }
}

/// The wire name of the tool that publishes, as the consent gate's payload carries it.
pub const SOCIAL_SEND_TOOL: &str = "social_send";

/// The word a yes to a publication comes back as, and nothing else.
///
/// A distinct word for the same boundary reason [`RUN_NET_ALLOW_WORD`] is one.  The page's gate
/// answers `allow` outright for our own host, and the forge is reached through our own gateway --
/// so a question that ever fell through to that shortcut would publish with nobody asked.  The
/// publish branch is answered above it, and this word means that an older bundle, a missing
/// branch and the shortcut all say `allow`, and all three correctly mean NO here.
pub const PUBLISH_ALLOW_WORD: &str = "allow-publish";

/// How many records a listing answers with when the call does not say.
pub const SOCIAL_PAGE: u64 = 12;

/// The most a listing will answer with however large a `limit` is asked for.
pub const SOCIAL_PAGE_MAX: u64 = 50;

/// What one note may be, matching `MAX_CHARS` in `www/js/improve.js` and the gateway's own cap.
///
/// Held here as well so the refusal reaches the model BEFORE a round trip: a note cut off at the
/// far end comes back as a gateway error the model cannot attribute.
pub const SOCIAL_MAX_CHARS: usize = 20_000;

/// What one feed post may be, matching `POST_MAX` in `www/js/feed.js` and the gateway's own
/// `FEED_POST_MAX_BYTES`.  Bytes, not characters: the gateway's bound is on the wire size.
pub const FEED_POST_MAX_BYTES: usize = 4096;


/// The refusal a publication that was declined -- or could not be put to anybody -- hands back.
///
/// Through [`refusal_line`], so a publication the gate stopped is not later counted as one that
/// happened: [`call_outcome`] reads the opening word.
///
/// It says what to do next, because a model with something to say and no way to say it will
/// otherwise spend the turn finding that out one refusal at a time -- which is the whole of what
/// the two daimons above did.
///
/// # Arguments
/// * `act` - The act that did not happen, in the user's vocabulary.
/// * `reason` - Why, as a whole sentence.
pub(super) fn publish_refusal(act: &str, reason: &str) -> String {
    refusal_line(&fmt!(
        "Nothing was published. You asked to {} on Daimond's Social panel, which other people \
        read and which nothing here can take back, so it is put to the user before it goes. {} \
        Do not send it again unasked. Tell the user what you wanted to publish and why, and let \
        them say.",
        act, reason))
}

/// Put a publication to the user, through the same door every other consent question goes
/// through.
///
/// **This one is not conditional on anything.**  Every other gate in this file asks
/// [`egress_needs_consent`] or [`act_needs_consent`] first, and both of those are quiet on an
/// untainted turn in the default rung -- rightly, because reaching a page the user asked about
/// is the turn doing what it was told.  Publishing is not that.  It is the user's name on
/// something strangers read, it happens once rather than fifty times a turn, and the owner's
/// ruling was `nothing goes out unseen`.  So there is no rung and no taint in the condition:
/// asked, every time.
///
/// # Arguments
/// * `shown` - Exactly what would be published, as the panel composed it.
/// * `host` - The host the question is put through.
pub async fn publish_check<H: Host>(shown: &str, host: &H) -> Option<String> {
    let answer = host.net().egress_allowed_publish("", shown).await;
    match answer {
        Some(Verdict::Allow) => None,
        Some(Verdict::Deny)  => Some(publish_refusal(
            "publish something", "The user was asked, and said no.")),
        None                 => Some(publish_refusal(
            "publish something",
            "The user could not be asked, and an unanswered request is not consent.")),
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Asking the user: one decision, answered with a tap             │
// └───────────────────────────────────────────────────────────────┘

// What one question may carry.  A label is a BUTTON, so it is capped hard, for the reason the
// `run` dialog caps a command line: an operative argument buried under a screenful of padding is
// a control whose other choices have been pushed off the screen.
pub(super) const ASK_MIN_OPTIONS:  usize = 2;      // one option is not a decision
pub(super) const ASK_MAX_OPTIONS:  usize = 4;      // five is a list, and a list is answered in a lump
pub(super) const ASK_LABEL_MAX:    usize = 60;     // it has to sit on a button beside three others
pub(super) const ASK_QUESTION_MAX: usize = 300;    // one sentence, and this is generous for one
pub(super) const ASK_MEANS_MAX:    usize = 400;    // what the option means, not an essay about it

/// One question, checked and composed, ready for the page to draw.
#[derive(Debug)]
pub(super) struct Asked {
    pub(super) payload:    String,     // what the page is handed, as JSON
    pub(super) options:    usize,      // how many buttons it will draw
    pub(super) silent:     String,     // what the model said it would do if nobody answers
}

/// A refusal from this tool, in the shape every refusal in this file takes.
///
/// Through [`refusal_line`] so [`call_outcome`] books it [`CallOutcome::Refused`], which is what
/// stops the turn ending: an `ask` that asked nothing must leave the model a round in which to
/// put the question properly, or the refusal is advice it is denied the chance to take.  That is
/// exactly the defect `say` had when a refused fold ended a worker's turn and threw its report
/// away.
pub(super) fn ask_refusal(reason: &str) -> String {
    refusal_line(&fmt!("Nothing was asked. {}", reason))
}

/// Whether this call may put its question, and what the page is to draw if it may.
///
/// **Pure, so the whole of the house rule for decisions is testable on a build with no browser
/// in it.**  Every clause below is one line of the rule the owner wrote down twice, enforced
/// here rather than requested in a prompt -- a prompt sentence is advice a model may take, and
/// what has been missing is not advice.
///
/// # Arguments
/// * `args` - The raw tool arguments.
/// * `alone` - Whether this turn is a dispatched worker, acting with nobody watching.
/// * `already` - Whether this turn has put a question already.
pub(super) fn ask_step(args: &str, alone: bool, already: bool) -> Result<Asked, String> {
    // A DISPATCHED WORKER MAY NOT ASK, for the reason it may not take the screen: nobody is
    // reading its transcript, several run at once, and a question drawn into a conversation the
    // user is not in is a question put to an empty room.  The daimon that dispatched it is
    // supervised and is where a decision belongs, so this says so rather than only saying no --
    // a worker told "no" writes the same call again with different arguments.
    if alone {
        return Err(ask_refusal(
            "You are a dispatched worker: nobody is reading this transcript, so there is \
            nobody to tap an answer. Put the question in your report, with the options and \
            your recommendation, and the daimon that dispatched you will ask it."));
    }
    // ONE DECISION AT A TIME, and this is the clause that could not be left to the prompt: a
    // single round may carry several tool calls, so a model minded to ask three things asks
    // them in one breath and the user answers one.
    if already {
        return Err(ask_refusal(
            "You have already put a question this turn and it is on the user's screen. One \
            decision at a time: a list is read as a chore and answered in a lump or not at \
            all. Wait for this answer, then ask the next."));
    }
    let question = extract_json_string(args, "question").unwrap_or_default();
    if question.trim().is_empty() {
        return Err(ask_refusal(
            "The call carried no 'question'. It is the decision in one sentence of plain words, \
            naming the thing it decides."));
    }
    if question.chars().count() > ASK_QUESTION_MAX {
        return Err(ask_refusal(&fmt!(
            "The 'question' is {} characters and may be {}. It is ONE sentence; what will not fit \
            belongs in what each option means.",
            question.chars().count(), ASK_QUESTION_MAX)));
    }
    let why = extract_json_string(args, "why").unwrap_or_default();
    if why.trim().is_empty() {
        return Err(ask_refusal(
            "The call carried no 'why'. Give the reason for your recommendation in one sentence, \
            and cite THEIR world -- their constraint, their cost, their users -- rather than a \
            general virtue."));
    }
    let silent = extract_json_string(args, "if_silent").unwrap_or_default();
    if silent.trim().is_empty() {
        return Err(ask_refusal(
            "The call carried no 'if_silent'. Say what you will do if they answer nothing, so \
            that saying nothing is itself a choice they can make knowingly."));
    }
    let raw = match extract_json_objects(args, "options") {
        Some(v) => v,
        None    => return Err(ask_refusal(
            "The call carried no 'options' array. Each option is an object with a 'label' -- the \
            words on the button -- and a 'means', which is what choosing it would concretely do, \
            with an example where one is possible.")),
    };
    if raw.len() < ASK_MIN_OPTIONS {
        return Err(ask_refusal(&fmt!(
            "A question with {} option is not a decision. Give at least {}, or ask in prose.",
            raw.len(), ASK_MIN_OPTIONS)));
    }
    if raw.len() > ASK_MAX_OPTIONS {
        return Err(ask_refusal(&fmt!(
            "There are {} options and a question may carry {}. More than that is a list, and it \
            will be answered in a lump or not at all. Decide which really differ and ask again.",
            raw.len(), ASK_MAX_OPTIONS)));
    }
    let mut opts: Vec<(String, String)> = Vec::with_capacity(raw.len());
    for one in &raw {
        let label = extract_json_string(one, "label").unwrap_or_default();
        if label.trim().is_empty() {
            return Err(ask_refusal(
                "An option has no 'label'. It is the words on the button, so it cannot be empty."));
        }
        if label.chars().count() > ASK_LABEL_MAX {
            return Err(ask_refusal(&fmt!(
                "The label '{}…' is {} characters and a label may be {}: it goes on a button \
                beside the others, and a long one pushes them off the screen. Put the detail in \
                'means'.",
                label.chars().take(24).collect::<String>(), label.chars().count(), ASK_LABEL_MAX)));
        }
        if label.contains('\n') {
            return Err(ask_refusal(&fmt!(
                "The label '{}' holds a newline. A label is one line; everything after it belongs \
                in 'means'.", label.lines().next().unwrap_or("").trim())));
        }
        let means = extract_json_string(one, "means").unwrap_or_default();
        if means.trim().is_empty() {
            return Err(ask_refusal(&fmt!(
                "The option '{}' says what it is called and not what it means. Say what choosing \
                it would concretely do -- what they would see, get, or pay -- and the trade-off \
                that comes with it.", label.trim())));
        }
        if means.chars().count() > ASK_MEANS_MAX {
            return Err(ask_refusal(&fmt!(
                "What '{}' means runs to {} characters and may be {}. This is read at a glance \
                beside three others.", label.trim(), means.chars().count(), ASK_MEANS_MAX)));
        }
        if opts.iter().any(|(l, _): &(String, String)| l.trim() == label.trim()) {
            return Err(ask_refusal(&fmt!(
                "Two options are both called '{}', so an answer naming it would not say which \
                was chosen.", label.trim())));
        }
        opts.push((label.trim().to_string(), means.trim().to_string()));
    }
    // THE RECOMMENDATION IS NAMED, IN WORDS, AS ONE OF THE OPTIONS.  Matched against the labels
    // rather than taken as prose, because a recommendation the page cannot find is one it cannot
    // mark -- and a recommendation implied by ordering is the failure this field exists to stop.
    let rec = extract_json_string(args, "recommend").unwrap_or_default();
    if rec.trim().is_empty() {
        return Err(ask_refusal(&fmt!(
            "The call carried no 'recommend'. Name your recommendation as one of the options, in \
            words: {}. 'It depends' is not an answer; if it genuinely depends, say what on and \
            pick the branch you believe applies.",
            opts.iter().map(|(l, _)| fmt!("'{}'", l)).collect::<Vec<_>>().join(", "))));
    }
    if !opts.iter().any(|(l, _)| l == rec.trim()) {
        return Err(ask_refusal(&fmt!(
            "'{}' is not one of the options, so nothing on the screen can be marked as your \
            recommendation. It must match a label exactly: {}.",
            rec.trim().chars().take(60).collect::<String>(),
            opts.iter().map(|(l, _)| fmt!("'{}'", l)).collect::<Vec<_>>().join(", "))));
    }
    // `n` of `of` is the line that says how many follow, and it is optional: a single decision
    // has no count worth drawing.  A count of nought or a pair that does not make sense is
    // dropped rather than refused -- it is decoration on a question that is otherwise sound.
    let n  = extract_json_number(args, "n").unwrap_or(0);
    let of = extract_json_number(args, "of").unwrap_or(0);
    let (n, of) = if n > 0 && of >= n { (n, of) } else { (0, 0) };
    let body = opts.iter()
        .map(|(l, m)| fmt!(r#"{{"label":"{}","means":"{}","recommended":{}}}"#,
            json_escape(l), json_escape(m), l == rec.trim()))
        .collect::<Vec<_>>()
        .join(",");
    Ok(Asked {
        payload: fmt!(
            r#"{{"question":"{}","why":"{}","if_silent":"{}","n":{},"of":{},"options":[{}]}}"#,
            json_escape(question.trim()), json_escape(why.trim()), json_escape(silent.trim()),
            n, of, body),
        options: opts.len(),
        silent:  silent.trim().to_string(),
    })
}

/// What the model reads once the question is on the screen.
///
/// **It says the turn ends here**, because it does -- see the note in
/// [`crate::agent::Agent::run_tool_loop`] on why a question is the one tool result a turn stops
/// on.  A model told nothing would write a paragraph restating the question it has just drawn, in
/// a round it has just been charged for, under a card that already says it.
///
/// And it says nothing is held waiting, because nothing is: the card is drawn from the call's own
/// arguments, so a reload redraws it and the buttons still work.  A model that believed a machine
/// was blocked would tell the user so, and that would be false.
///
/// # Arguments
/// * `a` - The checked question, as [`ask_step`] composed it.
pub(super) fn ask_result(a: &Asked) -> String {
    fmt!(
        "Asked. The question is on the user's screen with {} options, your recommendation marked, \
        and a box beside them for an answer of their own. YOUR TURN ENDS HERE: say nothing \
        further, and do not repeat the question in prose. Their answer arrives as their next \
        message -- it opens 'Chose:' followed by the label they tapped, or 'Other:' followed by \
        words of their own, which may reject every option you offered. Nothing on the machine is \
        held waiting, so an unanswered question costs nothing and expires never; if they say \
        nothing, what you said you would do is: {}",
        a.options, a.silent)
}
