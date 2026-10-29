//! The three standing files beside a Diamond's crystal, read and seeded through one store.
//!
//! r578f (2026-10-23, E-PORT QA-A1 F2): the logic of `wasm::diamond::read_standing` and
//! `ensure_standing`, lifted out of the page so it is proved without a browser.  The page's
//! store is OPFS; a test's is a map that can be told to fail a read or
//! to have a save land under a write.

use crate::diamond_versions::Seen;

use oxedyne_fe2o3_core::prelude::*;

/// Where the three files are read and written: OPFS in the page, a map in a test.
#[allow(async_fn_in_trait)]
pub trait StandingStore {
    /// A file's bytes, `None` where it does not exist; any other failure to read is an error.
    async fn read_bound(&self, path: &str) -> Outcome<Option<Vec<u8>>>;
    /// Write `bytes` only where what stands at `path` is still `expect` (`None` is unbound):
    /// `None` once written, or what stands there instead, with nothing written.
    async fn write_if(&self, path: &str, bytes: &[u8], expect: Option<&Seen>)
        -> Outcome<Option<Seen>>;
}

/// The three files as they sit on disk, empty where a file does not exist yet.
///
/// **A file that will not read is an error and never an empty file** (QA-A1 F2): OPFS answers
/// `NotReadableError` while a save commits, and every caller of this one goes on to write the
/// files back -- a turn's seeding, a fold's landing, the fold's notes -- so an empty answer there
/// is the template or a reducer's rewrite of nothing landing over the person's record.
pub async fn read_standing_in<S: StandingStore>(store: &S, id: &str)
    -> Outcome<crate::tools::Standing>
{
    let mut files = crate::tools::Standing::default();
    for leaf in crate::tools::STANDING_FILES {
        let now = res!(read_one(store, id, leaf).await);
        *field(&mut files, leaf) = text_of(now.as_deref());
    }
    Ok(files)
}

/// The three files, seeded from the shipped templates where this Diamond has none, with the
/// crystal's `open[]` filed under `## Unfiled` in `REQUIREMENTS.md` and its key deleted.
///
/// **Only an absent file is seeded, and only while it is still absent**: a file that will not read
/// fails the whole call with nothing written, and the seed is a write bound to `Seen::Absent`, so
/// a save landing between the read and the seed is kept and read back rather than written over.
/// The filing is bound to the `REQUIREMENTS.md` it was made from, and the crystal loses `open[]`
/// only after that write has landed, so an entry is never in neither place.
///
/// Answers the files and what could not be done, for the caller to log.
pub async fn ensure_standing_in<S: StandingStore>(store: &S, id: &str)
    -> Outcome<(crate::tools::Standing, Vec<String>)>
{
    let mut notes = Vec::new();
    let mut files = crate::tools::Standing::default();
    let mut req: Option<(Seen, Option<Vec<u8>>)> = None;   // REQUIREMENTS.md as it stands
    for leaf in crate::tools::STANDING_FILES {
        let path = crate::tools::standing_path(leaf, id);
        let now = match res!(read_one(store, id, leaf).await) {
            Some(b) => Some(b),
            None    => {
                let seed = crate::tools::standing_template(leaf).as_bytes();
                match store.write_if(&path, seed, Some(&Seen::Absent)).await {
                    Ok(None)    => Some(seed.to_vec()),
                    // Landed since the read: what stands is the file, and it is read again.
                    Ok(Some(_)) => res!(read_one(store, id, leaf).await),
                    Err(e)      => {
                        notes.push(fmt!("{} could not be seeded ({}).", leaf, e));
                        if leaf == crate::tools::REQUIREMENTS_FILE {
                            req = Some((Seen::Unread, None));
                        }
                        *field(&mut files, leaf) = crate::tools::standing_template(leaf)
                            .to_string();
                        continue;
                    },
                }
            },
        };
        *field(&mut files, leaf) = text_of(now.as_deref());
        if leaf == crate::tools::REQUIREMENTS_FILE {
            req = Some((Seen::of(now.as_deref()), now));
        }
    }
    if let Some((seen, bytes)) = req {
        if let Some(text) = migrate_open(store, id, &seen, bytes.as_deref(), &mut notes).await {
            files.requirements = text;
        }
    }
    Ok((files, notes))
}

