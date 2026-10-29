//! Where a turn end reads the person's files (spec §16.3, d1_plan §9.2 D1s2b).
//!
//! A turn end reads what stands at a path three times: a capture read again under the hold
//! ([`StandingSource::standing`]), an adopted note's path ([`StandingSource::workspace_capped`]),
//! and the paths the turn's windows credit ([`StandingSource::changes`]).  A Diamond's own files
//! are the store's and are read from the backend; **only the person's are asked of the source**
//! ([`by_source`]).
//!
//! In the tab the source is [`CtxReads`], which makes today's reads at today's points, so the tab
//! is unchanged.  In the store process it is [`Staged`]: what the run's child read itself and sent
//! after [`turn_wants`](crate::store::diamond::turn_wants).  A path it was not sent, or could not
//! read, is unseen or cannot be told, never gone.

use crate::{
    diamond_versions::{self as versions, Body, BodyRef, Change, Seen, Stamp},
    engine::host::Host,
    store::{diamond, own},
    tools::{FileRoot, ToolContext},
};

/// The reads a turn end makes of the person's files.  Each is asked only for a path
/// [`by_source`] names.
#[allow(async_fn_in_trait)]
pub trait StandingSource {
    /// What stands at a capture's path now, for the question whether the turn's `after` is still
    /// there.  `None` where it cannot be told.
    async fn standing(&self, path: &str, after: &Body) -> Option<Body>;
    /// What stands at an adopted note's path now, read up to the per-file ceiling.
    async fn workspace_capped(&self, path: &str) -> Body;
    /// These paths as they stand, as changes ready to record ([`diamond::versions_changes`]).
    async fn changes(&self, id: &str, paths: &[String]) -> Vec<Change>;
    /// Did a capture whose `Large` `after` still stands leave the file wiped, against its
    /// `before`?  The child's `turn_wiped` answer (spec §16.3a 2 (b)); `None` where none was sent,
    /// and always in the tab, which never makes `Large`.
    async fn wiped(&self, path: &str, after: &Body) -> Option<bool>;
    /// A window path's stamp as it stands, for the question whether it is still what the last
    /// window to move it left there (the credit, [`diamond::drain_windows_by`]).  `None` where it
    /// cannot be told, which loses the credit and nothing else.
    async fn stamp(&self, path: &str) -> Option<Stamp>;
}

/// Is `path` the person's, so read through the source?  Natively, every path but a Diamond's own
/// files under the Workspace; in the tab every path, since the tab's reads are today's.
#[cfg(not(target_arch = "wasm32"))]
pub fn by_source(path: &str) -> bool { crate::store::native::is_user(FileRoot::Workspace, path) }
#[cfg(target_arch = "wasm32")]
pub fn by_source(_path: &str) -> bool { true }

// ── Today's reads ────────────────────────────────────────────────────────

/// Today's reads with no tool context: the backend's, under the Workspace.  A capture cannot be
/// read again without the turn's context, so it cannot be told.
pub struct TabReads;

impl StandingSource for TabReads {
    async fn standing(&self, _path: &str, _after: &Body) -> Option<Body> { None }

    async fn workspace_capped(&self, path: &str) -> Body {
        let ceiling = versions::VERSION_FILE_MAX as u32;
        match own::user_read_file_capped(FileRoot::Workspace, path, ceiling).await {
            Ok((b, total)) if total as usize <= versions::VERSION_FILE_MAX => Body::Held(b),
            Ok((_, total)) => Body::TooLarge(total as u64),
            // Not read is not absent (spec §16.2); only the native seam answers so.
            Err(e) if diamond::unreadable(&e) => Body::Unseen,
            // GONE ONLY WHERE IT IS GONE (r578f sweep): in the tab, whose seam says no
            // `Unreadable`, a file that stands and will not read was recorded as deleted, and a
            // restore to the version deleted it.
            Err(_) => match own::user_exists(FileRoot::Workspace, path).await {
                Ok(false) => Body::Gone,
                _         => Body::Unseen,
            },
        }
    }

