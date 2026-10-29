use super::*;

impl Tool {
    /// `file_write` in the browser.  Its own function rather than an arm of `execute`, for the
    /// reason [`Self::file_delete`] is: a debug build of the wasm keeps every local of
    /// `execute`'s one future, and the format's limit is 50,000 (Q5-1 open item 2).
    pub(super) async fn file_write_page<H: Host>(args_json: &str, ctx: &ToolContext<H>) -> Outcome<MessageContent> {
        let text: Outcome<String> = {
            let raw = res!(Self::arg(args_json, "path"));
            let path = res!(Self::scoped(ctx, &raw));
            let content = res!(Self::arg(args_json, "content"));
            // THE WRITE FENCE, before anything is read or held: the only way this arm can name
            // a path to a door that changes one (see `Licence`).
            let lic = match ctx.licence(&path) {
                Ok(l)    => l,
                Err(why) => return Ok(MessageContent::text(why)),
        };
        // THE MACHINE, WHERE THE PATH IS UNDER A MARK. Above `write_place`, which is the
        // sentence that exists BECAUSE there was no door: it refuses a write that would
        // invent a folder in browser storage while the daimon believed it had changed a
        // file on disk. Where the write can reach the disk, that is not the question any
        // more.
        match reach_of(ctx, &raw, &path, Door::Change).await {
            Reach::Refuse(why) => return Ok(MessageContent::text(refusal_line(&why))),
            Reach::Machine { abs, cwd, root, spec } => {
                // THE BYTES THAT ARE ABOUT TO BE GONE. A Diamond's history can put a
                // machine file back only where the app took a copy at the instant it was
                // changed, because the hand returns no prior content and keeps no
                // journal. See `machine_before`, which can refuse nothing.
                let keep = match ctx.keeper() {
                    Some(d) => Some((d,
                        machine_before(&abs, &cwd, &spec, &ctx.no_write, ctx.host()).await)),
                    None    => None,
                };
                // A FILE THAT IS THERE AND COULD NOT BE KEPT is not overwritten: the
                // delete's rule, at the write door (audit of 2026-09-23, finding 5).
                if let Some((_, (None, Some(why)))) = &keep {
                    return Ok(MessageContent::text(overwrite_unkept_refusal(&raw, why)));
                }
                // THE STALE-READ GUARD, as the storage door below asks it and in its words
                // (fix/r51e, 2026-09-25): a file this agent read and the person has since
                // edited in their own editor, or restored from its History, is not written
                // over from the old read.  The bytes are the ones kept above; a turn with no
                // keeper reads them only where there is a read to compare.
                let at = Storage::Machine(root.clone());
                // What the guard passed, which the write is bound to where the hand compares as
                // it writes (`machine_write`): a save in the person's editor during the hand's
                // round trip is refused there rather than written over.
                let mut guarded: Option<crate::diamond_versions::Seen> = None;
                if ctx.restoring == 0 && lock_cache(&ctx.read_seen).seen.contains_key(&at, &path) {
                    let fresh;
                    let found = match &keep {
                        Some((_, f)) => f,
                        None         => {
                            fresh = machine_before(&abs, &cwd, &spec, &ctx.no_write, ctx.host()).await;
                            &fresh
                        },
                    };
                    // Its bytes, or nothing there, which is a change as an edit is (RD2); a
                    // file there that would not read has nothing to compare.
                    let now: Option<Option<&[u8]>> = match found {
                        (Some(b), _)    => Some(Some(b.as_slice())),
                        (None, None)    => Some(None),
                        (None, Some(_)) => None,
                    };
                    if let Some(now) = now {
                        if let Some(why) = stale_write(&ctx.read_seen, &at, &path, Some(&abs), now) {
                            return Err(err!("{}", why; Invalid, Input, Mismatch));
                        }
                        guarded = Some(crate::diamond_versions::Seen::of(now));
                    }
                }
                // A file this agent never read is bound to the version capture's read of it, so
                // a save between that read and the write is not written over either.
                let bound = match ctx.restoring {
                    0 => WriteBound::of(guarded, keep.as_ref().map(|(_, (b, _))|
                        crate::diamond_versions::Seen::of(b.as_deref()))),
                    _ => None,
                };
                // AN OVERWRITE OF A FILE THAT WAS THERE counts against the turn's bound,
                // and its copy is on disk before the write -- held as a delete's is where
                // the write wipes it (`Tool::before_overwrite`).
                let mut over: Option<Overwrite> = None;
                match &keep {
                    Some((dia, (Some(before), _))) => match Self::before_overwrite(ctx, dia, &abs,
                        &raw, Some(before), Some(content.as_bytes()), true).await
                    {
                        Ok(o)    => over = Some(o),
                        Err(why) => return Ok(MessageContent::text(why)),
                    },
                    // Nothing there: the file the write makes is told to the host first.
                    Some((dia, (None, None))) => if let Err(why) =
                        Self::note_create(ctx, dia, &abs, &raw).await
                    {
                        return Ok(MessageContent::text(why));
                    },
                    _ => {},
                }
                // A RESTORE'S WRITE KEEPS WHAT IT REPLACES, read through the hand at the act:
                // the person's own save since the version is the file's newest state, and the
                // restore is the one thing that would otherwise write over it with no copy.
                // And the hand compares as it writes, as `put_bytes` has it (hist-safe F1).
                let (rest, seen) = if ctx.restoring != 0 {
                    let now = match machine_before(&abs, &cwd, &spec, &ctx.no_write, ctx.host()).await {
                        (None, Some(why)) => {
                            Self::overwrite_failed(&over, ctx.host()).await;
                            return Ok(MessageContent::text(overwrite_unkept_refusal(&raw, &why)));
                        },
                        (b, _)            => b,
                    };
                    let seen = crate::diamond_versions::Seen::of(now.as_deref());
                    match Self::restore_hold(ctx, &raw, &abs, now.as_deref(),
                        Some(content.as_bytes())).await
                    {
                        Ok(h)    => (h, seen),
                        Err(why) => {
                            Self::overwrite_failed(&over, ctx.host()).await;
                            return Ok(MessageContent::text(why));
                        },
                    }
                } else {
                    (None, crate::diamond_versions::Seen::Unread)
                };
                // HIS FILE, ASKED ABOUT (UNBLOCK-26 U3): under the marks as they stand now, and only
                // over the text he was shown.
                let (lic, bound) = match Self::machine_bound(ctx, &lic, &over).await {
                    Ok(Some((l, b))) => (l, Some(b)),
                    Ok(None)    => (lic, bound),
                    Err(why)    => {
                        Self::overwrite_failed(&over, ctx.host()).await;
                        return Ok(MessageContent::text(why));
                    },
                };
                let got = match machine_change("file_write",
                    machine_write(rest.is_some(), &lic, &content, &seen, bound.as_ref()), &root,
                    &cwd, &spec, &ctx.no_write, ctx.host()).await
                {
                    Ok(g)  => g,
                    Err(e) => {
                        Self::overwrite_failed(&over, ctx.host()).await;
                        Self::restore_failed(&rest, ctx.host()).await;
                        return Err(e);
                    },
                };
                if got.is_err() {
                    Self::overwrite_failed(&over, ctx.host()).await;
                }
                if let Some(said) = Self::restore_hand_changed(ctx, &raw, &rest, &got).await {
                    return Ok(MessageContent::text(said));
                }
                if got.is_err() {
                    Self::restore_failed(&rest, ctx.host()).await;
                }
                // The hand refused the bound write: what stood there changed since the read.
                if let (Err(why), None, Some(b)) = (&got, &rest, &bound) {
                    if let Some(said) = b.hand_refusal("file_write", &raw, why) {
                        return Err(err!("{}", said; Invalid, Input, Mismatch));
                    }
                }
                return match got {
                    Ok(_)    => {
                        // What this agent now knows the file holds, as the storage door
                        // records it; and under a restore, what the restore left.
                        lock_cache(&ctx.read_seen).seen.insert(&at, &path,
                            content_hash(content.as_bytes()));
                        if ctx.restoring != 0 {
                            note_restored(&ctx.read_seen, &at, &abs, content.as_bytes());
                        }
                        let mut unkept = String::new();
                        unkept.push_str(&Self::restore_landed(rest, crate::diamond_versions::Body::Held(
                            content.as_bytes().to_vec()), ctx.host()));
                        if let Some((dia, (before, refused))) = keep {
                            let found = machine_found(&before, &refused);
                            let (before, wiped) = Overwrite::prior(&over, before);
                            unkept.push_str(&Self::unkept(ctx.host(), ctx.host().store().capture(&dia, &raw,
                                crate::diamond_versions::Change {
                                    path:    abs.clone(),
                                    after:   crate::diamond_versions::Body::Held(
                                        content.as_bytes().to_vec()),
                                    before: before.map(crate::diamond_versions::Prior::Held),
                                    found,
                                    carried: None,
                                    mark:    true,
                                    refused,
                                    wiped,
                                    folder:  None,
                                    by:      ctx.by.clone(),
                                    door:    false,
                                }), &abs));
                        }
                        Ok(MessageContent::text(
                            fmt!("Wrote {} bytes to {}.{}{}", content.len(), abs, unkept,
                                Self::file_write_nudge(content.len()))))
                    },
                    Err(why) => Err(err!("{}", why; IO, File, Write)),
                };
            },
            Reach::Storage => (),
        }
        // Where the write lands, for the guard below and the record it leaves: taken once, before
        // any of its I/O, so both name the storage the write used.
        let at = stored_in(ctx, &path);
        // WHICH FILESYSTEM THIS IS ABOUT TO LAND IN, asked before it lands and not
        // after.  A write that would invent a folder in browser storage is refused
        // outright; one that lands says where.  See the section above `Tool::run`'s
        // script rules for why this one arm refuses where the other seven annotate.
        let place = res!(write_place(ctx, &raw, &path).await);
        if let WritePlace::Inventing(dir) = &place {
            return Ok(MessageContent::text(
                refusal_line(&would_invent_said(&raw, dir,
                    &marks_of(&ctx.no_write).join(", ")))));
        }
        let place_line = match place {
            WritePlace::Storage => fmt!("\n{}", landed_in_storage()),
            _                   => String::new(),
        };
        // If this agent has seen the file before, refuse to overwrite it
        // when the bytes on disk no longer match what it last saw -- that
        // means another agent changed it underneath, and a blind write
        // would erase their work with no error. A new file, or one this
        // agent never read, has nothing to conflict with.
        //
        // NOT A RESTORE'S QUESTION (U2 of the release 5.1 fix's second QA, 2026-09-25). A
        // restore's act keeps whatever stands there at the act (`restore_hold` below), which is
        // what this guard protects, and it is no agent's edit. Asked of the restore door, the
        // guard refused to put back any file a steer on the page had touched and the person had
        // saved since, in a sentence addressed to a model.
        let seen = match ctx.restoring {
            0 => lock_cache(&ctx.read_seen).seen.contains_key(&at, &path),
            _ => false,
        };
        // What the guard passed, which the write is bound to (`guarded_store_write`): the guard
        // reads before the write takes the file's lock, so a save landing in between is refused
        // there, under the lock, rather than written over.
        let mut guarded: Option<crate::diamond_versions::Seen> = None;
        if seen {
            // A FILE NOT THERE ANY MORE has changed as an edited one has (RD2).  `before_bytes`
            // tells it from one that is there and would not read, or is only in cloud storage,
            // which have nothing to compare and meet the copy's own refusal below.
            if let Ok(now) = Self::before_bytes(ctx, &path).await {
                if let Some(why) = stale_write(&ctx.read_seen, &at, &path, None, now.as_deref()) {
                    return Err(err!("{}", why; Invalid, Input, Mismatch));
                }
                guarded = Some(crate::diamond_versions::Seen::of(now.as_deref()));
            }
        }
        // THE BYTES THAT ARE ABOUT TO BE GONE, in browser storage as the machine arm
        // above takes them off the disk.  Without this the FIRST change to any file kept
        // no `was` at all: `versions_record` falls back to what the store last recorded,
        // and for a file no version has ever named that is nothing -- so the one change a
        // person is likeliest to regret was the one with nowhere to go back to, and a
        // delete of such a file was dropped from the manifest entirely.
        //
        // Read here rather than at the write, because `standing_retired` below may rewrite
        // the file's own content before it lands, and what is wanted is what stood there
        // when the turn arrived.
        let keep = match ctx.keeper() {
            Some(d) => match Self::before_bytes(ctx, &path).await {
                Ok(b)    => Some((d, b)),
                Err(why) => return Ok(MessageContent::text(
                    overwrite_unkept_refusal(&raw, &why))),
            },
            None    => None,
        };
        // THE THREE MARKDOWN FILES RETIRE BEFORE THEY ARE MEASURED, so the ceiling the
        // refusal below reports is on what is LIVE. The arithmetic is the app's; a model
        // asked to prune its own record prunes what it judges unimportant, which is the
        // judgement the record exists to survive.
        // It only reads: what it moves waits in `landed` until the write is accepted (F6).
        let landed = res!(ctx.host().store().standing_retired(ctx.root, &path, content).await);
        let mut content = landed.kept.clone();
        let retired = landed.said.clone();
        let mut demoted = String::new();
        // A Diamond has a ceiling on five of its files, and this is the door a daimon
        // uses: it edits them with the ordinary file tools, and the store only sees the
        // result afterwards, when `record_steer` snapshots whatever is on disk. Refusing
        // there would be refusing a write that already happened.
        if is_crystal_data_path(&path) || is_crystal_page_path(&path)
            || standing_leaf(&path).is_some()
        {
            // The TEXT and not its length: the hot ceiling has to split each side
            // before it can measure it. Lossy where the file is not UTF-8, which a
            // crystal and a page both are; the total ceiling's arithmetic is on bytes
            // either way, and `from_utf8_lossy` does not change a byte of valid text.
            let old = ctx.host().fs().read_file(ctx.root, &path).await
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_default();
            let (got, said) = res!(Self::cap_door(ctx, "file_write", &path, content, &old).await);
            content = got;
            demoted = said;
            // And a crystal that is not one JSON object: the panel would show it as raw text and
            // the page would draw nothing from it.  Refused with the place, so that the turn
            // writes it again rather than finding out fourteen minutes later.
            if let Some(msg) = crystal_invalid_refusal(&path, &content) {
                return Err(err!("file_write: {}", msg; Invalid, Input, Data));
            }
            Self::hot_landed(&path, ctx.host()).await;
        }
        // A path naming an Office document means the content is MARKDOWN and the file is a
        // real document. The name decides, not the bytes: `.docx` is what the user will
        // double-click, and it is the same rule `file_read` uses to decide to unpack one.
        let office = match office_kind(&path) {
            Some(media) => Some(res!(office_written(&path, media, &content))),
            None        => None,
        };
        // AN OVERWRITE OF A FILE THAT WAS THERE counts against the turn's bound, and its
        // copy is on disk before the write -- held as a delete's is, and asked about in the
        // open folder as one is, where the write wipes it.
        let over = {
            let after: &[u8] = match &office {
                Some((bytes, _)) => bytes,
                None             => content.as_bytes(),
            };
            match &keep {
                Some((dia, Some(b))) => match Self::before_overwrite(ctx, dia, &path, &raw,
                    Some(b), Some(after), true).await
                {
                    Ok(o)    => Some(o),
                    Err(why) => return Ok(MessageContent::text(why)),
                },
                // Nothing there: the file the write makes is told to the host first.
                Some((dia, None)) => match Self::note_create(ctx, dia, &path, &raw).await {
                    Ok(())   => None,
                    Err(why) => return Ok(MessageContent::text(why)),
                },
                None => None,
            }
        };
        // A RESTORE'S WRITE KEEPS WHAT IT REPLACES, read the moment before it lands: what the
        // person saved while the restore's question was open included.
        let rest = if ctx.restoring != 0 {
            let now = match Self::before_bytes(ctx, &path).await {
                Ok(b)    => b,
                Err(why) => return Ok(MessageContent::text(overwrite_unkept_refusal(&raw, &why))),
            };
            let puts: &[u8] = match &office {
                Some((bytes, _)) => bytes,
                None             => content.as_bytes(),
            };
            match Self::restore_hold(ctx, &raw, &normalise(&path), now.as_deref(), Some(puts))
                .await
            {
                Ok(h)    => h,
                Err(why) => return Ok(MessageContent::text(why)),
            }
        } else {
            None
        };
        // A file this agent never read is bound to the version capture's read of it (`keep`, above):
        // a save between that read and the write is refused under the lock, not written over and
        // kept nowhere.  A restore's write is bound to its own hold instead.
        let bound = match ctx.restoring {
            0 => WriteBound::of(guarded, keep.as_ref().map(|(_, b)|
                crate::diamond_versions::Seen::of(b.as_deref()))),
            _ => None,
        };
        // ACCEPTED: the landing's side files go down with the file, under its lock -- the archive
        // before the bytes, DECISIONS.md and the touched record after (F6, held-lock settle P3).
        // An office file is never a standing one, so it has nothing to settle.
        if let Some((bytes, note)) = office {
            match Self::restore_store_write(ctx, &raw, &lic, &bytes, &rest, bound.as_ref(), &over,
                None).await
            {
                Ok(Ok(_))      => {},
                Ok(Err(said))  => {
                    Self::overwrite_failed(&over, ctx.host()).await;
                    return Ok(MessageContent::text(said));
                },
                Err(e)         => {
                    Self::overwrite_failed(&over, ctx.host()).await;
                    Self::restore_failed(&rest, ctx.host()).await;
                    return Err(e);
                },
            }
            let mut unkept = String::new();
            unkept.push_str(&Self::restore_landed(rest, crate::diamond_versions::Body::Held(bytes.clone()), ctx.host()));
            if let Some((dia, before)) = keep {
                let found = Found::of(before.as_deref());
                let (before, wiped) = Overwrite::prior(&over, before);
                unkept.push_str(&Self::captured_write(ctx, &dia, &path, bytes.clone(), found, before, wiped));
            }
            lock_cache(&ctx.read_seen).seen.insert(&at, &path, content_hash(&bytes));
            return Ok(MessageContent::text(
                fmt!("Wrote {} bytes to {}.{}{}{}{}", bytes.len(), path, note, place_line, unkept,
                    Self::file_write_nudge(content.len()))));
        }
        let noted = match Self::restore_store_write(ctx, &raw, &lic, content.as_bytes(), &rest,
            bound.as_ref(), &over, Some(&landed)).await
        {
            Ok(Ok(noted))  => noted,
            Ok(Err(said))  => {
                Self::overwrite_failed(&over, ctx.host()).await;
                return Ok(MessageContent::text(said));
            },
            Err(e)         => {
                Self::overwrite_failed(&over, ctx.host()).await;
                Self::restore_failed(&rest, ctx.host()).await;
                return Err(e);
            },
        };
        let mut unkept = String::new();
        unkept.push_str(&Self::restore_landed(rest, crate::diamond_versions::Body::Held(content.as_bytes().to_vec()), ctx.host()));
        if let Some((dia, before)) = keep {
            let found = Found::of(before.as_deref());
            let (before, wiped) = Overwrite::prior(&over, before);
            unkept.push_str(&Self::captured_write(ctx, &dia, &path, content.as_bytes().to_vec(), found, before,
                wiped));
        }
        lock_cache(&ctx.read_seen).seen.insert(&at, &path, content_hash(content.as_bytes()));
        Ok(fmt!("{}Wrote {} bytes to {}.{}{}{}{}{}", demoted, content.len(), path, place_line,
            retired, noted, unkept, Self::file_write_nudge(content.len())))
        };
        Ok(MessageContent::text(res!(text)))
    }

