//! A turn's specification: what a Diamond's turn runs, decided once, in the engine.
//!
//! "Send a turn" used to be decided by the page (daimond.js `runSteerHeld`, `diamondModel`,
//! `appCfgFor`, `diamondCanRun`, and models.js `resolve`): which provider and model the turn runs
//! on, what its instruction is, how many gather rounds deep it is, and whether it is a hand-off's
//! detached turn.  [`resolve`] is that decision, and [`TurnSpec`] is its answer, so the native
//! runner and the tab run a turn on the same model by the same rules.  The page hands the facts
//! only it holds (the box's text, which providers have a key) and takes the spec back through the
//! wasm export `turn_spec`.
//!
//! What stays with the page: whether the Diamond is already busy (a queue of its own), the key
//! itself (never in the spec), and the effort setting, which models.js reconciles against the
//! provider's own list.

use crate::{
    agent::Agent,
    diamond_versions::Cause,
    engine::{
        host::{
            Host,
            clock::HostClock,
            store::HostStore,
        },
        race::{
            race,
            Won,
        },
    },
    marks::{num, Reach},
    protocol::{seed_prior, ChatMessage},
    tools::{
        KeeperKind,
        ToolContext,
        ToolRegistry,
    },
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_jdat::{
    Dat,
    conv::FromDat,
    map::DaticleMap,
};

use std::{
    cell::Cell,
    future::Future,
    rc::Rc,
};

/// The provider and model a turn runs on.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Model {
    pub provider:   String,
    pub model:      String,
}

/// A hand-off's turn holds a lease named by its turn id, until `until` (ms since the epoch;
/// 0 where the asker gave no deadline).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Lease {
    pub turn:   String,
    pub until:  u64,
}

/// Who asked for the turn: a person (`person`), and whether they typed it (`said`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct How {
    pub person:         bool,
    pub said:           bool,
    pub pending_only:   bool,   // a mail trigger's turn, which reports on Pending alone (`how.pendingOnly`)
}

/// Why a turn does not go out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Refused {
    /// Nothing to send: no preset, and no box or an empty one.
    Empty,
    /// The Diamond's model has no provider with a key.  Never moved to another provider.
    NoKey,
}

impl Refused {
    pub fn word(&self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::NoKey => "no_key",
        }
    }
}

/// One turn, resolved.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TurnSpec {
    pub chat:           String,
    pub diamond:        String,
    /// The resolved model, or `None` where nothing can run it (then `refused` says why).
    pub model:          Option<Model>,
    /// The instruction that came from a gather round, a trigger, the conductor or an errand, not
    /// the box; empty for a typed send.
    pub preset:         String,
    /// How many gather rounds deep this turn is: 0 for the composer.
    pub depth:          i64,
    /// What the turn is asked: the preset, else the box's text trimmed.
    pub instruction:    String,
    /// A hand-off's turn, run against the errand's own chat record.
    pub detached:       bool,
    pub how:            How,
    pub lease:          Option<Lease>,
    pub refused:        Option<Refused>,
    /// The app's note beside the instruction, as the turn's own message carries it.
    pub pre:            String,
    /// The transcript row the instruction is said as (an errand's turn id); empty for none.
    pub mid:            String,
    /// The conversation before the turn, oldest first, as the page seeds it (the turn's own
    /// message excluded): what a detached run's agent holds before the instruction.
    pub thread:         Vec<ChatMessage>,
    /// The page's applied limits (KT-2), `None` from a send that carried none.
    pub limits:         Option<TurnLimits>,
    pub today:          String,         // the page's `Today` block (KT-4), empty for none
    pub reach:          Option<Reach>,  // the page's reach, its `Attached` block (KT-4)
    pub words:          Option<(String, String)>,   // the tab's words log, `(keeper, log)` (U2a)
}