    async fn changes(&self, id: &str, paths: &[String]) -> Vec<Change> {
        diamond::versions_changes(id, paths).await
    }

    async fn wiped(&self, _path: &str, _after: &Body) -> Option<bool> { None }

    async fn stamp(&self, path: &str) -> Option<Stamp> { diamond::stamp_now(path).await }
}

/// Today's reads with the turn's own tool context: a capture is read again through it, as the
/// turn's acts read it ([`crate::tools::standing_now`]).
pub struct CtxReads<'a, H: Host>(pub &'a ToolContext<H>);

impl<'a, H: Host> StandingSource for CtxReads<'a, H> {
    async fn standing(&self, path: &str, _after: &Body) -> Option<Body> {
        crate::tools::standing_now(self.0, path).await
    }
    async fn workspace_capped(&self, path: &str) -> Body { TabReads.workspace_capped(path).await }
    async fn changes(&self, id: &str, paths: &[String]) -> Vec<Change> {
        TabReads.changes(id, paths).await
    }
    async fn wiped(&self, _path: &str, _after: &Body) -> Option<bool> { None }
    async fn stamp(&self, path: &str) -> Option<Stamp> { TabReads.stamp(path).await }
}

/// A Diamond's own file read again from the backend, as [`crate::tools::standing_now`] reads a
/// workspace path: `None` where it is there and would not read.
pub async fn store_standing(path: &str) -> Option<Body> {
    let ceiling = versions::VERSION_FILE_MAX as u32;
    match own::user_read_file_capped(FileRoot::Workspace, path, ceiling).await {
        Ok((b, total)) if total as usize <= versions::VERSION_FILE_MAX => Some(Body::Held(b)),
        Ok((_, total)) => Some(Body::TooLarge(total as u64)),
        Err(_)         => match own::user_exists(FileRoot::Workspace, path).await {
            Ok(false) => Some(Body::Gone),
            _         => None,
        },
    }
}

// ── The staged turn end ─────────────────────────────────────────────────

/// What a turn end will ask of the person's files, for the child to read before it ends the turn
/// (spec §16.3 2 (a)).  Every entry is a path [`by_source`] names.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Wants {
    /// The captures to read again, each with what the turn left there.
    pub own:     Vec<(String, Seen)>,
    /// The notes the turn end will adopt.
    pub notes:   Vec<String>,
    /// The paths the turn's windows credit.
    pub windows: Vec<String>,
    /// Each capture in `own` whose `after` passes the per-file ceiling, with what the turn left:
    /// the child judges it by the tab's rule, [`versions::large_stands`] (d1_plan §9.11 O1).
    pub large:   Vec<(String, BodyRef)>,
    /// Each marked capture with a `Large` `after` and a first copy, `(path, seen, before)`: the
    /// child, where it stands, runs the record's wipe test and sends `turn_wiped`.
    pub wipe:    Vec<(String, Seen, BodyRef)>,
}

/// What the child found at a path it was asked for.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Standing {
    /// What stands there, read up to the per-file ceiling; `Gone` only where nothing is.
    Now(Body),
    /// It could not be read: not known, never absent.
    Unknown,
}

/// The run's staged table: a [`Wants`] snapshot and what the child sent against it, as the store's
/// [`StandingSource`].  A capture's entry is honoured only while its `after` still has the
/// [`Seen`] the snapshot named; anything not sent is unseen, or cannot be told.
///
/// **Admission is keyed by `(path, Seen)`, only for an outstanding entry of the snapshot, and once
/// each across the three staging calls** (d1_plan §9.2, §9.10 D1v2): a capture is told either as
/// standing as left (`turn_stands`) or as found otherwise (`turn_standing`), never both and never
/// twice; a `wipe` entry's answer (`turn_wiped`) is taken once, and only for a capture not told as
/// found otherwise, since the wipe test asks of an `after` that still stands.
#[derive(Clone, Debug, Default)]
pub struct Staged {
    wants:  Wants,
    stood:  Vec<(String, Option<Seen>, Standing)>,  // `None` for a note's or a window's path
    stands: Vec<(String, Seen)>,                    // captures found as the turn left them
    wiped:  Vec<(String, Seen, bool)>,              // the child's `turn_wiped` answers
    stamps: Vec<(String, Stamp)>,                   // window paths' stamps, as the child found them
    #[cfg(test)]
    off:    Vec<&'static str>,                      // `wanted`, `seen`: the checks not made (D1x1b)
}

