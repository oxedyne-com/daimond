//! Which of a round's tool calls may run at the same time.
//!
//! A model routinely asks for several tools in one reply, and Daimond ran them one after
//! another: the round's wall clock was the SUM of the calls where it could be the MAXIMUM.
//! Three reads of 400 ms were 1.2 seconds instead of 400 ms, every round, for the whole loop.
//!
//! ## THE RULE
//!
//! **A batch may hold only calls that read, and nothing else.** A call joins the batch running
//! beside it only when all four are true of it:
//!
//! 1. It touches no network, so it cannot reach a destination the model chose.
//! 2. It puts no question to the user, so two of them cannot race one dialog.
//! 3. It changes nothing -- no file, no crystal, no store, no ledger, no open page, no panel.
//! 4. It reads no flag that another call in the round can set.
//!
//! **Everything else runs ALONE, in the order the model gave.** That is a narrowing of what runs
//! together, not a rewrite of what runs: a call this cannot confidently place in a batch keeps
//! exactly the behaviour it has today, which is a batch of one.
//!
//! ## WHY THE FOUR, EACH IN TURN
//!
//! **Writes to one target must not race.** Two `file_edit`s of one file, or a write and a read of
//! one path, have an order the model intended and expressed by emitting them together. No
//! intersection of paths is computed here and none is needed: a write is never in a batch, so a
//! write always separates the reads before it from the reads after it, and the model's order
//! across a write is preserved by construction. A path-collision test would be a second, weaker
//! statement of a rule the batching already enforces -- and one that would have to be extended
//! every time a tool learned to touch a path it does not name.
//!
//! **Publishing stays serial and stays exactly-once.** `social_send` is the reachable tool on the
//! wrong side of that line, and it is already excluded from road-failure retries for the same
//! reason (see [`crate::tools::Tool::road_retryable`]): sending in somebody's name twice because
//! of an infrastructure event is not something a budget may buy. Nothing that publishes is ever
//! in a batch.
//!
//! **THE CONSENT SURFACE IS WHY THE WEB READS ARE NOT HERE**, and it is the trap this module was
//! written around. `web_fetch`, `web_search` and `web_read` look like the ideal batch -- pure
//! reads, hundreds of milliseconds each, no shared file. They are not, and the reason is
//! [`crate::tools::ToolContext::wrap_untrusted`]: every one of them marks the turn as having read
//! a stranger's words, and [`crate::tools::web_step`] consults that very flag to decide whether to
//! ask the user. Run serially -- which is what happens today -- the first fetch is free, taints
//! the turn, and the second fetch therefore asks. Run together, all of them read the flag before
//! any of them sets it, every one comes out free, and a question the user is owed is never put.
//! That is not slowness traded for a race; it is a consent gate silently skipped. So a web read is
//! a batch of one until something has settled what a batch of them should ask, and the one ask per
//! conversation that `web_step` now makes is not on its own an answer to it.
//!
//! **The batch is capped** at [`AT_ONCE`]. Nothing about correctness needs a cap; the turn's
//! output budget does. Each result is charged as it lands ([`crate::tools::ToolRegistry::charge`]),
//! so calls already in flight when the budget runs short are not cut by it, and the overshoot a
//! turn can take is bounded by the size of a batch and by nothing else.

use oxedyne_fe2o3_core::prelude::*;

use std::future::Future;
use std::ops::Range;
use std::pin::Pin;
use std::task::{Context, Poll};

use crate::tools::Tool;

// The most calls that ever run at once, whatever the model asked for.  See the module note.
pub const AT_ONCE: usize = 8;

/// May this tool run beside another call in the same round?
///
/// The allow-list is small and stays small.  A tool added to Daimond later is serial until
/// somebody reads the four conditions in the module note and decides otherwise about it, which is
/// the whole point of writing it as an allow-list: a new tool cannot become concurrent by
/// accident, and a tool that grows a side effect does not quietly keep a permission it was granted
/// when it had none.
///
/// `file_show` is the near miss worth naming.  It reads a file, so it passes the first two
/// conditions and looks like the others -- but what it does with what it reads is put it in the
/// document panel, and two of them racing fight over one panel.  Reading is not the test; changing
/// nothing is.
pub fn may_run_beside(name: &str) -> bool {
    match Tool::from_name(name) {
        Some(t) => matches!(t,
            Tool::FileRead
            | Tool::FileList
            | Tool::FileSearch
            | Tool::FileGlob
            | Tool::SheetRead
            // Reads a file and maps it; touches no panel, no store. Two outlines in one round
            // are the ordinary shape of surveying a few unfamiliar files before reading them.
            | Tool::Outline
            // Both read-only, and neither touches a panel: `crystal_read` reads one file out of
            // the Diamond store and `recall` reads the crystal and the conversation's own fold
            // notices. A round that fetches two cold sections at once is the ordinary shape of
            // using them.
            | Tool::CrystalRead
            | Tool::Recall
            // READ-ONLY BY CONSTRUCTION, which is why `edit` is not one of its ops. It runs its
            // own ops one after another inside a single call, and every one of them is one of
            // the reads named above -- so the four conditions are answered by the ops rather
            // than by anything the compound itself does, and a compound of reads beside a read
            // is the same claim as two reads beside each other.
            | Tool::Compound),
        None => false,
    }
}

