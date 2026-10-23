//! The browser's session engine: what [`crate::engine::actor`] drives for a
//! [`DaimondApp`](super::app::DaimondApp), and the `spawn_local` it runs on.
//!
//! The app holds the [`Handle`]; the conversation's [`Session`] lives only in the actor's task, so
//! nothing on the page borrows it, across an await or otherwise.  A turn's event sink publishes the
//! spend so far before it calls the page, so a counter read inside the callback is the real figure.

use crate::agent::Agent;
use crate::engine::actor::{Edge, Meter, Registered, Tagged, TurnEngine};
use crate::engine::turn::{drive, Ended};
use crate::llm::{Halt, StopMark, StopSet};
use crate::protocol::{AgentEvent, ChatMessage, Session};
use crate::tools::ToolRegistry;
use crate::wasm::app::{event_to_js, message_to_js, open_command, refuse, DaimondApp, DiamondTurn, Opened};
use crate::wasm::host::store::WasmStore;
use crate::engine::host::store::HostStore;

use oxedyne_fe2o3_core::{
    prelude::*,
    channels::WatchReceiver,
};

use std::cell::Cell;
use std::collections::BTreeMap;
use std::future::{poll_fn, Future};
use std::pin::pin;
use std::rc::Rc;

use wasm_bindgen::JsValue;


/// What the page may change between rounds of a running turn, adopted at the next boundary, and
/// what a Diamond turn is composed from, taken whole as it starts.  Written copy-on-write.
#[derive(Clone)]
pub struct Controls {
    pub registry:       Rc<ToolRegistry>,
    /// The user's standing instructions (their `DAIMOND.md`), composed into the daimon's and the
    /// reducer's system prompts.  A chat and a worker are built with theirs already composed.
    pub instructions:   String,
    /// The user's replacement for the daimon's role prompt (`prompts/daimon.md`); empty is the
    /// default.
    pub daimon_prompt:  String,
    /// The same, for the reducer (`prompts/reducer.md`).
    pub reducer_prompt: String,
    /// WHICH PROVIDER SERVES THIS APP, for the author a version entry records: only the page
    /// knows it, and says it through `set_provenance`.
    pub provider:       String,
    /// The standing notes each Diamond's daimon composes in, by Diamond id, already reduced to the
    /// lines the block carries, so a note written for one Diamond never steers another.
    pub steering:       BTreeMap<String, String>,
}

impl Controls {
    pub fn new(registry: Rc<ToolRegistry>) -> Self {
        Self {
            registry,
            instructions:   String::new(),
            daimon_prompt:  String::new(),
            reducer_prompt: String::new(),
            provider:       String::new(),
            steering:       BTreeMap::new(),
        }
    }
}

impl Registered for Controls {
    fn registry(&self) -> Rc<ToolRegistry> { self.registry.clone() }
}

pub use crate::engine::counters::Counters;

/// A session write: `restore` and `restore_session` replace, `append_message` appends.
#[derive(Clone)]
pub enum Write {
    Replace { messages: Vec<ChatMessage>, counters: Counters },
    Append(ChatMessage),
}

impl Write {

    /// THE ONE FUNCTION BOTH SIDES APPLY: the handle to what it publishes at once, the actor to
    /// its session after, so the two publish the same values (the actor core's D4 contract).
    pub fn apply(self, counters: &mut Counters, messages: &mut Vec<ChatMessage>) {
        match self {
            Self::Replace { messages: m, counters: c } => {
                *messages = m;
                *counters = c;
            },
            Self::Append(m) => messages.push(m),
        }
    }
}

pub struct TurnSpec {
    pub user_msg:   String,
    pub on_event:   js_sys::Function,
    pub pre:        String,
    pub mid:        String,
    /// The page's tag for the conversation's own turn, read when `run_turn` was called.
    pub tag:        String,
    /// The stop cell when the turn was sent, so a Stop between then and its start lands.
    pub base:       StopMark,
    /// The turn is its conversation's own (a Diamond's thread), not a worker's: its Diamond
    /// keeper's turn is ended with it (`engine::turn::drive`).
    pub own:        bool,
}

