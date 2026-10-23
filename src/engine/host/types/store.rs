//! Types the store port names, shared by every host.

use crate::diamond_versions::{Body, BodyRef, Seen};

use oxedyne_fe2o3_jdat::{FromDat, ToDat};

/// One of the crystal's two files, which keep the crystal chain rather than rows in the store.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ToDat, FromDat)]
pub enum CrystalHalf {
    Data,   // crystal.json
    Page,   // crystal.html
}

/// One record's place in a run's journal (R1i): a settled round an actor writes, or the parent's
/// own record that the run is open.  Typed, so no reader can take the one for the other.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, ToDat, FromDat)]
pub enum JournalKey {
    Round(u64), // `<run>/<round>`, zero-padded
    Open,       // `<run>/open`
}

/// One run a journal listing names (R1i): its id, and whether the parent's open record is there.
#[derive(Clone, Debug, PartialEq, Eq, ToDat, FromDat)]
pub struct JournalRun {
    pub run:    String,
    pub open:   bool,
}

/// What a run's turn end must read for the store, which cannot read the person's files itself
/// (spec §16.3): every entry is a user path, keyed by the `Seen` the store expects there.  A
/// [`Standing`] is admitted only for an outstanding `(path, Seen)`, once.
#[derive(Clone, Debug, Default, Eq, PartialEq, ToDat, FromDat)]
pub struct Wants {
    pub own:     Vec<(String, Seen)>,   // the captures whose `after` is held or gone
    pub notes:   Vec<(String, Seen)>,   // the adoptable notes, neither a machine path nor away
    pub windows: Vec<(String, Seen)>,   // the paths the open windows credit
    pub large:   Vec<(String, BodyRef)>,    // each `own` capture whose `after` is `Large`
    pub wipe:    Vec<(String, Seen, BodyRef)>,  // each marked `Large` capture with its `before`
}

/// What the run found at a wanted path that did not stand as expected.  Only NotFound is
/// `Now(Body::Gone)`; any other failure to read is `Unknown`, never Gone.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum Standing {
    Now(Body),
    Unknown,
}

/// The most entries one page of a turn-end list carries (spec §16.3a 1).
pub const LIST_PAGE: usize = 256;

/// What a turn end's `drain_turn` answers: the count it took into the slot, which keeps the rest.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ToDat, FromDat)]
pub struct Drained {
    pub captured: u32,
}

/// A standing file's write as it will land, and the side files it leaves to write (UNBLOCK-18 F6).
///
/// **Plain data: nothing is written when one is made.**  [`HostStore::standing_retired`] only
/// reads and answers this; a door that can still refuse (`before_overwrite`, a restore's question)
/// would otherwise leave an archive entry, a DECISIONS line or a touched row for a write that
/// never happened.  Once the write is accepted the door calls
/// [`HostStore::standing_settle`] with it, and only then writes the file itself: archive first,
/// so a failure at any point leaves the retired text somewhere, never nowhere.
///
/// Every side file is named by what it is, never by a path: the store derives each path from the
/// standing file's own, so a run's child cannot name one outside it.
///
/// **Only what is new is carried, never a whole side file** (PORT-L QA B1): `noted` is the dated
/// lines to append to `DECISIONS.md` and `touched` the rows to set in the touched record.  The
/// store reads each file at settle time, appends, retires what is over the ceiling (archive
/// first) and writes it bound to what it read, so nothing written between a landing and its
/// settle is lost, and a child can name no body for either file.
///
/// [`HostStore::standing_retired`]: crate::engine::host::store::HostStore::standing_retired
/// [`HostStore::standing_settle`]: crate::engine::host::store::HostStore::standing_settle
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Landed {
    pub kept:      String,                  // the file to write
    pub said:      String,                  // what the tool result says moved
    pub archive:   Vec<(String, String)>,   // (standing leaf whose archive, text to append), first
    pub noted:     Vec<String>,             // dated lines to append to DECISIONS.md, one each
    pub touched:   Vec<String>,             // touched rows (`<ms>\t<key>`), each replacing its own
    pub from:      Option<Seen>,            // the bytes the landing was computed from, if it read
    pub at:        u64,                     // the landing's time (ms), which its removals compare
}

/// What a run's child asks the store to do to a Diamond's path that is not a write (HL5c): what
/// the tab's fs port does to a path in its own store, as [`crate::store::call::StoreCall::StoreFileAct`].
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum FileAct {
    /// Make the folder, and those above it.
    Mkdir,
    /// Remove the one ordinary file; never a folder.
    Delete,
    /// Move the file or folder to this path, in the same Diamond, where nothing stands.
    Move(String),
}

/// Which side files of a [`Landed`] one settle writes (held-lock settle P2).
///
/// `Archive` writes only the `.daimond/` archives, and is called under the target's lock before
/// the target is written; `Record` writes the `noted` lines into `DECISIONS.md` and the
/// `touched` rows, once the target has landed.  A phase never writes the other's files.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum SettlePhase {
    Archive,
    Record,
}

impl Landed {
    /// A write that lands exactly as it came, with nothing to settle.
    pub fn kept(text: String) -> Self {
        Self { kept: text, ..Self::default() }
    }

    /// True when settling it writes nothing.
    pub fn settles_nothing(&self) -> bool {
        self.archive.is_empty() && self.noted.is_empty() && self.touched.is_empty()
    }

    /// Only the parts of it that `phase` writes: the archive for `Archive`, the noted lines and
    /// touched rows for `Record`.  `kept`, `said`, `from` and `at` ride along unchanged.
    pub fn part(&self, phase: SettlePhase) -> Self {
        let mut out = self.clone();
        match phase {
            SettlePhase::Archive    => {
                out.noted.clear();
                out.touched.clear();
            },
            SettlePhase::Record     => out.archive.clear(),
        }
        out
    }
}
