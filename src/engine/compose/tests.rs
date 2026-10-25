//! KT-3: [`compose_turn`] composes a Diamond's turn and a chat's from the keeper, on a test Host.

use super::*;
use crate::{
    engine::host::test::TestHost,
    executor::Executor,
    prompts::Block,
    tools::{FileRoot, Tool, ToolContext, new_read_cache},
    workspace::Workspace,
};

const CRYSTAL: &str = r#"{"title":"Ledger","sections":[{"title":"Plan","body":"quillfeather"}]}"#;
const REQUIREMENTS: &str = "# Requirements\n\n## Objectives\n\n- [ ] Ship the ledger\n";
const STATE: &str = "# State\n\nHalfway through the ledger.\n";
const DECISIONS: &str = "# Decisions\n\n- 2026-10-24: one ledger, not two.\n";

/// The page's limits for a 1M-window model, its tune setting K to 9.
fn limits() -> TurnLimits {
    TurnLimits {
        window:     1_048_576,
        fold_at:    0.8,
        tune:       r#"{"no_progress_rounds":9}"#.to_string(),
        ..TurnLimits::default()
    }
}

/// A turn's registry for `keeper` on a test Host holding Diamond `d1`'s crystal (K 20) and its
/// three standing files.
fn registry(keeper: &str) -> ToolRegistry<TestHost> {
    registry_holding(keeper, &[("REQUIREMENTS.md", REQUIREMENTS), ("STATE.md", STATE),
        ("DECISIONS.md", DECISIONS)])
}

/// [`registry`], with only `files` of the three standing files seeded.
fn registry_holding(keeper: &str, files: &[(&str, &str)]) -> ToolRegistry<TestHost> {
    let dir = match oxedyne_fe2o3_test::scratch::scratch_dir("engine_compose_tests") {
        Ok(d)  => d,
        Err(e) => panic!("a scratch directory: {}", e),
    };
    let ws = match Workspace::new(dir) {
        Ok(w)  => w,
        Err(e) => panic!("a workspace: {}", e),
    };
    let host = TestHost::default();
    host.store().hold_diamond(CRYSTAL, 20);
    for (leaf, text) in files {
        if let Err(e) = host.fs().put(FileRoot::Opfs, &fmt!("diamonds/d1/{}", leaf), text.as_bytes()) {
            panic!("seeding {}: {}", leaf, e);
        }
    }
    let ctx = ToolContext {
        workspace:   ws,
        executor:    Executor::local_default(),
        cwd:         String::new(),
        path_prefix: String::new(),
        root:        FileRoot::Workspace,
        read_seen:   new_read_cache(),
        no_write:    crate::tools::diamond_bounds("diamonds/d1", &[], &[]),
        daimon_of:   String::new(),
        turn:        String::new(),
        keeper:      keeper.to_string(),
        unconfirmed: Vec::new(),
        live:        None,
        by_model:    false,
        restoring:   0,
        by:          None,
        host,
    };
    ToolRegistry::new_on(Tool::daimon(), ctx)
}

fn ask<'a>(keeper: &'a str, l: &'a TurnLimits) -> Ask<'a> {
    Ask {
        keeper,
        own:            "",
        steer:          "",
        instructions:   "",
        today:          "",
        reach:          None,
        limits:         Limited::Page(l),
        liveness_ms:    45_000,
    }
}

async fn composed(keeper: &str) -> Composed {
    let l = limits();
    let reg = registry(keeper);
    match compose_turn(crate::llm::tests::stub_client(1), &ask(keeper, &l), &reg).await {
        Ok(c)   => c,
        Err(e)  => panic!("compose_turn for {}: {}", keeper, e),
    }
}

/// A Diamond's turn: the daimon, its crystal, standing files and objectives as blocks, the page's
/// limits with the Diamond's own K over them, the liveness, and the Diamond named for a fold.
/// Red before KT-3: the runner's agent held none of the blocks and no Diamond.
#[tokio::test]
async fn kt3_diamond_turn_is_the_daimons() {
    let c = composed("d1").await;
    let blocks = c.agent.blocks.borrow().clone();
    let lim = c.agent.limits();
    println!("KT-3 diamond: role {:?}, crystal {} B, req {} B, objectives {:?}, window {}, K {}, \
        liveness {}, diamond {:?}", c.role, blocks.get(Block::Crystal).len(),
        blocks.get(Block::Requirements).len(), blocks.get(Block::Objectives), lim.window,
        lim.no_progress_rounds, c.agent.liveness_ms(), c.agent.diamond());
    assert_eq!(c.role, Role::Daimon, "a Diamond's turn spoke as {:?}", c.role);
    assert!(c.agent.system_prompt.starts_with(&c.head), "the system message opens with the role");
    assert!(c.agent.system_prompt.contains("diamonds/d1/crystal.json"),
        "the system message names the Diamond's own folder: {}", c.local);
    assert!(blocks.get(Block::Crystal).contains("quillfeather"), "no crystal block");
    assert!(blocks.get(Block::Requirements).contains("Ship the ledger"), "no REQUIREMENTS block");
    assert!(blocks.get(Block::State).contains("Halfway"), "no STATE block");
    assert!(blocks.get(Block::Decisions).contains("one ledger"), "no DECISIONS block");
    assert!(!blocks.get(Block::Objectives).is_empty(), "no objectives block");
    assert_eq!(c.crystal, CRYSTAL, "the whole crystal is kept for the after-turn diff");
    assert_eq!(lim.window, 1_048_576, "the window is not the page's: {}", lim.window);
    assert!((lim.fold_at - 0.8).abs() < 1e-9, "the fold band is not the page's: {}", lim.fold_at);
    assert_eq!(lim.no_progress_rounds, 20, "the Diamond's own K is not applied after the limits");
    assert_eq!(c.agent.liveness_ms(), 45_000, "the liveness is not the caller's");
    assert_eq!(c.agent.diamond(), "d1", "the Diamond is not named for a fold");
}

