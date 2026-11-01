//! What a chat has been shown, and whether an address or query it reaches for carries data out
//! (RUNNER-WEB D1, judged by provenance; UNBLOCK-88).
//!
//! One home for every surface: Kimberlite's run port and the tab's net port both answer the
//! tainted reading gate from here, so a search or a fetch after outside content runs with nobody
//! asked on either, and only an address or query of the payload's shape that no result or page
//! showed the chat is refused ([`heavy_refusal`]).  Moved from kimberlite/src/run_net.rs.

use super::*;

use crate::protocol::ChatMessage;

use std::collections::{
    BTreeMap,
    BTreeSet,
    VecDeque,
};

/// The most addresses a chat remembers from its results and pages, oldest forgotten first.
pub const SEEN_MAX: usize = 4096;	// fixed: a memory bound, not a policy figure

/// The longest address remembered: a longer one is measured as if composed.
pub const SEEN_URL_MAX: usize = 4096;	// fixed: a memory bound, not a policy figure

/// Whether `s` holds a run of at least [`EGRESS_BLOB`] of `[A-Za-z0-9+/=_-]`.
pub fn blob(s: &str) -> bool {
    let mut run = 0usize;
    for c in s.chars() {
        match c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_' | '-') {
            true    => {
                run += 1;
                if run >= EGRESS_BLOB {
                    return true;
                }
            },
            false   => run = 0,
        }
    }
    false
}

/// An address's path, query and fragment: what follows its authority.
fn tail(url: &str) -> &str {
    let rest = match url.find("://") {
        Some(i) => &url[i + 3..],
        None    => url,
    };
    match rest.find(|c| c == '/' || c == '?' || c == '#') {
        Some(i) => &rest[i..],
        None    => "",
    }
}

/// `tail` as it goes on the wire, as the tab measures it (`new URL(..).pathname + search +
/// hash`): each character WHATWG percent-encodes in its part is counted as its `%XX` bytes
/// (C0 controls, space, DEL and every non-ASCII character in all three; `"`, `<`, `>` in all
/// three; `` ` ``, `{`, `}`, `^` in the path; `'` in the query; `` ` `` in the fragment), and a
/// special scheme's `\` is the `/` it becomes (RUNNER-WEB QA M1).
pub fn encoded_tail(url: &str) -> String {
    let t = tail(url);
    let (before_hash, frag) = match t.find('#') {
        Some(i) => (&t[..i], Some(&t[i..])),
        None    => (t, None),
    };
    let (path, query) = match before_hash.find('?') {
        Some(i) => (&before_hash[..i], Some(&before_hash[i..])),
        None    => (before_hash, None),
    };
    let mut out = String::with_capacity(t.len());
    let mut put = |part: &str, set: &[u8], slash: bool| {
        for c in part.chars() {
            if slash && c == '\\' {
                out.push('/');
                continue;
            }
            let mut b = [0u8; 4];
            let enc = (c as u32) < 0x21 || (c as u32) > 0x7e || (c.is_ascii() && set.contains(&(c as u8)));
            match enc {
                true    => for byte in c.encode_utf8(&mut b).bytes() {
                    out.push_str(&fmt!("%{:02X}", byte));
                },
                false   => out.push(c),
            }
        }
    };
    put(path, b"\"<>`{}^", true);
    if let Some(q) = query {
        put(q, b"\"<>'", false);
    }
    if let Some(f) = frag {
        put(f, b"\"<>`", false);
    }
    out
}

/// Does a search query carry more than a query needs?  Its UTF-8 bytes past
/// [`EGRESS_PAYLOAD_MAX`], or a [`blob`] (UNBLOCK-88).
pub fn heavy_query(q: &str) -> bool {
    q.len() > EGRESS_PAYLOAD_MAX || blob(q)
}

/// daimond.js `egressPayload(url).heavy`: the address carries more than an address needs,
/// measured on the wire ([`encoded_tail`]).
pub fn heavy(url: &str) -> bool {
    let t = encoded_tail(url);
    t.len() > EGRESS_PAYLOAD_MAX || blob(&t)
}

