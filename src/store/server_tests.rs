//! The store server's acceptance tests (d1v1 §4).  Each server is its own thread, so its store is
//! its own: no test sees another's ledgers, slots or windows.

use super::*;
use crate::{
    diamond_versions::{Body, Found, Short},
    store::{
        call::{StoreCall as C, StoreReply as R, WireChange, HexHash, Put, BODY_CHUNK, FRAME_MAX},
        mem::MemBackend,
    },
};

fn env(run: &str, diamonds: &[&str]) -> RunEnv {
    RunEnv {
        run:        run.to_string(),
        diamonds:   diamonds.iter().map(|d| d.to_string()).collect(),
        folder_id:  None,
        known:      BTreeSet::new(),
        page:       run.to_string(),
    }
}

fn server_over(backend: NativeBackend) -> StoreServer {
    match StoreServer::start(backend) {
        Ok(s)   => s,
        Err(e)  => panic!("the store server: {}", e),
    }
}

fn server() -> StoreServer { server_over(NativeBackend::Mem(MemBackend::default())) }

/// A server whose store holds the Diamond `d`'s metadata, so a turn can be recorded.
fn server_with_d() -> StoreServer {
    use crate::store::StoreBackend;
    let mem = MemBackend::default();
    let rt = match tokio::runtime::Builder::new_current_thread().build() {
        Ok(rt)  => rt,
        Err(e)  => panic!("a runtime: {}", e),
    };
    if let Err(e) = rt.block_on(mem.write_file("diamonds/d/.daimond/meta.json",
        br#"{"name":"d","crystal_version":0,"updated":0,"touched":0}"#))
    {
        panic!("the Diamond's metadata: {}", e);
    }
    server_over(NativeBackend::Mem(mem))
}

fn bind(s: &StoreServer, tag: Tag, run: &str) -> LoopLink {
    match s.bind(tag, env(run, &["d"])) {
        Ok(l)   => l,
        Err(e)  => panic!("binding {}: {}", run, e),
    }
}

fn ask(link: &LoopLink, call: C) -> R {
    match link.call_blocking(&call) {
        Ok(r)   => r,
        Err(e)  => panic!("store.{} from {}: {}", call.name(), link.run(), e),
    }
}

fn probe(s: &StoreServer) -> Probe {
    match s.probe("d") {
        Ok(p)   => p,
        Err(e)  => panic!("the probe: {}", e),
    }
}

fn dropped(s: &StoreServer, run: &str) {
    if let Err(e) = s.drop_run(run) {
        panic!("dropping {}: {}", run, e);
    }
}

fn room(link: &LoopLink, path: &str) -> Result<bool, Short> {
    match ask(link, C::CapturedRoom { id: s("d"), path: s(path), found: Found::Unread,
        copy: Some(1), destroying: false, room: u64::MAX })
    {
        R::CapturedRoom(r)  => r,
        other               => panic!("captured_room answered {:?}", other),
    }
}

fn s(v: &str) -> String { v.to_string() }

fn handle(r: R) -> Handle {
    match r {
        R::HoldVersions(Ok(h)) | R::OpenWindow(h) | R::Steering(h) => h,
        other => panic!("no handle: {:?}", other),
    }
}

fn hold(link: &LoopLink) -> Handle { handle(ask(link, C::HoldVersions { id: s("d") })) }

fn drained(link: &LoopLink, h: Handle) -> u32 {
    match ask(link, C::DrainTurn { hold: h, id: s("d") }) {
        R::DrainTurn(Ok(d)) => d.captured,
        other               => panic!("drain_turn answered {:?}", other),
    }
}

/// A note `link`'s run leaves on `path`, its room reserved first.
fn pends(link: &LoopLink, path: &str) {
    assert_eq!(room(link, path), Ok(true), "the room for the note");
    match ask(link, C::Pend { id: s("d"), path: s(path), before: BodyRef::of(b""),
        deleting: false, mark: false })
    {
        R::Pend(Ok(true))   => (),
        other               => panic!("pend answered {:?}", other),
    }
}

fn unbound_id(r: &R) -> Option<String> {
    match r {
        R::Fault(Fault::Unbound(u)) => Some(u.id.clone()),
        _                           => None,
    }
}

// 1
#[test]
fn drop_run_after_captured_room_frees_the_room() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let b = bind(&srv, Tag::Run, "b");
    for n in 0..crate::diamond_versions::TURN_FILES_MAX {
        assert_eq!(room(&a, &fmt!("/m/{}", n)), Ok(true), "a's room {}", n);
    }
    assert_eq!(room(&b, "/m/b"), Err(Short::Count), "the cap counts a's rooms");
    dropped(&srv, "a");
    assert_eq!(room(&b, "/m/b"), Ok(true), "a's rooms went with a");
}

// 2
#[test]
fn drop_run_closes_its_window_as_lost() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let _ = handle(ask(&a, C::OpenWindow { id: s("d"), by: None }));
    assert_eq!(probe(&srv).windows, vec![u64::MAX], "a's window is open");
    dropped(&srv, "a");
    let windows = probe(&srv).windows;
    assert_eq!(windows.len(), 1, "a's window is still taken at the turn end: {:?}", windows);
    assert!(windows[0] != u64::MAX, "a's window was closed as lost: {:?}", windows);
}

// 3
#[test]
fn a_sync_call_never_awaits() {
    let srv = server_over(NativeBackend::Tripwire(MemBackend::default()));
    let p = bind(&srv, Tag::Parent, "p");
    let empty = BodyRef::of(b"");
    let change = WireChange::refer(&crate::diamond_versions::Change {
        path:    s("/m/c"),
        after:   Body::Held(Vec::new()),
        before:  None,
        found:   Found::Unread,
        carried: None,
        mark:    false,
        refused: None,
        wiped:   false,
        folder:  None,
        by:      None,
        door:    false,
    });
    let steer = handle(ask(&p, C::Steering { id: s("d") }));
    let seen = Seen::Absent;
    let calls = vec![
        C::CrystalHalf { id: s("d"), path: s("/m/c") },
        C::Capture { id: s("d"), raw: s("/m/c"), change: change.clone() },
        C::CapturedRoom { id: s("d"), path: s("/m/r"), found: Found::Unread, copy: Some(1),
            destroying: false, room: u64::MAX },
        C::Release { id: s("d"), path: s("/m/r") },
        C::HeldUnder { id: s("d"), from: s("/m"), after: None },
        C::ThisTurnFound { id: s("d"), path: s("/m/c"), now: empty.clone() },
        C::SealsSpent { id: s("d"), path: s("/m/c"), now: empty.clone() },
        C::RanOpaque { id: s("d") },
        C::Theirs { id: s("d"), path: s("/m/c") },
        C::FolderOf { path: s("/m/c") },
        C::Versionable { id: s("d"), path: s("/m/c") },
        C::ChangeRefused { id: s("d"), path: s("/m/c") },
        C::RefuseChange { id: s("d"), path: s("/m/c") },
        C::OpenDeleteRoom { id: s("d"), file: s("/m/x") },
        C::OpenDeleteAnswer { id: s("d"), ticket: 1, allow: true },
        C::OpenDeleteRelease { id: s("d"), file: s("/m/x") },
        C::RouteHere { row: s("/m/c"), row_folder: None, landed: s("/m/c"), overwrites: false },
        C::RestoreStore { ticket: 7 },
        C::RestoreRoute { ticket: 7, spelled: s("/m/c"), landed: s("/m/c"), now: None,
            puts: None },
        C::RestoreLook { ticket: 7, spelled: s("/m/c"), now: seen.clone() },
        C::RestoreAsked { ticket: 7, spelled: s("/m/c"), now: seen },
        C::RestoreLanded { ticket: 7, change },
        C::IsSteering { id: s("d") },
        C::Steering { id: s("d") },
        C::DrainDirty { id: s("d") },
        C::EndTurnCounts { id: s("d") },
        C::Trail { what: s("t"), detail: s("d") },
        C::LetGo { handle: steer },
        C::Ping {},
    ];
    let declared = include_str!("call.rs").lines().filter(|l| l.starts_with("    sync ")).count();
    assert_eq!(calls.len(), declared, "every sync call is served here");
    for call in calls {
        assert!(call.sync(), "store.{} is a sync call", call.name());
        let r = ask(&p, call.clone());
        assert!(r.answers(&call) && !matches!(r, R::Fault(_)), "store.{}: {:?}", call.name(), r);
    }
    // A wait call is spawned, and may reach the backend.
    assert!(matches!(ask(&p, C::KeepRoom { id: s("d") }), R::KeepRoom(_)));
    assert!(matches!(ask(&p, C::Ping {}), R::Ping(())), "the store thread still answers");
}

// 3, second half
#[test]
fn a_parked_hold_does_not_stop_the_sync_calls_of_other_runs() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let b = bind(&srv, Tag::Run, "b");
    let c = bind(&srv, Tag::Run, "c");
    let held = hold(&a);
    let parked = std::thread::spawn(move || b.call_blocking(&C::HoldVersions { id: s("d") }));
    std::thread::sleep(std::time::Duration::from_millis(100));
    assert!(!parked.is_finished(), "b's hold waits on a's");
    for _ in 0..10 {
        assert!(matches!(ask(&c, C::Ping {}), R::Ping(())));
        assert!(matches!(ask(&c, C::IsSteering { id: s("d") }), R::IsSteering(false)));
    }
    assert!(!parked.is_finished(), "b's hold still waits");
    assert!(matches!(ask(&a, C::LetGo { handle: held }), R::LetGo(())));
    match parked.join() {
        Ok(Ok(R::HoldVersions(Ok(_))))  => (),
        other => panic!("b's hold, once a's was let go: {:?}", other.map(|r| r.map(|r| r.name()))),
    }
}

// 4
#[test]
fn one_thread_per_store() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let first = probe(&srv).thread;
    assert!(first != std::thread::current().id(), "the store is on its own thread");
    let from_another = std::thread::spawn(move || ask(&a, C::KeepRoom { id: s("d") })).join();
    assert!(from_another.is_ok());
    assert_eq!(probe(&srv).thread, first, "every call is served on the one thread");
}

// 5
#[test]
fn nothing_in_the_hold_table_outlives_drop_run() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let h = hold(&a);
    let _ = drained(&a, h);
    let _ = handle(ask(&a, C::OpenWindow { id: s("d"), by: None }));
    let _ = handle(ask(&a, C::Steering { id: s("d") }));
    let p = probe(&srv);
    assert_eq!((p.runs, p.held, p.slots), (1, 3, 1), "a's table and slot");
    dropped(&srv, "a");
    let p = probe(&srv);
    assert_eq!((p.runs, p.held, p.slots), (0, 0, 0), "nothing of a's is left");
}

// 6
#[test]
fn a_window_given_as_a_hold_is_refused() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let w = handle(ask(&a, C::OpenWindow { id: s("d"), by: None }));
    match ask(&a, C::DrainTurn { hold: w, id: s("d") }) {
        R::DrainTurn(Err(_)) => (),
        other => panic!("a window drained a turn: {:?}", other),
    }
}

// 7
#[test]
fn another_runs_handle_is_unbound() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let b = bind(&srv, Tag::Run, "b");
    let h = hold(&a);
    let r = ask(&b, C::DrainTurn { hold: h, id: s("d") });
    assert_eq!(unbound_id(&r), Some(fmt!("handle {}", h.0)), "b used a's hold: {:?}", r);
    let r = ask(&b, C::LetGo { handle: h });
    assert_eq!(unbound_id(&r), Some(fmt!("handle {}", h.0)), "b let a's hold go: {:?}", r);
    assert_eq!(drained(&a, h), 0, "a's hold is still a's");
}

