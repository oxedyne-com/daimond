//! The errand codec (R3a): peer.js's errand and report envelopes, natively, over S1's
//! seal ([`oxedyne_daimond::seal`]), byte for byte the tab's.
//!
//! # What travels
//!
//! | Envelope | Plaintext | Sealed as | Tab code |
//! |----------|-----------|-----------|----------|
//! | errand, report | `JSON.stringify` of the signed envelope | `DPY2 ‖ iv ‖ AES-GCM`, AAD `daimond/peer/env/1` | peer.js `sealForSelf` / `openEnvelope` |
//!
//! An errand or report is signed before it is sealed: `author` (the account's Ed25519 public key,
//! hex) and `sig` (base64) are appended after the builder's own fields, and the signature is over
//! peer.js `canonical` of the envelope without those two.  It opens only when it is sealed under
//! the account wrap key AND signed by the account, which is what stops a stranger who holds the
//! account's public card from dropping an errand into the box.
//!
//! # Where the keys are
//!
//! Nowhere in this module.  Every operation under the account wrap key or the account signing key
//! is one call on an [`AccountHolder`], which the keeper answers (the account bundle reaches the
//! keeper in R2d2); the runner parent hands it bytes and gets bytes back, as the tab hands
//! identity.js bytes for `wrapBytesAad` and `sign`.  The codec checks a signature itself, because
//! that needs only the public key.
//!
//! # Refusal and failure
//!
//! An open answers [`Opened::Refused`] for an envelope that is definitely not to be acted on (not
//! sealed, not under this account's key, not signed by it) -- the collector drops it, as peer.js
//! `peek`/`verifyEnvelope` answer `null`/`false` -- and an `Err` when the holder could not be
//! asked (the keeper away, locked), which leaves the row on the relay for the next collect, as
//! TAKEROW does in the tab.

use crate::{
    errand::{
        json::Js,
        rule_off,
    },
    seal::{
        peer,
        peer::Scheme,
    },
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_crypto::sign::verify_ed25519;
use oxedyne_fe2o3_hash::sha256;
use oxedyne_fe2o3_text::base64;

use zeroize::Zeroizing;

/// peer.js `ENVELOPE_V`.
pub const ENVELOPE_V: i64 = 1;
/// The signature scheme an envelope's `sigv` names: 2, the account key over the SHA-256 of the
/// envelope's `canonical` (UNBLOCK-50, -53).  Version 1, over the canonical text itself, is
/// refused with [`Refused::V1`]: one cut-over, no window (P2 design F5).
pub const SIG_V: i64 = 2; // fixed: the wire format's version
/// peer.js `T_ERRAND`.
pub const T_ERRAND: &str = "errand";
/// peer.js `T_REPORT`.
pub const T_REPORT: &str = "report";
/// peer.js `handBackReport`: a report that the runner ran nothing and hands the turn back.
pub const HANDED_BACK: &str = "undeliverable";
/// A hand-back's cause for a refusal before the run (RUN-HIST E): peer.js keeps it, and the
/// sender's "not run" row names it.
pub const CAUSE_REFUSED: &str = "refused";
/// A hand-back's cause for a turn rooted in a machine folder its runner cannot work in
/// (UNBLOCK-32 F2b): never run in the home instead; the sender ends it "not run" with Retry.
pub const CAUSE_PLACE: &str = "place";
/// A hand-back's cause for a turn whose answer alone was over the run pipe's ceiling (PIPE_MAX):
/// it cannot reach the sender whole, so it is never sent cut; the "not run" row says why, in the
/// runner's own words.
pub const CAUSE_OVERSIZE: &str = "oversize";
/// A hand-back's cause for a turn whose thread the runner does not hold (U11b): peer.js
/// `threadReadiness` `behind`.  The sender pulls it back and runs it where the chat is whole.
pub const CAUSE_THREAD: &str = "thread";
/// A hand-back's cause for an errand that carries no limits (KT-2): a tab built before
/// `limits`, whose model's window the runner does not know and will not guess.
pub const CAUSE_LIMITS: &str = "limits";
/// A hand-back's cause for an errand whose page speaks an engine ABI below this runner's
/// `ENGINE_ABI_MIN`, or names none (OWNKEY H3): never run under a reading the page did not mean.
pub const CAUSE_ABI: &str = "abi";
/// A hand-back's cause for an errand whose own-key providers the runner cannot use (OWNKEY I4,
/// I5): a half names a provider `keys` does not carry, `keys` carries `credits`, or a sealed row
/// does not open.  Never run on another source.
pub const CAUSE_KEYS: &str = "keys";
/// A hand-back's cause for an errand whose sealed envelope is over the post door's ceiling
/// (BOX-HOT): never run, and never left to block the box.
pub const CAUSE_SIZE: &str = "size";
/// peer.js `T_ASK`: a runner's live question for the person who sent the turn.
pub const T_ASK: &str = "consent-ask";
/// peer.js `T_GRANT`: their answer.
pub const T_GRANT: &str = "consent-grant";
/// peer.js `T_UNDO`: the asker's "Undo this turn", page to runner (RUN-HIST K3).
pub const T_UNDO: &str = "undo-turn";
/// peer.js `T_UNDONE`: what the runner's undo did, runner to asker, kept until acked.
pub const T_UNDONE: &str = "undone";
/// Every tag peer.js `peerType` accepts.
pub const PEER_TYPES: [&str; 8] = ["errand", "report", "consent-ask", "consent-grant", "compile", "built",
    "undo-turn", "undone"];
/// peer.js `PERMIT_ASKS`, the permit kinds an errand's `asks` may name.
pub const PERMIT_ASKS: [&str; 3] = ["place", "toolkit", "run"];
/// peer.js `NOTE_HOLD_MS` (`DISPATCH_DEADLINE_MS + LEASE_TTL_MS`).
pub const NOTE_HOLD_MS: i64 = 15 * 60 * 1000 + 90_000;
/// peer.js `LEASE_TTL_MS`.
pub const LEASE_TTL_MS: i64 = 90_000;

/// The one holder of the account's keys, which this codec asks and never reads.
///
/// In service the keeper answers each call over its channel; nothing returns key bytes.
pub trait AccountHolder {
    /// identity.js `wrapBytes` / `wrapBytesAad`: `iv ‖ AES-256-GCM(plain)` under the account wrap
    /// key, binding `aad` when given.
    fn wrap(&self, plain: &[u8], aad: Option<&[u8]>) -> Outcome<Vec<u8>>;
    /// The other way: `Ok(None)` when the tag does not verify (another key, another `aad`, a
    /// changed byte), `Err` when the holder could not try.
    fn unwrap(&self, body: &[u8], aad: Option<&[u8]>) -> Outcome<Option<Zeroizing<Vec<u8>>>>;
    /// The account's Ed25519 public key, identity.js `publicKeyRaw`.
    fn author(&self) -> Outcome<[u8; 32]>;
    /// identity.js `sign`: the account key's raw 64-byte Ed25519 signature of `msg`.
    fn sign(&self, msg: &[u8]) -> Outcome<Vec<u8>>;
}

/// Why an envelope was refused, each a definite answer the collector drops on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// Not base64, or no known scheme tag at its front.
    NotSealed,
    /// The AES-GCM tag did not verify: another account's key, or a changed byte.
    NotForYou,
    /// A legacy `DPS1` X25519 body, which the runner holds no sealing secret to open.
    Legacy,
    /// It opened, but is not JSON carrying a peer tag `t`.
    NotEnvelope,
    /// It opened, but is not signed by this account.
    Unsigned,
    /// It opened, but is signed under scheme 1 (no `sigv:2`), which is refused whole.
    V1,
}

