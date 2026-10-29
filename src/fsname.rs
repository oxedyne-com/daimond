//! One path component, spelled so that a browser's filesystem will accept it.
//!
//! A workspace path is Daimond's own idea and a filesystem's name is the platform's, and the two
//! do not agree about which characters exist.  A Maildir message is called
//! `<uid>.<uidvalidity>.daimond:2,<flags>` — the `:2,` is the standard's, not ours — and that name
//! is refused outright by the File System Access API on any root that is not a modern browser's
//! sandbox:
//!
//! ```text
//! TypeError: Failed to execute 'getFileHandle' on 'FileSystemDirectoryHandle':
//! Name is not allowed.
//! ```
//!
//! ## Which characters, and on the authority of what
//!
//! Three rules are in play and only the loosest of them is the web standard's:
//!
//! - The **File System Standard** defines a *valid file name* as "a string that is not an empty
//!   string, is not equal to `.` or `..`, and does not contain `/` or any other character used as
//!   path separator on the underlying platform" (<https://fs.spec.whatwg.org/>).  That is the
//!   floor, and it is all a conforming engine must enforce.
//! - **Chromium's sandbox (OPFS)** enforces exactly that floor plus `\`.  Its
//!   `FileSystemAccessManagerImpl::IsSafePathComponent` returns early for
//!   `storage::kFileSystemTypeTemporary` with the comment "The names of files in sandboxed file
//!   systems are obfuscated before they end up on disk … We don't need to worry about
//!   platform-specific restrictions", testing only `!= "."`, `!= ".."`, and the absence of `/` and
//!   `\`.  Measured on Chrome 149 and 150 and on Firefox 151: `70074.3.daimond:2,` is accepted.
//! - **Every other root** — a real local folder opened through `showDirectoryPicker`, and
//!   Chromium's own sandbox before that early return was added — falls through to
//!   `base::i18n::IsFilenameLegal`, whose illegal set is
//!   the ICU pattern `[["*/:<>?\\|][:Cc:][:Cf:]]` (`base/i18n/file_util_icu.cc`), plus the
//!   non-characters, plus whitespace, `.` and `~` at either end.
//!
//! So the characters this module escapes are the printable members of that strict set plus the C0
//! controls and `DEL`:
//!
//! ```text
//! "  *  :  <  >  ?  \  |     and  0x00-0x1F, 0x7F
//! ```
//!
//! `/` is in the strict set and is NOT in that list, for a reason set out at [`is_reserved`]: a
//! path component cannot contain one, so escaping it is dead code, and recognising `%2F` on the
//! way back would split a name people really have into path components they never asked for.
//!
//! What it deliberately does NOT escape is the position-dependent part of the strict rule — a
//! leading or trailing space, `.` or `~`.  Those are legal in every sandbox, `foo.txt~` is a name
//! people really have, and escaping them would change a name that is already on disk for no
//! reported gain.  A real folder still refuses them; that is a separate defect and this is not it.
//!
//! ## The shape, and why the escape is conditional
//!
//! Percent escapes, because they are the one convention a reader recognises on sight, and the
//! store is meant to be legible by eye when something goes wrong.  Only the offending bytes are
//! touched, so `crystal.json` is `crystal.json` on disk and every ordinary name is byte-identical
//! to what it was before this module existed.
//!
//! The marker has to be escapable or the encoding is not reversible — but escaping every `%` would
//! rewrite `file%20name`, which is a legal name somebody may already have, and rewriting a name
//! that is already on disk is a migration.  **No injective encoding can be the identity on every
//! legal name**: the identity on the legal set already uses the whole legal set as its image, so
//! there is nowhere left for an illegal name to go.  Something has to move, and the choice here is
//! to move as little as possible: `%` is escaped **only when the three characters starting at it
//! spell an escape this codec could itself have emitted** — `%25`, or `%` followed by the
//! upper-case hex of one of the reserved bytes above.  `file%20name` is untouched (`%20` is a
//! space, which is not reserved here); `a%3Ab` is not (it would decode to `a:b`).  Lower case is
//! never recognised, because the encoder never emits it, so `a%3ab` is untouched too.
//!
//! ## Length
//!
//! No cap is imposed.  Measured, a name of 8192 characters is accepted by Chromium's and Firefox's
//! sandbox, and imposing a limit here would newly refuse long names that work today.  A real
//! folder is bounded by the platform (255 bytes per component on Linux and macOS) and an escape
//! costs two bytes; a Maildir name is about twenty-five characters, so the inflation that matters
//! to the defect this module fixes is nil.

use oxedyne_fe2o3_core::prelude::*;


/// The escape marker.
const MARK: u8 = b'%';

/// Whether a byte must be escaped to survive a filesystem that applies the strict rule.
///
/// The C0 controls and `DEL` are Unicode category Cc; the eight punctuation marks are the printable
/// part of ICU's `illegal_anywhere_` set.  All are ASCII, so a multi-byte UTF-8 sequence can never
/// contain one and passes through untouched.
///
/// `/` IS ABSENT AND THAT IS THE POINT.  It is in ICU's set, but a path component cannot contain
/// one — the splitter in [`crate::wasm::opfs`] consumes every separator before a name is formed —
/// so escaping it would be dead code, while RECOGNISING `%2F` on the way back would not be.
/// `https%3A%2F%2Fexample.com.html` is a name people really have, from saving a page under its
/// URL; decoding its `%2F` would hand a caller `https://example.com.html`, which the next path
/// join reads as three components and opens nothing.  Left out, that name decodes to something
/// harmless and encodes straight back to itself, so the file still opens.
pub fn is_reserved(b: u8) -> bool {
    matches!(b,
        0x00..=0x1F
        | 0x7F
        | b'"'
        | b'*'
        | b':'
        | b'<'
        | b'>'
        | b'?'
        | b'\\'
        | b'|')
}