/// `url` as the browser would hold it for comparison: the scheme and the host lower-cased, and
/// nothing else touched, since a path or query difference is what a payload would change.
pub fn same_address(url: &str) -> String {
    let i = match url.find("://") {
        Some(i) => i,
        None    => return url.to_string(),
    };
    let rest = &url[i + 3..];
    let end = rest.find(|c| c == '/' || c == '?' || c == '#').unwrap_or(rest.len());
    let auth = &rest[..end];
    // Only the host is case-blind: any user part before an `@` is kept as written.
    let host_at = auth.rfind('@').map(|a| a + 1).unwrap_or(0);
    fmt!("{}://{}{}{}", url[..i].to_ascii_lowercase(), &auth[..host_at],
        auth[host_at..].to_ascii_lowercase(), &rest[end..])
}

/// The `http(s)://` addresses written out in `text`, each as it ends at a space or a quote and
/// again shorn of each trailing mark prose or markdown puts after a link (`).`, `],` ..).
pub fn addresses_in(text: &str) -> Vec<&str> {
    let low = text.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(k) = low[from..].find("http") {
        let at = from + k;
        from = at + 4;
        let rest = &low[at..];
        if !(rest.starts_with("http://") || rest.starts_with("https://")) {
            continue;
        }
        let len = text[at..].find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '`'))
            .unwrap_or(text.len() - at);
        let mut u = &text[at..at + len];
        loop {
            if u.len() > 8 {
                out.push(u);
            }
            match u.chars().last() {
                Some(c) if matches!(c, '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']' | '}' | '*') =>
                    u = &u[..u.len() - 1],
                _ => break,
            }
        }
    }
    out
}

/// The scheme of `r` if it opens with one (`[A-Za-z][A-Za-z0-9+.-]*:` before any `/`, `?` or `#`).
fn scheme_of(r: &str) -> Option<&str> {
    let end = match r.find(|c| c == ':' || c == '/' || c == '?' || c == '#') {
        Some(i) if r[i..].starts_with(':') => i,
        _ => return None,
    };
    let s = &r[..end];
    let mut cs = s.chars();
    match cs.next() {
        Some(c) if c.is_ascii_alphabetic() && cs.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')) => Some(s),
        _ => None,
    }
}

/// An absolute http(s) address cut into its origin (`https://host`) and its path, query and
/// fragment.
fn split_abs(url: &str) -> Option<(&str, &str)> {
    match scheme_of(url) {
        Some(s) if (s.eq_ignore_ascii_case("http") || s.eq_ignore_ascii_case("https"))
            && url[s.len()..].starts_with("://") => {
            let t = tail(url);
            Some((&url[..url.len() - t.len()], t))
        },
        _ => None,
    }
}

/// RFC 3986 §5.2.4 on an absolute path: each `.` dropped, each `..` taking the segment before.
fn remove_dots(p: &str) -> String {
    let segs: Vec<&str> = p.split('/').collect();
    let mut out: Vec<&str> = Vec::new();
    for (i, seg) in segs.iter().enumerate().skip(1) {
        let last = i + 1 == segs.len();
        match *seg {
            "."     => if last { out.push("") },
            ".."    => {
                out.pop();
                if last {
                    out.push("");
                }
            },
            _       => out.push(seg),
        }
    }
    fmt!("/{}", out.join("/"))
}