// 8
#[test]
fn drop_run_frees_the_slot_and_leaves_its_notes_unsettled() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let b = bind(&srv, Tag::Run, "b");
    pends(&a, "/m/n.txt");
    let h = hold(&a);
    let _ = drained(&a, h);
    assert_eq!(probe(&srv).slots, 1, "a's slot is open");
    dropped(&srv, "a");
    assert_eq!(probe(&srv).slots, 0, "a's slot was freed");
    let hb = hold(&b);
    assert_eq!(drained(&b, hb), 1, "a's note, unsettled, is adopted by b's turn end");
}

// 9
#[test]
fn drop_run_clears_the_reservation_so_the_note_is_adopted() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let b = bind(&srv, Tag::Run, "b");
    pends(&a, "/m/n.txt");
    // The rest of the store's cap, reserved by a: a ledger drop_run left would still count.
    for n in 1..crate::diamond_versions::TURN_FILES_MAX {
        assert_eq!(room(&a, &fmt!("/m/r{}", n)), Ok(true), "a's room {}", n);
    }
    dropped(&srv, "a");
    assert_eq!(room(&b, "/m/b.txt"), Ok(true), "a dropped run's reservations still count");
    assert!(matches!(ask(&b, C::Release { id: s("d"), path: s("/m/b.txt") }), R::Release(())));
    let hb = hold(&b);
    assert_eq!(drained(&b, hb), 1, "a's note is no longer held back by its reservation");
}

// 10
#[test]
fn a_call_on_a_diamond_not_granted_is_unbound() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let p = bind(&srv, Tag::Parent, "p");
    let r = ask(&a, C::KeepRoom { id: s("e") });
    assert_eq!(unbound_id(&r), Some(s("e")), "a reached e: {:?}", r);
    let r = ask(&a, C::RestoreLook { ticket: 99, spelled: s("/m/c"), now: Seen::Absent });
    assert_eq!(unbound_id(&r), Some(s("ticket 99")), "a reached an unknown restore: {:?}", r);
    assert!(matches!(ask(&p, C::KeepRoom { id: s("e") }), R::KeepRoom(_)), "the parent may");
}

// 11
#[test]
fn a_door_is_refused_captured_room_and_admitted_restore_look() {
    let srv = server();
    let door = bind(&srv, Tag::Door, "door");
    let r = ask(&door, C::CapturedRoom { id: s("d"), path: s("/m/c"), found: Found::Unread,
        copy: Some(1), destroying: false, room: u64::MAX });
    assert_eq!(unbound_id(&r), Some(s("door door")), "a door had room: {:?}", r);
    let r = ask(&door, C::RestoreLook { ticket: 5, spelled: s("/m/c"), now: Seen::Absent });
    assert_eq!(unbound_id(&r), Some(s("ticket 5")), "the door rule admits restore_look: {:?}", r);
    assert!(matches!(ask(&door, C::Ping {}), R::Ping(())));
}

// 12
#[test]
fn a_call_from_an_unbound_run_is_refused() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    assert!(srv.bind(Tag::Run, env("", &["d"])).is_err(), "a run with no name");
    assert!(srv.bind(Tag::Run, RunEnv { page: String::new(), ..env("x", &["d"]) }).is_err(),
        "a run with no page");
    dropped(&srv, "a");
    let r = ask(&a, C::Ping {});
    assert_eq!(unbound_id(&r), Some(s("run a")), "a dropped run was answered: {:?}", r);
}

// d1v1 check D3
#[test]
fn a_door_is_admitted_the_reads_its_acts_make() {
    let srv = server();
    let door = bind(&srv, Tag::Door, "door");
    assert!(matches!(ask(&door, C::Versionable { id: s("d"), path: s("a.txt") }),
        R::Versionable(true)), "a door act's versionable was refused");
    assert!(matches!(ask(&door, C::Theirs { id: s("d"), path: s("a.txt") }), R::Theirs(_)),
        "a door act's theirs was refused");
    assert!(matches!(ask(&door, C::FolderOf { path: s("a.txt") }), R::FolderOf(_)),
        "a door act's folder_of was refused");
    // Past the door rule, a ticket no restore holds is the binding's own refusal.
    let r = ask(&door, C::RestoreStore { ticket: 7 });
    assert_eq!(unbound_id(&r), Some(s("ticket 7")), "a door act's restore_store: {:?}", r);
    let r = ask(&door, C::VersionsBody { id: s("d"), hash: HexHash::of(b"") });
    assert!(matches!(r, R::VersionsBody(_)), "a door act's versions_body was refused: {:?}", r);
    let r = ask(&door, C::CapturedRoom { id: s("d"), path: s("/m/c"), found: Found::Unread,
        copy: Some(1), destroying: false, room: u64::MAX });
    assert_eq!(unbound_id(&r), Some(s("door door")), "a door had room: {:?}", r);
    let r = ask(&door, C::Versionable { id: s("e"), path: s("a.txt") });
    assert_eq!(unbound_id(&r), Some(s("e")), "a door read a Diamond not granted: {:?}", r);
}

fn deletes(link: &LoopLink, file: &str) -> OpenDelete {
    match ask(link, C::OpenDeleteRoom { id: s("d"), file: s(file) }) {
        R::OpenDeleteRoom(o)    => o,
        other                   => panic!("open_delete_room answered {:?}", other),
    }
}

// d1v1 check D4, as D1v2c rules it: each run's tally is its own, so a dropped run's goes with it
// and the other run's limit is its own turn's, neither lifted nor spent by the dropped one.
#[test]
fn a_dropped_runs_count_is_never_another_runs() {
    let srv = server();
    let w = bind(&srv, Tag::Run, "w");
    let c = bind(&srv, Tag::Run, "c");
    let limit = crate::diamond_versions::OPEN_DELETES_ASK_DEFAULT;
    for n in 0..limit - 1 {
        assert_eq!(deletes(&w, &fmt!("f{}", n)), OpenDelete::Go(true), "the worker's {}", n);
    }
    assert_eq!(deletes(&c, "c0"), OpenDelete::Go(true), "the conductor's first");
    dropped(&srv, "w");
    assert_eq!(probe(&srv).deletes, 1, "the dropped run's count went with it");
    for n in 1..limit {
        assert_eq!(deletes(&c, &fmt!("c{}", n)), OpenDelete::Go(true), "the conductor's {}", n);
    }
    let over = deletes(&c, "over");
    assert!(matches!(over, OpenDelete::Ask(..)), "past the conductor's own limit: {:?}", over);
}

// d1v1 check D4, as D1v2c rules it (reversing D1v1c's shared tally): a run's turn end ends its
// own count only.  Red (the tally shared by the store): the worker's counted file is counted
// afresh, or the conductor's own is still counted after its turn end.
#[test]
fn end_turn_counts_ends_the_callers_count_only() {
    let srv = server();
    let w = bind(&srv, Tag::Run, "w");
    let c = bind(&srv, Tag::Run, "c");
    assert_eq!(deletes(&w, "a"), OpenDelete::Go(true));
    assert_eq!(deletes(&c, "b"), OpenDelete::Go(true));
    assert_eq!(probe(&srv).deletes, 2, "both counted");
    assert!(matches!(ask(&c, C::EndTurnCounts { id: s("d") }), R::EndTurnCounts(())));
    assert_eq!(probe(&srv).deletes, 1, "the conductor's count ended, the worker's stands");
    assert_eq!(deletes(&w, "a"), OpenDelete::Go(false), "the worker's file is still counted");
    assert_eq!(deletes(&c, "b"), OpenDelete::Go(true), "the conductor's next turn counts afresh");
    assert!(matches!(ask(&w, C::EndTurnCounts { id: s("d") }), R::EndTurnCounts(())));
    assert_eq!(deletes(&w, "a"), OpenDelete::Go(true), "the worker's own turn end ended it");
    assert_eq!(deletes(&c, "b"), OpenDelete::Go(false), "and left the conductor's");
}

// d1v1 check H1
#[test]
fn a_second_bind_is_refused_and_the_first_table_stands() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let h = hold(&a);
    assert!(srv.bind(Tag::Run, env("a", &["d"])).is_err(), "a run bound twice");
    assert!(srv.bind(Tag::Run, RunEnv { page: s("a"), ..env("b", &["d"]) }).is_err(),
        "a second run on a bound run's page");
    let p = probe(&srv);
    assert_eq!((p.runs, p.held), (1, 1), "the first table was replaced");
    assert_eq!(drained(&a, h), 0, "the first run's hold still serves");
    dropped(&srv, "a");
    let _ = bind(&srv, Tag::Run, "a");
}

// d1v1 check H2
#[tokio::test]
async fn a_sync_call_on_the_wait_path_is_a_fault() {
    let st: Shared = Rc::new(RefCell::new(State::default()));
    let bs = Bodies::staged(&st.borrow(), "a", None, Vec::new());
    let r = serve_wait(&st, "a", &bs, C::Ping {}).await;
    assert!(matches!(r, R::Fault(Fault::Down(_))), "a sync call served off the inline path: {:?}",
        r);
}

// Does a links answer name a link `d` holds, and one `e` holds?
fn owners(r: R) -> (bool, bool) {
    match r {
        R::AllLinks(Ok(t)) | R::LinksJson(Ok(t)) =>
            (t.contains("\"owner\":\"d\""), t.contains("\"owner\":\"e\"")),
        other => panic!("the links answered {:?}", other),
    }
}

// d1v1 check H3
#[test]
fn a_run_reads_the_links_of_its_own_diamonds_alone() {
    let srv = server();
    let p = bind(&srv, Tag::Parent, "p");
    let a = bind(&srv, Tag::Run, "a");
    for owner in ["d", "e"] {
        let r = ask(&p, C::AddLink { owner: s(owner), from: fmt!("diamond:{}", owner),
            to: s("url:https://x"), rel: s("cites"), note: s(""), by: s("") });
        assert!(matches!(r, R::AddLink(Ok(_))), "the link of {}: {:?}", owner, r);
    }
    assert_eq!(owners(ask(&p, C::AllLinks {})), (true, true), "the parent reads every link");
    assert_eq!(owners(ask(&a, C::AllLinks {})), (true, false), "all_links past the grant");
    assert_eq!(owners(ask(&a, C::LinksJson { node_ref: s("url:https://x") })), (true, false),
        "links_json past the grant");
    // The paged read (D1k3b shape): served for a granted owner, Unbound for another.
    match ask(&a, C::LinksPage { owner: s("d"), at: 0, stamp: None }) {
        R::LinksPage(Ok(page)) => {
            assert_eq!(page.links.len(), 1, "d's page: {:?}", page);
            assert!(page.next.is_none(), "one link is one page: {:?}", page);
        }
        other => panic!("links_page of d answered {:?}", other),
    }
    let r = ask(&a, C::LinksPage { owner: s("e"), at: 0, stamp: None });
    assert_eq!(unbound_id(&r), Some(s("e")), "links_page past the grant: {:?}", r);
}

// ── The body channel (D1v3, spec §16.3a 3, d1_plan §9.11 O2/O3) ──────────────────────────

/// One chunk, in the act `act`.
fn put_in(link: &LoopLink, act: u64, id: &str, bytes: &[u8], hash: &HexHash, offset: usize,
    end: usize) -> Outcome<Put>
{
    match ask(link, C::BodyPut { id: s(id), act, hash: hash.clone(), len: bytes.len() as u64,
        offset: offset as u64, chunk: bytes[offset..end].to_vec() })
    {
        R::BodyPut(r)   => r,
        other           => panic!("body_put answered {:?}", other),
    }
}