/// The upper-case hexadecimal digit for a nibble.
fn hex_digit(n: u8) -> u8 {
    match n {
        0..=9 => b'0' + n,
        _     => b'A' + (n - 10),
    }
}

/// The value of an upper-case hexadecimal digit, or `None` for anything else.
///
/// Lower case is refused on purpose: the encoder emits upper case only, so refusing lower case
/// here leaves `a%3ab` alone rather than reading it as an escape somebody never wrote.
fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'A'..=b'F' => Some(10 + (b - b'A')),
        _           => None,
    }
}

/// The byte an escape at the head of `w` stands for, or `None` when `w` does not begin with one
/// this codec could have emitted.
///
/// The recognised set is exactly the encoder's output alphabet: the reserved bytes, and `%25` for
/// the marker itself.  Anything else beginning with `%` is a literal percent sign.
fn escaped(w: &[u8]) -> Option<u8> {
    if w.len() < 3 || w[0] != MARK {
        return None;
    }
    let hi = match hex_value(w[1]) { Some(v) => v, None => return None };
    let lo = match hex_value(w[2]) { Some(v) => v, None => return None };
    let b = (hi << 4) | lo;
    if is_reserved(b) || b == MARK {
        Some(b)
    } else {
        None
    }
}

/// Spell `name` so a filesystem will take it.
///
/// The identity on every name that holds none of the reserved bytes and none of this codec's own
/// escape sequences, which is every ordinary name.
///
/// # Arguments
/// * `name` - One path component, as the workspace spells it.
pub fn encode(name: &str) -> String {
    let src = name.as_bytes();
    let mut out = String::with_capacity(src.len());
    let mut run = 0;                             // start of the untouched run
    let mut i = 0;
    while i < src.len() {
        let b = src[i];
        // A reserved byte becomes its escape; a marker becomes one only when leaving it alone
        // would let the decoder read the next three characters as an escape.
        let esc = if is_reserved(b) {
            Some(b)
        } else if b == MARK && escaped(&src[i..]).is_some() {
            Some(MARK)
        } else {
            None
        };
        if let Some(v) = esc {
            // Both ends of the slice sit on an ASCII byte, so this can never split a character.
            out.push_str(&name[run..i]);
            out.push(MARK as char);
            out.push(hex_digit(v >> 4) as char);
            out.push(hex_digit(v & 0x0F) as char);
            run = i + 1;
        }
        i += 1;
    }
    out.push_str(&name[run..]);
    out
}

/// Read a stored name back as the workspace spells it.  The exact inverse of [`encode`].
///
/// # Arguments
/// * `name` - One path component, as it is stored.
pub fn decode(name: &str) -> String {
    let src = name.as_bytes();
    let mut out = String::with_capacity(src.len());
    let mut run = 0;                             // start of the untouched run
    let mut i = 0;
    while i < src.len() {
        match escaped(&src[i..]) {
            Some(v) => {
                out.push_str(&name[run..i]);
                out.push(v as char);
                i += 3;
                run = i;
            }
            None => i += 1,
        }
    }
    out.push_str(&name[run..]);
    out
}

/// Spell a whole workspace-relative path, component by component.
///
/// The separators are the path's own and are not names, so they are left where they are.  Used by
/// the callers that hold a path rather than a component; the filesystem edge itself works one
/// component at a time.
pub fn encode_path(path: &str) -> String {
    path.split('/').map(encode).collect::<Vec<_>>().join("/")
}

/// The Web Lock every writer of one file holds from before it opens the file until after it
/// closes it: `daimond-file:<root>:<path>`, `root` being `folder` for the real folder the user has
/// open and `sandbox` for this account's browser storage (OPFS-LOCK, 2026-10-17).
///
/// **A writable's bytes are private until it closes**, so a restore's compare-and-swap could only
/// see a rival that had already closed: two restores both "won", and a sync or upload write
/// closing in the gap was overwritten and kept in no version row.  Under this lock the check and
/// the close are one step against every writer in the origin.
///
/// THE SAME RULE AS `www/js/filelock.js` `name`, and `filelock.test.mjs` holds the two to the same
/// table: empty and `.` components dropped, `..` taken back (never past the root), lower case,
/// joined by `/`.  Two names for one file would be no lock; one name for two files (a case pair on
/// a disk that keeps case) is only a short wait.
///
/// **`..` is taken back here because this side's walk takes it back** (`opfs::split_components`),
/// so the name is the file written.  The page's walks DROP `..` instead, so the page refuses a path
/// with `..` at the lock, before anything opens (OPFS-LOCK check2, D5): no path is ever locked
/// under one name and written under another.
pub fn file_lock_name(folder: bool, path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for c in path.split('/') {
        match c {
            "" | "."    => {},
            ".."        => { out.pop(); },
            _           => out.push(c),
        }
    }
    let root = match folder {
        true  => "folder",
        false => "sandbox",
    };
    fmt!("daimond-file:{}:{}", root, out.join("/").to_lowercase())
}


#[cfg(test)]
#[path = "../tests/unit/fsname/tests.rs"]
mod tests;
