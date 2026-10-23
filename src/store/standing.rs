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
mod tests {
    use super::*;
    use crate::store::{
        install,
        mem::MemBackend,
        native::NativeBackend,
        run::RunEnv,
        StoreBackend,
    };

    use oxedyne_fe2o3_core::prelude::*;
    use std::cell::RefCell;

    /// A source that keeps the paths it was asked, and answers from a staged table.
    struct Spy {
        staged: Staged,
        asked:  RefCell<Vec<String>>,
    }

    impl StandingSource for Spy {
        async fn standing(&self, path: &str, after: &Body) -> Option<Body> {
            self.asked.borrow_mut().push(fmt!("standing {}", path));
            self.staged.standing(path, after).await
        }
        async fn workspace_capped(&self, path: &str) -> Body {
            self.asked.borrow_mut().push(fmt!("capped {}", path));
            self.staged.workspace_capped(path).await
        }
        async fn changes(&self, id: &str, paths: &[String]) -> Vec<Change> {
            self.asked.borrow_mut().push(fmt!("changes {}", paths.join(",")));
            self.staged.changes(id, paths).await
        }
        async fn wiped(&self, path: &str, after: &Body) -> Option<bool> {
            self.staged.wiped(path, after).await
        }
        async fn stamp(&self, path: &str) -> Option<versions::Stamp> {
            self.asked.borrow_mut().push(fmt!("stamp {}", path));
            self.staged.stamp(path).await
        }
    }

    fn env(page: &str) -> RunEnv {
        RunEnv {
            run:        page.to_string(),
            diamonds:   ["d".to_string()].into_iter().collect(),
            folder_id:  None,
            known:      Default::default(),
            page:       page.to_string(),
        }
    }

    fn s(v: &str) -> String { v.to_string() }

    // A dead run's notes: two of the person's files and one of the Diamond's own.
    async fn dead_run_notes() {
        env("worker").scope(async {
            for (path, before) in [("notes/a.md", "old a"), ("notes/b.md", "old b"),
                ("diamonds/d/s.md", "old s")]
            {
                match diamond::pend("d", path, before.as_bytes(), false, false).await {
                    Ok(true) => (),
                    other    => panic!("the note on {}: {:?}", path, other),
                }
            }
        }).await;
    }

    /// The turn end asks the source for the person's files only, and reads the Diamond's own
    /// from the backend; a file the child could not read is unseen, never gone; and
    /// `turn_wants` peeks, leaving the turn end what it would have had.
    #[tokio::test]
    async fn turn_end_reads_the_persons_files_through_the_source() {
        let mem = MemBackend::default();
        let _ = install(NativeBackend::Mem(mem.clone()));
        let _ = mem.write_file("diamonds/d/s.md", b"store now").await;
        let _ = mem.write_file("diamonds/d/t.md", b"t").await;
        dead_run_notes().await;
        let (wants, again, kept, asked) = env("conductor").scope(async {
            diamond::capture("d", "notes/c.md", Change::of("notes/c.md", b"c".to_vec()));
            diamond::capture("d", "diamonds/d/t.md", Change::of("diamonds/d/t.md", b"t".to_vec()));
            let wants = diamond::turn_wants("d").await;
            let again = diamond::turn_wants("d").await;
            let mut staged = Staged::new(wants.clone());
            assert!(staged.stand("notes/c.md", Seen::of(Some(b"c"))), "the capture stands");
            assert!(staged.stage("notes/a.md", None, Standing::Now(Body::Held(b"a now".to_vec()))));
            assert!(staged.stage("notes/b.md", None, Standing::Unknown), "b could not be read");
            assert!(!staged.stage("notes/x.md", None, Standing::Unknown), "an invented path");
            assert!(!staged.stage("notes/a.md", None, Standing::Unknown), "a second send");
            let spy = Spy { staged, asked: RefCell::new(Vec::new()) };
            let hold = match diamond::hold_versions("d").await {
                Ok(h)  => h,
                Err(e) => panic!("the version hold: {}", e),
            };
            let (kept, _, _) = diamond::drain_turn_by(&hold, "d", &spy).await;
            (wants, again, kept, spy.asked.into_inner())
        }).await;
        let _ = install(NativeBackend::Closed);
        assert_eq!(wants, again, "two peeks differ");
        let mut notes = wants.notes.clone();
        notes.sort();
        assert_eq!(wants.own, vec![(s("notes/c.md"), Seen::of(Some(b"c")))], "own");
        assert_eq!(notes, vec![s("notes/a.md"), s("notes/b.md")], "notes");
        assert!(wants.windows.is_empty(), "windows");
        let mut after: Vec<(String, Body)> = kept.into_iter().map(|(_, c)| (c.path, c.after)).collect();
        after.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(after, vec![
            (s("diamonds/d/s.md"), Body::Held(b"store now".to_vec())),  // the backend's
            (s("diamonds/d/t.md"), Body::Held(b"t".to_vec())),          // captured, nothing drained
            (s("notes/a.md"), Body::Held(b"a now".to_vec())),            // the source's
            (s("notes/b.md"), Body::Unseen),                             // unread: never Gone
            (s("notes/c.md"), Body::Held(b"c".to_vec())),
        ]);
        let mut asked = asked;
        asked.sort();
        assert_eq!(asked, vec![s("capped notes/a.md"), s("capped notes/b.md"),
            s("standing notes/c.md")], "what the source was asked");
    }

