//! Types the ui port names, shared by every host.

use crate::{
    engine::host::{
        DefaultHost,
        Host,
    },
    tools::{
        LookBy,
        ToolContext,
    },
};

/// One photograph of the current view: the PNG bytes and the pixel size drawn.
pub struct Shot {
    pub png:   Vec<u8>,
    pub w:     u32,
    pub h:     u32,
    // The text table of a Diamond page's measurement (`in:"crystal"`), else empty; `png` is
    // then empty too when the page measured but could not be drawn, and the table says why.
    pub table: String,
    // The load proof's verdict (`pass` or `FAIL: ...`) when the request asked for one, else empty,
    // and the debug nodes the page showed.
    pub proof: String,
    pub debug: u32,
    // The page's console and the channel's messages, capped and scrubbed by the driver (K3).
    pub trace: String,
}

/// What the Diamond's images model made of one picture, and what that cost.
pub struct Look {
    pub text:   String,
    pub model:  String,
    pub tokens: u64,
    pub usd:    f64,    // nought when the provider reported no cost
    pub by:     LookBy, // the Diamond's choice, or which rule chose the account's default
}

/// The outcome of asking the images model to look.
pub enum Looked {
    Seen(Look),
    NoModel,            // none is set for this Diamond nor any seeing model priced on the account
    Failed(String),
}


/// What came back from asking the panel for one message's bytes.
///
/// A refusal is an ANSWER and not an error, exactly as it is for the Social panel: no such
/// mailbox, no such message, nothing synced -- each is something the model can act on and
/// must read in its own language, so it comes back as a sentence to relay rather than as an
/// `Err` the dispatcher would dress in a failure line.
#[derive(Clone, Debug)]
pub enum Read {
    Bytes(Vec<u8>),
    Refused(String),
}


/// What came back from asking the panel what one act would publish.
///
/// A refusal is an ANSWER and not an error.  Every reason a compose can fail -- no voice on the
/// forge, a proposal number that is not there, an act this build does not have -- is something
/// the model can act on and must be told in its own language, so it comes back as a sentence to
/// hand over rather than as an `Err` the dispatcher would dress in a failure line.
#[derive(Clone, Debug)]
pub enum Composed {
    // Ready to put to the user.  `token` is opaque on this side on purpose: Rust must not be
    // able to assemble one, or the binding between what was seen and what is sent is a
    // convention rather than a mechanism.
    Draft {
        shown: String,	// exactly what the user is shown
        token: String,	// the panel's handle on the payload those characters describe
    },
    Refused(String),	// nothing was composed, and this is what the model reads instead
}


/// How far a gather may reach, since it follows paths the call never named.
///
/// The tool guard can only check the paths a call NAMES, and a project is a
/// closure: one path goes in and a hundred files are read.  `file_search` and
/// `file_glob` have exactly this shape and answer it by re-asking the turn about
/// every entry they reach, so this re-asks too rather than inventing a second
/// convention.  Dispatching the model's `typst_compile` at the gatherer without
/// this would have widened one named read into a walk that could climb out of a
/// chat's folder by writing `#import "../../elsewhere.typ"` in a source.
pub enum Reach<'a, H: Host = DefaultHost> {
    // Anywhere in the workspace: the page's own Compile button, which is the
    // user opening a file they marked in themselves.
    Workspace,
    // Only what this turn may read, and never above its compartment.
    Turn(&'a ToolContext<H>),
}