    /// A restore's write: put the body the store holds under `hash` back at `path`, BYTE FOR BYTE,
    /// through the Diamond's fence ([`ToolRegistry::put_back`]).  `{path, hash}`; no model holds it.
    ///
    /// **Why this is not `file_write`** (release 5.1's restore follow-ups, 2026-09-25).  The
    /// History's Restore and a turn's Undo wrote a person's file back through `file_write`, whose
    /// `content` is text: the page read the body as lossy UTF-8, and a `.docx` path turned that
    /// text, as markdown, into a new document.  A restored PNG, PDF or Word file came back
    /// corrupt, while today's bytes were kept.  Here the bytes go from the store to the file
    /// unread by anything that could change them: no text, no office conversion, no retirement.
    ///
    /// **The machine hand's `write` carries text** (`hand/src/codec.rs`), so on this computer a
    /// body that is not UTF-8 is refused and the file left, as `file_revert` refuses it.  Its act
    /// keeps what it replaces as every restore's act does ([`Self::restore_hold`]), and a refused
    /// one keeps, records and notes nothing.  The model's stale-read guard is not asked, since the
    /// act keeps what it replaces; nor is the read cache changed, so a daimon that read the file
    /// before the restore is refused its next blind write.
    pub(super) async fn put_back_page<H: Host>(args_json: &str, ctx: &ToolContext<H>) -> Outcome<MessageContent> {
        let raw = res!(Self::arg(args_json, "path"));
        let hash = res!(Self::arg(args_json, "hash"));
        let path = res!(Self::scoped(ctx, &raw));
        let lic = match ctx.licence(&path) {
            Ok(l)    => l,
            Err(why) => return Ok(MessageContent::text(why)),
        };
        let id = match ctx.host().store().restore_store(ctx.restoring) {
            Some(id) => id,
            None     => return Ok(MessageContent::text(restore_ended_refusal(&raw))),
        };
        let body = match res!(ctx.host().store().versions_body(&id, &hash).await) {
            Some(b) => b,
            None    => return Ok(MessageContent::text(put_back_absent_refusal(&raw))),
        };
        Self::put_bytes(ctx, &raw, &path, &lic, body).await
    }

    /// The page's look at one of the person's files an open restore could not read, through this
    /// context's fence: `{"over":bool}`, whether the person is asked before the restore's act goes
    /// over what stands there, which that act is then bound to
    /// ([`crate::wasm::diamond::restore_look`]; hist-safe R2, 2026-10-12).  Changes nothing.
    pub(super) async fn restore_look_page<H: Host>(args_json: &str, ctx: &ToolContext<H>) -> Outcome<MessageContent> {
        let raw = res!(Self::arg(args_json, "path"));
        let path = res!(Self::scoped(ctx, &raw));
        let now = match reach_of(ctx, &raw, &path, Door::Look).await {
            Reach::Refuse(why) => return Ok(MessageContent::text(refusal_line(&why))),
            Reach::Machine { abs, cwd, spec, .. } =>
                match machine_before(&abs, &cwd, &spec, &ctx.no_write, ctx.host()).await {
                    (Some(b), _)   => crate::diamond_versions::Seen::of(Some(&b)),
                    (None, None)   => crate::diamond_versions::Seen::Absent,
                    (None, Some(_)) => crate::diamond_versions::Seen::Unread,
                },
            Reach::Storage => match Self::before_bytes(ctx, &path).await {
                Ok(b)  => crate::diamond_versions::Seen::of(b.as_deref()),
                Err(_) => crate::diamond_versions::Seen::Unread,
            },
        };
        // A FILE THAT WOULD NOT READ IS NOT ASKED ABOUT (hist-safe F3, 2026-10-12): the act reads
        // it again and, finding nothing it was bound to, refused it as changed after the person had
        // said yes.  The page leaves it as it stands and says it could not be read now.
        let unread = now == crate::diamond_versions::Seen::Unread;
        Ok(MessageContent::text(match ctx.host().store().restore_look(ctx.restoring, &raw, now) {
            Some(_) if unread => "{\"unread\":true}".to_string(),
            Some(over) => fmt!("{{\"over\":{}}}", over),
            None       => refusal_line(&fmt!("'{}' is no file of an open restore, so there is \
                nothing to look at. Nothing was changed.", raw)),
        }))
    }

    /// A page door's write of `bytes` at `raw`, byte for byte, through this context's fence: the
    /// Files panel's Undo of a delete ([`ToolRegistry::write_bytes_door`]).  No model holds it.
    ///
    /// **The Undo wrote a deleted file back as text** (release 5.1 QA round 3, FP): the panel read
    /// it with `read_file`, lossily, and wrote it with `file_write`, so a PNG or a PDF came back
    /// corrupt and a `.docx` became a new document of its text.
    pub(super) async fn write_bytes_page<H: Host>(raw: &str, bytes: Vec<u8>, ctx: &ToolContext<H>)
        -> Outcome<MessageContent>
    {
        let path = res!(Self::scoped(ctx, raw));
        let lic = match ctx.licence(&path) {
            Ok(l)    => l,
            Err(why) => return Ok(MessageContent::text(why)),
        };
        Self::put_bytes(ctx, raw, &path, &lic, bytes).await
    }

    /// Write `body` at the licensed `path`, byte for byte: through the hand where the path is
    /// under a mark on the machine, which carries text only, else into storage.  Under a restore
    /// the act keeps what it replaces ([`Self::restore_hold`]); for any other caller it keeps
    /// nothing, as `file_write` for the same caller keeps nothing.
    pub(super) async fn put_bytes<H: Host>(ctx: &ToolContext<H>, raw: &str, path: &str, lic: &Licence, body: Vec<u8>)
        -> Outcome<MessageContent>
    {
        let raw = raw.to_string();
        let path = path.to_string();
        match reach_of(ctx, &raw, &path, Door::Change).await {
            Reach::Refuse(why) => return Ok(MessageContent::text(refusal_line(&why))),
            Reach::Machine { abs, cwd, root, spec } => {
                // Checked before anything is read or held, so a refusal keeps nothing.
                let text = match std::str::from_utf8(&body) {
                    Ok(t)  => t.to_string(),
                    Err(_) => return Ok(MessageContent::text(put_back_binary_refusal(&raw))),
                };
                let now = match machine_before(&abs, &cwd, &spec, &ctx.no_write, ctx.host()).await {
                    (None, Some(why)) => return Ok(MessageContent::text(
                        overwrite_unkept_refusal(&raw, &why))),
                    (b, _)            => b,
                };
                let rest = match Self::restore_hold(ctx, &raw, &abs, now.as_deref(), Some(&body)).await
                {
                    Ok(h)    => h,
                    Err(why) => return Ok(MessageContent::text(why)),
                };
                // UNDER A RESTORE THE HAND COMPARES AS IT WRITES (hist-safe F1, 2026-10-12): the
                // read above and this write are two round trips, and a save landing between them
                // was written over and kept nowhere. The hand writes only over the bytes the act
                // was bound to, and refuses where anything else stands.
                // And with no restore, bound to that same read (U3a RMW2): an Undo of a delete
                // that finds the file made again since does not write over it.
                let seen = crate::diamond_versions::Seen::of(now.as_deref());
                let kept = WriteBound::Kept(seen.clone());
                let change = machine_write(rest.is_some(), lic, &text, &seen, Some(&kept));
                let got = match machine_change("file_write", change, &root, &cwd, &spec,
                    &ctx.no_write, ctx.host()).await
                {
                    Ok(g)  => g,
                    Err(e) => {
                        Self::restore_failed(&rest, ctx.host()).await;
                        return Err(e);
                    },
                };
                if let Some(said) = Self::restore_hand_changed(ctx, &raw, &rest, &got).await {
                    return Ok(MessageContent::text(said));
                }
                if let (Err(why), None) = (&got, &rest) {
                    if let Some(said) = kept.hand_refusal("file_write", &raw, why) {
                        return Err(err!("{}", said; Invalid, Input, Mismatch));
                    }
                }
                return match got {
                    Ok(_)    => {
                        let n = body.len();
                        // WHAT THE RESTORE LEFT, noted here because this is the one moment its
                        // bytes are in hand: the door's notes read storage, which does not hold
                        // a machine file (fix/r51e, 2026-09-25).
                        if ctx.restoring != 0 {
                            note_restored(&ctx.read_seen, &Storage::Machine(root.clone()), &abs,
                                &body);
                        }
                        let unkept = Self::restore_landed(rest,
                            crate::diamond_versions::Body::Held(body), ctx.host());
                        Ok(MessageContent::text(fmt!("Put back {} bytes at {}.{}", n, abs, unkept)))
                    },
                    Err(why) => {
                        Self::restore_failed(&rest, ctx.host()).await;
                        Err(err!("{}", why; IO, File, Write))
                    },
                };
            },
            Reach::Storage => (),
        }
        let place = res!(write_place(ctx, &raw, &path).await);
        if let WritePlace::Inventing(dir) = &place {
            return Ok(MessageContent::text(
                refusal_line(&would_invent_said(&raw, dir, &marks_of(&ctx.no_write).join(", ")))));
        }
        let now = match Self::before_bytes(ctx, &path).await {
            Ok(b)    => b,
            Err(why) => return Ok(MessageContent::text(overwrite_unkept_refusal(&raw, &why))),
        };
        let rest = match Self::restore_hold(ctx, &raw, &normalise(&path), now.as_deref(),
            Some(&body)).await
        {
            Ok(h)    => h,
            Err(why) => return Ok(MessageContent::text(why)),
        };
        // Bound to the read above where no restore holds it (U3a RMW2).
        let kept = WriteBound::Kept(crate::diamond_versions::Seen::of(now.as_deref()));
        match Self::restore_store_write(ctx, &raw, lic, &body, &rest, Some(&kept), &None, None)
            .await
        {
            Ok(Ok(_))      => {},
            Ok(Err(said))  => return Ok(MessageContent::text(said)),
            Err(e)         => {
                Self::restore_failed(&rest, ctx.host()).await;
                return Err(e);
            },
        }
        // The read cache is left as it stands: a daimon whose last read was before the restore is
        // refused its next blind write, rather than writing over what was put back.
        let n = body.len();
        let unkept = Self::restore_landed(rest, crate::diamond_versions::Body::Held(body),
            ctx.host());
        Ok(MessageContent::text(fmt!("Put back {} bytes at {}.{}", n, path, unkept)))
    }

    /// `file_edit` in the browser; its own function for the reason [`Self::file_write_page`] is.
    pub(super) async fn file_edit_page<H: Host>(args_json: &str, ctx: &ToolContext<H>) -> Outcome<MessageContent> {
        let text: Outcome<String> = {
            let raw = res!(Self::arg(args_json, "path"));
            let path = res!(Self::scoped(ctx, &raw));
            let hunks = res!(edit_hunks(args_json, &raw));
            let lic = match ctx.licence(&path) {
                Ok(l)    => l,
                Err(why) => return Ok(MessageContent::text(why)),
        };
        // THE MACHINE, WHERE THE PATH IS UNDER A MARK. This arm is the one
        // `dev/BLOCKERS.md` B2 is measured on: exact-string replacement, applied by
        // the hand behind the same fence a command runs behind, with no shell, no `sed`
        // and nothing to escape. The count comes back as a refusal naming the number
        // found, which is the partial-apply signal B2 says is absent.
        match reach_of(ctx, &raw, &path, Door::Change).await {
            Reach::Refuse(why) => return Ok(MessageContent::text(refusal_line(&why))),
            Reach::Machine { abs, cwd, root, spec } => {
                // THE BYTES THAT ARE ABOUT TO BE GONE, for the same reason and by the
                // same means as at the write door above. Taken before the dry run rather
                // than out of it: the dry run happens only for a multi-hunk call, and a
                // single hunk is the commonest edit there is.
                let keep = match ctx.keeper() {
                    Some(d) => Some((d,
                        machine_before(&abs, &cwd, &spec, &ctx.no_write, ctx.host()).await)),
                    None    => None,
                };
                // ALL-OR-NOTHING OVER A HAND THAT TAKES ONE HUNK AT A TIME.
                //
                // The relay's `edit` op carries a single `text`/`text2` pair, and the
                // hand is a separate program with its own release cycle, so the list
                // cannot be pushed down to it.  What CAN be done here is to read the
                // file once and place every hunk against that text before any of them is
                // sent: a hunk that would fail is then found before the first write,
                // which is the whole of what the contract promises.  A single hunk skips
                // the read and is byte for byte the call this tool has always made.
                //
                // The dry run is skipped where the read came back WINDOWED -- a whole
                // file read is cut at 512 KiB -- because validating against part of a
                // file would refuse hunks that are perfectly placeable in the rest of
                // it.  There the hunks go one at a time and the refusal says which
                // landed, which is honest about a guarantee that could not be kept.
                let mut checked = hunks.len() == 1;
                if !checked {
                    let got = res!(machine_op("file_read", "read", &abs, &cwd, &spec,
                        &ctx.no_write, "", ctx.host()).await);
                    if let Ok(t) = got {
                        let read = res!(machine_read(&t));
                        if read.held >= read.lines {
                            let _ = res!(file_edited(&raw, read.body, &hunks));
                            checked = true;
                        }
                    }
                }
                if let Some((_, (None, Some(why)))) = &keep {
                    return Ok(MessageContent::text(overwrite_unkept_refusal(&raw, why)));
                }
                // WHAT THE FILE WILL BE, worked out from the bytes in hand by the same
                // placement the hand applies, so the turn knows before the first hunk goes
                // whether the edit keeps anything of it.
                let after: Option<Vec<u8>> = match &keep {
                    Some((_, (Some(b), _))) => std::str::from_utf8(b).ok()
                        .and_then(|t| file_edited(&raw, t, &hunks).ok())
                        .map(|(updated, _, _)| updated.into_bytes()),
                    _ => None,
                };
                // The turn's bound, and the copy on disk, after the dry run and before
                // the first hunk is sent.
                let mut over: Option<Overwrite> = None;
                if let Some((dia, (before, _))) = &keep {
                    match Self::before_overwrite(ctx, dia, &abs, &raw, before.as_deref(),
                        after.as_deref(), true).await
                    {
                        Ok(o)    => over = Some(o),
                        Err(why) => return Ok(MessageContent::text(why)),
                    }
                }
                // HIS FILE, ASKED ABOUT (UNBLOCK-26 U3): ONE write of the whole text he was shown
                // the change to, under the marks as they stand now and over the text he was shown
                // alone, rather than hunk by hunk.
                let bound = match Self::machine_bound(ctx, &lic, &over).await {
                    Ok(b)    => b,
                    Err(why) => {
                        Self::overwrite_failed(&over, ctx.host()).await;
                        return Ok(MessageContent::text(why));
                    },
                };
                if let Some((l, b)) = &bound {
                    let whole = match after.as_deref().map(std::str::from_utf8) {
                        Some(Ok(t)) => t,
                        _           => {
                            Self::overwrite_failed(&over, ctx.host()).await;
                            return Ok(MessageContent::text(change_unshown_refusal(&raw)));
                        },
                    };
                    let got = match machine_change("file_edit",
                        machine_write(false, l, whole, b.seen(), Some(b)), &root, &cwd, &spec,
                        &ctx.no_write, ctx.host()).await
                    {
                        Ok(g)  => g,
                        Err(e) => Err(fmt!("file_edit: {}", e.plain())),
                    };
                    if let Err(why) = got {
                        Self::overwrite_failed(&over, ctx.host()).await;
                        if let Some(said) = b.hand_refusal("file_edit", &raw, &why) {
                            return Err(err!("{}", said; Invalid, Input, Mismatch));
                        }
                        return Err(err!("{}", why; IO, File, Write));
                    }
                }
                let sent = if bound.is_some() { 0 } else { hunks.len() };
                for (i, (old, new)) in hunks.iter().take(sent).enumerate() {
                    let got = match machine_change("file_edit",
                        MachineChange::Edit(&lic, old, new), &root, &cwd, &spec,
                        &ctx.no_write, ctx.host()).await
                    {
                        Ok(g)  => g,
                        // The road failed: whether the hunk landed is not known, which
                        // is the same case as the hand refusing it, said the same way.
                        Err(e) => Err(fmt!("file_edit: {}", e.plain())),
                    };
                    if let Err(why) = got {
                        let mut unkept = String::new();
                        // Nothing landed, so nothing is kept; or some did, and the file
                        // has changed, so what stood before is recorded as the turn's.
                        if i == 0 {
                            Self::overwrite_failed(&over, ctx.host()).await;
                        } else if let Some((dia, (before, refused))) = &keep {
                            let found = machine_found(before, refused);
                            let (before, wiped) = Overwrite::prior(&over, before.clone());
                            unkept.push_str(&Self::unkept(ctx.host(), ctx.host().store().capture(dia, &raw,
                                crate::diamond_versions::Change {
                                    path:    abs.clone(),
                                    after:   crate::diamond_versions::Body::Unseen,
                                    before: before.map(crate::diamond_versions::Prior::Held),
                                    found,
                                    carried: None,
                                    mark:    true,
                                    refused: refused.clone(),
                                    wiped,
                                    folder:  None,
                                    by:      ctx.by.clone(),
                                    door:    false,
                                }), &abs));
                        }
                        // What is already on disk is said plainly. A model told only
                        // that the call failed would re-send every hunk, and the ones
                        // that landed would no longer match.
                        return Err(if i == 0 {
                            err!("{}", why; IO, File, Write)
                        } else {
                            err!("{} -- edit(s) 1 to {} of {} ARE ALREADY WRITTEN to \
                                '{}'{}. Read the file before you send anything again.{}",
                                why, i, hunks.len(), abs,
                                if checked {
                                    ", which the file changed under this call"
                                } else {
                                    " (the file was too large to check the edits first)"
                                }, unkept;
                                IO, File, Write)
                        });
                    }
                }
                // WHAT THE FILE NOW IS, worked out rather than read back: the hand has
                // just applied these hunks to the bytes above, and `file_edited` is the
                // same placement it applied them by. A second fenced read would cost a
                // round trip to learn what is already in hand.
                //
                // It is also this agent's latest view, as the storage door records it, so its
                // next write is not refused over its own edit.  Where it could not be worked
                // out the old read is dropped instead, which leaves that write unguarded.
                {
                    let at = Storage::Machine(root.clone());
                    let mut st = lock_cache(&ctx.read_seen);
                    match &after {
                        Some(b) => st.seen.insert(&at, &path, content_hash(b)),
                        None    => st.seen.remove(&at, &path),
                    }
                }
                let mut unkept = String::new();
                if let Some((dia, (before, refused))) = keep {
                    let after = match after {
                        Some(b) => crate::diamond_versions::Body::Held(b),
                        None    => crate::diamond_versions::Body::Unseen,
                    };
                    let found = machine_found(&before, &refused);
                    let (before, wiped) = Overwrite::prior(&over, before);
                    unkept.push_str(&Self::unkept(ctx.host(), ctx.host().store().capture(&dia, &raw,
                        crate::diamond_versions::Change {
                            path: abs.clone(), after, before: before.map(crate::diamond_versions::Prior::Held), found, carried: None,
                            mark: true, refused, wiped, folder: None, by: ctx.by.clone(), door: false }), &abs));
                }
                return Ok(MessageContent::text(fmt!("{}{}", Self::edit_said(&abs, hunks.len()), unkept)));
            },
            Reach::Storage => (),
        }
        // WHICH FILESYSTEM WAS LOOKED IN, as `file_read` says it. Lane H fixed the two
        // tools it was measured on and left this one deliberately; a daimon that edits
        // rather than rewrites met the browser's `JsValue(NotFoundError: …)` instead.
        // A cloud-only file is fetched here as `file_read` fetches one, and for the
        // same reason: an edit refused for want of bytes this device could have had costs
        // three rounds to do what one would.
        if let Some(size) = ctx.host().fs().cloud_size_of(&path) {
            if size <= AUTO_FETCH_MAX {
                res!(ctx.host().fs().cloud_fetch(&path).await);
            } else {
                return Err(err!(
                    "file_edit: '{}' is in cloud storage, not on this device. It is {} \
                    bytes, above the {} KiB an edit fetches for itself. Use file_fetch to \
                    bring it here first.", path, size, AUTO_FETCH_MAX / 1024;
                    IO, File, Read, Missing));
            }
        }
        // Where the edit is read and lands, for the record it leaves; taken before its I/O.
        let at = stored_in(ctx, &path);
        let bytes = match ctx.host().fs().read_file(ctx.root, &path).await {
            Ok(b)  => b,
            Err(e) => match absent_here(ctx, &raw, &path).await {
                Some(note) => return Err(err!("file_edit: {}", note;
                    IO, File, Read, Missing)),
                None       => match wrong_root_note(ctx, &raw, &path).await {
                    Some(note) => return Err(err!("file_edit: {}", note;
                        IO, File, Read, Missing)),
                    None       => return Err(e),
                },
            },
        };
        // Strict, because this text is WRITTEN BACK whole: a lossy read turned every invalid
        // byte in the file into U+FFFD, not only the ones the hunks touched.
        let data = res!(utf8_text(&bytes, &path));
        let (updated, relaxed, missed) = res!(file_edited(&path, &data, &hunks));
        // THE CRYSTAL'S THIRD DOOR, and it answers for both of its files.
        //
        // `Tool::FileWrite` has carried this check since the ceiling was built, and
        // the store's own door catches a hand edit and a fold.  This one was missed,
        // and a daimon that EDITS rather than rewrites walked straight past it.  The
        // store's door does then fire -- but it reads the old length from disk, and
        // by then the edit has landed, so `old == new` and the refusal arrives after
        // the fact: `record_steer` errors, the turn fails, and an oversized crystal
        // is left on disk with no version snapshot and no log record.  Refusing here
        // means the file is never written at all, which is the only place the
        // asymmetry below can still be honoured.
        //
        // `data` is the content BEFORE the replacement, so an edit that shrinks an
        // already-oversized crystal is still allowed, exactly as at the other doors.
        // Retired first, exactly as at the write door and by the same function, so an
        // edit that tips one of the three over its ceiling is relieved rather than
        // refused -- and a daimon that appends a decision a day never meets the limit.
        let landed = res!(ctx.host().store().standing_retired(ctx.root, &path, updated).await);
        let (updated, retired) = (landed.kept.clone(), landed.said.clone());
        let (updated, demoted) = res!(Self::cap_door(ctx, "file_edit", &path, updated, &data).await);
        // The edit's RESULT must still be one JSON object where it is a crystal's data, and a
        // crystal that was broken before the edit is said to be.
        if let Some(msg) = crystal_edit_refusal(&path, &data, &updated) {
            return Err(err!("file_edit: {}", msg; Invalid, Input, Data));
        }
        Self::hot_landed(&path, ctx.host()).await;
        // THE BYTES IT REPLACES, kept as the write door keeps them -- this arm kept none,
        // so a turn's first edit of a file no version had named had nowhere to go back to.
        // An edit whose hunks leave less than half of the file is a wipe like any other
        // write's.
        let over = match ctx.keeper() {
            Some(dia) => match Self::before_overwrite(ctx, &dia, &path, &raw, Some(&bytes),
                Some(updated.as_bytes()), true).await
            {
                Ok(o)    => Some(o),
                Err(why) => return Ok(MessageContent::text(why)),
            },
            None      => None,
        };
        // Bound to the bytes the edit was made from: a save since is refused under the lock, and
        // the landing's side files go down with the file, under that lock (held-lock settle P3).
        let noted = match Self::write_over(ctx, &lic, "file_edit", &raw, updated.as_bytes(), &over,
            Some(&WriteBound::Read(crate::diamond_versions::Seen::of(Some(&bytes)))), Some(&landed))
            .await
        {
            Ok(Ok(noted)) => noted,
            Ok(Err(why))  => {
                Self::overwrite_failed(&over, ctx.host()).await;
                return Ok(MessageContent::text(why));
            },
            Err(e)        => { Self::overwrite_failed(&over, ctx.host()).await; return Err(e); },
        };
        let mut unkept = String::new();
        if let Some(dia) = ctx.keeper() {
            let found = Found::of(Some(&bytes));
            let (before, wiped) = Overwrite::prior(&over, Some(bytes));
            unkept.push_str(&Self::captured_write(ctx, &dia, &path, updated.as_bytes().to_vec(), found, before,
                wiped));
        }
        // The edit is anchored to current on-disk content, so it merges
        // safely; record the new state as this agent's latest view.
        lock_cache(&ctx.read_seen).seen.insert(&at, &path, content_hash(updated.as_bytes()));
        Ok(fmt!("{}{}{}{}{}{}{}", demoted, Self::edit_said(&path, hunks.len()),
            relaxed_said(&relaxed), missed, retired, noted, unkept))
        };
        Ok(MessageContent::text(res!(text)))
    }

