//! A turn's own record, as it ran (RUNNER-TURN RT-A, 2026-10-25).
//!
//! Whoever drives the engine folds its [`AgentEvent`]s into a [`TurnLog`]: the think runs, each
//! tool call with its result, the folds, vision, leak and error lines, the ending and the turn's
//! token figures.  A runner sends it home with its answer, so a turn settled elsewhere shows what
//! a turn run here shows (`notes/daimond_runner_20261016/runnerturn_design.md` §1.3).  The rows
//! keep the page's own role words and keys; the row ids, the run and the `prod` are the settling
//! side's to stamp, since only it knows them.
//!
//! **Prose before a tool call is the model's working, not its answer**, as the page's `logThinking`
//! takes it: it joins the think run.  The prose after the last call is the answer, which the
//! driver already holds, so it is never a row here.

use crate::protocol::AgentEvent;
use crate::llm::json_escape;

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_jdat::prelude::*;

/// The most bytes of one tool row's output or argument string a turn over its whole ceiling keeps
/// (D2): the page's `PROGRESS_MSG_CHARS`.
pub const TURN_TOOL_MAX: usize = 16 * 1024;
/// The least a cut row keeps, however large the turn.
const TURN_CUT_FLOOR: usize = 256;

/// One row of a turn, in transcript order.
#[derive(Clone, Debug, PartialEq)]
pub enum LogRow {
    Think   { content: String, ts: u64 },
    Tool    { name: String, args: String, call_id: String, content: String, outcome: String,
              paused: String, ts: u64 },
    Fold    { note: String, folded: u64, kept: u64, structured: bool, model: String, sp: String,
              cut: u64, summarised: bool, ts: u64 },
    Vision  { images: u64, model: String, source: String, ts: u64 },
    Leak    { fragment: String, ts: u64 },
    Error   { content: String, ts: u64 },
    Steer   { content: String, ts: u64 },
}

impl LogRow {

    /// The page's role word for the row.
    pub fn role(&self) -> &'static str {
        match self {
            Self::Think { .. }  => "think_log",
            Self::Tool { .. }   => "tool_log",
            Self::Fold { .. }   => "fold_log",
            Self::Vision { .. } => "vision_log",
            Self::Leak { .. }   => "leak_log",
            Self::Error { .. }  => "error_log",
            Self::Steer { .. }  => "user",
        }
    }

    fn json(&self) -> String {
        let s = |k: &str, v: &str| fmt!(",\"{}\":\"{}\"", k, json_escape(v));
        let n = |k: &str, v: u64| fmt!(",\"{}\":{}", k, v);
        let b = |k: &str, v: bool| fmt!(",\"{}\":{}", k, v);
        let mut o = fmt!("{{\"role\":\"{}\"", self.role());
        match self {
            Self::Think { content, ts } | Self::Error { content, ts } | Self::Steer { content, ts } => {
                o.push_str(&s("content", content));
                o.push_str(&n("ts", *ts));
            },
            Self::Tool { name, args, call_id, content, outcome, paused, ts } => {
                o.push_str(&s("name", name));
                o.push_str(&s("args", args));
                o.push_str(&s("callId", call_id));
                o.push_str(&s("content", content));
                o.push_str(&s("outcome", outcome));
                if !paused.is_empty() {
                    o.push_str(&s("paused", paused));
                }
                o.push_str(&n("ts", *ts));
            },
            Self::Fold { note, folded, kept, structured, model, sp, cut, summarised, ts } => {
                o.push_str(&s("content", note));
                o.push_str(&n("folded", *folded));
                o.push_str(&n("kept", *kept));
                o.push_str(&b("structured", *structured));
                o.push_str(&s("model", model));
                o.push_str(&s("sp", sp));
                o.push_str(&n("cut", *cut));
                o.push_str(&b("summarised", *summarised));
                o.push_str(&n("ts", *ts));
            },
            Self::Vision { images, model, source, ts } => {
                o.push_str(&n("images", *images));
                o.push_str(&s("model", model));
                o.push_str(&s("source", source));
                o.push_str(&n("ts", *ts));
            },
            Self::Leak { fragment, ts } => {
                o.push_str(&s("content", fragment));
                o.push_str(&n("ts", *ts));
            },
        }
        o.push('}');
        o
    }

    fn of_dat(d: &Dat) -> Outcome<Self> {
        let text = |k: &str| match d.map_get(&dat!(k)) {
            Ok(Some(Dat::Str(s)))   => s.clone(),
            _                       => String::new(),
        };
        let num = |k: &str| match d.map_get(&dat!(k)) {
            Ok(Some(v)) => v.get_u64().unwrap_or(0),
            _           => 0,
        };
        let flag = |k: &str| matches!(d.map_get(&dat!(k)), Ok(Some(Dat::Bool(true))));
        let ts = num("ts");
        Ok(match text("role").as_str() {
            "think_log"     => Self::Think { content: text("content"), ts },
            "error_log"     => Self::Error { content: text("content"), ts },
            "user"          => Self::Steer { content: text("content"), ts },
            "leak_log"      => Self::Leak { fragment: text("content"), ts },
            "tool_log"      => Self::Tool { name: text("name"), args: text("args"), call_id: text("callId"),
                content: text("content"), outcome: text("outcome"), paused: text("paused"), ts },
            "fold_log"      => Self::Fold { note: text("content"), folded: num("folded"), kept: num("kept"),
                structured: flag("structured"), model: text("model"), sp: text("sp"), cut: num("cut"),
                summarised: flag("summarised"), ts },
            "vision_log"    => Self::Vision { images: num("images"), model: text("model"),
                source: text("source"), ts },
            r               => return Err(err!("A turn log row has no role {:?}.", r; Decode, Invalid)),
        })
    }
}

