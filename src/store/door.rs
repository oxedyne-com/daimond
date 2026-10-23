//! The person's door on the runner: the read-only seam the store reads his files through for a
//! door errand, and the entry guard on the calls only a door errand makes (d1_plan §9.2 D1s2c,
//! spec §16.4).
//!
//! A [`DoorEnv`] is in scope only around the parent's errand handler, set in a
//! `tokio::task_local!` as [`RunEnv`](crate::store::run::RunEnv) is.  Inside it, the native seam
//! reads a path of the person's through the door's [`UserLink`]: a capped read, an exists and a
//! list, each bounded by the door's deadline ([`USER_LINK_DEADLINE`], 20 s).  Past it, or on any
//! failure but absence, the answer is the typed [`Unreadable`], never absent.
//!
//! **`UserLink` has no write op.**  A write into his folder is a door act, made by the door child
//! inside a verified errand (R7a), never by the store:
//!
//! ```compile_fail
//! use oxedyne_daimond::store::door::{DirLink, UserLink};
//! async fn write_through(link: &DirLink) {
//!     let _ = link.write("a.md", b"x").await;
//! }
//! ```
//!
//! The same link reads, which is what the doc test above is the negative of:
//!
//! ```
//! use oxedyne_daimond::store::door::{DirLink, UserLink};
//! async fn read_through(link: &DirLink) {
//!     let _ = link.read_capped("a.md", 64).await;
//! }
//! ```
//!
//! The restore family, `versions_walk`, `mark_dirty_before` and `dirty_changes` refuse at entry
//! with no `DoorEnv` for their Diamond in scope ([`guard`]).  On wasm the guard is always true.

use crate::store::call::Unreadable;

use oxedyne_fe2o3_core::prelude::*;

use std::{
    future::Future,
    path::{Component, Path, PathBuf},
    time::Duration,
};

/// How long one read over a [`UserLink`] may take before it is [`Unreadable`] (spec §16.4).
pub const USER_LINK_DEADLINE: Duration = Duration::from_secs(20);

/// The reads the store may make of the person's files over a door.  Read-only by construction:
/// there is no write, swap, move or delete here.
#[allow(async_fn_in_trait)]
pub trait UserLink {
    /// Up to `max` bytes of `path`, with its whole length; `None` where nothing is there.
    async fn read_capped(&self, path: &str, max: u32) -> Outcome<Option<(Vec<u8>, u64)>>;
    /// Is anything at `path`?
    async fn exists(&self, path: &str) -> Outcome<bool>;
    /// The entries of the directory `path`, each `(name, is_dir, size)`; `None` where it is not
    /// there.
    async fn list(&self, path: &str) -> Outcome<Option<Vec<(String, bool, u64)>>>;
}

/// A door over one directory, read directly: the fake the store's tests read a folder through,
/// answering as the door child's link answers.
#[derive(Clone, Debug)]
pub struct DirLink {
    root: PathBuf,
}

impl DirLink {
    pub fn new(root: PathBuf) -> Self { Self { root } }

    /// `path` under the root, refused where it would leave it: by its spelling (`..`, a root),
    /// or by where it REALLY is, every link on the way followed, since the reads below follow
    /// links (D1s2c check).  The real place is the tools' own rule, [`crate::tools::real_place`]:
    /// a path not there yet is judged by where it would land, its nearest real folder on the way,
    /// so absence inside stays absence and an absence beyond a link out is refused, however many
    /// of its folders are not made yet (D1int).
    fn under(&self, path: &str) -> Outcome<PathBuf> {
        let rel = Path::new(path.trim_start_matches('/'));
        if rel.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
            return Err(err!("'{}' leaves the folder the door was opened on.", path;
                Invalid, Input, Path));
        }
        let at = self.root.join(rel);
        match crate::tools::real_place(&crate::workspace::Workspace::unchecked(self.root.clone()), &at) {
            Some(_) => Ok(at),
            None    => Err(err!("'{}' passes through a link out of the folder the door was \
                opened on.", path; Invalid, Input, Path)),
        }
    }
}

/// `Ok(None)` for absence, the error otherwise.
fn absent<V>(e: std::io::Error, path: &str) -> Outcome<Option<V>> {
    if e.kind() == std::io::ErrorKind::NotFound {
        return Ok(None);
    }
    Err(err!("'{}': {}", path, e; IO, Read))
}

impl UserLink for DirLink {
    async fn read_capped(&self, path: &str, max: u32) -> Outcome<Option<(Vec<u8>, u64)>> {
        use tokio::io::AsyncReadExt;
        let at = res!(self.under(path));
        let file = match tokio::fs::File::open(&at).await {
            Ok(f)  => f,
            Err(e) => return absent(e, path),
        };
        let total = match file.metadata().await {
            Ok(m)  => m.len(),
            Err(e) => return absent(e, path),
        };
        let mut body = Vec::new();
        if let Err(e) = file.take(max as u64).read_to_end(&mut body).await {
            return absent(e, path);
        }
        Ok(Some((body, total)))
    }

    async fn exists(&self, path: &str) -> Outcome<bool> {
        let at = res!(self.under(path));
        match tokio::fs::metadata(&at).await {
            Ok(_)  => Ok(true),
            Err(e) => absent::<()>(e, path).map(|_| false),
        }
    }