/// A chat's turn: the chat's role, and none of a Diamond's blocks or name.
#[tokio::test]
async fn kt3_chat_turn_is_the_chats() {
    let c = composed("chat:c1").await;
    let blocks = c.agent.blocks.borrow().clone();
    println!("KT-3 chat: role {:?}, crystal {} B, diamond {:?}", c.role,
        blocks.get(Block::Crystal).len(), c.agent.diamond());
    assert_eq!(c.role, Role::Chat, "a chat's turn spoke as {:?}", c.role);
    for b in [Block::Crystal, Block::Requirements, Block::State, Block::Decisions, Block::Objectives] {
        assert!(blocks.get(b).is_empty(), "a chat's turn carried {:?}", b);
    }
    assert_eq!(c.agent.diamond(), "", "a chat's turn named a Diamond");
    assert_eq!(c.agent.limits().window, 1_048_576, "the chat's window is not the page's");
}

/// An `away:` keeper's turn: its daimon's role, and none of a Diamond's blocks or name, since its
/// store is not here.
#[tokio::test]
async fn kt3_away_turn_is_the_daimons_without_the_diamond() {
    let c = composed("away:d1").await;
    let blocks = c.agent.blocks.borrow().clone();
    assert_eq!(c.role, Role::Daimon, "an away turn spoke as {:?}", c.role);
    assert!(c.local.is_empty(), "an away turn named a folder here: {}", c.local);
    for b in [Block::Crystal, Block::Requirements, Block::State, Block::Decisions, Block::Objectives,
        Block::Activity, Block::Attached]
    {
        assert!(blocks.get(b).is_empty(), "an away turn carried {:?}", b);
    }
    assert_eq!(c.agent.diamond(), "", "an away turn named a Diamond");
}

/// A Diamond that predates a standing file has it seeded from the template through the turn's own
/// Host, its licensed write, and the turn is shown the seed.
#[tokio::test]
async fn kt3_diamond_turn_seeds_a_missing_standing_file() {
    let l = limits();
    let reg = registry_holding("d1", &[("REQUIREMENTS.md", REQUIREMENTS), ("STATE.md", STATE)]);
    let c = match compose_turn(crate::llm::tests::stub_client(1), &ask("d1", &l), &reg).await {
        Ok(c)   => c,
        Err(e)  => panic!("compose_turn: {}", e),
    };
    let seeded = reg.ctx.host().fs().peek(FileRoot::Opfs, "diamonds/d1/DECISIONS.md");
    let template = crate::tools::standing_template(crate::tools::DECISIONS_FILE);
    assert_eq!(seeded.as_deref(), Some(template.as_bytes()), "DECISIONS.md was not seeded");
    assert_eq!(c.files.decisions, template, "the turn was not shown the seed");
}

/// A run spawned with no keeper composes no Diamond: nothing is seeded under an empty name and no
/// Diamond's blocks are carried (a keeperless runner turn failed on `store_file_read` of `''`).
#[tokio::test]
async fn kt3_keeperless_turn_holds_no_diamond() {
    let l = limits();
    let reg = registry("");
    let c = match compose_turn(crate::llm::tests::stub_client(1), &ask("", &l), &reg).await {
        Ok(c)   => c,
        Err(e)  => panic!("compose_turn with no keeper: {}", e),
    };
    let blocks = c.agent.blocks.borrow().clone();
    for b in [Block::Crystal, Block::Requirements, Block::State, Block::Decisions, Block::Objectives] {
        assert!(blocks.get(b).is_empty(), "a keeperless turn carried {:?}", b);
    }
    assert_eq!(c.agent.diamond(), "", "a keeperless turn named a Diamond");
    assert!(reg.ctx.host().fs().peek(FileRoot::Opfs, "REQUIREMENTS.md").is_none(),
        "a keeperless turn seeded a standing file");
}