/// How the turn ended, the engine's own [`AgentEvent::Ended`].
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TurnEnding {
    pub how:        String,
    pub offered:    u64,
    pub rounds:     u64,
    pub calls:      u64,
    pub refused:    u64,
    pub failed:     u64,
    pub missing:    Vec<String>,
    pub malformed:  u64,
    pub reasoned:   u64,
    pub why:        String,
    pub said:       String,
    pub fault:      String,     // A failed turn's class (`llm::failure_class`), else empty
    pub touched:    Vec<String>,
}

/// The turn's own token figures: the session's counters after it less those before it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TurnUsage {
    pub prompt:     u64,    // Prompt tokens, every round
    pub completion: u64,    // Completion tokens, every round
    pub cached:     u64,    // Of the prompt tokens, those served from cache
    pub last:       u64,    // The last round's prompt tokens: the context, never a sum
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TurnLog {
    pub rows:   Vec<LogRow>,
    pub ending: Option<TurnEnding>,
    pub usage:  TurnUsage,
    prose:      String,     // This round's prose so far: working if a call follows, else the answer
}

impl TurnLog {

    pub fn new() -> Self { Self::default() }

    /// Does the log hold nothing to send?
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty() && self.ending.is_none() && self.usage == TurnUsage::default()
    }

    /// Folds event `ev`, which happened at `ts` (ms since the epoch), into the log.
    pub fn fold(&mut self, ev: &AgentEvent, ts: u64) {
        match ev {
            AgentEvent::Text(t)         => self.prose.push_str(t),
            AgentEvent::Thinking(t)     => self.think(t, ts),
            AgentEvent::ToolCall { id, name, args } => {
                let prose = std::mem::take(&mut self.prose);
                self.think(&prose, ts);
                self.rows.push(LogRow::Tool { name: name.clone(), args: args.clone(), call_id: id.clone(),
                    content: String::new(), outcome: String::new(), paused: String::new(), ts });
            },
            AgentEvent::ToolResult { result, outcome, paused, .. } => {
                // The result answers the newest call still open.
                let open = self.rows.iter_mut().rev().find_map(|r| match r {
                    LogRow::Tool { content, outcome: o, paused: p, .. } if o.is_empty() => Some((content, o, p)),
                    _ => None,
                });
                if let Some((content, o, p)) = open {
                    *content = result.clone();
                    *o = outcome.wire().to_string();
                    *p = paused.clone();
                }
            },
            AgentEvent::Compacted { folded, kept, note, structured, model, sp, cut, summarised } => {
                self.rows.push(LogRow::Fold { note: note.clone(), folded: *folded as u64, kept: *kept as u64,
                    structured: *structured, model: model.clone(), sp: sp.clone(), cut: *cut as u64,
                    summarised: *summarised, ts });
            },
            AgentEvent::Unseeable { images, model, source } => {
                self.rows.push(LogRow::Vision { images: *images as u64, model: model.clone(),
                    source: source.clone(), ts });
            },
            // A leak the engine rebuilt and ran is a tool call; one it could not is no answer, and
            // its prose goes with it, as the page drops the live tile.
            AgentEvent::Leaked { fragment, recovered } => if !*recovered {
                self.prose.clear();
                self.rows.push(LogRow::Leak { fragment: fragment.clone(), ts });
            },
            AgentEvent::Error(e)        => self.rows.push(LogRow::Error { content: e.clone(), ts }),
            AgentEvent::Interjected(s)  => self.rows.push(LogRow::Steer { content: s.clone(), ts }),
            AgentEvent::Ended { how, offered, rounds, calls, refused, failed, missing, malformed, reasoned,
                why, said, fault, touched } =>
            {
                self.ending = Some(TurnEnding { how: how.clone(), offered: *offered as u64,
                    rounds: *rounds as u64, calls: *calls as u64, refused: *refused as u64,
                    failed: *failed as u64, missing: missing.clone(), malformed: *malformed as u64,
                    reasoned: *reasoned as u64, why: why.clone(), said: said.clone(), fault: fault.clone(),
                    touched: touched.clone() });
            },
            _ => (),
        }
    }

    /// Joins `text` to the think run the log ends on, or opens one, as `logThinking` does.
    fn think(&mut self, text: &str, ts: u64) {
        if text.is_empty() {
            return;
        }
        if let Some(LogRow::Think { content, .. }) = self.rows.last_mut() {
            content.push_str(text);
            return;
        }
        self.rows.push(LogRow::Think { content: text.to_string(), ts });
    }

    /// The turn's figures, from session counters `before` and `after`, each `(prompt, completion,
    /// cached, last_prompt)`.
    pub fn measure(&mut self, before: (u64, u64, u64, u64), after: (u64, u64, u64, u64)) {
        self.usage = TurnUsage {
            prompt:     after.0.saturating_sub(before.0),
            completion: after.1.saturating_sub(before.1),
            cached:     after.2.saturating_sub(before.2),
            last:       match after.0 > before.0 { true => after.3, false => 0 },
        };
    }

    /// The log as JSON: `{"rows":[…],"end":{…},"usage":{"p","c","ca","last"}}`, the rows in the
    /// page's keys.
    pub fn json(&self) -> String {
        let mut o = String::from("{\"rows\":[");
        for (i, r) in self.rows.iter().enumerate() {
            if i > 0 {
                o.push(',');
            }
            o.push_str(&r.json());
        }
        o.push(']');
        if let Some(e) = &self.ending {
            let list = |l: &[String]| l.iter().map(|p| fmt!("\"{}\"", json_escape(p))).collect::<Vec<_>>().join(",");
            // `fault` only when set, as the `Ended` event carries it.
            let fault = match e.fault.is_empty() {
                true    => String::new(),
                false   => fmt!(",\"fault\":\"{}\"", json_escape(&e.fault)),
            };
            o.push_str(&fmt!(",\"end\":{{\"how\":\"{}\",\"offered\":{},\"rounds\":{},\"calls\":{},\"refused\":{},\
                \"failed\":{},\"missing\":[{}],\"malformed\":{},\"reasoned\":{},\"why\":\"{}\",\"said\":\"{}\"{},\
                \"touched\":[{}]}}",
                json_escape(&e.how), e.offered, e.rounds, e.calls, e.refused, e.failed, list(&e.missing),
                e.malformed, e.reasoned, json_escape(&e.why), json_escape(&e.said), fault, list(&e.touched)));
        }
        let u = &self.usage;
        o.push_str(&fmt!(",\"usage\":{{\"p\":{},\"c\":{},\"ca\":{},\"last\":{}}}}}", u.prompt, u.completion, u.cached, u.last));
        o
    }

    /// The log [`Self::json`] wrote.
    pub fn of_json(json: &str) -> Outcome<Self> {
        let cfg: oxedyne_fe2o3_jdat::string::dec::DecoderConfig<
            std::collections::BTreeMap<oxedyne_fe2o3_jdat::usr::UsrKindCode, oxedyne_fe2o3_jdat::usr::UsrKind>,
            std::collections::BTreeMap<String, oxedyne_fe2o3_jdat::usr::UsrKindId>,
        > = oxedyne_fe2o3_jdat::string::dec::DecoderConfig::json(None);
        let d = res!(Dat::decode_string_with_config(json, &cfg));
        let mut log = Self::new();
        if let Ok(Some(Dat::List(rows))) = d.map_get(&dat!("rows")) {
            for r in rows {
                log.rows.push(res!(LogRow::of_dat(r)));
            }
        }
        let num = |m: &Dat, k: &str| match m.map_get(&dat!(k)) {
            Ok(Some(v)) => v.get_u64().unwrap_or(0),
            _           => 0,
        };
        if let Ok(Some(e)) = d.map_get(&dat!("end")) {
            let text = |k: &str| match e.map_get(&dat!(k)) {
                Ok(Some(Dat::Str(s)))   => s.clone(),
                _                       => String::new(),
            };
            let list = |k: &str| match e.map_get(&dat!(k)) {
                Ok(Some(Dat::List(l)))  => l.iter().filter_map(|v| match v {
                    Dat::Str(s) => Some(s.clone()),
                    _           => None,
                }).collect(),
                _                       => Vec::new(),
            };
            log.ending = Some(TurnEnding { how: text("how"), offered: num(e, "offered"), rounds: num(e, "rounds"),
                calls: num(e, "calls"), refused: num(e, "refused"), failed: num(e, "failed"), missing: list("missing"),
                malformed: num(e, "malformed"), reasoned: num(e, "reasoned"), why: text("why"), said: text("said"),
                fault: text("fault"), touched: list("touched") });
        }
        if let Ok(Some(u)) = d.map_get(&dat!("usage")) {
            log.usage = TurnUsage { prompt: num(u, "p"), completion: num(u, "c"), cached: num(u, "ca"),
                last: num(u, "last") };
        }
        Ok(log)
    }

    /// The log cut to fit `max` bytes of [`Self::json`] (D2), or as it is where it fits.  Tool rows
    /// are cut first, each output and argument string past [`TURN_TOOL_MAX`], then think rows the
    /// same, each cut visibly marked; while still over, the cap halves, down to a floor.  Arguments
    /// are cut only inside their strings, so they stay the JSON they were.
    pub fn bounded(mut self, max: usize) -> Self {
        if self.json().len() <= max {
            return self;
        }
        // Each pass cuts from the rows as they ran, so a mark always names every byte that went.
        let ran = self.rows.clone();
        let mut cap = TURN_TOOL_MAX;
        loop {
            self.rows = ran.iter().map(|r| match r {
                LogRow::Tool { name, args, call_id, content, outcome, paused, ts } => LogRow::Tool {
                    name: name.clone(), args: cut_json_strings(args, cap), call_id: call_id.clone(),
                    content: cut_text(content, cap), outcome: outcome.clone(), paused: paused.clone(), ts: *ts },
                other => other.clone(),
            }).collect();
            if self.json().len() <= max {
                return self;
            }
            for r in self.rows.iter_mut() {
                if let LogRow::Think { content, .. } = r {
                    *content = cut_text(content, cap);
                }
            }
            if self.json().len() <= max || cap <= TURN_CUT_FLOOR {
                return self;
            }
            cap = (cap / 2).max(TURN_CUT_FLOOR);
        }
    }
}

