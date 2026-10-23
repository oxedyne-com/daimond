//! The session actor: one owner per conversation, so no session is ever borrowed across an await.
//!
//! A conversation's [`Session`] lives in one task, the [`Actor`], which takes work from a mailbox
//! bounded at [`MAILBOX`].  The [`Handle`] the page holds has no session at all: it sends
//! [`Cmd`]s, writes the control cell and reads the [`Snapshot`] the actor publishes.  While a turn
//! runs the loop races it against the mailbox, so a second turn or a session write is refused at
//! once, exactly as the borrow refused it before, and a Diamond turn ([`Cmd::Child`]) still starts
//! beside it.  Nothing is deferred.
//!
//! Generic over [`TurnEngine`], so the loop is tested natively with a mock.  The browser's engine
//! and its `spawn_local` glue live under `crate::wasm`.

use crate::{
    agent::Boundary,
    protocol::Session,
    tools::ToolRegistry,
};

use oxedyne_fe2o3_core::{
    prelude::*,
    channels::{
        bounded,
        oneshot,
        watch,
        OneshotReceiver,
        OneshotSender,
        Receiver,
        Sender,
        TrySendError,
        WatchReceiver,
        WatchSender,
    },
};

use std::{
    cell::Cell,
    collections::VecDeque,
    future::{poll_fn, Future},
    pin::pin,
    rc::Rc,
    task::Poll,
};

/// The mailbox bound.  A full mailbox makes an async sender wait and a sync sender throw.
pub const MAILBOX: usize = 64;
/// The most commands a handle's construction may send before the actor first runs.
pub const BURST_MAX: usize = 20;

/// The refusal of a turn started on a conversation already in one (today's `run_turn` text).
pub const BUSY_TURN: &str =
    "This conversation is in the middle of a turn, so another cannot start on it.";
/// The refusal of a hand fold mid-turn (today's `fold_now` text).
pub const BUSY_FOLD: &str =
    "This chat is in the middle of a turn; wait for it to finish before folding by hand.";
/// The refusal of a session write mid-turn, or behind a turn already sent (`Session::write_held`).
pub const HELD: &str = "The session is held by a turn in flight, so it cannot be changed now.";
/// The refusal of a sync send to a full mailbox.
pub const FULL: &str =
    "This conversation's engine is busy: its mailbox is full, so try again in a moment.";
/// The answer to every command after a shutdown.
pub const SHUT: &str =
    "This conversation's engine was shut down; it will be rebuilt on its next turn.";

fn shut_err() -> Error<ErrTag> {
    err!("{}", SHUT; Channel, Missing)
}

/// Names the turn a spec starts, for the snapshot's running tags and the Stop cell.
pub trait Tagged {
    fn tag(&self) -> &str;
}

/// Controls that carry the tool registry a turn runs under.
pub trait Registered {
    fn registry(&self) -> Rc<ToolRegistry>;
}