/// The limits the page's agent runs a turn under (KT-2), carried so a turn run elsewhere folds,
/// caps and spends as the tab's would.  Each figure is the page's setting as it hands it to its
/// own agent, so zero or empty means the engine's own figure, read by the same setter; the
/// window is the page's model table's (`pricing.js` `contextWindow`), zero where it has none.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TurnLimits {
    pub window:         u64,	// tokens; `Agent::set_context_window`
    pub fold_at:        f64,	// fraction of the window; `Agent::set_fold_at`
    pub context_cap:    u64,	// tokens; `Agent::set_context_cap`
    pub spend_cap_usd:  f64,	// per turn; `Agent::set_spend_cap_usd`
    pub max_rounds:     usize,	// `Agent::set_max_rounds`
    pub fold_model:     String,	// the effective Summarising model on the turn's provider
    pub fold_prompt:    String,	// the person's `prompts/compactor.md`
    pub tune:           String,	// the tune JSON; `Agent::set_tune`
}

impl TurnLimits {
    /// The limits a send's `limits` object carries (the page's names), or `None` for anything
    /// that is not an object.
    pub fn of_dat(d: &Dat) -> Option<Self> {
        let m = match d {
            Dat::Map(m) => m,
            _           => return None,
        };
        let whole = |k: &str| {
            let n = num(m.get(&key(k)));
            if n.is_finite() && n > 0.0 { n.trunc() as u64 } else { 0 }
        };
        let real = |k: &str| {
            let n = num(m.get(&key(k)));
            if n.is_finite() && n > 0.0 { n } else { 0.0 }
        };
        Some(Self {
            window:         whole("window"),
            fold_at:        real("foldAt"),
            context_cap:    whole("contextCap"),
            spend_cap_usd:  real("spendCap"),
            max_rounds:     whole("maxRounds") as usize,
            fold_model:     text(m, "foldModel"),
            fold_prompt:    text(m, "foldPrompt"),
            tune:           text(m, "tune"),
        })
    }

    /// The limits under the page's names, as [`TurnLimits::of_dat`] reads them.
    pub fn to_dat(&self) -> Dat {
        let mut d = DaticleMap::new();
        d.insert(key("window"), Dat::U64(self.window));
        d.insert(key("foldAt"), Dat::from(self.fold_at));
        d.insert(key("contextCap"), Dat::U64(self.context_cap));
        d.insert(key("spendCap"), Dat::from(self.spend_cap_usd));
        d.insert(key("maxRounds"), Dat::U64(self.max_rounds as u64));
        d.insert(key("foldModel"), Dat::Str(self.fold_model.clone()));
        d.insert(key("foldPrompt"), Dat::Str(self.fold_prompt.clone()));
        d.insert(key("tune"), Dat::Str(self.tune.clone()));
        Dat::Map(d)
    }

    /// Set `agent` to these limits as the page sets its own (daimond.js: the window and round
    /// limit when the app is built, then `applyFoldSettings`), so the turn's [`Agent::limits`]
    /// are the tab's, as [`Agent::adopt_limits`] makes a Diamond's daimon's the chat's.  A tune
    /// the engine refuses is answered as the error, after every other figure is set.
    pub fn apply(&self, agent: &Agent) -> Outcome<()> {
        agent.set_context_window(self.window);
        agent.set_max_rounds(self.max_rounds);
        agent.set_fold_at(self.fold_at);
        agent.set_context_cap(self.context_cap);
        agent.set_spend_cap_usd(self.spend_cap_usd);
        agent.set_fold_model(&self.fold_model);
        agent.set_fold_prompt(&self.fold_prompt);
        agent.set_tune(&self.tune)
    }
}