    /// A capture a window then moved (a FileFetch over a written file): the capture is not kept,
    /// so the window's credit reads the path, and `turn_wants` must have asked for it, else the
    /// bytes the tab records are lost as unseen.
    #[tokio::test]
    async fn a_moved_capture_leaves_its_window_path_wanted() {
        let mem = MemBackend::default();
        let _ = install(NativeBackend::Mem(mem.clone()));
        let after = env("conductor").scope(async {
            diamond::capture("d", "notes/a.md", Change::of("notes/a.md", b"x".to_vec()));
            diamond::test_window("d", None, "notes/a.md");
            let wants = diamond::turn_wants("d").await;
            assert_eq!(wants.windows, vec![s("notes/a.md")], "the window's path is wanted");
            let mut staged = Staged::new(wants);
            assert!(staged.stage("notes/a.md", Some(Seen::of(Some(b"x"))),
                Standing::Now(Body::Held(b"y".to_vec()))), "the capture moved");
            assert!(staged.stage("notes/a.md", None, Standing::Now(Body::Held(b"y".to_vec()))),
                "the window's read");
            // The turn end seals the moved capture as a version of its own and keeps nothing of
            // it, so the windows are drained against an empty `held`, as the callers pass `kept`.
            let changes = diamond::drain_windows_by("d", &[], &staged).await;
            changes.into_iter().map(|c| (c.path, c.after)).collect::<Vec<_>>()
        }).await;
        let _ = install(NativeBackend::Closed);
        assert_eq!(after, vec![(s("notes/a.md"), Body::Held(b"y".to_vec()))]);
    }

    /// A capture's staged entry is honoured only for the `Seen` its `Wants` named; a window's path
    /// not sent, or unread, is unseen; and the Diamond's own paths are the backend's, in order.
    #[tokio::test]
    async fn staged_answers_only_what_was_wanted() {
        let mem = MemBackend::default();
        let _ = install(NativeBackend::Mem(mem.clone()));
        let _ = mem.write_file("diamonds/d/s.md", b"store").await;
        let mut staged = Staged::new(Wants {
            own:     vec![(s("notes/c.md"), Seen::of(Some(b"c")))],
            notes:   Vec::new(),
            windows: vec![s("notes/w.md"), s("notes/u.md")],
            ..Wants::default()
        });
        assert!(staged.stage("notes/c.md", Some(Seen::of(Some(b"c"))),
            Standing::Now(Body::Held(b"moved".to_vec()))));
        assert!(!staged.stand("notes/c.md", Seen::of(Some(b"c"))), "sent twice");
        assert!(staged.stage("notes/w.md", None, Standing::Now(Body::Gone)));
        assert!(staged.stage("notes/u.md", None, Standing::Unknown));
        let c = Body::Held(b"c".to_vec());
        assert_eq!(staged.standing("notes/c.md", &c).await, Some(Body::Held(b"moved".to_vec())));
        assert_eq!(staged.standing("notes/c.md", &Body::Held(b"c2".to_vec())).await, None,
            "a later capture cannot be told");
        assert_eq!(staged.workspace_capped("notes/w.md").await, Body::Unseen, "not a note");
        let spy = Spy { staged, asked: RefCell::new(Vec::new()) };
        let paths = vec![s("notes/w.md"), s("notes/u.md"), s("diamonds/d/s.md"), s("notes/z.md")];
        let changes = env("conductor").scope(diamond::changes_by("d", &paths, &spy)).await;
        let _ = install(NativeBackend::Closed);
        let after: Vec<(String, Body)> = changes.into_iter().map(|c| (c.path, c.after)).collect();
        assert_eq!(after, vec![
            (s("notes/w.md"), Body::Gone),
            (s("notes/u.md"), Body::Unseen),
            (s("diamonds/d/s.md"), Body::Held(b"store".to_vec())),
            (s("notes/z.md"), Body::Unseen),
        ]);
        assert_eq!(spy.asked.into_inner(), vec![s("changes notes/w.md,notes/u.md"),
            s("changes notes/z.md")]);
    }

