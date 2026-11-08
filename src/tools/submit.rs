use super::*;

use crate::engine::host::ui::{
    SubmitAnswer,
    SubmitReach,
};

// ── `submit_change`: a daimon's tested commit, sent for his approval (SUBMIT-ROUTE SR2a) ──────
//
// D-20261105-01; design `daimond_submit_route_design_20261105.md` Rev 1.1, §2.1 and §2.3 step 1.
// A daimon that changed Daimond on a branch, tested and committed it, calls this.  On a Kimberlite
// run the host's ui port sends ONE `submit` control frame on the run's own pipe (no new socket)
// and returns the parent's answer: "submitted <id>", or its refusal.  The
// parent (SR2b) checks everything again -- the repo list, the protected refs, the open count --
// so the checks here are the daimon's early answer, never the gate.
//
// Everything the daimon writes here (the summary, its reported checks) is its own claim: the card
// labels it "the daimon says", beside the checks Kimberlite saw the run execute.

/// What the daimon is told about the tool, fetched by `tool_search`: when to submit, and never what.
pub(crate) const SUBMIT_CHANGE_DESC: &str = "Send a change you made to Daimond for his approval, \
    once it is ready to go live. Only when its tests pass and it is committed on a branch of its \
    own: never 'live', 'main' or a 'release/' branch (refused). 'commit' is the full object id \
    (40 or 64 hex) of the commit on that branch; 'kinds' says what it changes: 'runner' \
    (Kimberlite), 'page' (daimond.app), or 'both'. 'summary' is two short lines for him, saying \
    what changed and why; 'reported_checks' lists the checks you ran, each with its result \
    ('passed', 'failed' or 'skipped') and how many tests it ran, e.g. {\"name\":\"cargo test \
    --lib\",\"result\":\"passed\",\"count\":6456}. Both are shown to him labelled as what the daimon says. \
    Kimberlite checks that exact commit is the clean tip of that branch and puts a card on his \
    phone; nothing ships until he approves it there, and then that commit ships as it stands. Submit once per change: a newer submission from this chat \
    replaces the open one. Only a chat running on Kimberlite can submit.";

/// The tool's schema.
pub(crate) const SUBMIT_CHANGE_PARAMS: &str = r#"{"type":"object","properties":{"kinds":{"type":"string","enum":["runner","page","both"],"description":"What the change ships: 'runner' (Kimberlite), 'page' (daimond.app) or 'both'"},"repo":{"type":"string","description":"The repository the commit is in, as Kimberlite's submit list names it"},"branch":{"type":"string","description":"The branch the commit is on; never live, main or release/*"},"commit":{"type":"string","description":"The commit's full object id, 40 or 64 hex"},"summary":{"type":"string","description":"Two short lines for him: what changed and why"},"reported_checks":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string","description":"The check, as you ran it, e.g. 'cargo test --lib'"},"result":{"type":"string","enum":["passed","failed","skipped"]},"count":{"type":"integer","description":"How many tests it ran"}},"required":["name","result"]},"description":"The checks you ran and what each reported"}},"required":["kinds","repo","branch","commit","summary","reported_checks"]}"#;

/// The widths of a git object id in hex: SHA-1's and SHA-256's.
const OBJECT_ID_HEX: [usize; 2] = [40, 64]; // fixed: git's two hash widths

/// One checked `submit_change`, ready for the frame.
#[derive(Debug, PartialEq)]
pub(crate) struct SubmitCall {
    pub(crate) payload: String,    // the frame's JSON body
}

/// A refusal from `submit_change`, through [`refusal_line`] so it is booked as one.
pub(crate) fn submit_refusal(reason: &str) -> String {
    refusal_line(&fmt!("Nothing was submitted. {}", reason))
}

/// Is `branch` one of `protected` (a name, or a prefix ending in `*`)?
fn is_protected(branch: &str, protected: &[String]) -> bool {
    protected.iter().any(|p| {
        let p = p.trim();
        match p.strip_suffix('*') {
            Some(pre)   => branch.starts_with(pre),
            None        => !p.is_empty() && branch == p,
        }
    })
}