impl Tagged for TurnSpec {
    fn tag(&self) -> &str { &self.tag }
}

pub struct FoldSpec {
    pub on_event:   js_sys::Function,
    pub base:       StopMark,
}

/// What a Diamond turn answers: a steer its conversation, a proposal its envelope.
pub enum ChildOut {
    Steer(js_sys::Array),
    Proposal(String),
}

/// Resolves once the stop cell stops the turn tagged `tag`, sent at `base` (see
/// [`StopSet::stops`]).  A cell that cannot be read reads as stopped; a closed one never fires
/// again.
async fn stopped(mut rx: WatchReceiver<StopSet>, tag: String, base: StopMark) {
    loop {
        let hit = match rx.borrow() {
            Ok(s)   => s.stops(&tag, base),
            Err(_)  => true,
        };
        if hit {
            return;
        }
        if rx.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

/// Runs `work` to its end, firing `halt` once `stop` resolves, so a stopped turn ends at its next
/// seam with its partial kept, exactly as a fired halt always ended one.
async fn obeying<T>(work: impl Future<Output = T>, stop: impl Future<Output = ()>, halt: &Halt) -> T {
    let mut work = pin!(work);
    let mut stop = pin!(stop);
    let mut heard = false;
    poll_fn(|cx| {
        if !heard && stop.as_mut().poll(cx).is_ready() {
            heard = true;
            halt.fire();
        }
        work.as_mut().poll(cx)
    }).await
}

/// The browser's [`TurnEngine`]: the conversation's own agent, shared with the handle so its
/// tuning and its live counters are one, and the conversation's stop cell.
pub struct Engine {
    pub agent:  Rc<Agent>,
    pub stop:   WatchReceiver<StopSet>,
}

impl Engine {

    /// The conversation's stop, cleared of the last turn's, and what fires it for this one.
    fn arm(&self, tag: String, base: StopMark) -> (Halt, impl Future<Output = ()>) {
        let halt = self.agent.llm.halt();
        halt.rearm();
        (halt, stopped(self.stop.clone(), tag, base))
    }
}

impl TurnEngine for Engine {
    type Controls   = Controls;
    type View       = Counters;
    type Convo      = Vec<ChatMessage>;
    type Usage      = Counters;
    type Turn       = TurnSpec;
    type TurnOut    = ();
    type Fold       = FoldSpec;
    type FoldOut    = bool;
    type Child      = DiamondTurn;
    type ChildOut   = ChildOut;
    type Write      = Write;

    fn view(&self, session: &Session) -> Counters { Counters::of(session) }

    fn convo(&self, session: &Session) -> Vec<ChatMessage> { session.messages.clone() }

    async fn turn(&self, session: &mut Session, spec: TurnSpec, edge: &mut Edge<'_, Self>)
        -> Outcome<()>
    {
        let TurnSpec { user_msg, on_event, pre, mid, tag, base, own } = spec;
        let (halt, stop) = self.arm(tag, base);
        obeying(self.turn_inner(session, user_msg, on_event, pre, mid, own, edge), stop, &halt).await
    }

    async fn fold(&self, session: &mut Session, spec: FoldSpec, edge: &mut Edge<'_, Self>)
        -> Outcome<bool>
    {
        // The fold's request is the conversation's, so it takes the conversation's stop.
        let (halt, stop) = self.arm(String::new(), spec.base);
        let mut sink = |ev: AgentEvent| {
            let _ = spec.on_event.call1(&JsValue::NULL, &event_to_js(&ev));
        };
        Ok(obeying(self.agent.fold_by_hand(edge.controls().registry.ctx.host(), session, &mut sink), stop, &halt).await)
    }

    fn child(&self, spec: DiamondTurn, meter: Meter<Self>)
        -> impl Future<Output = (Outcome<ChildOut>, Counters)> + 'static
    {
        spec.run(meter)
    }

    fn absorb(&self, session: &mut Session, usage: &Counters) {
        Counters::of(session).plus(usage).set_on(session);
    }

    fn write(&self, session: &mut Session, write: Write) -> Outcome<()> {
        let mut counters = Counters::of(session);
        write.apply(&mut counters, &mut session.messages);
        counters.set_on(session);
        Ok(())
    }

    fn spawn(task: impl Future<Output = ()> + 'static) {
        wasm_bindgen_futures::spawn_local(task);
    }

    // THE RUN JOURNAL (U4c): each settled round, as the messages it added in the page's own
    // `export_session` form, under the session's id in the tab's OPFS store area.
    fn journal_record(&self, session: &Session, from: usize) -> Option<Vec<u8>> {
        let out = js_sys::Array::new();
        for msg in session.messages.iter().skip(from) {
            out.push(&message_to_js(msg));
        }
        match js_sys::JSON::stringify(&out) {
            Ok(s)   => Some(String::from(s).into_bytes()),
            Err(_)  => None,
        }
    }
    async fn journal_put(&self, run: String, round: u64, record: Vec<u8>) -> Outcome<()> {
        WasmStore.journal_put(&run, round, &record).await
    }
    async fn journal_drop(&self, run: String) -> Outcome<()> {
        WasmStore.journal_drop(&run).await
    }
}

impl Engine {

    async fn turn_inner(
        &self,
        session:    &mut Session,
        user_msg:   String,
        on_event:   js_sys::Function,
        pre:        String,
        mid:        String,
        own:        bool,
        edge:       &mut Edge<'_, Self>,
    )
        -> Outcome<()>
    {
        // A `/name` the user typed, resolved to the file's own text BEFORE the turn starts.
        let user_msg = match open_command(user_msg).await {
            Opened::Send(text)  => text,
            Opened::Refuse(msg) => return Err(refuse(&msg)),
        };
        let registry = edge.controls().registry.clone();
        let (brief, blocks, rooted) = DaimondApp::briefing(&self.agent, &registry).await;
        self.agent.set_briefing(&brief);
        self.agent.set_blocks(blocks);
        // THIS TURN'S OWN ANSWER, on this turn's own registry, set once before the request is
        // built (UNBLOCK-32 F4b): nothing else writes it until the next turn here is briefed.
        registry.set_machine_rooted(rooted);
        // THE SINK PUBLISHES BEFORE THE PAGE HEARS, so a counter read in the callback is the spend
        // so far.  The mirror is set from the session first: a restore since the last turn moved
        // the session and not the mirror, and the first event comes before the first response.
        let start = Counters::of(session);
        self.agent.live_prompt.set(start.prompt);
        self.agent.live_completion.set(start.completion);
        self.agent.live_cached.set(start.cached);
        self.agent.live_cost.set(start.cost);
        self.agent.live_last_prompt.set(start.last_prompt);
        let publisher = edge.publisher();
        let agent = self.agent.clone();
        let last = Cell::new(start);
        let mut sink = |ev: AgentEvent| {
            let now = Counters::live(&agent);
            if now != last.get() {
                last.set(now);
                publisher.view(now);
            }
            // A callback that throws must not abort the turn.
            let _ = on_event.call1(&JsValue::NULL, &event_to_js(&ev));
        };
        // WHAT THE TURN REPLACED OR REMOVED BECOMES A VERSION OF ITS KEEPER'S STORE, whichever
        // way it went, once, in the engine (U4b): a chat's always, and a Diamond's for its own
        // thread's turn, which the page used to end by calling `end_keeper_turn` after this.
        let body = async {
            let ran = self.agent.run_turn_bounded(session, user_msg, pre, mid, &registry, edge,
                &mut sink).await;
            (ran, edge.controls().registry.clone())
        };
        let driven = drive(registry.clone(), own, None, body).await;
        if let Some(kept) = &driven.kept {
            DaimondApp::versions_event(kept, &on_event);
        }
        // What the store refused to keep, said in the transcript (LOUD-FAIL B2).
        if let Some(said) = &driven.unkept {
            let ev = AgentEvent::Text(fmt!("\n\n{}", said));
            let _ = on_event.call1(&JsValue::NULL, &event_to_js(&ev));
        }
        match driven.ended {
            Ended::Ran(ran)     => ran,
            Ended::Interrupted  => Err(refuse("This turn's lease ran out, so it was interrupted.")),
        }
    }
}
