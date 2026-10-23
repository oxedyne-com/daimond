//! D1x2b's measures (d1_plan §9.2 D1x2, §9.10; spec §16.1 "Memory", §16.3a): each `#[ignore]`d,
//! and run alone, since the figures are the process's own:
//!
//! `cargo test --lib store::server::tests::measure::<name> -- --ignored --exact --test-threads=1
//! --nocapture`
//!
//! Each prints one `MEASURE` line.  The store's figure is the rise of the process's peak RSS
//! (`VmHWM`) from the moment the clients' bodies are built, so only the store's work is counted;
//! the relay's is the peak bytes of call frames queued in `LoopLink`s, the parent's share once R1
//! relays them (R1's pipe does not exist yet, so this counts the in-process queue that stands in
//! for it).

use super::*;
use crate::{diamond_versions::VERSION_FILE_MAX as K512, store::StoreBackend};

use std::sync::{Arc, Barrier};

/// A field of `/proc/self/status`, in KiB.
fn status_kib(field: &str) -> usize {
    let text = match std::fs::read_to_string("/proc/self/status") {
        Ok(t)   => t,
        Err(e)  => panic!("/proc/self/status: {}", e),
    };
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix(field) {
            let kib = rest.trim_start_matches(':').trim().trim_end_matches("kB").trim();
            return match kib.parse() {
                Ok(n)   => n,
                Err(e)  => panic!("{} in /proc/self/status: {}", field, e),
            };
        }
    }
    panic!("/proc/self/status has no {}", field)
}

/// Brings the peak RSS down to the RSS now (`clear_refs` 5), answering the RSS.
fn hwm_reset() -> usize {
    if let Err(e) = std::fs::write("/proc/self/clear_refs", "5") {
        panic!("/proc/self/clear_refs: {}", e);
    }
    status_kib("VmRSS")
}

fn mib(kib: usize) -> f64 { kib as f64 / 1024.0 }

/// A server over a fresh Ozone store holding the metadata of each Diamond in `ids`.
fn ozone_server(prefix: &str, ids: &[String]) -> StoreServer {
    let o = crate::store::ozone::tests::fresh_store(prefix);
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt)  => rt,
        Err(e)  => panic!("a runtime: {}", e),
    };
    for id in ids {
        let meta = fmt!(r#"{{"name":"{}","crystal_version":0,"updated":0,"touched":0}}"#, id);
        if let Err(e) = rt.block_on(o.write_file(&fmt!("diamonds/{}/.daimond/meta.json", id),
            meta.as_bytes()))
        {
            panic!("the metadata of {}: {}", id, e);
        }
    }
    server_over(NativeBackend::Ozone(o))
}

fn bind_to(s: &StoreServer, run: &str, id: &str) -> LoopLink {
    match s.bind(Tag::Run, env(run, &[id])) {
        Ok(l)   => l,
        Err(e)  => panic!("binding {}: {}", run, e),
    }
}

/// The envelope's bodies (the D1v2 test's): 64 `before`s of 512 KiB but the last, a 20 MB edit
/// copy, and 64 `after`s of 512 KiB, the first three 4 KiB over.
struct Envelope {
    before: Vec<Vec<u8>>,
    after:  Vec<Vec<u8>>,
}

impl Envelope {
    fn new() -> Self {
        Envelope {
            before: (0..64u64).map(|i| if i == 63 {
                body_of(i as u8, 20 * 1000 * 1000)
            } else {
                body_of(i as u8, K512)
            }).collect(),
            after:  (0..64u64).map(|i| if i < 3 {
                body_of(200 + i as u8, K512 + 4096)
            } else {
                body_of(100 + i as u8, K512)
            }).collect(),
        }
    }
}