/// The mark a cut leaves, naming what went.
pub fn cut_mark(gone: usize) -> String {
    fmt!("[… {} bytes not kept: output cut at {} KiB]", gone, TURN_TOOL_MAX / 1024)
}

/// `s` kept to its first `cap` bytes at a character boundary, the rest marked.
fn cut_text(s: &str, cap: usize) -> String {
    if s.len() <= cap {
        return s.to_string();
    }
    let mut at = cap;
    while !s.is_char_boundary(at) {
        at -= 1;
    }
    fmt!("{}\n{}", &s[..at], cut_mark(s.len() - at))
}

/// JSON text `j` with every string literal over `cap` bytes cut inside its quotes, never inside an
/// escape, the rest marked; everything outside the strings untouched, so valid JSON stays valid.
fn cut_json_strings(j: &str, cap: usize) -> String {
    if j.len() <= cap {
        return j.to_string();
    }
    let b = j.as_bytes();
    let mut out = String::with_capacity(j.len().min(cap * 4));
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'"' {
            let next = j[i..].find('"').map_or(b.len(), |k| i + k);
            out.push_str(&j[i..next]);
            i = next;
            continue;
        }
        // A string literal from its opening quote: find its closing one.
        let start = i + 1;
        let mut k = start;
        while k < b.len() && b[k] != b'"' {
            k += if b[k] == b'\\' { 2 } else { 1 };
        }
        let end = k.min(b.len());
        let body = &j[start..end];
        out.push('"');
        if body.len() > cap {
            let mut at = cap;
            // Never inside an escape: back off to a boundary that is not mid-escape.
            while at > 0 && (!body.is_char_boundary(at) || escape_open(&body.as_bytes()[..at])) {
                at -= 1;
            }
            out.push_str(&body[..at]);
            out.push_str(&json_escape(&fmt!("\n{}", cut_mark(body.len() - at))));
        } else {
            out.push_str(body);
        }
        if end < b.len() {
            out.push('"');
        }
        i = end + 1;
    }
    out
}

