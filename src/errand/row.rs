//! The chat log's row (P2 design §2) and [`TurnView`], the one end-of-turn decision.
//!
//! A row travels as a clear header and a sealed body:
//!
//! | Part | Fields | Written by |
//! |------|--------|------------|
//! | header | `seq`, `member`, `at` | the gateway, on append |
//! | header | `turn`, `n`, `kind`, `daimon`, `len` | the writer |
//! | body | `iv ‖ AES-GCM` under the space key, AAD `daimond/chatlog/1`, base64 | the writer |
//!
//! The body carries the chat message id `mid` (F1): `(turn, n)` is only the log's idempotency
//! key, and `more`, `edit` and `tomb` name their target by `mid`.  The body of `end` is the turn's
//! outcome, [`End`], which is the report without its transcript.
//!
//! A body whose plaintext is over the row ceiling goes whole in pieces (P2.2f): its plaintext JSON
//! is cut on character boundaries and each piece sealed as a [`Piece`], the first under the
//! change's kind and marked `first`, the rest as `more`, the final one marked `last`.  A writer
//! posts a change's rows in order, so one writer has at most one body in pieces at a time;
//! [`TurnView`] joins them and folds the body once its `last` piece arrives.  No value is cut.
//!
//! [`TurnView`] folds one turn's rows in seq order.  A turn has ended exactly when it has folded
//! an `end` row; the first `end` wins and every row after it is ignored, as the gateway refuses
//! them.

use crate::errand::{
    codec::{
        opaque,
        text,
        texts,
        whole,
        AccountHolder,
        Opened,
        Refused,
    },
    json::Js,
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_text::base64;

/// The purpose a row body is bound to.
pub const ROW_AAD: &[u8] = b"daimond/chatlog/1"; // fixed: the row seal's purpose

/// What a row does to its turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Msg,    // a new row
    More,   // text appended to a row
    Edit,   // a row replaced
    Tomb,   // a row removed
    End,    // the turn's end
}

impl Kind {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Msg   => "msg",
            Self::More  => "more",
            Self::Edit  => "edit",
            Self::Tomb  => "tomb",
            Self::End   => "end",
        }
    }

    pub fn of(code: &str) -> Option<Self> {
        match code {
            "msg"   => Some(Self::Msg),
            "more"  => Some(Self::More),
            "edit"  => Some(Self::Edit),
            "tomb"  => Some(Self::Tomb),
            "end"   => Some(Self::End),
            _       => None,
        }
    }
}

/// How a turn ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndStatus {
    Done,
    Stopped,
    Interrupted,
    NotRun,
}

impl EndStatus {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Done          => "done",
            Self::Stopped       => "stopped",
            Self::Interrupted   => "interrupted",
            Self::NotRun        => "not_run",
        }
    }

    pub fn of(code: &str) -> Option<Self> {
        match code {
            "done"          => Some(Self::Done),
            "stopped"       => Some(Self::Stopped),
            "interrupted"   => Some(Self::Interrupted),
            "not_run"       => Some(Self::NotRun),
            _               => None,
        }
    }
}

/// A row's clear header.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Header {
    pub seq:    i64,        // gateway: the chat's sequence number
    pub turn:   String,
    pub n:      i64,        // the writer's count within the turn
    pub kind:   String,     // a [`Kind`] code
    pub member: String,     // gateway: the author's account
    pub daimon: String,     // the writing daimon, empty for the person
    pub at:     i64,        // gateway: arrival, epoch-ms
    pub len:    i64,        // the sealed body's byte length
}

impl Header {
    pub fn to_js(&self) -> Js {
        Js::Obj(vec![
            ("seq".into(),      Js::int(self.seq)),
            ("turn".into(),     Js::str(&self.turn)),
            ("n".into(),        Js::int(self.n)),
            ("kind".into(),     Js::str(&self.kind)),
            ("member".into(),   Js::str(&self.member)),
            ("daimon".into(),   Js::str(&self.daimon)),
            ("at".into(),       Js::int(self.at)),
            ("len".into(),      Js::int(self.len)),
        ])
    }

