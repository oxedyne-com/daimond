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
            | Tool::SheetRead),
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


// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reads_batch_and_writes_do_not() {
        let names = ["file_read", "file_read", "file_read"];
        assert_eq!(vec![0..3], batches(&names), "three reads did not become one batch");

        let names = ["file_write", "file_write"];
        assert_eq!(vec![0..1, 1..2], batches(&names), "two writes were put in one batch");
    }

    #[test]
    fn test_a_write_separates_the_reads_around_it() {
        // The model's order across the write is the whole point: batch, write, batch.
        let names = ["file_read", "file_read", "file_edit", "file_read"];
        assert_eq!(vec![0..2, 2..3, 3..4], batches(&names),
            "a write did not break the batch around it");
    }

    #[test]
    fn test_two_writes_to_one_path_keep_the_model_s_order() {
        // The property the batching has to preserve, stated as the batching sees it: each write
        // is alone, and they are in the order given, so nothing can reorder them downstream.
        let names = ["file_edit", "file_edit"];
        let spans = batches(&names);
        assert_eq!(2, spans.len(), "two writes did not stay two batches");
        for (n, span) in spans.iter().enumerate() {
            assert_eq!(n..n + 1, *span, "write {} was not alone and in place", n);
        }
    }

    #[test]
    fn test_nothing_that_reaches_the_network_or_asks_is_batched() {
        // Named one by one rather than as a list, so a tool that changes side stands out in the
        // diff. `web_fetch` is the one the module note is mostly about.
        for name in ["web_fetch", "web_search", "web_read", "web_open", "web_click",
                     "social_send", "social_read", "ask", "run", "shell", "spawn_agent",
                     "file_show", "file_fetch", "typst_compile", "link_add"] {
            assert!(!may_run_beside(name), "'{}' was allowed into a batch", name);
        }
    }

    #[test]
    fn test_an_unknown_tool_is_never_batched() {
        assert!(!may_run_beside("no_such_tool"), "an unknown name was allowed into a batch");
        let names = ["file_read", "no_such_tool", "file_read"];
        assert_eq!(vec![0..1, 1..2, 2..3], batches(&names),
            "an unknown name did not break the batch");
    }

    #[test]
    fn test_a_batch_is_capped() {
        let names = vec!["file_read"; AT_ONCE + 3];
        assert_eq!(vec![0..AT_ONCE, AT_ONCE..AT_ONCE + 3], batches(&names),
            "the cap did not bound the batch");
    }

    #[test]
    fn test_the_batches_cover_every_call_exactly_once() {
        let names = ["file_read", "file_edit", "file_list", "file_glob", "run", "sheet_read"];
        let spans = batches(&names);
        let mut at = 0;
        for span in &spans {
            assert_eq!(at, span.start, "the batches are not contiguous");
            assert!(span.end > span.start, "an empty batch was produced");
            at = span.end;
        }
        assert_eq!(names.len(), at, "the batches did not cover every call");
    }

    #[test]
    fn test_nothing_is_batched_when_there_is_nothing() {
        let names: [&str; 0] = [];
        assert!(batches(&names).is_empty(), "an empty round produced a batch");
    }

    #[test]
    fn test_all_of_returns_outputs_in_the_order_given_not_the_order_finished() {
        // Deliberately finishing backwards: the last future is ready first.
        let futs = vec![
            ready_after(2, "a"),
            ready_after(1, "b"),
            ready_after(0, "c"),
        ];
        let got = block_on(all_of(futs));
        assert_eq!(vec!["a", "b", "c"], got, "outputs came back in completion order");
    }

    /// THE WHOLE POINT, ON A CLOCK: three waits of one length take one wait's time together and
    /// three waits' time in a queue.
    ///
    /// Both halves are measured in the one test rather than one of them being asserted from
    /// memory, because the claim is a COMPARISON -- a machine under load makes any single figure
    /// here meaningless, and the ratio survives what the absolute number does not.
    #[tokio::test]
    async fn test_waits_run_together_rather_than_one_after_another() {
        let each = std::time::Duration::from_millis(200);

        let began = std::time::Instant::now();
        let got   = all_of(vec![waited(each, 'a'), waited(each, 'b'), waited(each, 'c')]).await;
        let batch = began.elapsed();
        assert_eq!(vec!['a', 'b', 'c'], got, "the batch did not answer in the order given");

        let began = std::time::Instant::now();
        for c in ['a', 'b', 'c'] {
            let _ = waited(each, c).await;
        }
        let queue = began.elapsed();

        assert!(batch < each * 2,
            "three {:?} waits took {:?} together, which is a queue and not a batch", each, batch);
        assert!(queue > batch * 2,
            "the queue took {:?} and the batch {:?}, which is not the difference this is for",
            queue, batch);
    }

    /// A wait of a known length, so the test above measures a clock and not a poll count.
    async fn waited(d: std::time::Duration, v: char) -> char {
        tokio::time::sleep(d).await;
        v
    }

    /// A future that answers after `n` further polls, so a test can order completions without a
    /// clock.
    fn ready_after(n: usize, v: &'static str) -> impl Future<Output = &'static str> {
        let mut left = n;
        std::future::poll_fn(move |cx| {
            if left == 0 {
                Poll::Ready(v)
            } else {
                left -= 1;
                cx.waker().wake_by_ref();
                Poll::Pending
            }
        })
    }

    /// Drive a future to completion on this thread, with the no-op waker the standard library
    /// supplies -- so the test needs neither a runtime nor any `unsafe` of its own.
    fn block_on<F: Future>(f: F) -> F::Output {
        let mut f    = Box::pin(f);
        let waker    = std::task::Waker::noop();
        let mut cx   = Context::from_waker(waker);
        loop {
            if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
        }
    }
}