/// The facts the page holds for one send.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TurnAsk {
    pub chat:       String,
    pub diamond:    String,
    /// The Diamond's own stored choice, if any (`diamondModels()[id]`).
    pub stored:     Option<Model>,
    /// The account's default choice (`DaimondModels.getDefault()`).
    pub default:    Model,
    /// The providers configured with a readable key.
    pub keyed:      Vec<String>,
    /// `runSteer`'s preset argument, as given: only a string is a preset.
    pub preset:     Dat,
    /// `runSteer`'s depth argument, as given: only a number is a depth.
    pub depth:      Dat,
    /// The composer's text, or `None` where there is no composer.
    pub typed:      Option<String>,
    pub detached:   Option<Lease>,
    pub how:        How,
    /// The app's note beside the typed words (`pre`).
    pub pre:        String,
    /// The row the turn's message is said as (`mid`).
    pub mid:        String,
    /// The conversation before the turn, from the page's engine session (`session`: `{msgs,
    /// tail}`, KT-4) as `ensureApp` restores it: the model's rows repaired by [`seed_prior`],
    /// then the prose tail's `{role, content, pre, mid, interject?}` rows read through
    /// [`ChatMessage::of_row_opening`] as `append_message` reads them (an interjection opens no
    /// turn, B3).  Empty where the send carries no session.
    pub thread:     Vec<ChatMessage>,
    /// The page's applied limits (`limits`), `None` where the send carries no object.
    pub limits:     Option<TurnLimits>,
    pub today:      String,         // `today`: the page's `Today` block, empty for none
    pub reach:      Option<Reach>,  // `reach`: what the page's marks put in reach, `None` for none
    /// The tab's words log for a runner's fold to stage over (`words`: `{keeper, log}`, U2a):
    /// `(keeper, log)`, `None` where the send carries none.
    pub words:      Option<(String, String)>,
}

/// The model a provider/model choice runs on, or `None` where no keyed provider serves it
/// (models.js `resolve`): an empty provider is the default's, and an empty model is the default's
/// only when the provider was the default's too.
pub fn resolve_model(provider: &str, model: &str, default: &Model, keyed: &[String]) -> Option<Model> {
    let id = if provider.is_empty() { default.provider.as_str() } else { provider };
    let m = if !model.is_empty() {
        model
    } else if provider.is_empty() {
        default.model.as_str()
    } else {
        ""
    };
    if id.is_empty() || !keyed.iter().any(|k| k == id) || m.is_empty() {
        return None;
    }
    Some(Model { provider: id.to_string(), model: m.to_string() })
}

/// The decision half of "Send a turn": the model, preset, depth and instruction, once.
pub fn resolve(ask: &TurnAsk) -> TurnSpec {
    let preset = match &ask.preset {
        Dat::Str(s) => s.clone(),
        _           => String::new(),
    };
    let depth = if is_number(&ask.depth) { num(Some(&ask.depth)).trunc() as i64 } else { 0 };
    // The Diamond's own choice when it names a model, else the default (`diamondModel`).
    let chosen = match &ask.stored {
        Some(m) if !m.model.is_empty() => m.clone(),
        _                              => ask.default.clone(),
    };
    let model = resolve_model(&chosen.provider, &chosen.model, &ask.default, &ask.keyed);
    let instruction = if !preset.is_empty() {
        preset.clone()
    } else {
        match &ask.typed {
            Some(t) => t.trim().to_string(),
            None    => String::new(),
        }
    };
    // The page's order: nothing to send is answered before whether anything can run it.
    let refused = if instruction.is_empty() {
        Some(Refused::Empty)
    } else if model.is_none() {
        Some(Refused::NoKey)
    } else {
        None
    };
    TurnSpec {
        chat:       ask.chat.clone(),
        diamond:    ask.diamond.clone(),
        model,
        preset,
        depth,
        instruction,
        detached:   ask.detached.is_some(),
        how:        ask.how.clone(),
        lease:      ask.detached.clone(),
        refused,
        pre:        ask.pre.clone(),
        mid:        ask.mid.clone(),
        thread:     ask.thread.clone(),
        limits:     ask.limits.clone(),
        today:      ask.today.clone(),
        reach:      ask.reach.clone(),
        words:      ask.words.clone(),
    }
}

