//! The actor loop under a mock engine: rounds wait on a gate the test opens, so every check is made
//! at a known point of a turn.

use super::*;

use crate::protocol::ChatMessage;

use std::{
    cell::RefCell,
    collections::BTreeMap,
    time::{Duration, Instant},
};

/// The mock's run journal: `(run, round)` to record, and how many puts it took, shared with the rig.
#[derive(Clone, Default)]
struct Journal {
    records:    Rc<RefCell<BTreeMap<(String, u64), Vec<u8>>>>,
    puts:       Rc<Cell<u32>>,
}

impl Journal {
    fn len(&self) -> usize { self.records.borrow().len() }
    fn rounds(&self) -> Vec<u64> { self.records.borrow().keys().map(|(_, r)| *r).collect() }
}

#[derive(Clone, Debug, PartialEq)]
struct Ctl {
    scope: u32,
}

struct MTurn {
    tag:    String,
    rounds: u32,
    /// Fails before its first round, as `open_command` refuses a turn.
    refuse: bool,
    /// Panics before its first round, as a bug in a native turn would.
    panic:  bool,
}

impl Tagged for MTurn {
    fn tag(&self) -> &str { &self.tag }
}

struct MChild {
    tag:    String,
    spend:  u64,
    /// Spend metered before the gate, as a Diamond turn's sink meters each response.
    meter:  u64,
}

impl Tagged for MChild {
    fn tag(&self) -> &str { &self.tag }
}

enum MWrite {
    Restore(u64),
    Append(String),
    /// Refused by the engine, as a write the handle should never have accepted.
    Reject,
}

/// Each round of a turn records `(scope, adopted)` at its head, adds 10 prompt tokens, publishes,
/// and waits for `step`; a child waits for `cstep` and spends `spend` completion tokens.
struct Mock {
    step:   Receiver<()>,
    cstep:  Receiver<()>,
    log:    Sender<(u32, bool)>,
    journal: Journal,
}

impl TurnEngine for Mock {
    type Controls   = Ctl;
    type View       = (u64, u64, usize);
    type Convo      = usize;
    type Usage      = u64;
    type Turn       = MTurn;
    type TurnOut    = usize;
    type Fold       = ();
    type FoldOut    = usize;
    type Child      = MChild;
    type ChildOut   = u64;
    type Write      = MWrite;

    fn view(&self, s: &Session) -> Self::View {
        (s.prompt_tokens, s.completion_tokens, s.messages.len())
    }

    fn convo(&self, s: &Session) -> usize { s.messages.len() }

