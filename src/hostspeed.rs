//! How fast each host serves each model, measured on every round, and the hosts that routing
//! leaves out for being slow (FIRE D-20261020-10, 22 Oct 2026).
//!
//! OpenRouter chooses the host behind a model, and on 20 Oct its choice of Cloudflare made a
//! worker's DeepSeek V4 Flash rounds crawl while the same model elsewhere was quick.  Claude Code
//! has one host and needs none of this; Daimond has many, and measuring them is how it does
//! better.  One store per page (a `thread_local`, so every chat, daimon and worker on the page
//! feeds and reads the same figures), filled by [`crate::llm::LlmClient`] as each streamed round
//! ends, read by its request builder and its pin, and saved by the page between visits.

use crate::llm::json_escape;

use oxedyne_fe2o3_core::prelude::*;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::collections::VecDeque;

// The window
pub const WINDOW_ROUNDS:   usize = 12;                      // newest rounds kept per model+host: a dozen outvotes one bad round
pub const WINDOW_AGE_MS:   u64   = 48 * 3_600_000;          // a host's bad day ages out in two, so it is tried again
pub const MIN_ROUNDS:      usize = 3;                       // fewer than this is noise, and judges nobody

// What counts as slow
pub const MIN_OUT_TOKENS:  u64   = 64;                      // a shorter reply's rate is mostly its overhead, so it is not timed
pub const SLOW_TPS:        f64   = 20.0;                    // tokens/s; under it a 2,000-token reply takes over 100 s
pub const SLOW_SHARE:      f64   = 0.5;                     // under half the best host's rate for the same model
pub const SLOW_FIRST_MS:   u64   = 30_000;                  // median wait for the first token; past it a person thinks it hung
pub const STALL_SHARE:     f64   = 0.25;                    // one round in four going silent is a host to leave
pub const STAND_DOWN_MS:   u64   = 6 * 3_600_000;           // after OpenRouter refused a request for leaving out every host it had

/// One round as its host served it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Sample {
    pub at:       u64,      // wall clock, ms since 1970
    pub first_ms: u64,      // request to first token; 0 when none came
    pub gen_ms:   u64,      // first token to the end
    pub out:      u64,      // output tokens, reasoning included
    pub stalled:  bool,
}

impl Sample {
    /// Tokens a second from the first token on, where the reply was long enough to time.
    pub fn tps(&self) -> Option<f64> {
        if self.stalled || self.out < MIN_OUT_TOKENS || self.gen_ms == 0 { return None; }
        Some(self.out as f64 * 1000.0 / self.gen_ms as f64)
    }
}

/// One model+host pairing over the window, as the page shows it and routing reads it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HostFigures {
    pub model:     String,
    pub host:      String,
    pub rounds:    usize,
    pub stalls:    usize,
    pub first_ms:  Option<u64>,     // median, over rounds that produced a token
    pub tps:       Option<f64>,     // median, over rounds long enough to time
    pub out:       u64,             // output tokens over the window
    pub last_at:   u64,
    pub slow:      &'static str,    // "" or why routing leaves it out: stalls, rate, behind, wait
}

#[derive(Default)]
struct Store {
    rounds:     BTreeMap<(String, String), VecDeque<Sample>>,
    stand_down: BTreeMap<String, u64>,  // model -> wall ms until which nothing is left out
}

thread_local! {
    static STORE: RefCell<Store> = RefCell::new(Store::default());
}

/// Milliseconds since 1970: the window outlives a reload, so a monotonic clock will not do.
#[cfg(target_arch = "wasm32")]
pub fn wall_ms() -> u64 {
    js_sys::Date::now() as u64
}

#[cfg(not(target_arch = "wasm32"))]
pub fn wall_ms() -> u64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d)   => d.as_millis() as u64,
        Err(_)  => 0,
    }
}

/// A name as the save format holds it: no tab, no line break.
fn clean(s: &str) -> String {
    s.chars().map(|c| if c == '\t' || c == '\n' || c == '\r' { ' ' } else { c }).collect::<String>()
        .trim().to_string()
}

/// Count one round of `model` on `host`.  A round naming no host is not counted: nothing could
/// be routed by it.
pub fn record(model: &str, host: &str, s: Sample) {
    let (model, host) = (clean(model), clean(host));
    if model.is_empty() || host.is_empty() { return; }
    STORE.with(|st| {
        let mut st = st.borrow_mut();
        let q = st.rounds.entry((model, host)).or_default();
        q.push_back(s);
        while q.len() > WINDOW_ROUNDS { q.pop_front(); }
    });
}

/// OpenRouter refused a request that left measured hosts out of `model`: send none for a while.
pub fn stand_down(model: &str, now: u64) {
    STORE.with(|st| { st.borrow_mut().stand_down.insert(clean(model), now + STAND_DOWN_MS); });
}

fn median_u64(mut v: Vec<u64>) -> Option<u64> {
    if v.is_empty() { return None; }
    v.sort_unstable();
    Some(v[v.len() / 2])
}

fn median_f64(mut v: Vec<f64>) -> Option<f64> {
    if v.is_empty() { return None; }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(v[v.len() / 2])
}