fn is_number(d: &Dat) -> bool {
    match d {
        Dat::U8(_) | Dat::U16(_) | Dat::U32(_) | Dat::U64(_) | Dat::U128(_)
        | Dat::I8(_) | Dat::I16(_) | Dat::I32(_) | Dat::I64(_) | Dat::I128(_) => true,
        Dat::F32(n) => n.0.is_finite(),
        Dat::F64(n) => n.0.is_finite(),
        _           => false,
    }
}

fn key(k: &str) -> Dat { Dat::Str(k.to_string()) }

fn text(m: &DaticleMap, k: &str) -> String {
    match m.get(&key(k)) {
        Some(Dat::Str(s)) => s.clone(),
        _                 => String::new(),
    }
}

fn flag(m: &DaticleMap, k: &str) -> bool {
    matches!(m.get(&key(k)), Some(Dat::Bool(true)))
}

fn model_of(d: Option<&Dat>) -> Option<Model> {
    match d {
        Some(Dat::Map(m)) => Some(Model { provider: text(m, "provider"), model: text(m, "model") }),
        _                 => None,
    }
}

/// The history the page's engine session `{msgs, tail}` restores (KT-4, binding 15), as the
/// tab's `ensureApp` restores it: the model's own rows through [`seed_prior`]'s repair, then
/// each prose row of the tail after `upto` as `append_message` reads it, an interjection opening
/// no turn (B3).  The prose seed beside it is no source of history.
fn session_thread(m: &DaticleMap) -> Vec<ChatMessage> {
    let mut thread = match m.get(&key("msgs")) {
        Some(Dat::List(l)) => seed_prior(l),
        _                  => Vec::new(),
    };
    if let Some(Dat::List(l)) = m.get(&key("tail")) {
        thread.extend(l.iter().filter_map(|d| match d {
            Dat::Map(r) => match r.get(&key("content")) {
                Some(Dat::Str(c)) => ChatMessage::of_row_opening(&text(r, "role"), c.clone(),
                    text(r, "pre"), text(r, "mid"), !flag(r, "interject")),
                _                 => None,
            },
            _ => None,
        }));
    }
    thread
}

impl TurnAsk {
    /// The page's send, from its JSON (`turn_spec`'s argument).
    pub fn from_json(json: &str) -> Outcome<Self> {
        let top = match res!(Dat::decode_string_with_config(json, &crate::agent::compact::json_cfg())) {
            Dat::Map(m) => m,
            _           => return Err(err!("A turn's send must be a JSON object."; Input, Invalid)),
        };
        let keyed = match top.get(&key("keyed")) {
            Some(Dat::List(l)) => l.iter().filter_map(|d| match d {
                Dat::Str(s) if !s.is_empty() => Some(s.clone()),
                _                            => None,
            }).collect(),
            _ => Vec::new(),
        };
        let detached = match top.get(&key("detached")) {
            Some(Dat::Map(m)) => Some(Lease {
                turn:   text(m, "turnId"),
                until:  {
                    let n = num(m.get(&key("until")));
                    if n.is_finite() && n > 0.0 { n as u64 } else { 0 }
                },
            }),
            _ => None,
        };
        let how = match top.get(&key("how")) {
            Some(Dat::Map(m)) => How { person: flag(m, "person"), said: flag(m, "said"),
                pending_only: flag(m, "pendingOnly") },
            _                 => How::default(),
        };
        Ok(Self {
            chat:       text(&top, "chat"),
            diamond:    text(&top, "diamond"),
            stored:     model_of(top.get(&key("stored"))),
            default:    model_of(top.get(&key("default"))).unwrap_or_default(),
            keyed,
            preset:     top.get(&key("preset")).cloned().unwrap_or(Dat::Empty),
            depth:      top.get(&key("depth")).cloned().unwrap_or(Dat::Empty),
            typed:      match top.get(&key("typed")) {
                Some(Dat::Str(s)) => Some(s.clone()),
                _                 => None,
            },
            detached,
            how,
            pre:        text(&top, "pre"),
            mid:        text(&top, "mid"),
            thread:     match top.get(&key("session")) {
                Some(Dat::Map(m)) => session_thread(m),
                _                 => Vec::new(),
            },
            limits:     top.get(&key("limits")).and_then(TurnLimits::of_dat),
            today:      text(&top, "today"),
            reach:      match top.get(&key("reach")) {
                Some(d @ Dat::Map(_)) => Reach::from_dat(d.clone()).ok(),
                _                     => None,
            },
            words:      match top.get(&key("words")) {
                Some(Dat::Map(m)) => Some((text(m, "keeper"), text(m, "log"))),
                _                 => None,
            },
        })
    }
}

