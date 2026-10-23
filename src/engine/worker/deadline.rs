//! A tool call's own ceiling, and the person-wait beat that holds it off (U3a LV2, UNBLOCK-16).
//!
//! **A TOOL IS NEVER RACED AGAINST LIVENESS** (U3a plan rev 2, ruling 1): each call is raced
//! against its own ceiling ([`ceiling_of`]) plus [`TOOL_CEILING_MARGIN_MS`], and an expiry is a
//! failed outcome the turn reads and goes on from.
//!
//! **THE CALL'S DEADLINE IS FOUND BY POLLING, NOT BY ARGUMENT** (plan §9.7 A1).  The dispatch
//! site wraps the call in [`scoped`], which makes the call's [`Deadline`] the [`current`] one
//! for exactly the span of each poll of that call and no other.  The wasm leaves that wait on a
//! person (`wasm/web.rs::egress_ask_raw`, `wasm/deletes.rs::ask_to_go_on`, `wasm/social.rs`
//! `compose`/`commit`) take it with [`held_by_person`] from inside that poll, so no `tools.rs`
//! call site carries it and two turns on one page thread never beat each other's calls.
//! The project check does the same to set its declared budget (A2): [`stretch`].

use crate::agent::compact::{
    TOOL_CEILING_DEFAULT_MS,
    TOOL_CEILING_MARGIN_MS,
};
use crate::llm::{
    extract_json_number,
    extract_json_string,
    now_ms,
    sleep_ms,
};
use crate::engine::race::{
    race,
    Won,
};

use std::{
    cell::{
        Cell,
        RefCell,
    },
    future::{
        Future,
        poll_fn,
    },
    pin::pin,
    rc::Rc,
};

/// How often a person's wait pushes its call's deadline forward.
pub const PERSON_BEAT_MS: u64 = 30_000;

// Mirrors of the tools' own figures (`tools.rs`: `RUN_TIMEOUT_*`, `VERIFY_BUDGET_*`), which are
// gated to the browser build and private to it; `ceilings_match_the_tools` pins these.
const RUN_DEFAULT_MS:    u64 = 120_000;
const RUN_MAX_MS:        u64 = 900_000;
const VERIFY_DEFAULT_MS: u64 = 20 * 60 * 1_000;
const VERIFY_MAX_MS:     u64 = 2 * 60 * 60 * 1_000;
const GATHER_MIN_S:      u64 = 10;

/// How long a call may run, in ms, before its own limit is met, the margin not included.
///
/// `run` its `timeout_ms`, a named `verify` its budget, `gather` its wait; a project check
/// (`verify` with no name) the default until it reads its declaration and [`stretch`]es.
/// Everything else, the tools that wait on a person included, takes the default: a person's
/// wait is held off by its own beat, never by a ceiling of its own (A1).
pub fn ceiling_of(tool: &str, args: &str, gather_s: u64) -> u64 {
    match tool {
        "run" => extract_json_number(args, "timeout_ms")
            .unwrap_or(RUN_DEFAULT_MS)
            .min(RUN_MAX_MS),
        "verify" if extract_json_string(args, "name").map(|n| !n.is_empty()).unwrap_or(false) =>
            extract_json_number(args, "timeout_ms")
                .unwrap_or(VERIFY_DEFAULT_MS)
                .min(VERIFY_MAX_MS)
                .max(1),
        "gather" => {
            let held = gather_s.max(GATHER_MIN_S);
            extract_json_number(args, "timeout_s")
                .unwrap_or(held)
                .clamp(GATHER_MIN_S, held)
                .saturating_mul(1_000)
        }
        _ => TOOL_CEILING_DEFAULT_MS,
    }
}

/// When one tool call is due to have finished by, shared on clone.
#[derive(Clone, Debug)]
pub struct Deadline {
    due: Rc<Cell<u64>>, // clock time the call is cut at
}

impl Deadline {