/// Is `b` a branch name git would take?  The parent checks it again; this is the early answer.
fn branch_ok(b: &str) -> bool {
    !b.is_empty() && !b.starts_with('-') && !b.starts_with('/') && !b.ends_with('/')
        && !b.ends_with(".lock") && !b.contains("..") && !b.contains("//") && !b.contains("@{")
        && !b.chars().any(|c| c.is_control() || c.is_whitespace()
            || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
}

/// The call's `reported_checks`, each as the frame's JSON object `{"name","result","count"}`, the
/// shape Kimberlite's desk reads (`kimberlite/src/submit/mod.rs`, `Ask::of_json`); `count` is 0
/// where the daimon gave none.  A check with no name or a result other than passed, failed or
/// skipped is refused with the sentence why.
fn reported_checks(args: &str) -> Result<Vec<String>, String> {
    let cfg: oxedyne_fe2o3_jdat::string::dec::DecoderConfig<
        std::collections::BTreeMap<oxedyne_fe2o3_jdat::usr::UsrKindCode, oxedyne_fe2o3_jdat::usr::UsrKind>,
        std::collections::BTreeMap<String, oxedyne_fe2o3_jdat::usr::UsrKindId>,
    > = oxedyne_fe2o3_jdat::string::dec::DecoderConfig::json(None);
    let m = match Dat::decode_string_with_config(args, &cfg) {
        Ok(Dat::Map(m)) => m,
        _               => return Err(String::from("The call's arguments are not a JSON object.")),
    };
    let key = |m: &oxedyne_fe2o3_jdat::map::DaticleMap, k: &str| m.get(&Dat::Str(k.to_string())).cloned();
    let list = match key(&m, "reported_checks") {
        None                => return Ok(Vec::new()),
        Some(Dat::List(l))  => l,
        Some(_)             => return Err(String::from(
            "'reported_checks' is a list of checks, each {\"name\",\"result\",\"count\"}.")),
    };
    let mut out = Vec::new();
    for c in list.iter() {
        let cm = match c {
            Dat::Map(cm)    => cm,
            _               => return Err(String::from(
                "Each reported check is an object: {\"name\",\"result\",\"count\"}.")),
        };
        let name = match key(cm, "name") {
            Some(Dat::Str(n)) if !n.trim().is_empty()   => n.trim().to_string(),
            _   => return Err(String::from("A reported check has no 'name': say which check you ran.")),
        };
        let result = match key(cm, "result") {
            Some(Dat::Str(r)) if matches!(r.as_str(), "passed" | "failed" | "skipped") => r,
            _   => return Err(fmt!("The check {:?} has no 'result' of passed, failed or skipped.", name)),
        };
        let count = match key(cm, "count") {
            None    => 0,
            Some(d) => match d.get_u64().and_then(|n| u32::try_from(n).ok()) {
                Some(n) => n,
                None    => return Err(fmt!("The check {:?} has a 'count' that is not a whole number.", name)),
            },
        };
        out.push(fmt!(r#"{{"name":"{}","result":"{}","count":{}}}"#, json_escape(&name), result, count));
    }
    Ok(out)
}

/// Whether this call may be submitted from `reach`, and the frame's JSON if it may.
///
/// Pure, so every refusal is tested on a build with no Kimberlite in it.  A refusal is the
/// sentence the daimon is answered; nothing has been sent.
///
/// # Arguments
/// * `args` - The raw tool arguments.
/// * `reach` - Where the host says a submission goes.
pub(crate) fn submit_step(args: &str, reach: &SubmitReach) -> Result<SubmitCall, String> {
    let (protected, page_refused) = match reach {
        SubmitReach::Absent(why)                        => return Err(submit_refusal(why)),
        SubmitReach::Kimberlite { protected, page_refused } => (protected, page_refused),
    };
    let field = |k: &str| extract_json_string(args, k).unwrap_or_default().trim().to_string();
    let kinds = field("kinds");
    let page = match kinds.as_str() {
        "runner"        => false,
        "page" | "both" => true,
        _               => return Err(submit_refusal(
            "'kinds' must be \"runner\", \"page\" or \"both\": what the change ships.")),
    };
    if let (true, Some(why)) = (page, page_refused) {
        return Err(submit_refusal(why));
    }
    let repo = field("repo");
    if repo.is_empty() || repo.chars().any(|c| c.is_control()) {
        return Err(submit_refusal("The call carried no 'repo': name the repository the commit is in."));
    }
    let raw = field("branch");
    let branch = raw.strip_prefix("refs/heads/").unwrap_or(&raw).to_string();
    if !branch_ok(&branch) {
        return Err(submit_refusal(&fmt!(
            "'branch' {:?} is not a branch name: give the branch the commit is on.", raw)));
    }
    if is_protected(&branch, protected) {
        return Err(submit_refusal(&fmt!(
            "'{}' is a branch the release itself keeps ({}), and a change is submitted from a \
            branch of its own. Commit it on a new branch and submit that.",
            branch, protected.join(", "))));
    }
    let commit = field("commit").to_ascii_lowercase();
    if !OBJECT_ID_HEX.contains(&commit.len()) || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(submit_refusal(
            "'commit' must be the commit's full object id, 40 or 64 hex characters, as \
            `git rev-parse HEAD` prints it on the branch."));
    }
    let summary = field("summary");
    if summary.is_empty() {
        return Err(submit_refusal(
            "The call carried no 'summary': say in two short lines what changed and why."));
    }
    let checks = match reported_checks(args) {
        Ok(c)       => c,
        Err(why)    => return Err(submit_refusal(&why)),
    };
    if checks.is_empty() {
        return Err(submit_refusal(
            "The call carried no 'reported_checks': list the checks you ran and what each \
            reported. A change whose tests have not been run is not ready to submit."));
    }
    let payload = fmt!(
        r#"{{"kinds":"{}","repo":"{}","branch":"{}","commit":"{}","summary":"{}","reported_checks":[{}]}}"#,
        kinds, json_escape(&repo), json_escape(&branch), commit, json_escape(&summary),
        checks.join(","));
    Ok(SubmitCall { payload })
}

/// What the daimon is answered once the parent has answered the frame.
pub(crate) fn submit_result(answer: &SubmitAnswer) -> String {
    match answer {
        SubmitAnswer::Submitted(id) => fmt!(
            "Submitted {}. Nothing ships until he approves its card on his phone; his answer \
            comes back to this chat. Tell him it is \
            submitted for his approval, and do not submit it again.", id),
        SubmitAnswer::Refused(why)  => submit_refusal(why),
    }
}

impl Tool {
    /// `submit_change` on a host with ports: checked here, then one frame through the ui port.
    pub(super) async fn submit_change<H: Host>(args_json: &str, ctx: &ToolContext<H>)
        -> Outcome<String>
    {
        let call = match submit_step(args_json, &ctx.host().ui().submit_reach()) {
            Ok(c)       => c,
            Err(why)    => return Ok(why),
        };
        let answer = res!(ctx.host().ui().submit(&call.payload).await);
        Ok(submit_result(&answer))
    }
}
