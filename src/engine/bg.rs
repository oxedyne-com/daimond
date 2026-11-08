//! A background command's end (BG-WAKE), as Kimberlite reports it on the errand stream:
//!
//! `{"t":"bg_end","kind":"end"|"match","run","chat","id","command","exit","timed_out",
//! "stopped","ms","out_bytes","err_bytes","tail","spill","lost"}`, with `line` and `pattern` on a
//! `match`.  Heard while its turn is open, it reaches the model as a note at the next request
//! ([`crate::tools::note_late`]); heard after, the page's wake opens a turn on it.  Both say it in
//! the words [`note`] gives, so the model reads one form either way.

use crate::engine::turn::num;

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_jdat::{
    Dat,
    map::DaticleMap,
};

fn text(m: &DaticleMap, k: &str) -> String {
    match m.get(&Dat::Str(k.to_string())) {
        Some(Dat::Str(s)) => s.clone(),
        _                 => String::new(),
    }
}

fn flag(m: &DaticleMap, k: &str) -> bool {
    matches!(m.get(&Dat::Str(k.to_string())), Some(Dat::Bool(true)))
}

/// `ms` as the model reads a span: `950 ms`, `42 s`, `21 min 3 s`, `2 h 4 min`.
fn span(ms: u64) -> String {
    let s = ms / 1000;
    match (s / 3600, (s / 60) % 60, s % 60) {
        (0, 0, 0)   => fmt!("{} ms", ms),
        (0, 0, s)   => fmt!("{} s", s),
        (0, m, s)   => fmt!("{} min {} s", m, s),
        (h, m, _)   => fmt!("{} h {} min", h, m),
    }
}

/// The note the model reads for event `json`.
pub fn note(json: &str) -> Outcome<String> {
    let m = match res!(Dat::decode_string_with_config(json, &crate::agent::compact::json_cfg())) {
        Dat::Map(m) => m,
        _           => return Err(err!("A background command's event must be a JSON object, not: {}.",
            json; Input, Invalid)),
    };
    let cmd = text(&m, "command");
    let id = text(&m, "id");
    let ms = num(m.get(&Dat::Str("ms".to_string()))) as u64;
    let mut out = match text(&m, "kind").as_str() {
        "match" => fmt!("Background command `{}` (id {}) printed a line matching `{}`, after {}; it is \
            still running:\n{}\n", cmd, id, text(&m, "pattern"), span(ms), text(&m, "line")),
        _       => {
            let how = match (flag(&m, "stopped"), flag(&m, "timed_out"), m.get(&Dat::Str("exit".to_string()))) {
                (true, _, _)            => fmt!("was stopped by runs{{stop}}"),
                (false, true, _)        => fmt!("was ended at its time limit"),
                (false, false, Some(e)) if !matches!(e, Dat::Empty | Dat::Opt(_)) => fmt!("exited {}", num(Some(e)) as i64),
                (false, false, _)       => fmt!("ended with no exit code"),
            };
            fmt!("Background command `{}` (id {}) {} after {}; {} bytes out, {} bytes err.\n", cmd, id, how,
                span(ms), num(m.get(&Dat::Str("out_bytes".to_string()))) as u64,
                num(m.get(&Dat::Str("err_bytes".to_string()))) as u64)
        },
    };
    let tail = text(&m, "tail");
    if !tail.is_empty() {
        out.push_str(&fmt!("Its last output:\n```\n{}\n```\n", tail.trim_end()));
    }
    let spill = text(&m, "spill");
    let lost = text(&m, "lost");
    match (spill.is_empty(), lost.is_empty()) {
        (false, true)   => out.push_str(&fmt!("The whole output is at {}.", spill)),
        (_, false)      => out.push_str(&fmt!("The whole output was not kept: {}.", lost)),
        (true, true)    => (),
    }
    Ok(out.trim_end().to_string())
}

#[cfg(test)]
#[path = "../../tests/unit/engine/bg/tests.rs"]
mod tests;