fn model_dat(m: &Model) -> Dat {
    let mut d = DaticleMap::new();
    d.insert(key("provider"), Dat::Str(m.provider.clone()));
    d.insert(key("model"), Dat::Str(m.model.clone()));
    Dat::Map(d)
}

impl TurnSpec {
    /// The spec as the page reads it.
    pub fn to_dat(&self) -> Dat {
        let mut d = DaticleMap::new();
        d.insert(key("chat"), Dat::Str(self.chat.clone()));
        d.insert(key("diamond"), Dat::Str(self.diamond.clone()));
        d.insert(key("model"), match &self.model {
            Some(m) => model_dat(m),
            None    => Dat::Empty,
        });
        d.insert(key("preset"), Dat::Str(self.preset.clone()));
        d.insert(key("depth"), Dat::I64(self.depth));
        d.insert(key("instruction"), Dat::Str(self.instruction.clone()));
        d.insert(key("detached"), Dat::Bool(self.detached));
        let mut how = DaticleMap::new();
        how.insert(key("person"), Dat::Bool(self.how.person));
        how.insert(key("said"), Dat::Bool(self.how.said));
        d.insert(key("how"), Dat::Map(how));
        d.insert(key("lease"), match &self.lease {
            Some(l) => {
                let mut m = DaticleMap::new();
                m.insert(key("turn"), Dat::Str(l.turn.clone()));
                m.insert(key("until"), Dat::U64(l.until));
                Dat::Map(m)
            }
            None => Dat::Empty,
        });
        d.insert(key("refused"), Dat::Str(match self.refused {
            Some(r) => r.word().to_string(),
            None    => String::new(),
        }));
        // Written only when carried, so a spec without them is the bytes it always was.
        if let Some(l) = &self.limits {
            d.insert(key("limits"), l.to_dat());
        }
        Dat::Map(d)
    }

    /// Compact JSON, `null` for an absent model or lease, as the page's `JSON.parse` reads it.
    pub fn json(&self) -> Outcome<String> {
        self.to_dat().json_canonical()
    }
}

/// `turn_spec`'s whole body: the page's send in, the spec out, or `{"error":"..."}` for a send
/// that is not one (the page refuses the turn on it).  The error is a fixed sentence: the page logs
/// it, and a decoder's own wording is not for the console.
pub fn spec_json(json: &str) -> String {
    match TurnAsk::from_json(json) {
        Ok(ask) => match resolve(&ask).json() {
            Ok(s)  => s,
            Err(_) => fmt!("{{\"error\":\"turn_spec: the spec could not be written\"}}"),
        },
        Err(_) => fmt!("{{\"error\":\"turn_spec: the send is not a JSON object\"}}"),
    }
}

// ── The driver (U4b) ─────────────────────────────────────────────────────

/// A running turn's lease deadline (ms since the epoch), shared on clone: whoever renews the
/// lease moves it on, and the driver reads it again after every wait (spec §3.1).
#[derive(Clone, Debug, Default)]
pub struct Renewal {
    until: Rc<Cell<u64>>,
}

impl Renewal {
    pub fn new(until: u64) -> Self {
        Self { until: Rc::new(Cell::new(until)) }
    }

    /// The renewal of a spec's lease, from the deadline it was taken with.
    pub fn of(lease: &Lease) -> Self {
        Self::new(lease.until)
    }

    pub fn until(&self) -> u64 {
        self.until.get()
    }