    // ── D1v2b: admission once each, and the window's stamp ─────────────────

    /// A window's credit is checked against the stamp the child sent through the source: the
    /// store cannot stamp the person's path (D1s2b rider).  Red: `drain_windows_by` stamps the
    /// path itself, finds nothing, and the credit is lost.
    #[tokio::test]
    async fn a_windows_credit_is_checked_against_the_staged_stamp() {
        let mem = MemBackend::default();
        let _ = install(NativeBackend::Mem(mem.clone()));
        let by = crate::rating::Author { role: s("worker"), run: s("w1"), ..Default::default() };
        let (credited, refused) = env("conductor").scope(async {
            diamond::test_window("d", Some(by.clone()), "notes/w.md");
            let wants = diamond::turn_wants("d").await;
            assert_eq!(wants.windows, vec![s("notes/w.md")], "the window's path is wanted");
            let mut staged = Staged::new(wants);
            assert!(!staged.stage_stamped("notes/x.md", None, Standing::Unknown,
                Some(Stamp::Seen(1, Some(1)))), "a stamp at a path no window moved");
            assert!(staged.stage_stamped("notes/w.md", None,
                Standing::Now(Body::Held(b"y".to_vec())), Some(Stamp::Seen(1, Some(1)))));
            let refused = !staged.stage_stamped("notes/w.md", None, Standing::Unknown,
                Some(Stamp::Seen(2, None)));
            let changes = diamond::drain_windows_by("d", &[], &staged).await;
            (changes.into_iter().map(|c| (c.path, c.by.map(|a| a.run))).collect::<Vec<_>>(),
                refused)
        }).await;
        let _ = install(NativeBackend::Closed);
        assert!(refused, "a second stamp for the path");
        assert_eq!(credited, vec![(s("notes/w.md"), Some(s("w1")))], "the credit");
    }

    /// One `(path, seen)` through two staging calls: the second is refused, whichever the two
    /// (§9.10 D1v2).  Red: a `turn_wiped` for a capture told as found otherwise is taken, and a
    /// capture told wiped is then told found otherwise.
    #[test]
    fn a_path_through_two_staging_calls_is_refused_the_second_time() {
        let seen = Seen::Bytes(versions::hash_of(b"after"));
        let wants = Wants {
            own:     vec![(s("notes/c.md"), seen.clone()), (s("notes/d.md"), seen.clone())],
            wipe:    vec![(s("notes/c.md"), seen.clone(), BodyRef::of(b"b")),
                (s("notes/d.md"), seen.clone(), BodyRef::of(b"b"))],
            ..Wants::default()
        };
        let mut staged = Staged::new(wants);
        // standing, then stands or wiped
        assert!(staged.stage("notes/c.md", Some(seen.clone()), Standing::Now(Body::Gone)));
        assert!(!staged.stand("notes/c.md", seen.clone()), "standing then stands");
        assert!(!staged.wipe("notes/c.md", seen.clone(), true), "standing then wiped");
        // wiped, then stands is fine (the wipe test asks of an after that stands), standing not
        assert!(staged.wipe("notes/d.md", seen.clone(), true));
        assert!(!staged.stage("notes/d.md", Some(seen.clone()), Standing::Unknown),
            "wiped then standing");
        assert!(staged.stand("notes/d.md", seen.clone()), "wiped then stands");
        assert!(!staged.wipe("notes/d.md", seen.clone(), false), "wiped twice");
        assert!(!staged.stand("notes/d.md", seen), "stands twice");
    }