/// One of the three, `None` where it does not exist, and an error naming it where it will not read.
async fn read_one<S: StandingStore>(store: &S, id: &str, leaf: &str) -> Outcome<Option<Vec<u8>>> {
    match store.read_bound(&crate::tools::standing_path(leaf, id)).await {
        Ok(now) => Ok(now),
        Err(e)  => Err(err!(
            "Diamond '{}': {} could not be read ({}), so it was left exactly as it stands and \
            nothing was written.", id, leaf, e; IO, File, Read)),
    }
}

fn text_of(now: Option<&[u8]>) -> String {
    now.map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default()
}

/// Move the crystal's `open[]` into `REQUIREMENTS.md`, answering that file's new text where it
/// was written.
///
/// `seen` and `bytes` are `REQUIREMENTS.md` as the turn holds it.  The filing lands only on those
/// bytes, and `open[]` leaves the crystal only once it has, and only from the crystal that was
/// read: where either moved, the entries stay where they are for the next turn, whose filing
/// dedupes by whole line.
async fn migrate_open<S: StandingStore>(store: &S, id: &str, seen: &Seen,
    bytes: Option<&[u8]>, notes: &mut Vec<String>)
    -> Option<String>
{
    let path = crystal_path(id);
    let json_bytes = match store.read_bound(&path).await {
        Ok(Some(b)) => b,
        Ok(None)    => return None,
        Err(e)      => {
            notes.push(fmt!("open[] was left in the crystal, which could not be read ({}).", e));
            return None;
        },
    };
    // Not UTF-8 is "will not parse": this rewrites the file, and a lossy read would have written
    // U+FFFD over every byte it could not decode.
    let json = match crate::tools::utf8_text(&json_bytes, &path) {
        Ok(t)  => t,
        Err(_) => return None,
    };
    let (rest, open) = match crate::tools::crystal_without_open(&json) {
        Some(pair) => pair,
        None       => return None,
    };
    let req_path = crate::tools::standing_path(crate::tools::REQUIREMENTS_FILE, id);
    let was = match (seen, bytes) {
        (Seen::Unread, _) => return None,
        (_, None)         => String::new(),
        (_, Some(b))      => match crate::tools::utf8_text(b, &req_path) {
            Ok(t)  => t,
            Err(_) => {
                notes.push(fmt!("open[] was left in the crystal: {} is not UTF-8.",
                    crate::tools::REQUIREMENTS_FILE));
                return None;
            },
        },
    };
    let filed = crate::tools::file_unfiled(&was, &open);
    let mut out = None;
    if filed != was {
        match store.write_if(&req_path, filed.as_bytes(), Some(seen)).await {
            Ok(None)    => out = Some(filed),
            Ok(Some(_)) => {
                notes.push(fmt!("{} changed while open[] was being filed; open[] stays in the \
                    crystal for the next turn.", crate::tools::REQUIREMENTS_FILE));
                return None;
            },
            Err(e)      => {
                notes.push(fmt!("{} open[] entries could not be filed ({}).", open.len(), e));
                return None;
            },
        }
    }
    match store.write_if(&path, rest.as_bytes(), Some(&Seen::of(Some(&json_bytes)))).await {
        Ok(None)    => notes.push(fmt!("{} open[] entries moved into {} and the key deleted.",
            open.len(), crate::tools::REQUIREMENTS_FILE)),
        Ok(Some(_)) => notes.push(fmt!("The crystal changed while open[] was being filed; the key \
            stays, and the next turn finds its entries already filed.")),
        Err(e)      => notes.push(fmt!("open[] was filed but not deleted from the crystal ({}).", e)),
    }
    out
}

/// `diamonds/<id>/crystal.json`.
fn crystal_path(id: &str) -> String {
    fmt!("{}/{}/{}", crate::tools::STORE_ROOT, id, crate::tools::CRYSTAL_DATA_FILE)
}

/// The field of `files` that holds `leaf`.
fn field<'a>(files: &'a mut crate::tools::Standing, leaf: &str) -> &'a mut String {
    match leaf {
        crate::tools::REQUIREMENTS_FILE => &mut files.requirements,
        crate::tools::DECISIONS_FILE    => &mut files.decisions,
        _                               => &mut files.state,
    }
}

#[cfg(test)]
#[path = "../tests/unit/standing/tests.rs"]
mod tests;
