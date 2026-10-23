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
    marks::num,
    protocol::ChatMessage,
    tools::{
        CHAT_KEEPER,
        ToolContext,
        ToolRegistry,
    },
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_jdat::{
    Dat,
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
    pub person: bool,
    pub said:   bool,
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
    /// The prior transcript rows (`thread`: `{role, content, pre, mid, interject?}` each), read
    /// through [`ChatMessage::of_row_opening`] as the tab's `append_message` reads them: an
    /// interjection opens no turn (B3).
    pub thread:     Vec<ChatMessage>,
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
            Some(Dat::Map(m)) => How { person: flag(m, "person"), said: flag(m, "said") },
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
            thread:     match top.get(&key("thread")) {
                Some(Dat::List(l)) => l.iter().filter_map(|d| match d {
                    Dat::Map(m) => match m.get(&key("content")) {
                        Some(Dat::Str(c)) => ChatMessage::of_row_opening(&text(m, "role"),
                            c.clone(), text(m, "pre"), text(m, "mid"), !flag(m, "interject")),
                        _                 => None,
                    },
                    _ => None,
                }).collect(),
                _ => Vec::new(),
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
    let kept = end_keeper_turn(&registry.ctx, own).await;
    Driven { ended, kept }
}

/// End the store's turn for the keeper `ctx` keeps into: record what the turn kept as one version
/// of its store, and end its counts.  Answers the version recorded and its files.
///
/// A Diamond's keeper is ended only for its conversation's `own` turn.  Not while a steer runs on
/// the same Diamond, whose own turn end records the store's turn and must not have its captures
/// taken from under it: asked again once the store is held, since a steer can start during the
/// wait (R4 of the release 5.1 fix's QA, 2026-09-25).
pub async fn end_keeper_turn<H: Host>(ctx: &ToolContext<H>, own: bool) -> Option<Kept> {
    let key = match ctx.keeper() {
        Some(k) => k,
        None    => return None,
    };
    if !own && !key.starts_with(CHAT_KEEPER) {
        return None;
    }
    let store = ctx.host().store();
    store.keeper_turn_ended(&key);
    if store.is_steering(&key) {
        return None;
    }
    let hold = match store.hold_versions(&key).await {
        Ok(h)  => h,
        Err(e) => {
            // Left for the next turn end: the captures stay and the notes on disk.  The turn's
            // counts end here all the same (F4).
            store.end_turn_counts(&key);
            store.trail("TURN NOT RECORDED", &fmt!("{}: {}", key, e));
            return None;
        },
    };
    if store.is_steering(&key) {
        return None;
    }
    if let Err(e) = store.drain_turn(&hold, &key, ctx).await {
        store.trail("TURN NOT RECORDED", &fmt!("{}: {}", key, e));
        return None;
    }
    if let Err(e) = store.drain_windows(&hold, &key).await {
        store.trail("TURN NOT RECORDED", &fmt!("{}: {}", key, e));
        return None;
    }
    match store.versions_record_held(&hold, &key, None, Cause::Turn, "", "").await {
        Ok(Some((version, files)))  => Some(Kept { keeper: key, version, files }),
        Ok(None)                    => None,
        Err(e)                      => {
            store.trail("TURN NOT RECORDED", &fmt!("{}: {}", key, e));
            None
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN: &str = include_str!("../testdata/turn_golden.json");

    fn rows() -> Vec<DaticleMap> {
        match Dat::decode_string_with_config(GOLDEN, &crate::agent::compact::json_cfg()) {
            Ok(Dat::Map(top)) => match top.get(&key("sends")) {
                Some(Dat::List(l)) => l.iter().filter_map(|d| match d {
                    Dat::Map(m) => Some(m.clone()),
                    _           => None,
                }).collect(),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    #[test]
    fn golden_twelve_sends_match_the_js_decision() {
        let rows = rows();
        assert_eq!(rows.len(), 12, "the golden table holds twelve sends");
        for row in rows {
            let name = text(&row, "name");
            let input = match row.get(&key("in")) {
                Some(d) => match d.json_canonical() { Ok(s) => s, Err(e) => panic!("{}: {}", name, e) },
                None    => panic!("{}: no input", name),
            };
            let want = match row.get(&key("want")) {
                Some(Dat::Map(m)) => m.clone(),
                _                 => panic!("{}: no want", name),
            };
            let ask = match TurnAsk::from_json(&input) {
                Ok(a)  => a,
                Err(e) => panic!("{}: {}", name, e),
            };
            let got = resolve(&ask);
            assert_eq!(got.model, model_of(want.get(&key("model"))), "{}: model", name);
            assert_eq!(got.preset, text(&want, "preset"), "{}: preset", name);
            assert_eq!(got.depth, num(want.get(&key("depth"))) as i64, "{}: depth", name);
            assert_eq!(got.instruction, text(&want, "instruction"), "{}: instruction", name);
            assert_eq!(got.refused.map(|r| r.word()).unwrap_or(""), text(&want, "refused"), "{}: refused", name);
            assert_eq!(got.detached, flag(&want, "detached"), "{}: detached", name);
            let lease = match want.get(&key("lease")) {
                Some(Dat::Map(m)) => Some(Lease { turn: text(m, "turn"), until: num(m.get(&key("until"))) as u64 }),
                _                 => None,
            };
            assert_eq!(got.lease, lease, "{}: lease", name);
        }
    }

    #[test]
    fn the_spec_reads_back_as_the_page_reads_it() {
        let s = spec_json(r#"{"chat":"c1","diamond":"d1","default":{"provider":"a","model":"m"},"keyed":["a"],"typed":"hi"}"#);
        assert!(s.contains("\"provider\":\"a\""), "{}", s);
        assert!(s.contains("\"instruction\":\"hi\""), "{}", s);
        assert!(s.contains("\"refused\":\"\""), "{}", s);
        assert!(s.contains("\"lease\":null"), "{}", s);
    }

    #[test]
    fn a_send_that_is_not_an_object_is_an_error_not_a_turn() {
        let s = spec_json("[1,2]");
        assert!(s.starts_with("{\"error\":"), "{}", s);
    }

    #[test]
    fn a_send_carries_its_note_its_row_and_the_thread_as_the_tab_seeds_it() {
        let ask = match TurnAsk::from_json(r#"{"chat":"c1","default":{"provider":"a","model":"m"},"keyed":["a"],"typed":"go on","pre":"note","mid":"t9","thread":[{"role":"user","content":"first","pre":"p1","mid":"m1"},{"role":"assistant","content":"said"},{"role":"tool","content":"x"},{"role":"system","content":"s"},{"role":"user","content":7}]}"#) {
            Ok(a)  => a,
            Err(e) => panic!("{}", e),
        };
        let spec = resolve(&ask);
        assert_eq!(spec.pre, "note");
        assert_eq!(spec.mid, "t9");
        assert_eq!(spec.thread, vec![
            ChatMessage::user_noted("first".to_string(), "p1".to_string()).marked("m1".to_string()).opening(),
            ChatMessage::assistant("said".to_string()),
        ]);
    }

    /// EP-6 F6L (QA LOW-2): a thread row the page marks `interject` was said into a turn, never
    /// run as one, so it opens no turn (B3), as the tab's `append_message` reads it.
    #[test]
    fn a_thread_interjection_opens_no_turn() {
        let ask = match TurnAsk::from_json(r#"{"chat":"c1","default":{"provider":"a","model":"m"},"keyed":["a"],"typed":"go on","mid":"t9","thread":[{"role":"user","content":"ran","mid":"m1"},{"role":"user","content":"said in","mid":"m2","interject":true}]}"#) {
            Ok(a)  => a,
            Err(e) => panic!("{}", e),
        };
        let opens: Vec<bool> = resolve(&ask).thread.iter().map(|m| m.opens_turn()).collect();
        assert_eq!(opens, vec![true, false], "only the row a turn ran on opens one");
    }
}

#[cfg(test)]
mod driver {
    use super::*;
    use crate::engine::host::{
        test::{TestHost, clock::TestClock},
        test::store::closed::turn_ctx,
    };

    fn registry(keeper: &str) -> Rc<ToolRegistry<TestHost>> {
        let mut ctx = turn_ctx();
        ctx.keeper = keeper.to_string();
        Rc::new(ToolRegistry::new_on(Vec::new(), ctx))
    }

    fn ends(reg: &Rc<ToolRegistry<TestHost>>) -> u32 {
        reg.ctx.host().store().keeper_ends()
    }

    fn clock(reg: &Rc<ToolRegistry<TestHost>>) -> TestClock {
        reg.ctx.host().clock().clone()
    }

    fn now(c: &TestClock) -> u64 {
        c.now_ms() as u64
    }

    /// A turn that answers `out` at once, under `reg`.
    async fn quick(reg: &Rc<ToolRegistry<TestHost>>, own: bool, out: u32) -> Driven<u32> {
        let end = reg.clone();
        drive(reg.clone(), own, None, async move { (out, end) }).await
    }

    #[tokio::test]
    async fn keeper_end_runs_once_per_turn() {
        let chat = registry("chat:c1");
        for n in 1..=3u32 {
            let d = quick(&chat, false, n).await;
            assert_eq!(d.ended, Ended::Ran(n));
            println!("turn {}: keeper ends {}", n, ends(&chat));
            assert_eq!(ends(&chat), n, "a chat keeper's turn is ended once per turn");
        }
        // A Diamond's own thread turn ends its keeper; a worker's turn on the same Diamond does
        // not (its daimon's turn end does).
        let thread = registry("d1");
        let _ = quick(&thread, true, 1).await;
        assert_eq!(ends(&thread), 1, "a Diamond thread's turn ends its keeper once");
        let _ = quick(&thread, false, 2).await;
        assert_eq!(ends(&thread), 1, "a worker's turn leaves the Diamond keeper to its daimon");
        // No keeper, no end.
        let none = registry("");
        let _ = quick(&none, true, 1).await;
        assert_eq!(ends(&none), 0);
    }

    #[tokio::test]
    async fn no_renewal_past_the_deadline_is_interrupted() {
        let reg = registry("chat:c1");
        let c = clock(&reg);
        let lease = Renewal::new(now(&c) + 1_000);
        let ticking = c.clone();
        let end = reg.clone();
        let body = async move {
            // A wedged turn: the clock moves 30 s and nothing renews.  Bounded, so a driver that
            // never cuts it shows as a turn that ran, not a hung test.
            for _ in 0..100 {
                ticking.advance(300);
                ticking.sleep_ms(0).await;
            }
            (0u32, end)
        };
        let d = drive(reg.clone(), false, Some(&lease), body).await;
        println!("no renewal: {} at +{} ms, keeper ends {}", d.ended.word(),
            now(&c) - TEST_EPOCH, ends(&reg));
        assert_eq!(d.ended.word(), "interrupted");
        assert!(now(&c) > lease.until(), "ended only once the deadline had passed");
        assert_eq!(ends(&reg), 1, "an interrupted turn still ends its keeper, once");
    }

    #[tokio::test]
    async fn a_renewed_lease_never_ends_a_turn() {
        let reg = registry("chat:c1");
        let c = clock(&reg);
        let lease = Renewal::new(now(&c) + 1_000);
        let first = lease.until();
        let (ticking, renewing, end) = (c.clone(), lease.clone(), reg.clone());
        let body = async move {
            for _ in 0..40 {
                ticking.advance(300);
                renewing.renew(now(&ticking) + 1_000);
                ticking.sleep_ms(0).await;
            }
            (7u32, end)
        };
        let d = drive(reg.clone(), false, Some(&lease), body).await;
        println!("renewed: {} at +{} ms (first deadline +1000)", d.ended.word(),
            now(&c) - TEST_EPOCH);
        assert_eq!(d.ended, Ended::Ran(7));
        assert!(now(&c) > first, "the turn ran past its first deadline");
        assert_eq!(ends(&reg), 1);
    }

    #[tokio::test]
    async fn a_lease_with_no_deadline_never_lapses() {
        let reg = registry("chat:c1");
        let c = clock(&reg);
        let lease = Renewal::new(0);
        let (ticking, end) = (c.clone(), reg.clone());
        let body = async move {
            for _ in 0..10 {
                ticking.advance(60_000);
                ticking.sleep_ms(0).await;
            }
            (1u32, end)
        };
        let d = drive(reg.clone(), false, Some(&lease), body).await;
        assert_eq!(d.ended, Ended::Ran(1));
    }

    #[test]
    fn a_renewal_never_brings_the_deadline_nearer() {
        let l = Renewal::of(&Lease { turn: String::from("t"), until: 5_000 });
        l.renew(4_000);
        assert_eq!(l.until(), 5_000);
        l.renew(9_000);
        assert_eq!(l.until(), 9_000);
    }

    const TEST_EPOCH: u64 = crate::engine::host::test::clock::TEST_EPOCH_MS as u64;
}
