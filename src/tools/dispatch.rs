use super::*;

impl Tool {
    /// The browser transport's tools, before an edit of a Diamond's page is measured again.
    pub(super) async fn execute_inner<H: Host>(&self, args_json: &str, ctx: &ToolContext<H>) -> Outcome<MessageContent> {
        // The same door as the native transport, and the same `guard`: a turn bounded by a skill's
        // declaration may not edit the declaration, and may not read another skill's files. The
        // path is checked as the model wrote it, before `scoped` applies any Diamond prefix -- the
        // bounds are workspace-relative, and a bounded skill turn never carries a prefix.
        if let Some(refusal) = res!(self.guard(args_json, ctx)) {
            return Ok(MessageContent::text(refusal));
        }
        let text = res!(match self {
            Tool::FileWrite => return Self::file_write_page(args_json, ctx).await,
            Tool::DocEdit => {
                let raw = res!(Self::arg(args_json, "path"));
                let path = res!(Self::scoped(ctx, &raw));
                let media = res!(office_kind(&raw).ok_or_else(|| err!(
                    "doc_edit: '{}' does not name a document. It edits .docx and .odt; ordinary \
                    text files are edited with file_edit.", raw; Invalid, Input)));
                let at = stored_in(ctx, &path);
                let bytes = match ctx.host().fs().read_file(ctx.root, &path).await {
                    Ok(b)  => b,
                    Err(e) => match absent_here(ctx, &raw, &path).await {
                        Some(note) => return Err(err!("doc_edit: {}", note;
                            IO, File, Read, Missing)),
                        None       => return Err(e),
                    },
                };
                let (out, note) = res!(doc_edited(&raw, media, &bytes, args_json));
                let lic = match ctx.licence(&path) {
                    Ok(l)    => l,
                    Err(why) => return Ok(MessageContent::text(why)),
                };
                let over = match ctx.keeper() {
                    Some(dia) => match Self::before_overwrite(ctx, &dia, &path, &raw, Some(&bytes),
                        Some(&out), true).await
                    {
                        Ok(o)    => Some(o),
                        Err(why) => return Ok(MessageContent::text(why)),
                    },
                    None      => None,
                };
                match Self::write_over(ctx, &lic, "doc_edit", &raw, &out, &over,
                    Some(&WriteBound::Read(crate::diamond_versions::Seen::of(Some(&bytes)))), None).await
                {
                    Ok(Ok(_))     => {},
                    Ok(Err(why))  => {
                        Self::overwrite_failed(&over, ctx.host()).await;
                        return Ok(MessageContent::text(why));
                    },
                    Err(e)        => { Self::overwrite_failed(&over, ctx.host()).await; return Err(e); },
                }
                let mut unkept = String::new();
                if let Some(dia) = ctx.keeper() {
                    let found = Found::of(Some(&bytes));
                    let (before, wiped) = Overwrite::prior(&over, Some(bytes));
                    unkept.push_str(&Self::captured_write(ctx, &dia, &path, out.clone(), found, before, wiped));
                }
                // The file on disk is now this, so a later `file_write` is anchored to what the
                // edit left rather than to what the agent last read.
                lock_cache(&ctx.read_seen).seen.insert(&at, &path, content_hash(&out));
                Ok(fmt!("Edited {}, now {} bytes.{}{}", raw, out.len(), note, unkept))
            }
            Tool::SheetWrite => {
                let raw = res!(Self::arg(args_json, "path"));
                let path = res!(Self::scoped(ctx, &raw));
                let media = res!(office_kind(&raw).ok_or_else(|| err!(
                    "sheet_write: '{}' does not name a spreadsheet. It writes .xlsx and .ods.", raw;
                    Invalid, Input)));
                let at = stored_in(ctx, &path);
                let bytes = match ctx.host().fs().read_file(ctx.root, &path).await {
                    Ok(b)  => b,
                    Err(e) => match absent_here(ctx, &raw, &path).await {
                        Some(note) => return Err(err!("sheet_write: {}", note;
                            IO, File, Read, Missing)),
                        None       => return Err(e),
                    },
                };
                let (out, note) = res!(sheet_written(&raw, media, &bytes, args_json));
                let lic = match ctx.licence(&path) {
                    Ok(l)    => l,
                    Err(why) => return Ok(MessageContent::text(why)),
                };
                let over = match ctx.keeper() {
                    Some(dia) => match Self::before_overwrite(ctx, &dia, &path, &raw, Some(&bytes),
                        Some(&out), true).await
                    {
                        Ok(o)    => Some(o),
                        Err(why) => return Ok(MessageContent::text(why)),
                    },
                    None      => None,
                };
                match Self::write_over(ctx, &lic, "sheet_write", &raw, &out, &over,
                    Some(&WriteBound::Read(crate::diamond_versions::Seen::of(Some(&bytes)))), None).await
                {
                    Ok(Ok(_))     => {},
                    Ok(Err(why))  => {
                        Self::overwrite_failed(&over, ctx.host()).await;
                        return Ok(MessageContent::text(why));
                    },
                    Err(e)        => { Self::overwrite_failed(&over, ctx.host()).await; return Err(e); },
                }
                let mut unkept = String::new();
                if let Some(dia) = ctx.keeper() {
                    let found = Found::of(Some(&bytes));
                    let (before, wiped) = Overwrite::prior(&over, Some(bytes));
                    unkept.push_str(&Self::captured_write(ctx, &dia, &path, out.clone(), found, before, wiped));
                }
                lock_cache(&ctx.read_seen).seen.insert(&at, &path, content_hash(&out));
                Ok(fmt!("Wrote to {}, now {} bytes.{}{}", raw, out.len(), note, unkept))
            }
            Tool::SheetRead => {
                let raw = res!(Self::arg(args_json, "path"));
                let path = res!(Self::scoped(ctx, &raw));
                let bytes = match ctx.host().fs().read_file(ctx.root, &path).await {
                    Ok(b)  => b,
                    Err(e) => match absent_here(ctx, &raw, &path).await {
                        Some(note) => return Err(err!("sheet_read: {}", note;
                            IO, File, Read, Missing)),
                        None       => return Err(e),
                    },
                };
                let view = res!(sheet_view(&raw, &bytes, args_json));
                Ok(Self::mark_if_untrusted(ctx, &raw, view))
            }
            Tool::FileRead => {
                // Several files, or a pattern: a different answer with a different shape, and
                // the single read below is untouched by it.
                if let Some(asked) = read_many_ask(args_json) {
                    return Self::read_many(args_json, &asked, ctx).await;
                }
                let raw = res!(Self::arg(args_json, "path"));
                let path = res!(Self::scoped(ctx, &raw));
                // THE MACHINE, WHERE THE PATH IS UNDER A MARK. Asked first, because every
                // sentence below it is written about browser storage and would be false here.
                // The whole file is fetched and handed to `read_view` unchanged, so a page of a
                // machine file is the same page of the same file: one paging rule, one set of
                // line numbers, one notice.
                match reach_of(ctx, &raw, &path, Door::Look).await {
                    Reach::Refuse(why) => return Ok(MessageContent::text(refusal_line(&why))),
                    Reach::Machine { abs, cwd, root, spec } => {
                        // Judged where the read lands as well as how it was spelt (U10): on a
                        // whole-home runner `usr/mail/x` and `Downloads/x` are a stranger's.
                        let stranger = is_untrusted_path(&raw) || is_stranger_at(&abs, &root);
                        let at = Storage::Machine(root);
                        // THE WINDOW THIS CALL ASKED FOR, asked of the hand. It used to ask for
                        // the whole file and page whatever came back, and what came back was
                        // cut at 512 KiB -- so `src/tools.rs` read as 9,304 lines of 21,276,
                        // and the offset it named to continue from was a place the answer could
                        // not reach. `dev/BLOCKERS.md` B18.
                        let (from, _) = read_ask(args_json);
                        let got = res!(machine_op("file_read", "read", &abs, &cwd, &spec,
                            &ctx.no_write, &read_fields(args_json), ctx.host()).await);
                        let text = match got {
                            Ok(t)    => t,
                            Err(why) => {
                                // Nothing there is this agent's view of the path now (RD2).
                                if hand_said_absent(&why) {
                                    lock_cache(&ctx.read_seen).seen.remove(&at, &path);
                                }
                                return Err(err!("{}", why; IO, File, Read));
                            },
                        };
                        let read = res!(machine_read(&text));
                        // Recorded only where the window IS the file. A hash taken over one
                        // page of a file and filed under the file's name is what would later
                        // tell a `file_write` that "another agent changed it" about a file
                        // nobody had touched.
                        //
                        // The file's own bytes, as `machine_before` gives them to the write
                        // guard, not the body as the wire carried it: the hand ends a last line
                        // that has no newline with one, and a hash of that would refuse every
                        // write to such a file as changed.
                        if from == 1 && read.held >= read.lines {
                            if let (Some(b), _) = machine_body(&read) {
                                lock_cache(&ctx.read_seen).seen.insert(&at, &path, content_hash(&b));
                            }
                        }
                        let win = Window { lines: read.lines, bytes: read.bytes, from };
                        return Ok(MessageContent::text(Self::mark_if_from(ctx, &raw, stranger,
                            Self::read_view_of(args_json, &raw, stranger, read.body, Some(win)))));
                    },
                    Reach::Storage => (),
                }
                let mut at = stored_in(ctx, &path);
                let read = ctx.host().fs().read_file(ctx.root, &path).await;
                // A file the device does not hold is not a missing file: the workspace is one set
                // of files, and this one is in cloud storage. Saying so plainly, with its size, is
                // what lets the agent decide whether it is worth the transfer -- a generic "cannot
                // read" would send it hunting for a file that is exactly where it should be.
                let mut fetched: Option<u64> = None;
                let mut read = read;
                if read.is_err() {
                    if let Some(size) = ctx.host().fs().cloud_size_of(&path) {
                        // A SMALL ONE IS FETCHED RATHER THAN REFUSED. The workspace is one set of
                        // files and which device holds the bytes is Daimond's business, not the
                        // model's: a refusal here cost a round to be told, a round to call
                        // file_fetch and a round to read again, for a transfer the read was going
                        // to make anyway. Bounded three ways -- the ceiling below, one fetch per
                        // call, and the 128 MiB/10 min agent allowance `fetchDown` already holds.
                        if size <= AUTO_FETCH_MAX {
                            res!(ctx.host().fs().cloud_fetch(&path).await);
                            at = stored_in(ctx, &path);
                            read = ctx.host().fs().read_file(ctx.root, &path).await;
                            fetched = Some(size);
                        } else {
                            return Err(err!(
                                "file_read: '{}' is in cloud storage, not on this device. It is \
                                {} bytes, above the {} KiB a read fetches for itself. Use \
                                file_fetch to bring it here first.", path, size,
                                AUTO_FETCH_MAX / 1024; IO, File, Read, Missing));
                        }
                    }
                }
                // A DIRECTORY, SAID AS A DIRECTORY -- the browser's half of a sentence that
                // existed only in the native one.  The OPFS edge answers a read of a folder with
                // the browser's own words, `JsValue(TypeMismatchError: The path supplied exists,
                // but was not an entry of requested type. undefined)`, and a daimon that met that
                // on 2026-08-24 spent three calls working out what it meant.  The native
                // `file_read` has named `file_list` here since `f064764`; the product did not,
                // and that is exactly the shape a native probe cannot see -- `dev/reflux.mjs`
                // found it on its first outing.
                //
                // Asked of OPFS rather than matched against the exception's name: a listing that
                // SUCCEEDS is the proof that the path is a directory, and it costs one call on a
                // path that has already failed.
                if read.is_err()
                    && ctx.host().fs().list_dir(ctx.root, &path).await.is_ok()
                {
                    return Err(err!(
                        "file_read: '{}' is a directory, not a file. file_list answers what is \
                        in it, and file_search looks inside everything under it.", raw;
                        Invalid, Input));
                }
                // A READ THAT FINDS NOTHING is this agent's view of the path now (RD2): it is the
                // read the stale-read guard's refusal of a deleted file asks for.
                if read.is_err() {
                    Self::read_found_nothing(ctx, &at, &path).await;
                }
                // WHICH FILESYSTEM WAS LOOKED IN, said at the moment the two part company.
                //
                // Everything above has been ruled out: not in cloud storage, and not a
                // directory either, since the listing that would have proved it failed too.
                // What is left is a path browser storage does not hold -- which the browser
                // says in its own words, `JsValue(NotFoundError: …)`, an envelope addressed to
                // a developer that carries no clue about the second place at all. It is
                // REPLACED rather than annotated: leaving the exception in front of the
                // sentence is what `error_line`'s own note is about, and `dev/reflux.mjs`'s
                // `framed` catches a `JsValue(` wherever it appears.
                if read.is_err() {
                    if let Some(note) = two_places_note(&raw, Absence::Missing, ctx.host()) {
                        return Err(err!("file_read: {}", note; IO, File, Read, Missing));
                    }
                    // ONE FILESYSTEM, so the miss is about the ROOT the path was spelled against.
                    // Without this the arm fell through to `res!(read)` and handed the model the
                    // browser's own `JsValue(NotFoundError: …)`.
                    if let Some(note) = wrong_root_note(ctx, &raw, &path).await {
                        return Err(err!("file_read: {}", note; IO, File, Read, Missing));
                    }
                }
                let bytes = res!(read);
                // Remember what was seen here, and where, so a later write can tell if the
                // file moved underneath this agent.
                lock_cache(&ctx.read_seen).seen.insert(&at, &path, content_hash(&bytes));
                // Before the binary test, so a PNG becomes an image and an MP3 still becomes the
                // refusal. The path recorded on the part is the one the model wrote, because that
                // is the one it must use to read the file again after an elision.
                let want = Want::read(args_json);
                // BASE64 IS ASKED FOR, SO IT IS ANSWERED, WHATEVER THE FILE IS.
                //
                // This used to be reachable only through the image branch or the binary refusal
                // below, so a caller that asked for base64 on anything TEXT-shaped had the
                // argument silently discarded and got the file's text instead. An SVG is text.
                // A daimon asked to put a book's cover on a crystal page found the cover was an
                // SVG, asked for base64, was handed markup, and -- reasoning correctly from a
                // wrong premise -- renamed the file to `.png` to try to force the issue. That
                // failed too, and rightly: the sniff reads bytes, not extensions. It spent a
                // turn defeated by an argument this tool had accepted and thrown away.
                // A BMP, TIFF, HEIC or icon becomes a PNG or JPEG here, for both an attachment
                // and a data: URI, since neither a model nor a page's <img> takes most of them.
                if let Some(got) = converted_picture(&raw, &bytes) {
                    let (media, common) = res!(got);
                    return image_result(ctx, &raw, media, common, want);
                }
                if let Want::Base64 = want {
                    let mime = match ImageMedia::sniff(&bytes) {
                        Some(m) => m.mime(),
                        // A `.svg` is the case that started this, and it is worth naming
                        // properly: it is the one image format that needs no data: URI at all,
                        // because it is markup and goes into a page as itself.
                        None if looks_like_svg(&bytes) => "image/svg+xml",
                        None if is_binary(&bytes)      => "application/octet-stream",
                        None                           => "text/plain",
                    };
                    return base64_result(ctx, &raw, mime, bytes);
                }
                if let Some(media) = ImageMedia::sniff(&bytes) {
                    return image_result(ctx, &raw, media, bytes, want);
                }
                // Before the binary refusal, because an Office document IS binary and refusing it
                // was the whole complaint: `Media` has named these formats correctly all along and
                // nothing could read one. Most people's documents are in them.
                // An early return leaves this function rather than the match, so it carries the
                // content type the function answers with rather than the string the match yields.
                if let Some(got) = office_view(&raw, &bytes) {
                    let (md, note) = res!(got);
                    return Ok(MessageContent::text(Self::mark_if_from(
                        ctx, &raw, ws_stranger(ctx, &raw, &path),
                        fmt!("{}{}", Self::read_view(args_json, &raw, &md), note))));
                }
                // A PDF is TEXT to the model, even where its pages are pictures. This used to
                // drop to the binary refusal below, so a daimon told the user Daimond could not
                // read PDFs -- the second half of the same defect `file_show` closes. Now the
                // text layer is lifted for free where there is one, OCR'd where there is not,
                // and the words come back windowed like any file's -- the pixels never enter
                // the turn. Detected on the magic bytes, so a `.pdf` that is not one still falls
                // through rather than paying for a parse of nothing.
                if Media::sniff(&bytes) == Media::Pdf {
                    return Self::pdf_read(ctx, &raw, ws_stranger(ctx, &raw, &path), args_json, &bytes).await;
                }
                // Checked after the cloud case, which has no bytes to test.
                if is_binary(&bytes) {
                    // A caller that asked for base64 asked for BYTES, and a font, an icon or a
                    // sound is as embeddable as a picture. The refusal is for a caller that
                    // expected text and would be handed mojibake.
                    if let Want::Base64 = want {
                        return base64_result(ctx, &raw, "application/octet-stream", bytes);
                    }
                    return Err(binary_refusal(&path, bytes.len()));
                }
                let s = String::from_utf8_lossy(&bytes).to_string();
                // The whole file is hashed above and the whole file is what a later write is
                // checked against; only the VIEW is windowed. A page is a page of what is there.
                //
                // The path is tested as the model wrote it, the same way the bounds are, so a
                // Diamond prefix cannot spell a mail file into an ordinary one.
                // Judged where it lands under the workspace root too (U10): on the runner the
                // workspace is the home, so `Downloads/x` is a stranger's.
                let stranger = ws_stranger(ctx, &raw, &path);
                let view = Self::mark_if_from(ctx, &raw, stranger,
                    Self::read_view_of(args_json, &raw, stranger, &s, None));
                // SAID, BECAUSE IT COST THE USER MONEY. The fetch was made on the model's behalf
                // and without being asked for, so the result says it happened and that the file is
                // here now -- otherwise a turn that reads the same file twice has no way to know
                // the second read was free.
                Ok(match fetched {
                    Some(n) => fmt!("(fetched {} bytes from cloud storage; it is on this device \
                        now)\n{}", n, view),
                    None    => view,
                })
            }
            Tool::FileEdit => return Self::file_edit_page(args_json, ctx).await,
            Tool::FileRevert => {
                let raw  = res!(Self::arg(args_json, "path"));
                let path = res!(Self::scoped(ctx, &raw));
                let lic = match ctx.licence(&path) {
                    Ok(l)    => l,
                    Err(why) => return Ok(MessageContent::text(why)),
                };
                let dia  = match ctx.keeper() {
                    Some(d) => d,
                    None    => return Ok(MessageContent::text(refusal_line(
                        "file_revert puts back a file a turn changed, and this call is not \
                        part of one: nothing here keeps copies."))),
                };
                let at = extract_json_number(args_json, "version");
                // THE CRYSTAL'S TWO FILES KEEP THE CRYSTAL CHAIN, not rows in the store, so the
                // store never had a copy of them and every revert of the page the daimon had just
                // written said so (fix 7, 2026-10-09). They go back from the chain; the turn's
                // end records what lands as a version of its own, so this is undoable too.
                if let Some(half) = ctx.host().store().crystal_half(&dia, &path) {
                    // BOUND TO A READ MADE BEFORE THE TARGET IS JUDGED (QA2, A2 LOW 1), as every
                    // other revert arm is: a half that will not read is refused, and one changed
                    // after this read -- so after the store judged it -- is not written over.
                    let stood = match Self::before_bytes(ctx, &path).await {
                        Ok(b)    => b,
                        Err(why) => return Ok(MessageContent::text(refusal_line(&fmt!(
                            "'{}' would not read ({}), so it was not put back.", raw, why)))),
                    };
                    let seen = crate::diamond_versions::Seen::of(stood.as_deref());
                    let (n, text) = match res!(ctx.host().store().crystal_undo_target(
                        &dia, half, at).await)
                    {
                        Some(t) => t,
                        None    => return Ok(MessageContent::text(refusal_line(&fmt!(
                            "'{}' has no earlier version to go back to: Daimond's history of it \
                            starts where it stands now.", raw)))),
                    };
                    if res!(ctx.host().fs().write_licensed_if(ctx.root, &lic, text.as_bytes(),
                        &seen).await).is_some()
                    {
                        return Ok(MessageContent::text(refusal_line(&fmt!(
                            "'{}' changed while its earlier version was being found, so it was \
                            not put back. Read it again, then revert.", raw))));
                    }
                    lock_cache(&ctx.read_seen).seen.insert(&stored_in(ctx, &path), &path,
                        content_hash(text.as_bytes()));
                    let shipped = if text.is_empty() && half == crate::engine::host::types::store::CrystalHalf::Page {
                        " (no page of its own: the Diamond shows the page Daimond ships)"
                    } else {
                        ""
                    };
                    return Ok(MessageContent::text(fmt!("Put {} back to how it stood at version \
                        {}: {} bytes{}.", raw, n, text.len(), shipped)));
                }
                // WHICH FILESYSTEM, asked once and before anything -- because it decides both
                // where the file is written and what the store knows the file BY: a file on this
                // computer is recorded under its absolute path.
                let reach = reach_of(ctx, &raw, &path, Door::Change).await;
                // A machine path the hand cannot change is refused BEFORE its history is looked
                // up, since the history knows a machine file by the absolute path only a reach
                // names: asked later, the lookup missed and the model was told there was no copy.
                if let Reach::Refuse(why) = &reach {
                    return Ok(MessageContent::text(refusal_line(why)));
                }
                let known = match &reach {
                    Reach::Machine { abs, .. } => abs.clone(),
                    _                          => path.clone(),
                };
                // Where the file is, for what this agent saw of it, taken before any I/O.
                let in_storage = match &reach {
                    Reach::Machine { root, .. } => Storage::Machine(root.clone()),
                    _                           => stored_in(ctx, &path),
                };
                let target = res!(ctx.host().store().versions_undo_target(
                    &dia, &known, at).await);
                let (from, hash, _, folder) = match target {
                    Some(t) => t,
                    None    => return Ok(MessageContent::text(refusal_line(&fmt!(
                        "There is no kept copy of '{}' to go back to. Daimond keeps what it \
                        changed itself, from the moment it changed it -- so a file changed \
                        outside Daimond, one nothing has changed yet, and one too large to keep \
                        all have nothing earlier here. Say so rather than writing a guess at \
                        what it used to say.", raw)))),
                };
                let body = match res!(ctx.host().store().versions_body(&dia, &hash).await) {
                    Some(b) => b,
                    None    => return Ok(MessageContent::text(refusal_line(&fmt!(
                        "The earlier copy of '{}' is not on this device -- it is on whichever \
                        one made it, and the next full sync from there brings it.", raw)))),
                };
                // THE BYTES THIS IS ABOUT TO REPLACE, so the version below can carry them and
                // the revert is itself revertible. Read the same way the write door reads them,
                // through the hand where the file is on the machine.
                let (before, refused) = match &reach {
                    Reach::Machine { abs, cwd, root: _, spec } =>
                        machine_before(abs, cwd, spec, &ctx.no_write, ctx.host()).await,
                    _ => match Self::before_bytes(ctx, &path).await {
                        Ok(b)    => (b, None),
                        Err(why) => (None, Some(why)),
                    },
                };
                // What stands there now could not be kept, so the revert could not be undone.
                if let (None, Some(why)) = (&before, &refused) {
                    return Ok(MessageContent::text(overwrite_unkept_refusal(&raw, why)));
                }
                // THE WRITE IS BOUND TO THAT READ (U3a RMW2): the question below may wait on the
                // person, and a save landing meanwhile is refused, not written over and kept
                // nowhere.
                let bound = WriteBound::Kept(crate::diamond_versions::Seen::of(before.as_deref()));
                // ONLY INTO THE FILE ITS ROW WAS WRITTEN FROM (HR, 2026-09-25), by the rule a
                // History restore follows: a relative path is one file only with its folder.
                let overwrites = matches!(&before, Some(b) if *b != body);
                match ctx.host().store().route_here(&known, folder.as_deref(), &known, overwrites) {
                    crate::diamond_versions::Route::Go   => {},
                    crate::diamond_versions::Route::Left => return Ok(MessageContent::text(
                        refusal_line(&fmt!("The kept copy of '{}' was written in a different \
                        folder from the one open now, so the file here is another file of the \
                        same name, and it was left as it is. Say so rather than writing it back \
                        over a stranger.", raw)))),
                    crate::diamond_versions::Route::Ask(crate::diamond_versions::Unplaced::Unrecorded) =>
                        return Ok(MessageContent::text(refusal_line(&fmt!("The kept copy of '{}' \
                        was made before Daimond recorded which folder it came from, and a \
                        different file stands there now. Nothing was changed. The person can put \
                        it back from the Diamond's History, which asks them first.", raw)))),
                    crate::diamond_versions::Route::Ask(crate::diamond_versions::Unplaced::Unknown) =>
                        return Ok(MessageContent::text(refusal_line(&fmt!("The kept copy of '{}' \
                        was recorded in a folder this device does not know -- one on another \
                        device, or one Daimond no longer knows -- and a different file stands \
                        there now. Nothing was changed. The person can put it back from the \
                        Diamond's History, which asks them first.", raw)))),
                }
                // A REVERT IS A WRITE LIKE ANY OTHER, and one that leaves less than half of what
                // stands there -- a file put back to an empty or unrelated state -- is asked about
                // and held as a delete is. The hold is given back once the record below is written,
                // which carries the copy itself.
                let over = match Self::before_overwrite(ctx, &dia, &known, &raw, before.as_deref(),
                    Some(&body), true).await
                {
                    Ok(o)    => Some(o),
                    Err(why) => return Ok(MessageContent::text(why)),
                };
                let (before, wiped) = Overwrite::prior(&over, before);
                let (landed, mark) = match reach {
                    Reach::Refuse(why) => return Ok(MessageContent::text(refusal_line(&why))),
                    Reach::Machine { abs, cwd, root, spec } => {
                        // The wire carries text, so bytes that are not text cannot go down it --
                        // and writing them lossily would be corruption wearing the name of a
                        // restore.
                        let text = match std::str::from_utf8(&body) {
                            Ok(t)  => t.to_string(),
                            Err(_) => return Ok(MessageContent::text(refusal_line(&fmt!(
                                "The kept copy of '{}' is not text, and a file on this computer \
                                is written through the hand, which carries text. Restore it from \
                                the Diamond's History instead.", raw)))),
                        };
                        // HIS FILE, ASKED ABOUT (UNBLOCK-26 U3): under the marks as they stand now, and only
                        // over the text he was shown.
                        let (lic, bound) = match Self::machine_bound(ctx, &lic, &over).await {
                            Ok(Some((l, b))) => (l, b),
                            Ok(None)    => (lic, bound),
                            Err(why)    => {
                                Self::overwrite_failed(&over, ctx.host()).await;
                                return Ok(MessageContent::text(why));
                            },
                        };
                        let got = match machine_change("file_revert",
                            machine_write(false, &lic, &text, &crate::diamond_versions::Seen::Unread,
                                Some(&bound)), &root, &cwd, &spec, &ctx.no_write, ctx.host()).await
                        {
                            Ok(g)  => g,
                            Err(e) => { Self::overwrite_failed(&over, ctx.host()).await; return Err(e); },
                        };
                        if let Err(why) = got {
                            Self::overwrite_failed(&over, ctx.host()).await;
                            if let Some(said) = bound.hand_refusal("file_revert", &raw, &why) {
                                return Err(err!("{}", said; Invalid, Input, Mismatch));
                            }
                            return Err(err!("{}", why; IO, File, Write));
                        }
                        // What this agent last saw is what it just wrote, as in storage below.
                        lock_cache(&ctx.read_seen).seen.insert(&in_storage, &path, content_hash(&body));
                        (abs, true)
                    },
                    Reach::Storage => {
                        match Self::write_over(ctx, &lic, "file_revert", &raw, &body, &over,
                            Some(&bound), None).await
                        {
                            Ok(Ok(_))     => {},
                            Ok(Err(why))  => {
                                Self::overwrite_failed(&over, ctx.host()).await;
                                return Ok(MessageContent::text(why));
                            },
                            Err(e)        => { Self::overwrite_failed(&over, ctx.host()).await; return Err(e); },
                        }
                        // This agent has just changed the file, so what it last saw of it is
                        // what it just wrote -- otherwise its own next write meets the
                        // "changed on disk since you read it" guard over its own revert.
                        lock_cache(&ctx.read_seen).seen.insert(&in_storage, &path, content_hash(&body));
                        // A MARK AS THE WRITE DOOR RECORDS ONE (`stored_is_mark`): a file in the
                        // user's folder restored later goes back through the fence and the marks
                        // of the moment, whichever door wrote the row it is restored from.
                        (path.clone(), stored_is_mark(&dia, &path))
                    },
                };
                let note = fmt!("file_revert {}", raw);
                let recorded = ctx.host().store().versions_record(
                    &dia, crate::diamond_versions::Cause::Restore, "", &note,
                    crate::diamond_versions::Change {
                        path:    landed.clone(),
                        after:   crate::diamond_versions::Body::Held(body.clone()),
                        before: before.map(crate::diamond_versions::Prior::Held),
                        found:   crate::diamond_versions::Found::Unread,
                        carried: None,
                        mark,
                        refused,
                        wiped,
                        folder:  None,
                        by:      ctx.by.clone(),
                        door:    false,
                    }).await;
                // The record carries the copy now, so the hold's note would be a second one: the
                // reservation and the note go, and the open folder's count stays with the turn.
                if let Some(o) = &over {
                    Self::let_go(&o.held, ctx.host()).await;
                }
                let recorded = res!(recorded);
                let kept = match recorded {
                    Some((v, _)) => fmt!(" What was there is kept as version {}.", v),
                    None         => String::new(),
                };
                Ok(fmt!("Put {} back to how it stood before version {}: {} bytes.{}",
                    raw, from, body.len(), kept))
            }
            Tool::FileList => {
                let raw = extract_json_string(args_json, "path").unwrap_or_else(|| ".".to_string());
                let path = res!(Self::scoped(ctx, &raw));
                // THE MACHINE, WHERE THE PATH IS UNDER A MARK. `file_search` and `file_glob` are
                // NOT routed and that is a stated limit rather than an oversight: both walk a
                // whole tree with `Err(_) => continue`, so making them reach the machine is a
                // walk over the wire, and `dev/HATES.md` carries it as the next piece of work.
                match reach_of(ctx, &raw, &path, Door::Look).await {
                    Reach::Refuse(why) => return Ok(MessageContent::text(refusal_line(&why))),
                    Reach::Machine { abs, cwd, root: _, spec } => {
                        let got = res!(machine_op("file_list", "list", &abs, &cwd, &spec,
                            &ctx.no_write, "", ctx.host()).await);
                        // THE BOUND, PER ENTRY, ON THIS SIDE OF A MARK TOO (WALK check D3): the
                        // door is `may_walk`, so the hand's answer is filtered as storage's is.
                        let got = got.map(|t| machine_in_bounds(ctx, &raw, &t));
                        return match got {
                            Ok((t, hidden)) if t.trim().is_empty() && hidden > 0 =>
                                Ok(MessageContent::text(list_hidden_note(hidden))),
                            Ok((t, _)) if t.trim().is_empty() =>
                                Ok(MessageContent::text(fmt!("{} is empty.", abs))),
                            // THE HOST, ON EVERY ENTRY. The hand answers with bare names and
                            // `name/` for a directory, which is indistinguishable from browser
                            // storage's answer -- and the two are different places with different
                            // rules. The annotation goes inside the parentheses the page's readers
                            // already parse, never on a line of its own.
                            Ok((t, hidden)) => {
                                let mut out = machine_listed(&t, &host_name(ctx.host()).await);
                                if hidden > 0 {
                                    out.push_str(&list_hidden_note(hidden));
                                }
                                Ok(MessageContent::text(out))
                            },
                            Err(why) => Err(err!("{}", why; IO, File, Read)),
                        };
                    },
                    Reach::Storage => (),
                }
                // What is in cloud storage is part of the workspace, so it belongs in the
                // listing -- a directory that holds nothing but cloud-only files is not empty,
                // and a directory that exists only in cloud storage still lists.
                let cloud = ctx.host().fs().children_of(&path);
                let listed = ctx.host().fs().list_dir(ctx.root, &path).await;
                let on_disk = match listed {
                    Ok(e)                          => e,
                    Err(_) if !cloud.is_empty()    => Vec::new(),
                    // A folder browser storage does not hold at all, as opposed to one it holds
                    // and finds nothing in. Two different answers, and the browser's exception
                    // gives neither: it names a directory that could not be opened and says
                    // nothing about where it was looked for.
                    Err(e) => match two_places_note(&path, Absence::Missing, ctx.host()) {
                        Some(note) => return Err(err!("file_list: {}", note;
                            IO, File, Read, Missing)),
                        // NO SECOND FILESYSTEM, so the miss is about the ROOT the path was
                        // spelled against -- the largest bucket of tool failures on the bank.
                        // `e` is the browser's own `JsValue(NotFoundError: …)` and must never
                        // reach a model; see `not_in_workspace_said`.
                        None       => match wrong_root_note(ctx, &raw, &path).await {
                            Some(note) => return Err(err!("file_list: {}", note;
                                IO, File, Read, Missing)),
                            None       => return Err(e),
                        },
                    },
                };
                // `(name, is_dir, size, in_cloud)` -- the flag is what tells the agent which
                // entries it must fetch before it can read them.
                let mut entries: Vec<(String, bool, u64, bool)> = on_disk.into_iter()
                    .map(|(n, d, s)| (n, d, s, false))
                    .collect();
                for (name, is_dir, size) in cloud {
                    if entries.iter().any(|(n, _, _, _)| *n == name) {
                        continue; // already here on disk; the resident copy is the one to report
                    }
                    // THE FLAG IS ON THE DIRECTORY TOO. It used to be `!is_dir`, so a folder that
                    // exists only in cloud storage listed as a plain `name/` and read as though
                    // it were on this device.
                    entries.push((name, is_dir, size, true));
                }
                // Dirs first, then by name — matching the native ordering.
                entries.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
                // THE BOUND, PER ENTRY (UNBLOCK-16 WALK): the door let the listing start at a
                // folder that only HOLDS a grant, so what is shown is what may be read or walked.
                // Spelled as the model spelled the folder, which is what the fence works in.
                let hidden = {
                    let before = entries.len();
                    entries.retain(|(n, d, _, _)| ctx.may_list(&list_child(&raw, n), *d));
                    before - entries.len()
                };
                if entries.is_empty() && hidden > 0 {
                    return Ok(MessageContent::text(list_hidden_note(hidden)));
                }
                if entries.is_empty() {
                    // The answer stands -- this folder really is empty in browser storage --
                    // and it is the READING of it that had to be fixed. `webgrant is empty.`
                    // was what stopped a daimon on 2026-08-24 in front of a folder holding
                    // eighteen thousand lines of this file.
                    //
                    // THE FIRST LINE IS UNCHANGED, and that is not tidiness. Two page-side
                    // readers decide a directory is empty by the WORDS of this answer --
                    // `parseListing` in the Work panel and `parseSyncListing` in the census
                    // -- and a reader that does not recognise it turns every line into an
                    // entry. The census one is the dangerous half: a phantom file in a
                    // complete census is what the other device reads as a real file, and
                    // `dev/verify_refusedpath.mjs` is the write-up of the last time a
                    // listing's text was read for a fact. So the note goes on a SECOND line,
                    // and both readers were moved from the end of the text to the first line.
                    if let Some(note) = two_places_note(&path, Absence::Empty, ctx.host()) {
                        return Ok(MessageContent::text(fmt!("{} is empty.\n{}", path, note)));
                    }
                    return Ok(MessageContent::text(fmt!("{} is empty.", path)));
                }
                // THE ROOT IS THE ONLY LISTING THE STORE NOTES BELONG IN. Deeper down
                // `diamonds` is a folder like any other and a second account of it would be paid
                // for on every listing of every turn.
                let at_root = normalise(&path).is_empty();
                let mut out = String::new();
                for (name, is_dir, size, in_cloud) in entries {
                    // A cloud-only DIRECTORY used to lose the flag: the old arm printed `name/`
                    // for anything `is_dir` and the annotation only ever reached files, so a
                    // folder that exists nowhere but in cloud storage listed as though it were
                    // here.
                    let child = if at_root {
                        name.clone()
                    } else {
                        fmt!("{}/{}", normalise(&path), name)
                    };
                    // The cloud index holds files and not the directories they imply, so a
                    // cloud-only directory is known by the flag the merge above set and by
                    // nothing else; everything else is `where_of`'s to decide.
                    let w = if in_cloud {
                        Where::Cloud
                    } else {
                        where_of(&ctx.no_write, &child, two_places(ctx.host()), None)
                    };
                    out.push_str(&listing_line(&name, is_dir, size, w, at_root, ""));
                }
                if hidden > 0 {
                    out.push_str(&list_hidden_note(hidden));
                }
                Ok(out)
            }
            Tool::Outline => Self::outline(args_json, ctx).await,
            Tool::Serve   => Self::serve(args_json, ctx).await,
            Tool::FileSearch => {
                let query = res!(Self::arg(args_json, "query"));
                // The turn's marks when the call did not name a place: see `walk_starts`.
                let starts = walk_starts(args_json, ctx);
                let raw = starts_named(&starts);
                // Strip the Diamond prefix from reported paths so results are
                // Diamond-relative and round-trip back through `file_read`.
                // Normalised, so the prefix `scoped` joined with is the prefix stripped back off.
                let strip = {
                    let p = normalise(&ctx.path_prefix);
                    if p.is_empty() { String::new() } else { fmt!("{}/", p) }
                };
                let opts = res!(search_opts(args_json));
                let mut trusted: Vec<String> = Vec::new();
                // Match lines from under `mail/`, which are a stranger's words and go in an
                // envelope rather than in among the user's own files.
                let mut untrusted: Vec<String> = Vec::new();
                let mut stats = SearchStats::default();
                // THE MACHINE, WHERE EVERY START IS UNDER A MARK. The hand walks the tree and
                // sends back the text of the files its pattern matched; `scan_file` below is
                // the SAME call the browser-storage walk makes, over those files, so the
                // context lines, the paging, the envelope and the notes are composed once.
                // What the machine half of the walk left behind, merged into the report at
                // the end: a walk that stopped on one filesystem stopped, whatever the other
                // one managed.
                let mut starts = starts;
                let mut machine_stop: Option<String> = None;
                let mut machine_queued = 0usize;
                let mut residue = String::new();
                // Whether NO part of this walk reached the machine, which is the only state in
                // which an empty answer is browser storage speaking alone: see `walked_here`.
                let mut all_in_storage = false;
                // Directories and files the browser-storage walk below could not open. Counted
                // rather than skipped in silence, which is `dev/BLOCKERS.md` B1.
                let mut unopened = 0usize;
                let mut unread   = 0usize;
                match walk_reach(ctx, &starts).await {
                    WalkReach::Refuse(why) =>
                        return Ok(MessageContent::text(refusal_line(&why))),
                    WalkReach::Machine { abs, rest: elsewhere, cwd, root, spec } => {
                        let skip: Vec<String> = opts.walk.passed_over()
                            .iter().map(|d| fmt!("\"{}\"", json_escape(d))).collect();
                        let paths: Vec<String> = abs.iter()
                            .map(|p| fmt!("\"{}\"", json_escape(p))).collect();
                        // THE PREFIX THE GLOB IS WRITTEN AGAINST. A model writes
                        // `www/i18n/en.js`; on this machine the file is
                        // `<root>/<prefix>/www/i18n/en.js`, and a glob matched against the
                        // second excludes every file there is -- measured on this door's
                        // first live run, three searches answering "No matches" with "804
                        // file(s) the glob excluded" beside them. It is the same prefix
                        // `machine_rel` takes back off a result, so the two cannot drift.
                        let base = fmt!("{}{}", root.trim_end_matches('/'),
                            if strip.is_empty() {
                                String::new()
                            } else {
                                fmt!("/{}", strip.trim_end_matches('/'))
                            });
                        let fields = fmt!(
                            r#","paths":[{}],"query":"{}","ci":{},"glob":"{}","base":"{}","skip":[{}],"budget":{},"cap":{}"#,
                            paths.join(","),
                            json_escape(&opts.src),
                            opts.ci,
                            json_escape(&match &opts.glob_src { Some(g) => g.clone(), None => String::new() }),
                            json_escape(&base),
                            skip.join(","),
                            WALK_ENTRIES_MAX,
                            SEARCH_MACHINE_MAX_FILE,
                        );
                        let got = res!(machine_op("file_search", "search", &abs[0], &cwd, &spec,
                            &ctx.no_write, &fields, ctx.host()).await);
                        let answer = match got {
                            Ok(t)    => t,
                            Err(why) => return Err(err!("{}", why; IO, File, Read)),
                        };
                        let (head, mut rest) = res!(walk_head(&answer));
                        stats.skipped  = head.skipped;
                        stats.filtered = head.filtered;
                        stats.too_big  = head.too_big;
                        stats.binary   = head.binary;
                        stats.files    = head.files;
                        // Each file arrives as `<path>\t<byte length>` and then exactly that
                        // many bytes of its MATCHING LINES, each with the number it has in the
                        // file. Length-prefixed and not delimited, because a line of a file
                        // holds every character a delimiter could have been -- and the lines
                        // rather than the file because a 1.2 MB file will not cross a 384 KiB
                        // wire and no narrowing a caller can write makes one file smaller:
                        // `dev/BLOCKERS.md` B17.
                        while !rest.is_empty() {
                            let (line, after) = match rest.split_once('\n') {
                                Some(p) => p,
                                None    => break,
                            };
                            let (raw_path, len) = match line.rsplit_once('\t') {
                                Some(p) => p,
                                None    => break,
                            };
                            let len: usize = match len.parse() {
                                Ok(n)  => n,
                                Err(_) => break,
                            };
                            if after.len() < len {
                                break;
                            }
                            let block = &after[..len];
                            rest = &after[len..];
                            let disp = machine_rel(&root, raw_path, &strip);
                            // The bound, per file, exactly as the browser-storage walk makes
                            // it: the fence has already refused what a command could not
                            // reach, and this is the app's own rule over what is left.
                            if !ctx.may_read(&disp) {
                                stats.refused += 1;
                                continue;
                            }
                            let out = if is_untrusted_path(&disp) {
                                &mut untrusted
                            } else {
                                &mut trusted
                            };
                            let held = res!(machine_lines(block));
                            if !res!(scan_file(&opts, &ctx.workspace.shown(&disp), &held, &mut stats, out)) {
                                break;
                            }
                        }
                        machine_stop = head.stop.map(|d| machine_rel(&root, &d, &strip));
                        machine_queued = head.queued;
                        residue = walk_residue("file_search", head.left, head.denied);
                        // Whatever was not on the machine is walked below by the machinery that
                        // already knows how, and the two halves meet in one report.
                        starts = elsewhere;
                    },
                    WalkReach::Storage => all_in_storage = true,
                }
                // The bound on the WALK: see the native arm.  It matters most here, where every
                // entry costs a round trip into the browser's own filesystem.
                let mut budget = WalkBudget::new();
                // Reversed so the first mark is popped first, as on the native arm.
                let mut stack: Vec<String> = Vec::new();
                for st in starts.iter().rev() {
                    stack.push(res!(Self::scoped(ctx, st)));
                }
                'walk: while let Some(dir) = stack.pop() {
                    let (dir, mut entries) = match ctx.host().fs().list_dir(ctx.root, &dir).await {
                        Ok(e)  => (dir, e),
                        // NOT the same as a directory holding nothing, and until 2026-08-25 this
                        // arm could not tell the reader which it had met. A start on the machine
                        // that browser storage does not hold fails here on the first turn of the
                        // walk, and the search then answered "No matches" about a tree it had
                        // never opened.
                        //
                        // A START THAT IS A FILE is searched as that file, walked as its folder
                        // holding only it: see the native arm (finding 4, 2026-10-08).
                        Err(_) => {
                            let (up, leaf) = match dir.rfind('/') {
                                Some(i) => (dir[..i].to_string(), dir[i + 1..].to_string()),
                                None    => (String::new(), dir.clone()),
                            };
                            let hit = match ctx.host().fs().list_dir(ctx.root, &up).await {
                                Ok(es) => es.into_iter().find(|(n, d, _)| !*d && *n == leaf),
                                Err(_) => None,
                            };
                            match hit {
                                Some(e) => (up, vec![e]),
                                None    => { unopened += 1; continue; },
                            }
                        },
                    };
                    let here = if strip.is_empty() {
                        dir.clone()
                    } else {
                        dir.strip_prefix(&strip).unwrap_or(dir.as_str()).to_string()
                    };
                    // Name order, so the walk is repeatable and `offset` can page it honestly.
                    entries.sort_by(|a, b| a.0.cmp(&b.0));
                    for (name, is_dir, _) in entries.iter().rev() {
                        if *is_dir {
                            if !budget.spend(&here) {
                                break; // out of budget: stop growing the walk, and stop below
                            }
                            if opts.walk.skips(name) {
                                stats.skipped += 1;
                                continue;
                            }
                            stack.push(Self::join_rel(&dir, name));
                        }
                    }
                    for (name, is_dir, size) in &entries {
                        if *is_dir {
                            continue;
                        }
                        if !budget.spend(&here) {
                            break 'walk;
                        }
                        let child = Self::join_rel(&dir, name);
                        let disp = if strip.is_empty() {
                            child.clone()
                        } else {
                            child.strip_prefix(&strip).unwrap_or(child.as_str()).to_string()
                        };
                        // The bound, per file: see the native arm.  `disp` is the path as this
                        // turn's model spells it, which is the spelling `may_read` and `file_read`
                        // both work in, so the two doors cannot disagree about one file.
                        if !ctx.may_read(&disp) {
                            stats.refused += 1;
                            continue;
                        }
                        // The filter is written as the model writes paths, relative to the
                        // folder base, so it is asked of the path as shown too (F2-FIX M3).
                        if let Some(g) = &opts.glob {
                            if !g.matches(&disp) && !g.matches(&ctx.workspace.shown(&disp)) {
                                stats.filtered += 1;
                                continue;
                            }
                        }
                        // NO SIZE CEILING, here or on the native arm: the file is read a
                        // chunk at a time and split into lines as it arrives, so what it costs
                        // is one chunk and a ring of neighbours rather than two copies of
                        // itself.  `_size` is still read off the listing and is now only the
                        // listing's business.
                        let _ = size;
                        let (head, total) = match ctx.host().fs().read_file_range(
                            ctx.root, &child, 0.0, SEARCH_CHUNK_BYTES).await
                        {
                            Ok(p)  => p,
                            // Counted for the same reason as the directory above: a file that
                            // would not open is a file whose contents are unknown, and dropping
                            // it in silence makes the answer read as though it had been searched.
                            Err(_) => { unread += 1; continue; },
                        };
                        // Trimmed to a character boundary: a chunk ends where the read ended,
                        // and an incomplete tail would make every large text file read binary.
                        if is_binary(whole_chars(&head)) {
                            stats.binary += 1;
                            continue;
                        }
                        stats.files += 1;
                        let out = if is_untrusted_path(&disp) {
                            &mut untrusted
                        } else {
                            &mut trusted
                        };
                        let mut src = OpfsLines::new();
                        let shown   = ctx.workspace.shown(&disp);
                        let mut sc  = LineScanner::new(&opts, &shown);
                        let mut off = head.len() as f64;
                        let mut bytes = head;
                        let mut room = true;
                        loop {
                            let eof = bytes.is_empty() || off >= total;
                            src.fill(&bytes, eof);
                            while let Some((n, line)) = res!(src.next_line()) {
                                if !sc.feed(n, &line, &mut stats, out) {
                                    room = false;
                                    break;
                                }
                            }
                            if eof || !room {
                                break;
                            }
                            bytes = match ctx.host().fs().read_file_range(
                                ctx.root, &child, off, SEARCH_CHUNK_BYTES).await
                            {
                                Ok((b, _)) => b,
                                Err(_)     => { unread += 1; break; },
                            };
                            off += bytes.len() as f64;
                        }
                        stats.cut_lines += src.cut();
                        if !sc.finish() {
                            break 'walk;
                        }
                    }
                }
                budget.unwalked(stack.len());
                // A stop on EITHER filesystem is a stop. The browser walk's own budget wins
                // where it ran out, because that is the one this code measured; where it
                // finished and the machine's did not, the machine's is the honest answer.
                if !budget.stopped() {
                    if let Some(d) = machine_stop {
                        budget = WalkBudget::reported(Some(d), machine_queued);
                    }
                }
                if let Some(e) = stopped_empty("file_search", &raw, &budget, stats.matched) {
                    if extract_json_bool(args_json, "all").unwrap_or(false) {
                        return Ok(MessageContent::text(stopped_wide("file_search", &raw)));
                    }
                    return Err(e);
                }
                let mut notes = search_notes(&opts, &stats, &budget, &raw);
                notes.push_str(&unopened_residue("file_search", unopened, unread));
                notes.push_str(&residue);
                // FIRST among the notices, and only under an empty answer, for the reason
                // `search_notes` gives the budget notice the same place: it is the line that
                // changes how the sentence above it is to be read. "No matches" said of the
                // browser's own storage is not "no matches" said of this computer.
                if trusted.is_empty() && untrusted.is_empty() {
                    if let Some(here) = walked_here("file_search", &raw, all_in_storage, ctx.host()) {
                        notes.insert_str(0, &here);
                    }
                }
                Ok(Self::search_output(ctx, &query, trusted, untrusted, &notes, budget.spent()))
            }
            // The times come off the listing itself.  This arm used to declare, in every result,
            // that modification times could not be read -- on the grounds that asking for one
            // would cost a `getFile()` round trip per candidate.  It costs nothing: the listing
            // already opens each file to learn its size, and `lastModified` is on the same
            // handle, so the round trip was being paid and the answer thrown away.
            //
            // Worse, the claim was not even true of the whole call.  With a real folder open, a
            // walk crosses the user's disk AND the sandbox the store is carved back into (see
            // `wasm::opfs::resolve_root`), and a file on disk knows perfectly well when it was
            // written.  So the question is asked per path and answered per path.
            Tool::FileGlob => {
                let pattern = res!(Self::arg(args_json, "pattern"));
                let glob = res!(Glob::new(pattern.trim()).map_err(|e| err!(e,
                    "file_glob: 'pattern' is not a glob this build can read."; Invalid, Input)));
                let starts = walk_starts(args_json, ctx);
                let raw = starts_named(&starts);
                // Normalised, so the prefix `scoped` joined with is the prefix stripped back off.
                let strip = {
                    let p = normalise(&ctx.path_prefix);
                    if p.is_empty() { String::new() } else { fmt!("{}/", p) }
                };
                let all = extract_json_bool(args_json, "all").unwrap_or(false);
                let walk = Skips::new(all, &[&raw, &pattern]);
                let (limit, page) = GlobPage::of(args_json);
                let mut hits: Vec<GlobHit> = Vec::new();
                let mut skipped = 0usize;
                let mut refused = 0usize;
                // THE MACHINE, WHERE A START IS UNDER A MARK. The hand walks and answers
                // paths and times; `glob_output` below is the same call the browser-storage
                // walk makes, so one report is composed in one place. Whatever is NOT on the
                // machine -- a Diamond's own directory always is not -- is walked below.
                let mut starts = starts;
                let mut machine_stop: Option<String> = None;
                let mut machine_queued = 0usize;
                let mut residue = String::new();
                // See the same two lines in `Tool::FileSearch`, and the reasons there.
                let mut all_in_storage = false;
                let mut unopened = 0usize;
                match walk_reach(ctx, &starts).await {
                    WalkReach::Refuse(why) =>
                        return Ok(MessageContent::text(refusal_line(&why))),
                    WalkReach::Machine { abs, rest: elsewhere, cwd, root, spec } => {
                        let skip: Vec<String> = walk.passed_over()
                            .iter().map(|d| fmt!("\"{}\"", json_escape(d))).collect();
                        let paths: Vec<String> = abs.iter()
                            .map(|p| fmt!("\"{}\"", json_escape(p))).collect();
                        // The same prefix a search sends, and for the same reason.
                        let base = fmt!("{}{}", root.trim_end_matches('/'),
                            if strip.is_empty() {
                                String::new()
                            } else {
                                fmt!("/{}", strip.trim_end_matches('/'))
                            });
                        let fields = fmt!(
                            r#","paths":[{}],"query":"{}","base":"{}","skip":[{}],"budget":{}"#,
                            paths.join(","),
                            json_escape(pattern.trim()),
                            json_escape(&base),
                            skip.join(","),
                            WALK_ENTRIES_MAX,
                        );
                        let got = res!(machine_op("file_glob", "glob", &abs[0], &cwd, &spec,
                            &ctx.no_write, &fields, ctx.host()).await);
                        let answer = match got {
                            Ok(t)    => t,
                            Err(why) => return Err(err!("{}", why; IO, File, Read)),
                        };
                        let (head, rest) = res!(walk_head(&answer));
                        skipped = head.skipped;
                        for line in rest.split('\n').filter(|l| !l.is_empty()) {
                            let (raw_path, stamp) = match line.rsplit_once('\t') {
                                Some(p) => p,
                                None    => continue,
                            };
                            let disp = machine_rel(&root, raw_path, &strip);
                            // The bound, per path. `file_glob` reads nothing, and a path is
                            // itself information -- the name of a skill nobody was told about --
                            // so the tool that lists it answers by the rule that opens it.
                            if !ctx.may_read(&disp) {
                                refused += 1;
                                continue;
                            }
                            hits.push(GlobHit {
                                path: ctx.workspace.shown(&disp),
                                // `-` is the platform declining to say, kept as an absence
                                // rather than turned into 1970.
                                when: stamp.parse::<u64>().ok(),
                            });
                        }
                        machine_stop = head.stop.map(|d| machine_rel(&root, &d, &strip));
                        machine_queued = head.queued;
                        residue = walk_residue("file_glob", head.left, head.denied);
                        // AND THEN FALL THROUGH, which the comment above has claimed since this
                        // door was built and the code did not do: this arm composed its report
                        // and RETURNED, so `elsewhere` was dropped on the floor. A scoped
                        // Diamond's marks always include its own directory, which is browser
                        // storage by construction (`walk_reach`), so every default `file_glob`
                        // in a Diamond with a folder attached listed the machine and silently
                        // left out everything the Diamond itself holds -- and the merge below,
                        // `machine_stop`, `machine_queued` and `residue` with it, was dead code
                        // the compiler had been reporting as an unused `elsewhere` all along.
                        starts = elsewhere;
                    },
                    WalkReach::Storage => all_in_storage = true,
                }
                // The bound on the WALK: see the native arm.  This is the arm the unbounded walk
                // was seen on -- a `**` pattern over an open machine folder, one round trip per
                // entry, and a turn that never ended.
                let mut budget = WalkBudget::new();
                // Each directory with the start its walk came from, which a '/' pattern is read
                // against as well as the root ([`glob_hits`]).
                let mut stack: Vec<(String, String)> = Vec::new();
                for st in starts.iter().rev() {
                    let at = res!(Self::scoped(ctx, st));
                    stack.push((at.clone(), at));
                }
                'walk: while let Some((dir, from)) = stack.pop() {
                    let mut entries = match ctx.host().fs().list_dir_stamped(ctx.root, &dir).await {
                        Ok(e)  => e,
                        // See the same arm in `Tool::FileSearch`: a directory that will not open
                        // is not a directory with nothing in it.
                        Err(_) => { unopened += 1; continue; },
                    };
                    let here = if strip.is_empty() {
                        dir.clone()
                    } else {
                        dir.strip_prefix(&strip).unwrap_or(dir.as_str()).to_string()
                    };
                    entries.sort_by(|a, b| a.0.cmp(&b.0));
                    for (name, is_dir, _, when) in &entries {
                        if !budget.spend(&here) {
                            break 'walk;
                        }
                        let child = Self::join_rel(&dir, name);
                        if *is_dir {
                            if walk.skips(name) {
                                skipped += 1;
                                continue;
                            }
                            stack.push((child, from.clone()));
                            continue;
                        }
                        let disp = if strip.is_empty() {
                            child.clone()
                        } else {
                            child.strip_prefix(&strip).unwrap_or(child.as_str()).to_string()
                        };
                        // The bound, per path: see the native arm.
                        if !ctx.may_read(&disp) {
                            refused += 1;
                            continue;
                        }
                        if glob_hits(&glob, &disp, &child, &from) {
                            // Milliseconds from the browser, nanoseconds in the hit, so both arms
                            // sort on one scale and a build's worth of files written in the same
                            // second keeps whatever order the platform can actually distinguish.
                            hits.push(GlobHit {
                                path: ctx.workspace.shown(&disp),
                                when: (*when).map(|ms| (ms as u64).saturating_mul(1_000_000)),
                            });
                        }
                    }
                }
                budget.unwalked(stack.len());
                // A stop on EITHER filesystem is a stop: see the same three lines in
                // `Tool::FileSearch`, and the reason there.
                if !budget.stopped() {
                    if let Some(d) = machine_stop {
                        budget = WalkBudget::reported(Some(d), machine_queued);
                    }
                }
                if let Some(e) = stopped_empty("file_glob", &raw, &budget, hits.len()) {
                    if all {
                        return Ok(MessageContent::text(stopped_wide("file_glob", &raw)));
                    }
                    return Err(e);
                }
                let here = if hits.is_empty() {
                    walked_here("file_glob", &raw, all_in_storage, ctx.host()).unwrap_or_default()
                } else {
                    String::new()
                };
                let mut out = Self::glob_output(
                    &pattern, &raw, hits, limit, page, skipped, refused, walk, &budget, &here);
                out.push_str(&unopened_residue("file_glob", unopened, 0));
                out.push_str(&residue);
                Ok(out)
            }
            Tool::FileDelete => return Self::file_delete(args_json, ctx).await,
            Tool::FileFetch => {
                let path = res!(Self::scoped(ctx, &res!(Self::arg(args_json, "path"))));
                ctx.host().fs().cloud_fetch(&path).await
            }
            // Message content rather than a string, so it leaves by the same early return that
            // `file_read` uses for an image.
            Tool::FileShow => return Self::file_show(args_json, ctx).await,
            // Message content for a Diamond's page, which may carry its pictures.
            Tool::Capture if Self::capture_in_crystal(args_json) =>
                return Self::capture_crystal(args_json, ctx).await,
            Tool::Capture  => Self::capture_view(args_json, ctx).await,
            // The same drawing as `capture` in:"crystal", asked for the targets alone.
            Tool::CrystalLook => return match ctx.daimon() {
                None     => Ok(MessageContent::text(refusal_line(
                    "crystal_look looks at a Diamond's own page, and this turn is not working \
                    inside a Diamond, so there is no page to look at."))),
                Some(id) => match Self::look_args(args_json, &id) {
                    Ok(req)  => Self::capture_crystal(&req, ctx).await,
                    Err(why) => Ok(MessageContent::text(refusal_line(&why))),
                },
            },
            Tool::Ocr      => return Self::ocr(args_json, ctx).await,
            Tool::ImageEdit => return Self::image_edit(args_json, ctx).await,
            Tool::Ask      => return Self::ask(args_json, ctx).await,
            Tool::SocialRead => Self::social_read(args_json, ctx).await,
            Tool::SocialSend => Self::social_send(args_json, ctx).await,
            Tool::FileMove => return Self::file_move(args_json, ctx).await,
            Tool::DirCreate => {
                let raw = res!(Self::arg(args_json, "path"));
                let path = res!(Self::scoped(ctx, &raw));
                let lic = match ctx.licence(&path) {
                    Ok(l)    => l,
                    Err(why) => return Ok(MessageContent::text(why)),
                };
                match reach_of(ctx, &raw, &path, Door::Change).await {
                    Reach::Refuse(why) => return Ok(MessageContent::text(refusal_line(&why))),
                    Reach::Machine { abs, cwd, root, spec } => {
                        let got = res!(machine_change("dir_create", MachineChange::Mkdir(&lic),
                            &root, &cwd, &spec, &ctx.no_write, ctx.host()).await);
                        return match got {
                            Ok(_)    => Ok(MessageContent::text(fmt!("Created {}.", abs))),
                            Err(why) => Err(err!("{}", why; IO, File, Write)),
                        };
                    },
                    Reach::Storage => (),
                }
                res!(ctx.host().fs().create_dir_licensed(ctx.root, &lic).await);
                // A store's folder stands by the files in it (HL5c, lead ruling 2): one made with
                // nothing in it yet is noted, not listed, and the reply says so plainly.
                if store_owned(ctx.root, &path).is_some()
                    && !res!(ctx.host().fs().exists(ctx.root, &path).await)
                {
                    return Ok(MessageContent::text(fmt!("Folder {} noted; it appears once a file \
                        is written in it.", path)));
                }
                Ok(fmt!("Created {}.", path))
            }
            // The file must EXIST to be declared.  A declaration that quietly
            // accepted a typo would put a link on the Diamond pointing at
            // nothing, and the reader would find that out by clicking it.
            Tool::ArtefactAdd => {
                let path = res!(Self::scoped(ctx, &res!(Self::arg(args_json, "path"))));
                if !res!(ctx.host().fs().exists(ctx.root, &path).await) {
                    return Ok(Self::absent_artefact(&path));
                }
                // Recorded by the fold, from this line in the tool log, with
                // every other artefact. Nothing is written behind the user's
                // back: an unaccepted fold records nothing at all.
                Ok(fmt!("Recorded {} as an artefact of this Diamond.", path))
            }
            Tool::Shell => Err(err!(
                "Tool 'shell' is not available in the browser build (no in-browser process executor).";
                Unimplemented)),
            Tool::Run => Self::run(args_json, ctx).await,
            Tool::Runs => Self::runs(args_json, ctx).await,
            Tool::Verify => Self::verify(args_json, ctx).await,
            // BOTH HALVES REACH THE PAGE, and both return early rather than falling through the
            // string arm: they are `async`, because a worker is started by the page and a report
            // is waited for from the page, exactly as `ask` and `run` are.
            Tool::SpawnAgent => return Self::spawn_hosted(args_json, ctx).await,
            Tool::Gather     => return Self::gather_hosted(args_json, ctx).await,
            Tool::WebOpen => {
                let url = res!(Self::arg(args_json, "url"));
                // The panel navigates to a URL the model chose, so its path and query are an
                // outward channel exactly as `web_fetch`'s are.
                if let Some(refusal) = egress_check(self.name(), &url, ctx).await {
                    return Ok(MessageContent::text(refusal));
                }
                // WHO is asking, as `file_show` names it: the turn's keeper.  The panel answers
                // whether the conversation is on screen, and keeps the page for it if not; the
                // turn's tag says whether it was asked on another device, whose screen it is.
                let owner = ctx.keeper().or_else(|| ctx.daimon()).unwrap_or_default();
                ctx.host().web().open(&url, &owner, &ctx.turn_tag()).await
            }
            Tool::WebClose    => ctx.host().web().close().await,
            Tool::WebFetch => {
                let url = res!(Self::arg(args_json, "url"));
                // The primary exfiltration channel: the gateway fetches whatever URL the model
                // wrote, and anything the model knows can be written into it.
                if let Some(refusal) = egress_check(self.name(), &url, ctx).await {
                    return Ok(MessageContent::text(refusal));
                }
                // A `to` turns a read into a DOWNLOAD: the raw bytes are saved to a workspace file
                // and only a handle comes back, never the content. This is the sanctioned bulk
                // egress -- the hand that runs the daimon's commands has no network of its own, so
                // `curl > file` there returns nothing, and the ordinary fetch strips a page to
                // text and would corrupt a binary or a canonical file. The write reuses the file
                // tools' two-way path exactly: `reach_of` decides machine or storage, the machine
                // arm keeps a `before` for the Diamond's history, and the storage arm writes bytes.
                if let Some(to) = extract_json_string(args_json, "to")
                    .filter(|s| !s.trim().is_empty())
                {
                    let path = res!(Self::scoped(ctx, &to));
                    // THE WRITE FENCE, before a byte is fetched: this door wrote past every fence
                    // until 2026-09-23 (re-check R1), because the fence was a list and this tool
                    // was not on it. The licence is what the write below takes, so it cannot land
                    // anywhere the fence did not pass.
                    let lic = match ctx.licence(&path) {
                        Ok(l)    => l,
                        Err(why) => return Ok(MessageContent::text(why)),
                    };
                    let raw  = res!(ctx.host().net().fetch_raw(&url).await);
                    // The bytes are outside content the moment they arrive, as `wrap_untrusted`
                    // says for the text path: the turn is tainted HERE, before the write, so
                    // `tainted_landing` books the file as a stranger's (NF5) every time rather
                    // than when a parent's async word happened to arrive first (RUNNER-WEB QA H1).
                    ctx.set_tainted();
                    let ctype = raw.content_type;
                    match reach_of(ctx, &to, &path, Door::Change).await {
                        Reach::Refuse(why) => {
                            return Ok(MessageContent::text(refusal_line(&why)));
                        }
                        Reach::Machine { abs, cwd, root, spec } => {
                            // The hand writes TEXT only (`hand/src/codec.rs`), so a machine path
                            // takes a UTF-8 body losslessly -- the wordlist case -- and a non-UTF-8
                            // body is refused rather than mangled. Growing the hand to carry binary
                            // is a separate change; this says so plainly instead of guessing.
                            let text = match String::from_utf8(raw.bytes) {
                                Ok(t)  => t,
                                Err(_) => return Err(err!(
                                    "web_fetch: {} answered with binary data ({}), and a file in a \
                                    folder on this computer is written through the machine hand, \
                                    which carries text only. Save it under this Diamond's own \
                                    folder instead (a path with no mark), which takes bytes of any \
                                    kind -- or the machine hand needs updating to write binary \
                                    files before this can.", url, ctype;
                                    Invalid, Input, Unimplemented)),
                            };
                            let keep = match ctx.keeper() {
                                Some(d) => Some((d,
                                    machine_before(&abs, &cwd, &spec, &ctx.no_write, ctx.host()).await)),
                                None    => None,
                            };
                            if let Some((_, (None, Some(why)))) = &keep {
                                return Ok(MessageContent::text(
                                    overwrite_unkept_refusal(&to, why)));
                            }
                            // AN OVERWRITE OF A FILE THAT WAS THERE counts against the turn's
                            // bound, and its copy is on disk before the write -- held as a
                            // delete's is where the download wipes it.
                            let mut over: Option<Overwrite> = None;
                            if let Some((dia, (Some(before), _))) = &keep {
                                match Self::before_overwrite(ctx, dia, &abs, &to, Some(before),
                                    Some(text.as_bytes()), true).await
                                {
                                    Ok(o)    => over = Some(o),
                                    Err(why) => return Ok(MessageContent::text(why)),
                                }
                            }
                            // Bound to the version capture's read (U3a RMW2).
                            let bound = keep.as_ref().map(|(_, (b, _))| WriteBound::Kept(
                                crate::diamond_versions::Seen::of(b.as_deref())));
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
                            let got = match machine_change("web_fetch",
                                machine_write(false, &lic, &text,
                                    &crate::diamond_versions::Seen::Unread, bound.as_ref()),
                                &root, &cwd, &spec, &ctx.no_write, ctx.host()).await
                            {
                                Ok(g)  => g,
                                Err(e) => { Self::overwrite_failed(&over, ctx.host()).await; return Err(e); },
                            };
                            if got.is_err() {
                                Self::overwrite_failed(&over, ctx.host()).await;
                            }
                            if let (Err(why), Some(b)) = (&got, &bound) {
                                if let Some(said) = b.hand_refusal("web_fetch", &to, why) {
                                    return Err(err!("{}", said; Invalid, Input, Mismatch));
                                }
                            }
                            return match got {
                                Ok(_) => {
                                    // What this agent last saw, as the storage door records it.
                                    lock_cache(&ctx.read_seen).seen.insert(
                                        &Storage::Machine(root.clone()), &path,
                                        content_hash(text.as_bytes()));
                                    let mut unkept = String::new();
                                    if let Some((dia, (before, refused))) = keep {
                                        let found = machine_found(&before, &refused);
                                        let (before, wiped) = Overwrite::prior(&over, before);
                                        unkept.push_str(&Self::unkept(ctx.host(), ctx.host().store().capture(&dia, &to,
                                            crate::diamond_versions::Change {
                                                path:    abs.clone(),
                                                after:   crate::diamond_versions::Body::Held(
                                                    text.as_bytes().to_vec()),
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
                                    Ok(MessageContent::text(fmt!("{}{}",
                                        Self::saved_bytes_line(text.len(), &abs, &ctype), unkept)))
                                },
                                Err(why) => Err(err!("{}", why; IO, File, Write)),
                            };
                        }
                        Reach::Storage => {
                            let at = stored_in(ctx, &path);
                            // Browser storage takes the bytes as they are, binary and all. A write
                            // that would have to invent a folder to land is refused here exactly as
                            // file_write's is, and for the same reason: the success would otherwise
                            // be indistinguishable from a real one.
                            let place = res!(write_place(ctx, &to, &path).await);
                            if let WritePlace::Inventing(dir) = &place {
                                return Ok(MessageContent::text(refusal_line(&would_invent_said(
                                    &to, dir, &marks_of(&ctx.no_write).join(", ")))));
                            }
                            let keep = match ctx.keeper() {
                                Some(d) => match Self::before_bytes(ctx, &path).await {
                                    Ok(b)    => Some((d, b)),
                                    Err(why) => return Ok(MessageContent::text(
                                        overwrite_unkept_refusal(&to, &why))),
                                },
                                None    => None,
                            };
                            // AN OVERWRITE OF A FILE THAT WAS THERE counts against the turn's
                            // bound, and its copy is on disk before the write -- held as a
                            // delete's is, and asked about in the open folder as one is, where the
                            // download wipes it.
                            let over = match &keep {
                                Some((dia, Some(b))) =>
                                    match Self::before_overwrite(ctx, dia, &path, &to, Some(b),
                                        Some(&raw.bytes), true).await
                                    {
                                        Ok(o)    => Some(o),
                                        Err(why) => return Ok(MessageContent::text(why)),
                                    },
                                _ => None,
                            };
                            let n    = raw.bytes.len();
                            let hash = content_hash(&raw.bytes);
                            // Bound to the version capture's read (U3a RMW2).
                            let bound = keep.as_ref().map(|(_, b)| WriteBound::Kept(
                                crate::diamond_versions::Seen::of(b.as_deref())));
                            match Self::write_over(ctx, &lic, "web_fetch", &to, &raw.bytes, &over,
                                bound.as_ref(), None).await
                            {
                                Ok(Ok(_))     => {},
                                Ok(Err(why))  => {
                                    Self::overwrite_failed(&over, ctx.host()).await;
                                    return Ok(MessageContent::text(why));
                                },
                                Err(e)        => { Self::overwrite_failed(&over, ctx.host()).await; return Err(e); },
                            }
                            let mut unkept = String::new();
                            if let Some((dia, before)) = keep {
                                let found = Found::of(before.as_deref());
                                let (before, wiped) = Overwrite::prior(&over, before);
                                unkept.push_str(&Self::captured_write(ctx, &dia, &path, raw.bytes, found, before, wiped));
                            }
                            lock_cache(&ctx.read_seen).seen.insert(&at, &path, hash);
                            return Ok(MessageContent::text(fmt!("{}{}",
                                Self::saved_bytes_line(n, &path, &ctype), unkept)));
                        }
                    }
                }
                let page = res!(ctx.host().net().fetch(&url).await);
                Ok(ctx.wrap_untrusted(&url, &page))
            }
            // Searching is not fetching, and the difference is who chose the destination. Nothing
            // here picks an engine: that is the user's setting, held and resolved by the
            // JavaScript half, and the absence of an `engine` argument is the whole change.
            //
            // Governed by `root/web` in the pause tree, with no leaf of its own. A leaf with no
            // control on screen is the mistake `root/web` itself already made.
            Tool::WebSearch => {
                let (query, kind, limit) = res!(Self::search_args(args_json));
                // The QUERY is the thing leaving the machine, so the query is what the user is
                // shown -- as `web_type` shows the text it is about to send. Putting a URL there
                // instead is precisely what made the search prompt unreadable.
                if let Some(refusal) =
                    egress_check_detail(self.name(), SEARCH_ENDPOINT, &query, ctx).await
                {
                    return Ok(MessageContent::text(refusal));
                }
                let ans = res!(ctx.host().net().search(&query, kind.id(), limit).await);
                Ok(Self::search_result(ctx, &ans))
            }
            // A snapshot is a control surface -- the model acts on its refs -- but every role and
            // name in it was written by whoever wrote the page, so it is wrapped like the rest.
            Tool::WebSnapshot => {
                let tree = res!(ctx.host().web().snapshot().await);
                Ok(ctx.wrap_untrusted("the open web page — accessibility tree", &tree))
            }
            Tool::WebRead => {
                let page = res!(ctx.host().web().read().await);
                Ok(ctx.wrap_untrusted("the open web page", &page))
            }
            // Acting on a page carries no URL of its own, so the gate could not see it: a link's
            // href can hold the payload, and a form post sends whatever was typed. The destination
            // is the page already open, and it is named here so the user knows where an action
            // goes.
            Tool::WebClick => {
                let node_ref = res!(Self::node_ref(args_json));
                let here = ctx.host().web().current_url().await;
                // `act_check`, not `egress_check`: a click is the act the safety clause names, and
                // an unattended agent is asked about it whatever the rung says.
                if let Some(refusal) = act_check(self.name(), &here, ctx).await {
                    return Ok(MessageContent::text(refusal));
                }
                ctx.host().web().click(node_ref).await
            }
            Tool::WebType => {
                let node_ref = res!(Self::node_ref(args_json));
                let text = res!(Self::arg(args_json, "text"));
                let submit = extract_json_bool(args_json, "submit").unwrap_or(false);
                let here = ctx.host().web().current_url().await;
                // The text IS the thing being sent, so it is what the user is shown.
                if let Some(refusal) =
                    act_check_detail(self.name(), &here, &text, ctx).await
                {
                    return Ok(MessageContent::text(refusal));
                }
                ctx.host().web().type_into(node_ref, &text, submit).await
            }
            Tool::WebScroll => {
                let dir = res!(Self::arg(args_json, "direction"));
                if dir != "up" && dir != "down" {
                    return Err(err!(
                        "web_scroll: 'direction' must be 'up' or 'down', not '{}'.", dir;
                        Invalid, Input));
                }
                let amount = extract_json_number(args_json, "amount").map(|n| n as u32);
                ctx.host().web().scroll(&dir, amount).await
            }
            // Rust owns both ends of the file: every source, picture and font is read
            // and the PDF is written through `wasm::opfs`, which carries the path jail,
            // the account namespace and the real-folder override.  The JS driver is
            // handed contents and hands back bytes; it touches no file at all.
            //
            // THE PROJECT DOOR, not the single-string one.  This arm read the named file
            // and handed that ONE STRING to the compiler until seq 117, so a book's first
            // `#import` could not resolve however the gatherer behaved -- the gatherer was
            // never reached.  What the user got instead was a well-written refusal
            // explaining that a single string had been compiled rather than a folder,
            // from which the daimon reasonably concluded that the compiler could not do
            // imports at all, and told the user to attach a folder that was already in
            // the workspace.  A tool with no production caller is a tool that does not
            // exist, and this was the caller.
            //
            // `Reach::Turn` and not the workspace's own reach: a compile follows paths
            // this call never named, so it is held to the bounds of the turn that asked
            // for it, entry by entry, exactly as `file_search` and `file_glob` are.
            Tool::TypstCompile => {
                let src_rel = res!(Self::arg(args_json, "path"));
                let out_rel = res!(Self::typst_out(args_json));
                let src = res!(Self::scoped(ctx, &src_rel));
                let out = res!(Self::scoped(ctx, &out_rel));
                let lic = match ctx.licence(&out) {
                    Ok(l)    => l,
                    Err(why) => return Ok(MessageContent::text(why)),
                };
                // ON A MACHINE (the runner, U13b) the machine's own Typst compiles it, through the
                // run's exec door; the tab keeps the compiler bundled into its page.  Either way the
                // bytes take the one write path below.  The pack gate (`Tool::pack`, read by
                // `guard` above) has already been passed: nothing here asks it again.
                let (pdf, after) = match Self::typst_on_machine(ctx) {
                    true    => match res!(Self::typst_native(ctx, &src).await) {
                        Ok(got)  => got,
                        Err(why) => return Ok(MessageContent::text(why)),
                    },
                    false   => {
                        let reach = crate::engine::host::types::ui::Reach::Turn(ctx);
                        (res!(ctx.host().ui().compile_project(&reach, ctx.root, &src).await),
                            String::new())
                    }
                };
                // WHAT THE PDF LANDS ON: as every generated file's, [`Self::land_output`].
                let unkept = match res!(Self::land_output(ctx, Tool::TypstCompile, &out_rel, &out,
                    &lic, &pdf).await)
                {
                    Ok(u)    => u,
                    Err(why) => return Ok(MessageContent::text(why)),
                };
                Ok(fmt!("Compiled {} to {} ({} bytes).{}{}", src, out, pdf.len(), unkept, after))
            }
            // The world model, read.  A node was named or it was not, and the two questions -- what
            // is THIS related to, and what is the whole shape of the work -- are one tool because
            // they are one answer in two sizes, and a model given two tools picks the wrong one.
            Tool::LinkList => {
                match extract_json_string(args_json, "node") {
                    Some(node) if !node.trim().is_empty() =>
                        ctx.host().store().links_json(node.trim()).await,
                    _ => ctx.host().store().all_links().await,
                }
            }
            // The Diamond's own memory, cold half included.  `ctx.daimon()` is the one reader of
            // `daimon_of`, so a turn that acts for no Diamond is told so in a sentence rather
            // than answered about somebody else's crystal.
            Tool::CrystalRead => {
                let id = match ctx.daimon() {
                    Some(i) => i,
                    None    => return Ok(MessageContent::text(fmt!(
                        "A crystal is kept on a Diamond, and this turn is not working inside \
                        one, so there is no memory to read."))),
                };
                let json = ctx.host().store().read_crystal_data(&id).await
                    .unwrap_or_default();
                let section = extract_json_string(args_json, "section").unwrap_or_default();
                let key     = extract_json_string(args_json, "key").unwrap_or_default();
                if !section.trim().is_empty() {
                    match res!(crystal_section(&json, &section)) {
                        Some(body) => Ok(fmt!("crystal.json, section \"{}\":\n{}",
                            section.trim(), body)),
                        None => Ok(fmt!(
                            "No section of crystal.json is headed \"{}\" -- or more than one is, \
                            once case is folded. Call crystal_read with no arguments for the \
                            outline and take the heading from there.", section.trim())),
                    }
                } else if !key.trim().is_empty() {
                    match res!(crystal_key(&json, &key)) {
                        Some(text) => Ok(fmt!("crystal.json, key \"{}\":\n{}", key.trim(), text)),
                        None       => Ok(fmt!(
                            "crystal.json has no top-level key \"{}\". Call crystal_read with no \
                            arguments for the outline, which names every key it has.",
                            key.trim())),
                    }
                } else {
                    let split = res!(crystal_split(&json, crystal_hot_cap()));
                    Ok(Self::crystal_outline_said(&split))
                }
            }
            // Half of `recall`.  The FOLD half needs the session, which no tool has, so it is
            // answered by `Agent::run_tool_loop` and prepended to this.
            Tool::Recall => {
                let id = match ctx.daimon() {
                    Some(i) => i,
                    None    => return Ok(MessageContent::text(fmt!(
                        "recall searches this Diamond's memory, and this turn is not working \
                        inside a Diamond."))),
                };
                let json  = ctx.host().store().read_crystal_data(&id).await
                    .unwrap_or_default();
                let opts  = res!(search_opts(args_json));
                let mut stats = SearchStats::default();
                let mut lines = res!(recall_crystal(&json, &opts, &mut stats));
                // AND THE FILES BESIDE IT, live and retired. A decision made a month ago is in
                // `.daimond/decisions-archive.md` and in no prompt anywhere, so a recall that
                // searched the crystal alone would answer "nothing" about the one record the
                // whole file set exists to keep. Named by their own paths, so what comes back
                // can be opened with file_read.
                res!(Self::recall_standing(&id, &opts, &mut stats, &mut lines, ctx.host()).await);
                // AND WHAT EVERY DEVICE'S TURNS DID (UNBLOCK-11): the activity record, whole,
                // where the prompt carries only its newest lines.
                let files: Vec<String> = ctx.host().store().activity_read_all(&id).await
                    .into_iter().map(|(_, text)| text).collect();
                let now = ctx.host().clock().now_ms() as i64;
                if res!(recall_activity(&files, now, &opts, &mut stats, &mut lines)) {
                    // AND THE DAIMON CHAT'S OWN TRANSCRIPT, on every device the same, where a
                    // session folded or rebuilt elsewhere no longer holds the words. The page
                    // searches it; a page without the search is said, not hidden.
                    match ctx.host().ui().transcript_search(&id, args_json).await {
                        Ok(json) => recall_transcript_lines(&json, opts.limit, &mut lines),
                        Err(e)   => lines.push(fmt!("[recall] the chat transcript was not \
                            searched: {}", e.plain())),
                    }
                }
                Ok(Self::recall_said(&opts, &lines, &stats))
            }
            Tool::LinkAdd => {
                let from = res!(Self::arg(args_json, "from"));
                let to   = res!(Self::arg(args_json, "to"));
                let owner = match Self::link_owner(self, args_json, ctx) {
                    Some(o) => o,
                    None    => return Ok(MessageContent::text(fmt!(
                        "A link is kept on a Diamond, and this turn is not working inside one. \
                        Name a Diamond as 'from' -- 'diamond:<id>', as link_list reports it -- and \
                        the record will be kept there."))),
                };
                // The owner came out of a string the MODEL wrote, which no earlier caller of
                // `add_link` was true of -- the page always passed an id it had just read off the
                // rail. A mistyped one would have a sidecar written for it, and `all_links` walks
                // directories rather than the rail, so the graph would gain links belonging to a
                // Diamond nothing lists.
                if !ctx.host().store().diamond_exists(&owner).await {
                    return Ok(MessageContent::text(fmt!(
                        "There is no Diamond '{}', so nothing was linked. Take the id from \
                        link_list rather than from the name of the thing.", owner)));
                }
                let rel  = extract_json_string(args_json, "rel").unwrap_or_default();
                let note = extract_json_string(args_json, "note").unwrap_or_default();
                let id = res!(ctx.host().store().add_link(
                    &owner, &from, &to, &rel, &note, &Self::asserted_by(ctx)).await);
                Ok(fmt!(
                    "Linked {} to {} on Diamond {} (link {}). It is found from either end, so do \
                    not assert the reverse.", from, to, owner, id))
            }
            Tool::LinkRemove => {
                let link_id = res!(Self::arg(args_json, "id"));
                let owner = match Self::link_owner(self, args_json, ctx) {
                    Some(o) => o,
                    None    => return Ok(MessageContent::text(fmt!(
                        "Missing 'owner': name the Diamond whose sidecar holds the link, exactly \
                        as link_list reported it."))),
                };
                // A LINK THE USER DREW IS THEIRS TO TAKE BACK, in EVERY turn (see
                // [`user_link_refusal`]).  The user's own doors remove links through the store and
                // never through this tool, so there is no turn this refusal may skip; it was asked
                // of a daimon's or a fenced turn alone, and a chat's model could take a mark out.
                match res!(ctx.host().store().remove_link_by_model(&owner, &link_id).await) {
                    crate::diamond_link::Unlink::Users =>
                        return Ok(MessageContent::text(user_link_refusal(&link_id))),
                    crate::diamond_link::Unlink::Removed(_) =>
                        Ok(fmt!("Removed link {} from Diamond {}.", link_id, owner)),
                    crate::diamond_link::Unlink::Missing => Ok(fmt!(
                        "No link {} on Diamond {}, so nothing was removed. The record is kept on \
                        ONE Diamond and found from both ends, so check 'owner' against what \
                        link_list returned rather than assuming the end you came from.",
                        link_id, owner)),
                }
            }
            Tool::MailList   => Self::mail_list(args_json, ctx).await,
            Tool::MailSearch => Self::mail_search(args_json, ctx).await,
            Tool::MailRead   => Self::mail_read(args_json, ctx).await,
            Tool::MailDraft  => Self::mail_draft(args_json, ctx.host()).await,
            Tool::PendingNone => pending_none(ctx),
            Tool::StateSet => return Self::state_set(args_json, ctx).await,
            // The page keeps the alert under the turn's own Diamond, never the model's word.
            Tool::PendingRaise | Tool::PendingClear => {
                let raise = matches!(self, Tool::PendingRaise);
                match pending_step(args_json, ctx.daimon().as_deref(), raise) {
                    Err(why) => Ok(why),
                    Ok(call) => {
                        let answer = res!(ctx.host().ui().pending(
                            raise, &call.diamond, &call.payload).await);
                        Ok(pending_result(raise, &call.key, &answer))
                    }
                }
            }
            // THE REGISTRY RUNS THIS ONE, not the tool.  Its ops are dispatched through the
            // same door the primitives go through, and that door is `ToolRegistry`'s -- a tool
            // holds no registry, so it cannot reach it.  `try_dispatch_unbilled` intercepts the
            // name before this match is ever consulted; reaching here means that interception
            // has been lost, and saying so loudly is better than answering nothing.
            Tool::Compound => Err(err!("compound is run by the tool registry, which dispatches \
                its ops; it cannot be executed as a tool on its own"; Unimplemented)),
        });
        Ok(MessageContent::text(text))
    }

    /// Read the integer `ref` argument that names a node from the latest
    /// snapshot, tolerating a model that quotes it as a string.
    pub(super) fn node_ref(args: &str) -> Outcome<u32> {
        if let Some(n) = extract_json_number(args, "ref") {
            return Ok(n as u32);
        }
        if let Some(s) = extract_json_string(args, "ref") {
            if let Ok(n) = s.trim().parse::<u32>() {
                return Ok(n);
            }
        }
        Err(err!(
            "Missing 'ref': name the node by its integer ref from the most recent web_snapshot.";
            Invalid, Input, Missing))
    }

    /// The `query`, `kind` and `limit` of a `web_search` call.
    ///
    /// An unrecognised `kind` is REFUSED rather than quietly treated as `web`.  A model that asked
    /// for news and was silently handed the open web would report ordinary pages as news, and
    /// nothing in the result would say otherwise -- a wrong answer with no mark on it.
    ///
    /// # Arguments
    /// * `args` - The raw tool arguments, as the model sent them.
    pub(super) fn search_args(args: &str) -> Outcome<(String, SearchKind, Option<u32>)> {
        let query = res!(Self::arg(args, "query"));
        if query.trim().is_empty() {
            return Err(err!(
                "web_search: 'query' is empty, so there is nothing to search for.";
                Invalid, Input, Missing));
        }
        let kind = match extract_json_string(args, "kind") {
            Some(k) if !k.trim().is_empty() => match SearchKind::from_id(k.trim()) {
                Some(k) => k,
                None    => return Err(err!(
                    "web_search: 'kind' is '{}', which is not one of {}.",
                    k.trim(), SearchKind::names(); Invalid, Input)),
            },
            _ => SearchKind::Web,
        };
        // Passed on as the model wrote it. The contract has each engine clamp to its own maximum,
        // and a second ceiling here would silently make the answer the smaller of two.
        let limit = match extract_json_number(args, "limit") {
            Some(n) => Some(n as u32),
            // A model that sends `"limit":"10"` means ten, as `uint_arg` already allows for.
            None    => extract_json_string(args, "limit").and_then(|s| s.trim().parse::<u32>().ok()),
        };
        Ok((query, kind, limit))
    }

    /// The origin a search result is wrapped under: which engine answered, and what was asked.
    ///
    /// Not merely the engine's name.  A reader working out later why the model believed something
    /// needs the QUESTION as well as the source, and the transcript is where they will look.
    ///
    /// # Arguments
    /// * `engine` - The engine's contract id, as the JavaScript half reported it.
    /// * `query` - What was asked of it.
    pub(super) fn search_origin(engine: &str, query: &str) -> String {
        // An engine that named itself nothing still has to leave a legible line.
        let who = if engine.trim().is_empty() { "search" } else { engine.trim() };
        fmt!("{} results for: {}", who, query)
    }

    /// The result list as the model reads it.
    ///
    /// Numbered, one URL to a line so it can be copied into `web_fetch`, and the age before the
    /// snippet because "is this current" is the question a result list is usually being scanned
    /// for.  An empty snippet or age takes no line at all rather than an empty one.
    ///
    /// # Arguments
    /// * `ans` - What came back.
    pub(super) fn render_search(ans: &SearchAnswer) -> String {
        if ans.results.is_empty() {
            return "No results. The engine ran the query and had nothing for it, so this is an \
                answer rather than a failure -- and it cost nothing. Try different words, or say \
                that the web does not appear to have this.".to_string();
        }
        let mut out = String::new();
        for (i, r) in ans.results.iter().enumerate() {
            out.push_str(&fmt!("{}. {}\n   {}\n", i + 1, r.title.trim(), r.url.trim()));
            let mut tail = String::new();
            if !r.age.trim().is_empty() {
                tail.push_str(&fmt!("[{}] ", r.age.trim()));
            }
            tail.push_str(r.snippet.trim());
            if !tail.trim().is_empty() {
                out.push_str(&fmt!("   {}\n", tail.trim()));
            }
        }
        out
    }

    /// A search's whole answer as the tool hands it back: rendered, cut to the output budget, and
    /// wrapped as a stranger's words.
    ///
    /// ONE function, called by the dispatch and by the tests, so what a test proves is what the
    /// tool does rather than a second composition that agrees with it today.
    ///
    /// **A search result deserves the envelope more than a page the user named does.** Nobody can
    /// make you type their URL; anyone can work to rank their page into your results. This is the
    /// one web tool whose destinations are chosen by strangers, so it is the one whose output must
    /// never read as instruction.
    ///
    /// # Arguments
    /// * `ctx` - The turn, which the wrapper marks as having read outside content.
    /// * `ans` - What came back.
    pub(super) fn search_result<H: Host>(ctx: &ToolContext<H>, ans: &SearchAnswer) -> String {
        let origin = Self::search_origin(&ans.engine, &ans.query);
        // Defanged before the cut, as `mark_if_untrusted` does: quoting a forged marker lengthens
        // the text, and a result list made of nothing but forged markers would otherwise leave the
        // budget far behind.
        let mut body = defang(&Self::render_search(ans));
        truncate_output(&mut body, MAX_OUTPUT.saturating_sub(envelope_overhead(&origin)));
        ctx.wrap_untrusted(&origin, &body)
    }

    /// Put `path` in front of the user, and say what they are now looking at.
    ///
    /// The one tool here whose whole effect is on the USER'S SCREEN, and that is what shapes it.
    /// Nothing is written, nothing leaves the machine, and the path has already been through
    /// [`guard`](Tool::guard) as a read -- see [`read_target`](Tool::read_target) for why showing
    /// counts as reading.  What is left to answer is whether there is anybody in front of the
    /// panel, and whether the file is really there.
    ///
    /// # Arguments
    /// * `args_json` - The raw tool arguments: `path`, and optionally `page`.
    /// * `ctx` - The turn's context, which knows whether this actor is working alone.

    /// One file's text, or the sentence saying why there is none (browser).
    ///
    /// Both transports, because a multi-file read crosses them: a marked folder is on the
    /// machine and the Diamond's own directory is in browser storage, and a call may name files
    /// in both.
    pub(super) async fn read_one_text<H: Host>(ctx: &ToolContext<H>, raw: &str) -> Result<String, String> {
        Self::read_one_text_from(ctx, raw).await.map(|(t, _)| t)
    }

    /// [`Self::read_one_text`], with whether the file is a stranger's: judged where a machine read
    /// lands ([`is_stranger_at`]) as well as how it was spelt, and by the spelling alone elsewhere.
    pub(super) async fn read_one_text_from<H: Host>(ctx: &ToolContext<H>, raw: &str) -> Result<(String, bool), String> {
        let path = match Self::scoped(ctx, raw) {
            Ok(p)  => p,
            Err(e) => return Err(fmt!("not read: {}", e.plain())),
        };
        match reach_of(ctx, raw, &path, Door::Look).await {
            Reach::Refuse(why) => return Err(why),
            Reach::Machine { abs, cwd, root, spec } => {
                let got = match machine_op("file_read", "read", &abs, &cwd, &spec,
                    &ctx.no_write, &fmt!(r#","offset":1,"limit":{}"#, READ_LINES_MAX), ctx.host()).await
                {
                    Ok(g)  => g,
                    Err(e) => return Err(fmt!("not read: {}", e.plain())),
                };
                let text = match got {
                    Ok(t)    => t,
                    Err(why) => {
                        // Nothing there is this agent's view now, as a single read says (RD2).
                        if hand_said_absent(&why) {
                            lock_cache(&ctx.read_seen).seen.remove(&Storage::Machine(root), &path);
                        }
                        return Err(why);
                    },
                };
                let read = match machine_read(&text) {
                    Ok(r)  => r,
                    Err(e) => return Err(fmt!("not read: {}", e.plain())),
                };
                // A file too long to come back whole is not a file for this call: the header
                // would say it holds the whole of something it holds part of.
                if read.held < read.lines {
                    return Err(fmt!(
                        "{} lines, more than a multi-file read carries; read it on its own with \
                        'offset' and 'limit'.", read.lines));
                }
                return Ok((read.body.to_string(), is_untrusted_path(raw) || is_stranger_at(&abs, &root)));
            },
            Reach::Storage => (),
        }
        let at = stored_in(ctx, &path);
        let bytes = match ctx.host().fs().read_file(ctx.root, &path).await {
            Ok(b)  => b,
            Err(e) => {
                Self::read_found_nothing(ctx, &at, &path).await;
                return Err(fmt!("not read: {}", e.plain()));
            },
        };
        if is_binary(&bytes) {
            return Err(fmt!(
                "{} bytes and not text; read it on its own to be told what it is.", bytes.len()));
        }
        Ok((String::from_utf8_lossy(&bytes).to_string(), ws_stranger(ctx, raw, &path)))
    }

    /// Read several files in one call, each under its own header (browser).
    ///
    /// **One round for a small tree.** The rounds census of 2026-09-13 measured Claude Code
    /// reading a whole fixture with a single `cat src/*.js test/*.js` while a daimon spent three
    /// to six rounds at two or three files each -- about fourteen rounds over the valid trials,
    /// spent entirely on getting the files in front of itself.
    ///
    /// A pattern is expanded through `file_glob` rather than by walking here, so that one piece
    /// of code decides which paths a pattern names: the marks, the bounds, the skipped
    /// directories and the walk budget all apply, and they apply the way they do to a glob the
    /// model wrote itself.
    pub(super) async fn read_many<H: Host>(args: &str, asked: &[String], ctx: &ToolContext<H>) -> Outcome<MessageContent> {
        if let Some(why) = read_many_window_refusal(args) {
            return Ok(MessageContent::text(refusal_line(&why)));
        }
        let mut want: Vec<String> = Vec::new();
        for a in asked {
            if is_pattern(a) {
                let call = fmt!(
                    r#"{{"pattern":"{}","limit":{}}}"#, json_escape(a), READ_MANY_MAX);
                // Boxed into a trait object, because this is called FROM `execute` and calls
                // back into it: without the indirection the two futures name each other's types
                // and the compiler has an infinite one to build.
                let fut: std::pin::Pin<Box<dyn std::future::Future<
                    Output = Outcome<MessageContent>> + '_>> =
                    Box::pin(Tool::FileGlob.execute(&call, ctx));
                let listing = res!(fut.await);
                // A listing names each path as the model writes it back (`shown`), relative to
                // the folder base; `asked` is already root-relative (`based_args`), so each is
                // put through `based` -- the inverse -- before it is read (F2-FIX M3).
                for p in glob_paths(&listing.as_text()) {
                    let p = ctx.workspace.based(&p);
                    if !want.contains(&p) {
                        want.push(p);
                    }
                }
            } else if !want.contains(a) {
                want.push(a.clone());
            }
        }
        let over = want.len() > READ_MANY_MAX;
        want.truncate(READ_MANY_MAX);
        let mut out   = String::new();
        let mut left: Vec<String> = Vec::new();
        let mut room  = MAX_OUTPUT;
        let mut shown = 0usize;
        for path in &want {
            if !left.is_empty() {
                left.push(path.clone());
                continue;
            }
            if let Some(why) = path_refusal(&Tool::FileRead, path) {
                out.push_str(&fmt!("== {} == {}\n\n", path, why));
                continue;
            }
            // The bound, per file. `guard` checked the ONE path a call names, and this call may
            // name forty.
            if !ctx.may_read(path) {
                out.push_str(&fmt!("== {} == {}\n\n", path, ctx.refuse(path, false)));
                continue;
            }
            // Whether it is a stranger's is judged where a machine read lands (U10).
            let (text, stranger) = match Self::read_one_text_from(ctx, path).await {
                Ok(t)  => t,
                Err(w) => {
                    out.push_str(&fmt!("== {} == {}\n\n", path, w));
                    continue;
                },
            };
            let block = Self::mark_if_from(ctx, path, stranger, read_many_block(path, &text));
            if block.len() + 1 > room {
                left.push(path.clone());
                continue;
            }
            room -= block.len() + 1;
            out.push_str(&block);
            out.push('\n');
            shown += 1;
        }
        let mut head = fmt!("[file_read] {} file(s) of {} asked for.\n", shown, want.len());
        if over {
            head.push_str(&fmt!(
                "[file_read] at most {} files are opened in one call; the rest were not \
                listed.\n", READ_MANY_MAX));
        }
        out.push_str(&read_many_left(&left));
        Ok(MessageContent::text(fmt!("{}{}", head, out)))
    }


    /// Map a file, reading it a window or a chunk at a time (browser).
    ///
    /// **There is no hand verb for this and there does not need to be.** On the machine door the
    /// file is paged with the read the hand already has, ten thousand lines at a time, and each
    /// window is fed to the scanner as it arrives -- five round trips for a 2.36 MB file, and
    /// nothing of it held. In storage it is read in chunks and split by [`OpfsLines`].
    pub(super) async fn outline<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let raw  = res!(Self::arg(args, "path"));
        let opts = res!(outline_opts(args));
        let lang = match OutlineLang::of(&raw) {
            Some(l) => l,
            None    => return Ok(outline_no_scanner(&raw)),
        };
        let path = res!(Self::scoped(ctx, &raw));
        let mut scan = OutlineScan::new(lang);
        match reach_of(ctx, &raw, &path, Door::Look).await {
            Reach::Refuse(why) => return Ok(refusal_line(&why)),
            Reach::Machine { abs, cwd, root: _, spec } => {
                let mut from  = 1usize;
                let mut lines = 0usize;
                let mut bytes = 0usize;
                loop {
                    let got = res!(machine_op("file_read", "read", &abs, &cwd, &spec,
                        &ctx.no_write,
                        &fmt!(r#","offset":{},"limit":{}"#, from, READ_LINES_MAX), ctx.host()).await);
                    let text = match got {
                        Ok(t)    => t,
                        Err(why) => return Ok(refusal_line(&why)),
                    };
                    let read = res!(machine_read(&text));
                    lines = read.lines;
                    bytes = read.bytes;
                    if read.held == 0 {
                        break;
                    }
                    let mut n = from;
                    for line in read.body.lines() {
                        scan.feed(n, line);
                        n += 1;
                    }
                    from += read.held;
                    if from > read.lines {
                        break;
                    }
                }
                let (items, seen) = scan.finish();
                // The hand knows the file's length; the scanner only knows what it was shown.
                return Ok(outline_report(&raw, lines.max(seen), bytes, &items, &opts));
            },
            Reach::Storage => (),
        }
        let mut src = OpfsLines::new();
        let mut off = 0f64;
        let mut total = 0f64;
        loop {
            let (bytes, whole) = match ctx.host().fs().read_file_range(
                ctx.root, &path, off, SEARCH_CHUNK_BYTES).await
            {
                Ok(p)  => p,
                Err(e) => return Err(err!(e, "outline: cannot read '{}'.", raw; IO, File, Read)),
            };
            total = whole;
            off += bytes.len() as f64;
            let eof = bytes.is_empty() || off >= whole;
            src.fill(&bytes, eof);
            while let Some((n, line)) = res!(src.next_line()) {
                scan.feed(n, &line);
            }
            if eof {
                break;
            }
        }
        let (items, lines) = scan.finish();
        Ok(outline_report(&raw, lines, total as usize, &items, &opts))
    }

    /// Read one view of the Social panel.
    ///
    /// Short, because there is nothing here to decide.  The owner ruled that reading is
    /// immediate, so no gate is consulted, no rung is read and nobody is asked; what is left is
    /// [`social_read_step`], which is pure and tested, one call to the panel, and the fence.
    ///
    /// **The context IS taken, and until 2026-09-15 it was not.**  The paragraph that stood here
    /// argued that a read of the account's own panel is the same read whichever conversation
    /// asks -- true, and beside the point.  What comes back is written by OTHER PEOPLE: a
    /// proposal, a comment and a vote are other testers', a message is whoever sent it, and a
    /// feed post is whoever this account follows -- read here as untrusted text for the reason
    /// the feed plan gives (§6): the words are held by Oxedyne in the clear, but that makes them
    /// readable, not trusted.  Every other stranger-text path in this file goes through
    /// [`ToolContext::wrap_untrusted`]; this one handed them over bare, so the Social panel was
    /// the one door into a turn that neither fenced what it carried nor marked the turn as
    /// having read it -- and the egress gate behind the turn stayed open on the strength of it.
    ///
    /// # Arguments
    /// * `args_json` - The raw tool arguments: `view`, and `n` or `limit` where the view wants them.
    /// * `ctx` - The turn, which the fence marks as having read outside content.
    pub(super) async fn social_read<H: Host>(args_json: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        match social_read_step(args_json) {
            Ok(req) => {
                let reading = res!(ctx.host().ui().read(&req).await);
                Ok(Self::social_result(ctx, &req, &reading))
            },
            // Daimond's OWN sentence, and it is not fenced.  A refusal wrapped as untrusted
            // content reads as a stranger telling the model it may not look, which is the one
            // thing the envelope must never be able to say.
            Err(no) => Ok(no),
        }
    }

    /// Where a reading of the Social panel came from, as the envelope names it.
    ///
    /// The view, because "a stranger wrote this" is not the whole of what a reader needs: the
    /// Notes view is this device's own drafts and the Messages view is the account's mail, and a
    /// model owes its reader which of them it is quoting.
    ///
    /// # Arguments
    /// * `req` - The request [`social_read_step`] composed, not the raw tool arguments.
    pub(super) fn social_origin(req: &str) -> String {
        let view = extract_json_string(req, "view").unwrap_or_default();
        let n    = extract_json_number(req, "n").unwrap_or(0);
        if view == SocialView::Proposal.id() && n > 0 {
            return fmt!("Daimond's Social panel -- proposal {}", n);
        }
        let named = if view.is_empty() { SocialView::Proposals.id() } else { view.as_str() };
        fmt!("Daimond's Social panel -- {}", named)
    }

    /// One view of the Social panel as the tool hands it back: cut to the output budget and
    /// wrapped as a stranger's words.
    ///
    /// ONE function, called by the dispatch and by the tests, so what a test proves is what the
    /// tool does rather than a second composition that agrees with it today.  That is
    /// [`Tool::search_result`]'s shape and it is here for [`Tool::search_result`]'s reason.
    ///
    /// **The taint is not conditional here.**  [`Tool::run_result`] and [`Tool::verify_result`]
    /// decide it beside the fence, because a command's output can be the daimon's own words
    /// coming back; a proposal on the forge cannot be.  So this always takes the method that
    /// marks the turn, and never the free function.
    ///
    /// # Arguments
    /// * `ctx` - The turn, which the wrapper marks as having read outside content.
    /// * `req` - The request the panel was handed, for the origin line.
    /// * `reading` - What the panel answered.
    pub(super) fn social_result<H: Host>(ctx: &ToolContext<H>, req: &str, reading: &str) -> String {
        let origin = Self::social_origin(req);
        // Defanged before the cut, as `search_result` does: quoting a forged marker lengthens
        // the text, and a panel of nothing but forged markers would otherwise leave the budget
        // far behind.
        let mut body = defang(reading);
        truncate_output(&mut body, MAX_OUTPUT.saturating_sub(envelope_overhead(&origin)));
        ctx.wrap_untrusted(&origin, &body)
    }

    /// Publish one thing on the Social panel, once the user has seen it and said yes.
    ///
    /// **Four steps and the order is the whole of it.**
    ///
    /// 1. [`social_send_step`] decides whether this call may publish at all.  A dispatched worker
    ///    is refused here, before anything is composed and before anybody is asked -- the refusal
    ///    is the answer, not a question put to somebody else.
    /// 2. [`crate::wasm::social::compose`] asks the panel what would actually leave.  Nothing is
    ///    sent by this; it is the step that makes the next one about bytes.
    /// 3. [`publish_check`] puts those exact characters to the user.
    /// 4. [`crate::wasm::social::commit`] sends what the panel composed, named by the token it
    ///    minted for it -- so what goes out is what was on the screen the user answered.
    ///
    /// # Arguments
    /// * `args_json` - The raw tool arguments: `act`, and the fields that act needs.
    /// * `ctx` - The turn, which knows whether it is a dispatched worker.
    pub(super) async fn social_send<H: Host>(args_json: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let req = match social_send_step(args_json, ctx.is_unsupervised()) {
            Ok(r)  => r,
            Err(no) => return Ok(no),
        };
        let (shown, token) = match res!(ctx.host().ui().compose(&req).await) {
            crate::engine::host::types::ui::Composed::Draft { shown, token } => (shown, token),
            crate::engine::host::types::ui::Composed::Refused(no)            => return Ok(no),
        };
        if let Some(no) = publish_check(&shown, ctx.host()).await {
            return Ok(no);
        }
        ctx.host().ui().commit(&token).await
    }

    /// List the mailboxes and a folder's recent messages.
    ///
    /// The panel composes the listing, for the reason [`crate::wasm::social`] gives: which
    /// accounts and folders exist and how many messages each holds is the panel's own account
    /// of its own disk, and a second reckoning here would be a second opinion to disagree with
    /// the screen.  The arguments go straight through.
    ///
    /// **Every answer from the mail set is a stranger's words** (D-20261026-05), a listing of
    /// senders and subjects as much as a body, since a subject line can carry an instruction.  So
    /// it goes through [`Self::mark_if_from`], the one envelope `file_read` puts round a file
    /// under `mail/`, and the turn is tainted: network, push and sign are then off for the chat.
    pub(super) async fn mail_list<H: Host>(args_json: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let listing = res!(ctx.host().ui().list(args_json).await);
        Ok(Self::mark_if_from(ctx, &Self::mail_origin("mail_list", args_json), true, listing))
    }

    /// Find messages in a folder by sender or subject; the panel scans its own digest.
    pub(super) async fn mail_search<H: Host>(args_json: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let found = res!(ctx.host().ui().search(args_json).await);
        Ok(Self::mark_if_from(ctx, &Self::mail_origin("mail_search", args_json), true, found))
    }

    /// Where a mail answer came from, for the envelope: the mailbox and folder asked of, and the
    /// message where there is one.
    pub(super) fn mail_origin(tool: &str, args_json: &str) -> String {
        let field = |k: &str| extract_json_string(args_json, k).unwrap_or_default();
        let path = field("path");
        if !path.is_empty() {
            return fmt!("{}: {}", tool, path);
        }
        let mut o = fmt!("{}: mail", tool);
        let address = field("address");
        if !address.is_empty() {
            o.push_str(&fmt!(" {}", address));
        }
        let folder = field("folder");
        o.push_str(&fmt!(" {}", if folder.is_empty() { "INBOX" } else { folder.as_str() }));
        if let Some(uid) = extract_json_number(args_json, "uid") {
            o.push_str(&fmt!(" uid {}", uid));
        }
        o
    }

    /// Read one message: the panel hands back its bytes and the sans-io parser decodes them.
    ///
    /// The split is the whole point.  The panel knows WHERE the message is -- the Maildir
    /// layout, the account, the uid -- and hands over the raw RFC 5322 bytes; the reading of
    /// those bytes is [`oxedyne_fe2o3_mail::message`], one tested decoder rather than a second
    /// one written here.  A refusal (no such mailbox, no such uid) comes back as a sentence to
    /// relay, not an error, and is the panel's own words, so it neither wraps nor taints; the
    /// message itself does both (see [`Self::mail_list`]).
    pub(super) async fn mail_read<H: Host>(args_json: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        match res!(ctx.host().ui().read_raw(args_json).await) {
            crate::engine::host::types::ui::Read::Refused(no)  => Ok(no),
            crate::engine::host::types::ui::Read::Bytes(bytes) => Ok(Self::mark_if_from(ctx,
                &Self::mail_origin("mail_read", args_json), true, Self::format_message(&bytes))),
        }
    }

    /// Render a parsed message for the model: the headers it needs to reply, the attachment
    /// names, then the readable body.
    pub(super) fn format_message(bytes: &[u8]) -> String {
        let m = oxedyne_fe2o3_mail::message::ParsedMessage::parse(bytes);
        let mut out = String::new();
        let mut line = |label: &str, value: &str| {
            if !value.trim().is_empty() {
                out.push_str(&fmt!("{}: {}\n", label, value.trim()));
            }
        };
        line("From", &m.from);
        line("To", &m.to);
        line("Cc", &m.cc);
        line("Date", &m.date);
        line("Subject", &m.subject);
        line("Message-ID", &m.message_id);
        line("In-Reply-To", &m.in_reply_to);
        if !m.attachments.is_empty() {
            line("Attachments", &m.attachments.join(", "));
        }
        out.push('\n');
        out.push_str(&m.body);
        out
    }

    /// Compose a draft with the sans-io builder and leave it for the user to send.
    ///
    /// **This is the one write in the mail set, and it is not a send.**  The bytes are built by
    /// [`oxedyne_fe2o3_mail::message::DraftMessage`] and handed to the panel, which writes them
    /// to `mail/<address>/drafts/<id>.eml` -- the same drafts folder a person's Send button
    /// reads.  There is no arm here, and none on the panel a model can reach, that puts the
    /// bytes on the wire (see `www/js/mail.js`).
    ///
    /// The two environment facts the builder is kept pure of -- the `Date` and the
    /// `Message-ID` -- are filled here from the page's clock and randomness, so the crate that
    /// emits the bytes stays testable.
    pub(super) async fn mail_draft<H: Host>(args_json: &str, host: &H) -> Outcome<String> {
        let field = |k: &str| extract_json_string(args_json, k).unwrap_or_default();

        let to = field("to");
        if to.trim().is_empty() {
            return Ok(fmt!(
                "mail_draft needs at least one recipient in 'to'. Give a bare address or \
                'Name <address>', and more than one comma-separated."));
        }

        // Which mailbox to send from: the model's choice, or the panel's selected one.
        let mut from = field("from").trim().to_string();
        if from.is_empty() {
            from = res!(host.ui().sender("{}").await).trim().to_string();
            if from.is_empty() {
                return Ok(fmt!(
                    "No mailbox is configured to send from, so there is nowhere to draft from. \
                    The user adds a mailbox in the Mail panel."));
            }
        }

        let draft = oxedyne_fe2o3_mail::message::DraftMessage {
            from:        from.clone(),
            from_name:   field("from_name"),
            to:          Self::split_addr_list(&to),
            cc:          Self::split_addr_list(&field("cc")),
            subject:     field("subject"),
            body:        field("body"),
            in_reply_to: field("in_reply_to"),
            references:  field("references"),
            date:        Self::draft_date(host),
            message_id:  Self::draft_message_id(&from, host),
            attachments: Vec::new(),
        };
        let bytes = match draft.build() {
            Ok(b)  => b,
            Err(e) => return Ok(fmt!("The draft could not be built: {}", e)),
        };
        let b64 = oxedyne_fe2o3_text::base64::encode(&bytes);
        let req = fmt!(
            r#"{{"address":"{}","raw_b64":"{}"}}"#,
            crate::llm::json_escape(&from),
            crate::llm::json_escape(&b64),
        );
        host.ui().put_draft(&req).await
    }

    /// Split a comma-separated address list, ignoring the commas inside a quoted display name
    /// (`"Doe, Jane" <j@x>` is one recipient, not two).
    pub(super) fn split_addr_list(s: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut cur = String::new();
        let mut quoted = false;
        for c in s.chars() {
            match c {
                '"'          => { quoted = !quoted; cur.push(c); },
                ',' if !quoted => {
                    let t = cur.trim().to_string();
                    if !t.is_empty() { out.push(t); }
                    cur.clear();
                },
                _            => cur.push(c),
            }
        }
        let t = cur.trim().to_string();
        if !t.is_empty() { out.push(t); }
        out
    }

    /// The `Date` header, from the page's own clock.  `toUTCString` gives RFC 1123 with a
    /// trailing `GMT`; RFC 5322 wants a numeric zone, so `GMT` becomes `+0000`.
    pub(super) fn draft_date<H: Host>(host: &H) -> String {
        let s = host.clock().utc_string();
        s.replace(" GMT", " +0000")
    }

    /// A `Message-ID` for a new draft: random bytes, the millisecond clock, and the sender's
    /// domain, which is what a reply to this message will point back at.
    pub(super) fn draft_message_id<H: Host>(from: &str, host: &H) -> String {
        let domain = match from.split('@').nth(1) {
            Some(d) if !d.trim().is_empty() => d.trim(),
            _                               => "daimond.local",
        };
        let millis = host.clock().now_ms() as u64;
        let r1 = host.clock().random_u32() as u64;
        let r2 = host.clock().random_u32() as u64;
        fmt!("<{:08x}{:08x}.{}@{}>", r1, r2, millis, domain)
    }

    /// Put one decision to the user, as options they answer with a tap.
    ///
    /// **The order here is the whole of the design.**  The question is checked first and drawn
    /// second, and the turn is marked as having asked LAST -- only once a card is really on the
    /// screen.  A mark set before the draw would spend the turn's one question on a page that
    /// never drew one, and the model would be refused the retry that the failure tells it to make.
    ///
    /// Nothing is awaited but the drawing.  See [`crate::wasm::ask`] for why this holds no promise
    /// and why that is what lets an unanswered question survive a reload.
    pub(super) async fn ask<H: Host>(args_json: &str, ctx: &ToolContext<H>) -> Outcome<MessageContent> {
        let asked = match ask_step(args_json, ctx.is_unsupervised(), ctx.has_asked()) {
            Ok(a)  => a,
            Err(r) => return Ok(MessageContent::text(r)),
        };
        // RUNNER-ASK: a host with no page carries the question home and answers in its own
        // words; one it would not carry is refused, and the turn may ask again.
        match res!(ctx.host().ui().put_ask(&asked.payload).await) {
            crate::engine::host::ui::AskShown::Page         => {
                ctx.set_asked();
                Ok(MessageContent::text(ask_result(&asked)))
            },
            crate::engine::host::ui::AskShown::Said(s)      => {
                ctx.set_asked();
                Ok(MessageContent::text(s))
            },
            crate::engine::host::ui::AskShown::Refused(s)   => Ok(MessageContent::text(ask_refusal(&s))),
        }
    }

    /// Read a PDF's text: the free layer first, OCR only where there is none.
    ///
    /// The bytes are already in hand and already sniffed as a PDF.  The transcript never
    /// carries the pages themselves -- only their words reach the turn, windowed by the
    /// same `offset`/`limit` every `file_read` honours, so a book-length PDF costs the
    /// model a page of text and not a megabyte of it.
    pub(super) async fn pdf_read<H: Host>(ctx: &ToolContext<H>, path: &str, stranger: bool, args_json: &str, bytes: &[u8])
        -> Outcome<MessageContent>
    {
        let hash = content_hash(bytes);
        if let Some(hit) = OCR_CACHE.with(|c| c.borrow().get(&hash).cloned()) {
            return Ok(MessageContent::text(Self::mark_if_from(
                ctx, path, stranger, Self::ocr_view(args_json, path, &hit, true))));
        }
        let data_url = fmt!("data:application/pdf;base64,{}",
            oxedyne_fe2o3_text::base64::encode(bytes));
        // Free text layer first: a born-digital PDF is done here, at no cost.
        let free = res!(ctx.host().net().openrouter_chat(
            &ocr_pdf_body(&data_url, PDF_ENGINE_FREE)).await);
        let mut text   = ocr_pdf_text(&free);
        let mut engine = "the free text layer".to_string();
        let mut paid   = false;
        let mut pages: Option<u32> = None;
        // Empty means a scanned page with no text layer.  Escalate to paid OCR with no
        // gate and no prompt -- the cost is stated in the note, after the fact.
        if ocr_text_empty(&text) {
            let ocr = res!(ctx.host().net().openrouter_chat(
                &ocr_pdf_body(&data_url, PDF_ENGINE_OCR)).await);
            text   = ocr_pdf_text(&ocr);
            engine = PDF_ENGINE_OCR.to_string();
            paid   = true;
            pages  = pdf_page_count(bytes);
        }
        if text.trim().is_empty() {
            return Err(err!(
                "file_read: '{}' is a PDF, but neither the free text layer nor OCR returned \
                any text -- it may hold no text at all, or be an image the OCR could not read. \
                file_show puts it on the user's screen.", path; Invalid, Data));
        }
        let hit = OcrHit { text, what: "a PDF", engine, pages, paid };
        OCR_CACHE.with(|c| { c.borrow_mut().insert(hash, hit.clone()); });
        Ok(MessageContent::text(Self::mark_if_from(
            ctx, path, stranger, Self::ocr_view(args_json, path, &hit, false))))
    }

    /// The generic OCR entry point: read the text off a PDF or a common image.
    ///
    /// A PDF here means "OCR this", so it goes straight to `mistral-ocr` rather than the
    /// free-first ladder `file_read` uses -- the explicit call has said the pages are
    /// pictures.  A common bitmap (PNG, JPEG, WebP, GIF) is transcribed by Mistral's OCR,
    /// or a vision model where no Mistral key is set.  An uncommon format the services will
    /// not take (TIFF, HEIC, BMP, ...) is NAMED and turned away rather than failing quietly.
    /// Either way only the words reach the turn; the picture stops at the throwaway call.
    pub(super) async fn ocr<H: Host>(args_json: &str, ctx: &ToolContext<H>) -> Outcome<MessageContent> {
        let raw  = res!(Self::arg(args_json, "path"));
        let path = res!(Self::scoped(ctx, &raw));
        let bytes = res!(ctx.host().fs().read_file(ctx.root, &path).await
            .map_err(|e| err!(e, "ocr: cannot read '{}'.", raw; IO, File, Read)));
        // Whose words the picture carries is judged as `file_read` judges it: by the spelling and
        // by where the path lands (U10), so `mail/x.png` read from `~/usr` is a stranger's.
        // A test's red: `ocr_landing` off, the spelling alone, as `ocr` judged it before RW-CF3.
        let stranger = match engine_rule_off("ocr_landing") {
            true  => is_untrusted_path(&raw),
            false => ws_stranger(ctx, &raw, &path),
        };
        let hash = content_hash(&bytes);
        if let Some(hit) = OCR_CACHE.with(|c| c.borrow().get(&hash).cloned()) {
            return Ok(MessageContent::text(Self::mark_if_from(
                ctx, &raw, stranger, Self::ocr_view(args_json, &raw, &hit, true))));
        }
        // A PDF given to `ocr` is a request to OCR it: `mistral-ocr` straight away, since
        // the caller has said its pages are images. `file_read` keeps the free-first path.
        if Media::sniff(&bytes) == Media::Pdf {
            let data_url = fmt!("data:application/pdf;base64,{}",
                oxedyne_fe2o3_text::base64::encode(&bytes));
            let body = res!(ctx.host().net().openrouter_chat(
                &ocr_pdf_body(&data_url, PDF_ENGINE_OCR)).await);
            let text = ocr_pdf_text(&body);
            if text.trim().is_empty() {
                return Err(err!(
                    "ocr: '{}' is a PDF the OCR returned no text for -- it may hold none.", raw;
                    Invalid, Data));
            }
            let hit = OcrHit {
                text, what: "a PDF", engine: PDF_ENGINE_OCR.to_string(),
                pages: pdf_page_count(&bytes), paid: true,
            };
            OCR_CACHE.with(|c| { c.borrow_mut().insert(hash, hit.clone()); });
            return Ok(MessageContent::text(Self::mark_if_from(
                ctx, &raw, stranger, Self::ocr_view(args_json, &raw, &hit, false))));
        }
        // A picture: each page as one the OCR services accept, converted here where the file
        // is in any other format this can read, and the pages' text joined in order.
        let urls = res!(ocr_images(&raw, &bytes));
        let mut parts: Vec<String> = Vec::with_capacity(urls.len());
        let mut engine = String::new();
        let mut pages: Option<u32> = Some(0);
        for data_url in &urls {
            let (route, body) = res!(ctx.host().net().image_ocr(
                &ocr_image_mistral_body(data_url), &ocr_image_vision_body(data_url)).await);
            let (t, e, n) = match route.as_str() {
                "mistral" => (ocr_mistral_text(&body), "Mistral OCR",
                              ocr_mistral_pages(&body).or(Some(1))),
                _         => (ocr_vision_text(&body), "a vision model", Some(1)),
            };
            parts.push(t);
            engine = e.to_string();
            pages = match (pages, n) {
                (Some(a), Some(b)) => Some(a + b),
                _                  => None,
            };
        }
        let (text, paid) = (parts.join("\n\n"), true);
        if text.trim().is_empty() {
            return Err(err!(
                "ocr: '{}' returned no text -- the image may carry none, or be one the reader \
                could not make out.", raw; Invalid, Data));
        }
        let hit = OcrHit { text, what: "an image", engine, pages, paid };
        OCR_CACHE.with(|c| { c.borrow_mut().insert(hash, hit.clone()); });
        Ok(MessageContent::text(Self::mark_if_from(
            ctx, &raw, stranger, Self::ocr_view(args_json, &raw, &hit, false))))
    }

    /// The windowed transcript plus the engine/cost note the two OCR paths share.
    pub(super) fn ocr_view(args_json: &str, path: &str, hit: &OcrHit, cached: bool) -> String {
        let tag = "file_read";
        let mut out = Self::read_view(args_json, path, &hit.text);
        out.push_str(&ocr_note(tag, hit.what, &hit.engine, hit.pages, hit.paid));
        if cached {
            out.push_str(" Cached from an earlier read, so this one was free.");
        }
        out
    }

    /// `state_set`: one keyed section of the Diamond's `STATE.md`, landed through `file_write`'s
    /// own door so the fence, the version capture and the store's section landing (never
    /// refused; what it replaces retires) all apply as they do to a whole-file write.  It reads
    /// the file itself, through the host, so that read is what it has seen.
    pub(super) async fn state_set<H: Host>(args_json: &str, ctx: &ToolContext<H>) -> Outcome<MessageContent> {
        let path = match state_path(ctx.daimon().as_deref()) {
            Ok(p)  => p,
            Err(e) => return Ok(MessageContent::text(refusal_line(&e.plain()))),
        };
        let key  = res!(Self::arg(args_json, "key"));
        let text = extract_json_string(args_json, "text");
        if let Some(why) = crate::state_md::set_refusal(&key, text.as_deref()) {
            return Ok(MessageContent::text(why));
        }
        let text = text.unwrap_or_default();
        let at   = stored_in(ctx, &path);
        // A STATE.md that stands but will not read is refused (QA2), never set from empty and
        // its rewrite -- the one section alone -- written over it.
        let now  = match Self::before_bytes(ctx, &path).await {
            Ok(b)    => b,
            Err(why) => return Ok(MessageContent::text(refusal_line(&fmt!(
                "'{}' would not read ({}), so nothing was set in it.", path, why)))),
        };
        let was  = now.as_deref().map(|b| String::from_utf8_lossy(b).into_owned())
            .unwrap_or_default();
        if let Some(b) = &now {
            lock_cache(&ctx.read_seen).seen.insert(&at, &path, content_hash(b));
        }
        // A rename's retired section goes out in this same write (UNBLOCK-52): whole, or not at all.
        let replaces = extract_json_string(args_json, "replaces");
        let next = crate::state_md::set_replacing(&was, &key, &text, replaces.as_deref());
        let args = fmt!("{{\"path\":\"{}\",\"content\":\"{}\"}}",
            crate::llm::json_escape(&path), crate::llm::json_escape(&next));
        Self::file_write_page(&args, ctx).await
    }

}
