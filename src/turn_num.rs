//! A turn's number, as the model holds it (TURN-NUM, D-20261031-18).
//!
//! The page fixes `n` on a turn's record when it makes it: 1 + the highest `n` after the chat's
//! last fold, the same on every device (`www/js/turnnum.js`).  The engine is handed it with the
//! turn, on the tab and on Kimberlite alike, and writes it ONCE, as a label at the foot of the
//! turn's own note, which is stored with the message.  The history only grows, so every earlier
//! byte of the request stays where it was and the provider's cache still holds it.
//!
//! A row the page rebuilds from its transcript (another device's prompt, a restored tail) takes
//! the same label from the row's own `n`, through the same [`noted`].

use crate::protocol::ChatMessage;

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_jdat::Dat;

/// The label turn `n` carries in the model's history, `[#n]`; empty for 0, a turn with no number.
pub fn label(n: u32) -> String {
    match n {
        0   => String::new(),
        _   => fmt!("[#{}]", n),
    }
}

/// A JavaScript number as a turn number: a whole number from 1 up, else 0 (none).
pub fn n_of(v: f64) -> u32 {
    match v.is_finite() && v >= 1.0 && v <= u32::MAX as f64 && v.fract() == 0.0 {
        true    => v as u32,
        false   => 0,
    }
}

/// `pre` with turn `n`'s label at its foot, beside the words it numbers; `pre` itself for 0.
pub fn noted(pre: &str, n: u32) -> String {
    crate::prompts::join_note(pre, &label(n))
}

/// The number a note's label carries, read from its last paragraph, or `None`.
pub fn label_of(pre: &str) -> Option<u32> {
    let last = match pre.rsplit("\n\n").next() {
        Some(p) => p.trim(),
        None    => return None,
    };
    match last.strip_prefix("[#").and_then(|r| r.strip_suffix(']')) {
        Some(d) if !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()) => d.parse::<u32>().ok(),
        _ => None,
    }
}

/// What the system message says about the numbers, only where `turn_get` is on the belt: a fact
/// about the belt, as the `compound` sentence is.  Fixed text, so the system message is the same
/// bytes on every turn.
pub const TURN_NUM_LINE: &str = " Each of the person's messages ends its note with that \
    turn's number, as [#N], and he sees the same #N on his message. \"My message #N\" is the \
    message labelled [#N] and \"your response #N\" is your answer to it. Numbering starts again \
    at #1 after each fold, so the latest [#N] is the one meant. A number higher than the current \
    turn's, or one you no longer hold, is from before a fold: answer it from the fold notes or \
    recall, and say that is where the answer came from. turn_get with {\"n\": N} returns that \
    turn whole. When he cites a number, call turn_get with it: a label in the history may be \
    out of date.";

/// Turn `n` as the conversation holds it, found through `nums`, the rows' own numbers since the
/// last fold (`[(mid, n)]`, from the page's transcript, [`crate::agent::Agent::set_turn_numbers`]):
/// the latest row numbered `n` names the person's message by its `mid`, and the answer is every
/// assistant reply after it up to the next turn's message.  Never the `[#n]` labels in the
/// history: a turn not yet accepted may be renumbered after it ran, so its label can be stale.
pub fn turn_said(msgs: &[ChatMessage], nums: &[(String, u32)], n: u32) -> String {
    if n == 0 {
        return fmt!("[turn_get] Give the turn's number as 'n', 1 or more.");
    }
    let mid = match nums.iter().rev().find(|(m, k)| *k == n && !m.is_empty()) {
        Some((m, _))    => m.as_str(),
        None            => return fmt!(
            "[turn_get] No turn #{} has been said since the last fold, so it is from before a \
            fold. Answer from the fold notes or with recall, and say that is where the answer \
            came from.", n),
    };
    let at = match msgs.iter().rposition(|m| m.role() == "user" && m.mid() == mid) {
        Some(i) => i,
        None    => return fmt!(
            "[turn_get] Turn #{} is no longer in the conversation you hold: it was folded away. \
            Answer from the fold notes or with recall, and say that is where the answer came \
            from.", n),
    };
    let mut answer: Vec<String> = Vec::new();
    for m in msgs[at + 1..].iter() {
        if m.opens_turn() {
            break;
        }
        if m.role() == "assistant" {
            let t = m.text();
            if !t.trim().is_empty() {
                answer.push(t.trim().to_string());
            }
        }
    }
    let reply = match answer.is_empty() {
        true    => fmt!("(no answer was given)"),
        false   => answer.join("\n\n"),
    };
    fmt!("[turn_get] Turn #{}.\n\nThe person's message:\n{}\n\nYour answer:\n{}",
        n, msgs[at].text().trim(), reply)
}

/// A page's `[["mid", n], …]` as rows' numbers; an entry without a mid or a whole `n` from 1 up
/// is left out.
pub fn nums_of_json(json: &str) -> Outcome<Vec<(String, u32)>> {
    let v = res!(Dat::decode_string_with_config(json, &crate::agent::compact::json_cfg()));
    Ok(nums_of_dat(&v))
}

/// [`nums_of_json`] on a decoded value; anything but a list is no numbers.
pub fn nums_of_dat(v: &Dat) -> Vec<(String, u32)> {
    let mut out = Vec::new();
    if let Dat::List(l) = v {
        for e in l.iter() {
            if let Dat::List(p) = e {
                let mid = match p.get(0) {
                    Some(Dat::Str(s))   => s.as_str(),
                    _                   => "",
                };
                let n = n_of(crate::engine::turn::num(p.get(1)));
                if !mid.is_empty() && n > 0 {
                    out.push((mid.to_string(), n));
                }
            }
        }
    }
    out
}

#[cfg(test)]
#[path = "../tests/unit/turn_num/tests.rs"]
mod tests;