    pub fn of_js(o: &Js) -> Outcome<Self> {
        let h = Self {
            seq:    whole(o, "seq"),
            turn:   text(o, "turn"),
            n:      whole(o, "n"),
            kind:   text(o, "kind"),
            member: text(o, "member"),
            daimon: text(o, "daimon"),
            at:     whole(o, "at"),
            len:    whole(o, "len"),
        };
        if h.turn.is_empty() {
            return Err(err!("A chat log row names no turn."; Invalid, Input, Missing));
        }
        if Kind::of(&h.kind).is_none() {
            return Err(err!("A chat log row's kind '{}' is not msg, more, edit, tomb or end.", h.kind;
                Invalid, Input));
        }
        Ok(h)
    }

    pub fn kind(&self) -> Option<Kind> {
        Kind::of(&self.kind)
    }
}

/// The body of an `end` row: the report without its transcript.
#[derive(Clone, Debug, PartialEq)]
pub struct End {
    pub status: EndStatus,
    pub totals: Js,         // cost and counts, opaque
    pub alerts: Vec<Js>,    // the Pending panel's raises and clears, in order
    pub undo:   Js,         // what an undo of the turn needs, opaque
    pub tried:  Vec<String>,// the runners that tried the turn
    pub not_run: Option<NotRun>, // why the turn was not run; only on `not_run`
    pub unsent: Vec<Js>,    // rows the log could not take, each `{mid, kind, why}`; empty for none
}

impl End {
    pub fn to_js(&self) -> Js {
        let mut kv = vec![
            ("status".into(),   Js::str(self.status.code())),
            ("totals".into(),   self.totals.clone()),
            ("alerts".into(),   Js::Arr(self.alerts.clone())),
            ("undo".into(),     self.undo.clone()),
            ("tried".into(),    Js::strs(&self.tried)),
        ];
        if let (EndStatus::NotRun, Some(nr)) = (self.status, &self.not_run) {
            kv.push(("not_run".into(), nr.to_js()));
        }
        if !self.unsent.is_empty() {
            kv.push(("unsent".into(), Js::Arr(self.unsent.clone())));
        }
        Js::Obj(kv)
    }

    pub fn of_js(o: &Js) -> Outcome<Self> {
        let code = text(o, "status");
        let status = res!(EndStatus::of(&code).ok_or_else(|| err!(
            "An end row's status '{}' is not done, stopped, interrupted or not_run.", code;
            Invalid, Input)));
        Ok(Self {
            status,
            totals: opaque(o, "totals"),
            alerts: match o.get("alerts") {
                Some(Js::Arr(v))    => v.clone(),
                _                   => Vec::new(),
            },
            undo:   opaque(o, "undo"),
            tried:  texts(o, "tried"),
            // A reason on any other status is not the turn's, so it is not read.
            not_run: match (status, o.get("not_run")) {
                (EndStatus::NotRun, Some(nr @ Js::Obj(_)))  => Some(NotRun::of_js(nr)),
                _                                           => None,
            },
            unsent: match o.get("unsent") {
                Some(Js::Arr(v))    => v.clone(),
                _                   => Vec::new(),
            },
        })
    }
}

/// Why a turn ended `not_run`, as the "not run" row with Retry shows it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NotRun {
    pub why:    String, // the plain words
    pub cause:  String, // a not-run cause code, e.g. `abi` for `sig:v1-refused`; empty for none
    pub to:     String, // the device the turn was sent to
    pub name:   String, // that device's name
    pub said:   String, // the runner's own words
}

impl NotRun {
    /// Only the fields that are set.
    pub fn to_js(&self) -> Js {
        let kv = [
            ("why",     &self.why),
            ("cause",   &self.cause),
            ("to",      &self.to),
            ("name",    &self.name),
            ("said",    &self.said),
        ];
        Js::Obj(kv.iter()
            .filter(|(_, v)| !v.is_empty())
            .map(|(k, v)| ((*k).into(), Js::str(v)))
            .collect())
    }

    pub fn of_js(o: &Js) -> Self {
        Self {
            why:    text(o, "why"),
            cause:  text(o, "cause"),
            to:     text(o, "to"),
            name:   text(o, "name"),
            said:   text(o, "said"),
        }
    }
}

/// A row's sealed body, opened.
#[derive(Clone, Debug, PartialEq)]
pub struct Body {
    pub mid:    String, // the chat message id; empty only on `end`
    pub role:   String, // `user`, `assistant`, ...; on `msg` and `edit`
    pub text:   String,
    pub meta:   Js,     // the message's other fields, opaque; `Null` for none
    pub end:    Option<End>,
}