/// One chunk, in the act 1.
fn put(link: &LoopLink, id: &str, bytes: &[u8], hash: &HexHash, offset: usize, end: usize)
    -> Outcome<Put>
{
    put_in(link, 1, id, bytes, hash, offset, end)
}

/// Upload `bytes` whole for `id`, in chunks of `n`, in the act 1; the last answer.
fn upload(link: &LoopLink, id: &str, bytes: &[u8], n: usize) -> Outcome<Put> {
    upload_in(link, 1, id, bytes, n)
}

/// Upload `bytes` whole for `id`, in chunks of `n`, in the act `act`; the last answer.
fn upload_in(link: &LoopLink, act: u64, id: &str, bytes: &[u8], n: usize) -> Outcome<Put> {
    let hash = HexHash::of(bytes);
    let mut at = 0;
    loop {
        let end = bytes.len().min(at + n);
        let r = put_in(link, act, id, bytes, &hash, at, end);
        if end == bytes.len() || !matches!(r, Ok(Put::More)) {
            return r;
        }
        at = end;
    }
}

fn get(link: &LoopLink, id: &str, hash: &HexHash) -> Outcome<Vec<u8>> {
    match ask(link, C::BodyGet { id: s(id), hash: hash.clone(), offset: 0, max: 1 << 20 }) {
        R::BodyGet(r)   => r,
        other           => panic!("body_get answered {:?}", other),
    }
}

fn pend(link: &LoopLink, path: &str, before: &[u8]) -> Outcome<bool> {
    match ask(link, C::Pend { id: s("d"), path: s(path), before: BodyRef::of(before),
        deleting: false, mark: false })
    {
        R::Pend(r)  => r,
        other       => panic!("pend answered {:?}", other),
    }
}

fn body_of(n: u8, len: usize) -> Vec<u8> { (0..len).map(|i| n.wrapping_add(i as u8)).collect() }

#[test]
fn a_wrong_hash_upload_is_refused_and_leaves_nothing() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let bytes = body_of(1, 40);
    let wrong = HexHash::of(b"not these bytes");
    assert!(matches!(put(&a, "d", &bytes, &wrong, 0, 20), Ok(Put::More)), "the first chunk");
    let r = put(&a, "d", &bytes, &wrong, 20, 40);
    assert!(r.is_err(), "a wrong-hash upload was taken: {:?}", r);
    let p = probe(&srv);
    assert_eq!((p.uploads, p.staged, p.claims), (0, 0, 0), "a refused upload left {:?}", p);
}

#[test]
fn a_fifth_unnamed_upload_in_one_act_is_refused() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    for n in 0..4 {
        let r = upload(&a, "d", &body_of(n, 10), 4);
        assert!(matches!(r, Ok(Put::Done)), "upload {}: {:?}", n, r);
    }
    let r = upload(&a, "d", &body_of(9, 10), 4);
    assert!(r.is_err(), "a fifth unnamed upload was staged: {:?}", r);
    // Naming one frees its room alone.
    assert!(pend(&a, "/m/0", &body_of(0, 10)).is_ok(), "the naming call");
    assert_eq!(probe(&srv).uploads, 3, "the naming call freed what it did not name");
    assert!(matches!(upload(&a, "d", &body_of(9, 10), 4), Ok(Put::Done)), "room once named");
}

// O3
#[test]
fn two_interleaved_captures_in_one_run_are_both_served() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let (one, two) = (body_of(1, 30), body_of(2, 30));
    let (h1, h2) = (HexHash::of(&one), HexHash::of(&two));
    assert!(matches!(put_in(&a, 1, "d", &one, &h1, 0, 15), Ok(Put::More)), "one, first chunk");
    assert!(matches!(put_in(&a, 2, "d", &two, &h2, 0, 15), Ok(Put::More)), "two, first chunk");
    assert!(matches!(put_in(&a, 1, "d", &one, &h1, 15, 30), Ok(Put::Done)), "one, last chunk");
    assert!(matches!(put_in(&a, 2, "d", &two, &h2, 15, 30), Ok(Put::Done)), "two, last chunk");
    assert_eq!(pend(&a, "/m/one", &one).map_err(|e| e.to_string()), Ok(true), "the first act");
    assert_eq!(pend(&a, "/m/two", &two).map_err(|e| e.to_string()), Ok(true),
        "the second act lost its upload to the first's naming");
    assert_eq!(probe(&srv).uploads, 0, "each naming call frees what it names");
}

#[test]
fn a_named_body_resolves_from_the_upload_then_the_body_store() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let bytes = body_of(3, 50);
    assert!(pend(&a, "/m/x", &bytes).is_err(), "a body neither uploaded nor stored");
    assert!(matches!(upload(&a, "d", &bytes, 16), Ok(Put::Done)), "the upload");
    assert_eq!(pend(&a, "/m/x", &bytes).map_err(|e| e.to_string()), Ok(true), "from the upload");
    // `pend` stored it, so another call names it with no upload.
    assert_eq!(pend(&a, "/m/y", &bytes).map_err(|e| e.to_string()), Ok(true),
        "from the body store");
    assert_eq!(probe(&srv).claims, 0, "the claims are given back once named");
}

#[test]
fn a_re_upload_of_a_held_hash_answers_held_at_offset_0() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let bytes = body_of(4, 64);
    assert!(matches!(upload(&a, "d", &bytes, 64), Ok(Put::Done)), "the upload");
    assert!(matches!(upload(&a, "d", &bytes, 64), Ok(Put::Held)), "staged by this run");
    assert!(pend(&a, "/m/x", &bytes).is_ok(), "the naming call");
    let r = put(&a, "d", &bytes, &HexHash::of(&bytes), 0, 8);
    assert!(matches!(r, Ok(Put::Held)), "a held body asked again: {:?}", r);
    assert!(pend(&a, "/m/y", &bytes).is_ok(), "named once held");
}

#[test]
fn body_get_serves_only_a_hash_named_to_the_run() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let b = bind(&srv, Tag::Run, "b");
    let bytes = body_of(5, 70);
    let hash = HexHash::of(&bytes);
    assert!(matches!(upload(&a, "d", &bytes, 70), Ok(Put::Done)), "the upload");
    assert!(pend(&a, "/m/x", &bytes).is_ok(), "stored by pend");
    // Stored, but named to no run.
    assert!(get(&a, "d", &hash).is_err(), "body_get of a hash no reply named");
    match ask(&a, C::VersionsBody { id: s("d"), hash: hash.clone() }) {
        R::VersionsBody(Ok(Some(r))) => assert_eq!(r, BodyRef::of(&bytes), "the reply's ref"),
        other => panic!("versions_body answered {:?}", other),
    }
    assert!(get(&b, "d", &hash).is_err(), "another run read a body named to a");
    assert_eq!(get(&a, "d", &hash).map_err(|e| e.to_string()), Ok(bytes), "the named body");
    assert_eq!(probe(&srv).out, 0, "the last chunk frees the naming");
}

// O2
#[test]
fn a_run_probing_another_diamonds_hash_is_refused() {
    let srv = server();
    let p = bind(&srv, Tag::Parent, "p");
    let a = bind(&srv, Tag::Run, "a");
    // `e` holds a body `a` was not granted.
    let bytes = body_of(6, 33);
    let hash = HexHash::of(&bytes);
    assert!(matches!(upload(&p, "e", &bytes, 33), Ok(Put::Done)), "the parent's upload");
    let r = ask(&p, C::Pend { id: s("e"), path: s("/m/e"), before: BodyRef::of(&bytes),
        deleting: false, mark: false });
    assert!(matches!(r, R::Pend(Ok(_))), "stored in e: {:?}", r);
    let r = ask(&a, C::BodyPut { id: s("e"), act: 1, hash: hash.clone(), len: 33, offset: 0,
        chunk: bytes[..8].to_vec() });
    assert_eq!(unbound_id(&r), Some(s("e")), "body_put into e: {:?}", r);
    let r = ask(&a, C::BodyGet { id: s("e"), hash: hash.clone(), offset: 0, max: 33 });
    assert_eq!(unbound_id(&r), Some(s("e")), "body_get from e: {:?}", r);
    // Under its own Diamond, `Held` answers for d's store alone.
    let r = put(&a, "d", &bytes, &hash, 0, 8);
    assert!(matches!(r, Ok(Put::More)), "e's body answered for d: {:?}", r);
    assert!(get(&a, "d", &hash).is_err(), "e's body read through d");
}

#[test]
fn drop_run_leaves_no_staged_bytes() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    assert!(matches!(upload(&a, "d", &body_of(7, 20), 20), Ok(Put::Done)), "a whole upload");
    let part = body_of(8, 20);
    assert!(matches!(put(&a, "d", &part, &HexHash::of(&part), 0, 10), Ok(Put::More)),
        "a part upload");
    let p = probe(&srv);
    assert_eq!((p.uploads, p.staged, p.claims), (2, 30, 2), "before the drop: {:?}", p);
    dropped(&srv, "a");
    let p = probe(&srv);
    assert_eq!((p.uploads, p.staged, p.claims), (0, 0, 0), "a dropped run left {:?}", p);
}

// ── D1v3b: the d1v3 check's defects (d1v3_check.md D1-D4, O3) ────────────────────────────

fn held_change(before: Option<&[u8]>, after: &[u8]) -> WireChange {
    WireChange {
        path:    s("/m/c"),
        after:   crate::store::call::WireBody::Held(BodyRef::of(after)),
        before:  before.map(BodyRef::of),
        found:   Found::Unread,
        carried: None,
        mark:    false,
        refused: None,
        wiped:   false,
        folder:  None,
        by:      None,
        door:    false,
    }
}

/// `bytes` stored in d's body store by a `pend`, and asked again at offset 0: `Held`.
fn stored_then_held(a: &LoopLink, path: &str, bytes: &[u8]) {
    assert!(matches!(upload(a, "d", bytes, 40), Ok(Put::Done)), "the upload");
    assert!(pend(a, path, bytes).is_ok(), "pend stores it");
    let r = put(a, "d", bytes, &HexHash::of(bytes), 0, 8);
    assert!(matches!(r, Ok(Put::Held)), "a stored body answers Held: {:?}", r);
}

// Control: a `before` the run uploaded whole is captured.
#[test]
fn a_sync_capture_of_an_uploaded_before_is_served() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let (before, after) = (body_of(1, 40), body_of(2, 40));
    assert!(matches!(upload(&a, "d", &before, 40), Ok(Put::Done)));
    assert!(matches!(upload(&a, "d", &after, 40), Ok(Put::Done)));
    let r = ask(&a, C::Capture { id: s("d"), raw: s("/m/c"), change: held_change(Some(&before), &after) });
    assert!(matches!(r, R::Capture(Ok(()))), "capture: {:?}", r);
}

// D1: a body the store holds is answered `Held`, so nothing is uploaded; a sync call naming it
// is served all the same (capture, seals_spent, and every restore of a stored version).
#[test]
fn a_sync_capture_of_a_store_held_before_is_served() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let (before, after) = (body_of(1, 40), body_of(2, 40));
    stored_then_held(&a, "/m/x", &before);
    let p = probe(&srv);
    assert_eq!((p.uploads, p.staged), (1, 40), "a Held stored body is staged whole: {:?}", p);
    assert!(matches!(upload(&a, "d", &after, 40), Ok(Put::Done)));
    let r = ask(&a, C::Capture { id: s("d"), raw: s("/m/c"), change: held_change(Some(&before), &after) });
    assert!(matches!(r, R::Capture(Ok(()))), "capture of a Held before: {:?}", r);
}

