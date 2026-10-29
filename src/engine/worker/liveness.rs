//! The last-progress clock of a turn: whether its model stream is still saying anything.
//!
//! **ONLY THE STREAM BEATS IT** (U3a plan rev 2, ruling 1).  Every line the model stream
//! delivers is progress -- a keep-alive comment included, because a provider that sends one is
//! still holding the request -- and nothing else is: a tool call is bounded by its own ceiling
//! (`compact::TOOL_CEILING_DEFAULT_MS` plus `compact::TOOL_CEILING_MARGIN_MS`), never by this.
//! [`StreamWatch::heard`](crate::llm::StreamWatch) and its `data` beat the turn's `Liveness`;
//! the turn's model call is raced against [`Liveness::due_at`] (LV2).
//!
//! Pure and clock-injected: every method is handed `now` in milliseconds, so the tests need no
//! timer and the two targets read their own clocks.  Shared on clone, so the stream that beats
//! it and the turn that races it hold one clock.

use std::{
    cell::Cell,
    rc::Rc,
};

/// A turn's last-progress clock and its limit `N`, both shared on clone.
#[derive(Clone, Debug)]
pub struct Liveness {
    last:  Rc<Cell<u64>>,   // clock at the last progress, or at the start
    limit: Rc<Cell<u64>>,   // N: the most a turn may go without progress, in ms
    hold:  Rc<Cell<u64>>,   // while non-zero, not due before this: a reply being waited for
}

impl Liveness {

    /// A clock with limit `limit_ms`, last beaten at `now`.
    pub fn new(limit_ms: u64, now: u64) -> Self {
        Self {
            last:  Rc::new(Cell::new(now)),
            limit: Rc::new(Cell::new(limit_ms.max(1))),
            hold:  Rc::new(Cell::new(0)),
        }
    }

    /// Progress was heard at `now`.  A beat from before the last one is ignored, so two clocks
    /// read a hair apart cannot move it back.
    pub fn beat(&self, now: u64) {
        if now > self.last.get() { self.last.set(now); }
    }

    /// When the turn is due to have shown progress by, in the clock's milliseconds.
    pub fn due_at(&self) -> u64 {
        self.last.get().saturating_add(self.limit.get()).max(self.hold.get())
    }

    /// A reply is being waited for, which is not a silent model: the turn is not due before
    /// `until`, the wait's own ceiling (U3a LV2).  See [`ReplyHold`].
    pub fn hold_until(&self, until: u64) {
        self.hold.set(until);
    }

    /// The reply arrived, or the wait for it ended, at `now`: the hold goes and that is a beat.
    pub fn release(&self, now: u64) {
        self.hold.set(0);
        self.beat(now);
    }

    /// Has the turn gone its whole limit without progress?
    pub fn expired(&self, now: u64) -> bool {
        now >= self.due_at()
    }

    /// The limit `N`, in milliseconds.
    pub fn limit_ms(&self) -> u64 {
        self.limit.get()
    }

    /// Set the limit `N`; nought is taken as one millisecond, never as "no limit".
    pub fn set_limit_ms(&self, ms: u64) {
        self.limit.set(ms.max(1));
    }
}

/// THE WAIT FOR A REPLY IS NOT SILENCE (U3a LV2).  Until a provider has answered at all, no line
/// can beat the clock, and a provider that answers a streaming request with one whole body
/// (see `SseLines`) sends nothing until its whole answer is written.  So from the request until
/// the reply is in hand -- the headers of a stream, or the whole of a body -- the clock is held
/// to the wait's own ceiling, `REPLY_WAIT_FACTOR` x the idle figure, outside the liveness race,
/// and the reply's arrival is a beat.  Released when dropped, so every way out of the read
/// lets the hold go.
pub struct ReplyHold {
    live: Option<Liveness>,
}

impl ReplyHold {

    /// Hold `live` until `until`, if the turn has a clock.
    pub fn new(live: Option<Liveness>, until: u64) -> Self {
        if let Some(l) = &live { l.hold_until(until); }
        Self { live }
    }

    /// The reply arrived at `now`: release the hold and beat.
    pub fn release(&mut self, now: u64) {
        if let Some(l) = self.live.take() { l.release(now); }
    }
}

impl Drop for ReplyHold {
    fn drop(&mut self) {
        self.release(crate::llm::now_ms());
    }
}

#[cfg(test)]
#[path = "../../../tests/unit/engine/worker/liveness/tests.rs"]
mod tests;