impl Body {
    /// A body for `kind`, checked: every kind but `end` names its message by `mid`, and `end`
    /// carries an [`End`].
    pub fn of_js(kind: Kind, o: &Js) -> Outcome<Self> {
        let mid = text(o, "mid");
        if kind != Kind::End && mid.is_empty() {
            return Err(err!("A '{}' row's body names no message id (mid).", kind.code();
                Invalid, Input, Missing));
        }
        let end = match kind {
            Kind::End   => Some(res!(End::of_js(o))),
            _           => None,
        };
        Ok(Self {
            mid,
            role:   text(o, "role"),
            text:   text(o, "text"),
            meta:   opaque(o, "meta"),
            end,
        })
    }

    pub fn to_js(&self) -> Js {
        let mut o = match &self.end {
            Some(e) => match e.to_js() {
                Js::Obj(kv) => kv,
                _           => Vec::new(),
            },
            None    => Vec::new(),
        };
        if !self.mid.is_empty() || self.end.is_none() {
            o.insert(0, ("mid".into(), Js::str(&self.mid)));
        }
        if self.end.is_none() {
            o.push(("role".into(), Js::str(&self.role)));
            o.push(("text".into(), Js::str(&self.text)));
        }
        if self.meta != Js::Null {
            o.push(("meta".into(), self.meta.clone()));
        }
        Js::Obj(o)
    }
}

/// One piece of a body too big for one row: a run of its plaintext JSON.
#[derive(Clone, Debug, PartialEq)]
pub struct Piece {
    pub piece:  String,
    pub first:  bool,   // the body's first piece, under the change's kind
    pub last:   bool,   // the body's final piece: the body is whole once it is folded
}

impl Piece {
    pub fn to_js(&self) -> Js {
        let mut o = vec![("piece".into(), Js::str(&self.piece))];
        if self.first {
            o.push(("first".into(), Js::Bool(true)));
        }
        if self.last {
            o.push(("last".into(), Js::Bool(true)));
        }
        Js::Obj(o)
    }
}

/// What a row's sealed body holds: a whole body, or one piece of one.
#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    Whole(Body),
    Piece(Piece),
}

impl Part {
    /// A row body for `kind`: a piece when it carries `piece`, else a whole [`Body`], checked.  A
    /// piece after the first goes as `more`.
    pub fn of_js(kind: Kind, o: &Js) -> Outcome<Self> {
        let piece = match o.get("piece") {
            Some(Js::Str(s))    => s.clone(),
            Some(_)             => return Err(err!("A '{}' row's piece is not a string.", kind.code();
                Invalid, Input)),
            None                => return Ok(Self::Whole(res!(Body::of_js(kind, o)))),
        };
        let flag = |k: &str| matches!(o.get(k), Some(Js::Bool(true)));
        let p = Piece { piece, first: flag("first"), last: flag("last") };
        if !p.first && kind != Kind::More {
            return Err(err!("A '{}' row carries a piece after a body's first, which goes as 'more'.",
                kind.code(); Invalid, Input));
        }
        Ok(Self::Piece(p))
    }

    pub fn to_js(&self) -> Js {
        match self {
            Self::Whole(b)  => b.to_js(),
            Self::Piece(p)  => p.to_js(),
        }
    }
}

/// An opened row.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub head: Header,
    pub body: Part,
}

impl Row {
    /// `{head, body}`, the form [`TurnView`] and the wasm read.
    pub fn of_js(o: &Js) -> Outcome<Self> {
        let head = res!(Header::of_js(res!(o.get("head").ok_or_else(|| err!(
            "An opened row has no head."; Invalid, Input, Missing)))));
        let kind = res!(head.kind().ok_or_else(|| err!("Unknown row kind '{}'.", head.kind; Invalid, Input)));
        let body = res!(Part::of_js(kind, res!(o.get("body").ok_or_else(|| err!(
            "An opened row has no body."; Invalid, Input, Missing)))));
        Ok(Self { head, body })
    }

    pub fn to_js(&self) -> Js {
        Js::Obj(vec![
            ("head".into(), self.head.to_js()),
            ("body".into(), self.body.to_js()),
        ])
    }
}