impl Refused {
    /// The code a log line and the tab share (`not_for_you` is the seal's own).
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotSealed     => "not_sealed",
            Self::NotForYou     => "not_for_you",
            Self::Legacy        => "legacy",
            Self::NotEnvelope   => "not_envelope",
            Self::Unsigned      => "unsigned",
            Self::V1            => "sig:v1-refused",
        }
    }
}

/// What an open found.
#[derive(Clone, Debug, PartialEq)]
pub enum Opened<T> {
    Envelope(T),
    Refused(Refused),
}

/// An opened, verified peer envelope.
#[derive(Clone, Debug, PartialEq)]
pub enum Envelope {
    Errand(Errand),
    Report(Report),
    /// An ask, grant, compile or built note, kept whole for the units that read them.
    Other(Js),
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The errand and the report                                     │
// └───────────────────────────────────────────────────────────────┘

/// peer.js `makeErrand`'s envelope.  The opaque parts (`model`, `scope`, `pause`, `seed`,
/// `thread`) are kept as the tab wrote them.
#[derive(Clone, Debug, PartialEq)]
pub struct Errand {
    pub eid:            String,
    pub turn_id:        String,
    pub chat_id:        String,
    pub diamond_id:     String,
    pub prompt:         String,
    pub pre:            String,
    pub effort:         String,
    pub model:          Js,
    pub scope:          Js,
    /// The page-resolved absolute fence, `{"rw":[],"ro":[],"deny":[],"net":b}`: the engine's
    /// `fence_spec` over the turn's bounds as the tab's Hand gets it (R3c2).  Kept as the tab
    /// wrote it, so the envelope round-trips, and never read: a run is fenced by the runner's
    /// own whole-home fence (HF3), whatever this carries or lacks.
    pub fence:          Js,
    pub pause:          Js,
    pub parcel_version: i64,
    pub deadline:       i64,
    pub dispatched_by:  String,
    pub park_count:     i64,
    pub tried:          Vec<String>,
    pub seed:           Js,
    pub thread:         Js,
    /// The last message the asker saw, `{ts, mid}` (`throughOf`, UNBLOCK-11), as `makeErrand`
    /// coerces it; `Null` when the chat held nothing before the prompt, and from an older sender.
    pub through:        Js,
    /// The asker's message ids before the turn, oldest first, as peer.js `midHash`es (`threadIds`,
    /// at most 512): which rows `thread.n` counts.  `None` from an older dispatcher (the tab's
    /// `null`), which is not the same word as `Some(empty)`, a chat with nothing before the prompt.
    pub ids:            Option<Vec<String>>,
    pub gone:           Vec<String>,
    pub behind:         Vec<String>,
    pub to:             String,
    pub asks:           Vec<String>,
    pub auto:           bool,
    pub pending_only:   bool,       // a mail trigger's turn, reported on the Pending panel alone
    /// Has the chat read nothing from outside (U4 ERRAND-TAINT)?  True only for a tab's
    /// `"clean":true`; absent, null, false, a string or a number all read as tainted, so every
    /// tab built before the field fails closed.  It NARROWS ONLY: a run reads it to withhold
    /// network, never to grant it, and it is never copied into the child's fence.
    pub clean:          bool,
    /// The packs the account has not bought (U13a PACK-CARRY), as the tab's `LOCKED_PACKS`
    /// holds them, lower-cased.  `None` when the tab sent no list, or a list that is not one of
    /// strings: the run then locks every pack, so a tab built before the field never unlocks a
    /// paid tool.  `Some(empty)` is the tab's word that nothing is locked.  It NARROWS ONLY.
    pub locked:         Option<Vec<String>>,
    /// The page's applied limits for the turn (KT-2, engine `TurnLimits` under the page's
    /// names), kept as the tab wrote them, as `model` is; `Null` from a tab built before the
    /// field, whose turn the runner hands back rather than guess the model's window.
    pub limits:         Js,
    /// What the page's marks put in reach for the turn (KT-4, engine `Reach` under its own
    /// names), kept as the tab wrote it; `Null` where it sent none, and the turn then carries no
    /// `Attached` block.
    pub reach:          Js,
    pub today:          String,     // the page's `Today` block, '' where it sent none (KT-4)
    /// The page's reference to an engine session too large for the relay door (KT-4b),
    /// `{chat, sig, upto}`: the chat, its thread's `sig`, and the session's `upto`, which a runner
    /// holding the chat checks against what it holds.  `Null` where the session rode the seed.
    pub session_ref:    Js,
    /// His own providers' sealed rows (OWNKEY §1.1), `{"<pid>": {url, keyEnc, fetched}}`, kept
    /// as the tab wrote them: each `keyEnc` opens only through the keeper.  `Null` where it sent
    /// none, a turn on credits alone.
    pub keys:           Js,
    /// Which provider pays the run's PDF and picture reads, `{pdf, image}`, as the page's
    /// `ocr.js` `route()` decided it (OWNKEY A1, QA OKD-A M-2), kept as the tab wrote it; `Null`
    /// where it sent none, which routes no read ([`the runner's `run::ReadRoute``]).
    pub ocr:            Js,
    pub abi:            i64,        // the page's `ENGINE_ABI` (OWNKEY H3), 0 where it sent none
    pub ts:             i64,
}

impl Errand {
    /// The envelope object, keys in `makeErrand`'s order, lists as its `triedList`/`askList`
    /// leave them.  `clean` is written only when true, as `makeErrand` writes it, so a tainted
    /// errand carries no key a reader could misread.
    pub fn to_js(&self) -> Js {
        let mut kv = vec![
            ("t".into(),            Js::str(T_ERRAND)),
            ("v".into(),            Js::int(ENVELOPE_V)),
            ("eid".into(),          Js::str(&self.eid)),
            ("turnId".into(),       Js::str(&self.turn_id)),
            ("chatId".into(),       Js::str(&self.chat_id)),
            ("diamondId".into(),    Js::str(&self.diamond_id)),
            ("prompt".into(),       Js::str(&self.prompt)),
            ("pre".into(),          Js::str(&self.pre)),
            ("effort".into(),       Js::str(&self.effort)),
            ("model".into(),        self.model.clone()),
            ("scope".into(),        self.scope.clone()),
            ("fence".into(),        self.fence.clone()),
            ("pause".into(),        self.pause.clone()),
            ("parcelVersion".into(), Js::int(self.parcel_version)),
            ("deadline".into(),     Js::int(self.deadline)),
            ("dispatchedBy".into(), Js::str(&self.dispatched_by)),
            ("parkCount".into(),    Js::int(self.park_count)),
            ("tried".into(),        Js::strs(&id_list(&self.tried))),
            ("seed".into(),         self.seed.clone()),
            ("thread".into(),       self.thread.clone()),
            ("through".into(),      self.through.clone()),
            ("ids".into(),          match &self.ids {
                Some(v) => Js::strs(v),
                None    => Js::Null,
            }),
            ("gone".into(),         Js::strs(&id_list(&self.gone))),
            ("behind".into(),       Js::strs(&id_list(&self.behind))),
            ("to".into(),           Js::str(&self.to)),
            ("asks".into(),         Js::strs(&ask_list(&self.asks))),
            ("auto".into(),         Js::Bool(self.auto)),
            ("pendingOnly".into(),  Js::Bool(self.pending_only)),
            ("ts".into(),           Js::int(self.ts)),
        ];
        // Written only when set, so an older asker's errand is the bytes it always was.
        if self.clean {
            kv.push(("clean".into(), Js::Bool(true)));
        }
        if let Some(l) = &self.locked {
            kv.push(("locked".into(), Js::strs(l)));
        }
        if let Js::Obj(_) = &self.limits {
            kv.push(("limits".into(), self.limits.clone()));
        }
        // The page's reach and today line (KT-4) close the errand, after the limits.
        if let Js::Obj(_) = &self.reach {
            kv.push(("reach".into(), self.reach.clone()));
        }
        if !self.today.is_empty() {
            kv.push(("today".into(), Js::str(&self.today)));
        }
        // The over-door session's reference (KT-4b) closes it, after the today line.
        if let Js::Obj(_) = &self.session_ref {
            kv.push(("sessionRef".into(), self.session_ref.clone()));
        }
        // His sealed provider rows (OWNKEY §2.1), after the reference and before the ABI.
        if let Js::Obj(_) = &self.keys {
            kv.push(("keys".into(), self.keys.clone()));
        }
        // The reads' route (M-2), after the keys it chooses among and before the ABI.
        if let Js::Obj(_) = &self.ocr {
            kv.push(("ocr".into(), self.ocr.clone()));
        }
        // The page's engine ABI (OWNKEY H3) closes it, after the reference.
        if self.abi != 0 {
            kv.push(("abi".into(), Js::int(self.abi)));
        }
        Js::Obj(kv)
    }

