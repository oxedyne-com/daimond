//! One composition of a turn, for the tab and the runner alike.
//!
//! KT-3 (24 Oct 2026, invariant 8): the tab composed a Diamond's turn in
//! `wasm::app::compose_daimon` and the runner composed its own in `run.rs::agent_turn`, and the
//! two drifted: a runner turn on a Diamond carried no crystal, no standing files and no
//! `set_diamond`, so a fold's notes were never filed (F8).  The composition lives here now, and
//! what differs between the two (OPFS against the store) is read through the [`Host`] ports the
//! tools already use.

use crate::{
    agent::Agent,
    diamond_versions::Seen,
    engine::{
        host::{
            Host,
            clock::HostClock,
            fs::HostFs,
            store::HostStore,
        },
        turn::TurnLimits,
    },
    llm::LlmClient,
    marks::Reach,
    prompts::{
        Block,
        Role,
        TurnBlocks,
    },
    tools::{
        FileRoot,
        KeeperKind,
        Standing,
        Tool,
        ToolContext,
        ToolRegistry,
    },
};

use oxedyne_fe2o3_core::prelude::*;

/// Where a turn's limits come from.
pub enum Limited<'a> {
    Page(&'a TurnLimits),   // the page's own, carried on the errand (the runner)
    Adopted(&'a Agent),     // the app agent's, copied as `Agent::adopt_limits` copies them (the tab)
    Kept,                   // the long-lived agent's own, as the page set them (the tab's chat)
}

/// What a turn's caller holds that the engine cannot read for itself.
pub struct Ask<'a> {
    pub keeper:         &'a str,            // a Diamond id, `chat:…` or `away:…`
    pub own:            &'a str,            // the person's own role prompt, empty for the default
    pub steer:          &'a str,            // this Diamond's steering notes
    pub instructions:   &'a str,            // the person's standing instructions
    pub today:          &'a str,            // the `Today` block, composed where the clock's zone is known
    pub reach:          Option<&'a Reach>,  // what the marks put in reach, `None` where unread here
    pub limits:         Limited<'a>,
    pub liveness_ms:    u64,                // zero leaves the engine's own
}

/// One turn, composed.
pub struct Composed {
    pub agent:      Agent,
    pub role:       Role,
    pub head:       String,     // the role's composition, what the turn's author is fingerprinted over
    pub local:      String,     // what is true of this Diamond on this turn, after `head`
    pub crystal:    String,     // the whole crystal as read, for the after-turn diff
    pub files:      Standing,   // the three standing files as read
    pub rooted:     Option<bool>,
}

/// The role a turn speaks as, from its keeper: a chat's is the chat's, a Diamond's (held or away)
/// its daimon's.
pub fn role_of(keeper: &str) -> Role {
    match KeeperKind::of(keeper) {
        KeeperKind::Chat    => Role::Chat,
        _                   => Role::Daimon,
    }
}

/// The role's text over the person's own, on `model`, with `steer` and the alias table.
pub fn role_text(role: Role, own: &str, model: &str, steer: &str, claude_names: bool) -> String {
    role.compose_wire_with(own, model, steer, claude_names)
}

/// A system prompt: the role, then the person's standing instructions.
pub fn with_instructions(role: &str, md: &str) -> String {
    if md.trim().is_empty() {
        return role.to_string();
    }
    fmt!("{}\n\n## Standing instructions from the user\n\n{}", role, md.trim())
}

/// The role a turn speaks as and its system message, composed for `model` on `registry`.
pub struct Head {
    pub role:   Role,
    pub head:   String,     // the role's composition, what the turn's author is fingerprinted over
    pub local:  String,     // what is true of this Diamond on this turn, after `head`
    pub system: String,     // `head` and `local` in send order, then the standing instructions
}

