//! What a worker's turn is held to, apart from the page that shows it (U3a, UNBLOCK-16).
//!
//! [`liveness`]: the clock that says whether a turn's model stream is still making progress;
//! [`deadline`]: each tool call's own ceiling and the person-wait beat that holds it;
//! [`brief`]: a worker's brief judged against the worker's fence at dispatch.  The run's
//! ending and the dispatch pool join it in later units.

pub mod brief;
pub mod deadline;
pub mod liveness;

pub use deadline::Deadline;
pub use liveness::Liveness;
