use super::*;

use crate::{
    diamond_link::{
        links_page, model_unlink, parse_links, write_links, Link, LinksPage, Node, PageLink,
        Unlink,
    },
    diamond_versions::{hash_of, Body, Carried, Change, TurnFound, Unplaced, VERSION_FILE_MAX},
    engine::host::types::store::Wants,
    marks::{DiamondId, Hold},
    tools::Toolkit,
};

use oxedyne_fe2o3_core::error::ErrWire;

use std::collections::BTreeSet;


// ┌───────────────────────────────────────────────────────────────┐
// │ Samples                                                        │
// └───────────────────────────────────────────────────────────────┘

fn s(v: &str) -> String { v.to_string() }

fn author() -> Author {
    Author {
        role:   s("worker"),
        m:      s("claude-opus-5-5"),
        pv:     s("anthropic"),
        sp:     s("f00d"),
        run:    s("r1"),
        via:    s(""),
    }
}

fn change() -> Change {
    Change {
        path:       s("notes/a.md"),
        after:      Body::Held(vec![1, 2, 3]),
        before:     Some(crate::diamond_versions::Prior::Held(vec![0, 255])),
        found:      Found::Hash(hex()),
        carried:    Some(Carried::Kept(crate::diamond_versions::Prior::Held(vec![9]))),
        mark:       true,
        refused:    Some(s("the hand said no")),
        wiped:      false,
        folder:     Some(s("work")),
        by:         Some(author()),
        door:       true,
    }
}

fn live() -> Outcome<Live> {
    Ok(Live::Diamond(res!(DiamondId::parse("ab12")), vec![s("rust")]))
}

fn chat() -> Live {
    Live::Chat(s("c1"), vec![Hold { r: s("r"), path: s("p"), ws: true, read: false }])
}

fn notes() -> FoldNotes {
    FoldNotes {
        task:       s("t"),
        next:       s("n"),
        open:       vec![s("o")],
        decisions:  vec![],
        found:      vec![s("f")],
        edited:     vec![s("a -- b")],
        read:       vec![],
    }
}

fn passed() -> CrystalPassed {
    CrystalPassed { version: 4, at: 1_700_000_000_000, page: s(""), data: s("d"), debug: 2 }
}

fn refusal() -> Error<ErrTag> {
    let inner = err!("'notes/a.md' is held by another agent."; Conflict, Write);
    err!(inner, "The write was refused."; Invalid, Input)
}

/// One of every call.
fn calls() -> Outcome<Vec<StoreCall>> {
    let id = || s("ab12");
    let h = Handle(7);
    let r = |b: &[u8]| BodyRef::of(b);
    let wc = || WireChange::refer(&change());
    Ok(vec![
        StoreCall::ReadCrystalData { id: id() },
        StoreCall::ReadCrystalDataStrict { id: id() },
        StoreCall::ReadCrystalPage { id: id() },
        StoreCall::ReadCrystalPageStrict { id: id() },
        StoreCall::CrystalHalf { id: id(), path: s("crystal.json") },
        StoreCall::CrystalUndoTarget { id: id(), half: CrystalHalf::Page, at: Some(3) },
        StoreCall::HotRefusals { id: id() },
        StoreCall::SetHotRefusals { id: id(), n: 2 },
        StoreCall::CrystalHotLastGood { id: id(), old: r(b"{") },
        StoreCall::LastPassed { id: id() },
        StoreCall::MarkPassed {
            id: id(), version: 9, page: Some(HexHash::of(b"p")), data: HexHash::of(b"d"), debug: 1,
        },
        StoreCall::StandingSettle {
            id: id(), root: FileRoot::Opfs, path: s("diamonds/ab12/STATE.md"),
            phase: SettlePhase::Record, archive: vec![], noted: vec![s("- 2026-10-19 d")],
            touched: vec![s("1\tWhere"), s("\tGone")], at: 1_760_000_000_123,
        },
        StoreCall::StateRead { id: id(), root: FileRoot::Opfs, path: s("diamonds/ab12/STATE.md") },
        StoreCall::StoreFileRead { id: id(), path: s("diamonds/ab12/STATE.md"), max: 4096 },
        StoreCall::StoreFileList { id: id(), dir: s("diamonds/ab12/.daimond") },
        StoreCall::StoreWriteThen {
            id: id(), root: FileRoot::Opfs, path: s("diamonds/ab12/STATE.md"), body: r(b"# State\n"),
            expect: Some(Seen::Absent), archive: vec![(s("STATE.md"), r(b"retired"))],
        },
        StoreCall::StoreFileAct {
            id: id(), root: FileRoot::Opfs, path: s("diamonds/ab12/notes.md"),
            act: crate::engine::host::types::store::FileAct::Move(s("diamonds/ab12/old/notes.md")),
        },
        StoreCall::AbsorbFoldNotes { id: id(), notes: notes() },
        StoreCall::AddLink {
            owner:  id(),
            from:   s("diamond:ab12"),
            to:     s("url:https://x"),
            rel:    s("cites"),
            note:   s(""),
            by:     s("agent:w"),
        },
        StoreCall::AllLinks {},
        StoreCall::LinksJson { node_ref: s("diamond:ab12") },
        StoreCall::LinksPage { owner: id(), at: 16, stamp: Some(HexHash::of(b"x")) },
        StoreCall::RemoveLinkByModel { owner: id(), link_id: s("l1") },
        StoreCall::DiamondExists { id: id() },
        StoreCall::ActivityReadAll { id: id() },
        StoreCall::ActivityAppend { id: id(), line: s("{\"at\":1}"), now: 1_700_000_000_000 },
        StoreCall::NoProgressRounds { id: id() },
        StoreCall::Capture { id: id(), raw: s("a.md"), change: wc() },
        StoreCall::CapturedRoom {
            id:         id(),
            path:       s("a.md"),
            found:      Found::Unread,
            copy:       None,
            destroying: true,
            room:       u64::MAX,
        },
        StoreCall::KeepRoom { id: id() },
        StoreCall::Release { id: id(), path: s("a.md") },
        StoreCall::HeldUnder { id: id(), from: s("dir"), after: Some(s("dir/b")) },
        StoreCall::ThisTurnFound { id: id(), path: s("a.md"), now: r(b"") },
        StoreCall::TurnsFound { id: id(), path: s("a.md"), now: r(&[1]) },
        StoreCall::MeasuredAgainst { id: id(), path: s("a.md"), now: r(&[2]) },
        StoreCall::SealsSpent { id: id(), path: s("a.md"), now: r(&[3]) },
        StoreCall::SealRun { id: id(), path: s("a.md"), now: r(&[4]) },
        StoreCall::Pend { id: id(), path: s("a.md"), before: r(&[5]), deleting: true, mark: false },
        StoreCall::Unpend { id: id(), path: s("a.md") },
        StoreCall::RanOpaque { id: id() },
        StoreCall::NoteOutput { id: id(), tool: s("exec"), path: s("o"), bytes: r(&[6]) },
        StoreCall::OutputIsOwn { id: id(), tool: s("exec"), path: s("o"), bytes: r(&[7]) },
        StoreCall::MadeFiles { id: id() },
        StoreCall::RanMade { id: id(), by: None, files: vec![(s("/m/out/a.o"), s("ab"), true)],
            capped: true },
        StoreCall::Theirs { id: id(), path: s("a.md") },
        StoreCall::FolderOf { path: s("/home/x/a.md") },
        StoreCall::Versionable { id: id(), path: s("a.md") },
        StoreCall::AuthoredByUser { id: id(), path: s("a.md"), now: r(b"his") },
        StoreCall::ChangeRefused { id: id(), path: s("a.md") },
        StoreCall::RefuseChange { id: id(), path: s("a.md") },
        StoreCall::OpenDeleteRoom { id: id(), file: s("a.md") },
        StoreCall::OpenDeleteAnswer { id: id(), ticket: 11, allow: true },
        StoreCall::OpenDeleteRelease { id: id(), file: s("a.md") },
        StoreCall::OpenWindow { id: id(), by: Some(author()) },
        StoreCall::CloseWindow { window: h },
        StoreCall::VersionsRecord {
            id:         id(),
            cause:      Cause::Share,
            turn:       s("t1"),
            note:       WireText::Words(s("n")),
            change:     wc(),
        },
        StoreCall::RecordedNames { id: id(), version: 5, after: Some(s("a.md")) },
        StoreCall::VersionsBody { id: id(), hash: HexHash::of(b"abc") },
        StoreCall::VersionsUndoTarget { id: id(), path: s("a.md"), at: None },
        StoreCall::VersionsManifest { id: id(), version: 7 },
        StoreCall::RouteHere {
            row:        s("a.md"),
            row_folder: Some(s("work")),
            landed:     s("a.md"),
            overwrites: true,
        },
        StoreCall::RestoreStore { ticket: 1 },
        StoreCall::RestoreRoute {
            ticket:     1,
            spelled:    s("A.md"),
            landed:     s("a.md"),
            now:        None,
            puts:       Some(r(&[8])),
        },
        StoreCall::RestoreLook { ticket: 1, spelled: s("a.md"), now: Seen::Bytes(hex()) },
        StoreCall::RestoreAsked { ticket: 1, spelled: s("a.md"), now: Seen::Absent },
        StoreCall::RestoreKeep { ticket: 1, path: s("a.md"), now: Some(r(b"")), deleting: false },
        StoreCall::RestoreLetGo { ticket: 1, path: s("a.md") },
        StoreCall::RestoreLanded { ticket: 1, change: wc() },
        StoreCall::HoldVersions { id: id() },
        StoreCall::IsSteering { id: id() },
        StoreCall::Steering { id: id() },
        StoreCall::DrainDirty { id: id() },
        StoreCall::VersionsRecordDirty {
            id:     id(),
            dirty:  vec![Handle(1), Handle(2)],
            cause:  Cause::Turn,
            note:   WireText::Body(r(b"his long words")),
        },
        StoreCall::TurnWants { id: id() },
        StoreCall::TurnWantsPage { id: id(), n: 1 },
        StoreCall::TurnStanding {
            id:         id(),
            path:       s("a.md"),
            seen:       Seen::Unread,
            standing:   WireStanding::Now(WireBody::TooLarge(1 << 40)),
            stamp:      Some(crate::diamond_versions::Stamp::Seen(u64::MAX, Some(u64::MAX))),
        },
        StoreCall::TurnStands { id: id(), stands: vec![(s("a.md"), Seen::Absent)] },
        StoreCall::TurnWiped { id: id(), path: s("a.md"), seen: Seen::Unread, wiped: true },
        StoreCall::DrainTurn { hold: h, id: id() },
        StoreCall::TurnUncovered { hold: h, id: id(), wrote: vec![s("a.md"), s("b.md")] },
        StoreCall::TurnAdd { hold: h, id: id(), change: wc() },
        StoreCall::DrainWindows { hold: h, id: id() },
        StoreCall::VersionsRecordHeld {
            hold:       h,
            id:         id(),
            at:         Some(2),
            cause:      Cause::Turn,
            turn:       s("t"),
            note:       WireText::Words(s("")),
        },
        StoreCall::RecordSteer {
            hold:           h,
            id:             id(),
            json:           WireText::Words(s("{}")),
            instruction:    WireText::Body(r(b"go")),
        },
        StoreCall::EndTurnCounts { id: id() },
        StoreCall::LiveBounds { live: res!(live()) },
        StoreCall::Reach { target: chat() },
        StoreCall::Trail { what: s("w"), detail: s("d") },
        StoreCall::BodyPut { id: id(), act: 1, hash: HexHash::of(&[1, 2]), len: 2, offset: 0, chunk: vec![1, 2] },
        StoreCall::BodyGet { id: id(), hash: HexHash::of(&[1, 2]), offset: 1, max: 1 },
        StoreCall::JournalPut { run: s("r1"), key: JournalKey::Round(2), len: 3, offset: 1, chunk: vec![1, 2] },
        StoreCall::JournalRead { run: s("r1"), from: JournalKey::Open, offset: 0 },
        StoreCall::JournalList { after: Some(s("r1")) },
        StoreCall::JournalSweep { ttl_ms: 7, now_ms: 9 },
        StoreCall::JournalDrop { run: s("r1") },
        StoreCall::LetGo { handle: h },
        StoreCall::Ping {},
    ])
}