    /// An errand read from an opened envelope, each field as `makeErrand` would have coerced it.
    pub fn of_js(o: &Js) -> Self {
        Self {
            eid:            text(o, "eid"),
            turn_id:        text(o, "turnId"),
            chat_id:        text(o, "chatId"),
            diamond_id:     text(o, "diamondId"),
            prompt:         text(o, "prompt"),
            pre:            text(o, "pre"),
            effort:         text(o, "effort"),
            model:          opaque(o, "model"),
            scope:          opaque(o, "scope"),
            fence:          opaque(o, "fence"),
            pause:          opaque(o, "pause"),
            parcel_version: whole(o, "parcelVersion"),
            deadline:       whole(o, "deadline"),
            dispatched_by:  text(o, "dispatchedBy"),
            park_count:     whole(o, "parkCount"),
            tried:          id_list(&texts(o, "tried")),
            seed:           opaque(o, "seed"),
            thread:         opaque(o, "thread"),
            through:        through_of(o),
            ids:            match o.get("ids") {
                Some(Js::Arr(_))    => Some(texts(o, "ids").into_iter().filter(|s| !s.is_empty()).collect()),
                _                   => None,
            },
            gone:           id_list(&texts(o, "gone")),
            behind:         id_list(&texts(o, "behind")),
            to:             text(o, "to"),
            asks:           ask_list(&texts(o, "asks")),
            auto:           matches!(o.get("auto"), Some(Js::Bool(true))),
            pending_only:   matches!(o.get("pendingOnly"), Some(Js::Bool(true))),
            clean:          matches!(o.get("clean"), Some(Js::Bool(true))) || rule_off("errand_clean"),
            locked:         locked_list(o),
            limits:         match o.get("limits") {
                Some(v @ Js::Obj(_))    => v.clone(),
                _                       => Js::Null,
            },
            reach:          match o.get("reach") {
                Some(v @ Js::Obj(_))    => v.clone(),
                _                       => Js::Null,
            },
            today:          text(o, "today"),
            session_ref:    match o.get("sessionRef") {
                Some(v @ Js::Obj(_))    => v.clone(),
                _                       => Js::Null,
            },
            keys:           match o.get("keys") {
                Some(v @ Js::Obj(_))    => v.clone(),
                _                       => Js::Null,
            },
            ocr:            match o.get("ocr") {
                Some(v @ Js::Obj(_))    => v.clone(),
                _                       => Js::Null,
            },
            abi:            whole(o, "abi"),
            ts:             whole(o, "ts"),
        }
    }
}

/// peer.js `makeReport`'s envelope.
#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub eid:            String,
    pub turn_id:        String,
    pub chat_id:        String,
    /// done | refused-spend | error | aborted | parked | undeliverable
    pub status:         String,
    pub to:             String,
    pub parcel_version: i64,
    pub cost:           Js,
    pub why:            String,
    pub paused:         String,
    pub park_count:     i64,
    pub final_tail:     i64,
    pub by:             String,
    pub busy:           i64,
    /// `thread`, `refused` (a refusal before the run, RUN-HIST E), `place` (UNBLOCK-32 F2b) or
    /// empty; anything else is written as empty, as `makeReport` does.
    pub cause:          String,
    pub interrupted:    i64,
    pub cut:            String,
    /// The ids of the sender's mid-turn words the model heard (UNBLOCK-27 R7, `heard`), which
    /// peer.js `makeReport` always writes.  A runner hears no mid-turn words, so its own report
    /// says `[]`: the sender then queues every word it said as the next turn.
    pub heard:          Vec<String>,
    pub ts:             i64,
    /// The turn's own row for the asker's History (RUN-HIST K2, `turnRec`), or `Null`: written
    /// only when set, so an old asker reads the report it always read.
    pub turn_rec:       Js,
    /// The runner's record of the chat's taint when the report was made (NF3, `taintedAt`): the
    /// stamp the chat first read outside content at, or 0 for none.  Written only when set, so a
    /// clean chat's report is the one an old asker always read.
    pub tainted_at:     u64,
    /// The run's engine session sent home (KT-5, `session`): `{v, msgs, turnStart, base, upto,
    /// uptoTs}`, `msgs` the session after the turn whole, `base` the `upto` of the session the
    /// errand carried (the tab's conflict check), `upto`/`uptoTs` the turn's last row; or `Null`.
    pub session:        Js,
    /// The session stayed on the runner's side (KT-5, `sessionStayed`): whole it was over the
    /// door, and a cut one would orphan a tool call, so the tab lays its engine from the transcript.
    pub session_stayed: bool,
    /// The runner's `ENGINE_ABI` (OWNKEY H3), which the page refuses below its own min; 0, and
    /// not written, on a report peer.js `reportFor` makes.
    pub abi:            i64,
    /// The turn's raises and clears on its Diamond's Pending panel, in order (KT-5d, `alerts`):
    /// each `{op:"raise",key,headline,detail,needs}` or `{op:"clear",key}`, for the asking tab
    /// to apply.
    pub alerts:         Vec<Js>,
    /// His words the run's folds staged (U2a, `words`), in the words log's entry form, for the
    /// tab to file in its own log; empty for none.  On any status.
    pub words:          String,
    /// The turn's question to him (RUNNER-ASK, `ask`): the `ask` tool's own arguments, `{question,
    /// options:[{label, means}], recommend, why, if_silent}`, for his tab to draw as its Decision
    /// tile; `Null`, and not written, where the turn asked nothing.
    pub ask:            Js,
}