/// Does `b` end part-way through an escape (a trailing odd run of backslashes, or a `\u` short of
/// its four digits)?
fn escape_open(b: &[u8]) -> bool {
    let tail = b.iter().rev().take_while(|c| **c == b'\\').count();
    if tail % 2 == 1 {
        return true;
    }
    // `\uXXXX` cut within its six bytes.
    let n = b.len();
    for back in 1..=5 {
        if n > back && b[n - back] == b'u' {
            let slashes = b[..n - back].iter().rev().take_while(|c| **c == b'\\').count();
            if slashes % 2 == 1 {
                return true;
            }
        }
    }
    false
}

// ── The page's own judgements on a row's words (RUNNER-TURN RT-B) ─────────
//
// A turn run on the page stores an error line through `friendlyError`, a vision line through
// `blindLine`, and stores no error line at all for a dead road (`offline`): the settling side
// applies the same rules.  Where the page words a line itself, the runner sends its i18n key
// and parameters, never the English, so a page in any language draws the row in its own
// (lead ruling, 2026-10-25).  The keys are `www/i18n/en.js`'s.

/// A row's words as the page would say them.
#[derive(Clone, Debug, PartialEq)]
pub enum Said {
    Key(&'static str, Vec<(&'static str, String)>), // the page's `t(k, v)`
    Text(String),                                   // the engine's own words, cleaned, shown as they are
}