    /// `turn_standing`'s key is `(path, seen)`, and a stamp is taken only at a window's path: a
    /// capture whose path is also a window's is not opened by a stale `seen`, and a stamp at a
    /// note's path or with a capture's `seen` is refused.  Red: a `seen` matching no entry taken
    /// as the path's window; a stamp taken at any staged path.
    #[test]
    fn a_captures_stale_seen_is_never_its_paths_window_and_a_stamp_only_a_windows() {
        let seen = Seen::Bytes(versions::hash_of(b"after"));
        let stale = Seen::Bytes(versions::hash_of(b"before"));
        let stamp = || Some(Stamp::Seen(1, Some(1)));
        let wants = Wants {
            own:     vec![(s("notes/c.md"), seen.clone())],
            notes:   vec![s("notes/n.md")],
            windows: vec![s("notes/c.md")],
            ..Wants::default()
        };
        let mut staged = Staged::new(wants);
        assert!(!staged.stage_wire("notes/c.md", stale, Standing::Unknown, None),
            "a stale seen taken as the window's path");
        assert!(!staged.stage_wire("notes/n.md", Seen::Unread, Standing::Unknown, stamp()),
            "a stamp at a note's path");
        assert!(!staged.stage_wire("notes/c.md", seen.clone(), Standing::Unknown, stamp()),
            "a stamp with a capture's seen");
        assert!(staged.stage_wire("notes/c.md", seen, Standing::Unknown, None), "the capture");
        assert!(staged.stage_wire("notes/c.md", Seen::Unread, Standing::Unknown, stamp()),
            "the window");
        assert!(staged.stage_wire("notes/n.md", Seen::Unread, Standing::Unknown, None), "the note");
    }

    /// A page of stands is taken all or none (D1v2c).  Red: each entry taken as it is checked.
    #[test]
    fn a_stands_page_is_taken_whole_or_not_at_all() {
        let seen = Seen::Bytes(versions::hash_of(b"after"));
        let wants = Wants { own: vec![(s("notes/c.md"), seen.clone())], ..Wants::default() };
        let mut staged = Staged::new(wants);
        let c = (s("notes/c.md"), seen.clone());
        assert!(!staged.stand_page(vec![c.clone(), (s("notes/x.md"), seen.clone())]),
            "a page with an invented path");
        assert!(!staged.stand_page(vec![c.clone(), c.clone()]), "a page naming one twice");
        assert!(staged.stand_page(vec![c.clone()]), "the refused pages took nothing");
        assert!(!staged.stand_page(vec![c]), "sent already");
    }

    // ── D1b: `Body::Large` records what `Held` records ──────────────────────

    /// Past the per-file ceiling, so the tab reads a workspace path again capped (O1).
    const BIG: usize = versions::VERSION_FILE_MAX + 4096;

    fn big(fill: u8, len: usize) -> Vec<u8> { vec![fill; len] }

    /// One turn's captures, each `after` `Held` or the `Large` reference to the same bytes.
    fn captures(large: bool) -> Vec<Change> {
        let after = |b: Vec<u8>| if large { Body::Large(BodyRef::of(&b)) } else { Body::Held(b) };
        vec![
            // Stands; marked, and wiped by its write (not UTF-8, so any change is a wipe).
            Change { after: after(big(0xFE, BIG)), before: Some(crate::diamond_versions::Prior::Held(big(0xFF, BIG + 9))), mark: true,
                ..Change::gone("notes/wiped.md") },
            // Edited from outside to the same length: stands by length, as in the tab (O1).
            Change { after: after(big(1, BIG)), before: Some(crate::diamond_versions::Prior::Held(b"first".to_vec())),
                ..Change::gone("notes/same.md") },
            // Grown from outside: moved.
            Change { after: after(big(2, BIG)), ..Change::gone("notes/grown.md") },
            // A machine file edited from outside to the same length: moved, by its bytes.
            Change { after: after(big(3, BIG)), mark: true, ..Change::gone("/m/x.md") },
        ]
    }

