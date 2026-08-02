//! Daimond's machine hand: the program outside the page that runs commands.
//!
//! A web page cannot create a process.  There is no flag and no future API, so
//! the capability has to live in a program outside the page, and the whole of
//! this crate's design is an answer to *where that program sits and who may
//! talk to it*.
//!
//! The answer is a **native messaging host**.  Chrome launches this binary and
//! connects it to one extension only; the extension is connectable from
//! `daimond.oxedyne.com` only.  There is therefore no port to find and no
//! secret to steal -- the browser is the doorman.  A loopback daemon would be
//! reachable by any page the user visits, and its entire defence would be one
//! pasted secret.
//!
//! Four things are kept apart on purpose:
//!
//! * [`wire`] -- what the two ends say to each other, and how it is framed.
//!   Designed for remote from the first line: loopback is the degenerate case
//!   of remote, and a localhost-only protocol is a rewrite waiting to happen.
//! * [`exec`] -- running a command.  **`argv` only, never a shell string**, so
//!   there is no injection surface to defend rather than a defence to get right.
//! * [`fence`] -- what a command may touch.  Platform-specific, and therefore
//!   behind an enum from the start with the platforms that are not built yet
//!   declared rather than forgotten.
//! * [`journal`] -- what was run, what it returned, and what it was stopped
//!   from doing.  Load-bearing: the product's claim is that it can be checked
//!   rather than trusted, and that claim has to cover the hand too.

use oxedyne_fe2o3_core::prelude::*;

pub mod codec;
pub mod exec;
pub mod fence;
pub mod journal;
#[cfg(unix)]
pub mod pty;
pub mod seccomp;
pub mod wire;

/// The wire protocol version this build speaks.
///
/// Sent in the opening [`wire::Req::Hello`] and answered in
/// [`wire::Resp::Hello`], so a hand and a page that have drifted say so on the
/// first exchange rather than at the first command that needs the difference.
pub const PROTO: u32 = 1;

/// The name this build reports to the page, for the device roster.
pub const HOST_NAME: &str = "daimond-hand";

/// The version string this build reports, taken from the manifest at compile time.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// The operating system this build runs on, as the wire spells it.
///
/// A single vocabulary, so the page can say "this hand cannot fence on Windows
/// yet" without parsing a target triple.
pub fn os() -> &'static str {
    if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "unknown"
    }
}

/// A guard against a build that reports an operating system it has no fence for.
///
/// # Returns
/// The OS name, or an error naming the platform that needs a [`fence`] arm.
pub fn checked_os() -> Outcome<&'static str> {
    match os() {
        "unknown" => Err(err!(
            "The hand does not know what platform it was built for, so it \
            cannot say what fence applies to it.";
            Unimplemented, Configuration)),
        name => Ok(name),
    }
}