/// Uploads `before` and `after` of `path` in the act `act`, chunk by chunk.
fn upload_change(link: &LoopLink, id: &str, act: u64, change: &WireChange, before: &[u8],
    after: &[u8], max: &mut usize)
{
    for r in change.uploads() {
        let bytes: &[u8] = if r.names(before) { before } else { after };
        let hash = HexHash::of(bytes);
        let mut at = 0;
        while at < bytes.len() {
            let end = bytes.len().min(at + BODY_CHUNK);
            let r = framed(link, C::BodyPut { id: s(id), act, hash: hash.clone(),
                len: bytes.len() as u64, offset: at as u64, chunk: bytes[at..end].to_vec() }, max);
            assert!(matches!(r, R::BodyPut(Ok(_))), "body_put in act {}: {:?}", act, r);
            // A body the store holds already is answered `Held`: nothing more is sent.
            if matches!(r, R::BodyPut(Ok(Put::Held))) {
                break;
            }
            at = end;
        }
    }
}

/// One run's envelope turn on the Diamond `id`, end to end as the D1v2 test drives it.  `staged`
/// is met twice with every 20 MB copy uploaded and not yet named, `held` twice with every turn
/// captured, and the measure taken between.
fn envelope_turn(link: &LoopLink, id: &str, env: &Envelope, staged: &Barrier, held: &Barrier)
    -> usize
{
    let mut max = 0usize;
    let mut stands: Vec<(String, Seen)> = Vec::new();
    for i in 0..64usize {
        let path = fmt!("notes/f{:02}.md", i);
        let (before, after) = (&env.before[i], &env.after[i]);
        let change = change_at(&path, before, after);
        upload_change(link, id, i as u64 + 1, &change, before, after, &mut max);
        if i == 63 {
            staged.wait();      // the measure is taken here
            staged.wait();
        }
        let r = framed(link, C::Capture { id: s(id), raw: path.clone(), change }, &mut max);
        assert!(matches!(r, R::Capture(Ok(()))), "capture of {}: {:?}", path, r);
        stands.push((path, after_seen(after)));
    }
    held.wait();
    held.wait();
    let mut own: Vec<(String, Seen)> = Vec::new();
    let mut page = match framed(link, C::TurnWants { id: s(id) }, &mut max) {
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
        page = match framed(link, C::TurnWantsPage { id: s(id), n }, &mut max) {
            R::TurnWantsPage(Ok(p)) => p,
            other                   => panic!("turn_wants_page answered {:?}", other),
        };
    }
    own.sort_by(|x, y| x.0.cmp(&y.0));
    stands.sort_by(|x, y| x.0.cmp(&y.0));
    assert_eq!(own, stands, "every capture wanted");
    for chunk in stands.chunks(LIST_PAGE) {
        let r = framed(link, C::TurnStands { id: s(id), stands: chunk.to_vec() }, &mut max);
        assert!(matches!(r, R::TurnStands(Ok(()))), "turn_stands: {:?}", r);
    }
    let h = match framed(link, C::HoldVersions { id: s(id) }, &mut max) {
        R::HoldVersions(Ok(h))  => h,
        other                   => panic!("hold_versions answered {:?}", other),
    };
    let r = framed(link, C::DrainTurn { hold: h, id: s(id) }, &mut max);
    assert!(matches!(&r, R::DrainTurn(Ok(d)) if d.captured == 64), "drain_turn: {:?}", r);
    let r = framed(link, C::VersionsRecordHeld { hold: h, id: s(id), at: None,
        cause: crate::diamond_versions::Cause::Turn, turn: s("t"),
        note: crate::store::call::WireText::Words(s("")) }, &mut max);
    match r {
        R::VersionsRecordHeld(Ok(Some(rec))) => assert_eq!(rec.count, 64, "every capture a row"),
        other => panic!("versions_record_held answered {:?}", other),
    }
    max
}