    /// The lease was renewed to `until`.  A renewal never brings the deadline nearer.
    pub fn renew(&self, until: u64) {
        if until > self.until.get() {
            self.until.set(until);
        }
    }

    /// Resolves once `clock` is past the deadline with no renewal having moved it on.  A lease
    /// with no deadline (0) never lapses: the turn then ends only by its own end.
    pub async fn lapsed<C: HostClock>(&self, clock: &C) {
        loop {
            let until = self.until.get();
            if until == 0 {
                return std::future::pending::<()>().await;
            }
            let now = clock.now_ms().max(0.0) as u64;
            if now > until {
                return;
            }
            clock.sleep_ms(until - now + 1).await;
        }
    }
}

/// How a driven turn ended.
#[derive(Debug, PartialEq)]
pub enum Ended<T> {
    /// By its own end, whichever way that went.
    Ran(T),
    /// Its lease deadline passed with no renewal, so it was dropped where it stood (spec §3.1).
    Interrupted,
}

impl<T> Ended<T> {
    pub fn word(&self) -> &'static str {
        match self {
            Self::Ran(_)        => "ran",
            Self::Interrupted   => "interrupted",
        }
    }
}

/// The version a keeper's turn end recorded.
#[derive(Clone, Debug, PartialEq)]
pub struct Kept {
    pub keeper:     String,
    pub version:    u64,
    pub files:      Vec<String>,
}

/// What a driven turn came to: how it ended, and what its keeper's turn end recorded (`None`
/// where it recorded nothing).
#[derive(Debug)]
pub struct Driven<T> {
    pub ended:  Ended<T>,
    pub kept:   Option<Kept>,
    /// What the store refused to keep, as one visible sentence for the asker's transcript, or
    /// `None` (LOUD-FAIL B2, [`end_keeper_turn_said`]).
    pub unkept: Option<String>,
}

/// Drive one turn: `body` raced against its lease, then its keeper's turn ended, once, however
/// the turn went.
///
/// The halves the page used to run around a turn are the engine's: the lease bound (UNBLOCK-7
/// F4, the page's `killRun('deadline')`) and the keeper's turn end (the page's call to
/// `end_keeper_turn` after `run_turn`, F6 2026-09-25).
///
/// * `start` - The registry the turn starts under, whose keeper is ended when the turn is cut.
/// * `own` - The turn is its conversation's own (a Diamond's thread: a Continue, a Run here, a
///   gather round), not a worker's, so a Diamond keeper's turn is ended too.  A chat's keeper is
///   ended either way; a worker's Diamond is ended by its daimon's turn end.
/// * `lease` - The lease the turn runs under; `None` is no lease bound.
/// * `body` - The turn, answering its output and the registry it ended under (the controls move
///   at round boundaries).
pub async fn drive<H, T, F>(
    start:  Rc<ToolRegistry<H>>,
    own:    bool,
    lease:  Option<&Renewal>,
    body:   F,
)
    -> Driven<T>
    where
        H: Host,
        F: Future<Output = (T, Rc<ToolRegistry<H>>)>,
{
    let won = match lease {
        Some(l) => race(body, l.lapsed(start.ctx.host().clock())).await,
        None    => Won::First(body.await),
    };
    let (ended, registry) = match won {
        Won::First((out, reg))  => (Ended::Ran(out), reg),
        Won::Second(())         => (Ended::Interrupted, start),
    };
    let (kept, unkept) = end_keeper_turn_said(&registry.ctx, own).await;
    Driven { ended, kept, unkept }
}

/// End the store's turn for the keeper `ctx` keeps into: record what the turn kept as one version
/// of its store, and end its counts.  Answers the version recorded and its files.
///
/// A Diamond's keeper is ended only for its conversation's `own` turn.  Not while a steer runs on
/// the same Diamond, whose own turn end records the store's turn and must not have its captures
/// taken from under it: asked again once the store is held, since a steer can start during the
/// wait (R4 of the release 5.1 fix's QA, 2026-09-25).
pub async fn end_keeper_turn<H: Host>(ctx: &ToolContext<H>, own: bool) -> Option<Kept> {
    end_keeper_turn_said(ctx, own).await.0
}