#[test]
fn seals_spent_of_a_store_held_now_is_false() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let now = body_of(3, 40);
    stored_then_held(&a, "/m/x", &now);
    let r = ask(&a, C::SealsSpent { id: s("d"), path: s("/m/c"), now: BodyRef::of(&now) });
    assert!(matches!(r, R::SealsSpent(false)), "seals_spent of a Held now: {:?}", r);
}

// D2: two acts upload the same bytes; the second is answered `Held` from the first's staging;
// the first act's naming does not free it from under the second's sync call.
#[test]
fn an_upload_shared_by_two_acts_outlives_the_first_naming() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let now = body_of(4, 40);
    let hash = HexHash::of(&now);
    assert!(matches!(upload_in(&a, 1, "d", &now, 40), Ok(Put::Done)), "act 1's upload");
    assert!(matches!(put_in(&a, 2, "d", &now, &hash, 0, 40), Ok(Put::Held)), "act 2's: Held");
    let r = ask(&a, C::TurnsFound { id: s("d"), path: s("/m/one"), now: BodyRef::of(&now) });
    assert!(matches!(r, R::TurnsFound(_)), "act 1 names it: {:?}", r);
    let r = ask(&a, C::SealsSpent { id: s("d"), path: s("/m/two"), now: BodyRef::of(&now) });
    assert!(matches!(r, R::SealsSpent(false)), "act 2's seals_spent: {:?}", r);
    // Its claim is given back by a task the sync call spawns, so only the table is asserted.
    assert_eq!(probe(&srv).uploads, 0, "freed at the last naming");
}

// D1mem-a C: an upload allocates its declared length once, so a 20 MB body holds 20 MB, not the
// 32 MiB a doubling `Vec` reaches.
#[test]
fn an_upload_allocates_its_declared_length_once() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let body = body_of(7, 20_000_000);
    let hash = HexHash::of(&body);
    let n = 1 << 20;
    let first = put(&a, "d", &body, &hash, 0, n);
    assert!(matches!(first, Ok(Put::More)), "the first chunk: {:?}", first);
    let half = probe(&srv);
    let mut at = n;
    while at < body.len() {
        let end = body.len().min(at + n);
        let r = put(&a, "d", &body, &hash, at, end);
        assert!(matches!(r, Ok(Put::More) | Ok(Put::Done)), "the chunk at {}: {:?}", at, r);
        at = end;
    }
    let p = probe(&srv);
    let ok = half.capacity == body.len() && p.capacity == body.len();
    println!("D1mem-a {} upload capacity: part {} whole {} for len {}",
        if ok { "GREEN" } else { "RED" }, half.capacity, p.capacity, body.len());
    assert!(ok, "an upload of {} bytes allocated {} part way and {} whole", body.len(),
        half.capacity, p.capacity);
}

// D3/O3: an act's new upload drops its own unfinished one, so torn uploads hold no room.
#[test]
fn torn_uploads_give_back_their_room() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    for n in 0..4u8 {
        let b = body_of(10 + n, 40);
        assert!(matches!(put(&a, "d", &b, &HexHash::of(&b), 0, 10), Ok(Put::More)));
    }
    let x = body_of(20, 40);
    let r = upload(&a, "d", &x, 40);
    assert!(matches!(r, Ok(Put::Done)), "the act's room came back: {:?}", r);
    let p = probe(&srv);
    assert_eq!((p.uploads, p.staged, p.claims), (1, 40, 1), "torn uploads left {:?}", p);
    // A naming call of an act's upload drops that act's unfinished one.
    let (y, z) = (body_of(21, 40), body_of(22, 40));
    assert!(matches!(upload_in(&a, 2, "d", &y, 40), Ok(Put::Done)));
    assert!(matches!(put_in(&a, 2, "d", &z, &HexHash::of(&z), 0, 10), Ok(Put::More)));
    let r = ask(&a, C::SealsSpent { id: s("d"), path: s("/m/y"), now: BodyRef::of(&y) });
    assert!(matches!(r, R::SealsSpent(false)), "names y: {:?}", r);
    let p = probe(&srv);
    assert_eq!((p.uploads, p.staged), (1, 40), "act 2's torn upload stayed: {:?}", p);
}

/// The first chunk of a body declared `len` bytes long, in the act `act`.
fn declare(link: &LoopLink, act: u64, n: u8, len: u64) -> Outcome<Put> {
    let chunk = body_of(n, 8);
    match ask(link, C::BodyPut { id: s("d"), act, hash: HexHash::of(&chunk), len, offset: 0,
        chunk })
    {
        R::BodyPut(r)   => r,
        other           => panic!("body_put answered {:?}", other),
    }
}

// D3: staged bytes are bounded per run and per store, refused as busy.
#[test]
fn staged_bytes_are_bounded_per_run_and_per_store() {
    use crate::store::server::{STAGE_BYTES_MAX, STORE_STAGE_MAX};
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let part = (STAGE_BYTES_MAX / 4) as u64;
    for act in 1..=4 {
        assert!(matches!(declare(&a, act, act as u8, part), Ok(Put::More)), "act {}", act);
    }
    let r = declare(&a, 5, 5, 1 << 10);
    let msg = r.as_ref().err().map(|e| e.to_string()).unwrap_or_default();
    assert!(r.is_err() && msg.contains("busy"), "past the run's ceiling: {:?}", r);
    assert_eq!(probe(&srv).uploads, 4, "the refused put left nothing");
    // Over every run: the store's ceiling.
    let runs = STORE_STAGE_MAX / STAGE_BYTES_MAX;
    let links: Vec<LoopLink> = (1..runs).map(|n| bind(&srv, Tag::Run, &fmt!("r{}", n))).collect();
    for (n, l) in links.iter().enumerate() {
        assert!(matches!(declare(l, 1, 50 + n as u8, STAGE_BYTES_MAX as u64), Ok(Put::More)),
            "run {}", n);
    }
    let last = bind(&srv, Tag::Run, "z");
    let r = declare(&last, 1, 99, 1 << 10);
    let msg = r.as_ref().err().map(|e| e.to_string()).unwrap_or_default();
    assert!(r.is_err() && msg.contains("busy"), "past the store's ceiling: {:?}", r);
}

// D4: the named-out set keeps at most OUT_MAX bodies per run, the oldest evicted, and one
// fetch to the end frees an entry however often it was named.
#[test]
fn the_named_out_set_is_bounded() {
    use crate::store::server::OUT_MAX;
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let bodies: Vec<Vec<u8>> = (0..=OUT_MAX).map(|n| body_of(100 + n as u8, 24)).collect();
    for (n, b) in bodies.iter().enumerate() {
        assert!(matches!(upload(&a, "d", b, 24), Ok(Put::Done)), "upload {}", n);
        assert!(pend(&a, &fmt!("/m/o{}", n), b).is_ok(), "pend {}", n);
        match ask(&a, C::VersionsBody { id: s("d"), hash: HexHash::of(b) }) {
            R::VersionsBody(Ok(Some(_))) => (),
            other => panic!("versions_body {} answered {:?}", n, other),
        }
    }
    assert_eq!(probe(&srv).out, OUT_MAX, "the named-out set");
    assert!(get(&a, "d", &HexHash::of(&bodies[0])).is_err(), "the oldest was evicted");
    let last = &bodies[OUT_MAX];
    let _ = ask(&a, C::VersionsBody { id: s("d"), hash: HexHash::of(last) });
    assert_eq!(get(&a, "d", &HexHash::of(last)).map_err(|e| e.to_string()), Ok(last.clone()));
    assert_eq!(probe(&srv).out, OUT_MAX - 1, "named twice, one fetch frees it");
}


// ┌───────────────────────────────────────────────────────────────┐
// │ D1v2a: sync first, poison and busy (d1_plan §9.2 D1v2, §5)     │
// └───────────────────────────────────────────────────────────────┘

fn answered(link: &LoopLink, call: C) -> Outcome<R> { link.call_blocking(&call) }

fn is_down(r: &Outcome<R>) -> bool { matches!(r, Ok(R::Fault(Fault::Down(_)))) }

/// The reply to a call sent earlier, waited on for at most `secs` of the test's own clock.
fn reply_within(wait: &flume::Receiver<Vec<u8>>, secs: u64) -> Option<R> {
    match wait.recv_timeout(std::time::Duration::from_secs(secs)) {
        Ok(bytes)   => decode_reply(&bytes).ok(),
        Err(_)      => None,
    }
}

fn sent(link: &LoopLink, call: C) -> flume::Receiver<Vec<u8>> {
    match link.send(&call) {
        Ok(w)   => w,
        Err(e)  => panic!("sending store.{}: {}", call.name(), e),
    }
}

#[test]
fn a_panic_in_a_sync_call_poisons_the_store() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let b = bind(&srv, Tag::Run, "b");
    assert!(matches!(ask(&a, C::IsSteering { id: s("d") }), R::IsSteering(false)));
    assert!(srv.fuse("is_steering").is_ok());
    assert!(is_down(&answered(&a, C::IsSteering { id: s("d") })), "the call that panicked");
    assert!(is_down(&answered(&b, C::Ping {})), "a later ping");
    assert!(is_down(&answered(&b, C::IsSteering { id: s("d") })), "a later sync call");
    assert!(is_down(&answered(&a, C::HoldVersions { id: s("d") })), "a later wait call");
}

#[test]
fn a_panic_in_a_wait_call_poisons_the_store() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let b = bind(&srv, Tag::Run, "b");
    assert!(srv.fuse("read_crystal_data").is_ok());
    assert!(is_down(&answered(&a, C::ReadCrystalData { id: s("d") })), "the call that panicked");
    assert!(is_down(&answered(&b, C::Ping {})), "a later ping");
    assert!(is_down(&answered(&b, C::HoldVersions { id: s("d") })), "a later wait call");
}

/// A call 121 s long (on the paused clock) is answered `StoreBusy` at 120 s, and only it: its
/// siblings, of its own run and of others, sync and wait, are served while it runs and after.
#[test]
fn a_121_s_call_is_busy_and_its_siblings_are_served() {
    let srv = match StoreServer::start_paused(NativeBackend::Mem(MemBackend::default())) {
        Ok(s)   => s,
        Err(e)  => panic!("the store server: {}", e),
    };
    let a = bind(&srv, Tag::Run, "a");
    let b = bind(&srv, Tag::Run, "b");
    assert!(srv.stall("read_crystal_data", 121).is_ok());
    let slow = sent(&a, C::ReadCrystalData { id: s("d") });
    assert!(matches!(ask(&b, C::Ping {}), R::Ping(())));
    let held = hold(&b);
    assert!(matches!(ask(&b, C::LetGo { handle: held }), R::LetGo(())));
    match reply_within(&slow, 20) {
        Some(R::Fault(Fault::Busy(f)))  => {
            assert_eq!(f.call, "read_crystal_data");
            assert_eq!(f.secs, 120);
        }
        other => panic!("a's 121 s call: {:?}", other),
    }
    assert!(matches!(ask(&a, C::Ping {}), R::Ping(())), "the busy caller is served after");
    assert!(matches!(ask(&b, C::IsSteering { id: s("d") }), R::IsSteering(false)));
    let again = hold(&a);
    assert!(matches!(ask(&a, C::LetGo { handle: again }), R::LetGo(())), "a wait call after");
}

