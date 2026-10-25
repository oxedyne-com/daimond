//! The ui port: the page's panels and asks, and the transitional worker relay (U3a moves the
//! pool into the engine and deletes `spawn` and `await_reports`).

use crate::{
    engine::host::{
        Host,
        types::ui::{
            Composed,
            Looked,
            Reach,
            Read,
            Shot,
        },
    },
    tools::{
        FileRoot,
        Shown,
    },
};

use oxedyne_fe2o3_core::prelude::*;

/// The ui port a [`Host`](super::Host) carries: today's `ask`, `deletes`, `doc`, `shot`, `social`,
/// `mail`, `typst` and `workers` functions, by the same names. `trail` is on [`HostStore`](super::store::HostStore).
/// What became of a checked question [`HostUi::put_ask`] was given.
#[derive(Clone, Debug, PartialEq)]
pub enum AskShown {
    /// Drawn on the page, as [`HostUi::put`] draws it: the engine answers the model in its own words.
    Page,
    /// Carried to the person another way (a runner's turn, RUNNER-ASK): the model is answered
    /// with these words, and the turn ends as it ends on the page.
    Said(String),
    /// Not put, for this reason in a sentence: the model is told so, and may ask again.
    Refused(String),
}

#[allow(async_fn_in_trait)]
pub trait HostUi {
    async fn put(&self, payload: &str) -> Outcome<()>;
    /// Put the `ask` tool's checked question before the person.  By default it is [`put`]'s, drawn
    /// on the page; a host with no page of its own (the runner) carries it home and says so.
    ///
    /// [`put`]: HostUi::put
    async fn put_ask(&self, payload: &str) -> Outcome<AskShown> {
        res!(self.put(payload).await);
        Ok(AskShown::Page)
    }
    /// Ask the person whether a turn keeping into `keeper`'s store may make `change` to `path`, a
    /// file of theirs, showing them `before` and the change (UNBLOCK-26 U5), and wait.  Every
    /// failure to ask is `Answer::Unanswered`, and nothing is written for a question nobody saw.
    async fn ask_change(&self, keeper: &str, path: &str, before: &[u8],
        change: crate::held_change::Change<'_>, turn: &str)
        -> crate::held_change::Answer;
    /// The turn is about to make a file at `path` where nothing stands.  A host that logs a
    /// turn's changes for Undo records it first and answers once it has (R2 U2b), so the record
    /// keeps the order of the turn's acts; every other host lets it go.
    async fn note_create(&self, _keeper: &str, _path: &str, _turn: &str)
        -> crate::held_change::Answer
    {
        crate::held_change::Answer::Apply
    }
    /// Ask the person whether `keeper`'s turn may go on past `limit` deletes of `path` (`count`
    /// so far), and wait.  `turn` is the asking turn's tag, so its Stop closes the question
    /// (r578e D2).
    async fn ask_to_go_on(&self, keeper: &str, path: &str, count: usize, limit: usize, act: &str,
        turn: &str)
        -> bool;
    async fn show(&self, path: &str, page: Option<u32>, owner: &str, turn: &str) -> Outcome<Shown>;
    async fn capture(&self, req: &str) -> Outcome<Shot>;
    async fn look(&self, id: &str, png: &[u8], prompt: &str) -> Outcome<Looked>;
    async fn read(&self, req: &str) -> Outcome<String>;
    async fn compose(&self, req: &str) -> Outcome<Composed>;
    async fn commit(&self, token: &str) -> Outcome<String>;
    async fn list(&self, req: &str) -> Outcome<String>;
    async fn search(&self, req: &str) -> Outcome<String>;
    async fn read_raw(&self, req: &str) -> Outcome<Read>;
    async fn put_draft(&self, req: &str) -> Outcome<String>;
    async fn sender(&self, req: &str) -> Outcome<String>;
    async fn compile_project<H: Host>(&self, reach: &Reach<'_, H>, root: FileRoot, main_rel: &str)
        -> Outcome<Vec<u8>>;
    async fn spawn(&self, payload: &str) -> Outcome<String>;
    async fn await_reports(&self, payload: &str) -> Outcome<String>;
    /// Hand one checked `pending_raise` (`raise`) or `pending_clear` call to the page's Pending
    /// panel, under the turn's own Diamond, and return its answer as JSON text.
    async fn pending(&self, raise: bool, diamond: &str, payload: &str) -> Outcome<String>;
    /// Search Diamond `diamond`'s daimon chat transcript, as the page keeps it on every device,
    /// for a `recall` call's `args` JSON; the matches as JSON text.  A host with no transcript
    /// refuses, saying so.
    async fn transcript_search(&self, diamond: &str, args: &str) -> Outcome<String>;
}
