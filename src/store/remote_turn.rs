//! The child's half of the turn end (spec §16.3 2, §16.3a; d1_plan D1r2).
//!
//! The store cannot read the person's files, so before it drains the turn the child reads what the
//! turn end will ask of them and stages it, under the hold the caller already has:
//!
//! - (a) **`turn_wants`**, every page: the captures to read again, the notes to adopt and the
//!   paths the windows credit.
//! - (b) **The fenced reads.**  A capture's path through [`standing_now`](crate::tools::standing_now),
//!   with the run's own context; a note's or a window's through its `Fs`, capped.  **Only a path
//!   that is not there is `Gone`**: any other failure is `Unknown`, never a deletion.
//! - (c) **`turn_standing`** for every entry that does not stand as the store expects, one frame
//!   each; **`turn_wiped`** for each marked `Large` capture that stands, its wipe test run here
//!   against the `before` fetched from the store; and **`turn_stands`**, in pages, for the rest.
//! - (d) `drain_turn`, sent by the port after these.
//!
//! **No store-owned path is staged** (HL5a): a path under `diamonds/<id>/` is the store's to read,
//! and a copy of it on the run's disk is never its record.  `drain_windows` reads the same staged table.
//!
//! **Late arrivals need nothing here** (§16.3 5): a capture made after (a) is not in the snapshot,
//! so the store's re-read of it answers `None` and it is recorded as the turn left it; a note or a
//! credited path made after (a) is unseen.

use super::*;
use crate::{
    diamond_versions::{self as versions, Body, Stamp},
    engine::host::fs::HostFs,
    store::call::{WireStanding, LIST_PAGE},
};

use oxedyne_fe2o3_hash::sha256::Sha256;

impl<L: StoreLink> RemoteStore<L> {

    /// Phases (a) to (c) of `id`'s turn end, read through `ctx`.  The first refusal from the
    /// store ends it, so the turn end is refused rather than recorded from a partial table.
    pub(super) async fn stage_turn<H: Host>(&self, id: &str, ctx: &ToolContext<H>) -> Outcome<()> {
        let wants = res!(self.wants(id).await).wants;

        // A CAPTURE, read again with the run's own fence.
        let mut stands: Vec<(String, Seen)> = Vec::new();
        let mut stood: Vec<(String, Seen, Body)> = Vec::new();
        for (path, seen) in wants.own.iter() {
            // A store-owned path is the store's own to read, never the disk's (HL5a).
            if owned(path) {
                continue;
            }
            let left = wants.large.iter()
                .find(|(p, r)| p == path && Seen::Bytes(r.hash.clone()) == *seen)
                .map(|(_, r)| r);
            match crate::tools::standing_now(ctx, path).await {
                Some(now) if stands_as_seen(seen, left, &now) => {
                    stands.push((path.clone(), seen.clone()));
                    stood.push((path.clone(), seen.clone(), now));
                },
                now => if !off("phase_c") {
                    res!(self.standing(id, path, seen.clone(), now, None).await);
                },
            }
        }

        // THE WIPE OF A LARGE AFTER (§16.3a 2 (b)): the store never held its bytes, so the test
        // the record runs on a `Held` after is run here, on the file as it stands, only where its
        // bytes are the capture's own.
        if !off("turn_wiped") {
            for (path, seen, before) in wants.wipe.iter() {
                if owned(path) {
                    continue;
                }
                let now = match stood.iter().find(|(p, s, _)| p == path && s == seen) {
                    Some((_, _, now)) => now,
                    None              => continue,
                };
                let bytes = match now {
                    Body::Held(b) => Some(b.clone()),
                    _             => whole_if(ctx, path, seen).await,
                };
                let bytes = match bytes {
                    Some(b) => b,
                    None    => continue,    // not the capture's bytes: its own `wiped` stands
                };
                let was = res!(self.get(id, before).await);
                let call = StoreCall::TurnWiped {
                    id:     s(id),
                    path:   path.clone(),
                    seen:   seen.clone(),
                    wiped:  crate::tools::wiped(path, &was, &bytes),
                };
                res!(res!(answer!(self.link.call(&call).await, TurnWiped)));
            }
        }

        // A NOTE'S OR A WINDOW'S PATH, read afresh: the store names no `Seen` for it.  A path in
        // both lists is sent once, with its stamp where a window credits it.
        let mut sent: Vec<&str> = Vec::new();
        let paths = wants.notes.iter().chain(wants.windows.iter()).map(|(p, _)| p.as_str());
        for path in paths {
            if sent.contains(&path) || owned(path) || off("phase_c") {
                continue;
            }
            sent.push(path);
            let (now, total) = capped(ctx, path).await;
            let stamp = if wants.windows.iter().any(|(p, _)| p == path) {
                stamp_of(ctx, path, now.as_ref(), total).await
            } else {
                None
            };
            res!(self.standing(id, path, Seen::Unread, now, stamp).await);
        }

        for page in stands.chunks(LIST_PAGE) {
            let call = StoreCall::TurnStands { id: s(id), stands: page.to_vec() };
            res!(res!(answer!(self.link.call(&call).await, TurnStands)));
        }
        Ok(())
    }