/// The link `r` as a browser resolves it against the absolute address `base` (RFC 3986 §5.2),
/// if it lands on http(s).  Tabs and newlines are dropped and `&amp;` read as `&`, as a page's
/// attribute is read; nothing else is folded.
pub fn resolve_link(base: &str, r: &str) -> Option<String> {
    let r: String = r.trim().chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let r = r.replace("&amp;", "&");
    if scheme_of(&r).is_some() {
        return split_abs(&r).map(|_| r.clone());
    }
    let (origin, t) = match split_abs(base) {
        Some(x) => x,
        None    => return None,
    };
    let t = t.split('#').next().unwrap_or("");
    let (bpath, bquery) = match t.find('?') {
        Some(i) => (&t[..i], &t[i..]),
        None    => (t, ""),
    };
    if let Some(rest) = r.strip_prefix("//") {
        let scheme = &origin[..origin.find(':').unwrap_or(0)];
        return split_abs(&fmt!("{}://{}", scheme, rest)).map(|_| fmt!("{}://{}", scheme, rest));
    }
    if r.is_empty() {
        return Some(fmt!("{}{}{}", origin, bpath, bquery));
    }
    if r.starts_with('#') {
        return Some(fmt!("{}{}{}{}", origin, bpath, bquery, r));
    }
    if r.starts_with('?') {
        return Some(fmt!("{}{}{}", origin, if bpath.is_empty() { "/" } else { bpath }, r));
    }
    let cut = r.find(|c| c == '?' || c == '#').unwrap_or(r.len());
    let (rpath, rrest) = (&r[..cut], &r[cut..]);
    let merged = match rpath.starts_with('/') {
        true    => rpath.to_string(),
        false   => {
            let dir = match bpath.rfind('/') {
                Some(i) => &bpath[..=i],
                None    => "/",
            };
            fmt!("{}{}", dir, rpath)
        },
    };
    Some(fmt!("{}{}{}", origin, remove_dots(&merged), rrest))
}

/// The values of each `href` attribute in `text`, quoted or bare.
fn hrefs(text: &str) -> Vec<&str> {
    let low = text.to_ascii_lowercase();
    let b = low.as_bytes();
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(k) = low[from..].find("href") {
        let at = from + k;
        from = at + 4;
        if at > 0 && !b[at - 1].is_ascii_whitespace() {
            continue;
        }
        let mut i = at + 4;
        while i < b.len() && b[i].is_ascii_whitespace() { i += 1; }
        if i >= b.len() || b[i] != b'=' {
            continue;
        }
        i += 1;
        while i < b.len() && b[i].is_ascii_whitespace() { i += 1; }
        let (start, end) = match b.get(i) {
            Some(&q) if q == b'"' || q == b'\'' => match low[i + 1..].find(q as char) {
                Some(n) => (i + 1, i + 1 + n),
                None    => continue,
            },
            Some(_) => (i, low[i..].find(|c: char| c.is_ascii_whitespace() || c == '>').map(|n| i + n).unwrap_or(low.len())),
            None    => continue,
        };
        out.push(&text[start..end]);
        from = end;
    }
    out
}

/// The targets of each markdown link `[..](target)` in `text`.
fn md_targets(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(k) = text[from..].find("](") {
        let start = from + k + 2;
        let end = text[start..].find(|c: char| c == ')' || c.is_whitespace()).map(|n| start + n).unwrap_or(text.len());
        out.push(text[start..end].trim_start_matches('<').trim_end_matches('>'));
        from = end;
    }
    out
}

/// The `href` of the page's first `<base>`, resolved against `page`, if it has one.
fn base_of(text: &str, page: &str) -> Option<String> {
    let low = text.to_ascii_lowercase();
    let at = match low.find("<base") {
        Some(i) if low[i + 5..].starts_with(|c: char| c.is_ascii_whitespace() || c == '>') => i,
        _ => return None,
    };
    let end = low[at..].find('>').map(|n| at + n).unwrap_or(low.len());
    match hrefs(&text[at..end]).first() {
        Some(h) => resolve_link(page, h),
        None    => None,
    }
}

/// Every http(s) address the page at `page` shows in `text`: those written out whole, and each
/// link (`href`, markdown) resolved against its `<base>`, else `page`; each also in its wire
/// form ([`encoded_tail`]) where that differs, since that is what a browser would send.
pub fn links_in(text: &str, page: &str) -> Vec<String> {
    let mut out: Vec<String> = addresses_in(text).into_iter().map(String::from).collect();
    let base = base_of(text, page).unwrap_or_else(|| page.to_string());
    for l in hrefs(text).into_iter().chain(md_targets(text)) {
        if let Some(abs) = resolve_link(&base, l) {
            if let Some((origin, _)) = split_abs(&abs) {
                let wire = fmt!("{}{}", origin, encoded_tail(&abs));
                if wire != abs {
                    out.push(wire);
                }
            }
            out.push(abs);
        }
    }
    out
}