/// The plaintext a row body seals: its JSON, checked against the header's kind.
pub fn body_plain(head: &Header, body: &Body) -> Outcome<Vec<u8>> {
    let kind = res!(head.kind().ok_or_else(|| err!("Unknown row kind '{}'.", head.kind; Invalid, Input)));
    let js = body.to_js();
    res!(Body::of_js(kind, &js));
    Ok(js.stringify().into_bytes())
}

/// The plaintext a row's part seals, checked as [`body_plain`] for a whole body.
pub fn part_plain(head: &Header, part: &Part) -> Outcome<Vec<u8>> {
    match part {
        Part::Whole(b)  => body_plain(head, b),
        Part::Piece(p)  => {
            let kind = res!(head.kind().ok_or_else(|| err!("Unknown row kind '{}'.", head.kind; Invalid, Input)));
            let js = p.to_js();
            res!(Part::of_js(kind, &js));
            Ok(js.stringify().into_bytes())
        },
    }
}

/// The wire row: the header with `len` set and `body`, the sealed bytes in base64.
pub fn wire(head: &Header, sealed: &[u8]) -> Js {
    let mut h = head.clone();
    h.len = sealed.len() as i64;
    let mut kv = match h.to_js() {
        Js::Obj(kv) => kv,
        _           => Vec::new(),
    };
    kv.push(("body".into(), Js::Str(base64::encode(sealed))));
    Js::Obj(kv)
}

/// A wire row's header and its sealed body's bytes.
pub fn unwire(w: &Js) -> Outcome<(Header, Vec<u8>)> {
    let head = res!(Header::of_js(w));
    let b64 = res!(w.get_str("body").ok_or_else(|| err!(
        "Chat log row {} has no sealed body.", head.seq; Invalid, Input, Missing)));
    let sealed = res!(base64::decode(b64));
    Ok((head, sealed))
}

/// The opened row of a body's plaintext.
pub fn open_row_plain(head: Header, plain: &[u8]) -> Outcome<Row> {
    let kind = res!(head.kind().ok_or_else(|| err!("Unknown row kind '{}'.", head.kind; Invalid, Input)));
    let txt = match std::str::from_utf8(plain) {
        Ok(t)   => t,
        Err(_)  => return Err(err!("Chat log row {}'s body is not UTF-8.", head.seq; Invalid, Input)),
    };
    let body = res!(Part::of_js(kind, &res!(Js::parse(txt))));
    Ok(Row { head, body })
}

/// Seal a row under the holder's space key: the wire row.
pub fn seal_row<H: AccountHolder>(holder: &H, head: &Header, body: &Body) -> Outcome<Js> {
    let plain = res!(body_plain(head, body));
    let sealed = res!(holder.wrap(&plain, Some(ROW_AAD)));
    Ok(wire(head, &sealed))
}

/// Open a wire row: [`Refused::NotForYou`] when the tag does not verify, [`Refused::NotEnvelope`]
/// when it opens to something that is not a row body.
pub fn open_row<H: AccountHolder>(holder: &H, w: &Js) -> Outcome<Opened<Row>> {
    let (head, sealed) = match unwire(w) {
        Ok(hs)  => hs,
        Err(_)  => return Ok(Opened::Refused(Refused::NotSealed)),
    };
    let plain = match res!(holder.unwrap(&sealed, Some(ROW_AAD))) {
        Some(p) => p,
        None    => return Ok(Opened::Refused(Refused::NotForYou)),
    };
    match open_row_plain(head, &plain) {
        Ok(row) => Ok(Opened::Envelope(row)),
        Err(_)  => Ok(Opened::Refused(Refused::NotEnvelope)),
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ TurnView                                                      │
// └───────────────────────────────────────────────────────────────┘

/// Where a turn stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnState {
    Open,
    Ended(EndStatus),
}

/// One message as the turn's rows leave it.
#[derive(Clone, Debug, PartialEq)]
pub struct Folded {
    pub mid:    String,
    pub role:   String,
    pub text:   String,
    pub meta:   Js,
    pub seq:    i64,    // the `msg` row's seq, which orders the chat
    pub at:     i64,    // the `msg` row's arrival, the stored timestamp (F2)
    pub member: String,
    pub daimon: String,
}

impl Folded {
    fn to_js(&self) -> Js {
        let mut o = vec![
            ("mid".into(),      Js::str(&self.mid)),
            ("role".into(),     Js::str(&self.role)),
            ("text".into(),     Js::str(&self.text)),
            ("seq".into(),      Js::int(self.seq)),
            ("at".into(),       Js::int(self.at)),
            ("member".into(),   Js::str(&self.member)),
            ("daimon".into(),   Js::str(&self.daimon)),
        ];
        if self.meta != Js::Null {
            o.push(("meta".into(), self.meta.clone()));
        }
        Js::Obj(o)
    }

    fn of_js(o: &Js) -> Self {
        Self {
            mid:    text(o, "mid"),
            role:   text(o, "role"),
            text:   text(o, "text"),
            meta:   opaque(o, "meta"),
            seq:    whole(o, "seq"),
            at:     whole(o, "at"),
            member: text(o, "member"),
            daimon: text(o, "daimon"),
        }
    }
}

/// What [`TurnView::apply`] did with a row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Applied {
    Taken,
    OtherTurn,  // the row is another turn's
    Stale,      // its seq is at or below the last folded: a repeat
    AfterEnd,   // the turn has ended; first end wins
    NoTarget,   // `more`, `edit` or `tomb` naming a message the turn does not hold, or pieces
                // that do not join into a body
    Repeat,     // a `msg` for a message the turn already holds (log and parcel both)
}