impl Staged {

    pub fn new(wants: Wants) -> Self { Self { wants, ..Self::default() } }

    pub fn wants(&self) -> &Wants { &self.wants }

    fn sent(&self, path: &str, seen: Option<&Seen>) -> bool {
        self.stood.iter().any(|(p, s, _)| p == path && s.as_ref() == seen)
            || seen.is_some_and(|seen| self.stands.iter().any(|(p, s)| p == path && s == seen))
    }

    /// The admission checks named in `rules` switched off, for a red control.
    #[cfg(test)]
    pub fn rules_off(&mut self, rules: &[&'static str]) { self.off = rules.to_vec(); }

    #[cfg(test)]
    fn checks(&self, rule: &str) -> bool { !self.off.contains(&rule) }

    #[cfg(not(test))]
    #[inline(always)]
    fn checks(&self, _: &str) -> bool { true }

    fn wanted(&self, path: &str, seen: Option<&Seen>) -> bool {
        if !self.checks("wanted") {
            return true;
        }
        match seen {
            Some(seen) => self.wants.own.iter()
                .any(|(p, s)| p == path && (s == seen || !self.checks("seen"))),
            None       => self.wants.notes.iter().chain(self.wants.windows.iter()).any(|p| p == path),
        }
    }

    /// Take what the child found at `path`, a capture's with the `seen` its `Wants` named, a
    /// note's or a window's with none.  Refused, answering `false`, for an entry the snapshot does
    /// not name or one already sent.
    pub fn stage(&mut self, path: &str, seen: Option<Seen>, standing: Standing) -> bool {
        self.stage_stamped(path, seen, standing, None)
    }

    /// [`Staged::stage`], with a window path's stamp as the child found it.  Refused for a stamp
    /// given at a path that is not one of the snapshot's windows, and for a capture already told
    /// wiped (the wipe test was of an `after` that stands).
    pub fn stage_stamped(&mut self, path: &str, seen: Option<Seen>, standing: Standing,
        stamp: Option<Stamp>) -> bool
    {
        if !self.wanted(path, seen.as_ref()) || self.sent(path, seen.as_ref()) {
            return false;
        }
        if let Some(seen) = seen.as_ref() {
            if self.wiped.iter().any(|(p, s, _)| p == path && s == seen) {
                return false;
            }
        }
        if let Some(stamp) = stamp {
            if seen.is_some() || !self.wants.windows.iter().any(|w| w == path) {
                return false;
            }
            self.stamps.push((path.to_string(), stamp));
        }
        self.stood.push((path.to_string(), seen, standing));
        true
    }

    /// [`Staged::stage_stamped`] as `turn_standing` names it, keyed by `(path, seen)`: a capture
    /// names its entry's `Seen`, a note's or a window's path `Unread`.  A capture's `seen` that
    /// matches no entry is refused, never taken as the same path's note or window.
    pub fn stage_wire(&mut self, path: &str, seen: Seen, standing: Standing, stamp: Option<Stamp>)
        -> bool
    {
        let seen = if seen == Seen::Unread { None } else { Some(seen) };
        self.stage_stamped(path, seen, standing, stamp)
    }

    /// Take a capture the child found as the turn left it.  Refused as [`Staged::stage`] is.
    pub fn stand(&mut self, path: &str, seen: Seen) -> bool {
        if !self.wanted(path, Some(&seen)) || self.sent(path, Some(&seen)) {
            return false;
        }
        self.stands.push((path.to_string(), seen));
        true
    }

    /// Take a page of captures the child found as the turn left them, **all or none** (D1v2c): the
    /// page is checked whole first, each entry as [`Staged::stand`] checks it and none named twice
    /// within it, so a refused page took nothing and may be sent again in part.
    pub fn stand_page(&mut self, page: Vec<(String, Seen)>) -> bool {
        for (n, (path, seen)) in page.iter().enumerate() {
            if !self.wanted(path, Some(seen)) || self.sent(path, Some(seen))
                || page[..n].iter().any(|(p, s)| p == path && s == seen)
            {
                return false;
            }
        }
        self.stands.extend(page);
        true
    }

    /// Take the child's `turn_wiped` answer for a `wipe` entry.  Refused, answering `false`, for
    /// an entry the snapshot's `wipe` does not name or one already sent.
    pub fn wipe(&mut self, path: &str, seen: Seen, wiped: bool) -> bool {
        if !self.wants.wipe.iter().any(|(p, s, _)| p == path && *s == seen)
            || self.wiped.iter().any(|(p, s, _)| p == path && *s == seen)
            || self.stood.iter().any(|(p, s, _)| p == path && s.as_ref() == Some(&seen))
        {
            return false;
        }
        self.wiped.push((path.to_string(), seen, wiped));
        true
    }

    fn found(&self, path: &str, seen: Option<&Seen>) -> Option<&Standing> {
        self.stood.iter()
            .find(|(p, s, _)| p == path && s.as_ref() == seen)
            .map(|(_, _, st)| st)
    }

    /// A note's or a window's path as the child found it: unseen where it was not sent or could
    /// not be read.
    fn body_at(&self, path: &str) -> Body {
        match self.found(path, None) {
            Some(Standing::Now(b)) => b.clone(),
            _                      => Body::Unseen,
        }
    }
}

impl StandingSource for Staged {
    async fn standing(&self, path: &str, after: &Body) -> Option<Body> {
        let seen = match after {
            Body::Held(b)  => Seen::of(Some(b)),
            Body::Large(r) | Body::Stored(r) => Seen::Bytes(r.hash.clone()),
            Body::Gone     => Seen::of(None),
            Body::TooLarge(_) | Body::Unseen => return None,
        };
        if self.stands.iter().any(|(p, s)| p == path && *s == seen) {
            return Some(after.clone());
        }
        match self.found(path, Some(&seen)) {
            Some(Standing::Now(b)) => Some(b.clone()),
            _                      => None,
        }
    }

    async fn workspace_capped(&self, path: &str) -> Body {
        if !self.wants.notes.iter().any(|p| p == path) {
            return Body::Unseen;
        }
        self.body_at(path)
    }

    async fn changes(&self, id: &str, paths: &[String]) -> Vec<Change> {
        let mut out = Vec::new();
        for path in paths.iter() {
            if !diamond::versionable(id, path) {
                continue;
            }
            let body = if self.wants.windows.iter().any(|p| p == path) {
                self.body_at(path)
            } else {
                Body::Unseen
            };
            out.push(diamond::change_of(id, path, body));
        }
        out
    }

    async fn wiped(&self, path: &str, after: &Body) -> Option<bool> {
        let seen = match after {
            Body::Large(r) => Seen::Bytes(r.hash.clone()),
            Body::Held(_) | Body::Stored(_) | Body::Gone | Body::TooLarge(_) | Body::Unseen => return None,
        };
        self.wiped.iter().find(|(p, s, _)| p == path && *s == seen).map(|(_, _, w)| *w)
    }

    async fn stamp(&self, path: &str) -> Option<Stamp> {
        self.stamps.iter().find(|(p, _)| p == path).map(|(_, s)| s.clone())
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "../../tests/unit/store/standing/tests.rs"]
mod tests;