/// §5 D1v2: the ping is answered within 50 ms while a slow async call awaits.
#[test]
fn the_ping_is_answered_within_50_ms_while_a_slow_call_awaits() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let b = bind(&srv, Tag::Run, "b");
    let held = hold(&a);
    let parked = sent(&b, C::HoldVersions { id: s("d") });
    std::thread::sleep(std::time::Duration::from_millis(50));
    for link in [&a, &b, &a, &b, &a, &b] {
        let t = std::time::Instant::now();
        assert!(matches!(ask(link, C::Ping {}), R::Ping(())));
        assert!(t.elapsed() < std::time::Duration::from_millis(50), "ping took {:?}", t.elapsed());
    }
    assert!(parked.is_empty(), "b's hold still awaits");
    assert!(matches!(ask(&a, C::LetGo { handle: held }), R::LetGo(())));
    assert!(matches!(reply_within(&parked, 10), Some(R::HoldVersions(Ok(_)))));
}

/// The loop is biased: a sync call queued behind 200 wait calls is answered before any of them is
/// taken in.
#[test]
fn a_sync_call_is_taken_before_the_wait_calls_queued_ahead_of_it() {
    let srv = server();
    let w = bind(&srv, Tag::Run, "w");
    let c = bind(&srv, Tag::Run, "c");
    let open = match srv.gate() {
        Ok(o)   => o,
        Err(e)  => panic!("the gate: {}", e),
    };
    let waits: Vec<_> = (0..200).map(|_| sent(&w, C::ReadCrystalData { id: s("d") })).collect();
    let ping = sent(&c, C::Ping {});
    assert!(open.send(()).is_ok());
    assert!(matches!(reply_within(&ping, 10), Some(R::Ping(()))));
    for wait in waits.iter() {
        assert!(reply_within(wait, 10).is_some(), "every wait call is answered");
    }
    assert_eq!(probe(&srv).waits_at_sync, 0, "wait calls taken in before the ping");
}

// ── D1x2b: sync latency beside writers on a slow backend (d1_plan §9.2 D1x2) ─────────────

/// The time a [`NativeBackend::Slow`] holds the store's thread at each backend call.
const SLOW_HOLD: std::time::Duration = std::time::Duration::from_micros(100);

/// The `note_output`s each writer keeps in flight.
const WRITER_FLIGHT: usize = 400;

/// One run's pings, while five writers each keep [`WRITER_FLIGHT`] `note_output`s in flight on a
/// backend that holds the store's thread [`SLOW_HOLD`] at each call: the pings' latencies, sorted,
/// with `sync_first` off where `bias` is false.
fn ping_latencies(bias: bool) -> Vec<std::time::Duration> {
    use crate::store::native::SLOW_PAUSES;
    use std::{collections::VecDeque, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Instant};
    let srv = server_over(NativeBackend::Slow(MemBackend::default(), SLOW_HOLD));
    if !bias {
        if let Err(e) = srv.rule_off("sync_first") {
            panic!("rule_off: {}", e);
        }
    }
    let p = bind(&srv, Tag::Run, "p");
    let paused = SLOW_PAUSES.load(Ordering::Relaxed);
    let stop = Arc::new(AtomicBool::new(false));
    let writers: Vec<_> = (0..5).map(|w| {
        let link = bind(&srv, Tag::Run, &fmt!("w{}", w));
        let stop = stop.clone();
        std::thread::spawn(move || {
            let mut flight = VecDeque::new();
            let mut n = 0u64;
            while !stop.load(Ordering::Relaxed) {
                while flight.len() < WRITER_FLIGHT {
                    flight.push_back(sent(&link, C::NoteOutput { id: s("d"), tool: s("file_write"),
                        path: fmt!("w{}/f{}.md", w, n % 64), bytes: BodyRef::of(b"x") }));
                    n += 1;
                }
                if let Some(f) = flight.pop_front() {
                    assert!(reply_within(&f, 60).is_some(), "a note_output was answered");
                }
            }
            for f in flight {
                assert!(reply_within(&f, 60).is_some(), "a note_output was answered");
            }
            n
        })
    }).collect();
    // The writers are under way once the slow backend has paused for a full flight of theirs.
    let began = Instant::now();
    while SLOW_PAUSES.load(Ordering::Relaxed) < paused + (5 * WRITER_FLIGHT) as u64 {
        assert!(began.elapsed().as_secs() < 30, "the writers never reached the backend");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let mut took = Vec::new();
    for _ in 0..100 {
        let at = Instant::now();
        assert!(matches!(ask(&p, C::Ping {}), R::Ping(())));
        took.push(at.elapsed());
        std::thread::sleep(std::time::Duration::from_millis(3));
    }
    stop.store(true, Ordering::Relaxed);
    let mut wrote = 0u64;
    for w in writers {
        match w.join() {
            Ok(n)   => wrote += n,
            Err(_)  => panic!("a writer panicked"),
        }
    }
    assert!(SLOW_PAUSES.load(Ordering::Relaxed) >= paused + wrote,
        "every note_output reached the slow backend");
    took.sort();
    took
}

/// The 99th percentile of the sorted `took`.
fn p99(took: &[std::time::Duration]) -> std::time::Duration {
    took[(took.len() * 99).div_ceil(100) - 1]
}

/// Sync calls are answered within 50 ms at the 99th percentile while five writers keep the store
/// busy on a slow backend (d1_plan §9.2 D1x2).  Red: [`the_sync_first_bias_off_passes_50ms_at_p99`].
#[test]
fn a_sync_call_is_answered_within_50ms_at_p99_beside_five_writers_on_a_slow_backend() {
    let took = ping_latencies(true);
    let at = p99(&took);
    println!("MEASURE sync p99 {:?}, max {:?}, sync-first on", at, took[took.len() - 1]);
    assert!(at <= std::time::Duration::from_millis(50), "the sync p99 is {:?}", at);
}

/// The red control: with the loop's sync-first bias off, a ping waits behind the writers' work.
#[test]
fn the_sync_first_bias_off_passes_50ms_at_p99() {
    let took = ping_latencies(false);
    let at = p99(&took);
    println!("MEASURE sync p99 {:?}, max {:?}, sync-first off", at, took[took.len() - 1]);
    assert!(at > std::time::Duration::from_millis(50), "the unbiased sync p99 is only {:?}", at);
}

// ── D1v2b: the staged turn end, the riders, and the envelope (d1_plan §9.2, §9.10) ─────────

/// A change at `path` with both bodies, the after `Large` past the per-file ceiling.
fn change_at(path: &str, before: &[u8], after: &[u8]) -> WireChange {
    let after = if after.len() > crate::diamond_versions::VERSION_FILE_MAX {
        crate::store::call::WireBody::Large(BodyRef::of(after))
    } else {
        crate::store::call::WireBody::Held(BodyRef::of(after))
    };
    WireChange { path: s(path), after, ..held_change(Some(before), b"") }
}

/// `link`'s capture of `path`, each body it uploads first in its own act.
fn captured(link: &LoopLink, act: u64, path: &str, before: &[u8], after: &[u8]) {
    let change = change_at(path, before, after);
    for r in change.uploads() {
        let bytes = if r.names(before) { before } else { after };
        assert!(matches!(upload_in(link, act, "d", bytes, BODY_CHUNK), Ok(Put::Done | Put::Held)),
            "the upload of {}", path);
    }
    let r = ask(link, C::Capture { id: s("d"), raw: s(path), change });
    assert!(matches!(r, R::Capture(Ok(()))), "capture of {}: {:?}", path, r);
}

fn wants_of(r: R) -> crate::store::call::WantsPage {
    match r {
        R::TurnWants(Ok(p)) | R::TurnWantsPage(Ok(p)) => p,
        other => panic!("turn_wants answered {:?}", other),
    }
}

fn staged_ok(r: R) -> Outcome<()> {
    match r {
        R::TurnStanding(o) | R::TurnStands(o) | R::TurnWiped(o) => o,
        other => panic!("a staging call answered {:?}", other),
    }
}

fn after_seen(after: &[u8]) -> Seen { Seen::of(Some(after)) }

/// A staged entry outside the snapshot, or sent twice, or through two staging calls, is refused
/// (§9.2 D1v2, §9.10); a second snapshot replaces the table (§16.3 3, D1v2c).  Red: each rule
/// removed in turn.
#[test]
fn a_staged_entry_outside_wants_or_sent_twice_is_refused() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let (before, after) = (body_of(1, 40), body_of(2, 40));
    captured(&a, 1, "notes/c.md", &before, &after);
    let page = wants_of(ask(&a, C::TurnWants { id: s("d") }));
    assert_eq!(page.wants.own, vec![(s("notes/c.md"), after_seen(&after))], "the snapshot");
    let standing = |path: &str, seen: Seen| C::TurnStanding { id: s("d"), path: s(path), seen,
        standing: crate::store::call::WireStanding::Unknown, stamp: None };
    assert!(staged_ok(ask(&a, standing("notes/x.md", Seen::Unread))).is_err(), "an invented path");
    assert!(staged_ok(ask(&a, standing("notes/c.md", after_seen(&before)))).is_err(),
        "a stale seen");
    assert!(staged_ok(ask(&a, standing("notes/c.md", Seen::Unread))).is_err(),
        "a capture's path sent as a note's");
    let stands = || C::TurnStands { id: s("d"), stands: vec![(s("notes/c.md"), after_seen(&after))] };
    assert!(staged_ok(ask(&a, stands())).is_ok(), "the capture stands");
    assert!(staged_ok(ask(&a, stands())).is_err(), "sent twice");
    assert!(staged_ok(ask(&a, standing("notes/c.md", after_seen(&after)))).is_err(),
        "through a second staging call");
    let _ = wants_of(ask(&a, C::TurnWants { id: s("d") }));
    assert!(staged_ok(ask(&a, stands())).is_ok(), "the second snapshot's own reading");
}

/// One turn of `link` recorded: a capture of `path` that stands, drained and recorded.
fn record_turn(link: &LoopLink, act: u64, path: &str, before: &[u8], after: &[u8])
    -> crate::store::call::Recorded
{
    record_turn_of(link, act, path, before, after, &[])
}

/// [`record_turn`] of a turn that captured `earlier` already, `(path, after)` each.
fn record_turn_of(link: &LoopLink, act: u64, path: &str, before: &[u8], after: &[u8],
    earlier: &[(&str, &[u8])])
    -> crate::store::call::Recorded
{
    captured(link, act, path, before, after);
    let _ = wants_of(ask(link, C::TurnWants { id: s("d") }));
    let mut stands: Vec<(String, Seen)> = earlier.iter().map(|(p, a)| (s(p), after_seen(a)))
        .collect();
    stands.push((s(path), after_seen(after)));
    let r = ask(link, C::TurnStands { id: s("d"), stands });
    assert!(staged_ok(r).is_ok(), "stands");
    let h = hold(link);
    assert_eq!(drained(link, h) as usize, 1 + earlier.len(), "the captures drained");
    let r = ask(link, C::VersionsRecordHeld { hold: h, id: s("d"), at: None,
        cause: crate::diamond_versions::Cause::Turn, turn: s("t"),
        note: crate::store::call::WireText::Words(s("")) });
    let rec = match r {
        R::VersionsRecordHeld(Ok(Some(rec))) => rec,
        other => panic!("versions_record_held answered {:?}", other),
    };
    let _ = ask(link, C::DrainWindows { hold: h, id: s("d") });
    assert!(matches!(ask(link, C::LetGo { handle: h }), R::LetGo(())));
    rec
}

fn names_of(link: &LoopLink, version: u64) -> Outcome<Vec<String>> {
    match ask(link, C::RecordedNames { id: s("d"), version, after: None }) {
        R::RecordedNames(r) => r,
        other               => panic!("recorded_names answered {:?}", other),
    }
}