/// [`end_keeper_turn`], and what the store refused to keep (LOUD-FAIL, rc-a ruling B2): `None`
/// where nothing was refused, else one visible sentence naming the keeper, each op refused and
/// the store's reason, for the asker's transcript.  What the turn did stands on the disk either
/// way, so this is said and never only trailed: a turn that records nothing must not look fine.
pub async fn end_keeper_turn_said<H: Host>(ctx: &ToolContext<H>, own: bool)
    -> (Option<Kept>, Option<String>)
{
    let key = match ctx.keeper() {
        Some(k) => k,
        None    => return (None, None),
    };
    let mut unkept = crate::tools::take_unkept(&ctx.read_seen);
    let kept = end_keeper_turn_kept(ctx, own, &key, &mut unkept).await;
    let said = match unkept.is_empty() {
        true    => None,
        false   => Some(fmt!("[Not recorded in the History: {} What this turn did stands on the \
            disk, but the History does not list it and file_revert cannot put back what it \
            replaced.]", unkept.join(" "))),
    };
    (kept, said)
}

/// One refusal of the turn record: trailed, and said in `unkept` with the keeper, op and reason.
fn refused<S: crate::engine::host::store::HostStore>(store: &S, key: &str, op: &str,
    e: &Error<ErrTag>, unkept: &mut Vec<String>)
{
    store.trail("TURN NOT RECORDED", &fmt!("{}: {}: {}", key, op, e));
    unkept.push(fmt!("the store refused {} for keeper '{}' ({}).", op, key, e.plain()));
}

/// The record itself, each refusal trailed and added to `unkept`.
async fn end_keeper_turn_kept<H: Host>(ctx: &ToolContext<H>, own: bool, key: &str,
    unkept: &mut Vec<String>)
    -> Option<Kept>
{
    let key = key.to_string();
    // An away keeper's turn is a Diamond's for ownership (`KeeperKind::Away`).
    if !own && KeeperKind::of(&key) != KeeperKind::Chat {
        return None;
    }
    let store = ctx.host().store();
    store.keeper_turn_ended(&key);
    match store.is_steering(&key) {
        Ok(true)    => return None,
        Ok(false)   => (),
        Err(e)      => {
            // Refused after the act: said, never taken for a steer (LOUD-FAIL).  The counts end
            // as for a refused hold (F4).
            store.end_turn_counts(&key);
            refused(store, &key, "is_steering", &e, unkept);
            return None;
        },
    }
    let hold = match store.hold_versions(&key).await {
        Ok(h)  => h,
        Err(e) => {
            // Left for the next turn end: the captures stay and the notes on disk.  The turn's
            // counts end here all the same (F4).
            store.end_turn_counts(&key);
            refused(store, &key, "hold_versions", &e, unkept);
            return None;
        },
    };
    match store.is_steering(&key) {
        Ok(true)    => return None,
        Ok(false)   => (),
        Err(e)      => {
            refused(store, &key, "is_steering", &e, unkept);
            return None;
        },
    }
    if let Err(e) = store.drain_turn(&hold, &key, ctx).await {
        refused(store, &key, "drain_turn", &e, unkept);
        return None;
    }
    if let Err(e) = store.drain_windows(&hold, &key).await {
        refused(store, &key, "drain_windows", &e, unkept);
        return None;
    }
    match store.versions_record_held(&hold, &key, None, Cause::Turn, "", "").await {
        Ok(Some((version, files)))  => Some(Kept { keeper: key, version, files }),
        Ok(None)                    => None,
        Err(e)                      => {
            refused(store, &key, "versions_record_held", &e, unkept);
            None
        },
    }
}

#[cfg(test)]
#[path = "../../tests/unit/engine/turn/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../../tests/unit/engine/turn/driver.rs"]
mod driver;