    /// `file_delete` in the browser: one file, never a folder, and only once a copy is held.
    /// Its own function rather than an arm of `execute`, whose one future a debug build of
    /// the wasm keeps every local of, up to the format's limit.
    pub(super) async fn file_delete<H: Host>(args_json: &str, ctx: &ToolContext<H>) -> Outcome<MessageContent> {
        let raw = res!(Self::arg(args_json, "path"));
        if let Some(why) = delete_path_refusal(&raw) {
            return Ok(MessageContent::text(refusal_line(&why)));
        }
        // ONE SPELLING, BEFORE ANYTHING ELSE. `./x`, `a//x`, `a/z/../x` and `x/` all name
        // `x`, and the version store keeps a copy only under the canonical form -- on
        // 2026-09-23 an audit deleted four files spelled those ways and none of them was
        // kept, because `versionable` turned each spelling away after the file was gone.
        let raw = normalise(&raw);
        let path = res!(Self::scoped(ctx, &raw));
        let lic = match ctx.licence(&path) {
            Ok(l)    => l,
            Err(why) => return Ok(MessageContent::text(why)),
        };
        // WHICH FILESYSTEM, ASKED FIRST, as every other file tool asks it. A path under a mark
        // reached through the machine hand is a file on this computer, and the hand has no
        // delete, so it is refused here in words. Until 2026-09-25 this was never asked, and
        // everything below read browser storage for the machine's path: the file on the machine
        // was "not there", and a file at the same path in browser storage, which every device
        // syncs, was deleted in its place (the reopen rehearsal's U3).
        match reach_of(ctx, &raw, &path, Door::Change).await {
            Reach::Storage        => {},
            Reach::Refuse(why)    => return Ok(MessageContent::text(refusal_line(&why))),
            Reach::Machine { .. } =>
                return Ok(MessageContent::text(refusal_line(&delete_machine_refusal(&raw)))),
        }
        // Where the delete lands, for this agent's view of the path after it.
        let at = stored_in(ctx, &path);
        // ONE FILE, NEVER A FOLDER.  This took a `recursive` argument and handed it to
        // `removeEntry`, which on a folder-mounted Diamond is the user's own disk: on
        // 2026-09-22 a daimon whose moves had been refused used it on whole folders and
        // Syncthing carried ~4,900 deletions off the machine.  A folder is refused here in
        // words, and `delete_file` below cannot remove one whatever it is asked.
        if let Ok(true) = ctx.host().fs().is_directory(ctx.root, &path).await {
            return Ok(MessageContent::text(refusal_line(&delete_dir_refusal(&raw))));
        }
        // A TURN'S DELETE GOES AHEAD ONLY ONCE A COPY IS HELD -- a daimon's, a worker's
        // or a chat's, since 2026-09-23, because the risk is the folder and not which
        // model is in it.  Fail closed: every
        // reason no copy could be taken -- too large, unreadable though present, only in
        // cloud storage, or a path the store will not keep -- is a refusal in words, and
        // the file stays.  A delete nothing can put back is the one this guard exists to
        // stop, and on a folder-mounted Diamond the file is on the user's own disk.
        let keep = match ctx.keeper() {
            Some(d) => match Self::delete_copy(ctx, &d, &raw, &path).await {
                Ok(Ok(before)) => Some((d, before)),
                Ok(Err(why))   => return Ok(MessageContent::text(refusal_line(&why))),
                Err(e)         => return Err(e),
            },
            None    => None,
        };
        // AS THE TURNS FOUND IT (R4's follow-on, 2026-09-23). A delete is a destruction as
        // a wipe is, and keeps what a wipe keeps: the oldest copy of the unbroken run of
        // turns' changes that led here, not the file as this delete found it. Two trims
        // that each left over half and then a delete held only the trimmed file, and the
        // whole one sat in ordinary rows a prune may take. Only a user's file: a keeper's
        // own home is its working state. A file this turn made keeps what it holds.
        let keep = match keep {
            Some((d, before)) if stored_is_mark(&d, &path) => {
                let copy = ctx.host().store().turns_found(&d, &normalise(&path), &before)
                    .await.unwrap_or_else(|| before.clone());
                Some((d, before, copy))
            },
            Some((d, before)) => {
                let copy = before.clone();
                Some((d, before, copy))
            },
            None => None,
        };
        // A TURN'S DELETES FROM THE USER'S OWN FOLDER ARE HELD FOR THE PERSON past a
        // handful (decision review of 2026-09-23, decision 2; items b and c of the delete
        // unit): the file is on their disk, and whatever syncs that folder carries each
        // delete off the machine at once.  The store's own bound, below, still holds
        // after they say go on.  Asked about the FILE, which only its bytes say (Q5-1,
        // 2026-09-24): asked before the copy was read, the tally knew only the path, and
        // a yes to deleting the turn's own file there let a user's file moved onto the
        // path be emptied unasked.  So the copy is read first, which also means a delete
        // the store could not keep is refused before the person is asked about it.
        let open = ctx.root == FileRoot::Workspace && ctx.host().fs().folder_open()
            && !is_store_path(&path);
        // A RESTORE'S DELETE KEEPS WHAT IT REMOVES, read at the act and after the person's
        // yes: a save made while the question was open is what goes, so it is what is kept.
        // Every reason a turn's delete could keep no copy refuses this one too.  Asked BEFORE
        // the turn's claim, so a restore refused here leaves no reservation, count or note behind
        // (hist-safe F2, 2026-10-12: its three refusals returned past `held` and `counted`), and
        // every return below gives this hold back.
        let rest = if ctx.restoring != 0 {
            let store = ctx.host().store().restore_store(ctx.restoring).unwrap_or_default();
            match Self::delete_copy(ctx, &store, &raw, &path).await {
                Ok(Ok(now)) => match Self::restore_hold(ctx, &raw, &normalise(&path), Some(&now),
                    None).await
                {
                    Ok(h)    => h,
                    Err(why) => return Ok(MessageContent::text(why)),
                },
                Ok(Err(why)) => return Ok(MessageContent::text(refusal_line(&why))),
                Err(e)       => return Err(e),
            }
        } else {
            None
        };
        // PAST WHAT THE TURN MAY KEEP, the turn stops and asks -- and that is asked FIRST,
        // before the person is asked anything (R2-5): a delete the bound would refuse is
        // never put to them.
        let claimed = match &keep {
            Some((dia, now, copy)) => match Self::claim(dia, &path, &raw, Some(now), Some(copy),
                true, ctx.host()).await
            {
                Ok(h)    => Some(h),
                Err(why) => {
                    Self::restore_failed(&rest, ctx.host()).await;
                    return Ok(MessageContent::text(why));
                },
            },
            None => None,
        };
        // HIS FILE IS ASKED ABOUT FIRST (UNBLOCK-26 U3), after the bound and before the open
        // folder's count: a delete he was shown and applied is not counted against him again.
        let mut asked = false;
        if let Some((dia, now, _)) = &keep {
            let key = normalise(&path);
            if Self::asks_first(ctx, dia, &key, now).await {
                if let Err(why) = Self::ask_first(ctx, dia, &key, &raw, now,
                    crate::held_change::Change::Delete).await
                {
                    Self::let_go(&claimed, ctx.host()).await;
                    Self::restore_failed(&rest, ctx.host()).await;
                    return Ok(MessageContent::text(why));
                }
                asked = true;
            }
        }
        let counted = match &keep {
            Some((d, _, copy)) if open && !asked => {
                let file = crate::diamond_versions::open_file_key(&path, copy);
                match Self::open_delete_gate(d, &path, &file, &raw, OpenAct::Delete, &ctx.turn_tag(),
                    ctx.host()).await {
                    Ok(true)  => Some((d.clone(), file)),
                    Ok(false) => None,
                    Err(why)  => {
                        Self::let_go(&claimed, ctx.host()).await;
                        Self::restore_failed(&rest, ctx.host()).await;
                        return Ok(MessageContent::text(why));
                    },
                }
            },
            _ => None,
        };
        // What the gate counted is given back wherever the delete does not happen.
        let give_back = || {
            if let Some((d, file)) = &counted {
                ctx.host().store().open_delete_release(d, file);
            }
        };
        // The copy is on disk, with a note naming it, BEFORE the file goes -- a page that
        // dies between here and the turn's end leaves the note for the next turn end to adopt.
        let held = match (claimed, &keep) {
            (Some(h), Some((_, now, copy))) => match Self::keep(h, &raw, Some(now), Some(copy),
                true, ctx.host()).await
            {
                Ok(h)    => Some(h),
                Err(why) => {
                    give_back();
                    Self::restore_failed(&rest, ctx.host()).await;
                    return Ok(MessageContent::text(why));
                },
            },
            _ => None,
        };
        // AFTER HIS APPLY, under the marks as they stand now and only the file he was shown.
        let lic = if asked {
            let shown = keep.as_ref().map(|(_, now, _)| now.as_slice());
            let now = ctx.licence_now(lic.path()).await.ok();
            let same = match &now {
                Some(_) => match ctx.host().fs().read_file(ctx.root, &path).await {
                    Ok(b)  => Some(b.as_slice()) == shown,
                    Err(_) => false,
                },
                None    => false,
            };
            match (now, same) {
                (Some(l), true) => l,
                _               => {
                    Self::let_go(&held, ctx.host()).await;
                    Self::restore_failed(&rest, ctx.host()).await;
                    give_back();
                    return Ok(MessageContent::text(changed_while_asked_refusal(&raw)));
                },
            }
        } else {
            lic
        };
        // Absence from this device means "not here"; removal from the cloud index means
        // "gone". Those are different things, and only an explicit delete does the
        // second. The user's own door may do it for a file that is not resident; a
        // turn never reaches here for one, because `delete_copy` refused it.
        if let Err(e) = ctx.host().fs().delete_licensed(ctx.root, &lic).await {
            Self::let_go(&held, ctx.host()).await;
            Self::restore_failed(&rest, ctx.host()).await;
            give_back();
            if keep.is_none() && ctx.host().fs().cloud_size_of(&path).is_some() {
                res!(ctx.host().fs().cloud_forget_licensed(&lic).await);
                lock_cache(&ctx.read_seen).seen.remove(&at, &path);
                return Ok(MessageContent::text(fmt!("Deleted {} from cloud storage.", path)));
            }
            return Err(e);
        }
        // Its own delete is this agent's view of the path now, so the stale-read guard does not
        // refuse its next write as a file deleted since it read it (RD2).
        lock_cache(&ctx.read_seen).seen.remove(&at, &path);
        let mut unkept = String::new();
        unkept.push_str(&Self::restore_landed(rest, crate::diamond_versions::Body::Gone, ctx.host()));
        if let Some((dia, now, copy)) = keep {
            unkept.push_str(&Self::captured_delete(ctx, &dia, &path, Found::of(Some(&now)), copy));
        }
        let mut msg = fmt!("Deleted {}.{}", path, unkept);
        // The index lists only what is NOT on this device, so a resident file's cloud
        // copy is invisible to it; forget unconditionally, or deleting a file that was
        // synced would leave the copy behind to reappear.
        match ctx.host().fs().cloud_forget_licensed(&lic).await {
            Ok(s) if s.starts_with("Error") =>
                msg.push_str(&fmt!(" Its cloud copy was not removed: {}", s)),
            Ok(_)  => {},
            Err(e) => msg.push_str(&fmt!(" Its cloud copy was not removed: {}", e)),
        }
        Ok(MessageContent::text(msg))
    }