impl Applied {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Taken     => "taken",
            Self::OtherTurn => "other_turn",
            Self::Stale     => "stale",
            Self::AfterEnd  => "after_end",
            Self::NoTarget  => "no_target",
            Self::Repeat    => "repeat",
        }
    }
}

/// A body in pieces, joined so far: one per writer.
#[derive(Clone, Debug, PartialEq)]
pub struct Joining {
    pub head:   Header, // the first piece's, whose kind, seq and arrival the body takes
    pub plain:  String, // the pieces so far, in order
}

impl Joining {
    fn to_js(&self) -> Js {
        Js::Obj(vec![
            ("head".into(),     self.head.to_js()),
            ("plain".into(),    Js::str(&self.plain)),
        ])
    }

    fn of_js(o: &Js) -> Outcome<Self> {
        Ok(Self {
            head:   res!(Header::of_js(res!(o.get("head").ok_or_else(|| err!(
                "A joining body has no head."; Invalid, Input, Missing))))),
            plain:  text(o, "plain"),
        })
    }

    /// Is `h` from the writer of this body?
    fn writer_of(&self, h: &Header) -> bool {
        self.head.member == h.member && self.head.daimon == h.daimon
    }
}

/// One turn's state and rows, folded from its log rows in seq order.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnView {
    pub turn:       String,
    pub last:       i64,            // the highest seq folded
    pub state:      TurnState,
    pub rows:       Vec<Folded>,
    pub end:        Option<End>,
    pub joining:    Vec<Joining>,   // bodies whose last piece has not come, one per writer
}

impl TurnView {
    pub fn new(turn: &str) -> Self {
        Self {
            turn:   turn.to_string(),
            last:   0,
            state:  TurnState::Open,
            rows:       Vec::new(),
            end:        None,
            joining:    Vec::new(),
        }
    }

    /// Has the turn folded its `end` row?
    pub fn ended(&self) -> bool {
        matches!(self.state, TurnState::Ended(_))
    }

    /// Fold one row.
    pub fn apply(&mut self, row: &Row) -> Applied {
        let h = &row.head;
        if h.turn != self.turn {
            return Applied::OtherTurn;
        }
        if h.seq <= self.last {
            return Applied::Stale;
        }
        if self.ended() {
            return Applied::AfterEnd;
        }
        let kind = match h.kind() {
            Some(k) => k,
            None    => return Applied::NoTarget,
        };
        // A row seen moves the cursor whatever it did, so a repeat of it is stale.
        self.last = h.seq;
        let at = self.joining.iter().position(|j| j.writer_of(h));
        match &row.body {
            Part::Whole(b)  => {
                // A writer's whole row after pieces it never finished: those pieces are lost.
                if let Some(i) = at {
                    self.joining.remove(i);
                }
                self.fold(h, kind, b)
            },
            Part::Piece(p)  => {
                let j = match (p.first, at) {
                    (true, Some(i)) => {
                        self.joining[i] = Joining { head: h.clone(), plain: p.piece.clone() };
                        i
                    },
                    (true, None)    => {
                        self.joining.push(Joining { head: h.clone(), plain: p.piece.clone() });
                        self.joining.len() - 1
                    },
                    (false, Some(i)) => {
                        self.joining[i].plain.push_str(&p.piece);
                        i
                    },
                    (false, None)   => return Applied::NoTarget,
                };
                if !p.last {
                    return Applied::Taken;
                }
                let done = self.joining.remove(j);
                let k = match done.head.kind() {
                    Some(k) => k,
                    None    => return Applied::NoTarget,
                };
                match Js::parse(&done.plain).and_then(|js| Body::of_js(k, &js)) {
                    Ok(b)   => self.fold(&done.head, k, &b),
                    Err(_)  => Applied::NoTarget,
                }
            },
        }
    }