    /// What the child sends for the turn above, as the tab's reads would find it.
    fn child(wants: &Wants, large: bool) -> Staged {
        let seen = |b: &[u8]| Seen::of(Some(b));
        let mut st = Staged::new(wants.clone());
        assert!(st.stand("notes/wiped.md", seen(&big(0xFE, BIG))), "wiped stands");
        // Stands by the tab's rule (O1), so it is told as standing, and its wipe entry then
        // answered: a capture told as found otherwise has no wipe answer (D1v2b).
        assert!(st.stand("notes/same.md", seen(&big(1, BIG))), "same");
        assert!(st.stage("notes/grown.md", Some(seen(&big(2, BIG))),
            Standing::Now(Body::TooLarge(BIG as u64 + 1))), "grown");
        assert!(st.stage("/m/x.md", Some(seen(&big(3, BIG))),
            Standing::Now(Body::Held(big(4, BIG)))), "machine");
        if large {
            let w = crate::tools::wiped("notes/wiped.md", &big(0xFF, BIG + 9), &big(0xFE, BIG));
            assert!(w, "the test's write is a wipe");
            assert!(st.wipe("notes/wiped.md", seen(&big(0xFE, BIG)), w), "turn_wiped");
            assert!(!st.wipe("notes/wiped.md", seen(&big(0xFE, BIG)), w), "turn_wiped twice");
            assert!(!st.wipe("notes/grown.md", seen(&big(2, BIG)), true), "no first copy: not a wipe entry");
            let same = crate::tools::wiped("notes/same.md", b"first", &big(1, BIG));
            assert!(st.wipe("notes/same.md", seen(&big(1, BIG)), same), "the person's file is marked");
        }
        st
    }

    /// A turn ended and recorded through the staged table, and the rows it left: each version's
    /// cause and its files, field for field.
    async fn recorded(changes: Vec<Change>, stage: impl Fn(&Wants) -> Staged)
        -> (Wants, Vec<(versions::Cause, Vec<versions::Entry>)>)
    {
        recorded_after(Vec::new(), changes, stage).await
    }