/// D1v1c riders: a recorded turn ends its run's count of deletes, and the table keeps only the
/// latest version's names per id.  Red: no clear after the record; every version kept.
#[test]
fn a_record_ends_the_runs_deletes_and_keeps_the_latest_names() {
    let srv = server_with_d();
    let a = bind(&srv, Tag::Run, "a");
    assert_eq!(deletes(&a, "gone.md"), OpenDelete::Go(true));
    assert_eq!(probe(&srv).deletes, 1);
    let first = record_turn(&a, 1, "notes/c.md", &body_of(1, 40), &body_of(2, 40));
    assert_eq!(probe(&srv).deletes, 0, "the recorded turn's deletes are counted no longer");
    assert!(names_of(&a, first.version).is_ok(), "the latest version's names");
    let second = record_turn(&a, 2, "notes/c.md", &body_of(2, 40), &body_of(3, 40));
    assert!(second.version > first.version);
    assert!(names_of(&a, second.version).is_ok(), "the latest version's names");
    assert!(names_of(&a, first.version).is_err(), "an older version's names are not kept");
}

/// `call` through `link`, its frame and its reply's measured.
fn framed(link: &LoopLink, call: C, max: &mut usize) -> R {
    match encode_call(&call) {
        Ok(f)   => *max = (*max).max(f.len()),
        Err(e)  => panic!("store.{} would not frame: {}", call.name(), e),
    }
    let wait = match link.send(&call) {
        Ok(w)   => w,
        Err(e)  => panic!("store.{}: {}", call.name(), e),
    };
    let bytes = match wait.recv() {
        Ok(b)   => b,
        Err(_)  => panic!("store.{} had no answer", call.name()),
    };
    *max = (*max).max(bytes.len());
    match decode_reply(&bytes) {
        Ok(r)   => r,
        Err(e)  => panic!("store.{}'s reply ({} bytes): {}", call.name(), bytes.len(), e),
    }
}

/// The envelope (§9.10 D1v2): 64 captures, each a 512 KiB `after` over a 512 KiB `before`,
/// three of the `after`s over 512 KiB and one `before` a 20 MB edit copy, end their turn and are
/// recorded through `LoopLink` with every frame at most `FRAME_MAX`.
#[test]
fn the_envelope_turn_ends_and_records_within_the_frame() {
    use crate::diamond_versions::VERSION_FILE_MAX as K512;
    let srv = server_with_d();
    let a = bind(&srv, Tag::Run, "a");
    let mut max = 0usize;
    let mut stands: Vec<(String, Seen)> = Vec::new();
    for i in 0..64u64 {
        let path = fmt!("notes/f{:02}.md", i);
        let before = if i == 63 { body_of(i as u8, 20 * 1000 * 1000) } else { body_of(i as u8, K512) };
        let after = if i < 3 { body_of(200 + i as u8, K512 + 4096) } else { body_of(100 + i as u8, K512) };
        let change = change_at(&path, &before, &after);
        for r in change.uploads() {
            let bytes: &[u8] = if r.names(&before) { &before } else { &after };
            let hash = HexHash::of(bytes);
            let mut at = 0;
            while at < bytes.len() {
                let end = bytes.len().min(at + BODY_CHUNK);
                let r = framed(&a, C::BodyPut { id: s("d"), act: i + 1, hash: hash.clone(),
                    len: bytes.len() as u64, offset: at as u64, chunk: bytes[at..end].to_vec() },
                    &mut max);
                assert!(matches!(r, R::BodyPut(Ok(_))), "body_put of {}: {:?}", path, r);
                at = end;
            }
        }
        let r = framed(&a, C::Capture { id: s("d"), raw: path.clone(), change }, &mut max);
        assert!(matches!(r, R::Capture(Ok(()))), "capture of {}: {:?}", path, r);
        stands.push((path, after_seen(&after)));
    }
    // The snapshot, page by page.
    let mut own: Vec<(String, Seen)> = Vec::new();
    let mut page = match framed(&a, C::TurnWants { id: s("d") }, &mut max) {
        R::TurnWants(Ok(p)) => p,
        other               => panic!("turn_wants answered {:?}", other),
    };
    let mut n = 0;
    loop {
        own.extend(page.wants.own.iter().cloned());
        if !page.more {
            break;
        }
        n += 1;
        page = match framed(&a, C::TurnWantsPage { id: s("d"), n }, &mut max) {
            R::TurnWantsPage(Ok(p)) => p,
            other                   => panic!("turn_wants_page answered {:?}", other),
        };
    }
    own.sort_by(|x, y| x.0.cmp(&y.0));
    stands.sort_by(|x, y| x.0.cmp(&y.0));
    assert_eq!(own, stands, "every capture wanted");
    for chunk in stands.chunks(LIST_PAGE) {
        let r = framed(&a, C::TurnStands { id: s("d"), stands: chunk.to_vec() }, &mut max);
        assert!(matches!(r, R::TurnStands(Ok(()))), "turn_stands: {:?}", r);
    }
    let h = match framed(&a, C::HoldVersions { id: s("d") }, &mut max) {
        R::HoldVersions(Ok(h))  => h,
        other                   => panic!("hold_versions answered {:?}", other),
    };
    let r = framed(&a, C::DrainTurn { hold: h, id: s("d") }, &mut max);
    assert!(matches!(&r, R::DrainTurn(Ok(d)) if d.captured == 64), "drain_turn: {:?}", r);
    let r = framed(&a, C::VersionsRecordHeld { hold: h, id: s("d"), at: None,
        cause: crate::diamond_versions::Cause::Turn, turn: s("t"),
        note: crate::store::call::WireText::Words(s("")) }, &mut max);
    match r {
        R::VersionsRecordHeld(Ok(Some(rec))) => assert_eq!(rec.count, 64, "every capture a row"),
        other => panic!("versions_record_held answered {:?}", other),
    }
    assert!(max <= FRAME_MAX, "a frame of {} bytes", max);
    assert!(max > BODY_CHUNK, "the chunks were whole");
}

// ── The d1v2 check's probes, the D1v2c reds (P1-P5, P7; P6 passed already) ─────────

fn chk_stop(link: &LoopLink, file: &str) {
    let ticket = match deletes(link, file) {
        OpenDelete::Ask(_, t) => t,
        other => panic!("CHK not asked: {:?}", other),
    };
    assert!(matches!(ask(link, C::OpenDeleteAnswer { id: s("d"), ticket, allow: false }),
        R::OpenDeleteAnswer(())));
    assert!(matches!(deletes(link, file), OpenDelete::Stopped(_)), "CHK stopped");
}

#[test]
fn chk_p1_a_conductors_drain_turn_lifts_a_workers_stop() {
    let srv = server();
    let w = bind(&srv, Tag::Run, "w");
    let c = bind(&srv, Tag::Run, "c");
    let limit = crate::diamond_versions::OPEN_DELETES_ASK_DEFAULT;
    for n in 0..limit {
        assert_eq!(deletes(&w, &fmt!("f{}", n)), OpenDelete::Go(true));
    }
    chk_stop(&w, "over");
    let h = hold(&c);
    assert_eq!(drained(&c, h), 0);
    let got = deletes(&w, "over");
    assert!(matches!(got, OpenDelete::Stopped(_)),
        "CHK P1 the worker's stop after the conductor's drain_turn: {:?}", got);
}

// P2 and P3 as D1v2c rules: each run counts its own limit, so the worker is asked at its own.
#[test]
fn chk_p2_end_turn_counts_lifts_a_stop_given_a_worker_with_no_count() {
    let srv = server();
    let w = bind(&srv, Tag::Run, "w");
    let c = bind(&srv, Tag::Run, "c");
    let limit = crate::diamond_versions::OPEN_DELETES_ASK_DEFAULT;
    for n in 0..limit {
        assert_eq!(deletes(&c, &fmt!("c{}", n)), OpenDelete::Go(true));
    }
    for n in 0..limit {
        assert_eq!(deletes(&w, &fmt!("f{}", n)), OpenDelete::Go(true), "the worker's own count");
    }
    chk_stop(&w, "over");
    assert!(matches!(ask(&c, C::EndTurnCounts { id: s("d") }), R::EndTurnCounts(())));
    let got = deletes(&w, "over");
    assert!(matches!(got, OpenDelete::Stopped(_)),
        "CHK P2 the worker's stop after the conductor's end_turn_counts: {:?}", got);
    assert_eq!(deletes(&c, "c0"), OpenDelete::Go(true), "the conductor's next turn counts afresh");
}

#[test]
fn chk_p3_a_workers_go_on_carries_into_the_conductors_next_turn() {
    let srv = server();
    let w = bind(&srv, Tag::Run, "w");
    let c = bind(&srv, Tag::Run, "c");
    let limit = crate::diamond_versions::OPEN_DELETES_ASK_DEFAULT;
    assert_eq!(deletes(&c, "c0"), OpenDelete::Go(true));
    for n in 0..limit {
        assert_eq!(deletes(&w, &fmt!("f{}", n)), OpenDelete::Go(true));
    }
    let ticket = match deletes(&w, "over") {
        OpenDelete::Ask(_, t) => t,
        other => panic!("CHK not asked: {:?}", other),
    };
    assert!(matches!(ask(&w, C::OpenDeleteAnswer { id: s("d"), ticket, allow: true }),
        R::OpenDeleteAnswer(())));
    assert_eq!(deletes(&w, "over"), OpenDelete::Go(true));
    assert!(matches!(ask(&c, C::EndTurnCounts { id: s("d") }), R::EndTurnCounts(())));
    // The conductor's NEXT turn, to its own limit and past it:
    for n in 0..limit {
        assert_eq!(deletes(&c, &fmt!("n{}", n)), OpenDelete::Go(true), "the conductor's {}", n);
    }
    let got = deletes(&c, "past");
    assert!(matches!(got, OpenDelete::Ask(..)),
        "CHK P3 the conductor's next turn past the limit, never asked: {:?}", got);
}

#[test]
fn chk_p4_a_staged_entry_outlives_a_turn_end_that_never_drained_windows() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let (before, after) = (body_of(1, 40), body_of(2, 40));
    captured(&a, 1, "notes/c.md", &before, &after);
    let _ = wants_of(ask(&a, C::TurnWants { id: s("d") }));
    // turn 1: the child finds c as the turn left it
    assert!(staged_ok(ask(&a, C::TurnStands { id: s("d"),
        stands: vec![(s("notes/c.md"), after_seen(&after))] })).is_ok());
    // turn 1's end goes no further (drain refused / busy / abandoned); its counts end
    assert!(matches!(ask(&a, C::EndTurnCounts { id: s("d") }), R::EndTurnCounts(())));
    // turn 2: the person has edited c since; the child reads it again and says so
    let _ = wants_of(ask(&a, C::TurnWants { id: s("d") }));
    let r = staged_ok(ask(&a, C::TurnStanding { id: s("d"), path: s("notes/c.md"),
        seen: after_seen(&after), standing: crate::store::call::WireStanding::Unknown,
        stamp: None }));
    assert!(r.is_ok(), "CHK P4 turn 2's fresh reading refused, turn 1's 'stands' kept: {:?}", r);
}

#[test]
fn chk_p5_a_wait_call_in_flight_at_a_poison_is_not_answered_down() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let b = bind(&srv, Tag::Run, "b");
    assert!(srv.stall("hold_versions", 2).is_ok());
    let slow = sent(&a, C::HoldVersions { id: s("d") });
    std::thread::sleep(std::time::Duration::from_millis(100));
    assert!(srv.fuse("is_steering").is_ok());
    assert!(is_down(&answered(&b, C::IsSteering { id: s("d") })), "CHK the poison");
    let r = reply_within(&slow, 20);
    assert!(matches!(r, Some(R::Fault(Fault::Down(_)))),
        "CHK P5 a wait call in flight at the poison answered after it: {:?}", r);
}

