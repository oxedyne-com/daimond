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
//! * [`verify`] -- running a NAMED verifier out of the tracked tree, clean and
//!   under each break it declares, and refusing to report a passing count
//!   without the count of breaks that reddened nothing.
//! * [`journal`] -- what was run, what it returned, and what it was stopped
//!   from doing.  Load-bearing: the product's claim is that it can be checked
//!   rather than trusted, and that claim has to cover the hand too.

use oxedyne_fe2o3_core::prelude::*;

pub mod codec;
pub mod exec;
pub mod fence;
pub mod journal;
pub mod meter;
#[cfg(unix)]
pub mod pty;
pub mod seccomp;
pub mod verify;
pub mod wire;

/// The wire protocol version this build speaks.
///
/// Sent in the opening [`wire::Req::Hello`] and answered in
/// [`wire::Resp::Hello`], so a hand and a page that have drifted say so on the
/// first exchange rather than at the first command that needs the difference.
///
/// **2 since 2026-08-25**, when the two answers a walk and a read come back with
/// both changed shape: a read now opens with three numbers rather than one --
/// the whole file's lines, its bytes, and how many lines this answer holds --
/// and a search sends the LINES its pattern matched rather than whole file
/// texts.  Either read by the older parser is wrong in silence rather than
/// loudly, which is exactly what this number exists to stop.
pub const PROTO: u32 = 2;

/// The name this build reports to the page, for the device roster.
pub const HOST_NAME: &str = "daimond-hand";

/// The file, beside the journal, naming the one folder the hand may work in.
///
/// A file rather than an environment variable because the browser hands a
/// native messaging host *its own* environment, so nothing the user exports
/// reaches this program.  Here rather than in `main.rs` because [`journal`]
/// counts it as its own furniture: a directory holding the record and this file
/// and nothing else is one the hand made, and may be tightened to 0700.
pub const ROOT_FILE: &str = "root.txt";

/// The file, beside the journal, naming the widest a TERMINAL may ever reach.
///
/// A terminal is the user at a keyboard and a command is a daimon, and the two
/// deserve different sizes: the owner asked for exactly that on 2026-08-26, having
/// picked `~/usr` for the one root he had "for no reason other than I saw no need to
/// go higher".
///
/// It is a CEILING and not the working value.  The page may name a terminal's folder
/// within it and may never widen past it, which is the whole reason this lives on the
/// machine and is written by the installer: a page that could name its own root could
/// name a wider one, and every other rule here rests on its not being able to.
///
/// Absent, and a terminal gets [`ROOT_FILE`] exactly as before.
pub const TERMINAL_ROOT_FILE: &str = "terminal-root.txt";

/// The file, beside the journal, naming the tree the VERIFY verb resolves in.
///
/// The granted root is where a command may touch and is the folder the page
/// opened; a repository's verifiers live in `dev/` under ITS root, which is a
/// different tree, and a workspace that holds several projects has no
/// `dev/` of its own at all.  This file names that tree for the one verb that
/// runs unfenced, so a daimon seated in a wide workspace can still run the
/// repository's own verifiers.  The file is written by the person, like
/// [`ROOT_FILE`], and absent it is every hand built before this one: the verb
/// resolves in the granted root exactly as it always did.
pub const VERIFY_ROOT_FILE: &str = "verify-root.txt";

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

// ┌───────────────────────────────────────────────────────────────┐
// │ Which hand this is                                             │
// └───────────────────────────────────────────────────────────────┘

/// The binary this process was launched from, and the bytes it was launched
/// with.
///
/// WRITTEN BECAUSE A HAND THAT IS REPLACED ON DISK GOES ON RUNNING.  The
/// extension parks a hand for thirty seconds when its page goes, so a reload --
/// which is what a person does after installing a new one -- hands the SAME
/// process back to the new page.  On 2026-09-14 a hand installed at 01:02 sat
/// unused while a daimon measured the app against the one that started at 09:24
/// four days earlier, and nothing anywhere said which of the two it held.
pub struct Image {
    pub path: std::path::PathBuf,   // where the loader found it, empty if it would not say
    pub sha:  String,               // 8 hex of the bytes it was launched with, empty if unreadable
}