    /// Fold one whole body under its row's header `h`.
    fn fold(&mut self, h: &Header, kind: Kind, b: &Body) -> Applied {
        let at = self.rows.iter().position(|f| f.mid == b.mid);
        let out = match (kind, at) {
            (Kind::Msg, Some(_))    => Applied::Repeat,
            (Kind::Msg, None)       => {
                self.rows.push(Folded {
                    mid:    b.mid.clone(),
                    role:   b.role.clone(),
                    text:   b.text.clone(),
                    meta:   b.meta.clone(),
                    seq:    h.seq,
                    at:     h.at,
                    member: h.member.clone(),
                    daimon: h.daimon.clone(),
                });
                Applied::Taken
            }
            (Kind::More, Some(i))   => {
                self.rows[i].text.push_str(&b.text);
                Applied::Taken
            }
            (Kind::Edit, Some(i))   => {
                let f = &mut self.rows[i];
                f.text = b.text.clone();
                if !b.role.is_empty() {
                    f.role = b.role.clone();
                }
                if b.meta != Js::Null {
                    f.meta = b.meta.clone();
                }
                Applied::Taken
            }
            (Kind::Tomb, Some(i))   => {
                self.rows.remove(i);
                Applied::Taken
            }
            (Kind::End, _)          => match &b.end {
                Some(e) => {
                    self.state = TurnState::Ended(e.status);
                    self.end = Some(e.clone());
                    Applied::Taken
                }
                None    => Applied::NoTarget,
            },
            (Kind::More, None)
            | (Kind::Edit, None)
            | (Kind::Tomb, None)    => Applied::NoTarget,
        };
        out
    }

    pub fn to_js(&self) -> Js {
        let mut o = vec![
            ("turn".into(),     Js::str(&self.turn)),
            ("last".into(),     Js::int(self.last)),
            ("state".into(),    Js::str(match self.state {
                TurnState::Open         => "open",
                TurnState::Ended(_)     => "ended",
            })),
        ];
        if let TurnState::Ended(s) = self.state {
            o.push(("status".into(), Js::str(s.code())));
        }
        o.push(("rows".into(), Js::Arr(self.rows.iter().map(|f| f.to_js()).collect())));
        if let Some(e) = &self.end {
            o.push(("end".into(), e.to_js()));
        }
        if !self.joining.is_empty() {
            o.push(("joining".into(), Js::Arr(self.joining.iter().map(|j| j.to_js()).collect())));
        }
        Js::Obj(o)
    }