#[test]
fn chk_p6_an_empty_reply_frame_is_an_error_not_an_empty_answer() {
    assert!(decode_reply(&[]).is_err(), "CHK P6 an empty frame decoded");
}

#[test]
fn chk_p7_a_stands_page_refused_whole_is_taken_in_part() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let (before, after) = (body_of(1, 40), body_of(2, 40));
    captured(&a, 1, "notes/c.md", &before, &after);
    let _ = wants_of(ask(&a, C::TurnWants { id: s("d") }));
    let r = staged_ok(ask(&a, C::TurnStands { id: s("d"), stands: vec![
        (s("notes/c.md"), after_seen(&after)), (s("notes/x.md"), after_seen(&after))] }));
    assert!(r.is_err(), "CHK the page with an invented path");
    let again = staged_ok(ask(&a, C::TurnStands { id: s("d"),
        stands: vec![(s("notes/c.md"), after_seen(&after))] }));
    assert!(again.is_ok(), "CHK P7 the refused page's valid entry was taken: {:?}", again);
}

// ── D1mem fix B: the turn's ledger by hash ───────────────────────────────────────────────

/// A body a capture named is in the body store from its upload on, so a second name for it, in
/// another act, is answered `Held` and never uploaded again.  Red: `More`, the client re-uploads.
#[test]
fn a_second_name_for_a_captured_body_is_answered_held() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let (before, after) = (body_of(31, 4000), body_of(32, 40));
    captured(&a, 1, "notes/one.md", &before, &after);
    assert_eq!(probe(&srv).uploads, 0, "the naming freed the uploads");
    let r = put_in(&a, 2, "d", &before, &HexHash::of(&before), 0, 64);
    assert!(matches!(r, Ok(Put::Held)), "the second name of a captured before: {:?}", r);
}

/// A captured 20 MB edit leaves the ledger holding hashes, not bytes; the turn recorded from it
/// names the bytes it found, byte for byte.  Red: the ledger held the whole `before` (~20 MB).
#[test]
fn a_captured_20mb_edit_holds_no_bytes_in_the_ledger() {
    let srv = server_with_d();
    let a = bind(&srv, Tag::Run, "a");
    let before = body_of(41, 20 << 20);
    let after = body_of(42, 20 << 20);
    let (small_before, small_after) = (body_of(43, 300_000), body_of(44, 400_000));
    captured(&a, 1, "notes/small.md", &small_before, &small_after);
    let rec = record_turn_of(&a, 2, "notes/big.md", &before, &after,
        &[("notes/small.md", &small_after)]);
    assert_eq!(rec.count, 2, "both captures recorded");
    // Every body the record names reads back as the bytes captured.
    for (what, bytes) in [("before", &before), ("small before", &small_before),
        ("small after", &small_after)]
    {
        let hash = HexHash::of(bytes);
        match ask(&a, C::VersionsBody { id: s("d"), hash: hash.clone() }) {
            R::VersionsBody(Ok(Some(r))) => assert_eq!(r, BodyRef::of(bytes), "{}'s ref", what),
            other => panic!("versions_body of the {} answered {:?}", what, other),
        }
        let mut got = Vec::new();
        while got.len() < bytes.len() {
            match ask(&a, C::BodyGet { id: s("d"), hash: hash.clone(), offset: got.len() as u64,
                max: 1 << 20 })
            {
                R::BodyGet(Ok(b)) if !b.is_empty() => got.extend(b),
                other => panic!("body_get of the {} answered {:?}", what, other),
            }
        }
        assert!(got == **bytes, "the recorded {} is not the bytes captured", what);
    }
}

/// The ledger's live bytes, at the point the brief measures: after a 20 MB edit is captured and
/// before the turn ends.
#[test]
fn a_captured_20mb_edit_leaves_the_ledger_under_1_mib() {
    let srv = server();
    let a = bind(&srv, Tag::Run, "a");
    let before = body_of(51, 20 << 20);
    let after = body_of(52, 20 << 20);
    captured(&a, 1, "notes/small.md", &body_of(53, 300_000), &body_of(54, 400_000));
    captured(&a, 2, "notes/big.md", &before, &after);
    let p = probe(&srv);
    assert!(p.ledger <= 1 << 20, "the ledger holds {} bytes after a 20 MB edit", p.ledger);
}

/// A file rewritten N times in one turn leaves one body of those rewrites once the turn is
/// recorded: each whole upload is put down at its `Done` (D1mem fix B), and the record takes back
/// those it newly put down that no version names.  Red: all N kept, never swept (KEEP-ALL).
#[test]
fn n_rewrites_of_one_file_in_a_turn_leave_one_body() {
    let srv = server_with_d();
    let a = bind(&srv, Tag::Run, "a");
    let first = body_of(70, 5000);
    let afters: Vec<Vec<u8>> = (71..76u8).map(|n| body_of(n, 5000)).collect();
    let mut was = first.clone();
    for (i, after) in afters.iter().enumerate().take(afters.len() - 1) {
        captured(&a, 1 + i as u64, "notes/big.md", &was, after);
        was = after.clone();
    }
    let last = &afters[afters.len() - 1];
    let rec = record_turn(&a, afters.len() as u64, "notes/big.md", &was, last);
    assert_eq!(rec.count, 1, "the one file recorded");
    let held = |bytes: &[u8]| match ask(&a, C::VersionsBody { id: s("d"), hash: HexHash::of(bytes) }) {
        R::VersionsBody(Ok(r)) => r.is_some(),
        other => panic!("versions_body answered {:?}", other),
    };
    assert!(held(&first), "the turn's first copy is kept");
    assert!(held(last), "the body the record names is kept");
    let kept = afters[..afters.len() - 1].iter().filter(|b| held(b)).count();
    assert_eq!(kept, 0, "{} of the {} superseded rewrites' bodies are kept", kept, afters.len() - 1);
}

#[path = "server_measure.rs"]
mod measure;

const HL5B_STATE: &str = "diamonds/d/STATE.md";

/// A current-thread runtime, or the test's panic.
fn hl5b_rt() -> tokio::runtime::Runtime {
    match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt)  => rt,
        Err(e)  => panic!("a runtime: {}", e),
    }
}

/// HL5b (c), run on one thread over a slow store, with `file:<STATE.md>` held by the test: whether
/// the held op waited for that lock (it takes `file:<key>`); then whether a plain write (the
/// fold's) landed before the lock was let go, and what stood once it had.
fn hl5b_c_run() -> (bool, bool, Option<Vec<u8>>) {
    let rt = hl5b_rt();
    let local = tokio::task::LocalSet::new();
    let mem = MemBackend::default();
    let prev = install(NativeBackend::Slow(mem.clone(), std::time::Duration::from_millis(1)));
    let out = local.block_on(&rt, async {
        let hold = || async {
            match crate::store::native::installed().hold_file(HL5B_STATE).await {
                Ok(Some(l)) => l,
                other       => panic!("holding the file's lock: {:?}", other.map(|o| o.is_some())),
            }
        };
        let stands = || mem.files().get(HL5B_STATE).cloned();
        if let Err(e) = own::write_file(HL5B_STATE, b"old").await {
            panic!("seeding: {}", e);
        }
        let body = BodyRef::of(b"the child's write");
        let mut found = BTreeMap::new();
        found.insert(body.hash.clone(), Rc::new(b"the child's write".to_vec()));
        let bs = Bodies { id: Some(s("d")), refs: vec![body.clone()], found };
        let held = hold().await;
        let op = tokio::task::spawn_local(async move {
            store_write_then(&bs, "d", FileRoot::Opfs, HL5B_STATE, &body, None, &[],
                &Answered::default(), Lax::default()).await
        });
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        let waited = !op.is_finished() && stands().as_deref() == Some(&b"old"[..]);
        drop(held);
        match op.await {
            Ok(Ok(None))    => (),
            other           => panic!("the held op: {:?}", other.map(|r| r.map_err(|e| fmt!("{}", e)))),
        }
        assert_eq!(stands().as_deref(), Some(&b"the child's write"[..]), "the held op wrote nothing");
        let held = hold().await;
        let fold = tokio::task::spawn_local(own::write_file(HL5B_STATE, b"the fold's write"));
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        let early = stands().as_deref() == Some(&b"the fold's write"[..]);
        drop(held);
        match fold.await {
            Ok(Ok(()))  => (),
            other       => panic!("the fold's write: {:?}", other.map(|r| r.map_err(|e| fmt!("{}", e)))),
        }
        (waited, early, stands())
    });
    let _ = install(prev);
    out
}

/// HL5b (c): a concurrent plain write -- the fold's, `AbsorbFoldNotes` -- meets the lock the
/// held op takes, waits for it and does not interleave.  Red: the lock on `write_file_if` only
/// (`plain_lock` off), the plain write lands while the lock is held.
#[test]
fn hl5b_c_a_plain_write_waits_on_the_held_files_lock() {
    let (seen, early, end) = hl5b_c_run();
    assert!(seen, "the held op did not wait on file:<STATE.md>");
    assert!(!early, "the plain write landed while the file's lock was held");
    assert_eq!(end.as_deref(), Some(&b"the fold's write"[..]), "the plain write never landed");
    crate::store::diamond::switch_off(Some("plain_lock"));
    let (_, early, _) = hl5b_c_run();
    crate::store::diamond::switch_off(None);
    assert!(early, "red: with plain_lock off the plain write still waited");
    eprintln!("RED HL5b (c): plain_lock off, the plain write landed under the held lock");
}

