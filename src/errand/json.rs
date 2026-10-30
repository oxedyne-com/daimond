//! JSON as the tab's JavaScript writes and reads it, for the peer envelopes (R3a).
//!
//! The envelope a tab signs is `JSON.stringify` of an object whose keys sit in the order its
//! builder (`makeErrand`, `makeReport`) wrote them, and the signature is over peer.js `canonical`,
//! the same value with every object's keys sorted.  A native copy has to produce both byte for
//! byte, so this is a small value type that keeps key order and the number's own text, with a
//! writer for each form.  fe2o3_jdat's map is ordered by key, which is right for `canonical` and
//! wrong for `JSON.stringify`.
//!
//! - [`Js::stringify`] is `JSON.stringify`: no spaces, `"`, `\` and the control characters
//!   escaped (`\b \f \n \r \t`, the rest as lower-case `\u00xx`), everything else as it is.
//! - [`Js::canonical`] is peer.js `canonical`: keys sorted as `Array.prototype.sort` sorts
//!   strings, by UTF-16 code unit, which differs from Rust's byte order past U+FFFF.
//! - [`Js::parse`] reads what `JSON.stringify` writes.  A number keeps its text, so a value read
//!   from a tab and written again is the bytes the tab wrote.  A repeated key and a lone
//!   surrogate are refused: neither comes from a tab, and either would let two readers see two
//!   different objects in one envelope.

use oxedyne_fe2o3_core::prelude::*;

use std::cmp::Ordering;

/// How deep a value may nest before it is refused.
pub const MAX_DEPTH: usize = 64;

/// A JSON value with its object keys in their written order.
#[derive(Clone, Debug, PartialEq)]
pub enum Js {
    Null,
    Bool(bool),
    /// The number's text as written, which is what `JSON.stringify` wrote for it.
    Num(String),
    Str(String),
    Arr(Vec<Js>),
    Obj(Vec<(String, Js)>),
}

impl Js {
    /// A whole number.
    pub fn int(n: i64) -> Self {
        Self::Num(n.to_string())
    }

    /// A string.
    pub fn str(s: &str) -> Self {
        Self::Str(s.to_string())
    }

    /// A list of strings.
    pub fn strs(v: &[String]) -> Self {
        Self::Arr(v.iter().map(|s| Self::Str(s.clone())).collect())
    }

    /// The value at `key` of an object, or `None`.
    pub fn get(&self, key: &str) -> Option<&Js> {
        match self {
            Self::Obj(kv) => kv.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// The string at `key`, or `None` when it is absent or not a string.
    pub fn get_str(&self, key: &str) -> Option<&str> {
        match self.get(key) {
            Some(Self::Str(s)) => Some(s.as_str()),
            _ => None,
        }
    }

    /// The text `JSON.stringify` writes for this value.
    pub fn stringify(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, false);
        out
    }

    /// peer.js `canonical`: as [`Js::stringify`], with every object's keys sorted.
    pub fn canonical(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, true);
        out
    }

    fn write(&self, out: &mut String, sorted: bool) {
        match self {
            Self::Null => out.push_str("null"),
            Self::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Self::Num(n) => out.push_str(n),
            Self::Str(s) => quote(out, s),
            Self::Arr(v) => {
                out.push('[');
                for (i, x) in v.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    x.write(out, sorted);
                }
                out.push(']');
            },
            Self::Obj(kv) => {
                let mut order: Vec<&(String, Js)> = kv.iter().collect();
                if sorted {
                    order.sort_by(|a, b| utf16_cmp(&a.0, &b.0));
                }
                out.push('{');
                for (i, (k, v)) in order.into_iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    quote(out, k);
                    out.push(':');
                    v.write(out, sorted);
                }
                out.push('}');
            },
        }
    }

    /// Read one JSON value, the whole of `txt`.
    pub fn parse(txt: &str) -> Outcome<Self> {
        let mut p = Parser { b: txt.as_bytes(), at: 0 };
        let v = res!(p.value(0));
        p.space();
        if p.at != p.b.len() {
            return Err(err!("JSON carries {} bytes after its value.", p.b.len() - p.at;
                Decode, Invalid, Input));
        }
        Ok(v)
    }
}

/// Strings compared as JavaScript's default sort compares them, by UTF-16 code unit.
pub fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `s` as `JSON.stringify` quotes it.
fn quote(out: &mut String, s: &str) {
    const H: &[u8; 16] = b"0123456789abcdef";
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let n = c as u32 as usize;
                out.push_str("\\u00");
                out.push(H[n >> 4] as char);
                out.push(H[n & 15] as char);
            },
            c => out.push(c),
        }
    }
    out.push('"');
}

struct Parser<'a> {
    b:  &'a [u8],
    at: usize,
}

impl<'a> Parser<'a> {
    fn space(&mut self) {
        while self.at < self.b.len() && matches!(self.b[self.at], b' ' | b'\t' | b'\n' | b'\r') {
            self.at += 1;
        }
    }

    fn bad(&self, what: &str) -> Error<ErrTag> {
        err!("JSON is not readable at byte {}: {}.", self.at, what; Decode, Invalid, Input)
    }

    fn word(&mut self, w: &[u8], v: Js) -> Outcome<Js> {
        if self.b[self.at..].starts_with(w) {
            self.at += w.len();
            Ok(v)
        } else {
            Err(self.bad("an unknown word"))
        }
    }