    /// A call starting at `now` and held to `ceiling_ms` plus the margin.
    pub fn new(now: u64, ceiling_ms: u64) -> Self {
        Self { due: Rc::new(Cell::new(now.saturating_add(ceiling_ms)
            .saturating_add(TOOL_CEILING_MARGIN_MS))) }
    }

    pub fn due_at(&self) -> u64 {
        self.due.get()
    }

    /// Hold the call until at least `ms` plus the margin after `now`; never brings it nearer.
    pub fn push(&self, now: u64, ms: u64) {
        let to = now.saturating_add(ms).saturating_add(TOOL_CEILING_MARGIN_MS);
        if to > self.due.get() { self.due.set(to); }
    }

    /// Set the call's ceiling outright, counted from `began`: the project check's declared
    /// budget replaces the default, longer or shorter.
    pub fn reset(&self, began: u64, ms: u64) {
        self.due.set(began.saturating_add(ms).saturating_add(TOOL_CEILING_MARGIN_MS));
    }

    /// Resolve once the clock passes the deadline, re-reading it after every sleep so a push
    /// made meanwhile holds it off.
    pub async fn passed(&self) {
        loop {
            let (now, due) = (now_ms(), self.due.get());
            if now >= due { return; }
            sleep_ms(due - now).await;
        }
    }
}

thread_local! {
    static CURRENT: RefCell<Option<(Deadline, u64)>> = const { RefCell::new(None) };
}

/// The deadline of the call being polled right now, with the clock time it began; `None`
/// outside a [`scoped`] call.
pub fn current() -> Option<(Deadline, u64)> {
    CURRENT.with(|c| c.borrow().clone())
}

/// Poll `call` with `dl` as the [`current`] deadline, and the one before put back after each
/// poll, so only code running inside this call can find it.
pub async fn scoped<F: Future>(dl: Deadline, began: u64, call: F) -> F::Output {
    let mut call = pin!(call);
    poll_fn(|cx| {
        let prev = CURRENT.with(|c| c.replace(Some((dl.clone(), began))));
        let out = call.as_mut().poll(cx);
        CURRENT.with(|c| *c.borrow_mut() = prev);
        out
    }).await
}

/// Race `call` against `ceiling_ms` plus the margin.  When the ceiling wins, the call is
/// dropped where it stands, as a Stop drops it, and the error is the ceiling in force at the
/// end, in seconds and without the margin: the call may have moved it ([`stretch`]).
pub async fn within_ceiling<F: Future>(ceiling_ms: u64, call: F) -> Result<F::Output, u64> {
    let began = now_ms();
    let dl = Deadline::new(began, ceiling_ms);
    match race(scoped(dl.clone(), began, call), dl.passed()).await {
        Won::First(v)   => Ok(v),
        Won::Second(()) => Err(dl.due_at().saturating_sub(began)
            .saturating_sub(TOOL_CEILING_MARGIN_MS) / 1_000),
    }
}

/// The project check has read its declared budget: hold the current call to `ms` from its
/// start, plus the margin (A2).  Nothing outside a scoped call.
pub fn stretch(ms: u64) {
    if let Some((dl, began)) = current() { dl.reset(began, ms); }
}

/// Await `wait`, a person's answer, beating the current call's deadline at once and then every
/// [`PERSON_BEAT_MS`] while it is open, so a slow person never meets the ceiling.  `what` names
/// the wait in the log, and `say` writes each beat's line there: the caller's, since the log is
/// the host's and this file names no host (GATE H3; the page's is `crate::wasm::held_by_person`).
/// Must be called from inside the scoped call's poll, which is where the wasm leaves are;
/// elsewhere it is `wait` alone.
pub async fn held_by_person<F: Future>(what: &str, say: impl Fn(&str), wait: F) -> F::Output {
    held_every(what, PERSON_BEAT_MS, say, wait).await
}