    /// As [`recorded`], over a history that already holds `prior`, recorded as one version first.
    async fn recorded_after(prior: Vec<Change>, changes: Vec<Change>,
        stage: impl Fn(&Wants) -> Staged)
        -> (Wants, Vec<(versions::Cause, Vec<versions::Entry>)>)
    {
        let mem = MemBackend::default();
        let _ = install(NativeBackend::Mem(mem.clone()));
        let _ = mem.write_file("diamonds/d/.daimond/meta.json",
            br#"{"name":"d","crystal_version":0,"updated":0,"touched":0}"#).await;
        let out = env("conductor").scope(async {
            if !prior.is_empty() {
                let hold = match diamond::hold_versions("d").await {
                    Ok(h)  => h,
                    Err(e) => panic!("the version hold: {}", e),
                };
                if let Err(e) = diamond::versions_record_held(&hold, "d", None,
                    versions::Cause::Restore, "", "", prior).await
                {
                    panic!("the prior record: {}", e);
                }
                drop(hold);
            }
            for ch in changes.into_iter() {
                let raw = ch.path.clone();
                diamond::capture("d", &raw, ch);
            }
            let wants = diamond::turn_wants("d").await;
            let staged = stage(&wants);
            let hold = match diamond::hold_versions("d").await {
                Ok(h)  => h,
                Err(e) => panic!("the version hold: {}", e),
            };
            let (kept, _, _) = diamond::drain_turn_by(&hold, "d", &staged).await;
            let kept: Vec<Change> = kept.into_iter().map(|(_, c)| c).collect();
            if let Err(e) = diamond::versions_record_held(&hold, "d", None, versions::Cause::Turn,
                "t", "", kept).await
            {
                panic!("the record: {}", e);
            }
            drop(hold);
            let rows = diamond::versions_manifests("d").await.into_iter()
                .map(|(_, m)| (m.cause, m.files))
                .collect();
            (wants, rows)
        }).await;
        let _ = install(NativeBackend::Closed);
        out
    }

    /// NATIVE DIFFERENTIAL (D1b): one turn recorded with `Held` afters and again with `Large`
    /// ones gives equal rows, field for field -- the re-read, the sealed run, the record row and
    /// the wipe re-check (by the child's `turn_wiped`) -- and a same-length outside edit of a
    /// workspace file over the ceiling gives the tab's row, not "moved" (O1).
    #[tokio::test]
    async fn held_and_large_record_equal_rows() {
        let (held_wants, held) = recorded(captures(false), |w| child(w, false)).await;
        let (large_wants, large) = recorded(captures(true), |w| child(w, true)).await;
        assert_eq!(held, large, "Held and Large rows differ");
        assert_eq!(held_wants.own, large_wants.own, "own");
        assert_eq!(held_wants.large, large_wants.large, "large");
        assert_eq!(large_wants.large.len(), 4, "every capture passes the ceiling: {:?}",
            large_wants.large.iter().map(|(p, _)| p).collect::<Vec<_>>());
        assert!(held_wants.wipe.is_empty(), "a Held after's wipe is the record's");
        assert_eq!(large_wants.wipe, vec![
            (s("notes/wiped.md"), Seen::of(Some(&big(0xFE, BIG))), BodyRef::of(&big(0xFF, BIG + 9))),
            (s("notes/same.md"), Seen::of(Some(&big(1, BIG))), BodyRef::of(b"first")),
        ], "wipe");
        let rows: Vec<(versions::Cause, String, String, bool)> = large.iter()
            .flat_map(|(c, f)| f.iter().map(move |e| (*c, e.path.clone(), e.hash.clone(), e.wiped)))
            .collect();
        let of = |p: &str| rows.iter().filter(|r| r.1 == p).cloned().collect::<Vec<_>>();
        let h = |b: Vec<u8>| versions::hash_of(&b);
        assert_eq!(of("notes/same.md"), vec![(versions::Cause::Turn, s("notes/same.md"),
            h(big(1, BIG)), true)], "O1: same length stands, as the tab's (and is a wipe of 'first')");
        assert_eq!(of("notes/wiped.md"), vec![(versions::Cause::Turn, s("notes/wiped.md"),
            h(big(0xFE, BIG)), true)], "the wipe");
        assert_eq!(of("notes/grown.md").len(), 2, "grown: the sealed run and what stands");
        assert_eq!(of("/m/x.md").len(), 2, "machine: moved by its bytes");
        assert!(large.iter().flat_map(|(_, f)| f.iter())
            .filter(|e| !e.gone && !e.hash.is_empty() && e.path != "/m/x.md")
            .all(|e| e.skipped.as_deref() == Some("size") && e.bytes > 0), "rows over the ceiling");
    }

    /// With no `turn_wiped` for a `Large` after, the capture's own `wiped` stands.
    #[tokio::test]
    async fn no_turn_wiped_leaves_the_captures_own() {
        let after = Body::Large(BodyRef::of(&big(5, BIG)));
        let changes = vec![
            Change { after: after.clone(), before: Some(crate::diamond_versions::Prior::Held(big(6, BIG))), mark: true, wiped: false,
                ..Change::gone("notes/a.md") },
            Change { after: after.clone(), before: Some(crate::diamond_versions::Prior::Held(big(6, BIG))), mark: true, wiped: true,
                ..Change::gone("notes/b.md") },
        ];
        let (wants, rows) = recorded(changes, |w| {
            let mut st = Staged::new(w.clone());
            assert!(st.stand("notes/a.md", Seen::of(Some(&big(5, BIG)))));
            assert!(st.stand("notes/b.md", Seen::of(Some(&big(5, BIG)))));
            st
        }).await;
        assert_eq!(wants.wipe.len(), 2, "both are wipe entries");
        let wiped: Vec<(String, bool)> = rows.iter().flat_map(|(_, f)| f.iter())
            .map(|e| (e.path.clone(), e.wiped)).collect();
        assert_eq!(wiped, vec![(s("notes/a.md"), false), (s("notes/b.md"), true)]);
    }
    /// A moved machine file the History already names, `Held` against `Large`: the turn left
    /// `left` at the path, and the child finds `now` there.
    fn moved_machine(large: bool, path: &str, left: &[u8], now: &[u8])
        -> (Change, impl Fn(&Wants) -> Staged)
    {
        let after = if large { Body::Large(BodyRef::of(left)) } else { Body::Held(left.to_vec()) };
        let found = if large { Body::Large(BodyRef::of(now)) } else { Body::Held(now.to_vec()) };
        let (path, left) = (path.to_string(), left.to_vec());
        let ch = Change { after, mark: true, ..Change::gone(&path) };
        (ch, move |w: &Wants| {
            let mut st = Staged::new(w.clone());
            assert!(st.stage(&path, Some(Seen::of(Some(&left))), Standing::Now(found.clone())),
                "the moved file");
            st
        })
    }

    /// NATIVE DIFFERENTIAL (D1b check G1): the child sends `Standing::Now(Body::Large(..))` for a
    /// moved machine file, and the store tells it as it tells the `Held` bytes it names.  The
    /// path's newest row says what stands, and names the turn's bytes as its `was` (a Restore in
    /// another tab recorded it), so `told` and `in_rows` leave it alone and nothing more is
    /// recorded.  A row names its hash only where it holds the copy, so what stands is under the
    /// ceiling here, a `Large` the tab never makes: the arm, not the size, is under test.  Red with
    /// only `told`'s `Large` arm reverted.
    #[tokio::test]
    async fn a_large_now_is_told_as_held() {
        let (now, left) = (b"put back by a Restore".to_vec(), big(8, BIG));
        let prior = vec![Change { after: Body::Held(now.clone()), before: Some(crate::diamond_versions::Prior::Held(left.clone())),
            mark: true, ..Change::gone("/m/back.md") }];
        let (held_ch, held_child) = moved_machine(false, "/m/back.md", &left, &now);
        let (large_ch, large_child) = moved_machine(true, "/m/back.md", &left, &now);
        let (_, held) = recorded_after(prior.clone(), vec![held_ch], held_child).await;
        let (_, large) = recorded_after(prior.clone(), vec![large_ch], large_child).await;
        assert_eq!(held, large, "Held and Large rows differ");
        assert_eq!(large.len(), 1, "the Restore's row stands alone: {:?}", large);
    }

    /// `change_of`, as a window's `Standing::Now(Body::Large(..))` reaches it ([`Staged::changes`]),
    /// records the row the `Held` bytes it names record.  Red with `change_of`'s `Large` arm
    /// recording an unread file.
    #[tokio::test]
    async fn a_large_window_records_as_held() {
        let a = big(3, BIG);
        let mut rows = Vec::new();
        for body in [Body::Held(a.clone()), Body::Large(BodyRef::of(&a))] {
            let mut st = Staged::new(Wants { windows: vec![s("notes/w.md")], ..Wants::default() });
            assert!(st.stage("notes/w.md", None, Standing::Now(body)), "the window");
            let changes = st.changes("d", &[s("notes/w.md")]).await;
            let (_, r) = recorded_after(changes, Vec::new(), |w| Staged::new(w.clone())).await;
            rows.push(r);
        }
        assert_eq!(rows[0], rows[1], "Held and Large rows differ");
        assert_eq!(rows[1].iter().flat_map(|(_, f)| f.iter())
            .map(|e| (e.hash.clone(), e.bytes, e.skipped.clone())).collect::<Vec<_>>(),
            vec![(versions::hash_of(&a), BIG as u64, Some(s("size")))]);
    }

    /// The import walk ([`diamond::import_source`]) keeps of a `Large` what it keeps of the `Held`
    /// bytes it names: nothing, past the ceiling.  Compile-red before the walk's arm was its own.
    #[test]
    fn the_import_walk_keeps_a_large_as_held() {
        let a = big(4, BIG);
        let held = diamond::import_source(Change { after: Body::Held(a.clone()),
            ..Change::gone("notes/a.md") });
        let large = diamond::import_source(Change { after: Body::Large(BodyRef::of(&a)),
            ..Change::gone("notes/a.md") });
        assert_eq!(held, None);
        assert_eq!(large, held);
        assert_eq!(diamond::import_source(Change::of("notes/b.md", b"b".to_vec())),
            Some((s("notes/b.md"), b"b".to_vec())));
    }

    /// D1b check G2: a `Large` at or under the ceiling is never recorded as "too large" with no
    /// copy, a row that could not be restored for a false reason.  Red while the row assumed the
    /// ceiling was passed.
    #[tokio::test]
    async fn a_large_under_the_ceiling_is_not_too_large() {
        let small = b"small enough to keep".to_vec();
        let changes = vec![Change { after: Body::Large(BodyRef::of(&small)),
            ..Change::gone("notes/small.md") }];
        let (_, rows) = recorded_after(changes, Vec::new(), |w| Staged::new(w.clone())).await;
        let skipped: Vec<Option<String>> = rows.iter().flat_map(|(_, f)| f.iter())
            .map(|e| e.skipped.clone()).collect();
        assert_eq!(skipped, vec![Some(s("unreadable"))], "{:?}", rows);
    }
}