/// The system message of `ask`'s turn on `model`.
///
/// A long-lived agent's system message is fixed when it is built (the tab's chat, from the page's
/// `Prompts.role`, which is this same composition with no instructions), so only a fresh agent
/// takes it from here; every other part of the turn is set by [`compose_onto`].
pub fn compose_head<H: Host>(model: &str, ask: &Ask<'_>, registry: &ToolRegistry<H>) -> Head {
    let role = role_of(ask.keeper);
    let head = role_text(role, ask.own, model, ask.steer, registry.claude_names());
    let mut local = String::new();
    if let Some(id) = held_diamond(ask.keeper) {
        // Where this daimon stands, said per turn because only the turn knows the id: the role
        // text is one constant every Diamond shares and its owner may rewrite.
        let dir = crate::store::diamond::diamond_dir(id);
        local.push_str("\n\nThis Diamond's own folder is `");
        local.push_str(&dir);
        local.push_str("/`, so its crystal is `");
        local.push_str(&dir);
        local.push_str("/crystal.json` and its page is the `crystal.html` beside it. Paths you \
            give the file tools are whole workspace-relative paths, never bare names.");
        // K4: the page to fork, so a new page starts from the channel and the infographic parts
        // rather than from whatever page this Diamond last carried.
        local.push_str(" To build a new page, fork `");
        local.push_str(crate::tools::CRYSTAL_STARTER_PATH);
        local.push_str("`: it speaks the channel and draws cards, rings, bars, a timeline and a \
            spectrum from the data's keys.");
    }
    let system = with_instructions(&fmt!("{}{}", head, local), ask.instructions);
    Head { role, head, local, system }
}

/// What [`compose_onto`] read for the turn and its caller keeps.
#[derive(Default)]
pub struct Read {
    pub crystal:    String,     // the whole crystal as read, for the after-turn diff
    pub files:      Standing,   // the three standing files as read
    pub rooted:     Option<bool>,
}