    async fn list(&self, path: &str) -> Outcome<Option<Vec<(String, bool, u64)>>> {
        let at = res!(self.under(path));
        let mut dir = match tokio::fs::read_dir(&at).await {
            Ok(d)  => d,
            Err(e) => return absent(e, path),
        };
        let mut out = Vec::new();
        loop {
            let entry = match dir.next_entry().await {
                Ok(Some(e)) => e,
                Ok(None)    => break,
                Err(e)      => return Err(err!("'{}': {}", path, e; IO, Read)),
            };
            let meta = match entry.metadata().await {
                Ok(m)  => m,
                Err(e) => return Err(err!("'{}': {}", path, e; IO, Read)),
            };
            out.push((entry.file_name().to_string_lossy().into_owned(), meta.is_dir(),
                if meta.is_dir() { 0 } else { meta.len() }));
        }
        out.sort();
        Ok(Some(out))
    }
}

/// The links a door can hold, chosen by enum.  R7a adds the door child's pipe.
#[derive(Clone, Debug)]
pub enum Link {
    /// A folder read directly ([`DirLink`]).
    Dir(DirLink),
    /// A door child that never answers, for the deadline's tests.
    #[cfg(test)]
    Stalled,
}

impl UserLink for Link {
    async fn read_capped(&self, path: &str, max: u32) -> Outcome<Option<(Vec<u8>, u64)>> {
        match self {
            Self::Dir(l) => l.read_capped(path, max).await,
            #[cfg(test)]
            Self::Stalled => std::future::pending().await,
        }
    }
    async fn exists(&self, path: &str) -> Outcome<bool> {
        match self {
            Self::Dir(l) => l.exists(path).await,
            #[cfg(test)]
            Self::Stalled => std::future::pending().await,
        }
    }
    async fn list(&self, path: &str) -> Outcome<Option<Vec<(String, bool, u64)>>> {
        match self {
            Self::Dir(l) => l.list(path).await,
            #[cfg(test)]
            Self::Stalled => std::future::pending().await,
        }
    }
}

/// A door errand's environment: the Diamond it was opened on and the link to the person's
/// folder.  Set by the parent's errand handler, never by a run.
#[derive(Clone, Debug)]
pub struct DoorEnv {
    /// The Diamond the errand was opened on: the guard admits calls on it alone.
    pub id:     String,
    link:       Link,
    deadline:   Duration,
}

tokio::task_local! {
    static DOOR: DoorEnv;
}

impl DoorEnv {
    /// A door on `id` over `link`, each read bounded by [`USER_LINK_DEADLINE`].
    pub fn new(id: &str, link: Link) -> Self {
        Self { id: id.to_string(), link, deadline: USER_LINK_DEADLINE }
    }

    /// The deadline each read over the link is bounded by.
    pub fn deadline(&self) -> Duration { self.deadline }

    /// The same door with a shorter deadline, for a test that waits on it.
    #[cfg(test)]
    pub fn with_deadline(mut self, deadline: Duration) -> Self {
        self.deadline = deadline;
        self
    }

    /// Run `fut` inside this door, across every await inside it.
    pub async fn scope<F: Future>(self, fut: F) -> F::Output {
        DOOR.scope(self, fut).await
    }

    /// `fut`'s answer, or [`Unreadable`] past the deadline or on any failure; `Ok(None)` stays
    /// absence.
    async fn within<V>(&self, path: &str, fut: impl Future<Output = Outcome<Option<V>>>)
        -> Outcome<Option<V>>
    {
        if crate::store::diamond::off("deadline") {
            return fut.await.map_err(|e| Unreadable { path: path.to_string(), why: fmt!("{}", e) }
                .to_error());
        }
        match tokio::time::timeout(self.deadline, fut).await {
            Ok(Ok(v))  => Ok(v),
            Ok(Err(e)) => Err(Unreadable { path: path.to_string(), why: fmt!("{}", e) }.to_error()),
            Err(_)     => Err(Unreadable {
                path:   path.to_string(),
                why:    fmt!("the door had no answer in {} ms", self.deadline.as_millis()),
            }.to_error()),
        }
    }

    /// Up to `max` bytes of `path`, with its whole length; `None` where nothing is there.
    pub async fn read_capped(&self, path: &str, max: u32) -> Outcome<Option<(Vec<u8>, u64)>> {
        self.within(path, self.link.read_capped(path, max)).await
    }

    /// Is anything at `path`?
    pub async fn exists(&self, path: &str) -> Outcome<bool> {
        let found = self.within(path, async { self.link.exists(path).await.map(Some) }).await;
        found.map(|v| v.unwrap_or(false))
    }

    /// The entries of the directory `path`; `None` where it is not there.
    pub async fn list(&self, path: &str) -> Outcome<Option<Vec<(String, bool, u64)>>> {
        self.within(path, self.link.list(path)).await
    }
}

/// The door in scope, if any.
pub fn current() -> Option<DoorEnv> {
    DOOR.try_with(|d| d.clone()).ok()
}

const NO_DOOR_MARK: &str = "No door";

/// The entry guard: `call` on `id` goes on only inside a [`DoorEnv`] opened on `id`.
pub fn guard(call: &str, id: &str) -> Outcome<()> {
    match DOOR.try_with(|d| d.id == id) {
        Ok(true)  => Ok(()),
        Ok(false) => Err(err!("{}: store.{} on the Diamond '{}' is made only inside a door errand \
            opened on it, and the door in scope was opened on another.", NO_DOOR_MARK, call, id;
            Unauthorised, Security)),
        Err(_)    => Err(err!("{}: store.{} on the Diamond '{}' is made only inside a door errand, \
            and none is open.", NO_DOOR_MARK, call, id; Unauthorised, Security)),
    }
}

/// Is `e` the entry guard's refusal?
pub fn is_no_door(e: &Error<ErrTag>) -> bool {
    e.tags().contains(&ErrTag::Unauthorised) && e.msgs().iter().any(|m| m.starts_with(NO_DOOR_MARK))
}

#[cfg(test)]
#[path = "door_tests.rs"]
mod tests;