/// One alert as a report carries it, from the engine's checked `payload` (KT-5d): `None` where
/// the payload is not JSON or names no key.
pub fn alert_of(raise: bool, payload: &str) -> Option<Js> {
    let mut o = match Js::parse(payload) {
        Ok(Js::Obj(kv)) => kv,
        _               => return None,
    };
    o.insert(0, ("op".into(), Js::str(if raise { "raise" } else { "clear" })));
    alert_norm(&Js::Obj(o))
}

/// The most options a runner's ask carries, and the fewest (RUNNER-ASK): the Decision tile's own.
pub const ASK_OPTIONS_MIN: usize = 2;
pub const ASK_OPTIONS_MAX: usize = 4;
/// The longest option label a runner's ask carries, in characters (RUNNER-ASK).
pub const ASK_LABEL_CAP: usize = 80;
/// The longest option `means` a runner's ask carries, in characters (RUNNER-ASK).
pub const ASK_MEANS_CAP: usize = 300;

/// The `ask` tool's own arguments, `{question, options:[{label, means}], recommend, why,
/// if_silent}`, from the engine's checked `payload` (RUNNER-ASK), or the sentence that refuses it:
/// 2 to 4 options, exactly one recommended, each label at most [`ASK_LABEL_CAP`] characters and
/// each `means` at most [`ASK_MEANS_CAP`], for the tab cannot draw anything else.
pub fn ask_args(payload: &str) -> std::result::Result<Js, String> {
    let o = match Js::parse(payload) {
        Ok(o @ Js::Obj(_))  => o,
        _                   => return Err(String::from("The question did not arrive as one whole object.")),
    };
    let field = |k: &str| o.get_str(k).unwrap_or("").to_string();
    let opts = match o.get("options") {
        Some(Js::Arr(v))    => v.clone(),
        _                   => Vec::new(),
    };
    if opts.len() < ASK_OPTIONS_MIN || opts.len() > ASK_OPTIONS_MAX {
        return Err(fmt!("It has {} options, and his buttons take {} to {}.", opts.len(),
            ASK_OPTIONS_MIN, ASK_OPTIONS_MAX));
    }
    let mut out: Vec<Js> = Vec::with_capacity(opts.len());
    let mut recommend: Vec<String> = Vec::new();
    for one in &opts {
        let label = one.get_str("label").unwrap_or("").to_string();
        let means = one.get_str("means").unwrap_or("").to_string();
        if label.trim().is_empty() {
            return Err(String::from("An option has no label, and a button cannot be blank."));
        }
        if label.chars().count() > ASK_LABEL_CAP {
            return Err(fmt!("The label '{}…' is {} characters, and his buttons take {}.",
                label.chars().take(24).collect::<String>(), label.chars().count(), ASK_LABEL_CAP));
        }
        if means.chars().count() > ASK_MEANS_CAP {
            return Err(fmt!("What '{}' means is {} characters, and his tile takes {}.",
                label, means.chars().count(), ASK_MEANS_CAP));
        }
        if one.get("recommended") == Some(&Js::Bool(true)) {
            recommend.push(label.clone());
        }
        out.push(Js::Obj(vec![("label".into(), Js::str(&label)), ("means".into(), Js::str(&means))]));
    }
    if recommend.len() != 1 {
        return Err(fmt!("It recommends {} options, and his tile marks exactly one.", recommend.len()));
    }
    Ok(Js::Obj(vec![
        ("question".into(),     Js::str(&field("question"))),
        ("options".into(),      Js::Arr(out)),
        ("recommend".into(),    Js::str(&recommend.pop().unwrap_or_default())),
        ("why".into(),          Js::str(&field("why"))),
        ("if_silent".into(),    Js::str(&field("if_silent"))),
    ]))
}