/// The image this process is running, read once and read EARLY.
///
/// `main` asks for it before it answers anything, so the hash is of the bytes
/// that are actually executing.  Asked for the first time after an install it
/// would hash the NEW file and report a hand that is already current, which is
/// the one wrong answer this exists to prevent.
pub fn image() -> &'static Image {
    static SEEN: std::sync::OnceLock<Image> = std::sync::OnceLock::new();
    SEEN.get_or_init(|| {
        let path = match std::env::current_exe() {
            Ok(p)  => p,
            Err(_) => std::path::PathBuf::new(),
        };
        let sha = short_sha(&path).unwrap_or_else(String::new);
        Image { path, sha }
    })
}

/// The first eight hex digits of a file's SHA-256, or nothing where it cannot be read.
///
/// Eight digits, because this is read by a person comparing two lines and not by
/// anything that has to be sure: the whole digest in a report is thirty-two
/// characters nobody reads.
pub fn short_sha(path: &std::path::Path) -> Option<String> {
    let bytes = match std::fs::read(path) {
        Ok(b)  => b,
        Err(_) => return None,
    };
    let full = oxedyne_fe2o3_hash::sha256::digest(&bytes);
    let mut s = String::with_capacity(8);
    for b in full.iter().take(4) {
        s.push_str(&fmt!("{:02x}", b));
    }
    Some(s)
}

/// Does the file this hand was launched from now hold different bytes?
///
/// False where either hash could not be taken: a hand that cannot read its own
/// file says nothing rather than claiming a hand it cannot see is newer.
pub fn image_changed() -> bool {
    let img = image();
    if img.sha.is_empty() {
        return false;
    }
    match short_sha(&img.path) {
        Some(now) => now != img.sha,
        None      => false,
    }
}

/// The one sentence a newer hand on disk earns, or nothing while it is the same hand.
///
/// It names the reload, because a reload is what a person will already have
/// tried: inside the extension's grace a reload hands the OLD process back, so
/// the sentence has to say that the hand changes when nothing is running rather
/// than promising something the grace can quietly refuse.
pub fn image_note() -> Option<String> {
    if !image_changed() {
        return None;
    }
    Some(fmt!(
        "A NEWER MACHINE HAND IS INSTALLED at '{}' and this process is still running the \
        older one ({}). Reload the page with nothing running and the new hand is taken; a \
        reload while a command is in flight keeps this one, because the extension holds a \
        busy hand across the reload.",
        image().path.display(), image().sha))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Where a fixture goes: the home cache and never `/tmp`, which is a tmpfs here.
    fn tree(name: &str) -> std::path::PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| fmt!("."));
        let dir  = std::path::PathBuf::from(home).join(".cache/daimond/hand-image").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    /// **The hash is of the bytes, so replacing the file changes it and touching it does not.**
    ///
    /// The whole of the staleness question is this comparison: a hand holds the hash it
    /// started with and asks the file whether it still matches.  An mtime would answer
    /// differently for a reinstall of identical bytes, which is not a newer hand.
    #[test]
    fn a_replaced_file_hashes_differently_and_a_rewritten_identical_one_does_not() {
        let dir = tree("replaced");
        let f   = dir.join("daimond-hand");
        assert!(std::fs::write(&f, b"one").is_ok());
        let first = short_sha(&f);
        assert!(first.is_some(), "a readable file gave no hash");
        // The same bytes again, written later: the same hand, so the same answer.
        assert!(std::fs::write(&f, b"one").is_ok());
        assert_eq!(first, short_sha(&f), "an identical rewrite read as a different hand");
        // Different bytes: a different hand.
        assert!(std::fs::write(&f, b"two").is_ok());
        assert_ne!(first, short_sha(&f), "a replaced binary read as the same hand");
        // A path with nothing at it says nothing rather than guessing.
        assert_eq!(None, short_sha(&dir.join("absent")));
        assert_eq!(8, first.unwrap_or_default().len());
    }

    /// This process is running the bytes it says it is, and does not claim otherwise.
    #[test]
    fn the_running_image_is_named_and_is_not_stale() {
        let img = image();
        assert!(!img.path.as_os_str().is_empty(), "the hand cannot say what it was launched from");
        assert_eq!(8, img.sha.len(), "the running image has no eight-digit hash: {}", img.sha);
        // Nothing has replaced the test binary under itself, so the note is silent. A note
        // that fired here would fire on every hand that had ever started.
        assert!(!image_changed(), "an unreplaced image read as changed");
        assert_eq!(None, image_note());
    }
}