/// `runs` runs at once, each its envelope turn on a Diamond of its own over one Ozone store.
fn envelope_runs(runs: usize) {
    let ids: Vec<String> = (0..runs).map(|k| fmt!("d{}", k)).collect();
    let srv = ozone_server(&fmt!("measure{}", runs), &ids);
    let links: Vec<LoopLink> = ids.iter().map(|id| bind_to(&srv, &fmt!("r{}", id), id)).collect();
    let env = Arc::new(Envelope::new());
    let (staged, held) = (Arc::new(Barrier::new(runs + 1)), Arc::new(Barrier::new(runs + 1)));
    queued_peak_reset();
    let base = hwm_reset();
    let turns: Vec<_> = links.into_iter().zip(ids.iter().cloned()).map(|(link, id)| {
        let (env, staged, held) = (env.clone(), staged.clone(), held.clone());
        std::thread::spawn(move || envelope_turn(&link, &id, &env, &staged, &held))
    }).collect();
    staged.wait();
    let at_staged = status_kib("VmRSS");
    let p = probe(&srv);
    staged.wait();
    held.wait();
    let at_held = status_kib("VmRSS");
    held.wait();
    let mut frame = 0usize;
    for t in turns {
        match t.join() {
            Ok(m)   => frame = frame.max(m),
            Err(_)  => panic!("a run's envelope turn panicked"),
        }
    }
    let hwm = status_kib("VmHWM");
    let end = status_kib("VmRSS");
    println!("MEASURE envelope runs={} base_rss={:.1}MiB staged_rss_rise={:.1}MiB \
        (probe staged {:.1}MiB in {} uploads) held_rss_rise={:.1}MiB hwm_rise={:.1}MiB \
        end_rss_rise={:.1}MiB relay_queued_peak={}B max_frame={}B frame_max={}B",
        runs, mib(base), mib(at_staged.saturating_sub(base)), p.staged as f64 / (1 << 20) as f64,
        p.uploads, mib(at_held.saturating_sub(base)), mib(hwm.saturating_sub(base)),
        mib(end.saturating_sub(base)), queued_peak(), frame, FRAME_MAX);
}

#[test]
#[ignore = "a measure: run alone, --ignored --test-threads=1"]
fn measure_one_run_at_the_envelope() { envelope_runs(1) }

#[test]
#[ignore = "a measure: run alone, --ignored --test-threads=1"]
fn measure_six_runs_at_the_envelope() { envelope_runs(6) }

/// Whether a capture held under two names shares its bodies or copies them (spec §16.1, the
/// two-tab case of nested open folders): one 20 MB edit copy captured at `p/sub/f.md` and again
/// at `sub/f.md`, the RSS rise of each.  Shared, the second rises by next to nothing; copied, by
/// the copy's size again.
#[test]
#[ignore = "a measure: run alone, --ignored --test-threads=1"]
fn measure_a_capture_under_two_names() {
    let srv = ozone_server("measure-two", &[s("d")]);
    let link = bind_to(&srv, "r", "d");
    let before = body_of(1, 20 * 1000 * 1000);
    let after = body_of(2, K512);
    let mut max = 0usize;
    // A small capture first, so the ledger's own first growth is not counted against the copy.
    let warm = change_at("w.md", b"w0", b"w1");
    upload_change(&link, "d", 1, &warm, b"w0", b"w1", &mut max);
    assert!(matches!(framed(&link, C::Capture { id: s("d"), raw: s("w.md"), change: warm },
        &mut max), R::Capture(Ok(()))));
    let base = hwm_reset();
    let mut rise = Vec::new();
    for (act, name) in [(2u64, "p/sub/f.md"), (3, "sub/f.md")] {
        let was = status_kib("VmRSS");
        let change = change_at(name, &before, &after);
        upload_change(&link, "d", act, &change, &before, &after, &mut max);
        let r = framed(&link, C::Capture { id: s("d"), raw: s(name), change }, &mut max);
        assert!(matches!(r, R::Capture(Ok(()))), "capture of {}: {:?}", name, r);
        let p = probe(&srv);
        assert_eq!(p.uploads, 0, "the capture named its uploads");
        rise.push(status_kib("VmRSS").saturating_sub(was));
    }
    let copy = (before.len() + after.len()) / 1024;
    let shares = rise[1] * 4 < copy;
    println!("MEASURE two_names copy={:.1}MiB first_rise={:.1}MiB second_rise={:.1}MiB \
        hwm_rise={:.1}MiB shares={}", mib(copy), mib(rise[0]), mib(rise[1]),
        mib(status_kib("VmHWM").saturating_sub(base)), shares);
}