    /// `file_move` in the browser, on this computer where the source is under a mark, and its
    /// record of both ends ([`Self::move_ends`]).  Its own function for the reason
    /// [`Self::file_delete`] is.
    pub(super) async fn file_move<H: Host>(args_json: &str, ctx: &ToolContext<H>) -> Outcome<MessageContent> {
        let raw    = res!(Self::arg(args_json, "path"));
        let to_raw = res!(Self::arg(args_json, "to"));
        let from   = res!(Self::scoped(ctx, &raw));
        let to     = res!(Self::scoped(ctx, &to_raw));
        // BOTH ENDS through the fence: a move removes one path and writes the other, and
        // the source's licence covers everything a folder carries with it.
        let (from_lic, to_lic) = match (ctx.licence(&from), ctx.licence(&to)) {
            (Ok(f), Ok(t)) => (f, t),
            (Err(why), _) | (_, Err(why)) => return Ok(MessageContent::text(why)),
        };
        // THE MACHINE, WHERE THE SOURCE IS UNDER A MARK. The destination is made
        // absolute against the same root: a move that crossed the two filesystems would
        // be a copy and a delete wearing one name, and neither half would be visible in
        // the other place.
        match reach_of(ctx, &raw, &from, Door::Change).await {
            Reach::Refuse(why) => return Ok(MessageContent::text(refusal_line(&why))),
            Reach::Machine { abs, cwd, root, spec } => {
                let dest = match mark_over(&ctx.no_write, &normalise(&to)) {
                    Some(_) => fmt!("{}/{}", root, normalise(&to)),
                    None => return Ok(MessageContent::text(refusal_line(&fmt!(
                        "file_move: '{}' is a folder on this computer and '{}' is not in \
                        one, so this would move a file out of the filesystem it is in. \
                        Move it to a path inside a folder the user added.",
                        raw, to)))),
                };
                // WHAT THE MOVE CARRIES, read through the hand and its room reserved before
                // it goes, so both of its ends are recorded (`Tool::move_ends`).
                // HIS FILE OR FOLDER IS ASKED ABOUT FIRST (UNBLOCK-26 U3), once the move's bound
                // has passed.
                let mut asked = false;
                let mut shown: Option<Vec<u8>> = None;  // one file he was shown, which binds it
                let hold = match ctx.keeper() {
                    Some(d) => {
                        let files = Self::machine_move_read(&d, (&abs, &raw),
                            (&dest, &to_raw), &cwd, &spec, &ctx.no_write, ctx.host()).await;
                        let folder = match files.as_slice() {
                            [f] if f.from == abs => false,
                            []                   => match machine_before(&abs, &cwd, &spec,
                                &ctx.no_write, ctx.host()).await
                            {
                                (None, Some(why)) => hand_said_directory(&why),
                                _                 => false,
                            },
                            _                    => true,
                        };
                        let (ask, before) = Self::move_asks(ctx, &d, &abs, folder, &files).await;
                        let h = match Self::move_ends(&d, &raw, files, ctx.host()).await {
                            Ok(h)    => h,
                            Err(why) => return Ok(MessageContent::text(why)),
                        };
                        if ask {
                            let showing = before.as_deref().unwrap_or_default();
                            if let Err(why) = Self::ask_first(ctx, &d, &abs, &raw, showing,
                                crate::held_change::Change::Move(&normalise(&to))).await
                            {
                                Self::move_failed(&d, &h, ctx.host());
                                return Ok(MessageContent::text(why));
                            }
                            asked = true;
                            shown = before;
                        }
                        Some((d, h))
                    },
                    None => None,
                };
                // AFTER HIS APPLY, under the marks as they stand now, and one file only as he
                // was shown it.
                let (from_lic, to_lic) = if asked {
                    let ends = (ctx.licence_now(from_lic.path()).await,
                        ctx.licence_now(to_lic.path()).await);
                    let same = match &shown {
                        None    => true,
                        Some(b) => match machine_before(&abs, &cwd, &spec, &ctx.no_write,
                            ctx.host()).await
                        {
                            (Some(n), _) => n == *b,
                            _            => false,
                        },
                    };
                    match (ends, same) {
                        ((Ok(f), Ok(t)), true) => (f, t),
                        _                      => {
                            if let Some((d, h)) = &hold {
                                Self::move_failed(d, h, ctx.host());
                            }
                            return Ok(MessageContent::text(changed_while_asked_refusal(&raw)));
                        },
                    }
                } else {
                    (from_lic, to_lic)
                };
                let got = match machine_change("file_move",
                    MachineChange::Move(&from_lic, &to_lic), &root, &cwd, &spec,
                    &ctx.no_write, ctx.host()).await
                {
                    Ok(g)  => g,
                    Err(e) => {
                        if let Some((d, h)) = &hold {
                            Self::move_failed(d, h, ctx.host());
                        }
                        return Err(e);
                    },
                };
                return match got {
                    Ok(_)    => {
                        // What it moved away is gone from this agent's view, as the storage
                        // arm below says.
                        lock_cache(&ctx.read_seen).seen.remove_under(&Storage::Machine(root.clone()),
                            &from);
                        let mut unkept = String::new();
                        if let Some((d, h)) = hold {
                            unkept.push_str(&Self::captured_move(ctx, &d, h));
                        }
                        Ok(MessageContent::text(fmt!("Moved {} to {}.{}", abs, dest, unkept)))
                    },
                    Err(why) => {
                        if let Some((d, h)) = &hold {
                            Self::move_failed(d, h, ctx.host());
                        }
                        Err(err!("{}", why; IO, File, Write))
                    },
                };
            },
            Reach::Storage => (),
        }
        // Where the move's source is, for this agent's view of it after the move.
        let at = stored_in(ctx, &from);
        // A MOVE BETWEEN THE USER'S FOLDER AND DAIMOND'S STORE IS A DELETE FROM THEIR DISK.
        // `resolve_root` sends a store path to the browser sandbox whatever folder is
        // open, so a folder moved to `diamonds/<id>/...` leaves the machine -- and every
        // device its sync reaches -- while its bytes sit where only this browser can see
        // them.  The machine arm above refuses the same crossing for the same reason.
        if ctx.root == FileRoot::Workspace && ctx.host().fs().folder_open()
            && is_store_path(&from) != is_store_path(&to)
        {
            return Ok(MessageContent::text(refusal_line(&fmt!(
                "file_move: '{}' and '{}' are on different filesystems -- one is in the \
                folder the user opened on this computer, the other in Daimond's own \
                storage -- so this would take it off the user's disk. Nothing was moved. \
                Move it to a path in the same place, or ask the user.", raw, to))));
        }
        if under(&normalise(&to), &normalise(&from)) {
            return Ok(MessageContent::text(refusal_line(
                &move_into_itself_refusal(&raw, &to))));
        }
        // The SOURCE only. In Daimond's own storage `move_entry` refuses an existing destination
        // in its own words, and those are correct there.  On this computer the move replaces a
        // file standing at the destination, and the runner keeps that file first, so "Undo
        // this turn" puts back both (QA R2 F1).
        if let Some(note) = absent_here(ctx, &raw, &from).await {
            return Err(err!("file_move: {}", note; IO, File, Read, Missing));
        }
        // WHAT THE MOVE CARRIES, read and its room reserved before it goes, so both of its
        // ends are recorded (`Tool::move_ends`).  Keyed on the scoped paths, as
        // `Tool::captured_write` keys a write.
        // HIS FILE OR FOLDER IS ASKED ABOUT FIRST (UNBLOCK-26 U3), once the move's bound has
        // passed.
        let mut asked = false;
        let mut shown: Option<Vec<u8>> = None;  // one file he was shown, which binds it
        let hold = match ctx.keeper() {
            Some(d) => {
                let files = Self::store_move_read(ctx, &d, &from, &to).await;
                let folder = matches!(ctx.host().fs().is_directory(ctx.root, &from).await,
                    Ok(true));
                let key = normalise(&from);
                // A folder is walked from the scoped path, as storage names it.
                let (ask, before) = Self::move_asks(ctx, &d, if folder { &from } else { &key },
                    folder, &files).await;
                let h = match Self::move_ends(&d, &raw, files, ctx.host()).await {
                    Ok(h)    => h,
                    Err(why) => return Ok(MessageContent::text(why)),
                };
                if ask {
                    let showing = before.as_deref().unwrap_or_default();
                    if let Err(why) = Self::ask_first(ctx, &d, &key, &raw, showing,
                        crate::held_change::Change::Move(&normalise(&to))).await
                    {
                        Self::move_failed(&d, &h, ctx.host());
                        return Ok(MessageContent::text(why));
                    }
                    asked = true;
                    shown = before;
                }
                Some((d, h))
            },
            None => None,
        };
        // AFTER HIS APPLY, under the marks as they stand now, and one file only as he was shown it.
        let (from_lic, to_lic) = if asked {
            let ends = (ctx.licence_now(from_lic.path()).await,
                ctx.licence_now(to_lic.path()).await);
            let same = match &shown {
                None    => true,
                Some(b) => match ctx.host().fs().read_file(ctx.root, &from).await {
                    Ok(n)  => n == *b,
                    Err(_) => false,
                },
            };
            match (ends, same) {
                ((Ok(f), Ok(t)), true) => (f, t),
                _                      => {
                    if let Some((d, h)) = &hold {
                        Self::move_failed(d, h, ctx.host());
                    }
                    return Ok(MessageContent::text(changed_while_asked_refusal(&raw)));
                },
            }
        } else {
            (from_lic, to_lic)
        };
        // A FILE STANDING AT `to` is replaced on this computer and refused in Daimond's own
        // storage, so only the first can be a replace the reply has to own up to (QA R2 M1).
        let replacing = !is_store_path(&to)
            && matches!(ctx.host().fs().exists(ctx.root, &to).await, Ok(true))
            && matches!(ctx.host().fs().is_directory(ctx.root, &to).await, Ok(false));
        if let Err(e) = ctx.host().fs().move_licensed(ctx.root, &from_lic, &to_lic).await {
            if let Some((d, h)) = &hold {
                Self::move_failed(d, h, ctx.host());
            }
            return Err(e);
        }
        // Its own move is this agent's view of the source now, the file or the folder and all it
        // held, so the stale-read guard does not refuse a later write there as a file deleted
        // since it read it (RD2).
        lock_cache(&ctx.read_seen).seen.remove_under(&at, &from);
        let mut unkept = String::new();
        if let Some((d, h)) = hold {
            unkept.push_str(&Self::captured_move(ctx, &d, h));
        }
        let kept = runner_keeps(ctx) && unkept.is_empty();
        Ok(MessageContent::text(fmt!("{}{}", moved_line(&from, &to, replacing, kept), unkept)))
    }

    pub(super) async fn file_show<H: Host>(args_json: &str, ctx: &ToolContext<H>) -> Outcome<MessageContent> {
        // A DISPATCHED WORKER MAY NOT TAKE THE SCREEN.  Nobody is reading its transcript, several
        // of them run at once, and the panel is one panel: three workers each showing a file would
        // fight over what the user is looking at, in the middle of whatever the user was actually
        // doing.  The same reasoning `act_needs_consent` applies to a click -- an act with a
        // consequence its actor cannot see -- arriving at a surface rather than at a page.
        if ctx.is_unsupervised() {
            return Ok(Self::worker_may_not_show());
        }
        let path = res!(Self::scoped(ctx, &res!(Self::arg(args_json, "path"))));
        if !res!(ctx.host().fs().exists(ctx.root, &path).await) {
            // A file in cloud storage is not a missing file, and saying which is what stops the
            // model hunting for a path that is exactly where it should be.  Both sentences are
            // composed by [`absent_result`], where the two are side by side and their DIFFERENT
            // bookings can be read against each other.
            //
            // AND NEITHER IS THE MACHINE. This tool was left out of the eight arms `absent_here`
            // reaches (`dev/BLOCKERS.md` B1) and it is the one whose false answer a USER watches:
            // "There is no file at 'report.pdf'" said of a document sitting on the disk reads as
            // the app being broken. The panel really does read browser storage alone -- it has no
            // door onto the machine at all -- so what is named here is WHERE it looked, and no
            // way out is offered, because there is not one to offer.
            return Ok(Self::absent_result(&path, ctx.host().fs().cloud_size_of(&path),
                two_places(ctx.host())));
        }
        // A page of nought is not a page, so it is read as "no page named" rather than refused.
        // What that MEANS is the panel's to decide, and it decides "wherever this file was last
        // aimed" -- which is what puts a rebuilt document back in the reader's place instead of
        // at page 1.  The page reported afterwards therefore comes from the panel's answer and
        // never from this argument.
        let page = match extract_json_number(args_json, "page") {
            Some(n) if n > 0 => Some(n as u32),
            _                => None,
        };
        // The panel is told WHO is asking, and answers whether it took the screen.  Asked at the
        // panel and not here because the answer is "which Diamond is in view", which lives on the
        // page; this side knows only which Diamond the turn acts for.
        // And WHICH TURN, so a turn this device runs for another can be told apart from one
        // asked here: its file goes to the asking device's screen and this one is left alone
        // (D-20261006-27).
        //
        // WHO is the turn's KEEPER -- a Diamond's id or `chat:<id>` -- the same name `capture` fences
        // on (CAPTURE-FENCE, lead ruling on rc-b's per-view owner, 2026-10-12).  It was the daimon's
        // Diamond, which a chat does not have, so a chat's turn left running while the person opened
        // a Diamond named nobody, took that Diamond's screen, and the Diamond's own capture drew the
        // chat's file.  Named, the show waits for its own conversation and its panel is stamped with it.
        let owner = ctx.keeper().or_else(|| ctx.daimon()).unwrap_or_default();
        let shown = res!(ctx.host().ui().show(&path, page, &owner, &ctx.turn_tag()).await);
        Ok(Self::show_result(&path, &shown))
    }

    /// Photograph the current view and write the PNG to the workspace.
    ///
    /// The request handed to the driver carries only the fields it understands, so a stray
    /// argument cannot change what is photographed.  The bytes are written through the same
    /// licensed door (`crate::wasm::opfs::write_licensed`) `file_write` uses, and the read
    /// cache is stamped for the same reason it is there -- a later overwrite of the shot is this
    /// agent's own, not another's edit to guard against.
    pub(super) async fn capture_view<H: Host>(args_json: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let raw = Self::capture_out(args_json, ctx.daimon().as_deref());
        let (path, lic) = match res!(Self::capture_door(ctx, &raw)) {
            Ok(d)    => d,
            Err(why) => return Ok(why),
        };
        let shot = res!(ctx.host().ui().capture(&Self::capture_req(args_json, ctx.keeper().as_deref())).await);
        let unkept = match res!(Self::land_output(ctx, Tool::Capture, &raw, &path, &lic, &shot.png).await) {
            Ok(u)    => u,
            Err(why) => return Ok(why),
        };
        Ok(fmt!(
            "Photographed the view to {} ({}x{} px, {} bytes).{} {}",
            path, shot.w, shot.h, shot.png.len(), unkept, Self::capture_handoff("this path")))
    }

    /// `capture` with `in:"crystal"`: draw this Diamond's own page afresh, off screen, at a phone
    /// and a desktop width, and answer for each a table of what its elements measure and a
    /// picture.  The page need not be showing anywhere, which is the point: a turn handed off to
    /// another device has no page on screen, and a daimon that cannot see what it built guesses.
    ///
    /// The stored page and `crystal.json` are read here and handed to the driver, so a page the
    /// daimon has just written is the page drawn.  Every picture's door is checked before
    /// anything is drawn, and each lands as `capture`'s own do.  What the daimon is then given
    /// of the pictures is [`Self::crystal_sight`]'s to say.
    pub(super) async fn capture_crystal<H: Host>(args_json: &str, ctx: &ToolContext<H>) -> Outcome<MessageContent> {
        let id = match ctx.daimon() {
            Some(i) => i,
            None    => return Ok(MessageContent::text(refusal_line(
                "capture with in:\"crystal\" draws a Diamond's own page, and this turn is not \
                working inside a Diamond, so there is no page to draw."))),
        };
        ctx.note_probed(args_json);
        let (data, page) = match Self::crystal_inputs(&id, ctx.host()).await {
            Ok(pair) => pair,
            Err(why) => return Ok(MessageContent::text(crystal_unreadable_line(&why))),
        };
        let outs = Self::capture_outs(args_json, &id);
        let mut doors = Vec::new();
        for (_, raw) in &outs {
            match res!(Self::capture_door(ctx, raw)) {
                Ok(d)    => doors.push(d),
                Err(why) => return Ok(MessageContent::text(why)),
            }
        }
        let mut text   = String::new();
        let mut landed = Vec::new();
        let mut pics   = Vec::new();
        let mut trace  = String::new();
        for (i, (w, raw)) in outs.iter().enumerate() {
            let req  = Self::crystal_req(args_json, &id, &page, &data, *w, true);
            let shot = res!(ctx.host().ui().capture(&req).await);
            text.push_str(&shot.table);
            text.push_str("\n\n");
            if trace.is_empty() {
                trace = shot.trace.clone();
            }
            if shot.png.is_empty() {
                continue;   // the table says why there is no picture at this width
            }
            let (path, lic) = &doors[i];
            let unkept = match res!(Self::land_output(ctx, Tool::Capture, raw, path, lic, &shot.png).await) {
                Ok(u)    => u,
                Err(why) => return Ok(MessageContent::text(why)),
            };
            ctx.note_shot(&shot.png);
            landed.push(fmt!("{} ({}x{} px, {} bytes){}", path, shot.w, shot.h, shot.png.len(),
                unkept));
            pics.push((*w, path.clone(), shot.png));
        }
        // K3: what the page said while it drew, which is where a page that shows the wrong thing
        // says why.
        text.push_str(&page_trace_block(&trace));
        if landed.is_empty() {
            return Ok(MessageContent::text(text.trim_end().to_string()));
        }
        let said = fmt!("{}Photographed the Diamond's page to {}.", text, landed.join(" and "));
        Self::crystal_sight(ctx, &id, said, pics).await
    }

    /// Put a Diamond page's pictures where the daimon can use them, so it always gets something
    /// and never fails silently.
    ///
    /// The model that is running the turn gets them first, attached to the result, when it takes
    /// pictures and they are small enough to ride in the turn's byte allowance.  Otherwise (it
    /// has refused one, or a picture is too big to attach) the Diamond's images model is asked
    /// for a short description of any layout faults, through the page, which writes the spend to
    /// the ledger; the description comes back beside the table with who looked and what it cost.
    /// With no images model set the result says so in one line, and the table still comes back.
    ///
    /// A model nobody has yet caught refusing pictures is taken to see: its first refusal is
    /// learned from the request, after this has returned, so the line beside an attached picture
    /// says what to do then.
    pub(super) async fn crystal_sight<H: Host>(ctx: &ToolContext<H>, id: &str, said: String,
        pics: Vec<(u32, String, Vec<u8>)>) -> Outcome<MessageContent>
    {
        let total: usize = pics.iter().map(|p| p.2.len()).sum();
        if !ctx.is_blind() && total <= CRYSTAL_ATTACH_MAX {
            let mut parts = vec![ContentPart::Text(fmt!("{} {}", said, CRYSTAL_ATTACHED))];
            for (w, path, png) in pics {
                let _ = w;
                parts.push(ContentPart::Image(ImagePart::new(ImageMedia::Png, png, path)));
            }
            return Ok(MessageContent::parts(parts));
        }
        Ok(MessageContent::text(unseen_pictures(id, said, &pics, ctx.host()).await))
    }

    /// The crystal's data and page as the probe draws them, or WHY it cannot.
    ///
    /// Strict where the panel is lenient: a Diamond with no crystal anywhere, a page that could not
    /// be read and a `crystal.json` that is not one JSON object are each an answer in words, never
    /// an empty crystal or the shipped page standing in for the Diamond's own.  The probe used to
    /// default all three and draw the empty card for a crystal it had failed to read.
    pub(super) async fn crystal_inputs<H: Host>(id: &str, host: &H) -> std::result::Result<(String, String), String> {
        let data = match host.store().read_crystal_data_strict(id).await {
            Ok(d)  => d,
            Err(e) => return Err(e.plain()),
        };
        let page = match host.store().read_crystal_page_strict(id).await {
            Ok(p)  => p,
            Err(e) => return Err(fmt!("the page could not be read: {}", e.plain())),
        };
        if let Some(fault) = crystal_json_fault(&data) {
            return Err(fmt!("crystal.json is not valid JSON: {}", fault));
        }
        Ok((data, page))
    }