/// The page's `blindLine`: what a vision row says of the `model` that would not look.
pub fn blind_line(model: &str, source: &str) -> Said {
    let k = match source {
        "provider"  => "agent.model_blind_provider",
        "table"     => "agent.model_blind_table",
        "refusal"   => "agent.model_blind_refusal",
        _           => "agent.model_blind",
    };
    Said::Key(k, vec![("model", model.to_string())])
}

/// Is `raw` a road that went, the page's `offline` (`CLIENT_ROAD`, `BROWSER_ROAD`)?  The page
/// keeps no error row for one.
pub fn is_offline(raw: &str) -> bool {
    let s = strip_frames(&strip_ansi(raw)).to_lowercase();
    const ROADS: &[&str] = &["daimond-road", "could not reach", "could not send the request",
        "closed before replying", "the reply was cut short", "the reply carried no stream", "the stream broke",
        "tls handshake with", "read stream chunk failed", "failed to fetch", "load failed",
        "the network connection was lost", "err_connection", "enotfound", "econnrefused",
        "connection refused", "dns"];
    if ROADS.iter().any(|r| s.contains(r)) {
        return true;
    }
    // `network\s*error`.
    let mut at = 0;
    while let Some(i) = s[at..].find("network") {
        let rest = s[at + i + 7..].trim_start();
        if rest.starts_with("error") {
            return true;
        }
        at += i + 7;
    }
    false
}