// The most alerts one report carries, one per key (QA ccp4-b K1): the panel's own bound on a
// Diamond's live alerts (www/js/alerts.js `LIVE_MAX`), so a report stays far under the post door.
pub const ALERTS_MAX: usize = 20;

/// `a` folded into a turn's `alerts` as the panel would take it: a key already there is replaced
/// in its place, the latest raise or clear winning; a new key is added only below
/// [`ALERTS_MAX`].  Answers whether it was taken.
pub fn alert_fold(alerts: &mut Vec<Js>, a: Js) -> bool {
    let key = a.get_str("key").unwrap_or("").to_string();
    match alerts.iter().position(|b| b.get_str("key") == Some(key.as_str())) {
        Some(i)                             => alerts[i] = a,
        None if alerts.len() < ALERTS_MAX   => alerts.push(a),
        None                                => return false,
    }
    true
}

/// One report alert as peer.js `makeReport` normalises it: a raise with its four fields (a
/// missing text is '', `needs` true only when it is), a clear with its key alone; `None` for any
/// other op or no key, which is dropped.
fn alert_norm(a: &Js) -> Option<Js> {
    let s = |k: &str| match a.get(k) {
        Some(Js::Str(v))    => v.clone(),
        _                   => String::new(),
    };
    let key = s("key");
    if key.is_empty() {
        return None;
    }
    match a.get_str("op") {
        Some("raise")   => Some(Js::Obj(vec![
            ("op".into(),       Js::str("raise")),
            ("key".into(),      Js::Str(key)),
            ("headline".into(), Js::Str(s("headline"))),
            ("detail".into(),   Js::Str(s("detail"))),
            ("needs".into(),    Js::Bool(matches!(a.get("needs"), Some(Js::Bool(true))))),
        ])),
        Some("clear")   => Some(Js::Obj(vec![
            ("op".into(),       Js::str("clear")),
            ("key".into(),      Js::Str(key)),
        ])),
        _               => None,
    }
}

/// A report's `alerts`, each normalised and the malformed dropped.
fn alerts_of(o: &Js) -> Vec<Js> {
    match o.get("alerts") {
        Some(Js::Arr(v))    => v.iter().filter_map(alert_norm).collect(),
        _                   => Vec::new(),
    }
}

/// A hand-back cause peer.js reads: [`CAUSE_THREAD`], [`CAUSE_REFUSED`], [`CAUSE_PLACE`],
/// [`CAUSE_LIMITS`], [`CAUSE_ABI`], [`CAUSE_KEYS`], [`CAUSE_OVERSIZE`] or [`CAUSE_SIZE`].
fn known_cause(c: &str) -> bool {
    c == CAUSE_THREAD || c == CAUSE_REFUSED || c == CAUSE_PLACE || c == CAUSE_LIMITS || c == CAUSE_ABI
        || c == CAUSE_KEYS || c == CAUSE_OVERSIZE || c == CAUSE_SIZE
}

/// peer.js `midHash`: FNV-1a of a message id over its UTF-16 units, base 36, the name an
/// errand's `ids` gives each message.
pub fn mid_hash(mid: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for u in mid.encode_utf16() {
        h ^= u as u32;
        h = h.wrapping_mul(16_777_619);
    }
    let mut out = Vec::new();
    loop {
        out.push(std::char::from_digit(h % 36, 36).unwrap_or('0'));
        h /= 36;
        if h == 0 {
            break;
        }
    }
    out.iter().rev().collect()
}

impl Report {
    /// peer.js `reportFor`: a report on `e` with `status`, its turn, chat, id and addressee (the
    /// errand's dispatcher) taken from the errand, everything else empty for the caller to set.
    pub fn for_errand(e: &Errand, status: &str, ts: i64) -> Self {
        Self {
            eid:            e.eid.clone(),
            turn_id:        e.turn_id.clone(),
            chat_id:        e.chat_id.clone(),
            status:         if status.is_empty() { "done".into() } else { status.into() },
            to:             e.dispatched_by.clone(),
            parcel_version: 0,
            cost:           Js::Null,
            why:            String::new(),
            paused:         String::new(),
            park_count:     0,
            final_tail:     0,
            by:             String::new(),
            busy:           0,
            cause:          String::new(),
            interrupted:    0,
            cut:            String::new(),
            heard:          Vec::new(),
            ts,
            turn_rec:       Js::Null,
            tainted_at:     0,
            session:        Js::Null,
            session_stayed: false,
            abi:            0,
            alerts:         Vec::new(),
            words:          String::new(),
            ask:            Js::Null,
        }
    }