    async fn turn(&self, session: &mut Session, spec: MTurn, edge: &mut Edge<'_, Self>)
        -> Outcome<usize>
    {
        if spec.refuse {
            return Err(err!("No such command."; Invalid, Input));
        }
        if spec.panic {
            panic!("a turn panicked");
        }
        let seen = session.messages.len();
        session.messages.push(ChatMessage::user(spec.tag.clone()));
        for _ in 0..spec.rounds {
            let adopted = edge.next_round(session);
            let _ = self.log.send((edge.controls().scope, adopted));
            session.prompt_tokens += 10;
            match spec.tag.as_str() {
                // As an event sink does, which cannot reach the session its turn holds.
                "sink"  => edge.publisher().view((777, 0, 0)),
                _       => edge.publish(session),
            }
            if self.step.recv_async().await.is_err() {
                break;
            }
        }
        Ok(seen)
    }

    async fn fold(&self, session: &mut Session, _spec: (), _edge: &mut Edge<'_, Self>)
        -> Outcome<usize>
    {
        Ok(session.messages.len())
    }

    fn child(&self, spec: MChild, meter: Meter<Self>)
        -> impl Future<Output = (Outcome<u64>, u64)> + 'static
    {
        let gate = self.cstep.clone();
        async move {
            if spec.meter > 0 {
                meter.spent(spec.meter);
            }
            let _ = gate.recv_async().await;
            (Ok(spec.spend), spec.spend)
        }
    }

    fn absorb(&self, session: &mut Session, usage: &u64) {
        session.completion_tokens += *usage;
    }

    fn write(&self, session: &mut Session, write: MWrite) -> Outcome<()> {
        match write {
            MWrite::Restore(tokens) => session.prompt_tokens = tokens,
            MWrite::Append(text)    => session.messages.push(ChatMessage::user(text)),
            MWrite::Reject          => return Err(err!("Refused."; Invalid, Input)),
        }
        Ok(())
    }

    fn spawn(task: impl Future<Output = ()> + 'static) {
        tokio::task::spawn_local(task);
    }

    fn journal_record(&self, session: &Session, from: usize) -> Option<Vec<u8>> {
        Some(fmt!("{}..{}", from, session.messages.len()).into_bytes())
    }
    async fn journal_put(&self, run: String, round: u64, record: Vec<u8>) -> Outcome<()> {
        self.journal.records.borrow_mut().insert((run, round), record);
        self.journal.puts.set(self.journal.puts.get() + 1);
        Ok(())
    }
    async fn journal_drop(&self, run: String) -> Outcome<()> {
        self.journal.records.borrow_mut().retain(|(r, _), _| *r != run);
        Ok(())
    }
}

struct Rig {
    step:   Sender<()>,
    cstep:  Sender<()>,
    log:    Receiver<(u32, bool)>,
    journal: Journal,
}

fn rig() -> (Handle<Mock>, Actor<Mock>, Rig) {
    let (step, step_rx) = bounded(16);
    let (cstep, cstep_rx) = bounded(16);
    let (log_tx, log) = bounded(16);
    let journal = Journal::default();
    let mock = Mock { step: step_rx, cstep: cstep_rx, log: log_tx, journal: journal.clone() };
    let session = Session::new(fmt!("s"), fmt!("actor"), fmt!("model"));
    let (handle, actor) = Handle::new(mock, session, Ctl { scope: 1 });
    (handle, actor, Rig { step, cstep, log, journal })
}

fn turn(tag: &str, rounds: u32) -> MTurn {
    MTurn { tag: tag.to_string(), rounds, refuse: false, panic: false }
}

fn snap(h: &Handle<Mock>) -> Snap<Mock> {
    match h.snapshot() {
        Ok(s)   => s,
        Err(e)  => panic!("snapshot: {}", e),
    }
}

fn says<T>(out: Outcome<T>, text: &str) {
    match out {
        Ok(_)   => panic!("expected a refusal saying {:?}", text),
        Err(e)  => assert!(e.to_string().contains(text), "{:?} not in {}", text, e),
    }
}

async fn wait_for(what: &str, mut cond: impl FnMut() -> bool) {
    for _ in 0..2000 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    panic!("timed out waiting for {}", what);
}

async fn logged(rig: &Rig) -> (u32, bool) {
    match tokio::time::timeout(Duration::from_secs(2), rig.log.recv_async()).await {
        Ok(Ok(entry))   => entry,
        _               => panic!("no round head was logged"),
    }
}

fn append(h: &Handle<Mock>, text: &str) -> Outcome<OneshotReceiver<Outcome<()>>> {
    h.write(MWrite::Append(text.to_string()), None, None)
}

async fn local<F: Future>(f: F) -> F::Output {
    tokio::task::LocalSet::new().run_until(f).await
}

#[tokio::test]
async fn full_mailbox_holds_an_async_send_and_refuses_a_sync_one() {
    local(async {
        let (h, actor, _rig) = rig();
        // Writes coalesce into one command, so the mailbox is filled with owed spend instead.
        assert!(append(&h, "m0").is_ok());
        for _ in 1..MAILBOX {
            h.owe(0);
        }
        assert!(append(&h, "m1").is_ok(), "a write behind a queued write took a slot");
        says(h.post_fold(()).map(|_| ()), "engine is busy");
        assert_eq!(0, h.pending(), "a refused post stayed counted");
        let h = Rc::new(h);
        let h2 = h.clone();
        let t = tokio::task::spawn_local(async move { h2.turn(turn("t", 0)).await });
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert!(!t.is_finished(), "the 65th send did not wait");
        assert_eq!(1, h.pending());
        tokio::task::spawn_local(actor.run());
        match tokio::time::timeout(Duration::from_secs(2), t).await {
            Ok(Ok(Ok(seen)))    => assert_eq!(2, seen, "the writes ahead of it did not land first"),
            other               => panic!("the waiting turn never ran: {:?}", other.is_ok()),
        }
        assert_eq!(0, h.pending());
    }).await;
}

#[tokio::test]
async fn construction_burst_fits_the_mailbox() {
    local(async {
        assert!(BURST_MAX <= MAILBOX);
        let (h, _actor, _rig) = rig();
        for i in 0..BURST_MAX {
            assert!(append(&h, &fmt!("b{}", i)).is_ok(), "burst send {} refused", i + 1);
        }
    }).await;
}

#[tokio::test]
async fn a_second_turn_a_fold_and_a_write_are_refused_mid_turn_with_todays_texts() {
    local(async {
        let (h, actor, rig) = rig();
        tokio::task::spawn_local(actor.run());
        let h = Rc::new(h);
        let h2 = h.clone();
        let a = tokio::task::spawn_local(async move { h2.turn(turn("a", 1)).await });
        let _ = logged(&rig).await;
        assert_eq!(RunState::Running, snap(&h).state);
        assert!(h.running("a"));
        says(h.turn(turn("b", 0)).await, BUSY_TURN);
        says(h.fold(()).await, BUSY_FOLD);
        assert_eq!(0, h.pending(), "a refused turn left the pending count up");
        says(append(&h, "mid"), HELD);
        let _ = rig.step.send(());
        match tokio::time::timeout(Duration::from_secs(2), a).await {
            Ok(Ok(Ok(0)))   => (),
            _               => panic!("turn a did not settle cleanly"),
        }
        assert!(!h.running("a"));
        assert!(!h.held());
        assert!(append(&h, "after").is_ok(), "a write after the refused turn was refused");
    }).await;
}

#[tokio::test]
async fn a_write_behind_a_sent_turn_is_refused_and_the_turn_keeps_its_messages() {
    local(async {
        let (h, actor, rig) = rig();
        let h = Rc::new(h);
        let h2 = h.clone();
        // Sent, not yet started: the actor is not running.
        let a = tokio::task::spawn_local(async move { h2.turn(turn("a", 1)).await });
        wait_for("the turn to be sent", || h.pending() == 1).await;
        assert_eq!(RunState::Idle, snap(&h).state);
        says(append(&h, "behind"), HELD);
        says(h.write(MWrite::Restore(9), None, None), HELD);
        tokio::task::spawn_local(actor.run());
        let _ = logged(&rig).await;
        says(append(&h, "during"), HELD);
        let _ = rig.step.send(());
        match tokio::time::timeout(Duration::from_secs(2), a).await {
            Ok(Ok(Ok(0)))   => (),
            _               => panic!("turn a did not settle cleanly"),
        }
        assert_eq!((10, 0, 1), snap(&h).view, "the turn's messages or spend were overwritten");
        match h.convo() {
            Ok(c)   => assert_eq!(1, *c),
            Err(e)  => panic!("{}", e),
        }
    }).await;
}

#[tokio::test]
async fn a_turn_refused_before_its_first_round_returns_pending_to_zero() {
    local(async {
        let (h, actor, _rig) = rig();
        tokio::task::spawn_local(actor.run());
        let out = h.turn(MTurn { tag: fmt!("bad"), rounds: 1, refuse: true, panic: false }).await;
        says(out, "No such command");
        assert_eq!(0, h.pending());
        assert_eq!(RunState::Idle, snap(&h).state);
        assert!(!h.running("bad"));
        assert!(append(&h, "after").is_ok());
    }).await;
}

#[tokio::test]
async fn a_turn_queued_at_shutdown_fails_fast_and_returns_pending_to_zero() {
    local(async {
        let (h, actor, _rig) = rig();
        let h = Rc::new(h);
        let h2 = h.clone();
        let a = tokio::task::spawn_local(async move { h2.turn(turn("a", 1)).await });
        wait_for("the turn to be sent", || h.pending() == 1).await;
        h.shutdown();
        let run = tokio::task::spawn_local(actor.run());
        let t0 = Instant::now();
        match tokio::time::timeout(Duration::from_secs(1), a).await {
            Ok(Ok(out)) => says(out, SHUT),
            _           => panic!("a turn queued at shutdown hung"),
        }
        assert!(t0.elapsed() < Duration::from_millis(100));
        assert_eq!(0, h.pending());
        assert!(tokio::time::timeout(Duration::from_secs(1), run).await.is_ok(), "the loop ran on");
    }).await;
}

#[tokio::test]
async fn shutdown_mid_turn_lets_it_settle_then_ends_the_loop_and_leaves_a_readable_corpse() {
    local(async {
        let (h, actor, rig) = rig();
        let run = tokio::task::spawn_local(actor.run());
        let h = Rc::new(h);
        let h2 = h.clone();
        let a = tokio::task::spawn_local(async move { h2.turn(turn("a", 1)).await });
        let _ = logged(&rig).await;
        h.shutdown();
        let t0 = Instant::now();
        says(h.turn(turn("b", 0)).await, SHUT);
        assert!(t0.elapsed() < Duration::from_millis(100));
        assert_eq!(0, h.pending());
        let _ = rig.step.send(());
        match tokio::time::timeout(Duration::from_secs(2), a).await {
            Ok(Ok(Ok(0)))   => (),
            _               => panic!("the running turn did not settle"),
        }
        assert!(tokio::time::timeout(Duration::from_secs(1), run).await.is_ok(),
            "Shutdown did not end the loop");
        let corpse = snap(&h);
        assert_eq!(RunState::Shut, corpse.state);
        assert_eq!((10, 0, 1), corpse.view, "the getters lost the last published values");
        match h.convo() {
            Ok(c)   => assert_eq!(1, *c),
            Err(e)  => panic!("{}", e),
        }
        let t0 = Instant::now();
        says(h.turn(turn("c", 0)).await, SHUT);
        says(append(&h, "late"), SHUT);
        assert!(t0.elapsed() < Duration::from_millis(100));
        assert_eq!(0, h.pending());
        assert_eq!((10, 0, 1), snap(&h).view);
    }).await;
}

#[tokio::test]
async fn an_idle_write_is_read_at_once_and_lands_ahead_of_the_turn_behind_it() {
    local(async {
        let (h, actor, _rig) = rig();
        tokio::task::spawn_local(actor.run());
        let applied = match h.write(MWrite::Restore(500), Some((500, 0, 0)), Some(0)) {
            Ok(rx)  => rx,
            Err(e)  => panic!("{}", e),
        };
        // The handle published it before returning, ahead of the actor applying it.
        assert_eq!((500, 0, 0), snap(&h).view);
        let _ = append(&h, "restored");
        match h.turn(turn("t", 0)).await {
            Ok(seen)    => assert_eq!(1, seen, "the turn ran ahead of the write queued before it"),
            Err(e)      => panic!("{}", e),
        }
        assert!(matches!(applied.recv().await, Ok(Ok(()))));
        assert_eq!((500, 0, 2), snap(&h).view);
    }).await;
}

#[tokio::test]
async fn a_control_change_mid_turn_is_read_back_at_once_and_adopted_at_the_next_round() {
    local(async {
        let (h, actor, rig) = rig();
        tokio::task::spawn_local(actor.run());
        let h = Rc::new(h);
        let h2 = h.clone();
        let a = tokio::task::spawn_local(async move { h2.turn(turn("a", 3)).await });
        assert_eq!((1, false), logged(&rig).await);
        assert!(h.set_controls(|_| Ctl { scope: 2 }).is_ok(), "a scope change was refused");
        match h.controls() {
            Ok(c)   => assert_eq!(2, c.scope, "the read-back missed the write"),
            Err(e)  => panic!("{}", e),
        }
        let _ = rig.step.send(());
        assert_eq!((2, true), logged(&rig).await, "round two did not adopt the new scope");
        let _ = rig.step.send(());
        assert_eq!((2, false), logged(&rig).await, "round three adopted again");
        let _ = rig.step.send(());
        assert!(tokio::time::timeout(Duration::from_secs(2), a).await.is_ok());
    }).await;
}

#[tokio::test]
async fn the_snapshot_changes_after_every_round_with_the_spend_so_far() {
    local(async {
        let (h, actor, rig) = rig();
        tokio::task::spawn_local(actor.run());
        let h = Rc::new(h);
        let h2 = h.clone();
        let a = tokio::task::spawn_local(async move { h2.turn(turn("a", 3)).await });
        for k in 1..=3u64 {
            let _ = logged(&rig).await;
            wait_for("the round's publish", || snap(&h).view.0 == 10 * k).await;
            let s = snap(&h);
            assert_eq!(k, s.rounds, "round {} crossed no boundary in the snapshot", k);
            assert_eq!(RunState::Running, s.state);
            let _ = rig.step.send(());
        }
        assert!(tokio::time::timeout(Duration::from_secs(2), a).await.is_ok());
        assert_eq!(RunState::Idle, snap(&h).state);
    }).await;
}

#[tokio::test]
async fn a_child_runs_beside_a_turn_counts_as_busy_and_its_spend_is_owed_until_settle() {
    local(async {
        let (h, actor, rig) = rig();
        tokio::task::spawn_local(actor.run());
        let h = Rc::new(h);
        let h2 = h.clone();
        let a = tokio::task::spawn_local(async move { h2.turn(turn("a", 1)).await });
        let _ = logged(&rig).await;
        let h3 = h.clone();
        let c = tokio::task::spawn_local(async move {
            h3.child(MChild { tag: fmt!("c"), spend: 7, meter: 0 }).await
        });
        wait_for("the child to start", || h.children() == 1).await;
        assert!(h.running("c") && h.running("a"));
        let _ = rig.cstep.send(());
        match tokio::time::timeout(Duration::from_secs(2), c).await {
            Ok(Ok(Ok(7)))   => (),
            _               => panic!("the child did not answer beside the turn"),
        }
        let s = snap(&h);
        assert_eq!(vec![7u64], s.owed, "the child's spend was not published mid-turn");
        assert_eq!(0, s.view.1);
        assert!(!h.running("c"));
        wait_for("the child's count to drop", || h.children() == 0).await;
        let _ = rig.step.send(());
        assert!(tokio::time::timeout(Duration::from_secs(2), a).await.is_ok());
        let s = snap(&h);
        assert!(s.owed.is_empty());
        assert_eq!(7, s.view.1, "the owed spend was not folded in at settle");
        // Idle: a child alone makes the conversation busy, but never holds the session.
        let h4 = h.clone();
        let d = tokio::task::spawn_local(async move {
            h4.child(MChild { tag: fmt!("d"), spend: 5, meter: 0 }).await
        });
        wait_for("the second child to start", || h.children() == 1).await;
        assert!(h.busy() && !h.held());
        assert!(append(&h, "beside a child").is_ok());
        let _ = rig.cstep.send(());
        match tokio::time::timeout(Duration::from_secs(2), d).await {
            Ok(Ok(Ok(5)))   => (),
            _               => panic!("the idle child did not answer"),
        }
        assert_eq!(12, snap(&h).view.1, "an idle child's spend was not absorbed before it answered");
        wait_for("the conversation to be idle", || !h.busy()).await;
    }).await;
}

// ── u1bcheck experiments ──

#[tokio::test]
async fn x1_child_spend_landing_after_a_mid_turn_shutdown_is_kept() {
    local(async {
        let (h, actor, rig) = rig();
        let run = tokio::task::spawn_local(actor.run());
        let h = Rc::new(h);
        let h2 = h.clone();
        let a = tokio::task::spawn_local(async move { h2.turn(turn("a", 1)).await });
        let _ = logged(&rig).await;
        let h3 = h.clone();
        let c = tokio::task::spawn_local(async move {
            h3.child(MChild { tag: fmt!("c"), spend: 7, meter: 0 }).await
        });
        wait_for("the child", || h.children() == 1).await;
        h.shutdown();
        let _ = rig.cstep.send(());
        let cout = tokio::time::timeout(Duration::from_secs(2), c).await;
        let _ = rig.step.send(());
        let _ = tokio::time::timeout(Duration::from_secs(2), a).await;
        let _ = tokio::time::timeout(Duration::from_secs(1), run).await;
        let s = snap(&h);
        let owed: u64 = s.owed.iter().sum();
        let ok = matches!(cout, Ok(Ok(Ok(7))));
        assert_eq!(7, s.view.1 + owed, "X1 spend lost (child answered Ok(7)={}): {:?}", ok, s);
        assert!(!h.running("c"), "X1 corpse lists the finished child as running");
    }).await;
}

#[tokio::test]
async fn x2_child_alive_when_the_actor_ends_keeps_its_spend() {
    local(async {
        let (h, actor, rig) = rig();
        let run = tokio::task::spawn_local(actor.run());
        let h = Rc::new(h);
        let h3 = h.clone();
        let c = tokio::task::spawn_local(async move {
            h3.child(MChild { tag: fmt!("c"), spend: 7, meter: 0 }).await
        });
        wait_for("the child", || h.children() == 1).await;
        h.shutdown();
        assert!(tokio::time::timeout(Duration::from_secs(1), run).await.is_ok());
        let _ = rig.cstep.send(());
        let cout = tokio::time::timeout(Duration::from_secs(2), c).await;
        let ok = matches!(cout, Ok(Ok(Ok(7))));
        let s = snap(&h);
        let owed: u64 = s.owed.iter().sum();
        assert_eq!(7, s.view.1 + owed, "X2 spend lost (child answered Ok(7)={}): {:?}", ok, s);
        assert!(!h.running("c"), "X2 corpse lists the finished child as running");
    }).await;
}

#[tokio::test]
async fn x3_a_dropped_send_after_delivery_does_not_uncount_another_turn() {
    local(async {
        let (h, actor, rig) = rig();
        for i in 0..MAILBOX {
            assert!(append(&h, &format!("w{}", i)).is_ok());
        }
        let mut f1 = Box::pin(h.turn(turn("a", 1)));
        let mut f2 = Box::pin(h.turn(turn("b", 0)));
        poll_fn(|cx| {
            let _ = f1.as_mut().poll(cx);
            let _ = f2.as_mut().poll(cx);
            Poll::Ready(())
        }).await;
        assert_eq!(2, h.pending());
        tokio::task::spawn_local(actor.run());
        let _ = logged(&rig).await;
        wait_for("b dequeued", || h.pending() == 0).await;
        let mut f3 = Box::pin(h.turn(turn("c", 0)));
        poll_fn(|cx| { let _ = f3.as_mut().poll(cx); Poll::Ready(()) }).await;
        assert_eq!(1, h.pending(), "c not counted");
        drop(f2);
        assert_eq!(1, h.pending(), "X3 dropping a delivered send uncounted turn c, still queued");
    }).await;
}

/// A write the handle published early but the engine refused leaves the session's truth in the
/// snapshot and the conversation, not the handle's guess (D4).
#[tokio::test]
async fn d4_a_refused_idle_write_is_replaced_by_the_sessions_truth() {
    local(async {
        let (h, actor, _rig) = rig();
        tokio::task::spawn_local(actor.run());
        let applied = match h.write(MWrite::Reject, Some((777, 7, 7)), Some(7)) {
            Ok(rx)  => rx,
            Err(e)  => panic!("{}", e),
        };
        assert_eq!((777, 7, 7), snap(&h).view);
        assert!(matches!(applied.recv().await, Ok(Err(_))), "the engine took the write");
        assert_eq!((0, 0, 0), snap(&h).view, "the refused write's view stayed published");
        match h.convo() {
            Ok(c)   => assert_eq!(0, *c, "the refused write's conversation stayed published"),
            Err(e)  => panic!("{}", e),
        }
    }).await;
}

/// A turn that panics on a native `LocalSet` drops the actor mid-turn; the corpse it leaves reads
/// Shut, not Running for ever (D5).
#[tokio::test]
async fn d5_a_panicking_turn_leaves_a_shut_corpse_not_a_running_one() {
    local(async {
        let (h, actor, _rig) = rig();
        tokio::task::spawn_local(actor.run());
        let out = h.turn(MTurn { tag: fmt!("boom"), rounds: 1, refuse: false, panic: true }).await;
        says(out, SHUT);
        wait_for("the corpse to read shut", || h.is_shut()).await;
        assert_eq!(RunState::Shut, snap(&h).state);
        assert!(!h.held(), "a panicked turn left the session held");
        assert!(!h.busy());
    }).await;
}

/// An event inside a round publishes through a [`Publisher`], which needs no session: the sink of
/// a turn runs while that turn holds the session mutably (U1c).
#[tokio::test]
async fn u1c_a_publisher_publishes_mid_round_without_the_session() {
    local(async {
        let (h, actor, rig) = rig();
        tokio::task::spawn_local(actor.run());
        let h = Rc::new(h);
        let h2 = h.clone();
        let a = tokio::task::spawn_local(async move { h2.turn(turn("sink", 1)).await });
        let _ = logged(&rig).await;
        wait_for("the sink's publish", || snap(&h).view.0 == 777).await;
        assert_eq!(RunState::Running, snap(&h).state);
        let _ = rig.step.send(());
        assert!(tokio::time::timeout(Duration::from_secs(2), a).await.is_ok());
        assert_eq!(10, snap(&h).view.0, "settle did not publish the session's truth");
    }).await;
}

/// Spend made outside the actor's turns and children is read at once as owed, folded into the
/// session when idle, and folded at settle when a turn holds it (U1c, until U1d makes every Diamond
/// turn a child).
#[tokio::test]
async fn u1c_spend_owed_from_outside_is_read_at_once_and_folded_when_the_session_is_free() {
    local(async {
        let (h, actor, rig) = rig();
        tokio::task::spawn_local(actor.run());
        h.owe(5);
        assert_eq!(vec![5u64], snap(&h).owed, "owed spend was not read at once");
        wait_for("the idle fold", || snap(&h).view.1 == 5 && snap(&h).owed.is_empty()).await;
        let h = Rc::new(h);
        let h2 = h.clone();
        let a = tokio::task::spawn_local(async move { h2.turn(turn("a", 1)).await });
        let _ = logged(&rig).await;
        h.owe(7);
        tokio::task::yield_now().await;
        assert_eq!(vec![7u64], snap(&h).owed, "spend owed mid-turn was folded under the turn");
        assert_eq!(5, snap(&h).view.1);
        let _ = rig.step.send(());
        assert!(tokio::time::timeout(Duration::from_secs(2), a).await.is_ok());
        let s = snap(&h);
        assert_eq!((12, true), (s.view.1, s.owed.is_empty()), "settle did not fold what was owed");
    }).await;
}

#[tokio::test]
async fn u1c_a_turn_posted_is_counted_before_anything_is_polled() {
    local(async {
        let (h, actor, rig) = rig();
        // A wasm export's body runs only when its promise is first polled, so the page's very next
        // synchronous call must already see the turn as held.
        let answer = match h.post_turn(turn("a", 1)) {
            Ok(a)   => a,
            Err(e)  => panic!("{}", e),
        };
        assert_eq!(1, h.pending(), "a posted turn was not counted at once");
        says(append(&h, "straight after"), HELD);
        tokio::task::spawn_local(actor.run());
        let _ = logged(&rig).await;
        let _ = rig.step.send(());
        match tokio::time::timeout(Duration::from_secs(2), answer.recv()).await {
            Ok(Ok(Ok(0)))   => (),
            _               => panic!("the posted turn did not settle cleanly"),
        }
        assert_eq!(0, h.pending());
        let fold = match h.post_fold(()) {
            Ok(a)   => a,
            Err(e)  => panic!("{}", e),
        };
        assert_eq!(1, h.pending(), "a posted fold was not counted at once");
        drop(fold);
        h.shutdown();
        says(h.post_turn(turn("b", 1)).map(|_| ()), SHUT);
    }).await;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// U1C part 3: a synchronous write burst
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// The page's reconcile appends in one synchronous loop, unbounded, then sends a turn.  Every
/// append is held and the turn runs behind them all.
#[tokio::test]
async fn u1c_a_synchronous_burst_of_writes_is_held_whole_and_the_turn_behind_it_runs() {
    local(async {
        let (h, actor, _rig) = rig();
        tokio::task::spawn_local(actor.run());
        let mut replies = Vec::new();
        for i in 0..200 {
            match append(&h, &fmt!("m{}", i)) {
                Ok(rx)  => replies.push(rx),
                Err(e)  => panic!("append {} of 200 refused: {}", i + 1, e),
            }
        }
        let answer = match h.post_turn(turn("t", 0)) {
            Ok(a)   => a,
            Err(e)  => panic!("the turn behind the burst was refused: {}", e),
        };
        says(append(&h, "behind the turn"), HELD);
        match tokio::time::timeout(Duration::from_secs(2), answer.recv()).await {
            Ok(Ok(Ok(seen)))    => assert_eq!(200, seen, "the turn did not see every append"),
            _                   => panic!("the turn behind the burst did not run"),
        }
        for rx in replies {
            assert!(matches!(rx.recv().await, Ok(Ok(()))), "an append was not applied");
        }
        assert_eq!(201, snap(&h).view.2);
        assert_eq!(0, h.pending());
    }).await;
}

/// A child's spend so far is read while it runs, beside the turn's or alone, and replaced by its
/// final spend, never added to it, when it ends (U1d: a steer bills each round, not at its end).
#[tokio::test]
async fn u1d_a_child_meters_its_spend_while_it_runs_and_its_end_replaces_it() {
    local(async {
        let (h, actor, rig) = rig();
        tokio::task::spawn_local(actor.run());
        let h = Rc::new(h);
        let h2 = h.clone();
        let c = tokio::task::spawn_local(async move {
            h2.child(MChild { tag: fmt!("m"), spend: 9, meter: 4 }).await
        });
        wait_for("the child's metered spend", || snap(&h).flying.len() == 1).await;
        let s = snap(&h);
        assert_eq!(vec![4u64], s.flying.iter().map(|(_, u)| *u).collect::<Vec<_>>());
        assert_eq!(0, s.view.1, "metered spend was absorbed before the child ended");
        let _ = rig.cstep.send(());
        match tokio::time::timeout(Duration::from_secs(2), c).await {
            Ok(Ok(Ok(9)))   => (),
            _               => panic!("the metered child did not answer"),
        }
        let s = snap(&h);
        assert!(s.flying.is_empty(), "the child's meter outlived it: {:?}", s.flying);
        assert_eq!(9, s.view.1, "the end did not replace the meter");
    }).await;
}

/// Waits up to a second for the journal to hold `n` records, then says what it holds.
async fn journal_holds(rig: &Rig, n: usize) -> usize {
    for _ in 0..1000 {
        if rig.journal.len() == n {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    rig.journal.len()
}

/// U4c: a run killed in its third round leaves its two SETTLED rounds journalled, and only them.
#[tokio::test]
async fn u4c_a_run_killed_in_round_three_leaves_exactly_two_records() {
    local(async {
        let (h, actor, rig) = rig();
        let run = tokio::task::spawn_local(actor.run());
        let _out = match h.post_turn(turn("t", 3)) {
            Ok(rx)  => rx,
            Err(e)  => panic!("post_turn: {}", e),
        };
        let _ = logged(&rig).await;
        let _ = rig.step.send(());
        let _ = logged(&rig).await;
        let _ = rig.step.send(());
        // The third round's head: rounds 1 and 2 have settled, round 3 is running.
        let _ = logged(&rig).await;
        let held = journal_holds(&rig, 2).await;
        // The tab dies mid-round.
        run.abort();
        let _ = run.await;
        println!("u4c killed in round 3: {} records, rounds {:?}", rig.journal.len(), rig.journal.rounds());
        assert_eq!(2, held, "killed in round 3: {} records, want 2", held);
        assert_eq!(vec![1u64, 2], rig.journal.rounds());
    }).await;
}

/// U4c: a turn that settles leaves no journal, though each of its settled rounds was written.
#[tokio::test]
async fn u4c_settle_leaves_no_records() {
    local(async {
        let (h, actor, rig) = rig();
        tokio::task::spawn_local(actor.run());
        let out = match h.post_turn(turn("t", 3)) {
            Ok(rx)  => rx,
            Err(e)  => panic!("post_turn: {}", e),
        };
        for _ in 0..3 {
            let _ = logged(&rig).await;
            let _ = rig.step.send(());
        }
        match tokio::time::timeout(Duration::from_secs(2), out.recv()).await {
            Ok(Ok(Ok(_)))   => (),
            _               => panic!("the turn did not settle"),
        }
        println!("u4c settle: {} puts, {} records left", rig.journal.puts.get(), rig.journal.len());
        assert_eq!(2, rig.journal.puts.get(), "settled rounds written");
        assert_eq!(0, rig.journal.len(), "records left after settle");
    }).await;
}

/// U4c: a report's ack drops what an earlier, killed run left; mid-turn it leaves the running
/// turn's own records alone.
#[tokio::test]
async fn u4c_report_ack_leaves_no_records() {
    local(async {
        let (h, actor, rig) = rig();
        rig.journal.records.borrow_mut().insert((fmt!("s"), 1), b"r1".to_vec());
        rig.journal.records.borrow_mut().insert((fmt!("s"), 2), b"r2".to_vec());
        rig.journal.records.borrow_mut().insert((fmt!("other"), 1), b"o1".to_vec());
        tokio::task::spawn_local(actor.run());
        if let Err(e) = h.report_acked().await {
            panic!("report_acked: {}", e);
        }
        println!("u4c report ack: {} records of run s left", rig.journal.len() - 1);
        assert_eq!(1, rig.journal.len(), "the run's records outlived its report's ack");
        assert_eq!(vec![(fmt!("other"), 1u64)], rig.journal.records.borrow().keys().cloned()
            .collect::<Vec<_>>(), "another run's journal was dropped");
        // Mid-turn the journal is the running turn's, so an ack leaves it.
        let out = match h.post_turn(turn("t", 2)) {
            Ok(rx)  => rx,
            Err(e)  => panic!("post_turn: {}", e),
        };
        let _ = logged(&rig).await;
        let _ = rig.step.send(());
        let _ = logged(&rig).await;
        assert_eq!(2, journal_holds(&rig, 2).await, "round 1 not journalled");
        if let Err(e) = h.report_acked().await {
            panic!("report_acked mid-turn: {}", e);
        }
        assert_eq!(2, rig.journal.len(), "an ack mid-turn dropped the running turn's journal");
        let _ = rig.step.send(());
        let _ = tokio::time::timeout(Duration::from_secs(2), out.recv()).await;
        assert_eq!(1, rig.journal.len(), "settle left the run's records");
    }).await;
}