/// The page's `friendlyError`: the sentence an error row shows for engine text `raw`.
pub fn friendly_error(raw: &str) -> Said {
    let s = strip_frames(&strip_ansi(raw));
    if is_offline(&s) {
        // The host goes with it, so the page's road label still says where.
        return Said::Key("err.unreachable", match road_host(&s) {
            Some(h) => vec![("host", h)],
            None    => Vec::new(),
        });
    }
    let k = match http_status(&s) {
        401         => Some("err.rejected_401"),
        403         => Some("err.denied_403"),
        404         => Some("err.notfound_404"),
        429         => Some("err.ratelimit_429"),
        500..=599   => Some("err.server_5xx"),
        _           => None,
    };
    if let Some(k) = k {
        return Said::Key(k, Vec::new());
    }
    let mut t = s.trim_start().to_string();
    // `get`, not a slice: a leading character wider than a byte would split at 6.
    if t.get(..6).map_or(false, |h| h.eq_ignore_ascii_case("error:")) {
        t = t[6..].trim_start().to_string();
    }
    let t = blank_framing(&t);
    // Whitespace collapsed, none before punctuation, trailing punctuation gone.
    let mut c = String::with_capacity(t.len());
    for w in t.split_whitespace() {
        let glue = w.starts_with(['.', ',', ';', ':']);
        if !c.is_empty() && !glue {
            c.push(' ');
        }
        c.push_str(w);
    }
    let c = c.trim_end_matches([' ', '.', ':', ';', ',', '-']).to_string();
    if c.is_empty() {
        return Said::Key("err.generic", Vec::new());
    }
    // A leading tool name stays as it is spelt.
    let head: String = c.chars().take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_').collect();
    let snake = head.starts_with(|ch: char| ch.is_ascii_lowercase()) && head.contains('_')
        && !head.ends_with('_') && !head.contains("__");
    match snake {
        true    => Said::Text(fmt!("{}.", c)),
        false   => {
            let mut ch = c.chars();
            match ch.next() {
                Some(f) => Said::Text(fmt!("{}{}.", f.to_uppercase(), ch.as_str())),
                None    => Said::Key("err.generic", Vec::new()),
            }
        },
    }
}

/// The host a dead road's text `s` names: a URL's, else the word after "could not reach",
/// "handshake with" or "connect to", its port and closing punctuation dropped.  `None` where no
/// word there looks like a host (a dotted name, an address or `localhost`).
fn road_host(s: &str) -> Option<String> {
    let low = s.to_ascii_lowercase(); // the same byte offsets as `s`
    let start = match low.find("://") {
        Some(i) => Some(i + 3),
        None    => ["could not reach ", "handshake with ", "connect to "].iter()
            .find_map(|lead| low.find(lead).map(|i| i + lead.len())),
    };
    let rest = match start {
        Some(i) => s[i..].trim_start(),
        None    => return None,
    };
    let word: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).collect();
    let host = word.trim_end_matches(['.', '-', '_']).to_ascii_lowercase();
    match host.contains('.') || host == "localhost" {
        true    => Some(host),
        false   => None,
    }
}

/// `stripAnsi`: OSC and CSI sequences dropped.
fn strip_ansi(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut it = raw.chars().peekable();
    while let Some(c) = it.next() {
        match (c, it.peek().copied()) {
            ('\x1b', Some(']')) => {
                it.next();
                while let Some(b) = it.next() {
                    if b == '\x07' { break; }
                    if b == '\x1b' && it.peek() == Some(&'\\') { it.next(); break; }
                }
            },
            ('\x1b', Some('[')) | ('\u{9b}', _) => {
                if c == '\x1b' { it.next(); }
                for b in it.by_ref() {
                    if ('@'..='~').contains(&b) { break; }
                }
            },
            _ => out.push(c),
        }
    }
    out
}

/// The fe2o3 source frames (`src/x.rs:12:`) blanked.
fn strip_frames(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("src/") {
        out.push_str(&rest[..i]);
        let tail = &rest[i + 4..];
        let path_end = tail.find(|c: char| c.is_whitespace() || c == '"' || c == ':').unwrap_or(tail.len());
        let path = &tail[..path_end];
        let after = &tail[path_end..];
        let digits = after.strip_prefix(':').map(|a| a.chars().take_while(|c| c.is_ascii_digit()).count());
        match (path.ends_with(".rs") && path.len() > 3, digits) {
            (true, Some(n)) if n > 0 => {
                out.push(' ');
                let mut r = &after[1 + n..];
                if let Some(x) = r.strip_prefix(':') { r = x; }
                rest = r;
            },
            _ => {
                out.push_str("src/");
                rest = tail;
            },
        }
    }
    out.push_str(rest);
    out
}