/// Split a round's calls into consecutive batches, in the order the model gave them.
///
/// Every returned range is non-empty, they are contiguous, and they cover the whole slice -- so
/// running them in order and recording each batch's results in order reproduces the model's own
/// sequence exactly.  A range of length one is today's behaviour and is what everything that is
/// not in [`may_run_beside`] gets.
///
/// # Arguments
/// * `names` - The wire name of each call, in the order the model emitted them.
pub fn batches<S: AsRef<str>>(names: &[S]) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut i   = 0;
    while i < names.len() {
        if !may_run_beside(names[i].as_ref()) {
            out.push(i..i + 1);
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < names.len()
            && j - i < AT_ONCE
            && may_run_beside(names[j].as_ref())
        {
            j += 1;
        }
        out.push(i..j);
        i = j;
    }
    out
}

/// Several futures of one type, run together, yielding their outputs in the order they were given.
///
/// Hand-written rather than taken from a futures crate, and generic rather than over
/// `dyn Future`: Daimond depends on no async runtime beyond the one the browser already is, and
/// the whole combinator is the `poll` below.
///
/// **It forwards the caller's own waker to every child.**  There is no waker of its own to build,
/// so there is no `RawWakerVTable` and no `unsafe`.  A child that wakes wakes this task, which
/// polls every child still running -- a few spurious polls for a batch bounded at
/// [`AT_ONCE`], and no bookkeeping that could get the accounting wrong.
///
/// Each future is boxed, so the whole thing is `Unpin` and needs no pin projection.  One
/// allocation against a call that is about to wait on a disk or a network is not a cost worth
/// avoiding.
pub struct AllOf<F: Future> {
    work: Vec<Option<Pin<Box<F>>>>,
    done: Vec<Option<F::Output>>,
}

/// `work`'s output, or `None` if `stop` is ready first; the loser is dropped.  `work` is polled
/// first, so a result that is already there is never thrown away for a stop that landed beside it.
pub async fn unless<F: Future, S: Future<Output = ()>>(work: F, stop: S) -> Option<F::Output> {
    let mut work = std::pin::pin!(work);
    let mut stop = std::pin::pin!(stop);
    std::future::poll_fn(move |cx| {
        if let Poll::Ready(v) = work.as_mut().poll(cx) {
            return Poll::Ready(Some(v));
        }
        match stop.as_mut().poll(cx) {
            Poll::Ready(()) => Poll::Ready(None),
            Poll::Pending   => Poll::Pending,
        }
    }).await
}

/// Run every future together.  The outputs come back in the order the futures were given, not the
/// order they finished.
pub fn all_of<F: Future>(futs: Vec<F>) -> AllOf<F> {
    let n = futs.len();
    AllOf {
        work: futs.into_iter().map(|f| Some(Box::pin(f))).collect(),
        done: (0..n).map(|_| None).collect(),
    }
}

// `F::Output: Unpin` because the finished outputs are held in a `Vec` beside the futures, and a
// `Vec<T>` is `Unpin` only where `T` is.  Every caller's output is an `Outcome`, which is.
impl<F: Future> Future for AllOf<F>
where
    F::Output: Unpin,
{
    type Output = Vec<F::Output>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let me = self.get_mut();
        let mut waiting = false;
        for (i, slot) in me.work.iter_mut().enumerate() {
            let ready = match slot {
                Some(f) => match f.as_mut().poll(cx) {
                    Poll::Ready(v) => Some(v),
                    Poll::Pending  => { waiting = true; None },
                },
                None => None,
            };
            if let Some(v) = ready {
                me.done[i] = Some(v);
                *slot = None;
            }
        }
        if waiting {
            return Poll::Pending;
        }
        // Every slot is filled: the loop above only leaves `waiting` false when no future is
        // still running, and a future that finished wrote its output before its slot was cleared.
        Poll::Ready(std::mem::take(&mut me.done).into_iter().flatten().collect())
    }
}


/// Runs `f` when dropped, unless [`OnAbandon::settled`] was called first.
///
/// **A call the turn gives up on is a call nobody is waiting for, and the far side does not
/// know.**  A Stop drops the tool's future inside [`unless`] and a door's ceiling returns without
/// an answer; either way a command on the machine went on to its own timeout -- fifteen minutes
/// for a `run`, two hours for a `verify` (QA r578d D1).  The guard lives in the future, so it is
/// dropped with it, and the one thing it does is tell the far side to stop.
pub struct OnAbandon<F: FnOnce()> {
    f: Option<F>,
}

impl<F: FnOnce()> OnAbandon<F> {
    pub fn new(f: F) -> Self {
        Self { f: Some(f) }
    }

    /// The far side answered, so there is nothing left to stop.
    pub fn settled(mut self) {
        self.f = None;
    }
}

impl<F: FnOnce()> Drop for OnAbandon<F> {
    fn drop(&mut self) {
        if let Some(f) = self.f.take() {
            f();
        }
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
#[path = "../tests/unit/batch/tests.rs"]
mod tests;