/// Every model+host pairing in the window at `now`, each judged against its model's other hosts.
pub fn figures_at(now: u64) -> Vec<HostFigures> {
    let mut out: Vec<HostFigures> = STORE.with(|st| {
        st.borrow().rounds.iter().filter_map(|((model, host), q)| {
            let live: Vec<&Sample> = q.iter()
                .filter(|s| now.saturating_sub(s.at) <= WINDOW_AGE_MS).collect();
            if live.is_empty() { return None; }
            Some(HostFigures {
                model:    model.clone(),
                host:     host.clone(),
                rounds:   live.len(),
                stalls:   live.iter().filter(|s| s.stalled).count(),
                first_ms: median_u64(live.iter()
                    .filter(|s| !s.stalled && s.first_ms > 0).map(|s| s.first_ms).collect()),
                tps:      median_f64(live.iter().filter_map(|s| s.tps()).collect()),
                out:      live.iter().map(|s| s.out).sum(),
                last_at:  live.iter().map(|s| s.at).max().unwrap_or(0),
                slow:     "",
            })
        }).collect()
    });
    // The best timed rate per model, from hosts measured often enough to trust.
    let mut best: BTreeMap<String, f64> = BTreeMap::new();
    for f in &out {
        if f.rounds < MIN_ROUNDS { continue; }
        if let Some(t) = f.tps {
            let b = best.entry(f.model.clone()).or_insert(0.0);
            if t > *b { *b = t; }
        }
    }
    for f in out.iter_mut() {
        if f.rounds < MIN_ROUNDS { continue; }
        let best = best.get(&f.model).copied().unwrap_or(0.0);
        f.slow = if f.stalls as f64 >= STALL_SHARE * f.rounds as f64 { "stalls" }
            else if matches!(f.tps, Some(t) if t < SLOW_TPS) { "rate" }
            else if matches!(f.tps, Some(t) if t < SLOW_SHARE * best) { "behind" }
            else if matches!(f.first_ms, Some(ms) if ms > SLOW_FIRST_MS) { "wait" }
            else { "" };
    }
    out
}

/// The hosts `model`'s requests leave out at `now`: every one measured slow, unless OpenRouter
/// lately refused a request for having nobody left.
pub fn avoid_at(model: &str, now: u64) -> Vec<String> {
    let model = clean(model);
    let down = STORE.with(|st| st.borrow().stand_down.get(&model).copied().unwrap_or(0));
    if now < down { return Vec::new(); }
    figures_at(now).into_iter()
        .filter(|f| f.model == model && !f.slow.is_empty())
        .map(|f| f.host).collect()
}

pub fn avoid(model: &str) -> Vec<String> {
    avoid_at(model, wall_ms())
}

/// Is `host` measured slow for `model`?
pub fn is_slow(model: &str, host: &str) -> bool {
    let host = clean(host);
    avoid(model).iter().any(|h| *h == host)
}

/// The figures as the page reads them: one JSON object per model+host.
pub fn figures_json() -> String {
    let rows: Vec<String> = figures_at(wall_ms()).iter().map(|f| fmt!(
        "{{\"model\":\"{}\",\"host\":\"{}\",\"rounds\":{},\"stalls\":{},\"first_ms\":{},\
         \"tps\":{},\"out\":{},\"last_at\":{},\"slow\":\"{}\"}}",
        json_escape(&f.model), json_escape(&f.host), f.rounds, f.stalls,
        f.first_ms.map(|v| v.to_string()).unwrap_or_else(|| "null".to_string()),
        f.tps.map(|v| fmt!("{:.1}", v)).unwrap_or_else(|| "null".to_string()),
        f.out, f.last_at, f.slow)).collect();
    fmt!("[{}]", rows.join(","))
}

/// The window as the page keeps it between visits: a line per round, tab-separated.
pub fn save() -> String {
    STORE.with(|st| {
        let st = st.borrow();
        let mut out = String::new();
        for ((model, host), q) in st.rounds.iter() {
            for s in q {
                out.push_str(&fmt!("{}\t{}\t{}\t{}\t{}\t{}\t{}\n", model, host, s.at,
                    s.first_ms, s.gen_ms, s.out, if s.stalled { 1 } else { 0 }));
            }
        }
        out
    })
}

/// Take back what [`save`] wrote, beside anything already counted this visit.  A line that does
/// not read is passed over and counted in the answer: a figure lost costs one round of measuring.
pub fn load(text: &str) -> usize {
    let mut bad = 0;
    for line in text.lines() {
        if line.trim().is_empty() { continue; }
        let f: Vec<&str> = line.split('\t').collect();
        let num = |i: usize| f.get(i).and_then(|v| v.trim().parse::<u64>().ok());
        match (f.len(), num(2), num(3), num(4), num(5), num(6)) {
            (7, Some(at), Some(first_ms), Some(gen_ms), Some(out), Some(st)) =>
                record(f[0], f[1], Sample { at, first_ms, gen_ms, out, stalled: st != 0 }),
            _ => bad += 1,
        }
    }
    bad
}

/// Forget every figure (tests, and a person clearing the page's data).
pub fn clear() {
    STORE.with(|st| *st.borrow_mut() = Store::default());
}

#[cfg(test)]
#[path = "../tests/unit/hostspeed/tests.rs"]
mod tests;