/// `httpStatus`: the status `s` reports, or 0.
fn http_status(s: &str) -> u32 {
    let low = s.to_lowercase();
    let b = low.as_bytes();
    let word_at = |i: usize, n: usize| (i == 0 || !b[i - 1].is_ascii_alphanumeric())
        && b.get(i + n).map_or(true, |c| !c.is_ascii_alphanumeric());
    let three = |i: usize| -> Option<u32> {
        let d = b.get(i..i + 3)?;
        match d.iter().all(|c| c.is_ascii_digit()) && word_at(i, 3) {
            true    => low[i..i + 3].parse().ok(),
            false   => None,
        }
    };
    let mut named = false;
    for w in ["http", "status"] {
        let mut at = 0;
        while let Some(i) = low[at..].find(w) {
            let i = at + i;
            at = i + w.len();
            if !word_at(i, w.len()) {
                continue;
            }
            named = true;
            let mut j = at;
            let skip_ws = |j: &mut usize| while b.get(*j).map_or(false, |c| c.is_ascii_whitespace()) { *j += 1; };
            let save = j;
            skip_ws(&mut j);
            if low[j..].starts_with("error") { j += 5; } else { j = save; }
            skip_ws(&mut j);
            if b.get(j) == Some(&b':') { j += 1; }
            skip_ws(&mut j);
            if let Some(n) = three(j) {
                return n;
            }
        }
    }
    if named {
        for i in 0..b.len() {
            if matches!(b[i], b'4' | b'5') {
                if let Some(n) = three(i) {
                    return n;
                }
            }
        }
    }
    0
}