/// HL5b (d), one run: a StoreWriteThen stalled 121 s is answered Busy at 120 s; what stands at
/// STATE.md once the stalled op has had time to finish.
fn hl5b_d_run(red: bool) -> Option<Vec<u8>> {
    let mem = MemBackend::default();
    if let Err(e) = hl5b_rt().block_on(crate::store::StoreBackend::write_file(&mem, HL5B_STATE, b"# State\nstands\n")) {
        panic!("seeding: {}", e);
    }
    let srv = match StoreServer::start_paused(NativeBackend::Mem(mem.clone())) {
        Ok(s)   => s,
        Err(e)  => panic!("the store server: {}", e),
    };
    if red {
        assert!(srv.rule_off("commit_guard").is_ok());
    }
    let a = bind(&srv, Tag::Run, "a");
    assert!(srv.stall("store_write_then", 121).is_ok());
    let slow = sent(&a, C::StoreWriteThen { id: s("d"), root: FileRoot::Opfs, path: s(HL5B_STATE),
        body: BodyRef::of(b""), expect: None, archive: Vec::new() });
    match reply_within(&slow, 20) {
        Some(R::Fault(Fault::Busy(f)))  => assert_eq!(f.call, "store_write_then"),
        other                           => panic!("the 121 s held write: {:?}", other),
    }
    let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while std::time::Instant::now() < until
        && mem.files().get(HL5B_STATE).map(|b| b.is_empty()) != Some(true)
    {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    srv.stop();
    mem.files().get(HL5B_STATE).cloned()
}

/// HL5b (d): a StoreWriteThen held past `BUSY_SECS` answers Busy and does not commit.  Red: the
/// commit guard off (`commit_guard`), the busy-answered write still lands.
#[test]
fn hl5b_d_a_held_write_past_busy_secs_is_busy_and_commits_nothing() {
    assert_eq!(hl5b_d_run(false).as_deref(), Some(&b"# State\nstands\n"[..]),
        "a write answered busy still committed");
    assert_eq!(hl5b_d_run(true).as_deref(), Some(&b""[..]),
        "red: with commit_guard off the busy write still did not commit");
    eprintln!("RED HL5b (d): commit_guard off, the busy-answered write committed");
}

const QA1_FROM: &str = "diamonds/d/notes/a.md";
const QA1_TO: &str = "diamonds/d/notes/b.md";

/// QA1 F1 (`StoreFileAct`), one run: a delete of QA1_FROM, or its move to QA1_TO, meets the
/// lock it needs held by the test, and its caller is answered Busy while it waits.  Answers
/// whether it waited and was refused, and what stands at both names after.
fn qa1_act_run(mv: bool) -> (bool, Option<Vec<u8>>, Option<Vec<u8>>) {
    let rt = hl5b_rt();
    let local = tokio::task::LocalSet::new();
    let mem = MemBackend::default();
    let prev = install(NativeBackend::Slow(mem.clone(), std::time::Duration::from_millis(1)));
    let out = local.block_on(&rt, async {
        if let Err(e) = own::write_file(QA1_FROM, b"kept").await {
            panic!("seeding: {}", e);
        }
        let locked = if mv { QA1_TO } else { QA1_FROM };
        let held = match crate::store::native::installed().hold_file(locked).await {
            Ok(Some(l)) => l,
            other       => panic!("holding the file's lock: {:?}", other.map(|o| o.is_some())),
        };
        let answered = Answered::default();
        let act = if mv { FileAct::Move(s(QA1_TO)) } else { FileAct::Delete };
        let op = {
            let answered = answered.clone();
            tokio::task::spawn_local(async move {
                store_file_act("d", FileRoot::Opfs, QA1_FROM, &act, &answered, Lax::default()).await
            })
        };
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        let waited = !op.is_finished();
        // The Busy arm fires while the act waits on the lock.
        answered.set();
        drop(held);
        let refused = matches!(op.await, Ok(Err(_)));
        (waited && refused, mem.files().get(QA1_FROM).cloned(), mem.files().get(QA1_TO).cloned())
    });
    let _ = install(prev);
    out
}

/// QA1 F1: `StoreFileAct` decides its commit under each lock, just before each change, so a
/// delete or a move answered Busy while it waited on a lock changes nothing.  Red before the
/// fix: the check stood before the lock waits, so the delete removed the file and the move
/// landed its copy and removed the source after the caller was told Busy.
#[test]
fn qa1_f1_a_file_act_answered_busy_under_its_lock_changes_nothing() {
    let (refused, from, to) = qa1_act_run(false);
    assert_eq!(from.as_deref(), Some(&b"kept"[..]), "a delete answered busy removed the file");
    assert!(refused, "the delete did not wait on the lock and come back refused");
    let (refused, from, to2) = qa1_act_run(true);
    assert_eq!(to2, None, "a move answered busy landed its copy");
    assert_eq!(from.as_deref(), Some(&b"kept"[..]), "a move answered busy removed its source");
    assert!(refused, "the move did not wait on the lock and come back refused");
    assert_eq!(to, None);
}

const HL5C_CRYSTAL: &str = "diamonds/d/crystal.json";
const HL5C_TURNS: usize = 8;

/// One turn of the task set, yielded as the slow store's pause yields (woken at once, not
/// deferred as `yield_now` is), so the two tasks step in lock-step.
async fn hl5c_turn() {
    let mut yielded = false;
    std::future::poll_fn(|cx| {
        if yielded {
            std::task::Poll::Ready(())
        } else {
            yielded = true;
            cx.waker().wake_by_ref();
            std::task::Poll::Pending
        }
    }).await
}

/// HL5c (i), one run: the child's held write of the crystal (`store_write_then`, bound to "old")
/// and a store write of it (`write_file_if`, bound to "old") started `turns` turns of the task set
/// after it; each's answer and what stands after.
fn hl5c_i_run(red: bool, turns: usize) -> (Option<Seen>, Option<Seen>, Option<Vec<u8>>) {
    let rt = hl5b_rt();
    let local = tokio::task::LocalSet::new();
    let mem = MemBackend::default();
    let prev = install(NativeBackend::Slow(mem.clone(), std::time::Duration::from_millis(1)));
    if red {
        crate::store::diamond::switch_off(Some("held_lock"));
    }
    let out = local.block_on(&rt, async {
        if let Err(e) = own::write_file(HL5C_CRYSTAL, b"old").await {
            panic!("seeding: {}", e);
        }
        let body = BodyRef::of(b"the child's crystal");
        let mut found = BTreeMap::new();
        found.insert(body.hash.clone(), Rc::new(b"the child's crystal".to_vec()));
        let bs = Bodies { id: Some(s("d")), refs: vec![body.clone()], found };
        let old = Seen::of(Some(b"old"));
        let want = old.clone();
        let child = tokio::task::spawn_local(async move {
            store_write_then(&bs, "d", FileRoot::Workspace, HL5C_CRYSTAL, &body, Some(&want), &[],
                &Answered::default(), Lax::default()).await
        });
        // The store write as a task of the set beside the child, `turns` turns behind it: at
        // some count it comes between the child's compare and its bytes.
        let other = tokio::task::spawn_local(async move {
            for _ in 0..turns {
                hl5c_turn().await;
            }
            own::write_file_if(HL5C_CRYSTAL, b"the person's crystal", Some(&old)).await
        });
        let b = match other.await {
            Ok(Ok(r))   => r,
            other       => panic!("the store write: {:?}", other.map(|r| r.map_err(|e| fmt!("{}", e)))),
        };
        let a = match child.await {
            Ok(Ok(r))   => r,
            other       => panic!("the child's write: {:?}", other.map(|r| r.map_err(|e| fmt!("{}", e)))),
        };
        (a, b, mem.files().get(HL5C_CRYSTAL).cloned())
    });
    crate::store::diamond::switch_off(None);
    let _ = install(prev);
    out
}

/// HL5c (i): a store write racing the child's held write of its crystal: exactly one lands, the
/// other is refused with the winner's bytes as found, and nothing stands half-written.  Red:
/// `held_lock` off, both read "old" and both land, the first lost.
#[test]
fn hl5c_i_a_store_write_racing_the_childs_held_crystal_write_is_refused() {
    let child = b"the child's crystal".to_vec();
    let theirs = b"the person's crystal".to_vec();
    for turns in 0..HL5C_TURNS {
        let (a, b, end) = hl5c_i_run(false, turns);
        match (&a, &b) {
            (None, Some(f)) => {
                assert_eq!(f, &Seen::of(Some(child.as_slice())), "{}: the store write found {:?}",
                    turns, f);
                assert_eq!(end.as_ref(), Some(&child), "{}: the child won, yet stands {:?}", turns,
                    end);
            },
            (Some(f), None) => {
                assert_eq!(f, &Seen::of(Some(theirs.as_slice())), "{}: the child's write found \
                    {:?}", turns, f);
                assert_eq!(end.as_ref(), Some(&theirs), "{}: the store won, yet stands {:?}", turns,
                    end);
            },
            _ => panic!("{}: not exactly one landed: child {:?}, store {:?}, end {:?}", turns, a, b,
                end),
        }
    }
    let lost = (0..HL5C_TURNS).any(|turns| {
        let (a, b, _) = hl5c_i_run(true, turns);
        a.is_none() && b.is_none()
    });
    assert!(lost, "red: with held_lock off no interleaving landed both writes");
    eprintln!("RED HL5c (i): held_lock off, both writes landed over \"old\" (a lost update)");
}

/// QA1 F1 (a), one run: a StoreWriteThen of an empty body to STATE.md stalls 130 s at its commit
/// point, so the 120 s Busy timer fires once it has begun to commit.  Answers its reply, and
/// whether its write landed.
fn qa1_a_run(red: bool) -> (Option<R>, bool) {
    let mem = MemBackend::default();
    if let Err(e) = hl5b_rt().block_on(crate::store::StoreBackend::write_file(&mem, HL5B_STATE, b"# State\nstands\n")) {
        panic!("seeding: {}", e);
    }
    let srv = match StoreServer::start_paused(NativeBackend::Mem(mem.clone())) {
        Ok(s)   => s,
        Err(e)  => panic!("the store server: {}", e),
    };
    if red {
        assert!(srv.rule_off("busy_decides").is_ok());
    }
    let a = bind(&srv, Tag::Run, "a");
    assert!(srv.stall("store_write_then.commit", 130).is_ok());
    let slow = sent(&a, C::StoreWriteThen { id: s("d"), root: FileRoot::Opfs, path: s(HL5B_STATE),
        body: BodyRef::of(b""), expect: None, archive: Vec::new() });
    let reply = reply_within(&slow, 20);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while std::time::Instant::now() < until
        && mem.files().get(HL5B_STATE).map(|b| b.is_empty()) != Some(true)
    {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    srv.stop();
    (reply, mem.files().get(HL5B_STATE).map(|b| b.is_empty()) == Some(true))
}

/// QA1 F1 (a): the store decides Busy once, and only for a call that has not begun to commit; a
/// write past its commit point when the timer fires is waited for and answered with what it did.
/// Red: `busy_decides` off, Busy is answered while the write still lands.
#[test]
fn qa1_a_a_write_past_its_commit_point_is_answered_with_what_it_did() {
    let (reply, landed) = qa1_a_run(false);
    assert!(matches!(reply, Some(R::StoreWriteThen(Ok(None)))),
        "a write past its commit point was not answered with what it did: {:?}", reply);
    assert!(landed, "the committed write did not land");
    let (reply, landed) = qa1_a_run(true);
    assert!(matches!(reply, Some(R::Fault(Fault::Busy(_)))) && landed,
        "red: with busy_decides off the committing write was not answered busy and landed: {:?}",
        reply);
    eprintln!("RED QA1 (a): busy_decides off, Busy answered while the write landed");
}

/// QA1 F3: `own::delete_entry` removes under no lock, so it is the store's own door, never a
/// run's: in diamond.rs only the store's housekeeping calls it, and neither the run's file act
/// (server.rs) nor the tools call it.
#[test]
fn qa1_f3_delete_entry_is_the_stores_own_door() {
    const DIAMOND: &str = include_str!("diamond.rs");
    const SERVER: &str = include_str!("server.rs");
    const TOOLS: &str = include_str!("../tools.rs");
    const KEPT: [&str; 13] = ["migrate_one_root", "delete", "write_snapshot", "take_back",
        "unpend", "settle", "prune_held", "restore_let_go", "end_run", "refile_own_versions",
        "undo_refile", "rebase_before_import", "delete_except_kept"];
    let mut within = String::new();
    let mut callers = std::collections::BTreeSet::new();
    for line in DIAMOND.lines() {
        let head = line.trim_start_matches("pub(crate) ").trim_start_matches("pub ")
            .trim_start_matches("async ");
        if !line.starts_with(' ') {
            if let Some(rest) = head.strip_prefix("fn ") {
                within = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            }
        }
        if line.contains("own::delete_entry(") {
            callers.insert(within.clone());
        }
    }
    for f in callers.iter() {
        assert!(KEPT.contains(&f.as_str()), "own::delete_entry called from '{}'", f);
    }
    let file_act = match SERVER.find("async fn store_file_act(") {
        Some(i) => &SERVER[i..],
        None    => panic!("store_file_act not found"),
    };
    let file_act = match file_act.find("\n}\n") {
        Some(j) => &file_act[..j],
        None    => file_act,
    };
    assert!(!file_act.contains("delete_entry("), "the run's file act calls delete_entry");
    assert!(!SERVER.contains("own::delete_entry("), "the store server calls own::delete_entry");
    assert!(!TOOLS.contains("own::delete_entry("), "the tools call own::delete_entry");
}