    /// `turn_standing` of what was found at `path`, `None` where it could not be told: one frame,
    /// its body uploaded first.
    async fn standing(&self, id: &str, path: &str, seen: Seen, now: Option<Body>,
        stamp: Option<Stamp>) -> Outcome<()>
    {
        let standing = match &now {
            Some(b) => WireStanding::Now(WireBody::refer(b)),
            None    => WireStanding::Unknown,
        };
        let have: Vec<&[u8]> = match &now {
            Some(Body::Held(b)) => vec![b.as_slice()],
            _                   => Vec::new(),
        };
        let call = StoreCall::TurnStanding { id: s(id), path: s(path), seen, standing, stamp };
        res!(answer!(self.send(id, call, &have).await, TurnStanding))
    }
}

/// Is `path` store-owned ([`store_owned`](crate::tools::store_owned)), so that the turn end
/// stages no read of it: the store reads its own, and the run's disk copy is never its record.
fn owned(path: &str) -> bool { crate::tools::store_owned(FileRoot::Workspace, path).is_some() }

/// Does `now` stand as the capture the store names by `seen` left it?  The store's own rule,
/// [`versions::stands_as_left`], asked of the `after` the entry names: a `Large` one by the
/// reference `large` gives, a `Held` one by its hash, which is all the child is sent of it.
fn stands_as_seen(seen: &Seen, left: Option<&BodyRef>, now: &Body) -> bool {
    if let Some(r) = left {
        return versions::stands_as_left(&Body::Large(r.clone()), now);
    }
    match (seen, now) {
        (Seen::Absent, Body::Gone) | (_, Body::Unseen) | (Seen::Unread, _) => true,
        (Seen::Absent, _)                   => false,
        (Seen::Bytes(h), Body::Held(b))     => versions::hash_of(b) == *h,
        (Seen::Bytes(h), Body::Large(r) | Body::Stored(r)) => r.hash == *h,
        // A `Held` after is at most the ceiling, so a file over it is not that after.
        (Seen::Bytes(_), Body::TooLarge(_)) | (Seen::Bytes(_), Body::Gone) => false,
    }
}

/// The workspace file at `path` whole, read in chunks and hashed as it comes: `None` where it
/// would not read whole or is not the bytes `seen` names.
async fn whole_if<H: Host>(ctx: &ToolContext<H>, path: &str, seen: &Seen) -> Option<Vec<u8>> {
    let want = match seen {
        Seen::Bytes(h) => h,
        _              => return None,
    };
    let fs = ctx.host().fs();
    let mut hash = Sha256::new();
    let mut out: Vec<u8> = Vec::new();
    loop {
        let (chunk, total) = match fs.read_file_range(FileRoot::Workspace, path, out.len() as f64,
            BODY_CHUNK as u32).await
        {
            Ok(got) => got,
            Err(_)  => return None,
        };
        hash.update(&chunk);
        out.extend_from_slice(&chunk);
        if chunk.is_empty() || out.len() as f64 >= total {
            break;
        }
    }
    let got: String = hash.finish().iter().map(|b| fmt!("{:02x}", b)).collect();
    if got == *want { Some(out) } else { None }
}

/// A note's or a window's path read through the `Fs`, capped, with the file's whole length:
/// `None` where it could not be told.  **Only a path that is not there is `Gone`.**
async fn capped<H: Host>(ctx: &ToolContext<H>, path: &str) -> (Option<Body>, u64) {
    let fs = ctx.host().fs();
    let ceiling = versions::VERSION_FILE_MAX as u32;
    match fs.read_file_capped(FileRoot::Workspace, path, ceiling).await {
        Ok((b, total)) if total as usize <= versions::VERSION_FILE_MAX =>
            (Some(Body::Held(b)), total as u64),
        Ok((_, total)) => (Some(Body::TooLarge(total as u64)), total as u64),
        Err(_) => match fs.exists(FileRoot::Workspace, path).await {
            Ok(false)   => (Some(Body::Gone), 0),
            _           => (None, 0),
        },
    }
}

/// A window path's stamp as it stands, as the store stamps one (`diamond::stamp_of`): its write
/// time where the listing gives one, else its hash where it read whole, else its size.  `None`
/// where there is no file, or none could be listed.
async fn stamp_of<H: Host>(ctx: &ToolContext<H>, path: &str, now: Option<&Body>, total: u64)
    -> Option<Stamp>
{
    let (dir, leaf) = match path.rfind('/') {
        Some(i) => (&path[..i], &path[i + 1..]),
        None    => ("", path),
    };
    let listed = match ctx.host().fs().list_dir_stamped(FileRoot::Workspace, dir).await {
        Ok(l)   => l,
        Err(_)  => return None,
    };
    let (size, when) = match listed.into_iter().find(|(n, d, _, _)| n == leaf && !d) {
        Some((_, _, size, when)) => (size, when),
        None                     => return None,
    };
    if let Some(ms) = when.filter(|ms| ms.is_finite() && *ms > 0.0) {
        return Some(Stamp::Seen(size, Some(ms as u64)));
    }
    Some(match now {
        Some(Body::Held(b)) if total as usize <= versions::VERSION_FILE_MAX =>
            Stamp::Hashed(versions::hash_of(b)),
        _ => Stamp::Seen(size, None),
    })
}
