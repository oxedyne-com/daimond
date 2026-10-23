//! Two futures raced, with no runtime and no `unsafe`: whichever is ready first wins, and the
//! other is dropped where it stands.
//!
//! What a turn's Stop needs on both targets: the model stream reader and each tool call race the
//! turn's [`Halt::fired`](crate::llm::Halt::fired), so a Stop never waits for a byte, a tool or
//! the loop that started them.

use std::{
    future::{
        Future,
        poll_fn,
    },
    pin::pin,
    task::Poll,
};

/// Which of two raced futures finished first, with its output.
#[derive(Debug, PartialEq)]
pub enum Won<A, B> {
    First(A),
    Second(B),
}

/// Run `a` and `b` together until one is ready, then drop the other.  `a` is polled first, so
/// when both are ready at the same poll, `a` wins.
pub async fn race<A: Future, B: Future>(a: A, b: B) -> Won<A::Output, B::Output> {
    let mut a = pin!(a);
    let mut b = pin!(b);
    poll_fn(|cx| {
        if let Poll::Ready(v) = a.as_mut().poll(cx) {
            return Poll::Ready(Won::First(v));
        }
        if let Poll::Ready(v) = b.as_mut().poll(cx) {
            return Poll::Ready(Won::Second(v));
        }
        Poll::Pending
    }).await
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use std::{
        cell::Cell,
        rc::Rc,
        time::Duration,
    };

    /// Sets its flag when dropped, so a test can see the loser was let go.
    struct Dropped(Rc<Cell<bool>>);
    impl Drop for Dropped {
        fn drop(&mut self) { self.0.set(true); }
    }

    #[tokio::test]
    async fn the_quicker_future_wins_and_the_other_is_dropped() {
        let gone = Rc::new(Cell::new(false));
        let guard = Dropped(gone.clone());
        let slow = async move {
            let _held = guard;
            tokio::time::sleep(Duration::from_secs(30)).await;
            1u8
        };
        let quick = async { tokio::time::sleep(Duration::from_millis(10)).await; "stop" };
        assert_eq!(race(slow, quick).await, Won::Second("stop"));
        assert!(gone.get(), "the losing future was not dropped");
        assert_eq!(race(async { 7u8 }, std::future::pending::<()>()).await, Won::First(7));
    }

    #[tokio::test]
    async fn both_ready_at_once_goes_to_the_first() {
        assert_eq!(race(async { 1u8 }, async { 2u8 }).await, Won::First(1));
    }
}
