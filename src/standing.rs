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
mod tests {
    use super::*;

    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::collections::HashSet;
    use std::future::Future;
    use std::task::Context;
    use std::task::Poll;

    /// A store in memory, which fails the next read of a path in `fail` and answers the next read
    /// of a path in `hide` as absent while the file stands (a racing save not yet seen).
    #[derive(Default)]
    struct Mem {
        files:  RefCell<HashMap<String, Vec<u8>>>,
        fail:   RefCell<HashSet<String>>,
        hide:   RefCell<HashSet<String>>,
        race:   RefCell<Option<(String, Vec<u8>)>>,  // bytes that land just before a write there
    }

    impl Mem {
        fn put(&self, path: &str, text: &str) {
            self.files.borrow_mut().insert(path.to_string(), text.as_bytes().to_vec());
        }
        fn get(&self, path: &str) -> Option<Vec<u8>> {
            self.files.borrow().get(path).cloned()
        }
    }

    impl StandingStore for Mem {
        async fn read_bound(&self, path: &str) -> Outcome<Option<Vec<u8>>> {
            if self.fail.borrow_mut().remove(path) {
                return Err(err!("OPFS: read bytes of '{}' failed: NotReadableError.", path;
                    IO, File, Read));
            }
            if self.hide.borrow_mut().remove(path) {
                return Ok(None);
            }
            Ok(self.get(path))
        }
        async fn write_if(&self, path: &str, bytes: &[u8], expect: Option<&Seen>)
            -> Outcome<Option<Seen>>
        {
            let landed = match &*self.race.borrow() {
                Some((p, _)) => p == path,
                None         => false,
            };
            if landed {
                if let Some((p, b)) = self.race.borrow_mut().take() {
                    self.files.borrow_mut().insert(p, b);
                }
            }
            if let Some(want) = expect {
                let found = Seen::of(self.get(path).as_deref());
                if &found != want {
                    return Ok(Some(found));
                }
            }
            self.files.borrow_mut().insert(path.to_string(), bytes.to_vec());
            Ok(None)
        }
    }

    fn block_on<F: Future>(f: F) -> F::Output {
        let mut f  = Box::pin(f);
        let mut cx = Context::from_waker(std::task::Waker::noop());
        loop {
            if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
        }
    }

    const ID: &str = "d1";

    fn path(leaf: &str) -> String {
        crate::tools::standing_path(leaf, ID)
    }

    /// A Diamond with all three files and a crystal holding `open[]`.
    fn seeded() -> Mem {
        let m = Mem::default();
        m.put(&path(crate::tools::REQUIREMENTS_FILE), "# Requirements\n\n- [ ] mine\n");
        m.put(&path(crate::tools::DECISIONS_FILE), "# Decisions\n\n- 2026-10-01 kept\n");
        m.put(&path(crate::tools::STATE_FILE), "# State\n\nhalf way through the port\n");
        m.put(&crystal_path(ID), r#"{"title":"T","open":["call the bank"]}"#);
        m
    }

    #[test]
    fn test_ensure_standing_leaves_an_unreadable_file_byte_identical() {
        for leaf in crate::tools::STANDING_FILES {
            let m = seeded();
            let all_before = m.files.borrow().clone();
            m.fail.borrow_mut().insert(path(leaf));
            let got = block_on(ensure_standing_in(&m, ID));
            assert!(got.is_err(), "{} would not read, and the turn was given files", leaf);
            assert_eq!(all_before, *m.files.borrow(),
                "{} would not read once, and the store changed", leaf);
        }
    }

    #[test]
    fn test_read_standing_answers_an_unreadable_file_as_an_error() {
        let m = seeded();
        m.fail.borrow_mut().insert(path(crate::tools::STATE_FILE));
        assert!(block_on(read_standing_in(&m, ID)).is_err());
    }

    #[test]
    fn test_ensure_standing_never_seeds_over_a_file_that_landed_after_the_read() {
        let m = seeded();
        let state = path(crate::tools::STATE_FILE);
        m.hide.borrow_mut().insert(state.clone());
        let (files, _) = match block_on(ensure_standing_in(&m, ID)) {
            Ok(v)  => v,
            Err(e) => panic!("{}", e),
        };
        assert_eq!(Some(b"# State\n\nhalf way through the port\n".to_vec()), m.get(&state));
        assert_eq!("# State\n\nhalf way through the port\n", files.state);
    }

    #[test]
    fn test_ensure_standing_seeds_absent_files_and_files_open() {
        let m = Mem::default();
        m.put(&crystal_path(ID), r#"{"title":"T","open":["call the bank"]}"#);
        let (files, notes) = match block_on(ensure_standing_in(&m, ID)) {
            Ok(v)  => v,
            Err(e) => panic!("{}", e),
        };
        assert!(notes.iter().all(|n| n.contains("moved into")), "{:?}", notes);
        assert_eq!(crate::tools::standing_template(crate::tools::STATE_FILE), files.state);
        assert!(files.requirements.contains("- [ ] call the bank"));
        assert_eq!(Some(files.requirements.as_bytes().to_vec()),
            m.get(&path(crate::tools::REQUIREMENTS_FILE)));
        let crystal = String::from_utf8_lossy(&m.get(&crystal_path(ID)).unwrap_or_default())
            .into_owned();
        assert!(!crystal.contains("open"), "{}", crystal);
        // Idempotent: a second turn writes nothing.
        let before = m.files.borrow().clone();
        assert!(block_on(ensure_standing_in(&m, ID)).is_ok());
        assert_eq!(before, *m.files.borrow());
    }

    #[test]
    fn test_open_stays_in_the_crystal_when_requirements_changed_under_the_filing() {
        let m = seeded();
        let req = path(crate::tools::REQUIREMENTS_FILE);
        // A save of REQUIREMENTS.md lands between the turn's read and the filing's write.
        *m.race.borrow_mut() = Some((req.clone(), b"# Requirements\n\n- [ ] theirs\n".to_vec()));
        let crystal_before = m.get(&crystal_path(ID));
        let _ = block_on(ensure_standing_in(&m, ID));
        assert_eq!(Some(b"# Requirements\n\n- [ ] theirs\n".to_vec()), m.get(&req));
        // `open[]` stays in the crystal for the next turn to file, rather than leaving it for a
        // file that did not take it.
        assert_eq!(crystal_before, m.get(&crystal_path(ID)));
    }
}