/// Is a body of type `ct` text a link may be written in?  A binary body is never read for one.
pub fn texty(ct: &str) -> bool {
    let t = ct.trim().to_ascii_lowercase();
    t.starts_with("text/") || t.contains("html")
}

/// The addresses a chat has been shown, in the order they came, bounded at [`SEEN_MAX`].
#[derive(Debug, Default)]
pub struct ShownSet {
    order: VecDeque<String>,
    set:   BTreeSet<String>,
}

impl ShownSet {
    /// Remember one address a result or page showed.
    pub fn put(&mut self, url: &str) {
        let url = url.trim();
        if url.is_empty() || url.len() > SEEN_URL_MAX {
            return;
        }
        let u = same_address(url);
        if self.set.contains(&u) {
            return;
        }
        if self.order.len() >= SEEN_MAX {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        self.set.insert(u.clone());
        self.order.push_back(u);
    }

    /// Did a result or page show `url` as it stands?
    pub fn has(&self, url: &str) -> bool {
        self.set.contains(&same_address(url))
    }

    /// How many addresses it holds.
    pub fn len(&self) -> usize {
        self.order.len()
    }

    /// Does it hold none?
    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    /// Remember each address in a search answer: every result's address and those its snippets
    /// write out.
    pub fn put_answer(&mut self, a: &SearchAnswer) {
        for h in &a.results {
            self.put(&h.url);
            for u in addresses_in(&h.snippet) {
                self.put(u);
            }
        }
    }

    /// The chat's earlier search results and fetched pages count as shown (l.254, "this chat's";
    /// UNBLOCK-88): a link a result gave two turns ago is no more the model's than one it gave
    /// now.  Only a `web_search` or `web_fetch` result is read, by the call that asked for it: a
    /// command's output or the model's own words could hold an address the model composed.
    ///
    /// What it held before is dropped: the thread is the whole of what this chat was shown, and a
    /// set kept from another chat's turn must never count here (l.254, "this chat's").
    pub fn seed(&mut self, thread: &[ChatMessage]) {
        *self = Self::default();
        let mut asked: BTreeMap<&str, (&str, &str)> = BTreeMap::new();	// call id -> (tool, its arguments)
        for m in thread {
            match m {
                ChatMessage::Assistant { tool_calls, .. } => for c in tool_calls {
                    asked.insert(c.id.as_str(), (c.name.as_str(), c.arguments.as_str()));
                },
                ChatMessage::Tool { tool_call_id, content, .. } => {
                    let (tool, args) = match asked.get(tool_call_id.as_str()) {
                        Some(a) => *a,
                        None    => continue,
                    };
                    let text = content.as_text();
                    match tool {
                        "web_search" => for u in addresses_in(&text) {
                            self.put(u);
                        },
                        "web_fetch"  => {
                            for u in addresses_in(&text) {
                                self.put(u);
                            }
                            if let Ok(page) = Tool::arg(args, "url") {
                                for u in links_in(&text, &page) {
                                    self.put(&u);
                                }
                            }
                        },
                        _ => (),
                    }
                },
                _ => (),
            }
        }
    }
}

/// D1's answer for an address on a tainted chat (l.297, amended by l.254): an ordinary one is a
/// standing yes, and a heavy one is refused on its own terms unless this chat's results or pages
/// showed it as it stands (`shown`, from [`ToolContext::was_shown`]), since then the model did not
/// write it.  Nobody is asked either way.
pub fn address_reach(url: &str, shown: bool) -> EgressWord {
    match heavy(url) && !shown {
        true    => EgressWord::Heavy,
        false   => EgressWord::Standing(Verdict::Allow),
    }
}

/// D1's answer for a search query on a tainted chat (l.253, "an address or query"): one past
/// [`EGRESS_PAYLOAD_MAX`] UTF-8 bytes or holding a [`blob`] is refused on its own terms, and any
/// other runs with nobody asked.  Measured in bytes, not percent-encoded: a space carries one byte
/// of the chat, and counting it as three refused an ordinary research query on 1 Nov (UNBLOCK-88).
pub fn query_reach(q: &str) -> EgressWord {
    match heavy_query(q) {
        true    => EgressWord::Heavy,
        false   => EgressWord::Standing(Verdict::Allow),
    }
}