    /// Measure the Diamond's page again as the turn's last `capture` did, for the edit that has
    /// just changed it: the tables alone, with no picture, and what the note says when a width
    /// could not be measured.
    pub(super) async fn crystal_remeasure<H: Host>(probe: &str, ctx: &ToolContext<H>) -> String {
        let id = match ctx.daimon() {
            Some(i) => i,
            None    => return String::new(),
        };
        let look   = extract_json_string_array(probe, "targets").unwrap_or_default();
        let sel    = if look.is_empty() {
            extract_json_string(probe, "selector").unwrap_or_default()
        } else {
            look.join(", ")
        };
        let widths: Vec<u32> = Self::capture_outs(probe, &id).into_iter().map(|o| o.0).collect();
        let (data, page) = match Self::crystal_inputs(&id, ctx.host()).await {
            Ok(pair) => pair,
            Err(why) => return fmt!(
                "The edit landed, but the page was not measured, because {}. Mend crystal.json \
                first, then capture again.", why.trim_end_matches('.')),
        };
        let mut tables = Vec::new();
        for w in &widths {
            let req = Self::crystal_req(probe, &id, &page, &data, *w, false);
            match ctx.host().ui().capture(&req).await {
                Ok(shot) => tables.push(shot.table),
                Err(e)   => return Self::crystal_remeasure_note(&sel, &widths, Err(e.plain())),
            }
        }
        Self::crystal_remeasure_note(&sel, &widths, Ok(tables))
    }

    /// Where one captured PNG may land, checked BEFORE anything is drawn: the workspace path and
    /// its licence, or the refusal to hand the model.
    pub(super) fn capture_door<H: Host>(ctx: &ToolContext<H>, raw: &str)
        -> Outcome<std::result::Result<(String, Licence), String>>
    {
        let path = res!(Self::scoped(ctx, raw));
        match ctx.licence(&path) {
            Ok(l)    => Ok(Ok((path, l))),
            Err(why) => Ok(Err(why)),
        }
    }

    /// Write one generated file -- a capture's PNG, a compile's PDF, an edited picture -- through
    /// its door, with the bookkeeping every write has.
    ///
    /// WHAT THE FILE LANDS ON: nothing, or this tool's own last output there, made again;
    /// anything else -- a file of the user's included -- is kept and asked about as every other
    /// write's is.
    pub(super) async fn land_output<H: Host>(ctx: &ToolContext<H>, tool: Tool, raw: &str, path: &str,
        lic: &Licence, png: &[u8])
        -> Outcome<std::result::Result<String, String>>
    {
        let tool = tool.name();
        let at = stored_in(ctx, path);
        let (kept, over, bound) = match Self::before_output(ctx, tool, path, raw, png).await {
            Ok(k)    => k,
            Err(why) => return Ok(Err(why)),
        };
        match Self::write_over(ctx, lic, tool, raw, png, &over,
            bound.as_ref(), None).await
        {
            Ok(Ok(_))     => {},
            Ok(Err(why))  => {
                Self::overwrite_failed(&over, ctx.host()).await;
                return Ok(Err(why));
            },
            Err(e)        => { Self::overwrite_failed(&over, ctx.host()).await; return Err(e); },
        }
        let mut unkept = String::new();
        if let Some((dia, before)) = kept {
            let found = Found::of(Some(&before));
            let (before, wiped) = Overwrite::prior(&over, Some(before));
            unkept.push_str(&Self::captured_write(ctx, &dia, path, png.to_vec(), found, before, wiped));
        }
        Self::output_made(ctx, tool, path, png).await;
        lock_cache(&ctx.read_seen).seen.insert(&at, path, content_hash(png));
        Ok(Ok(unkept))
    }

    /// What `file_show` tells a dispatched worker, which may not take the screen.
    ///
    /// A composer rather than a sentence written at the branch, for [`show_result`]'s reason: the
    /// dispatch is wasm-only and a test process has no panel, so a wording only the dispatch knew
    /// could not be proved to be booked the way this file says it is.
    ///
    /// **Through [`refusal_line`]**, so [`call_outcome`] books it [`CallOutcome::Refused`] and the
    /// fold's ledger records a screen that was never taken as one that was never taken.  A refusal
    /// that does not open with the word its readers read is booked as work that was done -- which
    /// is what `say`'s twin refusal was, until it ended a worker's turn and threw the report away.
    pub(super) fn worker_may_not_show() -> MessageContent {
        MessageContent::text(refusal_line(
            "Nothing was shown. You are a dispatched worker: nobody is reading this \
            transcript, and the document panel belongs to the conversation the user is \
            actually in. Name the file in your report instead -- the agent that dispatched \
            you can show it."))
    }

    /// What `file_show` says about a path with no file on this device: in the cloud, or nowhere.
    ///
    /// **The two sentences are composed together because their BOOKINGS differ**, and a reader who
    /// meets them apart will eventually make them agree.  [`call_outcome`] reads the opening word
    /// of every tool reply, and what it decides is which column of the fold's ledger a call lands
    /// in -- `REFUSED, so nothing was touched`, `FAILED`, or, for this tool, no column at all.
    ///
    /// **The cloud file is a REFUSAL.**  Nothing reached the screen, nothing is going to, and the
    /// model met a condition with a documented way round it -- fetch it down, then show it, which
    /// is what [`Ledger::refused`](crate::agent::compact::Ledger::refused) means by a rule it can
    /// work around.  Booked `Done`, a fold recorded an attempted show as an event and then said
    /// nothing about it at all.
    ///
    /// **The missing file is NOT, and this is a judgement rather than an oversight.**  The tool was
    /// asked a question about a path and answered it truthfully; the model can act on the answer,
    /// and `file_list` is named so it can.  Neither other word is available without saying
    /// something false: `FAILED` tells a later self that the tool broke, which is the exact false
    /// generalisation this tool exists to repair -- reasoning from one awkward file to "this app
    /// cannot display things" -- and `REFUSED` tells it a door was closed on a path it is perfectly
    /// entitled to show, which a fold would then hand the user as a permission it does not lack.
    /// `Done` costs nothing here: `record` in [`crate::agent::compact`] has no `file_show` arm, so a
    /// `Done` show is listed in no column and therefore claims nothing.  A fold that says less than
    /// it could beats one that says something untrue.
    ///
    /// # Arguments
    /// * `path` - The file as the model named it, already scoped.
    /// * `cloud` - Its size in the cloud index, or `None` where nothing knows the path at all.
    /// * `split` - Whether a folder on this computer is a second filesystem this turn, which is
    ///   what makes "there is no file at x" a sentence about one place rather than about both.
    pub(super) fn absent_result(path: &str, cloud: Option<u64>, split: bool) -> MessageContent {
        MessageContent::text(match cloud {
            Some(size) => refusal_line(&fmt!(
                "'{}' is in cloud storage rather than on this device, so there is nothing \
                here to show. It is {} bytes. Bring it down with file_fetch first, then show \
                it.", path, size)),
            None if split => fmt!(
                "There is no file at '{}' in this browser's own storage, which is the only \
                place the document panel reads -- a folder on this computer is a second \
                filesystem and the panel has no door onto it. Nothing was shown and the panel \
                is unchanged.", path),
            None => fmt!(
                "There is no file at '{}', so nothing was shown and the panel is unchanged. \
                Check the path with file_list.", path),
        })
    }

    /// What `artefact_add` says about a path with no file on it.
    ///
    /// **Beside [`absent_result`] deliberately: the two sentences say almost the same thing about
    /// almost the same situation, and they are booked OPPOSITE ways.**  A reader who meets them
    /// apart will eventually make them agree, and either direction of that would be a defect.
    ///
    /// This one is a REFUSAL, and the reason is not the sentence -- it is what the fold does with
    /// it.  `record` in [`crate::agent::compact`] has no `file_show` arm, so a `Done` show is
    /// listed in no column and claims nothing; it HAS an `artefact_add` arm, which pushes the path
    /// into [`Ledger::wrote`](crate::agent::compact::Ledger::wrote).  So a `Done` here does not
    /// stay quiet: the fold's note reads `Files written: notes/x.pdf` for a file that does not
    /// exist and was never recorded, three lines above *"Do not claim to have done anything that
    /// is not listed above."*  The one part of a fold that is meant to be arithmetic rather than
    /// judgement was inventing a file and then vouching for it.
    ///
    /// The second reason agrees with the first.  A missing path is no rule at all for `file_show`,
    /// which was asked to put a file on screen and truthfully answered that there is none; here
    /// the tool has a rule of its own and is applying it -- **an artefact must exist to be
    /// declared**, because a record pointing at nothing is found by the user clicking it.  That is
    /// what [`Ledger::refused`](crate::agent::compact::Ledger::refused) means by a rule the model
    /// met and can work around, and the sentence names both the rule and the way round it so the
    /// model can.
    ///
    /// Not [`CallOutcome::Failed`]: nothing broke, and a tool reported as broken is one the model
    /// stops reaching for.
    ///
    /// # Arguments
    /// * `path` - The file as the model named it, already scoped.
    pub(super) fn absent_artefact(path: &str) -> MessageContent {
        MessageContent::text(refusal_line(&fmt!(
            "No file at {}, and an artefact must exist to be declared -- a record pointing at \
            nothing is found by the user clicking it. Nothing was recorded; check the path with \
            file_list.", path)))
    }

    /// What `file_show` tells the model it has just put on the user's screen.
    ///
    /// ONE function, called by the dispatch and by the tests, as [`search_result`](Tool::search_result)
    /// is -- so what a test proves is what the tool says, and not a second composition that happens
    /// to agree with it today.
    ///
    /// **Every FORMAT branch here describes a file that IS on screen.**  There is no "cannot show"
    /// tier: the viewer's floor is a hex dump naming the format, so a `.dSYM` and an `.ipynb` are
    /// shown too, badly but honestly.  That matters more than it sounds, because this tool exists
    /// to repair a false generalisation -- a daimon that reasoned from its toolbox to "this app
    /// cannot display a PDF" -- and a result reading "no viewer for this format" is an invitation
    /// to make exactly the same leap one file later.  So the `hex` branch names what the viewer
    /// DOES draw, and says in as many words not to generalise from the one file in hand.
    ///
    /// The one branch that does NOT is [`Shown::shown`] being false, and it is deliberately not a
    /// tier: it says nothing about the file or its format, only about who is looking at the
    /// screen right now, and it says the file is waiting rather than refused.  A tier would put
    /// "this cannot be displayed" back into the vocabulary this tool was written to remove.
    ///
    /// # Arguments
    /// * `path` - The file, as the panel was asked for it.
    /// * `s` - What the panel answered, including which page it actually opened at.
    pub(super) fn show_result(path: &str, s: &Shown) -> MessageContent {
        let size = fmt!("{} bytes", s.size);
        // A TURN RUN HERE FOR ANOTHER DEVICE.  The user is at that device, not this one, so the
        // file goes to its screen and this one is left alone; the sentence names the device, and
        // says nothing of "another Diamond", which was what it used to say and was false.
        if !s.asker.trim().is_empty() {
            let at = s.asker.trim();
            return MessageContent::text(fmt!(
                "'{}' ({}, {}) is going to the user's screen on {}, the device they asked from: \
                this turn is running on another of their devices for them, so the file opens in \
                Daimond's document panel on {} as this turn's progress reaches it, and the screen \
                of the device running the turn is left alone. There is nothing to do again -- do \
                not call file_show a second time for it. Tell them it is open on {}.",
                path, s.label, size, at, at, at));
        }
        // Answered before the format, because the format describes a screen nobody is looking at.
        if !s.shown {
            return MessageContent::text(fmt!(
                "'{}' was NOT put on screen: the user is in another Diamond, and the document \
                panel belongs to the conversation they are actually in. Daimond is holding the \
                file and will open it the moment they come back to this Diamond, so there is \
                nothing to do again -- do not call file_show a second time, and do not tell them \
                to look at it now. Say what is in it instead.", path));
        }
        let what = match s.tier.as_str() {
            // The one the defect was reported against.  It says "typeset pages, not source"
            // because the model's own answer that day offered the source as a consolation.
            "doc" => fmt!(
                "'{}' is on the user's screen now, in Daimond's document panel: a {}, {}, drawn \
                by the browser's own document viewer. They are looking at the typeset pages, not \
                at any source it came from.{}",
                path, s.label, size,
                match s.page {
                    Some(n) => fmt!(" It is open at page {}.", n),
                    None    => String::new(),
                }),
            "image" => fmt!(
                "'{}' is on the user's screen now, in Daimond's document panel: a {}, {}, decoded \
                and drawn by the browser.", path, s.label, size),
            "audio" | "video" => fmt!(
                "'{}' is on the user's screen now, in Daimond's document panel: a {}, {}, with \
                the player's own controls, so they can start it themselves.",
                path, s.label, size),
            "frame" => fmt!(
                "'{}' is on the user's screen now, in Daimond's document panel: a {}, {}, \
                rendered as a page in a sandboxed frame.", path, s.label, size),
            "json" => fmt!(
                "'{}' is on the user's screen now, in Daimond's document panel: a {}, {}, as a \
                tree they can open and close.", path, s.label, size),
            "table" => fmt!(
                "'{}' is on the user's screen now, in Daimond's document panel: a {}, {}, as a \
                table.", path, s.label, size),
            "markdown" => fmt!(
                "'{}' is on the user's screen now, in Daimond's document panel: a {}, {}, \
                rendered rather than as its markup.", path, s.label, size),
            // Not a lesser outcome: this is where DAIMOND.md and the role prompts are changed,
            // and telling the model the file is editable is what lets it say something useful.
            "editor" => fmt!(
                "'{}' is on the user's screen now, in Daimond's document panel: {}, in the \
                panel's text editor, where they can change it and save.", path, size),
            "empty" => fmt!(
                "'{}' is on the user's screen now, and it holds no bytes at all -- the panel says \
                so and there is nothing else to see. If you expected content, something did not \
                write it.", path),
            // The floor.  READ THE NOTE ABOVE before shortening any of this.
            "hex" => fmt!(
                "'{}' is on the user's screen now, in Daimond's document panel -- but nothing \
                here has a viewer for a {}, so what they can see is its bytes: a paged hex dump, \
                sixteen to a line, with the format and the size ({}) named above it. They can \
                walk through it; they cannot read it as a document. This is about THIS FORMAT and \
                nothing more -- the panel draws pictures, sound, video, PDF, HTML, JSON, CSV, TSV, \
                Markdown and text perfectly well, so do not tell the user Daimond cannot show \
                files. If they need to read this one, say what would open it and offer to convert \
                it to something the panel draws.",
                path, s.label, size),
            // A tier this build has never heard of.  The file is on screen either way, and
            // guessing at what it looks like is how a model comes to describe a screen nobody
            // has seen.
            other => fmt!(
                "'{}' is on the user's screen now, in Daimond's document panel ({}, {}). This \
                build does not know what a '{}' view looks like, so ask them what they can see \
                rather than describing it.", path, s.label, size, other),
        };
        // The disagreement, when there is one.  The panel is already saying this on screen, and
        // the model needs it too: a user looking at a broken export will ask about it, and an
        // agent that does not know the name and the bytes differ will guess at the wrong cause.
        let mut out = what;
        if s.disagree && !s.named.is_empty() && !s.found.is_empty() {
            out.push_str(&fmt!(
                " Note for you rather than for them: this file's NAME says {} and its BYTES say \
                {}, and the bytes are what was drawn. The panel says so on screen.",
                s.named, s.found));
        }
        MessageContent::text(out)
    }

    /// Resolve a tool's raw path against the context's Diamond
    /// [`path_prefix`](ToolContext::path_prefix), refusing one that leaves it.
    ///
    /// With an empty prefix the path passes through unchanged (whole-OPFS behaviour, jailed by the
    /// OPFS root itself); with a prefix such as `diamonds/<id>` the leaf path is confined beneath
    /// it, so a crystal agent addressing `crystal.md` writes `diamonds/<id>/crystal.md`.
    ///
    /// **The join is normalised and then checked, and both halves are the fix.**  This used to
    /// concatenate -- `fmt!("{}/{}", prefix, rel)` -- and hand the result to the OPFS edge, which
    /// resolves `..` lexically and refuses only what climbs above the OPFS ROOT.  A Diamond is not
    /// the root.  So a crystal agent asking for `../beta/crystal.md` was given
    /// `diamonds/alpha/../beta/crystal.md`, which resolved to another Diamond's private notes,
    /// inside OPFS and permitted (`hand/REVIEW.md` §1.19).  The string is the model's, so this is
    /// the compartment being left by something the model chose to write.
    ///
    /// The containment test is [`under`], which compares whole segments.  A string-prefix test
    /// would pass `../alpha2/x` against the prefix `diamonds/alpha` -- a different Diamond whose
    /// name merely begins with this one's.
    ///
    /// **This cannot be done with [`ToolContext::may_read`] instead, and the next person should not
    /// try.**  That door tests the path as the MODEL wrote it, because a turn's bounds are
    /// workspace-relative and a bounded skill turn carries no prefix; a crystal agent asking for
    /// `crystal.md` would be measured as `crystal.md` against an allow-list of `diamonds/<id>` and
    /// refused for its ordinary work.  It is the same collision [`ToolContext::default_cwd`]
    /// records for §1.18, arriving from the other side: a prefix and an allow-list are two ways of
    /// saying where a turn lives, and a path can be checked against one of them, not both.
    ///
    /// An absolute path is treated as relative to the Diamond rather than refused, which is what
    /// [`crate::workspace::Workspace::resolve`] does natively and what the OPFS edge does anyway.
    /// It cannot escape: `/etc/passwd` lands at `diamonds/<id>/etc/passwd`.
    ///
    /// # Arguments
    /// * `ctx` - The turn's context, whose `path_prefix` confines the path.
    /// * `rel` - The path as the model wrote it.
    pub(super) fn scoped<H: Host>(ctx: &ToolContext<H>, rel: &str) -> Outcome<String> {
        let prefix = normalise(&ctx.path_prefix);
        if prefix.is_empty() {
            // No Diamond prefix: the whole OPFS sandbox, which is the user's own workspace agent,
            // and the OPFS edge's own lexical jail is what bounds it, `..` above the root
            // included. Passed through rather than normalised, because this string is the path
            // the result quotes back; each map keyed by it files one spelling itself (`Seen`,
            // and the store's `captured_write`).
            return Ok(rel.to_string());
        }
        let joined = normalise(&fmt!("{}/{}", prefix, rel));
        if !under(&joined, &prefix) {
            return Err(err!(
                "'{}' is outside this Diamond. A Diamond's agent works in its own folder and \
                cannot reach another's, so nothing was read, written or run. Name the file \
                relative to this Diamond, without '..'.", rel;
                Invalid, Input, Path));
        }
        Ok(joined)
    }