    /// The envelope object, keys in `makeReport`'s order.
    pub fn to_js(&self) -> Js {
        let mut o = vec![
            ("t".into(),            Js::str(T_REPORT)),
            ("v".into(),            Js::int(ENVELOPE_V)),
            ("eid".into(),          Js::str(&self.eid)),
            ("turnId".into(),       Js::str(&self.turn_id)),
            ("chatId".into(),       Js::str(&self.chat_id)),
            ("status".into(),       Js::str(if self.status.is_empty() { "done" } else { &self.status })),
            ("to".into(),           Js::str(&self.to)),
            ("parcelVersion".into(), Js::int(self.parcel_version)),
            ("cost".into(),         self.cost.clone()),
            ("why".into(),          Js::str(&self.why)),
            ("paused".into(),       Js::str(&self.paused)),
            ("parkCount".into(),    Js::int(self.park_count)),
            ("finalTail".into(),    Js::int(self.final_tail)),
            ("by".into(),           Js::str(&self.by)),
            ("busy".into(),         Js::int(self.busy)),
            ("cause".into(),        Js::str(if known_cause(&self.cause) { &self.cause } else { "" })),
            ("interrupted".into(),  Js::int(self.interrupted)),
            ("cut".into(),          Js::str(&self.cut)),
            ("heard".into(),        Js::strs(&self.heard)),
            ("ts".into(),           Js::int(self.ts)),
        ];
        if self.turn_rec != Js::Null {
            o.push(("turnRec".into(), self.turn_rec.clone()));
        }
        if self.tainted_at != 0 {
            o.push(("taintedAt".into(), Js::int(i64::try_from(self.tainted_at).unwrap_or(i64::MAX))));
        }
        // KT-5: after every older key and only when set, so a report that sends no session home
        // is the one an older asker always read.
        if self.session != Js::Null {
            o.push(("session".into(), self.session.clone()));
        }
        if self.session_stayed {
            o.push(("sessionStayed".into(), Js::int(1)));
        }
        // OWNKEY H3: the runner's ABI, written only when set.
        if self.abi != 0 {
            o.push(("abi".into(), Js::int(self.abi)));
        }
        // KT-5d: after it, and only when the turn raised or cleared any.
        if !self.alerts.is_empty() {
            o.push(("alerts".into(), Js::Arr(self.alerts.clone())));
        }
        // U2a: last, and only when there are any, so a report whose run filed none is the one an
        // older asker always read.
        if !self.words.is_empty() {
            o.push(("words".into(), Js::str(&self.words)));
        }
        // RUNNER-ASK: after `words`, the last key, and only when the turn asked.
        if self.ask != Js::Null {
            o.push(("ask".into(), self.ask.clone()));
        }
        Js::Obj(o)
    }

    /// A report read from an opened envelope.
    pub fn of_js(o: &Js) -> Self {
        let cause = text(o, "cause");
        Self {
            eid:            text(o, "eid"),
            turn_id:        text(o, "turnId"),
            chat_id:        text(o, "chatId"),
            status:         text(o, "status"),
            to:             text(o, "to"),
            parcel_version: whole(o, "parcelVersion"),
            cost:           opaque(o, "cost"),
            why:            text(o, "why"),
            paused:         text(o, "paused"),
            park_count:     whole(o, "parkCount"),
            final_tail:     whole(o, "finalTail"),
            by:             text(o, "by"),
            busy:           whole(o, "busy"),
            cause:          if known_cause(&cause) { cause } else { String::new() },
            interrupted:    whole(o, "interrupted"),
            cut:            text(o, "cut"),
            heard:          texts(o, "heard"),
            ts:             whole(o, "ts"),
            turn_rec:       opaque(o, "turnRec"),
            tainted_at:     u64::try_from(whole(o, "taintedAt")).unwrap_or(0),
            session:        opaque(o, "session"),
            session_stayed: whole(o, "sessionStayed") == 1,
            abi:            whole(o, "abi"),
            alerts:         alerts_of(o),
            words:          text(o, "words"),
            ask:            match o.get("ask") {
                Some(v @ Js::Obj(_))    => v.clone(),
                _                       => Js::Null,
            },
        }
    }
}

/// peer.js `makeUndo`'s envelope, as the runner reads it: the asker's "Undo this turn".  No trash
/// key is carried: the runner looks it up from its own record of `run`.
#[derive(Clone, Debug, PartialEq)]
pub struct UndoTurn {
    pub uid:    String,
    /// The runner it is for (`turnRec.on`).
    pub to:     String,
    /// The asker's device, which the answer goes to.
    pub by:     String,
    pub keeper: String,
    /// `e-<eid>`, as `turnRec.run` named it.
    pub run:    String,
    pub ts:     i64,
}

impl UndoTurn {
    pub fn of_js(o: &Js) -> Self {
        Self {
            uid:    text(o, "uid"),
            to:     text(o, "to"),
            by:     text(o, "by"),
            keeper: text(o, "keeper"),
            run:    text(o, "run"),
            ts:     whole(o, "ts"),
        }
    }

    pub fn to_js(&self) -> Js {
        Js::Obj(vec![
            ("t".into(),        Js::str(T_UNDO)),
            ("v".into(),        Js::int(ENVELOPE_V)),
            ("uid".into(),      Js::str(&self.uid)),
            ("to".into(),       Js::str(&self.to)),
            ("by".into(),       Js::str(&self.by)),
            ("keeper".into(),   Js::str(&self.keeper)),
            ("run".into(),      Js::str(&self.run)),
            ("ts".into(),       Js::int(self.ts)),
        ])
    }
}

/// The runner's answer to an `undo-turn`: `status` is `done`, `already`, `expired`, `busy` or
/// `error`; `keeper` is the turn's (`turnRec.keeper`), so any of the asker's devices can record
/// the undo; `undo` is the undo's own restore reference (`{on, run, since, until}`), or `Null`
/// where nothing was undone.
#[allow(clippy::too_many_arguments)]
pub fn undone_js(uid: &str, to: &str, run: &str, keeper: &str, status: &str, restored: &[String],
    skipped: &[(String, String)], removed: &[String], undo: Js) -> Js
{
    Js::Obj(vec![
        ("t".into(),        Js::str(T_UNDONE)),
        ("v".into(),        Js::int(ENVELOPE_V)),
        ("uid".into(),      Js::str(uid)),
        ("to".into(),       Js::str(to)),
        ("run".into(),      Js::str(run)),
        ("keeper".into(),   Js::str(keeper)),
        ("status".into(),   Js::str(status)),
        ("restored".into(), Js::strs(restored)),
        ("skipped".into(),  Js::Arr(skipped.iter().map(|(p, why)| Js::Obj(vec![
            ("path".into(), Js::str(p)),
            ("why".into(),  Js::str(why)),
        ])).collect())),
        ("removed".into(),  Js::strs(removed)),
        ("undo".into(),     undo),
    ])
}