    fn value(&mut self, depth: usize) -> Outcome<Js> {
        if depth > MAX_DEPTH {
            return Err(self.bad("nested too deep"));
        }
        self.space();
        if self.at >= self.b.len() {
            return Err(self.bad("it ends where a value should be"));
        }
        match self.b[self.at] {
            b'n' => self.word(b"null", Js::Null),
            b't' => self.word(b"true", Js::Bool(true)),
            b'f' => self.word(b"false", Js::Bool(false)),
            b'"' => Ok(Js::Str(res!(self.string()))),
            b'[' => {
                self.at += 1;
                let mut v = Vec::new();
                self.space();
                if self.at < self.b.len() && self.b[self.at] == b']' {
                    self.at += 1;
                    return Ok(Js::Arr(v));
                }
                loop {
                    v.push(res!(self.value(depth + 1)));
                    self.space();
                    match self.b.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b']') => {
                            self.at += 1;
                            return Ok(Js::Arr(v));
                        },
                        _ => return Err(self.bad("a list without , or ]")),
                    }
                }
            },
            b'{' => {
                self.at += 1;
                let mut kv: Vec<(String, Js)> = Vec::new();
                self.space();
                if self.at < self.b.len() && self.b[self.at] == b'}' {
                    self.at += 1;
                    return Ok(Js::Obj(kv));
                }
                loop {
                    self.space();
                    if self.b.get(self.at) != Some(&b'"') {
                        return Err(self.bad("an object key that is not a string"));
                    }
                    let k = res!(self.string());
                    if kv.iter().any(|(have, _)| *have == k) {
                        return Err(self.bad("a repeated object key"));
                    }
                    self.space();
                    if self.b.get(self.at) != Some(&b':') {
                        return Err(self.bad("an object key without :"));
                    }
                    self.at += 1;
                    let v = res!(self.value(depth + 1));
                    kv.push((k, v));
                    self.space();
                    match self.b.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b'}') => {
                            self.at += 1;
                            return Ok(Js::Obj(kv));
                        },
                        _ => return Err(self.bad("an object without , or }")),
                    }
                }
            },
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(self.bad("an unexpected character")),
        }
    }

    fn digits(&mut self) -> usize {
        let from = self.at;
        while self.at < self.b.len() && self.b[self.at].is_ascii_digit() {
            self.at += 1;
        }
        self.at - from
    }

    fn number(&mut self) -> Outcome<Js> {
        let from = self.at;
        if self.b[self.at] == b'-' {
            self.at += 1;
        }
        let lead = self.b.get(self.at).copied();
        let n = self.digits();
        if n == 0 || (lead == Some(b'0') && n > 1) {
            return Err(self.bad("a malformed number"));
        }
        if self.b.get(self.at) == Some(&b'.') {
            self.at += 1;
            if self.digits() == 0 {
                return Err(self.bad("a number with no digits after its point"));
            }
        }
        if matches!(self.b.get(self.at), Some(b'e') | Some(b'E')) {
            self.at += 1;
            if matches!(self.b.get(self.at), Some(b'+') | Some(b'-')) {
                self.at += 1;
            }
            if self.digits() == 0 {
                return Err(self.bad("a number with no exponent digits"));
            }
        }
        // ASCII only, so the slice is whole characters.
        match std::str::from_utf8(&self.b[from..self.at]) {
            Ok(s) => Ok(Js::Num(s.to_string())),
            Err(_) => Err(self.bad("a number that is not text")),
        }
    }

    fn hex4(&mut self) -> Outcome<u32> {
        if self.at + 4 > self.b.len() {
            return Err(self.bad("a short \\u escape"));
        }
        let mut n = 0u32;
        for i in 0..4 {
            let c = self.b[self.at + i];
            let d = match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                b'A'..=b'F' => c - b'A' + 10,
                _ => return Err(self.bad("a \\u escape that is not hex")),
            };
            n = (n << 4) | d as u32;
        }
        self.at += 4;
        Ok(n)
    }

    fn string(&mut self) -> Outcome<String> {
        self.at += 1; // the opening quote
        let mut out: Vec<u8> = Vec::new();
        loop {
            let c = match self.b.get(self.at) {
                Some(c) => *c,
                None => return Err(self.bad("a string with no closing quote")),
            };
            self.at += 1;
            match c {
                b'"' => break,
                b'\\' => {
                    let e = match self.b.get(self.at) {
                        Some(e) => *e,
                        None => return Err(self.bad("a string ending in \\")),
                    };
                    self.at += 1;
                    let ch: char = match e {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let hi = res!(self.hex4());
                            let cp = if (0xD800..0xDC00).contains(&hi) {
                                if !self.b[self.at..].starts_with(b"\\u") {
                                    return Err(self.bad("a lone high surrogate"));
                                }
                                self.at += 2;
                                let lo = res!(self.hex4());
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return Err(self.bad("a high surrogate without its low half"));
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else if (0xDC00..0xE000).contains(&hi) {
                                return Err(self.bad("a lone low surrogate"));
                            } else {
                                hi
                            };
                            match char::from_u32(cp) {
                                Some(ch) => ch,
                                None => return Err(self.bad("a \\u escape that is no character")),
                            }
                        },
                        _ => return Err(self.bad("an unknown escape")),
                    };
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                },
                c if c < 0x20 => return Err(self.bad("a raw control character in a string")),
                c => out.push(c),
            }
        }
        match String::from_utf8(out) {
            Ok(s) => Ok(s),
            Err(_) => Err(self.bad("a string that is not UTF-8")),
        }
    }
}