/// What the actor drives: the agent and how each command acts on the session it owns.
///
/// `turn` and `fold` borrow the session for their whole run, so the actor answers the mailbox
/// beside them; `child` must not borrow it at all, since a Diamond turn runs beside the actor's
/// own on a fresh session of its own, and returns what it spent for [`TurnEngine::absorb`].
#[allow(async_fn_in_trait)]
pub trait TurnEngine: Sized + 'static {
    type Controls:  'static;
    type View:      Clone + 'static;
    type Convo:     'static;
    type Usage:     Clone + 'static;
    type Turn:      Tagged;
    type TurnOut;
    type Fold;
    type FoldOut;
    type Child:     Tagged;
    type ChildOut:  'static;
    /// `Restore`, `RestoreSession` and `Append`.
    type Write;

    fn view(&self, session: &Session) -> Self::View;
    fn convo(&self, session: &Session) -> Self::Convo;
    async fn turn(&self, session: &mut Session, spec: Self::Turn, edge: &mut Edge<'_, Self>)
        -> Outcome<Self::TurnOut>;
    async fn fold(&self, session: &mut Session, spec: Self::Fold, edge: &mut Edge<'_, Self>)
        -> Outcome<Self::FoldOut>;
    fn child(&self, spec: Self::Child, meter: Meter<Self>)
        -> impl Future<Output = (Outcome<Self::ChildOut>, Self::Usage)> + 'static;
    fn absorb(&self, session: &mut Session, usage: &Self::Usage);
    /// Applies a write the handle has already validated and published.  The contract (D4): the
    /// handle checks everything a write can fail on before it accepts one, and computes the `view`
    /// and `convo` it publishes with the same pure function this applies, so the two agree and
    /// this fails only on an impossible state.  Should it fail, the actor publishes the session's
    /// truth over the handle's early view at once.
    fn write(&self, session: &mut Session, write: Self::Write) -> Outcome<()>;
    /// Runs a task on the actor's own thread: `spawn_local` in the browser, a `LocalSet` natively.
    fn spawn(task: impl Future<Output = ()> + 'static);

    // The run journal (U4c, spec §4.4): SETTLED ROUNDS ONLY, one record per round, under the
    // session's id.  A round is settled at the head of the next, when everything it added is in
    // the session; the round a turn dies in is never journalled.  The actor drops the journal
    // when its turn settles, and on a report's ack.  An engine that keeps no journal answers
    // `None` here and is never asked to write.

    /// The record of one settled round: what it added to the session, `session.messages[from..]`.
    fn journal_record(&self, _session: &Session, _from: usize) -> Option<Vec<u8>> { None }
    /// Writes round `round` (from 1) of run `run`.
    async fn journal_put(&self, _run: String, _round: u64, _record: Vec<u8>) -> Outcome<()> {
        Ok(())
    }
    /// Drops every record of run `run`.
    async fn journal_drop(&self, _run: String) -> Outcome<()> { Ok(()) }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunState {
    Idle,
    /// The actor's own turn or hand fold is running.
    Running,
    Shut,
}

/// What the actor last published: every getter reads this, never the session.
#[derive(Clone, Debug)]
pub struct Snapshot<V, U> {
    pub state:  RunState,
    /// The turns running now, by tag: the actor's own and every child's.
    pub tags:   Vec<String>,
    /// Round boundaries crossed since the actor began, so a reader sees each round end.
    pub rounds: u64,
    pub view:   V,
    /// Child spend that landed while a turn held the session, folded into it at settle.  A
    /// counter getter is `view` plus this, plus `flying`.
    pub owed:   Vec<U>,
    /// What each child still running has spent so far, by child: replaced by its final spend, in
    /// one publish, when it ends.
    pub flying: Vec<(u64, U)>,
}

pub type Snap<E> = Snapshot<<E as TurnEngine>::View, <E as TurnEngine>::Usage>;

pub enum Cmd<E: TurnEngine> {
    StartTurn(E::Turn, OneshotSender<Outcome<E::TurnOut>>, Ticket<E>),
    FoldNow(E::Fold, OneshotSender<Outcome<E::FoldOut>>, Ticket<E>),
    /// `Steer` and `FoldPropose`: a Diamond turn, run beside the actor's own.
    Child(E::Child, OneshotSender<Outcome<E::ChildOut>>, Ticket<E>),
    /// Apply the writes queued in [`Shared::writes`].  At most one is ever in the mailbox, so a
    /// synchronous burst of writes costs one slot however long it runs.
    Write,
    /// A child's end, carrying its spend.  Sent only by the actor's own child tasks.
    UsageDelta(Settled<E>),
    /// Spend [`Handle::owe`] put in the snapshot: folded into the session if no turn holds it.
    Owed,
    /// The run's report was delivered and acknowledged: its journal goes.
    Acked(OneshotSender<Outcome<()>>),
    Shutdown,
}

/// A finished child, answered once its spend is published.
pub struct Settled<E: TurnEngine> {
    id:     u64,
    tag:    String,
    usage:  E::Usage,
    out:    Outcome<E::ChildOut>,
    reply:  OneshotSender<Outcome<E::ChildOut>>,
    _live:  Live<E>,
}

/// What the handle and the actor share.  Single-threaded: plain cells, no `RefCell`.
struct Shared<E: TurnEngine> {
    snap:       WatchSender<Snap<E>>,
    convo:      WatchSender<Rc<E::Convo>>,
    /// Turn-kind commands sent and not yet dequeued.
    pending:    Cell<u32>,
    /// Child tasks alive.
    children:   Cell<u32>,
    /// The id the next child is metered under.
    next_child: Cell<u64>,
    shut:       Cell<bool>,
    /// Idle writes accepted and not yet applied, oldest first.  Non-empty exactly while a
    /// [`Cmd::Write`] is in the mailbox: the first write sends it, the actor's dequeue takes them.
    writes:     Cell<Vec<(E::Write, OneshotSender<Outcome<()>>)>>,
    /// Settled rounds a turn's edge has journalled and the actor has not yet written, oldest
    /// first: `(run, round, record)`.
    journal:    Cell<VecDeque<(String, u64, Vec<u8>)>>,
}

impl<E: TurnEngine> Shared<E> {

    /// Publishes a changed copy of the snapshot.  A failure is a poisoned lock on a cell only this
    /// thread holds, so there is nothing to recover; the next publish tries again.
    fn update(&self, f: impl FnOnce(&mut Snap<E>)) {
        let mut next = match self.snap.borrow() {
            Ok(now) => (*now).clone(),
            Err(_)  => return,
        };
        f(&mut next);
        let _ = self.snap.send(next);
    }

    /// Child spend that cannot be absorbed now: held in the snapshot, its tag and meter cleared.
    fn owe(&self, id: u64, tag: &str, usage: E::Usage) {
        self.update(|s| {
            s.owed.push(usage);
            s.flying.retain(|(c, _)| *c != id);
            if let Some(i) = s.tags.iter().position(|t| t == tag) {
                s.tags.remove(i);
            }
        });
    }

    fn queue_round(&self, round: (String, u64, Vec<u8>)) {
        let mut q = self.journal.take();
        q.push_back(round);
        self.journal.set(q);
    }

    fn next_round(&self) -> Option<(String, u64, Vec<u8>)> {
        let mut q = self.journal.take();
        let next = q.pop_front();
        self.journal.set(q);
        next
    }

    /// Answers every queued write with `err`.
    fn refuse_writes(&self, err: impl Fn() -> Error<ErrTag>) {
        for (_, reply) in self.writes.take() {
            let _ = reply.send(Err(err()));
        }
    }
}

/// A turn-kind command's place in `pending`: counted while the message exists, uncounted when it
/// is dropped -- dequeued, refused, or never delivered -- exactly once.
pub struct Ticket<E: TurnEngine>(Rc<Shared<E>>);

impl<E: TurnEngine> Ticket<E> {
    fn new(shared: &Rc<Shared<E>>) -> Self {
        shared.pending.set(shared.pending.get() + 1);
        Self(shared.clone())
    }
}

impl<E: TurnEngine> Drop for Ticket<E> {
    fn drop(&mut self) {
        self.0.pending.set(self.0.pending.get().saturating_sub(1));
    }
}

/// One live child, counted for as long as it, or its unanswered `UsageDelta`, exists.
pub struct Live<E: TurnEngine>(Rc<Shared<E>>);

impl<E: TurnEngine> Live<E> {
    fn new(shared: &Rc<Shared<E>>) -> Self {
        shared.children.set(shared.children.get() + 1);
        Self(shared.clone())
    }
}

impl<E: TurnEngine> Drop for Live<E> {
    fn drop(&mut self) {
        self.0.children.set(self.0.children.get().saturating_sub(1));
    }
}

/// The round boundary a turn crosses: publishes the snapshot and adopts the newest controls.
pub struct Edge<'a, E: TurnEngine> {
    engine: &'a E,
    ctl:    &'a WatchReceiver<Rc<E::Controls>>,
    now:    Rc<E::Controls>,
    shared: &'a Rc<Shared<E>>,
    /// The run the journal keys this turn's rounds by: the session's id.
    run:    String,
    /// Round heads crossed: at the head of round `n + 1`, round `n` has settled.
    heads:  u64,
    /// The session's length at the last head, where the settling round's additions begin.
    seen:   usize,
}

/// Publishes what one running child has spent so far, so a getter read mid-child is the real
/// figure: each call replaces the last, and the child's end replaces the meter.
pub struct Meter<E: TurnEngine> {
    shared: Rc<Shared<E>>,
    id:     u64,
}

impl<E: TurnEngine> Meter<E> {
    pub fn spent(&self, usage: E::Usage) {
        let id = self.id;
        self.shared.update(|s| match s.flying.iter_mut().find(|(c, _)| *c == id) {
            Some(slot)  => slot.1 = usage,
            None        => s.flying.push((id, usage)),
        });
    }
}

/// Publishes a turn's view from where its session cannot be reached: the event sink, called while
/// the turn holds the session mutably.
pub struct Publisher<E: TurnEngine>(Rc<Shared<E>>);

impl<E: TurnEngine> Publisher<E> {
    pub fn view(&self, view: E::View) {
        self.0.update(|s| s.view = view);
    }
}

impl<'a, E: TurnEngine> Edge<'a, E> {

    fn new(
        engine: &'a E,
        ctl:    &'a WatchReceiver<Rc<E::Controls>>,
        shared: &'a Rc<Shared<E>>,
        run:    String,
    )
        -> Outcome<Self>
    {
        let now = res!(ctl.borrow()).clone();
        Ok(Self { engine, ctl, now, shared, run, heads: 0, seen: 0 })
    }

    /// The controls this turn runs under: the newest at its start or at its last round boundary.
    pub fn controls(&self) -> &Rc<E::Controls> { &self.now }

    /// What an event sink publishes through.
    pub fn publisher(&self) -> Publisher<E> { Publisher(self.shared.clone()) }

    /// Publishes the session's view without crossing a round, for an event inside one.
    pub fn publish(&self, session: &Session) {
        let view = self.engine.view(session);
        self.shared.update(|s| s.view = view);
    }

    /// Crosses a round boundary: publishes the view, and adopts the controls if the handle has
    /// written newer ones since this turn last looked.  Is there a newer set?
    pub fn next_round(&mut self, session: &Session) -> bool {
        // THE ROUND BEFORE THIS HEAD HAS SETTLED: everything it added is in the session, so it is
        // journalled now, and only now.  The round a turn dies in never reaches a head.
        self.heads += 1;
        if self.heads > 1 {
            if let Some(record) = self.engine.journal_record(session, self.seen) {
                self.shared.queue_round((self.run.clone(), self.heads - 1, record));
            }
        }
        self.seen = session.messages.len();
        let view = self.engine.view(session);
        self.shared.update(|s| {
            s.view = view;
            s.rounds += 1;
        });
        let newest = match self.ctl.borrow() {
            Ok(c)   => (*c).clone(),
            Err(_)  => return false,
        };
        if Rc::ptr_eq(&newest, &self.now) {
            return false;
        }
        self.now = newest;
        true
    }
}

impl<E: TurnEngine> Boundary for Edge<'_, E> where E::Controls: Registered {
    fn round(&mut self, session: &Session) -> Option<Rc<ToolRegistry>> {
        match self.next_round(session) {
            true    => Some(self.now.registry()),
            false   => None,
        }
    }
}

/// The page's side: sends commands, writes the control cell, reads the snapshot.  Never holds the
/// session, so no method borrows anything across an await.
pub struct Handle<E: TurnEngine> {
    tx:     Sender<Cmd<E>>,
    ctl:    WatchSender<Rc<E::Controls>>,
    shared: Rc<Shared<E>>,
}

/// The loop that owns the session.  Run it with [`Actor::run`] on the handle's thread.
pub struct Actor<E: TurnEngine> {
    engine:     E,
    session:    Session,
    rx:         Receiver<Cmd<E>>,
    tx:         Sender<Cmd<E>>,
    ctl:        WatchReceiver<Rc<E::Controls>>,
    shared:     Rc<Shared<E>>,
}

impl<E: TurnEngine> Handle<E> {

    /// A handle and its actor, not yet running, so construction can queue its first commands.
    pub fn new(engine: E, session: Session, controls: E::Controls) -> (Self, Actor<E>) {
        let (tx, rx) = bounded(MAILBOX);
        let (ctl, ctl_rx) = watch(Rc::new(controls));
        let (snap, _) = watch(Snapshot {
            state:  RunState::Idle,
            tags:   Vec::new(),
            rounds: 0,
            view:   engine.view(&session),
            owed:   Vec::new(),
            flying: Vec::new(),
        });
        let (convo, _) = watch(Rc::new(engine.convo(&session)));
        let shared = Rc::new(Shared {
            snap,
            convo,
            pending:    Cell::new(0),
            children:   Cell::new(0),
            next_child: Cell::new(0),
            shut:       Cell::new(false),
            writes:     Cell::new(Vec::new()),
            journal:    Cell::new(VecDeque::new()),
        });
        let actor = Actor { engine, session, rx, tx: tx.clone(), ctl: ctl_rx, shared: shared.clone() };
        (Self { tx, ctl, shared }, actor)
    }

    /// A handle whose actor is already spawned.
    pub fn spawn(engine: E, session: Session, controls: E::Controls) -> Self {
        let (handle, actor) = Self::new(engine, session, controls);
        E::spawn(actor.run());
        handle
    }

    /// The last published snapshot, which outlives the actor.
    pub fn snapshot(&self) -> Outcome<Snap<E>> {
        Ok(res!(self.shared.snap.borrow()).clone())
    }

    pub fn subscribe(&self) -> WatchReceiver<Snap<E>> { self.shared.snap.subscribe() }

    /// The settled conversation.
    pub fn convo(&self) -> Outcome<Rc<E::Convo>> {
        Ok(res!(self.shared.convo.borrow()).clone())
    }

    pub fn controls(&self) -> Outcome<Rc<E::Controls>> {
        Ok(res!(self.ctl.borrow()).clone())
    }

    /// Writes the control cell at once: a read straight after sees it, and a running turn adopts it
    /// at its next round boundary.  Never refused.
    pub fn set_controls(&self, f: impl FnOnce(&E::Controls) -> E::Controls) -> Outcome<()> {
        let next = {
            let now = res!(self.ctl.borrow());
            f(&now)
        };
        self.ctl.send(Rc::new(next))
    }

    pub fn pending(&self) -> u32 { self.shared.pending.get() }

    pub fn children(&self) -> u32 { self.shared.children.get() }

    pub fn is_shut(&self) -> bool { self.shared.shut.get() }

    fn state(&self) -> RunState {
        match self.shared.snap.borrow() {
            Ok(s)   => s.state,
            Err(_)  => RunState::Running,
        }
    }

    /// Would a session write be refused now?  A turn runs, or one is sent and not yet dequeued.
    pub fn held(&self) -> bool {
        self.state() == RunState::Running || self.pending() > 0
    }

    /// Is anything at all in flight on this conversation, a child included?
    pub fn busy(&self) -> bool {
        self.held() || self.children() > 0
    }

    /// Is a turn by this tag running now?
    pub fn running(&self, tag: &str) -> bool {
        match self.shared.snap.borrow() {
            Ok(s)   => s.tags.iter().any(|t| t == tag),
            Err(_)  => false,
        }
    }

    async fn ask<T>(&self, make: impl FnOnce(OneshotSender<Outcome<T>>, Ticket<E>) -> Cmd<E>)
        -> Outcome<T>
    {
        if self.shared.shut.get() {
            return Err(shut_err());
        }
        let (tx, rx) = oneshot();
        let ticket = Ticket::new(&self.shared);
        if self.tx.send_async(make(tx, ticket)).await.is_err() {
            return Err(shut_err());
        }
        match rx.recv().await {
            Ok(out) => out,
            Err(_)  => Err(shut_err()),
        }
    }

    /// Sends a turn-kind command without waiting, counted in `pending` before this returns.  A
    /// full mailbox refuses rather than waits.
    fn post<T>(&self, make: impl FnOnce(OneshotSender<Outcome<T>>, Ticket<E>) -> Cmd<E>)
        -> Outcome<OneshotReceiver<Outcome<T>>>
    {
        if self.shared.shut.get() {
            return Err(shut_err());
        }
        let (tx, rx) = oneshot();
        let ticket = Ticket::new(&self.shared);
        match self.tx.try_send(make(tx, ticket)) {
            Ok(())                              => Ok(rx),
            Err(TrySendError::Full(_))          => Err(err!("{}", FULL; Channel, Write)),
            Err(TrySendError::Disconnected(_))  => Err(shut_err()),
        }
    }

    /// [`Handle::turn`] for a caller whose next synchronous call must see the turn as held: a
    /// wasm export's body runs only when its promise is first polled.  An answer that never comes
    /// means the actor ended.
    pub fn post_turn(&self, spec: E::Turn) -> Outcome<OneshotReceiver<Outcome<E::TurnOut>>> {
        self.post(|reply, t| Cmd::StartTurn(spec, reply, t))
    }

    /// [`Handle::fold`], posted as [`Handle::post_turn`] posts a turn.
    pub fn post_fold(&self, spec: E::Fold) -> Outcome<OneshotReceiver<Outcome<E::FoldOut>>> {
        self.post(|reply, t| Cmd::FoldNow(spec, reply, t))
    }

    pub async fn turn(&self, spec: E::Turn) -> Outcome<E::TurnOut> {
        self.ask(|reply, t| Cmd::StartTurn(spec, reply, t)).await
    }

    pub async fn fold(&self, spec: E::Fold) -> Outcome<E::FoldOut> {
        self.ask(|reply, t| Cmd::FoldNow(spec, reply, t)).await
    }

    pub async fn child(&self, spec: E::Child) -> Outcome<E::ChildOut> {
        self.ask(|reply, t| Cmd::Child(spec, reply, t)).await
    }

    /// A session write, which never waits: refused at once while [`Handle::held`], otherwise queued
    /// and its outcome published here before this returns, so the very next read sees it.  The
    /// actor applies the same write to its session after, and publishes the same values.  The
    /// receiver answers once the actor has applied it; dropping it is fine.
    pub fn write(&self, write: E::Write, view: Option<E::View>, convo: Option<E::Convo>)
        -> Outcome<OneshotReceiver<Outcome<()>>>
    {
        if self.shared.shut.get() {
            return Err(shut_err());
        }
        if self.held() {
            return Err(err!("{}", HELD; Invalid, Conflict));
        }
        let mut queued = self.shared.writes.take();
        if queued.is_empty() {
            match self.tx.try_send(Cmd::Write) {
                Ok(())                              => (),
                Err(TrySendError::Full(_))          => return Err(err!("{}", FULL; Channel, Write)),
                Err(TrySendError::Disconnected(_))  => return Err(shut_err()),
            }
        }
        let (tx, rx) = oneshot();
        queued.push((write, tx));
        self.shared.writes.set(queued);
        if let Some(view) = view {
            self.shared.update(|s| s.view = view);
        }
        if let Some(convo) = convo {
            res!(self.shared.convo.send(Rc::new(convo)));
        }
        Ok(rx)
    }

    /// Spend made outside this actor's turns and children: read at once, as owed, and folded into
    /// the session as soon as no turn holds it.  A full mailbox only delays the fold, to the next
    /// settle or the next owe; the spend reads in the snapshot meanwhile.
    pub fn owe(&self, usage: E::Usage) {
        self.shared.update(|s| s.owed.push(usage));
        if !self.shared.shut.get() {
            let _ = self.tx.try_send(Cmd::Owed);
        }
    }

    /// The report of this conversation's last run was delivered and acknowledged, so the run's
    /// journal is dropped (U4c).  While a turn runs, the journal is that turn's and stays: its
    /// settle drops it.
    pub async fn report_acked(&self) -> Outcome<()> {
        if self.shared.shut.get() {
            return Err(shut_err());
        }
        let (tx, rx) = oneshot();
        if self.tx.send_async(Cmd::Acked(tx)).await.is_err() {
            return Err(shut_err());
        }
        match rx.recv().await {
            Ok(out) => out,
            Err(_)  => Err(shut_err()),
        }
    }

    /// Ends the actor once any turn running settles.  Every command after, or still queued, is
    /// answered with [`SHUT`] at once; the snapshot and conversation stay readable.
    pub fn shutdown(&self) {
        if self.shared.shut.replace(true) {
            return;
        }
        // A full mailbox still reaches the flag: the actor reads it at its next dequeue.
        let _ = self.tx.try_send(Cmd::Shutdown);
    }
}

impl<E: TurnEngine> Drop for Handle<E> {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// What woke a turn's race.
enum Next<T, C> {
    Done(T),
    Cmd(C),
    Closed,
}

/// Answers a command with [`SHUT`].
fn refuse_shut<E: TurnEngine>(shared: &Shared<E>, cmd: Cmd<E>) {
    match cmd {
        Cmd::StartTurn(_, reply, t) => { drop(t); let _ = reply.send(Err(shut_err())); },
        Cmd::FoldNow(_, reply, t)   => { drop(t); let _ = reply.send(Err(shut_err())); },
        Cmd::Child(_, reply, t)     => { drop(t); let _ = reply.send(Err(shut_err())); },
        Cmd::Write                  => shared.refuse_writes(shut_err),
        Cmd::UsageDelta(s)          => {
            let Settled { id, tag, usage, out, reply, _live } = s;
            shared.owe(id, &tag, usage);
            let _ = reply.send(out);
        },
        Cmd::Acked(reply)           => { let _ = reply.send(Err(shut_err())); },
        Cmd::Owed | Cmd::Shutdown   => (),
    }
}

fn spawn_child<E: TurnEngine>(
    engine: &E,
    tx:     &Sender<Cmd<E>>,
    shared: &Rc<Shared<E>>,
    spec:   E::Child,
    reply:  OneshotSender<Outcome<E::ChildOut>>,
) {
    let tag = spec.tag().to_string();
    let live = Live::new(shared);
    let id = shared.next_child.get();
    shared.next_child.set(id.wrapping_add(1));
    shared.update(|s| s.tags.push(tag.clone()));
    let work = engine.child(spec, Meter { shared: shared.clone(), id });
    let tx = tx.clone();
    E::spawn(async move {
        let (out, usage) = work.await;
        let settled = Settled { id, tag, usage, out, reply, _live: live };
        if let Err(e) = tx.send_async(Cmd::UsageDelta(settled)).await {
            if let Cmd::UsageDelta(s) = e.into_inner() {
                let Settled { id, tag, usage, out, reply, _live } = s;
                _live.0.owe(id, &tag, usage);
                let _ = reply.send(out);
            }
        }
    });
}

/// A command that lands while the actor's own turn holds the session.
fn mid_turn<E: TurnEngine>(engine: &E, tx: &Sender<Cmd<E>>, shared: &Rc<Shared<E>>, cmd: Cmd<E>) {
    if shared.shut.get() {
        return refuse_shut(shared, cmd);
    }
    match cmd {
        Cmd::StartTurn(_, reply, t) => {
            drop(t);
            let _ = reply.send(Err(err!("{}", BUSY_TURN; Invalid, Conflict)));
        },
        Cmd::FoldNow(_, reply, t) => {
            drop(t);
            let _ = reply.send(Err(err!("{}", BUSY_FOLD; Invalid, Conflict)));
        },
        Cmd::Write => shared.refuse_writes(|| err!("{}", HELD; Invalid, Conflict)),
        Cmd::Child(spec, reply, t) => {
            drop(t);
            spawn_child(engine, tx, shared, spec, reply);
        },
        Cmd::UsageDelta(s) => {
            let Settled { id, tag, usage, out, reply, _live } = s;
            shared.update(|snap| {
                snap.owed.push(usage);
                snap.flying.retain(|(c, _)| *c != id);
                if let Some(i) = snap.tags.iter().position(|t| *t == tag) {
                    snap.tags.remove(i);
                }
            });
            let _ = reply.send(out);
        },
        // Folded when the turn settles.
        Cmd::Owed => (),
        // The journal is the running turn's now, and its settle drops it.
        Cmd::Acked(reply) => { let _ = reply.send(Ok(())); },
        Cmd::Shutdown => shared.shut.set(true),
    }
}

/// Runs a turn to its end, answering the mailbox beside it.
async fn during<E: TurnEngine, T>(
    turn:   impl Future<Output = Outcome<T>>,
    rx:     &Receiver<Cmd<E>>,
    engine: &E,
    tx:     &Sender<Cmd<E>>,
    shared: &Rc<Shared<E>>,
)
    -> Outcome<T>
{
    let mut turn = pin!(turn);
    let mut open = true;
    // THE SETTLED ROUNDS ARE WRITTEN BESIDE THE TURN, one at a time and in order, so a round's
    // record never waits on the next round and two writes never race.
    let mut writing = shared.next_round().map(|r| Box::pin(put(engine, r)));
    loop {
        let next = {
            let mut recv = pin!(rx.recv_async());
            poll_fn(|cx| {
                if let Poll::Ready(out) = turn.as_mut().poll(cx) {
                    return Poll::Ready(Next::Done(out));
                }
                loop {
                    if writing.is_none() {
                        writing = shared.next_round().map(|r| Box::pin(put(engine, r)));
                    }
                    match writing.as_mut().map(|w| w.as_mut().poll(cx)) {
                        // A round that cannot be written costs its resume, never the turn.
                        Some(Poll::Ready(_))    => writing = None,
                        Some(Poll::Pending)     => break,
                        None                    => break,
                    }
                }
                if open {
                    if let Poll::Ready(got) = recv.as_mut().poll(cx) {
                        return Poll::Ready(match got {
                            Ok(cmd) => Next::Cmd(cmd),
                            Err(_)  => Next::Closed,
                        });
                    }
                }
                Poll::Pending
            }).await
        };
        match next {
            Next::Done(out) => {
                // The write in flight lands before the settle's drop, never after it; the rounds
                // still queued are the settle's to drop, so they are not written.
                if let Some(w) = writing.take() {
                    let _ = w.await;
                }
                let _ = shared.journal.take();
                return out;
            },
            Next::Cmd(cmd)  => mid_turn(engine, tx, shared, cmd),
            Next::Closed    => open = false,
        }
    }
}

impl<E: TurnEngine> Actor<E> {

    pub async fn run(self) {
        let Actor { engine, mut session, rx, tx, ctl, shared } = self;
        let corpse = Corpse(shared.clone());
        while !shared.shut.get() {
            let cmd = match rx.recv_async().await {
                Ok(cmd) => cmd,
                Err(_)  => break,
            };
            if shared.shut.get() {
                refuse_shut(&shared, cmd);
                break;
            }
            match cmd {
                Cmd::StartTurn(spec, reply, t) => {
                    drop(t);
                    let tag = spec.tag().to_string();
                    begin(&shared, Some(&tag));
                    let out = match Edge::new(&engine, &ctl, &shared, session.id.clone()) {
                        Ok(mut edge) => {
                            let work = engine.turn(&mut session, spec, &mut edge);
                            during(work, &rx, &engine, &tx, &shared).await
                        },
                        Err(e) => Err(e),
                    };
                    journal_end(&engine, &session).await;
                    settle(&engine, &mut session, &shared, Some(&tag));
                    let _ = reply.send(out);
                },
                Cmd::FoldNow(spec, reply, t) => {
                    drop(t);
                    begin(&shared, None);
                    let out = match Edge::new(&engine, &ctl, &shared, session.id.clone()) {
                        Ok(mut edge) => {
                            let work = engine.fold(&mut session, spec, &mut edge);
                            during(work, &rx, &engine, &tx, &shared).await
                        },
                        Err(e) => Err(e),
                    };
                    journal_end(&engine, &session).await;
                    settle(&engine, &mut session, &shared, None);
                    let _ = reply.send(out);
                },
                Cmd::Child(spec, reply, t) => {
                    drop(t);
                    spawn_child(&engine, &tx, &shared, spec, reply);
                },
                Cmd::Write => {
                    let mut replies = Vec::new();
                    for (write, reply) in shared.writes.take() {
                        replies.push((engine.write(&mut session, write), reply));
                    }
                    // PUBLISHED EITHER WAY, so a write the handle published early and the
                    // engine then refused is replaced by the session's truth at once.
                    publish(&engine, &session, &shared);
                    for (out, reply) in replies {
                        let _ = reply.send(out);
                    }
                },
                Cmd::UsageDelta(s) => {
                    let Settled { id, tag, usage, out, reply, _live } = s;
                    engine.absorb(&mut session, &usage);
                    // One publish: the meter goes as the absorbed spend arrives, never both or neither.
                    let view = engine.view(&session);
                    shared.update(|snap| {
                        snap.view = view;
                        snap.flying.retain(|(c, _)| *c != id);
                        if let Some(i) = snap.tags.iter().position(|t| *t == tag) {
                            snap.tags.remove(i);
                        }
                    });
                    let _ = shared.convo.send(Rc::new(engine.convo(&session)));
                    let _ = reply.send(out);
                },
                Cmd::Owed => fold_owed(&engine, &mut session, &shared),
                Cmd::Acked(reply) => {
                    let out = engine.journal_drop(session.id.clone()).await;
                    let _ = reply.send(out);
                },
                Cmd::Shutdown => shared.shut.set(true),
            }
        }
        drop(corpse);
        while let Ok(cmd) = rx.try_recv() {
            refuse_shut(&shared, cmd);
        }
    }
}

/// One settled round's write.
fn put<E: TurnEngine>(engine: &E, (run, round, record): (String, u64, Vec<u8>))
    -> impl Future<Output = Outcome<()>> + '_
{
    engine.journal_put(run, round, record)
}

/// The run settled: its journal goes, whatever the turn's outcome.  A drop that fails leaves the
/// records for the report's ack to drop.
async fn journal_end<E: TurnEngine>(engine: &E, session: &Session) {
    let _ = engine.journal_drop(session.id.clone()).await;
}

/// Marks the actor ended however `run` leaves, a panicking turn included: natively the `LocalSet`
/// catches the panic and drops the actor mid-turn, and the snapshot must not read Running for ever.
struct Corpse<E: TurnEngine>(Rc<Shared<E>>);

impl<E: TurnEngine> Drop for Corpse<E> {
    fn drop(&mut self) {
        self.0.shut.set(true);
        self.0.update(|s| s.state = RunState::Shut);
        self.0.refuse_writes(shut_err);
    }
}

fn begin<E: TurnEngine>(shared: &Shared<E>, tag: Option<&str>) {
    shared.update(|s| {
        s.state = RunState::Running;
        if let Some(tag) = tag {
            s.tags.push(tag.to_string());
        }
    });
}

/// Folds the spend owed into the session, between turns.
fn fold_owed<E: TurnEngine>(engine: &E, session: &mut Session, shared: &Shared<E>) {
    absorb_owed(engine, session, shared);
    let view = engine.view(session);
    shared.update(|s| {
        s.owed.clear();
        s.view = view;
    });
}

fn absorb_owed<E: TurnEngine>(engine: &E, session: &mut Session, shared: &Shared<E>) {
    let owed = match shared.snap.borrow() {
        Ok(s)   => s.owed.clone(),
        Err(_)  => Vec::new(),
    };
    for usage in &owed {
        engine.absorb(session, usage);
    }
}

/// Ends the actor's own turn: folds the child spend owed into the session and publishes.
fn settle<E: TurnEngine>(engine: &E, session: &mut Session, shared: &Shared<E>, tag: Option<&str>) {
    absorb_owed(engine, session, shared);
    let view = engine.view(session);
    shared.update(|s| {
        s.state = RunState::Idle;
        s.owed.clear();
        s.view = view;
        if let Some(tag) = tag {
            if let Some(i) = s.tags.iter().position(|t| t == tag) {
                s.tags.remove(i);
            }
        }
    });
    let _ = shared.convo.send(Rc::new(engine.convo(session)));
}

fn publish<E: TurnEngine>(engine: &E, session: &Session, shared: &Shared<E>) {
    let view = engine.view(session);
    shared.update(|s| s.view = view);
    let _ = shared.convo.send(Rc::new(engine.convo(session)));
}

#[cfg(test)]
mod tests;