pub(crate) fn text(o: &Js, key: &str) -> String {
    match o.get(key) {
        Some(Js::Str(s)) => s.clone(),
        Some(Js::Num(n)) => n.clone(),
        Some(Js::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

/// The errand's `locked` packs: an array of strings, lower-cased with blanks dropped, or `None`
/// for anything else, which the run reads as every pack locked (U13a).
fn locked_list(o: &Js) -> Option<Vec<String>> {
    let v = match o.get("locked") {
        Some(Js::Arr(v))    => v,
        _                   => return None,
    };
    let mut out = Vec::new();
    for x in v {
        match x {
            Js::Str(s)  => {
                let k = s.trim().to_lowercase();
                if !k.is_empty() {
                    out.push(k);
                }
            },
            _           => return None,
        }
    }
    Some(out)
}

pub(crate) fn opaque(o: &Js, key: &str) -> Js {
    match o.get(key) {
        Some(v) => v.clone(),
        None => Js::Null,
    }
}

/// The errand's `through`, as `makeErrand` coerces it: `{ts, mid}` when it names a mid, else
/// `Null`.
fn through_of(o: &Js) -> Js {
    match o.get("through") {
        Some(t @ Js::Obj(_)) => match t.get("mid") {
            Some(Js::Str(m)) if !m.is_empty() => Js::Obj(vec![
                ("ts".into(),   Js::int(whole(t, "ts"))),
                ("mid".into(),  Js::str(m)),
            ]),
            _ => Js::Null,
        },
        _ => Js::Null,
    }
}

/// A whole number field; a fraction is cut toward zero, anything else is 0.
pub fn whole(o: &Js, key: &str) -> i64 {
    match o.get(key) {
        Some(Js::Num(n)) => match n.parse::<i64>() {
            Ok(v) => v,
            Err(_) => match n.parse::<f64>() {
                Ok(f) if f.is_finite() => f.trunc() as i64,
                _ => 0,
            },
        },
        _ => 0,
    }
}

pub(crate) fn texts(o: &Js, key: &str) -> Vec<String> {
    match o.get(key) {
        Some(Js::Arr(v)) => v.iter().map(|x| match x {
            Js::Str(s) => s.clone(),
            Js::Num(n) => n.clone(),
            _ => String::new(),
        }).collect(),
        _ => Vec::new(),
    }
}

/// peer.js `triedList`: non-empty ids, each once, in first order.
pub fn id_list(v: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in v {
        if !id.is_empty() && !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

/// peer.js `askList`: known permit kinds only, each once.
pub fn ask_list(v: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for k in v {
        if PERMIT_ASKS.contains(&k.as_str()) && !out.contains(k) {
            out.push(k.clone());
        }
    }
    out
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Signing, sealing and opening                                  │
// └───────────────────────────────────────────────────────────────┘

/// What the account key signs (`sigv:2`): the SHA-256 of `canonical` of the envelope without its
/// `author` and `sig`, `sigv` included.  A digest, so a report of any size signs as 32 bytes and
/// never meets the signer's message cap.
pub fn signed_bytes(obj: &Js) -> Vec<u8> {
    let base = match obj {
        Js::Obj(kv) => Js::Obj(kv.iter().filter(|(k, _)| k != "author" && k != "sig").cloned().collect()),
        other => other.clone(),
    };
    sha256::digest(base.canonical().as_bytes()).to_vec()
}

/// Is the envelope marked `sigv:2`?
pub fn is_sig_v2(obj: &Js) -> bool {
    matches!(obj.get("sigv"), Some(Js::Num(n)) if n.as_str() == "2")
}

/// The envelope as it is to be signed: `sigv:2` set, any `author` and `sig` dropped.  The tab
/// signs [`signed_bytes`] of this and appends the two with [`signed_with`].
pub fn to_sign(obj: &Js) -> Outcome<Js> {
    let kv = match obj {
        Js::Obj(kv) => kv,
        _ => return Err(err!("A peer envelope must be an object."; Invalid, Input)),
    };
    let mut out: Vec<(String, Js)> = kv.iter()
        .filter(|(k, _)| k != "author" && k != "sig" && k != "sigv").cloned().collect();
    out.push(("sigv".into(), Js::int(SIG_V)));
    Ok(Js::Obj(out))
}

/// `base` (from [`to_sign`]) with `author` (hex) and `sig` (base64) appended.
pub fn signed_with(base: &Js, author: &[u8; 32], sig: &[u8]) -> Outcome<Js> {
    let mut out = match base {
        Js::Obj(kv) => kv.clone(),
        _ => return Err(err!("A peer envelope must be an object."; Invalid, Input)),
    };
    out.push(("author".into(), Js::Str(crate::seal::hex(author))));
    out.push(("sig".into(), Js::Str(base64::encode(sig))));
    Ok(Js::Obj(out))
}

/// The envelope with `sigv:2`, `author` and `sig` appended, signed by the holder.  An envelope
/// already signed under `sigv:2` (a re-seal) is answered as it is; one signed under scheme 1 is
/// refused, never re-signed as if it were new.
pub fn sign_envelope<H: AccountHolder>(holder: &H, obj: &Js) -> Outcome<Js> {
    if obj.get("sig").is_some() {
        if is_sig_v2(obj) {
            return Ok(obj.clone());
        }
        return Err(err!("sig:v1-refused: The envelope is signed under scheme 1, which is no longer \
            accepted."; Invalid, Input));
    }
    let base = res!(to_sign(obj));
    let author = res!(holder.author());
    let sig = res!(holder.sign(&signed_bytes(&base)));
    signed_with(&base, &author, &sig)
}

/// Whether `obj` was authored by this account: marked `sigv:2`, `author` is the holder's key AND
/// the signature over the digest verifies.  peer.js `verifyEnvelope`.
pub fn verify_envelope<H: AccountHolder>(holder: &H, obj: &Js) -> Outcome<bool> {
    Ok(verify_by(&res!(holder.author()), obj))
}

/// Whether `obj` is marked `sigv:2`, names `mine` as its author, and carries `mine`'s signature
/// over its digest: the check itself, which needs only the public key (the tab's, through the
/// wasm, and the runner's).
pub fn verify_by(mine: &[u8; 32], obj: &Js) -> bool {
    let (author, sig) = match (obj.get_str("author"), obj.get_str("sig")) {
        (Some(a), Some(s)) if !a.is_empty() && !s.is_empty() => (a, s),
        _ => return false,
    };
    if !is_sig_v2(obj) || crate::seal::hex(mine) != author {
        return false;
    }
    let sig = match base64::decode(sig) {
        Ok(s) => s,
        Err(_) => return false,
    };
    matches!(verify_ed25519(mine, &signed_bytes(obj), &sig), Ok(true))
}

/// peer.js `sealForSelf`'s sealed bytes: sign (unless already signed), `JSON.stringify`, then
/// `DPY2 ‖ wrap(plain, AAD)`.
pub fn seal_envelope<H: AccountHolder>(holder: &H, obj: &Js) -> Outcome<Vec<u8>> {
    let signed = res!(sign_envelope(holder, obj));
    let plain = signed.stringify();
    Ok(peer::frame(&res!(holder.wrap(plain.as_bytes(), Some(peer::AAD)))))
}

/// peer.js `relayMeta` for an envelope posted at `now` (epoch-ms): what the relay may know in the
/// clear.
pub fn relay_meta(env: &Js, now: i64) -> Vec<(String, Js)> {
    let secs = |ms: i64| -> i64 {
        let s = if ms <= 0 { 0 } else { (ms + 999) / 1000 };
        s.clamp(30, 86_400)
    };
    let mut out = Vec::new();
    let t = env.get_str("t").unwrap_or("");
    if t == T_REPORT || t == "built" || t == T_UNDO || t == T_UNDONE {
        let to = env.get_str("to").unwrap_or("");
        if !to.is_empty() {
            out.push(("for".into(), Js::str(to)));
            out.push(("ttl".into(), Js::int(secs(NOTE_HOLD_MS))));
        }
    } else if t == T_GRANT {
        let to = env.get_str("to").unwrap_or("");
        if !to.is_empty() {
            out.push(("for".into(), Js::str(to)));
            out.push(("ttl".into(), Js::int(secs(NOTE_HOLD_MS))));
        }
    } else if t == T_ASK {
        // Held for the asker alone (owner rule 2026-09-05: a chat's permission belongs to the
        // device it was driven from).
        let target = env.get_str("target").unwrap_or("");
        if !target.is_empty() && !rule_off("ask_for") {
            let deadline = whole(env, "deadline");
            let ms = if deadline != 0 { deadline - now + 30_000 } else { NOTE_HOLD_MS };
            out.push(("for".into(), Js::str(target)));
            out.push(("ttl".into(), Js::int(secs(ms))));
        }
    } else if t == T_ERRAND {
        let turn = env.get_str("turnId").unwrap_or("");
        if !turn.is_empty() {
            out.push(("turn".into(), Js::str(turn)));
        }
        let deadline = whole(env, "deadline");
        if deadline != 0 {
            out.push(("ttl".into(), Js::int(secs(deadline + LEASE_TTL_MS - now))));
        }
    }
    out
}

/// peer.js `sealForSelf`'s post body, `{to, addr, envelope}` and the relay meta: `to` the
/// account's public key in base64url (the form the gateway binds an account to), `addr` the
/// SHA-256 of the sealed bytes, hex, `envelope` the sealed bytes, base64.
pub fn post_body<H: AccountHolder>(holder: &H, obj: &Js, now: i64) -> Outcome<Js> {
    let signed = res!(sign_envelope(holder, obj));
    let sealed = res!(seal_envelope(holder, &signed));
    let author = res!(holder.author());
    let addr = sha256::digest(&sealed);
    let mut kv = vec![
        ("to".into(),       Js::Str(base64::encode_url(&author))),
        ("addr".into(),     Js::Str(crate::seal::hex(addr.as_ref()))),
        ("envelope".into(), Js::Str(base64::encode(&sealed))),
    ];
    kv.extend(relay_meta(&signed, now));
    Ok(Js::Obj(kv))
}

/// peer.js `openSealed` then `openEnvelope`, on the post's base64 `envelope`: decrypt through the
/// holder, parse, check the peer tag, verify the account's signature.
pub fn open_envelope<H: AccountHolder>(holder: &H, b64: &str) -> Outcome<Opened<Envelope>> {
    let bytes = match base64::decode(b64) {
        Ok(b) => b,
        Err(_) => return Ok(Opened::Refused(Refused::NotSealed)),
    };
    let aad = match peer::scheme_of(&bytes) {
        Some(Scheme::Dpy2) => Some(peer::AAD),
        Some(Scheme::Dpy1) => None,
        Some(Scheme::Dps1) => return Ok(Opened::Refused(Refused::Legacy)),
        None => return Ok(Opened::Refused(Refused::NotSealed)),
    };
    let plain = match res!(holder.unwrap(&bytes[4..], aad)) {
        Some(p) => p,
        None => return Ok(Opened::Refused(Refused::NotForYou)),
    };
    Ok(open_plain(&plain, &res!(holder.author())))
}

/// An envelope's plaintext, opened: parsed, its peer tag checked, its `sigv:2` signature by
/// `mine` verified.  The half of [`open_envelope`] after the account key's unwrap, which the tab
/// calls through the wasm with the unwrap done in identity.js.
pub fn open_plain(plain: &[u8], mine: &[u8; 32]) -> Opened<Envelope> {
    let obj = match std::str::from_utf8(plain).ok().and_then(|t| Js::parse(t).ok()) {
        Some(o) => o,
        None    => return Opened::Refused(Refused::NotEnvelope),
    };
    let t = obj.get_str("t").unwrap_or("").to_string();
    if !PEER_TYPES.contains(&t.as_str()) {
        return Opened::Refused(Refused::NotEnvelope);
    }
    if obj.get("sig").is_some() && !is_sig_v2(&obj) {
        return Opened::Refused(Refused::V1);
    }
    if !verify_by(mine, &obj) {
        return Opened::Refused(Refused::Unsigned);
    }
    Opened::Envelope(match t.as_str() {
        T_ERRAND    => Envelope::Errand(Errand::of_js(&obj)),
        T_REPORT    => Envelope::Report(Report::of_js(&obj)),
        _           => Envelope::Other(obj),
    })
}