/// **THE ONE COMPOSITION OF A TURN'S PARTS** (KT-3, invariant 8): `ask`'s limits, briefing and
/// blocks set on `agent`, and for a Diamond this store holds its crystal, standing files,
/// activity, objectives and name.  The tab's chat agent lives across turns and the runner's is
/// fresh, so both take their parts from here and the two cannot drift.
///
/// An `away:` keeper speaks as its daimon with none of a Diamond's blocks: its store is not here.
pub async fn compose_onto<H: Host>(agent: &Agent, ask: &Ask<'_>, registry: &ToolRegistry<H>)
    -> Outcome<Read>
{
    match &ask.limits {
        Limited::Page(l)    => res!(l.apply(agent)),
        // The liveness limit is not one `adopt_limits` carries, and a steer's turn is held to the
        // app's clock, not the engine's default.
        Limited::Adopted(a) => {
            agent.adopt_limits(a);
            agent.set_liveness_ms(a.liveness_ms());
        },
        Limited::Kept       => (),
    }
    if ask.liveness_ms > 0 {
        agent.set_liveness_ms(ask.liveness_ms);
    }
    let (brief, mut blocks, rooted) = briefing(&agent.llm, registry, ask.today).await;
    let mut read = Read { rooted, ..Read::default() };
    if let Some(id) = held_diamond(ask.keeper) {
        let host = registry.ctx.host();
        // AND THEN THIS DIAMOND'S OWN K (UNBLOCK-27 R4), after the limits, which are shared by
        // every Diamond on this model.
        agent.set_no_progress_rounds(host.store().no_progress_rounds(id).await);
        let tune = agent.limits();
        // Read ONCE here, so the blocks are byte-stable for every round of this turn.
        read.crystal = host.store().read_crystal_data(id).await.unwrap_or_default();
        let (files, notes) = res!(crate::standing::ensure_standing_in(
            &HostStanding { ctx: &registry.ctx }, id).await);
        for note in notes {
            crate::store::own::console_log(&fmt!("Diamond '{}': {}", id, note));
        }
        // THE `nofiles` MEASUREMENT ARM'S OWN DOOR: the files are read and kept for the turn-end
        // diff regardless, but this turn's prompt is shown none of them when the switch is off,
        // so the crystal gets the hot room back. See `dev/CRYSTAL_CONTRACT.md` §5.
        let shown = match tune.standing_files {
            true    => files.clone(),
            false   => Standing::default(),
        };
        let split = crate::tools::crystal_split(
            &read.crystal, crate::tools::crystal_hot_room(shown.hot_bytes())).unwrap_or_default();
        // Blocks of the turn's own note, restated only when they change, so the system message
        // stays the cached head of every request in the conversation (r578, ruling §17).
        blocks.set(Block::Crystal,       &crate::tools::crystal_block_for(&split, &shown, true));
        blocks.set(Block::Requirements,  &shown.requirements_text());
        blocks.set(Block::State,         &shown.state_text());
        blocks.set(Block::Decisions,     &shown.decisions_text());
        if let Some(reach) = ask.reach {
            blocks.set(Block::Attached, &attached(reach));
        }
        // WHAT THIS DIAMOND'S TURNS DID, on every device (UNBLOCK-11), newest first.
        let activity: Vec<String> = host.store().activity_read_all(id).await
            .into_iter().map(|(_, text)| text).collect();
        blocks.set(Block::Activity,
            &crate::activity::prompt_from(&activity, host.clock().now_ms() as i64));
        // Parsed from the SAME read of `REQUIREMENTS.md` the block above carries, so the figure
        // agrees with what the model is shown (`dev/CRYSTAL_CONTRACT.md` §5.1).
        blocks.set(Block::Objectives,
            &crate::tools::requirements_briefing(&files.requirements, tune.briefing_top3));
        read.files = files;
        // WHICH DIAMOND, so a fold mid-turn files what it is about to forget into the three
        // files rather than a note re-summarised at the next fold (`dev/CRYSTAL_CONTRACT.md` §13).
        agent.set_diamond(id);
    }
    // U12b: Block::Notes, a chat's NOTES.md, goes here.  A fold files his words into the words log
    // beside it (`WORDS.md`, CCP3 F1); an away Diamond's log is not here, so it files none.  Set on
    // every host (invariant 8): on a runner it is the store that answers "not filed" (CCP3 item 4).
    agent.set_words_home(match KeeperKind::of(ask.keeper) {
        _ if ask.keeper.is_empty()  => "",
        KeeperKind::Away            => "",
        KeeperKind::Chat
        | KeeperKind::Diamond       => ask.keeper,
    });
    registry.set_machine_rooted(rooted);
    agent.set_briefing(&brief);
    agent.set_blocks(blocks);
    Ok(read)
}

/// Compose one turn on a fresh agent over `llm` for `ask`, on `registry`, the turn's own.
pub async fn compose_turn<H: Host>(llm: LlmClient, ask: &Ask<'_>, registry: &ToolRegistry<H>)
    -> Outcome<Composed>
{
    let Head { role, head, local, system } = compose_head(&llm.model, ask, registry);
    let agent = Agent::new(llm, &system);
    let Read { crystal, files, rooted } = res!(compose_onto(&agent, ask, registry).await);
    Ok(Composed { agent, role, head, local, crystal, files, rooted })
}

/// The briefing every turn carries: the model note in the system message's briefing, and the
/// blocks of what the turn can reach (the machine, the day, the tree, the packs).
///
/// Each part is said only where it can be acted on: the machine where the belt holds `run`, the
/// tree where it holds the file tools, the packs where any is unbought.  The third value is
/// whether a command has anywhere to run (`None` where the belt holds no `run`), which the
/// turn's owner sets on its own registry and a view of the request does not.
///
/// # Arguments
/// * `today` - The `Today` block, composed where the clock's zone is known; empty sets none.
pub async fn briefing<H: Host>(llm: &LlmClient, registry: &ToolRegistry<H>, today: &str)
    -> (String, TurnBlocks, Option<bool>)
{
    let mut blocks = TurnBlocks::default();
    // Read off the client that will carry the request, never a constant.  THE MODEL NOTE ALONE
    // STAYS IN THE SYSTEM MESSAGE: it changes only with a model switch, a new cache epoch anyway.
    let s = crate::prompts::model_note(&llm.model, &llm.host,
        registry.tools.contains(&Tool::SpawnAgent));
    let mut rooted = None;
    // The machine only where a command can be run on it, as the fence it will run under.
    if registry.tools.contains(&Tool::Run) {
        let (machine, on) = crate::prompts::machine_briefing(&registry.ctx).await;
        blocks.set(Block::Machine, &machine);
        rooted = Some(on);
    }
    // WHAT DAY IT IS, which no model knows; see `prompts::today_note`.
    if !today.is_empty() {
        blocks.set(Block::Today, today);
    }
    // WHERE THE TURN IS, before anything else it may need: a wrong-root first read cost 44 rounds
    // over 16 trials on the bank.  Only where the turn holds file tools.
    if registry.tools.iter().any(|t| matches!(t, Tool::FileRead | Tool::FileList)) {
        let note = crate::tools::orientation_tree(
            &registry.ctx, &registry.ctx.cwd, &registry.ctx.no_write).await;
        blocks.set(Block::Tree, &note);
    }
    // What the account has NOT bought, since those tools are not in the request at all.
    if let Some(packs) = registry.locked_pack_note() {
        blocks.set(Block::Packs, &packs);
    }
    (s, blocks, rooted)
}

/// The Diamond this store holds that `keeper` names; `None` for a chat's, an `away:` one's and
/// none at all.
fn held_diamond(keeper: &str) -> Option<&str> {
    // A run spawned with no keeper (`SpawnSpec::keeper` empty, granted nothing) keeps into no
    // Diamond; `KeeperKind::of` would read the empty name as one and seed files under `''`.
    if keeper.is_empty() {
        return None;
    }
    match KeeperKind::of(keeper) {
        KeeperKind::Diamond => Some(keeper),
        KeeperKind::Chat
        | KeeperKind::Away  => None,
    }
}

/// What the marks put in reach, as the turn's `Attached` block says it.
///
/// Naming the marks is worth its tokens: a daimon whose user had just attached a book globbed
/// for it, found nothing where it was pinned, and reported that the book did not exist.  A mark
/// made on another device is out of reach here until confirmed, and a daimon told so asks the
/// user for the one press rather than working around the refusal.
pub fn attached(reach: &Reach) -> String {
    let marked = reach.places();
    let consult = &reach.read_only;
    let waiting = &reach.unconfirmed;
    let mut out = String::new();
    if marked.is_empty() && consult.is_empty() && waiting.is_empty() {
        out.push_str(" Nothing is attached to this Diamond yet, so the folder above is the \
            only place you may write. If the user asks for work on files that are not there, \
            say which folder to add with the + in the Workspace group rather than creating it.");
    } else if marked.is_empty() && consult.is_empty() {
        out.push_str(" Nothing attached to this Diamond is in force on this device yet, so \
            the folder above is the only place you may write.");
    } else {
        out.push_str("\n\nAttached to this Diamond, and reachable now:\n");
        for p in &marked {
            out.push_str("- `");
            out.push_str(p);
            out.push_str("` (yours to edit)\n");
        }
        for p in consult {
            out.push_str("- `");
            out.push_str(p);
            out.push_str("` (read it; do not edit it)\n");
        }
        out.push_str("Look at what is attached before you answer a question about it. You \
            may READ anywhere in the workspace, and you may write only in the places above.");
    }
    if !waiting.is_empty() {
        out.push_str("\n\nAdded to this Diamond on another device, or before this \
            device recorded added folders, and NOT yet in use on this device until the user confirms \
            them here:\n");
        for p in waiting {
            out.push_str("- `");
            out.push_str(p);
            out.push_str("` (unconfirmed on this device)\n");
        }
        out.push_str("You may read these but not write in them yet. If the work needs one, \
            tell the user it is unconfirmed on this device and ask them to confirm it -- one \
            press on the notice above the message box -- rather than working around it.");
    }
    out
}

/// The three standing files through a turn's own [`Host`]: OPFS in the page, the store on the
/// runner.  A seed is a licensed write, so a fence that refuses it is an error the seeding notes.
struct HostStanding<'a, H: Host> {
    ctx: &'a ToolContext<H>,
}

impl<H: Host> crate::standing::StandingStore for HostStanding<'_, H> {
    async fn read_bound(&self, path: &str) -> Outcome<Option<Vec<u8>>> {
        let fs = self.ctx.host().fs();
        match res!(fs.exists(FileRoot::Opfs, path).await) {
            false   => Ok(None),
            true    => Ok(Some(res!(fs.read_file(FileRoot::Opfs, path).await))),
        }
    }
    async fn write_if(&self, path: &str, bytes: &[u8], expect: Option<&Seen>)
        -> Outcome<Option<Seen>>
    {
        let lic = match self.ctx.licence(path) {
            Ok(l)   => l,
            Err(e)  => return Err(err!("{}", e; Invalid, Input)),
        };
        self.ctx.host().fs().write_licensed_then(FileRoot::Opfs, &lic, bytes, expect,
            || async { Ok(()) }).await
    }
}

#[cfg(test)]
mod tests;