/// The rest of `friendlyError`'s framing blanked: `FooErr{`, `JsValue(`, `[Kind Words]`, a bare
/// `undefined`, and `"`, `{`, `}`.
fn blank_framing(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let cs: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        // `[A-Z][A-Za-z]*( [A-Z][A-Za-z]*)*]`
        if c == '[' && cs.get(i + 1).map_or(false, |x| x.is_ascii_uppercase()) {
            let mut j = i + 1;
            let mut ok = false;
            while j < cs.len() {
                if cs[j] == ']' { ok = true; break; }
                let word_start = cs[j - 1] == '[' || cs[j - 1] == ' ';
                let fine = cs[j].is_ascii_alphabetic() && (!word_start || cs[j].is_ascii_uppercase())
                    || (cs[j] == ' ' && cs.get(j + 1).map_or(false, |x| x.is_ascii_uppercase()));
                if !fine { break; }
                j += 1;
            }
            if ok {
                out.push(' ');
                i = j + 1;
                continue;
            }
        }
        if c.is_ascii_alphabetic() && (i == 0 || !cs[i - 1].is_ascii_alphanumeric()) {
            let mut j = i;
            while j < cs.len() && cs[j].is_ascii_alphanumeric() { j += 1; }
            let w: String = cs[i..j].iter().collect();
            if w == "undefined" {
                out.push(' ');
                i = j;
                continue;
            }
            if w == "JsValue" && cs.get(j) == Some(&'(') {
                out.push(' ');
                i = j + 1;
                continue;
            }
            // `[A-Za-z]+Err{` (the regex has no lead boundary, but a longer word ends the same).
            let alpha_end = cs[i..j].iter().position(|x| !x.is_ascii_alphabetic()).map_or(j, |p| i + p);
            if alpha_end == j && w.len() > 3 && w.ends_with("Err") && cs.get(j) == Some(&'{') {
                out.push(' ');
                i = j + 1;
                continue;
            }
            out.push_str(&w);
            i = j;
            continue;
        }
        out.push(if matches!(c, '"' | '{' | '}') { ' ' } else { c });
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(k: &'static str) -> Said { Said::Key(k, Vec::new()) }

    /// Each status the page words is its i18n key, never its English.
    #[test]
    fn a_status_is_its_key() {
        assert_eq!(friendly_error("the provider returned HTTP 401"),          key("err.rejected_401"));
        assert_eq!(friendly_error("status: 403 forbidden"),                   key("err.denied_403"));
        assert_eq!(friendly_error("HTTP error 404 from upstream"),            key("err.notfound_404"));
        assert_eq!(friendly_error("http 429 too many"),                       key("err.ratelimit_429"));
        assert_eq!(friendly_error("[IO Network] HTTP 503 Service Unavailable"), key("err.server_5xx"));
        assert_eq!(friendly_error("  Error: ...  "),                          key("err.generic"));
        assert_eq!(friendly_error(""),                                        key("err.generic"));
    }

    /// A line number in a source frame is not a status, and a bare number is not one either.
    #[test]
    fn a_frame_or_bare_number_is_no_status() {
        assert_eq!(http_status("failed at src/llm.rs:507: bad"), 0);
        assert_eq!(http_status("got 503 things"), 0);
        assert_eq!(http_status("HTTP/1.1 then 502"), 502);
        assert_eq!(http_status("status=500x"), 0);
        assert_eq!(friendly_error("oops at src/llm.rs:507: model said no"),
            Said::Text(String::from("Oops at model said no.")));
    }

    /// Engine text the page shows as it is: framing blanked, a tool's name kept as spelt.
    #[test]
    fn engine_text_is_cleaned_not_worded() {
        assert_eq!(friendly_error("Error: FileErr{ \"x\" missing } [IO Missing]"),
            Said::Text(String::from("X missing.")));
        assert_eq!(friendly_error("file_edit: old_string not found"),
            Said::Text(String::from("file_edit: old_string not found.")));
        assert_eq!(friendly_error("JsValue(undefined) went wrong ,"),
            Said::Text(String::from(") went wrong.")));
        assert_eq!(friendly_error("\x1b[31mbad\x1b[0m thing"), Said::Text(String::from("Bad thing.")));
        assert_eq!(friendly_error("éé€ wide"), Said::Text(String::from("Éé€ wide.")));
        assert_eq!(blank_framing("[Kind Words] a [not this] FooErr{b} undefinedx"), "  a [not this]  b  undefinedx");
    }

    /// A road that went is no row at all, `network error` with any spacing.
    #[test]
    fn a_dead_road_is_offline() {
        assert!(is_offline("Network   Error while sending"));
        assert!(is_offline("ECONNREFUSED 127.0.0.1"));
        assert!(!is_offline("the network is fine"));
    }

    /// A dead road is `err.unreachable` with the host it would not reach, as `v.host`, for the
    /// page's road label; with no host to be read, no parameter.
    #[test]
    fn a_road_names_its_host() {
        let road = |h: &str| Said::Key("err.unreachable", vec![("host", String::from(h))]);
        assert_eq!(friendly_error("could not reach api.example.com"),                   road("api.example.com"));
        assert_eq!(friendly_error("UpstreamErr could not reach openrouter.ai:443."),   road("openrouter.ai"));
        assert_eq!(friendly_error("TLS handshake with openrouter.ai failed"),           road("openrouter.ai"));
        assert_eq!(friendly_error("Failed to fetch https://openrouter.ai/api/v1/chat"), road("openrouter.ai"));
        assert_eq!(friendly_error("could not reach 127.0.0.1:1"),                       road("127.0.0.1"));
        assert_eq!(friendly_error("connection refused"),                                key("err.unreachable"));
    }

    /// The vision line is the page's key for its source, with the model its one parameter.
    #[test]
    fn a_blind_line_is_its_key() {
        let m = |k| Said::Key(k, vec![("model", String::from("m-1"))]);
        assert_eq!(blind_line("m-1", "provider"),   m("agent.model_blind_provider"));
        assert_eq!(blind_line("m-1", "table"),      m("agent.model_blind_table"));
        assert_eq!(blind_line("m-1", "refusal"),    m("agent.model_blind_refusal"));
        assert_eq!(blind_line("m-1", ""),           m("agent.model_blind"));
    }

    /// A failed turn's `fault` rides the ending as the `Ended` event carries it, and back; an
    /// ending with none writes no key.
    #[test]
    fn a_failed_turns_fault_rides_the_ending() {
        let mut log = TurnLog::new();
        log.ending = Some(TurnEnding { how: String::from("failed"), fault: String::from("limit"),
            ..TurnEnding::default() });
        let back = match TurnLog::of_json(&log.json()) {
            Ok(l)   => l,
            Err(e)  => panic!("the log reads back: {}", e),
        };
        assert!(log.json().contains("\"fault\":\"limit\""));
        assert_eq!(back.ending.map(|e| e.fault), Some(String::from("limit")));
        log.ending = Some(TurnEnding { how: String::from("answered"), ..TurnEnding::default() });
        assert!(!log.json().contains("fault"));
    }
}