    pub fn of_js(o: &Js) -> Outcome<Self> {
        let turn = text(o, "turn");
        if turn.is_empty() {
            return Err(err!("A turn view names no turn."; Invalid, Input, Missing));
        }
        let end = match o.get("end") {
            Some(e @ Js::Obj(_))    => Some(res!(End::of_js(e))),
            _                       => None,
        };
        let state = match (text(o, "state").as_str(), &end) {
            ("open", None)
            | ("", None)        => TurnState::Open,
            ("ended", Some(e))  => TurnState::Ended(e.status),
            (s, _)              => return Err(err!(
                "Turn view {}'s state '{}' does not agree with its end.", turn, s; Invalid, Input)),
        };
        Ok(Self {
            turn,
            last:   whole(o, "last"),
            state,
            rows:   match o.get("rows") {
                Some(Js::Arr(v))    => v.iter().map(Folded::of_js).collect(),
                _                   => Vec::new(),
            },
            end,
            joining: match o.get("joining") {
                Some(Js::Arr(v))    => {
                    let mut out = Vec::new();
                    for j in v {
                        out.push(res!(Joining::of_js(j)));
                    }
                    out
                },
                _                   => Vec::new(),
            },
        })
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Writer                                                        │
// └───────────────────────────────────────────────────────────────┘

/// The bytes `c` takes in a JSON string as [`Js::stringify`] writes it.
fn quoted_len(c: char) -> usize {
    match c {
        '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t'    => 2,
        c if (c as u32) < 0x20                                  => 6, // fixed: JSON writes a control character as `\u00XX`, six bytes
        c                                                       => c.len_utf8(),
    }
}

/// `text` cut on character boundaries into pieces of at most `room` bytes each once quoted as
/// JSON; one empty piece for empty text.
pub fn text_pieces(text: &str, room: usize) -> Outcome<Vec<&str>> {
    if room < 6 {
        return Err(err!("A row has room for {} bytes of text, less than one character may take.", room;
            Invalid, Input, Size));
    }
    let mut out = Vec::new();
    let (mut start, mut used) = (0, 0);
    for (i, c) in text.char_indices() {
        let q = quoted_len(c);
        if used + q > room {
            out.push(&text[start..i]);
            start = i;
            used = 0;
        }
        used += q;
    }
    out.push(&text[start..]);
    Ok(out)
}

/// One change to a turn's log, before it is cut into rows.
#[derive(Clone, Debug, PartialEq)]
pub struct Change {
    pub kind:   Kind,
    pub body:   Body,
}

impl Change {
    pub fn to_js(&self) -> Js {
        Js::Obj(vec![
            ("kind".into(), Js::str(self.kind.code())),
            ("body".into(), self.body.to_js()),
        ])
    }

    pub fn of_js(o: &Js) -> Outcome<Self> {
        let code = text(o, "kind");
        let kind = res!(Kind::of(&code).ok_or_else(|| err!("Unknown change kind '{}'.", code;
            Invalid, Input)));
        let body = res!(Body::of_js(kind, o.get("body").unwrap_or(&Js::Null)));
        Ok(Self { kind, body })
    }
}

/// The log body of one of a turn's messages as the chat holds it: its `mid`, `role` and
/// `content`, and every other field but `whole` (which only a live row lacks) as its meta.
pub fn row_body(r: &Js) -> Body {
    let meta: Vec<(String, Js)> = match r {
        Js::Obj(kv) => kv.iter()
            .filter(|(k, _)| !matches!(k.as_str(), "mid" | "role" | "content" | "whole"))
            .cloned().collect(),
        _           => Vec::new(),
    };
    Body {
        mid:    r.get_str("mid").unwrap_or("").to_string(),
        role:   r.get_str("role").unwrap_or("").to_string(),
        text:   r.get_str("content").unwrap_or("").to_string(),
        meta:   if meta.is_empty() { Js::Null } else { Js::Obj(meta) },
        end:    None,
    }
}

/// The rows of `change`, numbered from `n`, each body's plaintext within `plain_max` bytes: one
/// whole row when the body fits, else its whole plaintext in [`Piece`]s.
pub fn change_rows(turn: &str, daimon: &str, n: i64, change: &Change, plain_max: usize)
    -> Outcome<Vec<(Header, Part)>>
{
    let head = Header {
        seq:    0,
        turn:   turn.to_string(),
        n,
        kind:   change.kind.code().to_string(),
        member: String::new(),
        daimon: daimon.to_string(),
        at:     0,
        len:    0,
    };
    let plain = res!(body_plain(&head, &change.body));
    if plain.len() <= plain_max {
        return Ok(vec![(head, Part::Whole(change.body.clone()))]);
    }
    let plain = match String::from_utf8(plain) {
        Ok(t)   => t,
        Err(_)  => return Err(err!("Message {}'s '{}' body is not UTF-8.", change.body.mid,
            change.kind.code(); Invalid, Input)),
    };
    piece_rows(head, &plain, true, true, plain_max)
}

/// `plain`, a run of a body's plaintext, as the pieces of rows from `head` on, each within
/// `plain_max` bytes: the first under `head`'s kind and number (marked `first` when `first`), the
/// rest as `more`, the final one marked `last` when `last`.  [`change_rows`] cuts a body with it,
/// and a poster a piece row the log door refuses as too large.
pub fn piece_rows(head: Header, plain: &str, first: bool, last: bool, plain_max: usize)
    -> Outcome<Vec<(Header, Part)>>
{
    // Every piece's room is a full piece row's, both marks set, less its empty piece.
    let mark = Piece { piece: String::new(), first: true, last: true }.to_js().stringify().len();
    let room = match plain_max.checked_sub(mark) {
        Some(r) => r,
        None    => return Err(err!("A row has room for {} bytes, less than a piece's {} bytes of marks.",
            plain_max, mark; Invalid, Input, Size)),
    };
    let cut = res!(text_pieces(plain, room));
    let k = cut.len();
    Ok(cut.into_iter().enumerate().map(|(i, t)| {
        let mut h = head.clone();
        h.n = head.n + i as i64;
        if i > 0 {
            h.kind = Kind::More.code().to_string();
        }
        (h, Part::Piece(Piece { piece: t.to_string(), first: first && i == 0, last: last && i + 1 == k }))
    }).collect())
}

/// One turn's log writer: the messages it has logged, so each look at the turn's messages so
/// far gives only what changed, and its one `end` last.
#[derive(Clone, Debug, Default)]
pub struct Writer {
    sent:   Vec<Body>,  // each message as logged, in order
    ended:  bool,
}

impl Writer {
    pub fn new() -> Self {
        Self::default()
    }

    /// The changes that bring the log to `msgs`: `msg` for a new message, `more` for text
    /// appended to one with the same role and meta, `edit` for one otherwise changed, `tomb` for
    /// one gone.  Each is counted as logged once given.
    pub fn diff(&mut self, msgs: &[Body]) -> Outcome<Vec<Change>> {
        if self.ended {
            return Err(err!("The turn's log has ended; no change follows its end."; Invalid, Input));
        }
        let mut out = Vec::new();
        for m in msgs {
            let at = self.sent.iter().position(|s| s.mid == m.mid);
            match at {
                None    => {
                    out.push(Change { kind: Kind::Msg, body: m.clone() });
                    self.sent.push(m.clone());
                },
                Some(i) => {
                    let s = &self.sent[i];
                    if s == m {
                        continue;
                    }
                    let grown = s.role == m.role && s.meta == m.meta && m.text.starts_with(&s.text);
                    let change = match grown {
                        true    => Change { kind: Kind::More, body: Body {
                            mid:    m.mid.clone(),
                            role:   String::new(),
                            text:   m.text[s.text.len()..].to_string(),
                            meta:   Js::Null,
                            end:    None,
                        }},
                        false   => Change { kind: Kind::Edit, body: m.clone() },
                    };
                    out.push(change);
                    self.sent[i] = m.clone();
                },
            }
        }
        let gone: Vec<String> = self.sent.iter()
            .filter(|s| !msgs.iter().any(|m| m.mid == s.mid))
            .map(|s| s.mid.clone())
            .collect();
        for mid in gone {
            out.push(Change { kind: Kind::Tomb, body: Body {
                mid:    mid.clone(),
                role:   String::new(),
                text:   String::new(),
                meta:   Js::Null,
                end:    None,
            }});
            self.sent.retain(|s| s.mid != mid);
        }
        Ok(out)
    }

    /// The turn's `end`, once.
    pub fn end(&mut self, end: End) -> Outcome<Change> {
        if self.ended {
            return Err(err!("The turn's log has already ended."; Invalid, Input));
        }
        self.ended = true;
        Ok(Change { kind: Kind::End, body: Body {
            mid:    String::new(),
            role:   String::new(),
            text:   String::new(),
            meta:   Js::Null,
            end:    Some(end),
        }})
    }

    /// Has the writer given the turn's `end`?
    pub fn ended(&self) -> bool {
        self.ended
    }

    /// The writer as it stands, for a holder that keeps it between looks (the tab's).
    pub fn to_js(&self) -> Js {
        Js::Obj(vec![
            ("sent".into(),     Js::Arr(self.sent.iter().map(Body::to_js).collect())),
            ("ended".into(),    Js::Bool(self.ended)),
        ])
    }

    /// A writer from [`Writer::to_js`]; `{}` for a new one.
    pub fn of_js(o: &Js) -> Outcome<Self> {
        let mut sent = Vec::new();
        if let Some(Js::Arr(v)) = o.get("sent") {
            for b in v {
                sent.push(res!(Body::of_js(Kind::Msg, b)));
            }
        }
        Ok(Self { sent, ended: matches!(o.get("ended"), Some(Js::Bool(true))) })
    }
}