    /// Take a turn's hold on the copy of `kept` before the act that replaces or removes it: the
    /// turn's bounds are asked, a run of the turn's the act ends is sealed as its own version
    /// ([`crate::wasm::diamond::seal_run`]), and the copy goes into the store with a note naming
    /// it, ON DISK AND BEFORE THE ACT (see [`crate::wasm::diamond::pend`]).  The refusal is the
    /// answer where the bounds say no or either could not be written, and then nothing may change.
    ///
    /// # Arguments
    /// * `dia` - The keeper whose store keeps the copy.
    /// * `kept` - The path as the capture will name it: the scoped path, or absolute for a file
    ///   on the machine.
    /// * `raw` - The path as the model wrote it, for the sentence.
    /// * `now` - What stands at `kept` as the act found it, or `None` where nothing does.
    /// * `copy` - What the act keeps of it: `now`, or the file as the turns found it where the act
    ///   wipes it; `None` where there is nothing to keep.
    /// * `destroying` - Is this a delete, or a write that wipes the file? Its copy is then held
    ///   as a delete's is, and bound by the room the store has for one.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) async fn hold<H: Host>(dia: &str, kept: &str, raw: &str, now: Option<&[u8]>, copy: Option<&[u8]>,
        destroying: bool, host: &H)
        -> Result<Hold, String>
    {
        match Self::claim(dia, kept, raw, now, copy, destroying, host).await {
            Ok(held) => Self::keep(held, raw, now, copy, destroying, host).await,
            Err(why) => Err(why),
        }
    }

    /// The first half of [`Tool::hold`]: the turn's bounds are asked, and the slot reserved.
    /// Nothing is written.  Asked BEFORE the person is asked anything about the act
    /// ([`Tool::open_delete_gate`]), so a turn past its bound is refused before a question it
    /// could never act on (R2-5 of the Q5-1 fix's QA, 2026-09-24).
    pub(super) async fn claim<H: Host>(dia: &str, kept: &str, raw: &str, now: Option<&[u8]>, copy: Option<&[u8]>,
        destroying: bool, host: &H)
        -> Result<Hold, String>
    {
        let machine = kept.starts_with('/');
        let key = if machine { kept.to_string() } else { normalise(kept) };
        let mut held = Hold { dia: dia.to_string(), key: key.clone(), kept: false,
            reserved: false, noted: false, seen: crate::store::call::unknown_seen() };
        // A path the store does not keep -- the crystal, the store's own record -- is recorded by
        // its own chain, as it always was, and bound by nothing here.
        if !machine && !host.store().versionable(dia, &key) {
            return Ok(held);
        }
        held.kept = true;
        let room = host.store().keep_room(dia).await;
        // Checked and RESERVED in one synchronous step, before the first await below, so agents
        // sharing this store cannot all pass the check at once.
        match host.store().captured_room(dia, &key, &Found::of(now),
            copy.map(|b| b.len() as u64), destroying, room)
        {
            Ok(r)                                         => held.reserved = r,
            Err(crate::diamond_versions::Short::Count)       => return Err(turn_cap_refusal(raw)),
            Err(crate::diamond_versions::Short::Bytes(room)) => return Err(turn_room_refusal(raw, room)),
            Err(crate::diamond_versions::Short::Kept(bytes, max)) =>
                return Err(keep_size_refusal(raw, bytes, max)),
            // The store refused the before-image's claim: nothing is written (LOUD-FAIL B1).
            Err(crate::diamond_versions::Short::Store(why)) =>
                return Err(copy_unwritten_refusal(raw, &why)),
        }
        Ok(held)
    }

    /// The second half of [`Tool::hold`], on a hold [`Tool::claim`] took: a run the act ends is
    /// sealed, and the copy goes into the store with its note.  A refusal gives the claim back.
    pub(super) async fn keep<H: Host>(mut held: Hold, raw: &str, now: Option<&[u8]>, copy: Option<&[u8]>,
        destroying: bool, host: &H)
        -> Result<Hold, String>
    {
        if !held.kept {
            return Ok(held);
        }
        let dia = held.dia.clone();
        let key = held.key.clone();
        let machine = key.starts_with('/');
        // BYTES FROM OUTSIDE THE TURN END ITS RUN on this path (QF2 of the Q5-1 fix's QA): the run
        // so far is its own version before this act, so the copy it holds and the one this act
        // keeps each have a row.
        if let Some(n) = now {
            // PAST THE SEALS A TURN MAY SPEND, refused rather than sealed (R2-4). Asked with no
            // await before the seal, which counts itself in the same step.
            if host.store().seals_spent(&dia, &key, n) {
                Self::let_go(&Some(held), host).await;
                return Err(seal_cap_refusal(raw));
            }
            if let Err(e) = host.store().seal_run(&dia, &key, n).await {
                Self::let_go(&Some(held), host).await;
                return Err(copy_unwritten_refusal(raw, &e.plain()));
            }
        }
        if let Some(b) = copy {
            let mark = machine || stored_is_mark(&dia, &key);
            match host.store().pend(&dia, &key, b, destroying, mark).await {
                Ok(n)  => held.noted = n,
                Err(e) => {
                    Self::let_go(&Some(held), host).await;
                    return Err(copy_unwritten_refusal(raw, &e.plain()));
                },
            }
        }
        Ok(held)
    }

    /// Hold a turn's delete from the folder the user opened on this computer until the PERSON says
    /// it may go on, once the turn has deleted as many there as it may without asking (see
    /// [`crate::diamond_versions::OpenTally`]).  Answers whether this call counted the path, which
    /// a delete that then does not happen gives back, or the refusal where the turn was stopped.
    ///
    /// **Asked through the page's own dialog and never the permission door**
    /// ([`crate::wasm::deletes`]), so the autonomous posture cannot answer it for the person.
    ///
    /// # Arguments
    /// * `dia` - The keeper whose turn this is.
    /// * `path` - The scoped path, normalised, which the question names.
    /// * `file` - The file, as the tally counts it ([`crate::diamond_versions::open_file_key`]).
    /// * `raw` - The path as the model wrote it, for the sentence.
    /// * `act` - What the call is about to do to it, which the question names.
    /// * `turn` - The asking turn's tag, so its Stop closes the question (r578e D2).
    pub(super) async fn open_delete_gate<H: Host>(dia: &str, path: &str, file: &str, raw: &str, act: OpenAct,
        turn: &str, host: &H)
        -> Result<bool, String>
    {
        use crate::diamond_versions::OpenDelete;
        loop {
            match host.store().open_delete_room(dia, file) {
                OpenDelete::Go(counted)   => return Ok(counted),
                OpenDelete::Stopped(n)    => return Err(open_delete_stopped_refusal(raw, n,
                    crate::diamond_versions::open_deletes_ask())),
                OpenDelete::Ask(n, ticket) => {
                    let limit = crate::diamond_versions::open_deletes_ask();
                    let allow = host.ui().ask_to_go_on(dia, path, n, limit,
                        act.wire(), turn).await;
                    host.store().open_delete_answer(dia, ticket, allow);
                    // A stop is this call's answer, whatever became of the turn while it was
                    // asked; a yes is read again from the tally, which says what it now allows.
                    if !allow {
                        return Err(open_delete_stopped_refusal(raw, n, limit));
                    }
                },
            }
        }
    }

    /// Give up a hold whose act did not happen: its reservation is released and its note
    /// withdrawn.  Answers whether the hold was kept instead, as below.
    ///
    /// **An act whose answer is not known may have happened, so its copy is kept** (QA1-C).
    /// Every failed act gives its hold back here, so the rule stands here once: where a store
    /// call since the hold was taken was answered
    /// [`StoreUnknown`](crate::store::call::StoreUnknown) -- the relay's backstop, a store gone
    /// down while it was owed -- the store may commit the act yet, or have committed it already.
    /// Withdrawing the note then left the bytes it wrote over in no row.  So the note and its copy
    /// stay, and only the reservation goes, so the turn end takes the act for done or not done
    /// rather than in flight.  The turn end reconciles it with what stands
    /// ([`crate::store::diamond::pend`]'s note): landed, the copy is recorded as the version it
    /// replaced; not landed, the path reads as the note's copy and nothing is recorded.  The
    /// answer counted is any on the thread since the hold, so a hold kept for another act's
    /// unknown answer keeps a copy that records nothing, never loses one.  A test's red:
    /// `unknown_keeps` off.
    pub(super) async fn let_go<H: Host>(held: &Option<Hold>, host: &H) -> bool {
        let h = match held {
            Some(h) => h,
            None    => return false,
        };
        if h.reserved {
            host.store().release(&h.dia, &h.key);
        }
        let unknown = crate::store::call::unknown_seen() != h.seen
            && !crate::store::diamond::off("unknown_keeps");
        if h.noted && !unknown {
            host.store().unpend(&h.dia, &h.key).await;
        }
        unknown
    }

    /// Before a turn writes over a file that is there: whether the write wipes it, the person's
    /// say where it does in the folder they opened, and the turn's hold on the copy.
    ///
    /// **Emptying most of a user's file is a delete by another verb** (re-check R4, 2026-09-23).
    /// THE RULE, [`crate::diamond_versions::wipes`] on the text a person reads ([`wiped`]): a write
    /// wipes a user's file when less than half of the file, as the turns found it, survives the
    /// write.  "As the turns found it" is [`crate::wasm::diamond::measured_against`] -- the oldest
    /// copy of the unbroken run of turns' changes to it -- so a run of trims, each leaving most of
    /// what it replaced, is a wipe at the write that takes the file below half.
    ///
    /// A wipe counts in the open folder's tally as a delete does, and asks the same person past the
    /// same limit; and it is held as a delete is, through the hold and inside the room the store
    /// has for one ([`Tool::hold`]) -- and what it holds is the copy it was measured against, so
    /// putting it back puts back the file as the turns found it, not the last of the trims.  A
    /// write that leaves half of the file or more is an edit, and is held as one.  Only the user's
    /// files are asked about or held so: a keeper's own home is its working state.
    ///
    /// # Arguments
    /// * `dia` - The keeper whose store keeps the copy.
    /// * `kept` - As the capture will name it: the scoped path, or absolute for a machine file.
    /// * `raw` - The path as the model wrote it, for the sentences.
    /// * `before` - What stands at `kept` now, or `None` where there is nothing to keep.
    /// * `after` - What the write will leave there, where that is known before it lands.
    /// * `take_hold` - Whether to take the hold here; `file_revert` takes it and gives it back
    ///   once its own record is written.
    pub(super) async fn before_overwrite<H: Host>(
        ctx:       &ToolContext<H>,
        dia:       &str,
        kept:      &str,
        raw:       &str,
        before:    Option<&[u8]>,
        after:     Option<&[u8]>,
        take_hold: bool,
    )
        -> Result<Overwrite, String>
    {
        let machine = kept.starts_with('/');
        let mark = machine || stored_is_mark(dia, kept);
        let key = if machine { kept.to_string() } else { normalise(kept) };
        let against = match (mark, before, after) {
            (true, Some(b), Some(_)) =>
                Some(ctx.host().store().measured_against(dia, &key, b).await),
            _ => None,
        };
        let wiped = match (&against, after) {
            (Some(r), Some(a)) => wiped(kept, r, a),
            _                  => false,
        };
        // IN THE FOLDER THE USER OPENED, a wipe is asked about as a delete there is, in the same
        // count: the question is about their disk and whatever syncs it, not about the verb.
        let copy = if wiped { against.clone() } else { None };
        // THE BOUND IS ASKED BEFORE THE PERSON IS (R2-5): a wipe the turn has no room to keep a
        // copy of is refused, and never put to them first.
        let claimed = if take_hold {
            match Self::claim(dia, kept, raw, before, copy.as_deref().or(before), wiped, ctx.host()).await {
                Ok(h)    => Some(h),
                Err(why) => return Err(why),
            }
        } else {
            None
        };
        if before.is_none() {
            if let Err(why) = Self::note_create(ctx, dia, &key, raw).await {
                Self::let_go(&claimed, ctx.host()).await;
                return Err(why);
            }
        }
        // HIS FILE IS ASKED ABOUT FIRST (UNBLOCK-26 U3): nothing is written before he says Apply,
        // and only over the bytes he was shown.
        let mut shown: Option<crate::diamond_versions::Seen> = None;
        if let Some(b) = before {
            if Self::asks_first(ctx, dia, &key, b).await {
                let asked = match after {
                    None    => Err(change_unshown_refusal(raw)),
                    Some(a) => Self::ask_first(ctx, dia, &key, raw, b,
                        crate::held_change::Change::Write(a)).await,
                };
                if let Err(why) = asked {
                    Self::let_go(&claimed, ctx.host()).await;
                    return Err(why);
                }
                shown = Some(crate::diamond_versions::Seen::of(Some(b)));
            }
        }
        let mut counted: Option<(String, String)> = None;
        // A change he was shown and applied is not asked about again as a wipe.
        if wiped && shown.is_none() && !machine && ctx.root == FileRoot::Workspace
            && ctx.host().fs().folder_open() && !is_store_path(kept)
        {
            let file = crate::diamond_versions::open_file_key(&key,
                against.as_deref().unwrap_or_default());
            match Self::open_delete_gate(dia, &key, &file, raw, OpenAct::Wipe, &ctx.turn_tag(),
                ctx.host()).await {
                Ok(true)  => counted = Some((dia.to_string(), file)),
                Ok(false) => {},
                Err(why)  => {
                    Self::let_go(&claimed, ctx.host()).await;
                    return Err(why);
                },
            }
        }
        let held = match claimed {
            Some(h) => match Self::keep(h, raw, before, copy.as_deref().or(before), wiped, ctx.host()).await {
                Ok(h)    => Some(h),
                Err(why) => {
                    if let Some((d, p)) = &counted {
                        ctx.host().store().open_delete_release(d, p);
                    }
                    return Err(why);
                },
            },
            None => None,
        };
        Ok(Overwrite { held, counted, wiped, copy, shown })
    }

    /// A FILE THE TURN MAKES WHERE NOTHING STOOD is told to the host before it lands (R2 U2b), in
    /// its place among the turn's other acts, so Undo removes it; `Err` is the sentence for the
    /// model where the host could not record it, and nothing is made.
    pub(super) async fn note_create<H: Host>(ctx: &ToolContext<H>, dia: &str, key: &str, raw: &str)
        -> Result<(), String>
    {
        if !ctx.by_model {
            return Ok(());
        }
        match ctx.host().ui().note_create(dia, key, &ctx.turn_tag()).await.told(raw) {
            None        => Ok(()),
            Some(why)   => Err(why),
        }
    }

    /// Must a model's turn ask the person before it changes the file at `key`, as `now` holds it?
    /// Yes for a file in a place the user marked that the keeper did not make
    /// ([`crate::store::diamond::authored_by_user`], which answers "his" when unsure); never for
    /// the keeper's own home, the user's own door, or a restore he asked for (UNBLOCK-26 U3).
    ///
    /// **A mark lets a turn write in a folder; it never said the turn may rewrite what he wrote
    /// there.**  On 18 Oct 2026 a daimon filed a letter into his biography with two `file_edit`
    /// calls in a folder held through the hand, and nothing asked.
    ///
    /// # Arguments
    /// * `key` - As the captures name it: normalised, or absolute on the machine.
    ///
    /// **Never in [`Mode::Bypass`]** (UNBLOCK-52), whose promise is that nothing is asked: there
    /// the protection is the automatic guards -- the copy kept before the change, the stale-read
    /// guard, the turn's bound and Undo -- not a question.  It asked there, on the Diamond's own
    /// `STATE.md`, and a "do not ask again" left a two-step rewrite half done.
    pub(super) async fn asks_first<H: Host>(ctx: &ToolContext<H>, dia: &str, key: &str, now: &[u8]) -> bool {
        ctx.by_model && ctx.restoring == 0 && !matches!(mode(), Mode::Bypass)
            && (key.starts_with('/') || stored_is_mark(dia, key))
            && ctx.host().store().authored_by_user(dia, key, now, None).await
    }

    /// Ask the person whether the turn may make `change` to `key`, a file of theirs, showing them
    /// `before` and the change (the host's `ask_change`), and wait.  Nothing is written before
    /// this answers; `Err` is the sentence for the model where nothing may be.
    ///
    /// **Every answer but Apply is final for the rest of the turn** at that path and around it
    /// ([`crate::diamond_versions::ChangeRefusals`]), so a retry, a worker or another verb is
    /// refused unasked rather than asked again.  An Apply binds only the bytes shown: the caller
    /// lands the change under the marks as they stand then and over those bytes alone.
    ///
    /// # Arguments
    /// * `raw` - The path as the model wrote it, for the sentences.
    pub(super) async fn ask_first<H: Host>(ctx: &ToolContext<H>, dia: &str, key: &str, raw: &str,
        before: &[u8], change: crate::held_change::Change<'_>)
        -> Result<(), String>
    {
        if ctx.host().store().change_refused(dia, key) {
            return Err(change_declined_refusal(raw));
        }
        let answer = ctx.host().ui().ask_change(dia, key, before, change, &ctx.turn_tag()).await;
        match answer.told(raw) {
            None       => Ok(()),
            Some(told) => {
                ctx.host().store().refuse_change(dia, key);
                Err(told)
            },
        }
    }

    /// Must a model's move of `key` ask the person first, and what is he shown?  One file is asked
    /// about as [`Tool::asks_first`] has it, and one that could not be read counts as his; a folder
    /// in storage where any file under it is his ([`Tool::store_folder_his`]); a folder on the
    /// machine always, since the hand's walk is not read here (UNBLOCK-26 U3).  The bytes come
    /// back only for one file that was read, which the move is then bound to.
    pub(super) async fn move_asks<H: Host>(ctx: &ToolContext<H>, dia: &str, key: &str, folder: bool,
        files: &[MoveRead])
        -> (bool, Option<Vec<u8>>)
    {
        let machine = key.starts_with('/');
        if !ctx.by_model || ctx.restoring != 0 || matches!(mode(), Mode::Bypass)
            || !(machine || stored_is_mark(dia, &normalise(key)))
        {
            return (false, None);
        }
        if folder {
            return (machine || Self::store_folder_his(ctx, dia, key).await, None);
        }
        match files.first().map(|f| &f.read) {
            Some(Ok(b)) => (Self::asks_first(ctx, dia, key, b).await, Some(b.clone())),
            _           => (true, None),
        }
    }

    /// Does the folder at `path` in storage hold a file of the user's?  Walked through the host's
    /// filesystem to `FOLDER_WALK_MAX` entries; past that, or where a listing or a read fails, the
    /// answer is yes.
    pub(super) async fn store_folder_his<H: Host>(ctx: &ToolContext<H>, dia: &str, path: &str) -> bool {
        const FOLDER_WALK_MAX: usize = 256;
        let max = crate::diamond_versions::VERSION_FILE_MAX as u32;
        let mut dirs = vec![path.to_string()];
        let mut walked = 0usize;
        while let Some(dir) = dirs.pop() {
            let names = match ctx.host().fs().list_dir(ctx.root, &dir).await {
                Ok(n)  => n,
                Err(_) => return true,
            };
            for (name, is_dir, _) in names {
                walked += 1;
                if walked > FOLDER_WALK_MAX {
                    return true;
                }
                let at = fmt!("{}/{}", dir.trim_end_matches('/'), name);
                if is_dir {
                    dirs.push(at);
                    continue;
                }
                let now = match ctx.host().fs().read_file_capped(ctx.root, &at, max).await {
                    Ok((b, _)) => b,
                    Err(_)     => return true,
                };
                if Self::asks_first(ctx, dia, &normalise(&at), &now).await {
                    return true;
                }
            }
        }
        false
    }

    /// Land `bytes` at the path `lic` names, after [`Tool::before_overwrite`], through
    /// [`landed_store_write`]: where nobody was asked, under `bound` (the read it follows, if
    /// any); where the person was, under the marks as they stand now and only over the bytes they
    /// were shown ([`WriteBound::Shown`]).  `landed` rides both arms, so a landing's side files
    /// settle under the same lock either way.  `Ok(Ok(unrecorded))` once written, `unrecorded`
    /// the landing's note for the reply; `Ok(Err(why))` where the licence no longer holds.
    pub(super) async fn write_over<H: Host>(ctx: &ToolContext<H>, lic: &Licence, tool: &str, raw: &str,
        bytes: &[u8], over: &Option<Overwrite>, bound: Option<&WriteBound>, landed: Option<&Landed>)
        -> Outcome<Result<String, String>>
    {
        let seen = match over.as_ref().and_then(|o| o.shown.as_ref()) {
            Some(s) => s,
            None    => return Self::bound_write(ctx, lic, tool, raw, bytes, bound, landed).await,
        };
        let now = match ctx.licence_now(lic.path()).await {
            Ok(l)    => l,
            Err(why) => return Ok(Err(why)),
        };
        let shown = WriteBound::Shown(seen.clone());
        Self::bound_write(ctx, &now, tool, raw, bytes, Some(&shown), landed).await
    }

    /// A file the door just wrote, while the turn had read outside content: a stranger path (NF5).
    pub(super) fn tainted_landing<H: Host>(ctx: &ToolContext<H>, lic: &Licence) {
        if ctx.is_tainted() {
            if let Ok(abs) = ctx.workspace.resolve(lic.path()) {
                note_tainted_write(&abs);
            }
        }
    }

    /// [`landed_store_write`] bound to `bound`, a refusal in `bound`'s words, or as changed just
    /// now where only the landing bound it.
    pub(super) async fn bound_write<H: Host>(ctx: &ToolContext<H>, lic: &Licence, tool: &str, raw: &str,
        bytes: &[u8], bound: Option<&WriteBound>, landed: Option<&Landed>)
        -> Outcome<Result<String, String>>
    {
        match res!(landed_store_write(ctx.host(), ctx.root, lic, lic.path(), bytes,
            bound.map(WriteBound::seen), landed).await)
        {
            Written::Landed { unrecorded } => {
                Self::tainted_landing(ctx, lic);
                Ok(Ok(unrecorded))
            },
            Written::Refused(found)        => {
                let why = match bound {
                    Some(b) => b.refusal(tool, raw, &found),
                    None    => WriteBound::Kept(found.clone()).refusal(tool, raw, &found),
                };
                Err(err!("{}", why; Invalid, Input, Mismatch))
            },
        }
    }

    /// [`Tool::write_over`]'s licence on the machine, for [`machine_write`]: `None` where nobody
    /// was asked, else the licence under the marks as they stand now and the bound to the bytes
    /// the person was shown, which the hand writes over alone (`MachineChange::WriteIf`) -- or
    /// the refusal where the licence no longer holds.
    pub(super) async fn machine_bound<H: Host>(ctx: &ToolContext<H>, lic: &Licence, over: &Option<Overwrite>)
        -> Result<Option<(Licence, WriteBound)>, String>
    {
        let seen = match over.as_ref().and_then(|o| o.shown.clone()) {
            Some(s) => s,
            None    => return Ok(None),
        };
        match ctx.licence_now(lic.path()).await {
            Ok(l)    => Ok(Some((l, WriteBound::Shown(seen)))),
            Err(why) => Err(why),
        }
    }

    /// Give up an overwrite that did not land: its hold, and its count in the open folder's tally.
    pub(super) async fn overwrite_failed<H: Host>(over: &Option<Overwrite>, host: &H) {
        if let Some(o) = over {
            // Kept for an answer not known ([`Tool::let_go`]): the wipe may have happened, so
            // its count in the open folder's tally stands too.
            if Self::let_go(&o.held, host).await {
                return;
            }
            if let Some((d, p)) = &o.counted {
                host.store().open_delete_release(d, p);
            }
        }
    }

    /// What a tool that WRITES A GENERATED FILE owes the file it lands on: nothing, where that file
    /// is absent or is this tool's own last output there, made again; the ordinary overwrite's
    /// keeping ([`Tool::before_overwrite`]) where it is anything else.  Answers what to capture
    /// once the write has landed, and the claim to give up if it does not.  [`Tool::output_made`]
    /// is its other half, once the write has landed.
    ///
    /// **`typst_compile` and `capture` kept no copy of what they wrote over** until 2026-09-23
    /// (re-check R4, the same loss by another door): a compile whose `out` named `notes.md`
    /// replaced the notes with a PDF, with no copy and no question.  A compile loop remakes one
    /// book dozens of times, and keeping each copy would fill the store with bytes the source makes
    /// again and ask the person about every compile in their folder, so a tool's own output is
    /// exempt -- and **which output is its own is decided by provenance, never by kind**.  The
    /// exemption was first "a PDF over a PDF, a PNG over a PNG", which let a compile or a capture
    /// replace the user's own PDF or photograph with no copy and no question.  Now it is the note
    /// this store keeps of the very bytes the tool last wrote at the path
    /// ([`crate::diamond_versions::output_note_says`]): the user's file, or the tool's output
    /// changed since by one byte, is kept as every other write keeps it.
    ///
    /// # Arguments
    /// * `tool` - The generating tool's name, which the note is by.
    /// * `path` - The scoped path the output goes to.
    /// * `raw` - The path as the model wrote it, for the sentences.
    /// * `after` - The output.
    ///
    /// The third answer is what the write is bound to: the read made here, so a save landing
    /// between it and the write -- the question may wait on the person -- is refused rather than
    /// written over (U3a RMW2, 2026-10-17); `None` where nothing was read.
    pub(super) async fn before_output<H: Host>(ctx: &ToolContext<H>, tool: &str, path: &str, raw: &str, after: &[u8])
        -> Result<(Option<(String, Vec<u8>)>, Option<Overwrite>, Option<WriteBound>), String>
    {
        use crate::diamond_versions::Seen;
        let dia = match ctx.keeper() {
            Some(d) => d,
            None    => return Ok((None, None, None)),
        };
        let before = match Self::before_bytes(ctx, path).await {
            Ok(Some(b)) => b,
            Ok(None)    => return Ok((None, None, Some(WriteBound::Kept(Seen::Absent)))),
            Err(why)    => return Err(overwrite_unkept_refusal(raw, &why)),
        };
        let bound = Some(WriteBound::Kept(Seen::of(Some(&before))));
        if ctx.host().store().output_is_own(&dia, tool, &normalise(path), &before).await {
            return Ok((None, None, bound));
        }
        let over = match Self::before_overwrite(ctx, &dia, path, raw, Some(&before), Some(after),
            true).await
        {
            Ok(o)    => o,
            Err(why) => return Err(why),
        };
        Ok((Some((dia, before)), Some(over), bound))
    }

    /// Note, once a generating tool's output has landed at `path`, that these bytes are its own:
    /// the next output there is then made again with no copy, until anything else changes them.
    pub(super) async fn output_made<H: Host>(ctx: &ToolContext<H>, tool: &str, path: &str, bytes: &[u8]) {
        if let Some(dia) = ctx.keeper() {
            ctx.host().store().note_output(&dia, tool, &normalise(path), bytes).await;
        }
    }

    /// Hold what a write into browser storage has just replaced, for the turn-end hook to record.
    ///
    /// The mirror of the machine arm's `machine_before` + [`crate::wasm::diamond::capture`] pair,
    /// and it keys the capture on the SCOPED path deliberately: that is what the turn's ledger
    /// names, and `steer_inner` builds the set of paths it need not read a second time out of
    /// these keys.
    ///
    /// # Arguments
    /// * `dia` - The Diamond the turn acts for.
    /// * `path` - The scoped path, which is the key and the manifest's own spelling.
    /// * `after` - The bytes now on disk.
    /// * `found` - What the write replaced, which tells the capture whether the turn's run on the
    ///   path is unbroken ([`crate::diamond_versions::capture_into`]).
    /// * `before` - The copy kept of what it replaced, or `None` for a file that was not there.
    /// * `wiped` - Did the write wipe them ([`Tool::before_overwrite`])?
    #[must_use]
    pub(super) fn captured_write<H: Host>(
        ctx:    &ToolContext<H>,
        dia:    &str,
        path:   &str,
        after:  Vec<u8>,
        found:  Found,
        before: Option<Vec<u8>>,
        wiped:  bool,
    )
        -> String
    {
        // ONE SPELLING in the manifest, whatever the model wrote: `./x` and `x` are one file, and
        // `versionable` refuses the first, so an overwrite spelled that way kept nothing.  The
        // ledger's own spelling stays the capture's key, which is what the turn end matches on.
        let kept = normalise(path);
        // THE STORE'S OWN RULE, asked here as the turn-end walk asks it: the crystal keeps its
        // own version chain and the store's directory is the store, so a capture of either would
        // put a second, conflicting account of the same bytes in the files manifest.
        if !ctx.host().store().versionable(dia, &kept) {
            return String::new();
        }
        let got = ctx.host().store().capture(dia, path, crate::diamond_versions::Change {
            path:    kept,
            after:   crate::diamond_versions::Body::Held(after),
            before: before.map(crate::diamond_versions::Prior::Held),
            found,
            carried: None,
            mark:    stored_is_mark(dia, path),
            refused: None,
            wiped,
            folder:  None,
            by:      ctx.by.clone(),
            door:    false,
        });
        Self::unkept(ctx.host(), got, path)
    }

    /// Hold what a daimon's `file_delete` has just removed, for the turn-end hook to record, so
    /// `file_revert` and the History can put it back. The delete's twin of [`Self::captured_write`].
    ///
    /// The caller has already asked [`Self::delete_copy`], which refuses the delete of any path
    /// this would pass over, so nothing reaches here that is not kept.  `found` is what the delete
    /// removed, and `before` the copy kept of it: the file as the turns found it.
    #[must_use]
    pub(super) fn captured_delete<H: Host>(ctx: &ToolContext<H>, dia: &str, path: &str, found: Found, before: Vec<u8>)
        -> String
    {
        let kept = normalise(path);
        if !ctx.host().store().versionable(dia, &kept) {
            return String::new();
        }
        let got = ctx.host().store().capture(dia, path, crate::diamond_versions::Change {
            mark:    stored_is_mark(dia, &kept),
            path:    kept,
            after:   crate::diamond_versions::Body::Gone,
            before:  Some(crate::diamond_versions::Prior::Held(before)),
            found,
            carried: None,
            refused: None,
            wiped:   false,
            folder:  None,
            by:      ctx.by.clone(),
            door:    false,
        });
        Self::unkept(ctx.host(), got, path)
    }

    /// Hold what a turn's `file_move` did, once it has landed, for the turn-end hook to record:
    /// each file it carried gone from where it was and standing where it went.  See
    /// [`Self::move_ends`], which worked them out before the move.
    #[must_use]
    pub(super) fn captured_move<H: Host>(ctx: &ToolContext<H>, dia: &str, hold: MoveHold) -> String {
        let mut unkept = String::new();
        for (raw, mut change) in hold.ends.into_iter() {
            change.by = ctx.by.clone();         // both ends are the mover's act
            let got = ctx.host().store().capture(dia, &raw, change);
            unkept.push_str(&Self::unkept(ctx.host(), got, &raw));
        }
        unkept
    }

    /// What an act's answer says of a change the store did not keep for the History, empty where
    /// it did (D1int).  The act stands, so the answer still says what was done; this tells the
    /// model what the History lacks, and the trail notes it.
    ///
    /// # Arguments
    /// * `got` - The store's answer to `capture` or `restore_landed`.
    /// * `path` - The path the change was to, as the act named it.
    #[must_use]
    pub(super) fn unkept<H: Host>(host: &H, got: Outcome<()>, path: &str) -> String {
        match got {
            Ok(())  => String::new(),
            Err(e)  => {
                host.store().trail("CHANGE NOT KEPT", &fmt!("{}: {}", path, e));
                fmt!(" The store did not keep this change to {} for the History ({}): the file \
                    stands as this call left it, but the History will not list it and file_revert \
                    cannot put back what it replaced.", path, e.plain())
            },
        }
    }

    /// Give back what [`Self::move_ends`] reserved for a move that did not happen.
    pub(super) fn move_failed<H: Host>(dia: &str, hold: &MoveHold, host: &H) {
        for key in hold.reserved.iter() {
            host.store().release(dia, key);
        }
    }

    /// What a turn's move of `files` will capture at both ends, worked out BEFORE the move from
    /// what each held as it was read, with the room for the copies it keeps reserved and any run
    /// of the turn's it ends sealed, as a hold's are ([`Self::hold`]); or the refusal where the
    /// turn may not keep them.
    ///
    /// **A move records both of its ends** (Q5-1, 2026-09-24).  It recorded neither, so a file the
    /// turn made and moved away left its "made here" at the path it left, a user's file moved onto
    /// that path took it on, and emptying the user's file there was measured against nothing.  The
    /// source is a destruction of its path and keeps what a delete there would keep; the bytes at
    /// the destination carry the file as the turns found it wherever they came from
    /// ([`crate::diamond_versions::moved`]).  Nothing is copied into the store before the move, as
    /// a delete's copy is: the bytes are not lost, only moved.
    ///
    /// # Arguments
    /// * `raw` - The path as the model wrote it, for the sentences.
    pub(super) async fn move_ends<H: Host>(dia: &str, raw: &str, files: Vec<MoveRead>, host: &H) -> Result<MoveHold, String> {
        use crate::diamond_versions::TurnFound;
        let room = host.store().keep_room(dia).await;
        let mut hold = MoveHold { ends: Vec::new(), reserved: Vec::new() };
        for f in files.into_iter() {
            let machine = f.from.starts_with('/');
            let mark = |p: &str| machine || stored_is_mark(dia, p);
            let keeps = |p: &str| machine || host.store().versionable(dia, p);
            let what = match f.read {
                // A USER'S FILE KEEPS WHAT A DELETE OF IT KEEPS, the file as the turns found it;
                // a keeper's own, what it holds -- `Tool::FileDelete`'s rule, on the other verb.
                Ok(bytes) => {
                    let first = if mark(&f.from) {
                        host.store().turns_found(dia, &f.from, &bytes).await
                    } else {
                        match host.store().this_turn_found(dia, &f.from, &bytes).await {
                            TurnFound::Made       => None,
                            TurnFound::Carried(k) => Some(k),
                            TurnFound::Was(w)     => Some(w),
                        }
                    };
                    crate::diamond_versions::Moving::Read(bytes, first)
                },
                Err((body, why)) => crate::diamond_versions::Moving::Unread(body, why),
            };
            let (src, dst) = crate::diamond_versions::moved(
                (&f.from, mark(&f.from)), (&f.to, mark(&f.to)), what);
            if keeps(&f.from) {
                // THE SOURCE IS A DESTRUCTION OF ITS PATH, and a copy it keeps counts as a
                // delete's does, reserved in one synchronous step as a hold's is.  A file the turn
                // made keeps nothing there, and neither does a destination: those are captured and
                // bound by nothing (QF1 of the Q5-1 fix's QA -- each cost a slot of the turn's 64,
                // so a folder of 33 files the turn wrote could not be renamed).
                if let Some(copy) = &src.before {
                    match host.store().captured_room(dia, &src.path, &src.found,
                        Some(copy.len() as u64), true, room)
                    {
                        Ok(true)   => hold.reserved.push(src.path.clone()),
                        Ok(false)  => {},
                        Err(short) => {
                            Self::move_failed(dia, &hold, host);
                            return Err(match short {
                                crate::diamond_versions::Short::Count       => turn_cap_refusal(raw),
                                crate::diamond_versions::Short::Bytes(room) =>
                                    turn_room_refusal(raw, room),
                                crate::diamond_versions::Short::Kept(bytes, max) =>
                                    keep_size_refusal(raw, bytes, max),
                                // LOUD-FAIL B1: the store refused the claim; nothing moves.
                                crate::diamond_versions::Short::Store(why) =>
                                    copy_unwritten_refusal(raw, &why),
                            });
                        },
                    }
                }
                // A run of the turn's the move ends is its own version before it goes, as a
                // hold's is ([`Self::hold`]); the moved bytes are what the source held.
                if let crate::diamond_versions::Body::Held(now) = &dst.after {
                    if host.store().seals_spent(dia, &src.path, now) {
                        Self::move_failed(dia, &hold, host);
                        return Err(seal_cap_refusal(raw));
                    }
                    if let Err(e) = host.store().seal_run(dia, &src.path, now).await {
                        Self::move_failed(dia, &hold, host);
                        return Err(copy_unwritten_refusal(raw, &e.plain()));
                    }
                }
                hold.ends.push((f.from_raw, src));
            }
            if keeps(&f.to) {
                hold.ends.push((f.to_raw, dst));
            }
        }
        Ok(hold)
    }

    /// What a move in browser storage or the open folder carries, read before it goes: the file at
    /// `from`, or where `from` is a folder, each file the turn holds under it
    /// ([`crate::wasm::diamond::held_under`]).  A folder's other files the turn neither made nor
    /// destroys, and where they land they are measured as they stand.
    ///
    /// # Arguments
    /// * `from`, `to` - The scoped paths, which are also what the captures are keyed on.
    pub(super) async fn store_move_read<H: Host>(ctx: &ToolContext<H>, dia: &str, from: &str, to: &str) -> Vec<MoveRead> {
        let (src, dst) = (normalise(from), normalise(to));
        if let Ok(true) = ctx.host().fs().is_directory(ctx.root, from).await {
            let mut out = Vec::new();
            for (path, rest, path_raw) in ctx.host().store().held_under(dia, &src) {
                // The turn's capture of a file no longer there -- one it deleted -- stays as it is.
                if let Some(read) = Self::store_move_one(ctx, &path).await {
                    out.push(MoveRead { from: path, from_raw: path_raw,
                        to: fmt!("{}/{}", dst, rest), to_raw: fmt!("{}/{}", dst, rest), read });
                }
            }
            return out;
        }
        match Self::store_move_one(ctx, from).await {
            Some(read) => vec![MoveRead { from: src, from_raw: from.to_string(), to: dst,
                to_raw: to.to_string(), read }],
            None       => Vec::new(),   // nothing there, and the move will say so
        }
    }

    /// One file a move in browser storage carries: its bytes, up to what a version holds; why it
    /// was not read; or nothing where there is no file.
    pub(super) async fn store_move_one<H: Host>(ctx: &ToolContext<H>, path: &str)
        -> Option<Result<Vec<u8>, (crate::diamond_versions::Body, String)>>
    {
        let max = crate::diamond_versions::VERSION_FILE_MAX;
        match ctx.host().fs().read_file_capped(ctx.root, path, max as u32).await {
            Ok((b, total)) if total as usize <= max => Some(Ok(b)),
            Ok((_, total)) => Some(Err((crate::diamond_versions::Body::TooLarge(total as u64),
                "size".to_string()))),
            Err(_) => match ctx.host().fs().exists(ctx.root, path).await {
                Ok(false) => None,
                _         => Some(Err((crate::diamond_versions::Body::Unseen,
                    "unreadable".to_string()))),
            },
        }
    }

    /// What a move on this computer carries, read through the hand before it goes: the file at
    /// `from`, or where `from` is a folder, each file the turn holds under it.  See
    /// [`Self::store_move_read`].
    ///
    /// # Arguments
    /// * `from`, `to` - Each absolute, as the captures name it, and as the model wrote it.
    /// * `host` - The host the hand and browser storage are reached through.
    pub(super) async fn machine_move_read<H: Host>(
        dia:  &str,
        from: (&str, &str),
        to:   (&str, &str),
        cwd:  &str,
        spec: &LinkedFence,
        kits: &[Bound],
        host: &H,
    )
        -> Vec<MoveRead>
    {
        let one = |path: &str, path_raw: &str, dst: String, dst_raw: String,
            read: Result<Vec<u8>, (crate::diamond_versions::Body, String)>|
            MoveRead { from: path.to_string(), from_raw: path_raw.to_string(), to: dst,
                to_raw: dst_raw, read };
        match machine_before(from.0, cwd, spec, kits, host).await {
            (Some(b), _)                                 =>
                vec![one(from.0, from.1, to.0.to_string(), to.1.to_string(), Ok(b))],
            (None, None)                                 => Vec::new(),
            (None, Some(why)) if !hand_said_directory(&why) =>
                vec![one(from.0, from.1, to.0.to_string(), to.1.to_string(),
                    Err((crate::diamond_versions::Body::Unseen, why)))],
            (None, Some(_))                              => {
                let mut out = Vec::new();
                for (path, rest, path_raw) in host.store().held_under(dia, from.0) {
                    let read = match machine_before(&path, cwd, spec, kits, host).await {
                        (Some(b), _)      => Ok(b),
                        (None, None)      => continue,  // a file the turn deleted stays so
                        (None, Some(why)) => Err((crate::diamond_versions::Body::Unseen, why)),
                    };
                    out.push(one(&path, &path_raw, fmt!("{}/{}", to.0, rest),
                        fmt!("{}/{}", to.1.trim_end_matches('/'), rest), read));
                }
                out
            },
        }
    }

    /// A restore's hold on what its act replaces or removes at `key`, taken once the fence has
    /// passed and immediately before the act (see [`ToolContext::restoring`]); `Ok(None)` for every
    /// call that is not a restore's.  The copy of `now` goes into the store with a note, and any
    /// turn's run on the path is ended ([`crate::wasm::diamond::restore_keep`]).
    ///
    /// **A restore never replaces or removes what it cannot keep**: a path the store does not
    /// keep, bytes past the size a version holds, or a copy that could not be written, is the
    /// act's refusal, and the file stays as it is.
    ///
    /// **Only into the file its row was written from** (HR, 2026-09-25): an act at a path handed out
    /// for a row written in another folder than the one the path reaches now is refused, and one
    /// for a row from before folders were recorded is refused over different bytes until the
    /// person says so ([`crate::wasm::diamond::restore_route`]).
    ///
    /// # Arguments
    /// * `raw` - The path as the caller wrote it, for the sentences.
    /// * `key` - As the store names it: the scoped path normalised, or absolute on the machine.
    /// * `now` - What stands there as the act found it, or `None` where nothing does.
    /// * `puts` - The bytes the act puts there, or `None` for a delete.
    pub(super) async fn restore_hold<H: Host>(ctx: &ToolContext<H>, raw: &str, key: &str, now: Option<&[u8]>,
        puts: Option<&[u8]>)
        -> Result<Option<RestoreHold>, String>
    {
        let deleting = puts.is_none();
        if ctx.restoring == 0 {
            return Ok(None);
        }
        let id = match ctx.host().store().restore_store(ctx.restoring) {
            Some(id) => id,
            None     => return Err(restore_ended_refusal(raw)),
        };
        if !key.starts_with('/') && !ctx.host().store().versionable(&id, key) {
            return Err(refusal_line(&fmt!(
                "'{}' is part of Daimond's own record, which keeps its own history, so a restore \
                does not change it here. Nothing was changed.", raw)));
        }
        // Before the route, so a file too large to keep is not asked about first and refused after.
        if let Some(b) = now {
            if b.len() > crate::diamond_versions::VERSION_FILE_MAX {
                return Err(restore_size_refusal(raw, b.len() as u64));
            }
        }
        // THE ACT IS BOUND TO THE BYTES THE PERSON DECIDED ON (hist-safe R2, 2026-10-12): `now` is
        // read here, at the act, and anything else there since is asked about again.
        match ctx.host().store().restore_route(ctx.restoring, raw, key, now, puts) {
            crate::diamond_versions::Act::Go         => {},
            crate::diamond_versions::Act::Same       => return Err(restore_same_line(raw)),
            crate::diamond_versions::Act::Changed    => return Err(restore_changed_refusal(raw)),
            crate::diamond_versions::Act::Left       => return Err(restore_elsewhere_refusal(raw)),
            crate::diamond_versions::Act::Ask(why)   => return Err(restore_unplaced_refusal(raw, why)),
            crate::diamond_versions::Act::Unasked    => return Err(restore_unasked_refusal(raw)),
            crate::diamond_versions::Act::Unanswered => return Err(restore_unanswered_refusal(raw)),
        }
        match ctx.host().store().restore_keep(ctx.restoring, key, now, deleting).await {
            Ok(())  => Ok(Some(RestoreHold {
                ticket: ctx.restoring,
                mark:   ctx.host().store().theirs(&id, key),
                key:    key.to_string(),
                before: now.map(|b| b.to_vec()),
                folder: ctx.host().store().folder_of(key),
            })),
            Err(e)  => Err(copy_unwritten_refusal(raw, &e.plain())),
        }
    }

    /// Hold what a restore's act left at its path, once it landed, for the restore's record.
    /// A landing the store did not keep is told as a capture's is ([`Self::unkept`]).
    #[must_use]
    pub(super) fn restore_landed<H: Host>(held: Option<RestoreHold>, after: crate::diamond_versions::Body, host: &H)
        -> String
    {
        let h = match held {
            Some(h) => h,
            None    => return String::new(),
        };
        let found = Found::of(h.before.as_deref());
        let key = h.key.clone();
        let got = host.store().restore_landed(h.ticket, crate::diamond_versions::Change {
            path:    h.key,
            after,
            before:  h.before.map(crate::diamond_versions::Prior::Held),
            found,
            carried: None,
            mark:    h.mark,
            refused: None,
            wiped:   false,
            folder:  h.folder,
            by:      None,          // a restore is the person's own act
            door:    false,
        });
        Self::unkept(host, got, &key)
    }

    /// A restore's machine write the hand refused as changed since the door read it, given back
    /// and recorded so the page's re-ask names what stands there now: the sentence to answer
    /// with, or `None` where `got` is not that refusal (hist-safe F1, 2026-10-12).
    pub(super) async fn restore_hand_changed<H: Host>(ctx: &ToolContext<H>, raw: &str, rest: &Option<RestoreHold>,
        got: &Result<String, String>)
        -> Option<String>
    {
        let found = match (got, rest) {
            (Err(why), Some(_)) => hand_found(why),
            _                   => None,
        };
        match found {
            Some(now) => {
                Self::restore_failed(rest, ctx.host()).await;
                ctx.host().store().restore_asked(ctx.restoring, raw, now);
                Some(restore_changed_refusal(raw))
            },
            None      => None,
        }
    }

    /// Write `bytes` into storage at `lic`; under a restore's hold, only over the bytes the act
    /// was bound to, re-read immediately before the commit (hist-safe F1, 2026-10-12), with
    /// `landed`'s side files settled under the same lock ([`landed_store_write`]).
    /// `Ok(Ok(unrecorded))` once written; where the file changed since, the hold is given back,
    /// what stands there is what the person is asked about next, and the sentence to answer with
    /// comes back as `Ok(Err(..))`.
    pub(super) async fn restore_store_write<H: Host>(ctx: &ToolContext<H>, raw: &str, lic: &Licence, bytes: &[u8],
        rest: &Option<RestoreHold>, bound: Option<&WriteBound>, over: &Option<Overwrite>,
        landed: Option<&Landed>)
        -> Outcome<Result<String, String>>
    {
        // Outside a restore, bound to the read the write follows, compared under the lock -- or
        // to what the person was shown, where they were asked ([`Tool::write_over`]).
        let held = match rest {
            Some(h) => h,
            None    => return Self::write_over(ctx, lic, "file_write", lic.path(), bytes, over,
                bound, landed).await,
        };
        // A landing worked out from other bytes than the hold's is an Err before the lock, which
        // the caller answers by giving the hold back; nobody is asked about bytes nobody found.
        let seen = crate::diamond_versions::Seen::of(held.before.as_deref());
        match res!(landed_store_write(ctx.host(), ctx.root, lic, lic.path(), bytes, Some(&seen),
            landed).await)
        {
            Written::Landed { unrecorded } => {
                Self::tainted_landing(ctx, lic);
                Ok(Ok(unrecorded))
            },
            Written::Refused(found)        => {
                Self::restore_failed(rest, ctx.host()).await;
                ctx.host().store().restore_asked(ctx.restoring, raw, found);
                Ok(Err(restore_changed_refusal(raw)))
            },
        }
    }

    /// Give back a restore's hold whose act did not land.
    pub(super) async fn restore_failed<H: Host>(held: &Option<RestoreHold>, host: &H) {
        if let Some(h) = held {
            host.store().restore_let_go(h.ticket, &h.key).await;
        }
    }

    /// What a model's overwrite of `path` in browser storage is about to replace: its bytes,
    /// `None` for a file that is not there, or why it is there and could not be read.
    ///
    /// **A failed read is not an absence.**  `read_file(...).ok()` read a present file that would
    /// not read -- a `NotReadableError` while an editor or Syncthing writes it, a permission lost
    /// mid-session -- as a new file, and overwrote it with no copy (audit of 2026-09-23, finding
    /// 5; the delete's arm was mended for the same fault before it).  A file held only in cloud
    /// storage is not read either: its bytes are not on this device to keep.
    pub(super) async fn before_bytes<H: Host>(ctx: &ToolContext<H>, path: &str) -> Result<Option<Vec<u8>>, String> {
        match ctx.host().fs().read_file(ctx.root, path).await {
            Ok(b)  => Ok(Some(b)),
            Err(e) => match ctx.host().fs().exists(ctx.root, path).await {
                Ok(false) if ctx.host().fs().cloud_size_of(path).is_some() =>
                    Err("it is only in cloud storage, not on this device".to_string()),
                Ok(false) => Ok(None),
                Ok(true)  => Err(e.plain()),
                Err(e2)   => Err(e2.plain()),
            },
        }
    }

    /// Forget this agent's view of `path` where nothing is there, which a read has just found: a
    /// write after it is then the agent's own choice, not one made from an old read (RD2).  A
    /// file there that would not read, or one only in cloud storage, leaves the view as it was.
    /// Its own function so `execute`'s one future holds none of its locals.
    pub(super) async fn read_found_nothing<H: Host>(ctx: &ToolContext<H>, at: &Storage, path: &str) {
        if let Ok(None) = Self::before_bytes(ctx, path).await {
            lock_cache(&ctx.read_seen).seen.remove(at, path);
        }
    }

    /// The bytes a turn's `file_delete` is about to remove, or the refusal that stops it.
    ///
    /// **The delete waits on the copy, never the other way round.**  Each way of failing to take
    /// one is a sentence, and the file stays:
    ///
    /// * a path the store does not keep -- a Diamond's crystal or the store's own record -- because a
    ///   capture there is dropped, and a delete with its capture dropped is a delete with no way
    ///   back;
    /// * a file larger than a version holds;
    /// * a file that is on this device and would not read -- a `NotReadableError` while an editor
    ///   or Syncthing is writing it, or a folder permission lost mid-session.  The old arm took
    ///   any failed read to mean "not here" and deleted with no copy;
    /// * a file that is only in cloud storage, whose deletion is a forget no copy on this device
    ///   stands behind.
    ///
    /// # Arguments
    /// * `dia` - The keeper whose store keeps the copy.
    /// * `raw` - The path as the model wrote it, normalised, for the sentences.
    /// * `path` - The scoped path, which is what is read and kept.
    pub(super) async fn delete_copy<H: Host>(ctx: &ToolContext<H>, dia: &str, raw: &str, path: &str)
        -> Outcome<Result<Vec<u8>, String>>
    {
        if !ctx.host().store().versionable(dia, path) {
            return Ok(Err(fmt!(
                "'{}' is part of Daimond's own record, which keeps its own history, so \
                file_delete does not remove it. Nothing was deleted.", raw)));
        }
        let max = crate::diamond_versions::VERSION_FILE_MAX;
        match ctx.host().fs().read_file_capped(ctx.root, path, max as u32).await {
            Ok((b, total)) if total as usize <= max => Ok(Ok(b)),
            Ok((_, total)) => Ok(Err(delete_size_refusal(raw, total as u64))),
            Err(e) => {
                if res!(ctx.host().fs().exists(ctx.root, path).await) {
                    return Ok(Err(delete_unread_refusal(raw)));
                }
                if ctx.host().fs().cloud_size_of(path).is_some() {
                    return Ok(Err(delete_cloud_refusal(raw)));
                }
                Err(err!(e, "file_delete: '{}' is not there, so nothing was deleted.", raw;
                    IO, File, Missing))
            },
        }
    }

    /// The one-line nudge a large `file_write` earns, or nothing where it is small.
    ///
    /// A write over [`FILE_WRITE_NUDGE_BYTES`] means a lot of text passed through the model, and
    /// the thing worth saying is that data it did not author has cheaper roads to a file than being
    /// typed. It is a note, never a refusal: the write has already happened when this is appended.
    pub(super) fn file_write_nudge(len: usize) -> String {
        if len <= FILE_WRITE_NUDGE_BYTES {
            return String::new();
        }
        fmt!("\nNote: {} KB typed through you. Data you did not author goes straight to a file -- \
            web_fetch 'to' for a download, run's sh -c redirection for local output.", len / 1024)
    }

    /// What a `web_fetch to:` write answers with: a handle, never the content.
    ///
    /// The whole point of saving to a file is that the bytes do not pass through the model, so the
    /// result names the size, the path and the type and stops there. Its own function so a test can
    /// hold it to that -- a return that carried the content would be the failure this path exists
    /// to avoid.
    pub(super) fn saved_bytes_line(n: usize, path: &str, content_type: &str) -> String {
        let ct = content_type.trim();
        let ct = if ct.is_empty() { "no content type given" } else { ct };
        fmt!("Saved {} bytes to {} ({}).", n, path, ct)
    }

    /// Join a workspace-relative directory and an entry name into a clean
    /// relative path, dropping a `.`/empty directory prefix so search
    /// results read like the native workspace-relative form.
    pub(super) fn join_rel(dir: &str, name: &str) -> String {
        if dir.is_empty() || dir == "." {
            name.to_string()
        } else {
            fmt!("{}/{}", dir.trim_end_matches('/'), name)
        }
    }

    // ── File tools (sync std::fs; workspace files are small) ────────

    pub(super) fn arg<'a>(args: &'a str, key: &str) -> Outcome<String> {
        match extract_json_string(args, key) {
            Some(v) => Ok(v),
            None => Err(err!("Tool: missing required argument '{}'.", key; Invalid, Input, Missing)),
        }
    }

    /// The text of a file read, cut to the output budget and, when the file came from outside the
    /// user, wrapped in the untrusted envelope.
    ///
    /// The cut is made to the content *before* the envelope goes on, so a file long enough to be
    /// truncated still ends with the closing marker.  An opening marker with no end would leave
    /// every later tool result reading as a stranger's words.
    ///
    /// # Arguments
    /// * `ctx` - The context, which records that the turn read untrusted content.
    /// * `path` - The workspace-relative path, as the model wrote it.
    /// * `s` - The file's text.
    pub(super) fn mark_if_untrusted<H: Host>(ctx: &ToolContext<H>, path: &str, s: String) -> String {
        Self::mark_if_from(ctx, path, is_untrusted_path(path), s)
    }

    /// [`Self::mark_if_untrusted`], where the caller has judged whether the file is a stranger's:
    /// a machine read judges where it lands as well as how it was spelt ([`is_stranger_at`]).
    ///
    /// # Arguments
    /// * `stranger` - Whether the file's content came from a stranger.
    pub(super) fn mark_if_from<H: Host>(ctx: &ToolContext<H>, path: &str, stranger: bool, mut s: String) -> String {
        if !stranger {
            truncate_output(&mut s, MAX_OUTPUT);
            return s;
        }
        // Defanged before the cut, not after: quoting a forged marker lengthens the text, and a
        // message that was nothing but forged markers would otherwise leave the budget far behind.
        // The cut cannot make a new marker out of what is left, since it only drops a tail.
        s = defang(&s);
        truncate_output(&mut s, MAX_OUTPUT.saturating_sub(envelope_overhead(path)));
        ctx.wrap_untrusted(path, &s)
    }

    /// The window of a file a `file_read` call asked for, numbered.
    ///
    /// Shared by both transports, so the browser and the native build page a file by the same
    /// rules -- two windowing routines would eventually disagree about which line is line one.
    ///
    /// # Arguments
    /// * `args` - The raw tool arguments, which may carry `offset` and `limit`.
    /// * `path` - The path, as the model wrote it.
    /// * `text` - The file's whole text.
    pub(super) fn read_view(args: &str, path: &str, text: &str) -> String {
        Self::read_view_of(args, path, is_untrusted_path(path), text, None)
    }

    /// The same view, where `text` is a WINDOW of the file rather than the whole of it.
    ///
    /// # Arguments
    /// * `stranger` - Whether the file is a stranger's, so the envelope is charged to the budget.
    /// * `text` - The lines held here, starting at `whole`'s own `from`.
    /// * `whole` - What the file is, or `None` where `text` is all of it.
    pub(super) fn read_view_of(args: &str, path: &str, stranger: bool, text: &str, whole: Option<Window>) -> String {
        let (offset, limit) = read_ask(args);
        // The envelope is charged against the same budget, so a mail message's window is computed
        // knowing what the wrapping will cost -- otherwise the foot notice would be cut off by
        // the very truncation it exists to explain.
        let budget = if stranger {
            MAX_OUTPUT.saturating_sub(envelope_overhead(path))
        } else {
            MAX_OUTPUT
        };
        // The FILE's size, not the window's: a peek is a decision about how much of a file to
        // hand over unasked, and a window is already less than the file.
        let size = match whole {
            Some(w) => w.bytes,
            None    => text.len(),
        };
        // A bare read of a large file is a peek. See `READ_BIG_BYTES` for the 80,016 bytes
        // that bought nothing.  A named range in ANY of its three spellings -- `offset`,
        // `limit`, or `end` -- is a caller answering the peek's question itself, so none of
        // them is bare.
        let bare = !arg_given(args, "offset")
            && !arg_given(args, "limit")
            && !arg_given(args, "end");
        let peek = bare && size > output_caps().read_bytes;
        let limit = if peek { READ_PEEK_LINES } else { limit };
        numbered_view(path, text, offset, limit, budget, peek, whole)
    }


}