/// One of every reply, each answering well.
fn replies() -> Outcome<Vec<StoreReply>> {
    let link = Link {
        id:     s("l1"),
        ts:     5,
        from:   Node { kind: s("diamond"), rest: s("ab12") },
        to:     Node { kind: s("url"), rest: s("https://x") },
        rel:    s("cites"),
        note:   s(""),
        by:     s("user"),
        share:  true,
    };
    let reach = Reach {
        attached:       vec![s("a")],
        read_only:      vec![],
        unconfirmed:    vec![s("u")],
        nested:         vec![],
    };
    let wants = Wants {
        own:        vec![(s("a.md"), Seen::Bytes(hex()))],
        notes:      vec![(s("n.md"), Seen::Absent)],
        windows:    vec![(s("w.md"), Seen::Unread)],
        large:      vec![(s("big.pdf"), BodyRef::of(&[1]))],
        wipe:       vec![(s("/m/big.pdf"), Seen::Bytes(hex()), BodyRef::of(&[2]))],
    };
    let r = |b: &[u8]| BodyRef::of(b);
    let page = WantsPage { wants, total: 5, more: false };
    Ok(vec![
        StoreReply::ReadCrystalData(Ok(r(b"{}"))),
        StoreReply::ReadCrystalDataStrict(Ok(r(b"{}"))),
        StoreReply::ReadCrystalPage(Ok(r(b"<p>"))),
        StoreReply::ReadCrystalPageStrict(Ok(r(b"<p>"))),
        StoreReply::CrystalHalf(Some(CrystalHalf::Data)),
        StoreReply::CrystalUndoTarget(Ok(Some((3, s("h"))))),
        StoreReply::HotRefusals(2),
        StoreReply::SetHotRefusals(Ok(())),
        StoreReply::CrystalHotLastGood(Ok(r(b"{}"))),
        StoreReply::LastPassed(Some(passed())),
        StoreReply::MarkPassed(Ok(passed())),
        StoreReply::StandingSettle(Ok(())),
        StoreReply::StateRead(Ok((Some(r(b"# State\n")), Some(r(b"1\tWhere\n"))))),
        StoreReply::StoreFileRead(Ok(Some((r(b"# State\n"), 8)))),
        StoreReply::StoreFileList(Ok(vec![(s("decisions-archive.md"), false, 12, Some(1_700)),
            (s("versions"), true, 0, None)])),
        StoreReply::StoreWriteThen(Ok(Some(Seen::Absent))),
        StoreReply::StoreFileAct(Ok(())),
        StoreReply::AbsorbFoldNotes(Some(notes())),
        StoreReply::AddLink(Ok(s("l1"))),
        StoreReply::AllLinks(Ok(s("[]"))),
        StoreReply::LinksJson(Ok(s("[]"))),
        StoreReply::LinksPage(Ok(LinksPage {
            stamp:  HexHash::of(b"x"),
            links:  vec![
                PageLink::Link(link.clone()),
                PageLink::Refused { id: s("l2"), why: s("its to end is too long") },
            ],
            next:   Some(16),
        })),
        StoreReply::RemoveLinkByModel(Ok(Unlinked::of(&Unlink::Removed(vec![link])))),
        StoreReply::DiamondExists(true),
        StoreReply::ActivityReadAll(Ok(vec![(s(".daimond/activity/a.log"), s("{\"at\":1}\n"))])),
        StoreReply::ActivityAppend(Ok(())),
        StoreReply::NoProgressRounds(20),
        StoreReply::Capture(Ok(())),
        StoreReply::CapturedRoom(Err(Short::Bytes(12))),
        StoreReply::KeepRoom(1 << 20),
        StoreReply::Release(()),
        StoreReply::HeldUnder(vec![(s("a"), s("b"), s("c"))]),
        StoreReply::ThisTurnFound(WireTurnFound::refer(&TurnFound::Carried(vec![1]))),
        StoreReply::TurnsFound(Some(r(&[2]))),
        StoreReply::MeasuredAgainst(r(&[3])),
        StoreReply::SealsSpent(false),
        StoreReply::SealRun(Ok(())),
        StoreReply::Pend(Ok(true)),
        StoreReply::Unpend(()),
        StoreReply::RanOpaque(()),
        StoreReply::NoteOutput(()),
        StoreReply::OutputIsOwn(true),
        StoreReply::MadeFiles(vec![(s("/m/a.typ"), s("ab"))]),
        StoreReply::RanMade(()),
        StoreReply::Theirs(false),
        StoreReply::FolderOf(Some(s("work"))),
        StoreReply::Versionable(true),
        StoreReply::AuthoredByUser(false),
        StoreReply::ChangeRefused(true),
        StoreReply::RefuseChange(()),
        StoreReply::OpenDeleteRoom(OpenDelete::Ask(3, 11)),
        StoreReply::OpenDeleteAnswer(()),
        StoreReply::OpenDeleteRelease(()),
        StoreReply::OpenWindow(Handle(4)),
        StoreReply::CloseWindow(()),
        StoreReply::VersionsRecord(Ok(Some(Recorded::of(5, &[s("a.md")])))),
        StoreReply::RecordedNames(Ok(vec![s("b.md")])),
        StoreReply::VersionsBody(Ok(Some(r(&[4])))),
        StoreReply::VersionsUndoTarget(Ok(Some((5, s("h"), true, Some(s("work")))))),
        StoreReply::VersionsManifest(Ok(Some(s("{\"v\":2}")))),
        StoreReply::RouteHere(Route::Ask(Unplaced::Unknown)),
        StoreReply::RestoreStore(Some(s("ab12"))),
        StoreReply::RestoreRoute(Act::Ask(Unplaced::Unrecorded)),
        StoreReply::RestoreLook(Some(false)),
        StoreReply::RestoreAsked(()),
        StoreReply::RestoreKeep(Ok(())),
        StoreReply::RestoreLetGo(()),
        StoreReply::RestoreLanded(Ok(())),
        StoreReply::HoldVersions(Ok(Handle(8))),
        StoreReply::IsSteering(true),
        StoreReply::Steering(Handle(9)),
        StoreReply::DrainDirty(vec![Handle(1)]),
        StoreReply::VersionsRecordDirty(Ok(None)),
        StoreReply::TurnWants(Ok(page.clone())),
        StoreReply::TurnWantsPage(Ok(WantsPage { more: true, ..page })),
        StoreReply::TurnStanding(Ok(())),
        StoreReply::TurnStands(Ok(())),
        StoreReply::TurnWiped(Ok(())),
        StoreReply::DrainTurn(Ok(Drained { captured: 3 })),
        StoreReply::TurnUncovered(Ok(vec![s("b.md")])),
        StoreReply::TurnAdd(Ok(())),
        StoreReply::DrainWindows(Ok(2)),
        StoreReply::VersionsRecordHeld(Ok(None)),
        StoreReply::RecordSteer(Ok(6)),
        StoreReply::EndTurnCounts(()),
        StoreReply::LiveBounds(Ok(vec![
            Bound::NoWrite(s("a")),
            Bound::Toolkit(Toolkit::Rust),
            Bound::Nowhere,
        ])),
        StoreReply::Reach(Ok(reach)),
        StoreReply::Trail(()),
        StoreReply::BodyPut(Ok(Put::Held)),
        StoreReply::BodyGet(Ok(vec![2])),
        StoreReply::JournalPut(Ok(Put::More)),
        StoreReply::JournalRead(Ok(Some(JournalChunk { key: JournalKey::Round(2), len: 3, chunk: vec![1, 2, 3] }))),
        StoreReply::JournalList(Ok(vec![JournalRun { run: s("r1"), open: true },
            JournalRun { run: s("r2"), open: false }])),
        StoreReply::JournalSweep(Ok(3)),
        StoreReply::JournalDrop(Ok(())),
        StoreReply::LetGo(()),
        StoreReply::Ping(()),
        StoreReply::Fault(Fault::Down(StoreDown { why: s("a call panicked") })),
        StoreReply::Fault(Fault::Busy(StoreBusy { call: s("seal_run"), secs: 120 })),
        StoreReply::Fault(Fault::Unbound(Unbound { call: s("drain_turn"), id: s("cd34") })),
    ])
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Round trips                                                    │
// └───────────────────────────────────────────────────────────────┘

#[test]
fn every_call_round_trips() -> Outcome<()> {
    let all = res!(calls());
    let seen: BTreeSet<&str> = all.iter().map(|c| c.name()).collect();
    let want: BTreeSet<&str> = StoreCall::NAMES.iter().copied().collect();
    assert_eq!(seen, want, "one sample per call");
    assert_eq!(all.len(), StoreCall::NAMES.len());
    for c in &all {
        let bytes = res!(encode_call(c));
        assert!(bytes.len() <= FRAME_MAX, "{} is {} bytes", c.name(), bytes.len());
        let back = res!(decode_call(&bytes));
        assert_eq!(&back, c, "{}", c.name());
    }
    Ok(())
}

#[test]
fn every_reply_round_trips() -> Outcome<()> {
    let all = res!(replies());
    let seen: BTreeSet<&str> = all.iter().map(|r| r.name()).collect();
    let mut want: BTreeSet<&str> = StoreCall::NAMES.iter().copied().collect();
    want.insert("fault");
    assert_eq!(seen, want, "one sample per reply");
    for r in &all {
        let bytes = res!(encode_reply(r));
        assert!(bytes.len() <= FRAME_MAX, "{} is {} bytes", r.name(), bytes.len());
        let back = res!(decode_reply(&bytes));
        // No error in these, so the second encoding is the first byte for byte.
        assert_eq!(res!(encode_reply(&back)), bytes, "{}", r.name());
        assert_eq!(fmt!("{:?}", back), fmt!("{:?}", r), "{}", r.name());
    }
    Ok(())
}

#[test]
fn a_reply_answers_its_own_call_only() -> Outcome<()> {
    let calls = res!(calls());
    let replies = res!(replies());
    for c in &calls {
        let mine: Vec<&StoreReply> = replies.iter().filter(|r| r.answers(c)).collect();
        // Its own, and the three faults, which answer any call.
        assert_eq!(mine.len(), 4, "{}", c.name());
    }
    Ok(())
}

#[test]
fn every_call_says_its_kind() -> Outcome<()> {
    // The sync-kind calls, as `HostStore` declares them (a plain `fn`), with the ping and the
    // let-go, which the store answers inline.
    let sync: BTreeSet<&str> = [
        "crystal_half", "capture", "captured_room", "release", "held_under", "this_turn_found",
        "seals_spent", "ran_opaque", "theirs", "folder_of", "versionable", "open_delete_room",
        "open_delete_answer", "open_delete_release", "route_here", "restore_store",
        "restore_route", "restore_look", "restore_asked", "restore_landed", "is_steering",
        "steering", "drain_dirty", "end_turn_counts", "trail", "let_go", "ping",
        "change_refused", "refuse_change",
    ].into_iter().collect();
    for c in &res!(calls()) {
        assert_eq!(c.sync(), sync.contains(c.name()), "{}", c.name());
    }
    Ok(())
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Errors keep their words and tags                               │
// └───────────────────────────────────────────────────────────────┘

#[test]
fn a_refusal_keeps_its_text_and_tags() -> Outcome<()> {
    let e = refusal();
    let r = StoreReply::SealRun(Err(e.clone()));
    let back = res!(decode_reply(&res!(encode_reply(&r))));
    match back {
        StoreReply::SealRun(Err(b)) => {
            assert_eq!(b.plain(), e.plain());
            assert_eq!(b.msgs(), e.msgs());
            assert_eq!(b.tags(), e.tags());
            assert_eq!(b.tags(), vec![ErrTag::Invalid, ErrTag::Input, ErrTag::Conflict, ErrTag::Write]);
        },
        other => panic!("not a refused seal_run: {:?}", other),
    }
    Ok(())
}

#[test]
fn a_typed_refusal_is_still_itself_after_the_trip() -> Outcome<()> {
    let down = StoreDown { why: s("a call panicked") }.to_error();
    let busy = StoreBusy { call: s("pend"), secs: 120 }.to_error();
    let unbound = Unbound { call: s("drain_turn"), id: s("cd34") }.to_error();
    let unreadable = Unreadable { path: s("a.md"), why: s("permission denied") }.to_error();
    // Under a frame of the caller's own, as a `res!` leaves it.
    let wrapped = err!(unreadable.clone(), "Reading the turn's files."; IO);
    for (e, which) in [
        (down, 0),
        (busy, 1),
        (unbound, 2),
        (unreadable, 3),
        (wrapped, 3),
    ] {
        let r = StoreReply::Pend(Err(e.clone()));
        let b = match res!(decode_reply(&res!(encode_reply(&r)))) {
            StoreReply::Pend(Err(b)) => b,
            other => panic!("not a refused pend: {:?}", other),
        };
        assert_eq!(b.plain(), e.plain());
        assert_eq!(b.tags(), e.tags());
        let is = [is_store_down(&b), is_store_busy(&b), is_unbound(&b), is_unreadable(&b)];
        for (i, v) in is.iter().enumerate() {
            assert_eq!(*v, i == which, "{} as {}", e.plain(), i);
        }
    }
    // A plain refusal is none of them, and nor is a NotFound read.
    let gone = err!("'a.md' is not there."; IO, Read, NotFound);
    for e in [refusal(), gone] {
        assert!(!is_store_down(&e) && !is_store_busy(&e) && !is_unbound(&e) && !is_unreadable(&e));
    }
    Ok(())
}

#[test]
fn a_fault_becomes_its_error() -> Outcome<()> {
    let f = Fault::Unbound(Unbound { call: s("drain_turn"), id: s("cd34") });
    let e = f.to_error();
    assert!(is_unbound(&e));
    assert!(e.plain().contains("cd34"), "{}", e.plain());
    assert!(is_store_down(&Fault::Down(StoreDown { why: s("x") }).to_error()));
    assert!(is_store_busy(&Fault::Busy(StoreBusy { call: s("x"), secs: 1 }).to_error()));
    Ok(())
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Frames                                                         │
// └───────────────────────────────────────────────────────────────┘

fn put(len: usize) -> StoreCall {
    let chunk = vec![0xab; len];
    StoreCall::BodyPut {
        id:     s("ab12"),
        act:    1,
        hash:   HexHash::of(&chunk),
        len:    len as u64,
        offset: 0,
        chunk,
    }
}

fn too_big(r: Outcome<impl std::fmt::Debug>) -> bool {
    match r {
        Err(e)  => e.tags().contains(&ErrTag::TooBig),
        Ok(v)   => panic!("admitted: {:?}", v),
    }
}

#[test]
fn a_full_chunk_fits_a_frame() -> Outcome<()> {
    let c = put(BODY_CHUNK);
    let bytes = res!(encode_call(&c));
    assert!(bytes.len() <= FRAME_MAX, "{} bytes", bytes.len());
    // Bytes travel as bytes, not as a list of numbers.
    assert!(bytes.len() < BODY_CHUNK + 1024, "{} bytes", bytes.len());
    assert_eq!(res!(decode_call(&bytes)), c);
    Ok(())
}

#[test]
fn a_frame_over_the_limit_is_refused_both_ways() -> Outcome<()> {
    assert!(too_big(encode_call(&put(BODY_CHUNK + 1))));
    assert!(too_big(encode_reply(&StoreReply::BodyGet(Ok(vec![0; BODY_CHUNK + 1])))));
    // A peer's frame that big is refused before it is read.
    let big = vec![0u8; FRAME_MAX + 1];
    assert!(too_big(decode_call(&big)));
    assert!(too_big(decode_reply(&big)));
    Ok(())
}

#[test]
fn a_well_formed_oversize_frame_is_refused_with_too_big() -> Outcome<()> {
    // Well formed, so only a size check can refuse it (D1k check 2 fix #2).
    let over = res!(dat_bytes(&res!(put(FRAME_MAX).to_dat())));
    assert!(over.len() > FRAME_MAX);
    assert!(too_big(decode_call(&over)));
    let over = res!(dat_bytes(&res!(StoreReply::BodyGet(Ok(vec![1; FRAME_MAX])).to_dat())));
    assert!(too_big(decode_reply(&over)));
    // Under `FRAME_MAX` but over its own `Meta` ceiling: the class check alone refuses it.
    let big = "x".repeat(FRAME_META_MAX + 4096);
    let call = StoreCall::DiamondExists { id: big.clone() };
    let bytes = res!(dat_bytes(&res!(call.to_dat())));
    assert!(bytes.len() < FRAME_MAX);
    assert!(too_big(decode_call(&bytes)));
    assert!(too_big(encode_call(&call)));
    let reply = StoreReply::LastPassed(Some(CrystalPassed {
        version: 1, at: 0, page: s(""), data: big, debug: 0,
    }));
    assert!(too_big(decode_reply(&res!(dat_bytes(&res!(reply.to_dat()))))));
    Ok(())
}

#[test]
fn a_malformed_frame_is_refused() -> Outcome<()> {
    let c = StoreCall::Release { id: s("ab12"), path: s("a.md") };
    let bytes = res!(encode_call(&c));
    // Trailing bytes.
    let mut long = bytes.clone();
    long.push(0);
    assert!(decode_call(&long).is_err());
    // Cut short.
    assert!(decode_call(&bytes[..bytes.len() - 1]).is_err());
    assert!(decode_call(&[]).is_err());
    // A reply is not a call.
    assert!(decode_call(&res!(encode_reply(&StoreReply::Release(())))).is_err());
    // An unknown call.
    let odd = res!(dat_bytes(&Dat::Map(map(vec![("Format", Dat::Map(Default::default()))]))));
    assert!(decode_call(&odd).is_err());
    // An unknown field is refused, not ignored (lead ruling).
    let mut dat = res!(c.to_dat());
    if let Dat::Map(outer) = &mut dat {
        for (_, inner) in outer.iter_mut() {
            if let Dat::Map(fields) = inner {
                fields.insert(Dat::Str(s("extra")), Dat::U8(1));
            }
        }
    }
    let extra = res!(dat_bytes(&dat));
    assert!(decode_call(&extra).is_err());
    // A missing field.
    let short = res!(dat_bytes(&Dat::Map(map(vec![(
        "Release",
        Dat::Map(map(vec![("id", Dat::Str(s("ab12")))])),
    )]))));
    assert!(decode_call(&short).is_err());
    Ok(())
}

#[test]
fn a_bad_diamond_id_is_refused_on_decode() -> Outcome<()> {
    let c = StoreCall::LiveBounds { live: res!(live()) };
    let mut dat = res!(c.to_dat());
    // Put "../x" where the id stands.
    fn swap(d: &mut Dat) {
        match d {
            Dat::Str(v) if v == "ab12" => *v = "../x".to_string(),
            Dat::Map(m) => for (_, v) in m.iter_mut() { swap(v) },
            Dat::List(l) => for v in l.iter_mut() { swap(v) },
            _ => (),
        }
    }
    swap(&mut dat);
    assert!(decode_call(&res!(dat_bytes(&dat))).is_err());
    Ok(())
}

fn map(pairs: Vec<(&str, Dat)>) -> oxedyne_fe2o3_jdat::map::DaticleMap {
    pairs.into_iter().map(|(k, v)| (Dat::Str(k.to_string()), v)).collect()
}

fn dat_bytes(d: &Dat) -> Outcome<Vec<u8>> {
    d.to_bytes(Vec::new())
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Generated changes                                              │
// └───────────────────────────────────────────────────────────────┘

/// A small fixed-seed generator, so a failure names a case that can be run again.
struct Gen(u64);

impl Gen {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: u64) -> u64 { self.next() % n }
    fn coin(&mut self) -> bool { self.below(2) == 0 }
    fn bytes(&mut self) -> Vec<u8> {
        let n = match self.below(4) { 0 => 0, 1 => 1, 2 => self.below(64), _ => self.below(4096) };
        (0..n).map(|_| self.next() as u8).collect()
    }
    fn text(&mut self) -> String {
        const PARTS: &[&str] = &["a", "é", "/", "..", " ", "日本", "\"", "\\", "\n", "🙂", ""];
        let n = self.below(8);
        (0..n).map(|_| PARTS[self.below(PARTS.len() as u64) as usize]).collect()
    }
    fn maybe<T>(&mut self, f: impl FnOnce(&mut Self) -> T) -> Option<T> {
        if self.coin() { Some(f(self)) } else { None }
    }
    fn body(&mut self) -> Body {
        match self.below(5) {
            0 => Body::Held(self.bytes()),
            1 => Body::TooLarge(self.next()),
            2 => Body::Unseen,
            3 => Body::Large(BodyRef::of(&self.bytes())),
            _ => Body::Gone,
        }
    }
    fn found(&mut self) -> Found {
        match self.below(3) {
            0 => Found::Nothing,
            1 => Found::Hash(hash_of(self.text().as_bytes())),
            _ => Found::Unread,
        }
    }
    fn carried(&mut self) -> Carried {
        match self.below(3) {
            0 => Carried::Made,
            1 => Carried::Kept(crate::diamond_versions::Prior::Held(self.bytes())),
            _ => Carried::Unread,
        }
    }
    fn author(&mut self) -> Author {
        Author {
            role:   self.text(),
            m:      self.text(),
            pv:     self.text(),
            sp:     self.text(),
            run:    self.text(),
            via:    self.text(),
        }
    }
    fn change(&mut self) -> Change {
        Change {
            path:       self.text(),
            after:      self.body(),
            before:     (self.maybe(|g| g.bytes())).map(crate::diamond_versions::Prior::Held),
            found:      self.found(),
            carried:    self.maybe(|g| g.carried()),
            mark:       self.coin(),
            refused:    self.maybe(|g| g.text()),
            wiped:      self.coin(),
            folder:     self.maybe(|g| g.text()),
            by:         self.maybe(|g| g.author()),
            door:       self.coin(),
        }
    }
}

#[test]
fn generated_changes_and_founds_round_trip() -> Outcome<()> {
    let mut g = Gen(0x9e37_79b9_7f4a_7c15);
    for case in 0..500 {
        let change = g.change();
        let found = g.found();
        let wire = WireChange::refer(&change);
        let c = StoreCall::Capture { id: s("ab12"), raw: change.path.clone(), change: wire.clone() };
        assert_eq!(res!(decode_call(&res!(encode_call(&c)))), c, "case {}", case);
        // And back to the port's own, its bodies fetched by reference.
        let mut store = Bodies::default();
        store.keep(&change);
        assert_eq!(res!(wire.resolve(&mut |r| store.get(r))), change, "case {}", case);
        let c = StoreCall::CapturedRoom {
            id:         s("ab12"),
            path:       s("a"),
            found:      found.clone(),
            copy:       g.maybe(|g| g.next()),
            destroying: g.coin(),
            room:       g.next(),
        };
        assert_eq!(res!(decode_call(&res!(encode_call(&c)))), c, "case {}", case);
        assert_eq!(res!(Found::from_dat(res!(found.to_dat()))), found, "case {}", case);
        let c = StoreCall::VersionsRecord {
            id:         s("ab12"),
            cause:      Cause::Turn,
            turn:       s("t"),
            note:       WireText::refer(&g.text()),
            change:     WireChange::refer(&g.change()),
        };
        assert_eq!(res!(decode_call(&res!(encode_call(&c)))), c, "case {}", case);
    }
    Ok(())
}

/// A body store for `resolve`: every body a change names, by hash.
#[derive(Default)]
struct Bodies(std::collections::BTreeMap<String, Vec<u8>>);

impl Bodies {
    fn add(&mut self, b: &[u8]) { self.0.insert(BodyRef::of(b).hash, b.to_vec()); }
    fn keep(&mut self, c: &Change) {
        if let Body::Held(b) = &c.after { self.add(b) }
        if let Some(b) = c.before.as_ref().and_then(|p| p.held()) { self.add(b) }
        if let Some(Carried::Kept(p)) = &c.carried {
            if let Some(b) = p.held() { self.add(b) }
        }
    }
    fn get(&self, r: &BodyRef) -> Outcome<Vec<u8>> {
        match self.0.get(&r.hash) {
            Some(b) => Ok(b.clone()),
            None    => Err(err!("No body {}.", r.hash; Missing)),
        }
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Bodies by reference                                            │
// └───────────────────────────────────────────────────────────────┘

fn walk(d: &Dat, f: &mut impl FnMut(&Dat)) {
    f(d);
    match d {
        Dat::Map(m) => for (_, v) in m.iter() { walk(v, f) },
        Dat::List(l) => for v in l { walk(v, f) },
        Dat::Opt(o) => if let Some(v) = o.as_ref() { walk(v, f) },
        Dat::Box(b) => walk(b, f),
        Dat::Tup2(t) => for v in t.iter() { walk(v, f) },
        Dat::Tup3(t) => for v in t.iter() { walk(v, f) },
        Dat::Tup4(t) => for v in t.iter() { walk(v, f) },
        Dat::Tup5(t) => for v in t.iter() { walk(v, f) },
        Dat::Tup6(t) => for v in t.iter() { walk(v, f) },
        _ => (),
    }
}

fn bytes_in(d: &Dat) -> bool {
    let mut any = false;
    walk(d, &mut |d| if matches!(d,
        Dat::BU8(_) | Dat::BU16(_) | Dat::BU32(_) | Dat::BU64(_) | Dat::BC64(_)) { any = true });
    any
}

#[test]
fn no_bytes_cross_outside_the_body_channel() -> Outcome<()> {
    for c in &res!(calls()) {
        let chunked = c.name() == "body_put" || c.name() == "journal_put";
        assert_eq!(bytes_in(&res!(c.to_dat())), chunked, "{}", c.name());
    }
    for r in &res!(replies()) {
        let chunked = r.name() == "body_get" || r.name() == "journal_read";
        assert_eq!(bytes_in(&res!(r.to_dat())), chunked, "{}", r.name());
    }
    Ok(())
}

#[test]
fn a_capture_with_two_512_kib_bodies_fits() -> Outcome<()> {
    // Red on the D1k codec: 1,048,936 bytes, over its 1,000,000.
    let mut c = change();
    c.after = Body::Held(vec![1; 512 * 1024]);
    c.before = Some(crate::diamond_versions::Prior::Held(vec![2; 512 * 1024]));
    let call = StoreCall::Capture { id: s("ab12"), raw: s("a.md"), change: WireChange::refer(&c) };
    let bytes = res!(encode_call(&call));
    assert!(bytes.len() < 4096, "{} bytes", bytes.len());
    Ok(())
}

#[test]
fn a_body_over_the_version_ceiling_travels_as_large() -> Outcome<()> {
    let big = vec![7; VERSION_FILE_MAX + 1];
    let small = vec![8; VERSION_FILE_MAX];
    assert_eq!(WireBody::refer(&Body::Held(big.clone())), WireBody::Large(BodyRef::of(&big)));
    assert_eq!(WireBody::refer(&Body::Held(small.clone())), WireBody::Held(BodyRef::of(&small)));
    // A `Large` is never fetched; a `Held` is, and the wrong bytes are refused.
    let mut never = |_: &BodyRef| -> Outcome<Vec<u8>> { panic!("fetched") };
    assert_eq!(res!(WireBody::Large(BodyRef::of(&big)).resolve(&mut never)),
        Body::Large(BodyRef::of(&big)));
    let mut wrong = |_: &BodyRef| -> Outcome<Vec<u8>> { Ok(vec![9]) };
    assert!(WireBody::Held(BodyRef::of(&small)).resolve(&mut wrong).is_err());
    Ok(())
}

#[test]
fn a_copy_reply_naming_the_callers_bytes_is_not_fetched() -> Outcome<()> {
    let now = b"what the act found".to_vec();
    let mut never = |_: &BodyRef| -> Outcome<Vec<u8>> { panic!("fetched") };
    let t = WireTurnFound::refer(&TurnFound::Was(now.clone()));
    assert_eq!(res!(t.resolve(&now, &mut never)), TurnFound::Was(now.clone()));
    let other = b"a copy the turn kept".to_vec();
    let mut store = Bodies::default();
    store.add(&other);
    let t = WireTurnFound::refer(&TurnFound::Carried(other.clone()));
    assert_eq!(res!(t.resolve(&now, &mut |r| store.get(r))), TurnFound::Carried(other));
    Ok(())
}

#[test]
fn his_words_are_never_cut() -> Outcome<()> {
    // Over `TEXT_WIRE_MAX` his instruction travels as a body, whole.
    let long = "go on ".repeat(TEXT_WIRE_MAX);
    let t = WireText::refer(&long);
    assert!(matches!(t, WireText::Body(_)));
    let mut store = Bodies::default();
    store.add(long.as_bytes());
    assert_eq!(res!(t.resolve(&mut |r| store.get(r))), long);
    assert_eq!(WireText::refer("go"), WireText::Words(s("go")));
    // Words over it are refused, not cut.
    let c = StoreCall::RecordSteer {
        hold:           Handle(1),
        id:             s("ab12"),
        json:           WireText::Words(long.clone()),
        instruction:    WireText::Words(s("go")),
    };
    assert!(too_big(encode_call(&c)));
    assert!(too_big(decode_call(&res!(dat_bytes(&res!(c.to_dat()))))));
    Ok(())
}

/// The three texts a call carries as `WireText`, each set to `t`.
fn texted(t: &WireText) -> [StoreCall; 3] {
    [
        StoreCall::VersionsRecord {
            id:         s("ab12"),
            cause:      Cause::Turn,
            turn:       s("t"),
            note:       t.clone(),
            change:     WireChange::refer(&change()),
        },
        StoreCall::RecordSteer {
            hold:           Handle(1),
            id:             s("ab12"),
            json:           t.clone(),
            instruction:    WireText::Words(s("go")),
        },
        StoreCall::RecordSteer {
            hold:           Handle(1),
            id:             s("ab12"),
            json:           WireText::Words(s("{}")),
            instruction:    t.clone(),
        },
    ]
}

#[test]
fn his_words_at_the_text_ceiling_cross_whole() -> Outcome<()> {
    // 16,383 and 16,384 bytes go as words, 16,385 as a body; none is cut.  The multi-byte texts
    // put the ceiling inside a character.
    let e = "é".repeat(TEXT_WIRE_MAX / 2);
    for (text, words) in [
        ("a".repeat(TEXT_WIRE_MAX - 1),  true),
        ("a".repeat(TEXT_WIRE_MAX),      true),
        ("a".repeat(TEXT_WIRE_MAX + 1),  false),
        (fmt!("{}", e),                  true),
        (fmt!("a{}", e),                 false),
    ] {
        let t = WireText::refer(&text);
        assert_eq!(matches!(t, WireText::Words(_)), words, "{} bytes", text.len());
        let mut store = Bodies::default();
        store.add(text.as_bytes());
        for c in texted(&t) {
            let back = res!(decode_call(&res!(encode_call(&c))));
            assert_eq!(back, c, "{} at {} bytes", c.name(), text.len());
            let got = match back {
                StoreCall::VersionsRecord { note: t, .. } => t,
                StoreCall::RecordSteer { json, instruction, .. } =>
                    if json == WireText::Words(s("{}")) { instruction } else { json },
                other => panic!("not a texted call: {:?}", other),
            };
            assert_eq!(res!(got.resolve(&mut |r| store.get(r))), text, "{}", c.name());
        }
    }
    // Words one byte over are refused on both sides, never cut to fit.
    let over = WireText::Words("a".repeat(TEXT_WIRE_MAX + 1));
    for c in texted(&over) {
        assert!(too_big(encode_call(&c)), "{}", c.name());
        assert!(too_big(decode_call(&res!(dat_bytes(&res!(c.to_dat()))))), "{}", c.name());
    }
    Ok(())
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Ceilings                                                     │
// └───────────────────────────────────────────────────────────────┘

/// Every string at the largest a field may be outside a page, and every byte field a chunk.
fn inflate(d: &mut Dat) {
    match d {
        Dat::Str(v) => *v = "x".repeat(TEXT_WIRE_MAX),
        Dat::BU8(b) | Dat::BU16(b) | Dat::BU32(b) | Dat::BU64(b) | Dat::BC64(b) =>
            *b = vec![0; BODY_CHUNK],
        Dat::Map(m) => for (_, v) in m.iter_mut() { inflate(v) },
        Dat::List(l) => for v in l.iter_mut() { inflate(v) },
        Dat::Opt(o) => if let Some(v) = o.as_mut() { inflate(v) },
        Dat::Box(b) => inflate(b),
        Dat::Tup2(t) => for v in t.iter_mut() { inflate(v) },
        Dat::Tup3(t) => for v in t.iter_mut() { inflate(v) },
        Dat::Tup4(t) => for v in t.iter_mut() { inflate(v) },
        Dat::Tup5(t) => for v in t.iter_mut() { inflate(v) },
        Dat::Tup6(t) => for v in t.iter_mut() { inflate(v) },
        _ => (),
    }
}

fn len_of(d: &Dat) -> Outcome<usize> { Ok(res!(dat_bytes(d)).len()) }

fn path(c: char) -> String { std::iter::repeat(c).take(PATH_WIRE_MAX).collect() }
fn word(c: char) -> String { std::iter::repeat(c).take(WORD_WIRE_MAX).collect() }
fn hex() -> String { "f".repeat(64) }
fn bref() -> BodyRef { BodyRef { hash: hex(), len: u64::MAX } }

fn author_max() -> Author {
    Author { role: word('r'), m: word('m'), pv: word('p'), sp: word('s'), run: word('u'),
        via: word('v') }
}

fn change_max() -> WireChange {
    WireChange {
        path:       path('p'),
        after:      WireBody::Large(bref()),
        before:     Some(bref()),
        found:      Found::Hash(hex()),
        carried:    Some(WireCarried::Kept(bref())),
        mark:       true,
        refused:    Some("r".repeat(TEXT_WIRE_MAX)),
        wiped:      true,
        folder:     Some(path('f')),
        by:         Some(author_max()),
        door:       true,
    }
}

fn link_max() -> Link {
    Link {
        id:     word('i'),
        ts:     u64::MAX,
        from:   Node { kind: word('k'), rest: path('a') },
        to:     Node { kind: word('k'), rest: path('b') },
        rel:    word('r'),
        note:   "n".repeat(TEXT_WIRE_MAX),
        by:     word('b'),
        share:  true,
    }
}

fn seen_max() -> Seen { Seen::Bytes(hex()) }

#[test]
fn every_page_entry_is_within_its_derived_ceiling() -> Outcome<()> {
    // The constants the `_PAGE` assertions in `call.rs` use, measured.
    let held = (path('a'), path('b'), path('c'));
    for (what, n, max) in [
        ("path",    len_of(&res!(path('p').to_dat())),                          PATH_ENTRY_MAX),
        ("want",    len_of(&res!((path('p'), seen_max(), bref()).to_dat())),    WANT_ENTRY_MAX),
        ("held",    len_of(&res!(held.to_dat())),                               HELD_ENTRY_MAX),
        ("link",    len_of(&res!(link_max().to_dat())),                         LINK_ENTRY_MAX),
        ("change",  len_of(&res!(change_max().to_dat())),                       CHANGE_ENTRY_MAX),
    ] {
        let n = res!(n);
        assert!(n <= max, "a {} entry is {} bytes, over {}", what, n, max);
    }
    Ok(())
}

/// Each paged variant with a full page of its worst entries and every other field at its
/// ceiling.
fn full_calls() -> Vec<StoreCall> {
    let h = Handle(u64::MAX);
    vec![
        StoreCall::VersionsRecord {
            id:         word('i'),
            cause:      Cause::Turn,
            turn:       word('t'),
            note:       WireText::Words("n".repeat(TEXT_WIRE_MAX)),
            change:     change_max(),
        },
        StoreCall::TurnStands { id: word('i'), stands: vec![(path('p'), seen_max()); LIST_PAGE] },
        StoreCall::TurnUncovered { hold: h, id: word('i'), wrote: vec![path('p'); LIST_PAGE] },
        StoreCall::Capture { id: word('i'), raw: path('r'), change: change_max() },
        StoreCall::AddLink {
            owner:  word('o'),
            from:   path('f'),
            to:     path('t'),
            rel:    word('r'),
            note:   "n".repeat(TEXT_WIRE_MAX),
            by:     word('b'),
        },
        StoreCall::RecordSteer {
            hold:           h,
            id:             word('i'),
            json:           WireText::Words("j".repeat(TEXT_WIRE_MAX)),
            instruction:    WireText::Words("i".repeat(TEXT_WIRE_MAX)),
        },
        StoreCall::Trail { what: word('w'), detail: "d".repeat(TEXT_WIRE_MAX) },
        StoreCall::BodyPut {
            id:     word('i'),
            act:    u64::MAX,
            hash:   HexHash::of(b"h"),
            len:    u64::MAX,
            offset: 0,
            chunk:  vec![0xff; BODY_CHUNK],
        },
    ]
}

fn full_replies() -> Vec<StoreReply> {
    let names = vec![path('n'); LIST_PAGE];
    let recorded = Recorded { version: u64::MAX, count: u32::MAX, first: names.clone() };
    let wipe = vec![(path('w'), seen_max(), bref()); LIST_PAGE];
    vec![
        StoreReply::HeldUnder(vec![(path('a'), path('b'), path('c')); HELD_PAGE]),
        StoreReply::LinksPage(Ok(LinksPage {
            stamp:  HexHash::of(b"x"),
            links:  vec![PageLink::Link(link_max()); LINK_PAGE],
            next:   Some(u64::MAX),
        })),
        StoreReply::VersionsRecord(Ok(Some(recorded.clone()))),
        StoreReply::VersionsRecordHeld(Ok(Some(recorded.clone()))),
        StoreReply::VersionsRecordDirty(Ok(Some(recorded))),
        StoreReply::RecordedNames(Ok(names.clone())),
        StoreReply::TurnUncovered(Ok(names)),
        StoreReply::TurnWants(Ok(WantsPage {
            wants:  Wants { wipe, ..Default::default() },
            total:  u32::MAX,
            more:   true,
        })),
        StoreReply::BodyGet(Ok(vec![0xff; BODY_CHUNK])),
    ]
}

#[test]
fn every_variant_at_its_ceilings_fits_its_class() -> Outcome<()> {
    // Every call and reply, each string at `TEXT_WIRE_MAX` and each byte field a chunk.
    for c in &res!(calls()) {
        let mut d = res!(c.to_dat());
        inflate(&mut d);
        let n = res!(len_of(&d));
        assert!(n <= c.ceiling().max(), "{} is {} bytes over {:?}", c.name(), n, c.ceiling());
    }
    for r in &res!(replies()) {
        let mut d = res!(r.to_dat());
        inflate(&mut d);
        let n = res!(len_of(&d));
        assert!(n <= r.ceiling().max(), "{} is {} bytes over {:?}", r.name(), n, r.ceiling());
    }
    // Each paged one with a full page of its worst entries, through the codec.
    for c in &full_calls() {
        let bytes = res!(encode_call(c));
        assert!(bytes.len() <= c.ceiling().max(), "{}: {} bytes", c.name(), bytes.len());
        assert_eq!(&res!(decode_call(&bytes)), c, "{}", c.name());
    }
    for r in &full_replies() {
        let bytes = res!(encode_reply(r));
        assert!(bytes.len() <= r.ceiling().max(), "{}: {} bytes", r.name(), bytes.len());
        assert_eq!(fmt!("{:?}", res!(decode_reply(&bytes))), fmt!("{:?}", r), "{}", r.name());
    }
    // An error at its ceiling, under any reply.
    let r = StoreReply::SealRun(Err(chain(ERR_FRAMES_MAX + 8, 64 * 1024)));
    let bytes = res!(encode_reply(&r));
    assert!(bytes.len() <= FRAME_META_MAX, "{} bytes", bytes.len());
    // Only the body channel and a journal round's chunks (U4e) carry a chunk, and no frame
    // carries a chunk and a page.
    const CHUNKED: &[&str] = &["body_put", "body_get", "journal_put", "journal_read"];
    let chunks: Vec<&str> = StoreCall::NAMES.iter().copied()
        .filter(|n| CHUNKED.contains(n)).collect();
    assert_eq!(chunks.len(), 4);
    for c in &res!(calls()) {
        let r = res!(replies()).into_iter().find(|r| r.answers(c) && r.name() != "fault");
        let rc = r.map(|r| r.ceiling());
        let chunked = c.ceiling() == Ceiling::Chunk || rc == Some(Ceiling::Chunk);
        assert_eq!(chunked, chunks.contains(&c.name()), "{}", c.name());
    }
    Ok(())
}

/// The calls that change nothing and whose answer may be too big to frame: a `Read` reply,
/// refused `TooBig` in its own `Outcome`, is safe only for these.
const READS: &[&str] = &["all_links", "links_json", "links_page", "live_bounds", "reach",
    "activity_read_all", "store_file_list"];

/// A mutating call's reply always fits (D1k2 lead line, kept by D1v2): its effect has happened,
/// so an answer too big to frame would tell the caller of a failure that did not happen.  Every
/// call but the `READS` has a `Meta` or `Page` reply, and that reply at its ceilings, and each
/// paged one with a full page of its worst entries, fits `FRAME_MAX`.  Red: a `Read` class given
/// to a mutating call's reply.
#[test]
fn a_mutating_calls_reply_always_fits() -> Outcome<()> {
    let replies = res!(replies());
    for c in &res!(calls()) {
        let r = match replies.iter().find(|r| r.answers(c) && r.name() != "fault") {
            Some(r) => r,
            None    => panic!("{} has no reply in the table", c.name()),
        };
        if READS.contains(&c.name()) {
            assert_eq!(r.ceiling(), Ceiling::Read, "{} is listed a read", c.name());
            continue;
        }
        assert!(r.ceiling() != Ceiling::Read, "{}'s reply may be refused too big after its effect",
            c.name());
        let mut d = res!(r.to_dat());
        inflate(&mut d);
        let n = res!(len_of(&d));
        assert!(n <= FRAME_MAX, "{}'s reply at its ceilings is {} bytes", c.name(), n);
    }
    for r in &full_replies() {
        if !READS.contains(&r.name()) {
            let n = res!(encode_reply(r)).len();
            assert!(n <= FRAME_MAX, "{}'s full page is {} bytes", r.name(), n);
        }
    }
    // Every call is in the table, so a new one cannot pass unmeasured.
    let names: BTreeSet<&str> = res!(calls()).iter().map(|c| c.name()).collect();
    for name in StoreCall::NAMES.iter() {
        assert!(names.contains(name), "{} is not in calls()", name);
    }
    Ok(())
}

#[test]
fn a_read_too_big_to_frame_answers_too_big() -> Outcome<()> {
    let r = StoreReply::AllLinks(Ok("x".repeat(FRAME_MAX)));
    match res!(decode_reply(&res!(encode_reply(&r)))) {
        StoreReply::AllLinks(Err(e)) => assert!(e.tags().contains(&ErrTag::TooBig)),
        other => panic!("not a refused read: {:?}", other),
    }
    // A reply that is not a read has no such answer: the sender is refused.
    let r = StoreReply::AbsorbFoldNotes(Some(FoldNotes { task: "x".repeat(FRAME_MAX), ..notes() }));
    assert!(too_big(encode_reply(&r)));
    Ok(())
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Pages and fields                                               │
// └───────────────────────────────────────────────────────────────┘

#[test]
fn a_257_entry_page_is_refused() -> Outcome<()> {
    // Red on the D1k codec: sent.
    let c = StoreCall::TurnStands {
        id:     s("ab12"),
        stands: vec![(s("a.md"), Seen::Absent); LIST_PAGE + 1],
    };
    assert!(too_big(encode_call(&c)));
    // As a peer's raw frame, so only the decode side's bound can refuse it.
    assert!(too_big(decode_call(&res!(dat_bytes(&res!(c.to_dat()))))));
    let ok = StoreCall::TurnStands { id: s("ab12"), stands: vec![(s("a.md"), Seen::Absent); LIST_PAGE] };
    assert_eq!(res!(decode_call(&res!(encode_call(&ok)))), ok);
    // A reply's page, each at its own constant.
    for r in [
        StoreReply::HeldUnder(vec![(s("a"), s("b"), s("c")); HELD_PAGE + 1]),
        StoreReply::TurnUncovered(Ok(vec![s("a"); LIST_PAGE + 1])),
        StoreReply::RecordedNames(Ok(vec![s("a"); LIST_PAGE + 1])),
        StoreReply::VersionsRecordHeld(Ok(Some(Recorded {
            version: 1, count: 300, first: vec![s("a"); LIST_PAGE + 1],
        }))),
    ] {
        assert!(too_big(encode_reply(&r)), "{}", r.name());
        assert!(too_big(decode_reply(&res!(dat_bytes(&res!(r.to_dat()))))), "{}", r.name());
    }
    let names: Vec<String> = (0..300).map(|i| fmt!("f{}.md", i)).collect();
    let r = Recorded::of(4, &names);
    assert_eq!((r.count, r.first.len(), r.whole()), (300, LIST_PAGE, false));
    Ok(())
}

#[test]
fn a_path_note_or_chunk_over_its_constant_is_refused() -> Outcome<()> {
    let long = "p".repeat(PATH_WIRE_MAX + 1);
    for c in [
        StoreCall::Release { id: s("ab12"), path: long.clone() },
        StoreCall::HeldUnder { id: s("ab12"), from: s("d"), after: Some(long.clone()) },
        StoreCall::AddLink {
            owner:  s("ab12"),
            from:   s("diamond:ab12"),
            to:     s("url:x"),
            rel:    s("cites"),
            note:   "n".repeat(TEXT_WIRE_MAX + 1),
            by:     s("agent:w"),
        },
        StoreCall::BodyGet { id: s("ab12"), hash: HexHash::of(b"h"), offset: 0, max: BODY_CHUNK as u64 + 1 },
    ] {
        assert!(too_big(encode_call(&c)), "{}", c.name());
        assert!(too_big(decode_call(&res!(dat_bytes(&res!(c.to_dat()))))), "{}", c.name());
    }
    // A chunk past the body's end.
    let c = StoreCall::BodyPut { id: s("ab12"), act: 1, hash: HexHash::of(b"h"), len: 2, offset: 1, chunk: vec![1, 2] };
    assert!(encode_call(&c).is_err());
    // A trail's detail is cut and marked, not refused.
    let c = StoreCall::Trail { what: s("w"), detail: "d".repeat(64 * 1024) };
    for back in [
        res!(decode_call(&res!(encode_call(&c)))),
        res!(decode_call(&res!(dat_bytes(&res!(c.to_dat()))))),
    ] {
        match back {
            StoreCall::Trail { detail, .. } => {
                assert!(detail.len() <= TEXT_WIRE_MAX && detail.ends_with(CUT_MARK));
            },
            other => panic!("not a trail: {:?}", other),
        }
    }
    // A change's `refused` is cut on the way to the wire (§9.11 O4).
    let mut ch = change();
    ch.refused = Some("why ".repeat(TEXT_WIRE_MAX));
    let w = WireChange::refer(&ch);
    assert!(w.refused.as_ref().map_or(false, |r| r.len() <= TEXT_WIRE_MAX && r.ends_with(CUT_MARK)));
    Ok(())
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Error words                                                    │
// └───────────────────────────────────────────────────────────────┘

/// `frames` frames of `words` bytes each, one tag a frame.
fn chain(frames: usize, words: usize) -> Error<ErrTag> {
    let mut e = err!("{}", "w".repeat(words); Input);
    for i in 1..frames {
        e = err!(e, "{} {}", i, "w".repeat(words); Invalid);
    }
    e
}

fn frames_of(w: &ErrWire) -> usize {
    match w {
        ErrWire::Frame { cause: Some(c), .. }   => 1 + frames_of(c),
        ErrWire::Frame { cause: None, .. }      => 1,
        ErrWire::Collection(l)                  => l.iter().map(frames_of).sum(),
    }
}

fn deepest(w: &ErrWire) -> &str {
    match w {
        ErrWire::Frame { cause: Some(c), .. }   => deepest(c),
        ErrWire::Frame { msg, .. }              => msg,
        ErrWire::Collection(l)                  => l.last().map_or("", deepest),
    }
}

fn refused_pend(r: StoreReply) -> Error<ErrTag> {
    match r {
        StoreReply::Pend(Err(e)) => e,
        other => panic!("not a refused pend: {:?}", other),
    }
}

#[test]
fn a_64_kib_error_word_arrives_cut_and_marked() -> Outcome<()> {
    // Red on the D1k codec: 65,691 bytes arrived.
    let r = StoreReply::Pend(Err(err!("{}", "w".repeat(64 * 1024); Conflict, Write)));
    for bytes in [res!(encode_reply(&r)), res!(dat_bytes(&res!(r.to_dat())))] {
        let e = refused_pend(res!(decode_reply(&bytes)));
        let words = e.plain();
        assert!(words.len() <= ERR_WORDS_MAX, "{} bytes arrived", words.len());
        assert!(words.ends_with(CUT_MARK.trim_start()), "{}", &words[words.len() - 20..]);
        // Its tags arrive whole.
        assert_eq!(e.tags(), vec![ErrTag::Conflict, ErrTag::Write]);
    }
    Ok(())
}

#[test]
fn a_40_frame_chain_arrives_as_32_frames() -> Outcome<()> {
    let r = StoreReply::Pend(Err(chain(40, 16)));
    for bytes in [res!(encode_reply(&r)), res!(dat_bytes(&res!(r.to_dat())))] {
        let e = refused_pend(res!(decode_reply(&bytes)));
        let w = e.to_wire();
        assert_eq!(frames_of(&w), ERR_FRAMES_MAX);
        assert!(deepest(&w).ends_with(DEEPER_MARK), "{}", deepest(&w));
    }
    // A short chain is untouched.
    let r = StoreReply::Pend(Err(chain(3, 16)));
    let e = refused_pend(res!(decode_reply(&res!(encode_reply(&r)))));
    assert_eq!(frames_of(&e.to_wire()), 3);
    assert!(!e.plain().contains("dropped"));
    // A collection is cut across its members.
    let many = Error::Collection((0..40).map(|_| Box::new(chain(1, 8))).collect());
    let e = refused_pend(res!(decode_reply(&res!(encode_reply(&StoreReply::Pend(Err(many)))))));
    assert_eq!(frames_of(&e.to_wire()), ERR_FRAMES_MAX);
    // A fault's words too.
    let f = StoreReply::Fault(Fault::Down(StoreDown { why: "y".repeat(64 * 1024) }));
    match res!(decode_reply(&res!(dat_bytes(&res!(f.to_dat()))))) {
        StoreReply::Fault(Fault::Down(d)) => assert!(d.why.len() <= ERR_WORDS_MAX),
        other => panic!("not a fault: {:?}", other),
    }
    Ok(())
}

#[test]
fn a_mark_needs_its_tag_and_words_on_one_frame() -> Outcome<()> {
    // The words of one frame and the tag of another (D1k check 2 fix #3).
    let inner = err!("Something else went wrong."; Poisoned);
    let split = err!(inner, "{}: but not so.", DOWN_MARK; IO);
    assert!(!is_store_down(&split));
    // The words without the ": " that ends a mark.
    let bare = err!("{}stream of no account.", DOWN_MARK; Poisoned);
    assert!(!is_store_down(&bare));
    // Under a frame of the caller's own, and after the trip, still itself.
    let down = err!(StoreDown { why: s("x") }.to_error(), "Ending the turn."; IO);
    assert!(is_store_down(&down));
    let r = StoreReply::Pend(Err(down));
    assert!(is_store_down(&refused_pend(res!(decode_reply(&res!(encode_reply(&r)))))));
    Ok(())
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Hashes                                                         │
// └───────────────────────────────────────────────────────────────┘

/// Every call and reply that names a hash in a `Seen`, a `BodyRef` or a `Found`, each naming
/// `h`.
fn hashed(h: &str) -> (Vec<StoreCall>, Vec<StoreReply>) {
    let seen = Seen::Bytes(s(h));
    let r = BodyRef { hash: s(h), len: 1 };
    let mut ch = WireChange::refer(&change());
    ch.found = Found::Hash(s(h));
    let mut before = WireChange::refer(&change());
    before.before = Some(r.clone());
    let calls = vec![
        StoreCall::TurnStands { id: s("ab12"), stands: vec![(s("a.md"), seen.clone())] },
        StoreCall::TurnStanding {
            id: s("ab12"), path: s("a.md"), seen: seen.clone(), standing: WireStanding::Unknown,
            stamp: None,
        },
        StoreCall::TurnStanding {
            id:         s("ab12"),
            path:       s("a.md"),
            seen:       Seen::Absent,
            standing:   WireStanding::Now(WireBody::Held(r.clone())),
            stamp:      Some(crate::diamond_versions::Stamp::Hashed(hash_of(b"x"))),
        },
        StoreCall::TurnWiped { id: s("ab12"), path: s("a.md"), seen: seen.clone(), wiped: true },
        StoreCall::RestoreLook { ticket: 1, spelled: s("a.md"), now: seen.clone() },
        StoreCall::RestoreAsked { ticket: 1, spelled: s("a.md"), now: seen.clone() },
        StoreCall::RestoreRoute {
            ticket: 1, spelled: s("a.md"), landed: s("a.md"), now: Some(r.clone()), puts: None,
        },
        StoreCall::RestoreKeep { ticket: 1, path: s("a.md"), now: Some(r.clone()), deleting: false },
        StoreCall::ThisTurnFound { id: s("ab12"), path: s("a.md"), now: r.clone() },
        StoreCall::TurnsFound { id: s("ab12"), path: s("a.md"), now: r.clone() },
        StoreCall::MeasuredAgainst { id: s("ab12"), path: s("a.md"), now: r.clone() },
        StoreCall::SealsSpent { id: s("ab12"), path: s("a.md"), now: r.clone() },
        StoreCall::SealRun { id: s("ab12"), path: s("a.md"), now: r.clone() },
        StoreCall::Pend {
            id: s("ab12"), path: s("a.md"), before: r.clone(), deleting: false, mark: false,
        },
        StoreCall::NoteOutput { id: s("ab12"), tool: s("t"), path: s("a.md"), bytes: r.clone() },
        StoreCall::OutputIsOwn { id: s("ab12"), tool: s("t"), path: s("a.md"), bytes: r.clone() },
        StoreCall::StandingSettle {
            id: s("ab12"), root: FileRoot::Workspace, path: s("a.md"), phase: SettlePhase::Archive,
            archive: vec![(s("DECISIONS.md"), r.clone())], noted: vec![], touched: vec![], at: 0,
        },
        StoreCall::CapturedRoom {
            id:         s("ab12"),
            path:       s("a.md"),
            found:      Found::Hash(s(h)),
            copy:       None,
            destroying: false,
            room:       1,
        },
        StoreCall::Capture { id: s("ab12"), raw: s("a.md"), change: ch.clone() },
        StoreCall::TurnAdd { hold: Handle(1), id: s("ab12"), change: before },
        StoreCall::RecordSteer {
            hold:           Handle(1),
            id:             s("ab12"),
            json:           WireText::Body(r.clone()),
            instruction:    WireText::Words(s("go")),
        },
    ];
    let want = |w: Wants| StoreReply::TurnWants(Ok(WantsPage { wants: w, total: 1, more: false }));
    let replies = vec![
        want(Wants { own: vec![(s("a.md"), seen.clone())], ..Default::default() }),
        want(Wants { notes: vec![(s("a.md"), seen.clone())], ..Default::default() }),
        want(Wants { windows: vec![(s("a.md"), seen.clone())], ..Default::default() }),
        want(Wants { large: vec![(s("a.md"), r.clone())], ..Default::default() }),
        want(Wants { wipe: vec![(s("a.md"), Seen::Absent, r.clone())], ..Default::default() }),
        StoreReply::TurnsFound(Some(r.clone())),
        StoreReply::MeasuredAgainst(r.clone()),
        StoreReply::ThisTurnFound(WireTurnFound::Was(r.clone())),
        StoreReply::VersionsBody(Ok(Some(r.clone()))),
        StoreReply::ReadCrystalPage(Ok(r)),
    ];
    (calls, replies)
}

#[test]
fn a_hash_that_is_not_64_lowercase_hex_is_refused_both_ways() -> Outcome<()> {
    // Red on the D1k2 codec: a 65-character hash, an upper-case one and a short one crossed.
    let good = hex();
    for bad in [fmt!("{}0", good), good.to_uppercase(), s("abc"), s("")] {
        let (calls, replies) = hashed(&bad);
        for c in &calls {
            assert!(encode_call(c).is_err(), "{} sent the hash {:?}", c.name(), bad);
        }
        for r in &replies {
            assert!(encode_reply(r).is_err(), "{} sent the hash {:?}", r.name(), bad);
        }
        // A peer's raw frame: the good frame with its hash respelled.
        let (calls, replies) = hashed(&good);
        for c in &calls {
            let mut d = res!(c.to_dat());
            respell(&mut d, &good, &bad);
            assert!(decode_call(&res!(dat_bytes(&d))).is_err(), "{} read {:?}", c.name(), bad);
        }
        for r in &replies {
            let mut d = res!(r.to_dat());
            respell(&mut d, &good, &bad);
            assert!(decode_reply(&res!(dat_bytes(&d))).is_err(), "{} read {:?}", r.name(), bad);
        }
    }
    // The call fields that name a body by its hash alone are `HexHash`.
    for bad in [fmt!("{}0", good), good.to_uppercase(), s("abc")] {
        assert!(HexHash::new(&bad).is_err(), "{:?}", bad);
        let c = StoreCall::VersionsBody { id: s("ab12"), hash: res!(HexHash::new(&good)) };
        let mut d = res!(c.to_dat());
        respell(&mut d, &good, &bad);
        assert!(decode_call(&res!(dat_bytes(&d))).is_err(), "versions_body read {:?}", bad);
    }
    // The same calls and replies cross with a hash.
    let (calls, replies) = hashed(&good);
    for c in &calls {
        assert_eq!(&res!(decode_call(&res!(encode_call(c)))), c, "{}", c.name());
    }
    for r in &replies {
        assert_eq!(fmt!("{:?}", res!(decode_reply(&res!(encode_reply(r))))), fmt!("{:?}", r));
    }
    Ok(())
}

/// Every string `from` in `d` made `to`.
fn respell(d: &mut Dat, from: &str, to: &str) {
    match d {
        Dat::Str(v) => if v == from { *v = to.to_string() },
        Dat::Map(m) => for (_, v) in m.iter_mut() { respell(v, from, to) },
        Dat::List(l) => for v in l.iter_mut() { respell(v, from, to) },
        Dat::Opt(o) => if let Some(v) = o.as_mut() { respell(v, from, to) },
        Dat::Box(b) => respell(b, from, to),
        Dat::Tup2(t) => for v in t.iter_mut() { respell(v, from, to) },
        Dat::Tup3(t) => for v in t.iter_mut() { respell(v, from, to) },
        _ => (),
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Link pages (D1k3 ruling 1)                                     │
// └───────────────────────────────────────────────────────────────┘

fn row(id: &str, to: &str, note: &str) -> Link {
    Link {
        id:     s(id),
        ts:     1,
        from:   Node { kind: s("diamond"), rest: s("ab12") },
        to:     Node { kind: s("url"), rest: s(to) },
        rel:    s("cites"),
        note:   s(note),
        by:     s("agent:w"),
        share:  false,
    }
}

/// Seventeen links, the ninth (`l8`) given `big` as its note or as its `to` end.
fn sidecar_17(big_note: bool) -> String {
    let big = "n".repeat(3 << 20);
    let links: Vec<Link> = (0..17).map(|i| {
        let id = fmt!("l{}", i);
        match (i, big_note) {
            (8, true)   => row(&id, "https://x", &big),
            (8, false)  => row(&id, &fmt!("https://x/{}", big), "ok"),
            _           => row(&id, "https://x", "ok"),
        }
    }).collect();
    write_links(&links)
}

/// The walk as `RemoteStore` makes it, each page through the codec both ways.
fn walk_wire(text: &str) -> Outcome<(Vec<Link>, Vec<(String, String)>)> {
    walk_links(|at, stamp| {
        let page = links_page(text, at, stamp);
        let bytes = res!(encode_reply(&StoreReply::LinksPage(page)));
        match res!(decode_reply(&bytes)) {
            StoreReply::LinksPage(p) => p,
            other => Err(err!("{:?}", other.name(); Bug)),
        }
    })
}

#[test]
fn one_huge_note_is_cut_on_read_and_hides_no_later_link() -> Outcome<()> {
    // Red with the id-cursor reader: "after 0 links read … frame of 3148301 bytes is over its
    // Read ceiling" (rnd1k3-red1.log).
    let (links, refused) = res!(walk_wire(&sidecar_17(true)));
    assert_eq!((links.len(), refused.len()), (17, 0));
    assert_eq!(links[8].note.chars().count(), 2_000);
    Ok(())
}

#[test]
fn one_huge_end_is_refused_by_name_and_a_remove_then_rebuilds() -> Outcome<()> {
    // Red with the id-cursor reader: the remove answered `Removed { count: 16 }`, then the
    // rebuild failed on the same over-ceiling frame (rnd1k3-red1.log).
    let text = sidecar_17(false);
    let (links, refused) = res!(walk_wire(&text));
    assert_eq!(links.len(), 16);
    assert_eq!(refused.len(), 1);
    assert_eq!(refused[0].0, "l8");
    assert!(refused[0].1.contains("to end"), "{}", refused[0].1);

    let out = model_unlink(&parse_links(&text), "l12");
    let wire = res!(decode_reply(&res!(encode_reply(&StoreReply::RemoveLinkByModel(
        Ok(Unlinked::of(&out)))))));
    let left = match (&out, wire) {
        (Unlink::Removed(left), StoreReply::RemoveLinkByModel(Ok(u @ Unlinked::Removed { .. }))) =>
            (left.clone(), u),
        _ => panic!("not removed"),
    };
    let (back, refused) = res!(walk_wire(&write_links(&left.0)));
    assert_eq!((back.len(), refused.len()), (15, 1));
    match left.1.rebuild(back) {
        Unlink::Removed(v) => assert!(v.iter().all(|l| l.id != "l12")),
        _ => panic!("rebuilt as other than removed"),
    }
    Ok(())
}

#[test]
fn blank_and_repeated_ids_neither_loop_nor_skip() -> Outcome<()> {
    // Red with the id-cursor reader: 44 reads of 32 rows, from the first blank id again
    // (rnd1k3-red1c.log).
    let links: Vec<Link> = (0..40).map(|i| {
        let id = match i { 3 | 15 => s(""), 20..=35 => s("dup"), _ => fmt!("l{}", i) };
        row(&id, &fmt!("https://x/{}", i), "ok")
    }).collect();
    let mut text = write_links(&links);
    text.push_str("not a link\n\n");
    let (got, refused) = res!(walk_wire(&text));
    let ends: Vec<String> = got.iter().map(|l| l.to.rest.clone()).collect();
    let want: Vec<String> = (0..40).map(|i| fmt!("https://x/{}", i)).collect();
    assert_eq!((ends, refused.len()), (want, 0), "each row read once, in order");
    Ok(())
}

#[test]
fn a_sidecar_written_mid_walk_starts_the_walk_again() -> Outcome<()> {
    let before = write_links(&(0..20).map(|i| row(&fmt!("l{}", i), "https://x", "ok"))
        .collect::<Vec<_>>());
    let after = write_links(&(0..18).map(|i| row(&fmt!("m{}", i), "https://y", "ok"))
        .collect::<Vec<_>>());
    // A page asked under the old stamp is refused with the distinct marker.
    let first = res!(links_page(&before, 0, None));
    assert_eq!(first.next, Some(LINK_PAGE as u64));
    let stale = links_page(&after, LINK_PAGE as u64, Some(&first.stamp));
    assert!(stale.as_ref().err().map_or(false, is_links_changed), "{:?}", stale.map(|p| p.next));
    // A page past row 0 with no stamp is refused the same way.
    assert!(links_page(&before, 16, None).err().map_or(false, |e| is_links_changed(&e)));
    // The mark survives the wire.
    let wire = res!(decode_reply(&res!(encode_reply(&StoreReply::LinksPage(Err(
        links_changed()))))));
    assert!(matches!(&wire, StoreReply::LinksPage(Err(e)) if is_links_changed(e)));

    // The walk: the file changes after its first page, and it reads the new file whole.
    let mut pages = 0;
    let (got, _) = res!(walk_links(|at, stamp| {
        pages += 1;
        links_page(if pages == 1 { &before } else { &after }, at, stamp)
    }));
    assert_eq!(got.len(), 18);
    assert!(got.iter().all(|l| l.id.starts_with('m')));
    Ok(())
}

#[test]
fn a_link_page_over_its_field_bounds_is_refused_both_ways() -> Outcome<()> {
    let page = |e: PageLink| StoreReply::LinksPage(Ok(LinksPage {
        stamp: HexHash::of(b"x"), links: vec![e], next: None,
    }));
    let mut long_note = link_max();
    long_note.note.push('n');
    let mut long_end = link_max();
    long_end.to.rest.push('p');
    let mut long_kind = link_max();
    long_kind.from.kind.push('k');
    for bad in [
        page(PageLink::Link(long_note)),
        page(PageLink::Link(long_end)),
        page(PageLink::Link(long_kind)),
        page(PageLink::Refused { id: word('i') + "i", why: s("w") }),
        page(PageLink::Refused { id: s("l1"), why: "w".repeat(TEXT_WIRE_MAX + 1) }),
    ] {
        assert!(bad.bounded().is_err(), "{:?}", bad);
        assert!(encode_reply(&bad).is_err() || decode_reply(&res!(encode_reply(&bad))).is_err());
    }
    assert!(page(PageLink::Link(link_max())).bounded().is_ok());
    Ok(())
}

/// HL2 (d): a settle round-trips with its `phase` and `at` on either phase, and a STATE.md read
/// says an absent file absent, not as empty bytes.
#[test]
fn hl2_a_settle_carries_its_phase_and_at_and_a_state_read_says_absent() -> Outcome<()> {
    let r = |b: &[u8]| BodyRef::of(b);
    for phase in [SettlePhase::Archive, SettlePhase::Record] {
        let c = StoreCall::StandingSettle {
            id: s("ab12"), root: FileRoot::Opfs, path: s("diamonds/ab12/STATE.md"), phase,
            archive: vec![(s("DECISIONS.md"), r(b"x"))], noted: vec![s("- 2026-10-19 d")],
            touched: vec![s("\tGone")], at: 1_760_000_000_123,
        };
        let back = res!(decode_call(&res!(encode_call(&c))));
        assert_eq!(back, c, "{:?}", phase);
    }
    for reply in [StoreReply::StateRead(Ok((None, None))),
        StoreReply::StateRead(Ok((None, Some(r(b"1\tWhere\n")))))]
    {
        let bytes = res!(encode_reply(&reply));
        let back = res!(decode_reply(&bytes));
        assert_eq!(fmt!("{:?}", back), fmt!("{:?}", reply));
    }
    Ok(())
}