/// [`held_by_person`] with its beat interval named, for the tests.
pub(crate) async fn held_every<F: Future>(what: &str, every: u64, say: impl Fn(&str), wait: F)
    -> F::Output
{
    let dl = match current() {
        Some((dl, _)) => dl,
        None          => return wait.await,
    };
    // The first beat is said at once, so a person's wait shows in the log however short it is.
    dl.push(now_ms(), every);
    say(&beat_line(what, dl.due_at()));
    let beat = async {
        loop {
            sleep_ms(every).await;
            dl.push(now_ms(), every);
            say(&beat_line(what, dl.due_at()));
        }
    };
    match race(wait, beat).await {
        Won::First(v)  => v,
        Won::Second(_) => unreachable!("the beat never ends"),
    }
}

/// The line a person-wait beat is logged as.
fn beat_line(what: &str, due: u64) -> String {
    format!("[daimond] person-wait beat: {} still open, its call now due at {} ms", what, due)
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn ceilings_match_the_tools() {
        assert_eq!(120_000, ceiling_of("run", r#"{"argv":["x"]}"#, 600));
        assert_eq!(10_000, ceiling_of("run", r#"{"argv":["x"],"timeout_ms":10000}"#, 600));
        assert_eq!(RUN_MAX_MS, ceiling_of("run", r#"{"timeout_ms":99999999}"#, 600));
        assert_eq!(60_000, ceiling_of("verify", r#"{"name":"graph","timeout_ms":60000}"#, 600));
        assert_eq!(TOOL_CEILING_DEFAULT_MS, ceiling_of("verify", r#"{"cwd":"."}"#, 600));
        assert_eq!(600_000, ceiling_of("gather", "{}", 600));
        assert_eq!(30_000, ceiling_of("gather", r#"{"timeout_s":30}"#, 600));
        assert_eq!(10_000, ceiling_of("gather", r#"{"timeout_s":1}"#, 600));
        assert_eq!(TOOL_CEILING_DEFAULT_MS, ceiling_of("web_read", r#"{"url":"x"}"#, 600));
    }

    #[test]
    fn a_push_never_brings_a_deadline_nearer() {
        let dl = Deadline::new(1_000, 500);
        assert_eq!(dl.due_at(), 1_500 + TOOL_CEILING_MARGIN_MS);
        dl.push(1_000, 100);
        assert_eq!(dl.due_at(), 1_500 + TOOL_CEILING_MARGIN_MS);
        dl.push(2_000, 500);
        assert_eq!(dl.due_at(), 2_500 + TOOL_CEILING_MARGIN_MS);
        dl.reset(1_000, 100);
        assert_eq!(dl.due_at(), 1_100 + TOOL_CEILING_MARGIN_MS, "a declared budget may be shorter");
    }

    #[tokio::test]
    async fn the_current_deadline_is_only_seen_inside_its_call() {
        assert!(current().is_none());
        let dl = Deadline::new(0, 1);
        let inside = scoped(dl.clone(), 0, async {
            tokio::task::yield_now().await;
            current().map(|(d, _)| d.due_at())
        }).await;
        assert_eq!(inside, Some(dl.due_at()));
        assert!(current().is_none(), "the deadline leaked out of its call");
    }

    #[tokio::test]
    async fn a_person_wait_beats_its_call_past_the_ceiling() {
        // A call due 50 ms in, and a person who answers after three beats of 40 ms.
        let began = now_ms();
        let dl = Deadline { due: Rc::new(Cell::new(began + 50)) };
        let ask = async { tokio::time::sleep(Duration::from_millis(130)).await; "yes" };
        let said = std::cell::RefCell::new(Vec::new());
        let call = scoped(dl.clone(), began,
            held_every("a test ask", 40, |l: &str| said.borrow_mut().push(l.to_string()), ask));
        let got = match race(call, dl.passed()).await {
            Won::First(v)   => Some(v),
            Won::Second(()) => None,
        };
        assert_eq!(got, Some("yes"), "the person's wait was cut by the ceiling");
        let said = said.borrow();
        assert!(said.len() >= 2 && said.iter().all(|l|
            l.starts_with("[daimond] person-wait beat: a test ask still open")), "{:?}", said);
    }
}
