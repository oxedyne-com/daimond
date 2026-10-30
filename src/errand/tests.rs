//! P2.2 acceptance: the [`TurnView`] vectors (`testdata/turnview_vectors.json`, which the wasm
//! check `www/js/errandwasm.test.mjs` runs as well), a 200 KiB report signed by digest under a
//! signer that takes at most 64 KiB, a scheme-1 signature refused by name, and a row sealed and
//! opened with its `mid`.

use crate::{
    errand::{
        codec::*,
        json::Js,
        row::*,
    },
    seal::wrap,
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_crypto::sign::SignatureScheme;
use oxedyne_fe2o3_iop_crypto::{
    keys::KeyManager,
    sign::Signer,
};
use oxedyne_fe2o3_text::base64;

const VECTORS: &str = include_str!("testdata/turnview_vectors.json");

/// The keeper's own cap on what it signs (kimberlite `device_key::SIGN_MAX`), held here so the
/// test fails as the runner would if a report were signed whole.
const SIGN_CAP: usize = 64 * 1024;

struct TestHolder {
    key:    Vec<u8>,
    pk:     [u8; 32],
    sk:     Vec<u8>,
}

impl TestHolder {
    fn new() -> Outcome<Self> {
        let s = SignatureScheme::new_ed25519();
        let pkv = res!(res!(s.get_public_key()).ok_or_else(|| err!("No public key."; Missing))).to_vec();
        let sk = res!(res!(s.get_secret_key()).ok_or_else(|| err!("No secret key."; Missing))).to_vec();
        let mut pk = [0u8; 32];
        if pkv.len() != 32 {
            return Err(err!("The Ed25519 public key is {} bytes.", pkv.len(); Invalid));
        }
        pk.copy_from_slice(&pkv);
        Ok(Self { key: vec![7u8; 32], pk, sk })
    }
}

impl AccountHolder for TestHolder {
    fn wrap(&self, plain: &[u8], aad: Option<&[u8]>) -> Outcome<Vec<u8>> {
        wrap::seal(&self.key, plain, aad)
    }
    fn unwrap(&self, body: &[u8], aad: Option<&[u8]>) -> Outcome<Option<zeroize::Zeroizing<Vec<u8>>>> {
        Ok(wrap::open(&self.key, body, aad).ok().map(zeroize::Zeroizing::new))
    }
    fn author(&self) -> Outcome<[u8; 32]> {
        Ok(self.pk)
    }
    fn sign(&self, msg: &[u8]) -> Outcome<Vec<u8>> {
        if msg.len() > SIGN_CAP {
            return Err(err!("The signer takes at most {} bytes, not {}.", SIGN_CAP, msg.len();
                Invalid, Input, Excessive));
        }
        let s = res!(SignatureScheme::empty_ed25519().clone_with_keys(Some(&self.pk), Some(&self.sk)));
        s.sign(msg)
    }
}

fn big_report() -> Report {
    let e = Errand::of_js(&Js::Obj(vec![
        ("t".into(),        Js::str(T_ERRAND)),
        ("eid".into(),      Js::str("e-200k")),
        ("turnId".into(),   Js::str("t-200k")),
        ("chatId".into(),   Js::str("c-1")),
    ]));
    let mut r = Report::for_errand(&e, "done", 1_761_782_400_000);
    r.words = "w".repeat(200 * 1024);
    r
}

#[test]
fn turnview_vectors_fold_as_written() -> Outcome<()> {
    let tv = res!(Js::parse(VECTORS));
    let cases = match tv.get("cases") {
        Some(Js::Arr(c))    => c.clone(),
        _                   => return Err(err!("turnview_vectors.json has no cases."; Missing)),
    };
    if cases.len() < 4 {
        return Err(err!("turnview_vectors.json has {} cases, not at least 4.", cases.len(); Invalid));
    }
    for case in &cases {
        let name = case.get_str("name").unwrap_or("");
        let mut view = TurnView::new(case.get_str("turn").unwrap_or(""));
        let rows = match case.get("rows") {
            Some(Js::Arr(r))    => r.clone(),
            _                   => return Err(err!("Case '{}' has no rows.", name; Missing)),
        };
        let mut applied = Vec::new();
        for r in &rows {
            let row = res!(Row::of_js(r));
            applied.push(Js::str(view.apply(&row).code()));
        }
        let want_applied = res!(case.get("applied").ok_or_else(|| err!("Case '{}': no applied.", name; Missing)));
        if Js::Arr(applied.clone()).canonical() != want_applied.canonical() {
            return Err(err!("Case '{}': applied {} not {}.", name, Js::Arr(applied).stringify(),
                want_applied.stringify(); Mismatch));
        }
        let want = res!(case.get("view").ok_or_else(|| err!("Case '{}': no view.", name; Missing)));
        if view.to_js().canonical() != want.canonical() {
            return Err(err!("Case '{}': view {} not {}.", name, view.to_js().stringify(), want.stringify();
                Mismatch));
        }
        // The view survives its own JSON, as the wasm passes it between calls.
        let again = res!(TurnView::of_js(&view.to_js()));
        if again != view {
            return Err(err!("Case '{}': the view does not survive its JSON.", name; Mismatch));
        }
        // Ended exactly when an end row was folded.
        if view.ended() != view.end.is_some() {
            return Err(err!("Case '{}': ended {} with end {:?}.", name, view.ended(), view.end; Mismatch));
        }
    }
    Ok(())
}

#[test]
fn report_of_200k_signs_by_digest_and_opens() -> Outcome<()> {
    let h = res!(TestHolder::new());
    let body = res!(post_body(&h, &big_report().to_js(), 1_761_782_400_000));
    let b64 = res!(body.get_str("envelope").ok_or_else(|| err!("No envelope."; Missing)));
    match res!(open_envelope(&h, b64)) {
        Opened::Envelope(Envelope::Report(r)) => {
            if r.words.len() != 200 * 1024 || r.turn_id != "t-200k" {
                return Err(err!("The report opened changed: {} bytes of words.", r.words.len(); Mismatch));
            }
        }
        other => return Err(err!("A 200 KiB report did not open: {:?}.", other; Mismatch)),
    }
    let signed = res!(sign_envelope(&h, &big_report().to_js()));
    if !is_sig_v2(&signed) || signed_bytes(&signed).len() != 32 {
        return Err(err!("The envelope is not signed over a 32-byte digest under sigv:2."; Mismatch));
    }
    Ok(())
}

#[test]
fn scheme_1_signature_is_refused_by_name() -> Outcome<()> {
    let h = res!(TestHolder::new());
    // A scheme-1 envelope: the signature over canonical itself, no sigv.
    let base = Report::for_errand(&Errand::of_js(&Js::Obj(vec![("t".into(), Js::str(T_ERRAND))])), "done", 1).to_js();
    let sig = res!(h.sign(base.canonical().as_bytes()));
    let mut kv = match base {
        Js::Obj(kv) => kv,
        _           => return Err(err!("A report is an object."; Invalid)),
    };
    kv.push(("author".into(), Js::Str(crate::seal::hex(&h.pk))));
    kv.push(("sig".into(), Js::Str(base64::encode(&sig))));
    let v1 = Js::Obj(kv);
    let sealed = crate::seal::peer::frame(&res!(h.wrap(v1.stringify().as_bytes(), Some(crate::seal::peer::AAD))));
    match res!(open_envelope(&h, &base64::encode(&sealed))) {
        Opened::Refused(Refused::V1) if Refused::V1.code() == "sig:v1-refused" => {}
        other => return Err(err!("A scheme-1 envelope was not refused as v1: {:?}.", other; Mismatch)),
    }
    // Nor is it re-signed as if it were new.
    if sign_envelope(&h, &v1).is_ok() {
        return Err(err!("A scheme-1 envelope was re-signed."; Mismatch));
    }
    Ok(())
}

#[test]
fn row_seals_and_opens_with_its_mid() -> Outcome<()> {
    let h = res!(TestHolder::new());
    let head = Header {
        seq: 0, turn: "t1".into(), n: 1, kind: "msg".into(), member: String::new(),
        daimon: "d1".into(), at: 0, len: 0,
    };
    let body = Body { mid: "m-42".into(), role: "assistant".into(), text: "Hello".into(), meta: Js::Null, end: None };
    let w = res!(seal_row(&h, &head, &body));
    if w.get_str("body").is_none() || crate::errand::codec::whole(&w, "len") <= 0 {
        return Err(err!("The wire row has no sealed body or length: {}.", w.stringify(); Mismatch));
    }
    if w.stringify().contains("m-42") || w.stringify().contains("Hello") {
        return Err(err!("The wire row shows its body in the clear."; Mismatch));
    }
    match res!(open_row(&h, &w)) {
        Opened::Envelope(row) if row.body == Part::Whole(body.clone()) && row.head.turn == "t1" => {}
        other => return Err(err!("The row did not open to itself: {:?}.", other; Mismatch)),
    }
    // A body that names no mid is refused at the writer.
    let blank = Body { mid: String::new(), ..body };
    if seal_row(&h, &head, &blank).is_ok() {
        return Err(err!("A msg row with no mid was sealed."; Mismatch));
    }
    Ok(())
}

/// A writer kept between looks as JSON (the tab's) gives the same changes as one held, and a
/// chat row maps to its body (`row_body`) with its other fields as meta.
#[test]
fn writer_round_trips_as_json_and_maps_chat_rows() -> Outcome<()> {
    let row = res!(Js::parse(r#"{"mid":"a","role":"assistant","content":"he","iturn":"u1","whole":1}"#));
    let b = row_body(&row);
    assert_eq!((b.mid.as_str(), b.role.as_str(), b.text.as_str()), ("a", "assistant", "he"));
    assert_eq!(b.meta, res!(Js::parse(r#"{"iturn":"u1"}"#)), "whole is not meta");
    let mut w = Writer::new();
    assert_eq!(res!(w.diff(&[b.clone()])).len(), 1);
    let mut kept = res!(Writer::of_js(&res!(Js::parse(&w.to_js().stringify()))));
    assert!(res!(kept.diff(&[b.clone()])).is_empty(), "the kept writer forgot what it sent");
    let grown = Body { text: "hello".into(), ..b };
    let c = res!(kept.diff(&[grown]));
    assert_eq!(c[0].kind, Kind::More);
    assert_eq!(res!(Change::of_js(&c[0].to_js())), c[0], "a change does not round-trip");
    let end = End { status: EndStatus::Interrupted, totals: Js::Null, alerts: Vec::new(), undo: Js::Null, tried: Vec::new(), not_run: None, unsent: Vec::new() };
    let e = res!(kept.end(end));
    assert_eq!(res!(Change::of_js(&e.to_js())), e);
    let kept2 = res!(Writer::of_js(&kept.to_js()));
    assert!(kept2.ended(), "the kept writer forgot its end");
    Ok(())
}

/// P2.2c: a writer looking at a growing turn gives `msg`, then `more` for appended text, `edit`
/// for a changed role, `tomb` for a gone message and one `end`; a long text goes whole in pieces
/// each within the row's room, which fold back to the whole.
#[test]
fn writer_gives_only_what_changed_and_cuts_long_text() -> Outcome<()> {
    let msg = |mid: &str, role: &str, text: &str| Body {
        mid: mid.into(), role: role.into(), text: text.into(), meta: Js::Null, end: None };
    let kinds = |c: &[Change]| c.iter().map(|x| x.kind).collect::<Vec<_>>();
    let mut w = Writer::new();
    assert_eq!(kinds(&res!(w.diff(&[msg("a", "assistant", "he")]))), vec![Kind::Msg]);
    assert!(res!(w.diff(&[msg("a", "assistant", "he")])).is_empty(), "nothing changed");
    let grown = res!(w.diff(&[msg("a", "assistant", "hello"), msg("b", "tool_log", "x")]));
    assert_eq!(kinds(&grown), vec![Kind::More, Kind::Msg]);
    assert_eq!(grown[0].body.text, "llo", "only the appended text");
    assert_eq!(kinds(&res!(w.diff(&[msg("a", "user", "hello")]))), vec![Kind::Edit, Kind::Tomb]);
    let end = End { status: EndStatus::Done, totals: Js::Null, alerts: Vec::new(), undo: Js::Null, tried: Vec::new(), not_run: None, unsent: Vec::new() };
    assert_eq!(res!(w.end(end.clone())).kind, Kind::End);
    assert!(w.end(end).is_err() && w.diff(&[]).is_err(), "nothing follows the end");
    // 3000 characters of every width at 512 bytes a row.
    // 3000 characters of every width at 512 bytes a row.
    let long: String = (0..300).map(|i| format!("{:03}é€😀\"\n", i)).collect();
    let view = res!(fold_cut("t1", &Change { kind: Kind::Msg, body: msg("c", "assistant", &long) }, 512, 4));
    assert_eq!(view.rows.len(), 1);
    assert_eq!(view.rows[0].text, long, "the pieces fold back to the whole");
    assert_eq!(view.rows[0].seq, 1, "the body takes its first piece's seq");
    Ok(())
}

/// The rows of `change` cut within `room` bytes from n 7, sealed and opened, and folded in seq
/// order: every row within its room and taken, more than `min` of them, and nothing left joining.
fn fold_cut(turn: &str, change: &Change, room: usize, min: usize) -> Outcome<TurnView> {
    let h = res!(TestHolder::new());
    let rows = res!(change_rows(turn, "d1", 7, change, room));
    assert!(rows.len() > min, "{} rows", rows.len());
    let mut view = TurnView::new(turn);
    for (i, (head, part)) in rows.iter().enumerate() {
        assert_eq!(head.n, 7 + i as i64);
        assert_eq!(head.kind, if i == 0 { change.kind.code() } else { "more" });
        assert!(res!(part_plain(head, part)).len() <= room, "row {} over its room", i);
        let sealed = res!(h.wrap(&res!(part_plain(head, part)), Some(ROW_AAD)));
        let mut head = head.clone();
        head.seq = 1 + i as i64;
        let row = match res!(open_row(&h, &wire(&head, &sealed))) {
            Opened::Envelope(r) => r,
            other               => return Err(err!("Row {} did not open: {:?}.", i, other; Mismatch)),
        };
        assert_eq!(view.apply(&row), Applied::Taken, "row {}", i);
        // The view goes between rows as JSON, as the wasm passes it.
        view = res!(TurnView::of_js(&view.to_js()));
    }
    assert!(view.joining.is_empty(), "a body is left joining");
    Ok(view)
}

/// P2.2f: a tool row whose meta is a 60 kB `file_write` call goes whole, in pieces each within the
/// row's room, and folds back byte for byte; so does an `end` too big for one row.
#[test]
fn big_tool_row_goes_whole_in_pieces() -> Outcome<()> {
    let args = format!(r#"{{"path":"rw/big.txt","content":"{}"}}"#, "a".repeat(60_000));
    let meta = Js::Obj(vec![("name".into(), Js::str("file_write")), ("args".into(), Js::str(&args))]);
    let body = Body { mid: "t-1".into(), role: "tool_log".into(), text: "file_write".into(), meta: meta.clone(),
        end: None };
    let view = res!(fold_cut("t1", &Change { kind: Kind::Msg, body }, 16 * 1024, 3));
    assert_eq!(view.rows.len(), 1);
    assert_eq!(view.rows[0].meta, meta, "the tool row's meta is not whole");
    assert_eq!(view.rows[0].role, "tool_log");
    // An end whose undo is big.
    let undo = Js::Obj(vec![("files".into(), Js::str(&"é".repeat(20_000)))]);
    let end = End { status: EndStatus::Done, totals: Js::Null, alerts: Vec::new(), undo: undo.clone(),
        tried: vec!["r1".into()], not_run: None, unsent: Vec::new() };
    let body = Body { mid: String::new(), role: String::new(), text: String::new(), meta: Js::Null, end: Some(end) };
    let view = res!(fold_cut("t1", &Change { kind: Kind::End, body }, 4096, 3));
    assert!(view.ended());
    assert_eq!(view.end.map(|e| e.undo), Some(undo), "the end's undo is not whole");
    Ok(())
}

/// P2.3a3: a `not_run` end carries its reason as a field of its own, round-trips through the
/// body, and no other status writes or reads one.
#[test]
fn not_run_end_carries_its_reason() -> Outcome<()> {
    let nr = NotRun {
        why: "Not run: the page is out of date.".into(), cause: "abi".into(), to: "dev-7".into(),
        name: "iphone".into(), said: String::new(),
    };
    let end = End { status: EndStatus::NotRun, totals: Js::Null, alerts: Vec::new(), undo: Js::Null,
        tried: vec!["dev-7".into()], not_run: Some(nr.clone()), unsent: Vec::new() };
    let js = end.to_js();
    let back = res!(End::of_js(&res!(Js::parse(&js.stringify()))));
    assert_eq!(back, end, "the not_run end round-trips");
    assert!(!js.stringify().contains("said"), "an empty field is not written");
    // Through a sealed row too.
    let h = res!(TestHolder::new());
    let head = Header { seq: 0, turn: "t1".into(), n: 1, kind: "end".into(), member: String::new(),
        daimon: String::new(), at: 0, len: 0 };
    let body = Body { mid: String::new(), role: String::new(), text: String::new(), meta: Js::Null,
        end: Some(end.clone()) };
    match res!(open_row(&h, &res!(seal_row(&h, &head, &body)))) {
        Opened::Envelope(row) if matches!(&row.body, Part::Whole(b)
            if b.end.as_ref().and_then(|e| e.not_run.clone()) == Some(nr.clone())) => {}
        other => return Err(err!("The not_run end row did not open to its reason: {:?}.", other; Mismatch)),
    }
    // A done end neither writes nor reads one.
    let done = End { status: EndStatus::Done, not_run: Some(nr), ..end };
    assert!(!done.to_js().stringify().contains("not_run"), "a done end writes no reason");
    let mut js = done.to_js();
    if let Js::Obj(kv) = &mut js {
        kv.push(("not_run".into(), Js::Obj(vec![("why".into(), Js::str("x"))])));
    }
    assert_eq!(res!(End::of_js(&js)).not_run, None, "a done end reads no reason");
    Ok(())
}
