//! The retired verify pin, driven through the real binary (11 Oct 2026).
//!
//! `verify-root.txt` beside the journal used to replace the tree every `verify`
//! request named, so a pin left behind by an agent on 2026-09-10 sent every
//! Diamond on argonaut to the daimond checkout's `dev/`.  The feature is removed:
//! a file still lying there is ignored, and `--report` names it once.  Driven over
//! the binary because the pin was read at start-up, which a `Serve` built in a
//! test never passes through.

use daimond_hand::codec::Frame;
use daimond_hand::wire::{
    Breaks,
    Req,
    Resp,
    TurnRules,
    World,
};
use daimond_hand::PROTO;

use oxedyne_fe2o3_core::prelude::*;

use std::os::unix::fs::PermissionsExt;
use std::io::{
    Cursor,
    Write,
};
use std::path::{
    Path,
    PathBuf,
};
use std::process::{
    Command,
    Stdio,
};

/// A grant holding two repositories, and a journal whose leftover pin names the first.
struct Rig {
    journal:	PathBuf,
    alpha:		PathBuf,	// the pinned tree
    beta:		PathBuf,	// the tree the request names
}

impl Rig {
    fn make(case: &str) -> Outcome<Self> {
        // Never /tmp: a tmpfs here.
        let base = match std::env::var("CARGO_TARGET_DIR") {
            Ok(v) if !v.is_empty() => PathBuf::from(v),
            _ => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target"),
        }.join("verify-pin-tests").join(case);
        if base.exists() {
            res!(std::fs::remove_dir_all(&base));
        }
        let grant = base.join("grant");
        for (repo, verifier) in [("alpha", "alef"), ("beta", "bet")] {
            let dev = grant.join(repo).join("dev");
            res!(std::fs::create_dir_all(&dev));
            res!(std::fs::write(dev.join(fmt!("verify_{}.mjs", verifier)), "//\n"), IO, File);
        }
        let grant = res!(std::fs::canonicalize(&grant));
        let journal = base.join("journal");
        res!(std::fs::create_dir_all(&journal));
        // The hand refuses a journal others can read, as it should.
        res!(std::fs::set_permissions(&journal, std::fs::Permissions::from_mode(0o700)), IO, File);
        res!(std::fs::write(journal.join(daimond_hand::ROOT_FILE),
            fmt!("{}\n", grant.display())), IO, File);
        res!(std::fs::write(journal.join("verify-root.txt"),
            fmt!("{}\n", grant.join("alpha").display())), IO, File);
        Ok(Self { journal, alpha: grant.join("alpha"), beta: grant.join("beta") })
    }

    fn hand(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_daimond-hand"));
        c.env("DAIMOND_HAND_JOURNAL_DIR", &self.journal)
            .env_remove("DAIMOND_HAND_ROOT")
            .env_remove("DAIMOND_HAND_TERMINAL_ROOT")
            .env_remove("DAIMOND_HAND_VERIFY_ROOT");
        c
    }
}

fn s(p: &Path) -> String {
    fmt!("{}", p.display())
}

/// A request naming tree B resolves in B, whatever a leftover `verify-root.txt` names.
#[test]
fn a_leftover_verify_root_txt_never_moves_a_request() -> Outcome<()> {
    let rig = res!(Rig::make("never-moves"));
    let frame = Frame::NativeMessaging;
    let mut input = Vec::new();
    res!(frame.write_req(&mut input, &Req::Hello { proto: PROTO, client: fmt!("test") }));
    res!(frame.write_req(&mut input, &Req::Verify {
        id:         fmt!("v1"),
        name:       fmt!("bet"),
        root:       s(&rig.beta),
        breaks:     Breaks::None,
        world:      World::None,
        net:        false,
        rules:      Some(TurnRules::default()),
        timeout_ms: 10_000,
    }));
    let mut child = res!(rig.hand()
        .arg("chrome-extension://verifypintest/")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn(), IO);
    {
        let mut sin = res!(child.stdin.take().ok_or_else(|| err!("no stdin"; Test, Missing)));
        res!(sin.write_all(&input), IO, File);
    }
    let out = res!(child.wait_with_output(), IO);
    let mut cur = Cursor::new(out.stdout);
    let mut resps: Vec<Resp> = Vec::new();
    while let Some(r) = res!(frame.read_resp(&mut cur)) {
        resps.push(r);
    }
    let said = fmt!("{:?}", resps);
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    assert!(resps.iter().any(|r| matches!(r, Resp::Hello { .. })), "no handshake: {} {}", said, stderr);
    // Neither the handshake nor the answer may mention the pinned tree.
    assert!(!said.contains(&s(&rig.alpha)),
        "the leftover pin moved the request or was advertised: {}", said);
    assert!(!said.contains("names no verifier"),
        "'bet' was not found in the tree the request named: {}", said);
    assert!(stderr.contains("verify-root.txt") && stderr.contains("ignored"),
        "the hand did not say on stderr that it ignored the leftover pin: {}", stderr);
    Ok(())
}

/// `--report` names a leftover `verify-root.txt` exactly once, as ignored, and never as a pin.
#[test]
fn the_report_names_a_leftover_verify_root_txt_as_ignored() -> Outcome<()> {
    let rig = res!(Rig::make("report"));
    let out = res!(rig.hand().arg("--report").stdin(Stdio::null()).output(), IO);
    let txt = String::from_utf8_lossy(&out.stdout).to_string();
    assert_eq!(1, txt.matches("ignored, feature removed").count(),
        "the report does not name the leftover pin once as ignored: {}", txt);
    assert!(!txt.contains("pinned by"), "the report still describes a pin: {}", txt);
    assert!(txt.contains(&s(&rig.beta.parent().map(|p| p.to_path_buf()).unwrap_or_default())),
        "the report does not list the granted root: {}", txt);
    Ok(())
}

/// `--report` says verifiers run fenced, in each request's folder, and does not list the
/// grant's `dev/` as though every verify ran there (QA A F3, 11 Oct 2026).
#[test]
fn the_report_says_verifiers_run_fenced_in_the_folder_each_request_names() -> Outcome<()> {
    let rig = res!(Rig::make("fenced"));
    let grant = res!(rig.beta.parent().map(|p| p.to_path_buf())
        .ok_or_else(|| err!("The rig's beta repository has no parent."; Missing)));
    // A verifier in the grant itself, which the old report listed as the machine's catalogue.
    let dev = grant.join("dev");
    res!(std::fs::create_dir_all(&dev), IO, File);
    res!(std::fs::write(dev.join("verify_top.mjs"), "//\n"), IO, File);
    let out = res!(rig.hand().arg("--report").stdin(Stdio::null()).output(), IO);
    let txt = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(txt.contains("Each verify runs behind the verifier fence, in the folder its request \
        names: a Diamond's own attached folder"), "the report does not say where verify runs: {}", txt);
    assert!(txt.contains("The granted root is the tree only for a turn that is not scoped to a \
        Diamond."), "the report does not place the grant: {}", txt);
    for stale in ["OUTSIDE the fence", "unfenced", "fence:none", "1 in ",
        "verify verb refuses on this machine"]
    {
        assert!(!txt.contains(stale), "the report still says {:?}: {}", stale, txt);
    }
    Ok(())
}
