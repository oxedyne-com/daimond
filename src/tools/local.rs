use super::*;

impl Tool {
    /// Read several files in one call, each under its own header (native).
    ///
    /// **One round for a small tree.** The rounds census of 2026-09-13 measured Claude Code
    /// reading a whole fixture with a single `cat src/*.js test/*.js` while a daimon spent three
    /// to six rounds at two or three files each -- about fourteen rounds over the valid trials,
    /// spent entirely on getting the files in front of itself.
    ///
    /// A pattern is expanded through `file_glob` rather than by walking here, so that one piece
    /// of code decides which paths a pattern names -- the marks, the bounds, the skipped
    /// directories and the walk budget all apply, and they apply the same way they do to a glob
    /// the model wrote itself.
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn local_read_many<H: Host>(args: &str, asked: &[String], ctx: &ToolContext<H>) -> Outcome<MessageContent> {
        if let Some(why) = read_many_window_refusal(args) {
            return Ok(MessageContent::text(refusal_line(&why)));
        }
        let mut want: Vec<String> = Vec::new();
        for a in asked {
            if is_pattern(a) {
                let listing = res!(Self::local_file_glob(&fmt!(
                    r#"{{"pattern":"{}","limit":{}}}"#, json_escape(a), READ_MANY_MAX), ctx));
                // Folder-relative as listed (`shown`); read root-relative, as `asked` is (M3).
                for p in glob_paths(&listing) {
                    let p = ctx.workspace.based(&p);
                    if !want.contains(&p) { want.push(p); }
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
            let abs = match ctx.workspace.resolve_followed(path) {
                Ok(Some(a)) if !real_admits(ctx, path, &a, false) => {
                    out.push_str(&fmt!("== {} == not read: {}\n\n", path,
                        link_inward_refusal("file_read", path)));
                    continue;
                },
                Ok(Some(a)) => a,
                Ok(None)    => {
                    out.push_str(&fmt!("== {} == not read: {}\n\n", path,
                        link_escape_refusal("file_read", path)));
                    continue;
                },
                Err(e) => {
                    out.push_str(&fmt!("== {} == not read: {}\n\n", path, e.plain()));
                    continue;
                },
            };
            if abs.is_dir() {
                out.push_str(&fmt!(
                    "== {} == a directory, not a file; file_list says what is in it.\n\n", path));
                continue;
            }
            let data = match std::fs::read(&abs) {
                Ok(d)  => d,
                Err(e) => {
                    out.push_str(&fmt!("== {} == not read: {}\n\n", path, e));
                    continue;
                },
            };
            if is_binary(&data) {
                out.push_str(&fmt!(
                    "== {} == {} bytes and not text; read it on its own to be told what it \
                    is.\n\n", path, data.len()));
                continue;
            }
            let text  = String::from_utf8_lossy(&data).to_string();
            let block = Self::mark_if_from(ctx, path, ws_stranger(ctx, path, path),
                read_many_block(path, &text));
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

    /// Read a file (native).
    ///
    /// An image comes back as an image, not as a refusal: the bytes are sniffed before the binary
    /// test runs, so a PNG takes the image path and an MP3 still takes the refusal. See
    /// [`image_result`].
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn local_file_read<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<MessageContent> {
        // Several files, or a pattern: a different answer with a different shape, and the single
        // read below is untouched by it.
        if let Some(asked) = read_many_ask(args) {
            return Self::local_read_many(args, &asked, ctx);
        }
        let path = res!(Self::arg(args, "path"));
        let abs = match res!(followed(ctx, "file_read", &path)) {
            Ok(p)    => p,
            Err(why) => return Ok(MessageContent::text(why)),
        };
        // A DIRECTORY, said as a directory. `std::fs::read` on one answers "Is a directory"
        // through the OS, which reaches the model wrapped in two error frames and a file name
        // and reads as the path being wrong. Watched happening: a daimon adding one key to
        // eight locale files called `file_read` on `www/i18n`, got that, and spent the call.
        // The name of the tool that answers this question costs one sentence.
        if abs.is_dir() {
            return Err(err!(
                "file_read: '{}' is a directory, not a file. file_list answers what is in it, \
                and file_search looks inside everything under it.", path; Invalid, Input));
        }
        let data = res!(std::fs::read(&abs)
            .map_err(|e| err!(e, "file_read: cannot read '{}'.", path; IO, File, Read)));
        let want = Want::read(args);
        // A picture the model APIs do not take: see the same branch on the browser path.
        if let Some(got) = converted_picture(&path, &data) {
            let (media, common) = res!(got);
            return image_result(ctx, &path, media, common, want);
        }
        if let Want::Base64 = want {
            let mime = match ImageMedia::sniff(&data) {
                Some(m) => m.mime(),
                None if looks_like_svg(&data) => "image/svg+xml",
                None if is_binary(&data)      => "application/octet-stream",
                None                          => "text/plain",
            };
            return base64_result(ctx, &path, mime, data);
        }
        if let Some(media) = ImageMedia::sniff(&data) {
            return image_result(ctx, &path, media, data, want);
        }
        // Before the binary refusal: see the same branch on the browser path.
        if let Some(got) = office_view(&path, &data) {
            let (md, note) = res!(got);
            return Ok(MessageContent::text(Self::mark_if_from(
                ctx, &path, ws_stranger(ctx, &path, &path),
                fmt!("{}{}", Self::read_view(args, &path, &md), note))));
        }
        if is_binary(&data) {
            if let Want::Base64 = want {
                return base64_result(ctx, &path, "application/octet-stream", data);
            }
            return Err(binary_refusal(&path, data.len()));
        }
        let s = String::from_utf8_lossy(&data).to_string();
        let stranger = ws_stranger(ctx, &path, &path);
        Ok(MessageContent::text(Self::mark_if_from(ctx, &path, stranger,
            Self::read_view_of(args, &path, stranger, &s, None))))
    }

    /// Read a rectangle of a spreadsheet, on the native build.
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn local_sheet_read<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let path = res!(Self::arg(args, "path"));
        let abs = match res!(followed(ctx, "sheet_read", &path)) {
            Ok(p)    => p,
            Err(why) => return Ok(why),
        };
        let data = res!(std::fs::read(&abs)
            .map_err(|e| err!(e, "sheet_read: cannot read '{}'.", path; IO, File, Read)));
        let view = res!(sheet_view(&path, &data, args));
        Ok(Self::mark_if_untrusted(ctx, &path, view))
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn local_file_write<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let path = res!(Self::arg(args, "path"));
        let content = res!(Self::arg(args, "content"));
        let abs = match res!(followed(ctx, "file_write", &path)) {
            Ok(p)    => p,
            Err(why) => return Ok(why),
        };
        if let Some(parent) = abs.parent() {
            res!(std::fs::create_dir_all(parent)
                .map_err(|e| err!(e, "file_write: cannot create parent dirs for '{}'.", path; IO, File)));
        }
        // A path naming an Office document means the content is MARKDOWN and the file is a document.
        // The name decides, not the bytes: `.docx` is what the user will double-click.
        if let Some(media) = office_kind(&path) {
            let (bytes, note) = res!(office_written(&path, media, &content));
            res!(std::fs::write(&abs, &bytes)
                .map_err(|e| err!(e, "file_write: cannot write '{}'.", path; IO, File, Write)));
            return Ok(fmt!("Wrote {} bytes to {}.{}", bytes.len(), path, note));
        }
        res!(std::fs::write(&abs, content.as_bytes())
            .map_err(|e| err!(e, "file_write: cannot write '{}'.", path; IO, File, Write)));
        Ok(fmt!("Wrote {} bytes to {}.", content.len(), path))
    }

    /// Replaces text in a document, on the native transport.
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn local_doc_edit<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let path = res!(Self::arg(args, "path"));
        let media = res!(office_kind(&path).ok_or_else(|| err!(
            "doc_edit: '{}' does not name a document. It edits .docx and .odt; ordinary text files             are edited with file_edit.", path; Invalid, Input)));
        let abs = match res!(followed(ctx, "doc_edit", &path)) {
            Ok(p)    => p,
            Err(why) => return Ok(why),
        };
        let bytes = res!(std::fs::read(&abs)
            .map_err(|e| err!(e, "doc_edit: cannot read '{}'.", path; IO, File, Read)));
        let (out, note) = res!(doc_edited(&path, media, &bytes, args));
        res!(std::fs::write(&abs, &out)
            .map_err(|e| err!(e, "doc_edit: cannot write '{}'.", path; IO, File, Write)));
        Ok(fmt!("Edited {}, now {} bytes.{}", path, out.len(), note))
    }

    /// Writes cells into a spreadsheet, on the native transport.
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn local_sheet_write<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let path = res!(Self::arg(args, "path"));
        let media = res!(office_kind(&path).ok_or_else(|| err!(
            "sheet_write: '{}' does not name a spreadsheet. It writes .xlsx and .ods.", path;
            Invalid, Input)));
        let abs = match res!(followed(ctx, "sheet_write", &path)) {
            Ok(p)    => p,
            Err(why) => return Ok(why),
        };
        let bytes = res!(std::fs::read(&abs)
            .map_err(|e| err!(e, "sheet_write: cannot read '{}'.", path; IO, File, Read)));
        let (out, note) = res!(sheet_written(&path, media, &bytes, args));
        res!(std::fs::write(&abs, &out)
            .map_err(|e| err!(e, "sheet_write: cannot write '{}'.", path; IO, File, Write)));
        Ok(fmt!("Wrote to {}, now {} bytes.{}", path, out.len(), note))
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn local_file_edit<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let path = res!(Self::arg(args, "path"));
        let hunks = res!(edit_hunks(args, &path));
        let abs = match res!(followed(ctx, "file_edit", &path)) {
            Ok(p)    => p,
            Err(why) => return Ok(why),
        };
        let data = res!(std::fs::read_to_string(&abs)
            .map_err(|e| err!(e, "file_edit: cannot read '{}'.", path; IO, File, Read)));
        let (updated, relaxed, missed) = res!(file_edited(&path, &data, &hunks));
        res!(std::fs::write(&abs, updated.as_bytes())
            .map_err(|e| err!(e, "file_edit: cannot write '{}'.", path; IO, File, Write)));
        Ok(fmt!("{}{}{}", Self::edit_said(&path, hunks.len()), relaxed_said(&relaxed), missed))
    }

    /// What an edit reports, which says how many hunks landed when there was more than one.
    ///
    /// A model told only "Edited x.rs" after sending six hunks cannot tell a six-hunk success
    /// from a one-hunk one, and the all-or-nothing contract is only useful if the confirmation
    /// states what it is confirming.
    pub(super) fn edit_said(path: &str, hunks: usize) -> String {
        if hunks == 1 {
            fmt!("Edited {}.", path)
        } else {
            fmt!("Edited {}, {} edit(s) applied.", path, hunks)
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn local_file_list<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let path = extract_json_string(args, "path").unwrap_or_else(|| ".".to_string());
        let abs = match res!(followed(ctx, "file_list", &path)) {
            Ok(p)    => p,
            Err(why) => return Ok(why),
        };
        let mut entries = res!(std::fs::read_dir(&abs)
            .map_err(|e| err!(e, "file_list: cannot list '{}'.", path; IO, File, Read)))
            .filter_map(|e| e.ok())
            .map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let is_dir = e.path().is_dir();
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                (is_dir, name, size)
            })
            .collect::<Vec<_>>();
        entries.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1))); // dirs first, then name
        // The bound, per entry: see the hosted arm.
        let before = entries.len();
        entries.retain(|(d, n, _)| {
            let rel = list_child(&path, n);
            ctx.may_list(&rel, *d) && real_admits(ctx, &rel, &abs.join(n), false)
        });
        let hidden = before - entries.len();
        if entries.is_empty() && hidden > 0 {
            return Ok(list_hidden_note(hidden));
        }
        if entries.is_empty() {
            return Ok(fmt!("{} is empty.", path));
        }
        // One page of entries (HATE-17): from `offset`, until `list_bytes` is spent. The first
        // entry of a page is always shown, so paging always moves.
        let total = entries.len();
        let from = uint_arg(args, "offset", 0, usize::MAX).min(total);
        let cap = output_caps().list_bytes;
        let mut out = String::new();
        let mut shown = 0usize;
        for (is_dir, name, size) in entries.iter().skip(from) {
            let line = if *is_dir {
                fmt!("{}/\n", name)
            } else {
                fmt!("{}  ({} bytes)\n", name, size)
            };
            if shown > 0 && out.len() + line.len() > cap {
                break;
            }
            out.push_str(&line);
            shown += 1;
        }
        if from + shown < total {
            out.push_str(&fmt!(
                "[file_list] entries {} to {} of {}; {} more are NOT shown. To find a file by \
                name use file_glob with a pattern ('dev/*check*'), or page on with \"offset\":{}.\n",
                from + 1, from + shown, total, total - from - shown, from + shown));
        }
        if hidden > 0 {
            out.push_str(&list_hidden_note(hidden));
        }
        Ok(out)
    }

    /// Delete one regular file (native).  A folder, a link, anything outside the workspace and
    /// anything reached through a link out of it is refused as a result the model reads.
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn local_file_delete<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let path = res!(Self::arg(args, "path"));
        if let Some(why) = delete_path_refusal(&path) {
            return Ok(refusal_line(&why));
        }
        // Held, not just checked: the delete acts in the folder that was proved inside the root.
        let pin = match res!(ctx.workspace.pin(&path, false)) {
            Some(p) => p,
            None    => return Ok(refusal_line(&link_escape_refusal("file_delete", &path))),
        };
        // Judged by where it really is, as every native write is (U3a QC1 L2).
        if !admits_real(ctx, &path, pin.real(), true) {
            return Ok(refusal_line(&link_inward_refusal("file_delete", &path)));
        }
        let abs = pin.act();
        // Not followed: a link at the leaf is the link, and removing it is the user's call.
        let meta = res!(std::fs::symlink_metadata(&abs)
            .map_err(|e| err!(e, "file_delete: '{}' is not there.", path; IO, File, Missing)));
        if meta.is_dir() {
            return Ok(refusal_line(&delete_dir_refusal(&path)));
        }
        if !meta.is_file() {
            return Ok(refusal_line(&fmt!(
                "'{}' is a link or a special file rather than an ordinary file. {}",
                path, DELETE_ASK)));
        }
        res!(std::fs::remove_file(&abs)
            .map_err(|e| err!(e, "file_delete: cannot delete '{}'.", path; IO, File)));
        Ok(fmt!("Deleted {}.", path))
    }

    /// Compose a search result from the matching lines the user wrote and the ones a stranger did.
    ///
    /// The two are kept apart rather than interleaved, because a match line carries file content
    /// and one envelope round the stranger's lines is the only way to say which of them is which.
    ///
    /// # Arguments
    /// * `ctx` - The context, which records that the turn read untrusted content.
    /// * `query` - What was searched for, for the empty answer.
    /// * `trusted` - Match lines from the user's own files.
    /// * `untrusted` - Match lines from files written by a stranger.
    /// * `notes` - The account of what was and was not searched.
    /// * `partial` - Whether the walk stopped before it had seen the whole tree, which is the
    ///   difference between "there is no such line" and "there is none in the part that was read".
    pub(super) fn search_output<H: Host>(
        ctx:        &ToolContext<H>,
        query:      &str,
        trusted:    Vec<String>,
        untrusted:  Vec<String>,
        notes:      &str,
        partial:    bool,
    )
        -> String
    {
        let mut out = if trusted.is_empty() && untrusted.is_empty() {
            // The sentence itself changes, and not only the notes below it: this line is the one
            // a reader takes the answer from, and on a stopped walk the flat form of it is false.
            if partial {
                fmt!("No matches for '{}' in the part of the tree this call reached.", query)
            } else {
                fmt!("No matches for '{}'.", query)
            }
        } else {
            trusted.join("\n")
        };
        // The account of what was searched goes with the user's own matches and BEFORE the
        // stranger's, so the result still ends with the closing marker.  A result that ended
        // inside an envelope would leave every later result reading as a stranger's words.
        out.push_str(notes);
        if !untrusted.is_empty() {
            let origin = fmt!("{}/ — search matches", MAIL_ROOT);
            out.push_str(&ctx.wrap_untrusted(&origin, &untrusted.join("\n")));
        }
        out
    }

    /// One directory's entries, in name order, so a walk is repeatable (native).
    ///
    /// Repeatability is not tidiness: `offset` pages through a search's matches, and a page of a
    /// walk whose order changed between calls would skip files and repeat others.
    ///
    /// `None` where the directory would not open at all, which until 2026-08-25 was an empty
    /// `Vec` and therefore indistinguishable from a directory holding nothing. Both callers
    /// count it now and say so: see [`unopened_residue`].
    ///
    /// # Arguments
    /// * `dir` - The directory to read.
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn local_sorted_entries(dir: &std::path::Path) -> Option<Vec<(String, std::path::PathBuf, bool)>> {
        let rd = match std::fs::read_dir(dir) {
            Ok(r)  => r,
            Err(_) => return None,
        };
        let mut out: Vec<(String, std::path::PathBuf, bool)> = rd
            .filter_map(|e| e.ok())
            .map(|e| {
                let p = e.path();
                let is_dir = p.is_dir();
                (e.file_name().to_string_lossy().to_string(), p, is_dir)
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Some(out)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn local_file_search<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let query = res!(Self::arg(args, "query"));
        let opts = res!(search_opts(args));
        // Where to look, which is the turn's marks when the call did not say. See `walk_starts`.
        let starts = walk_starts(args, ctx);
        let path = starts_named(&starts);
        let mut trusted: Vec<String> = Vec::new();
        // Match lines from under `mail/`, which are a stranger's words and go in an envelope.
        let mut untrusted: Vec<String> = Vec::new();
        let mut stats = SearchStats::default();
        // What this walk could not open, counted rather than skipped in silence: see
        // `unopened_residue`, and `dev/BLOCKERS.md` B1.
        let mut unopened = 0usize;
        let mut unread   = 0usize;
        // The bound on the WALK, as against the bound on the answer that `limit` is.  A search
        // that matches nothing walks every file there is, and on a large enough folder it never
        // comes back.
        let mut budget = WalkBudget::new();
        // Reversed so the first mark is popped first: a walk over several marks should reach the
        // one the user named first before it spends its budget on the others.
        let mut stack: Vec<std::path::PathBuf> = Vec::new();
        for st in starts.iter().rev() {
            match res!(followed(ctx, "file_search", st)) {
                Ok(p)    => stack.push(p),
                Err(why) => return Ok(why),
            }
        }
        'walk: while let Some(dir) = stack.pop() {
            let (dir, entries) = match Self::local_sorted_entries(&dir) {
                Some(e) => (dir, e),
                // A START THAT IS A FILE IS SEARCHED AS THAT FILE: it is walked as its folder
                // holding only it.  It used to count as a directory that would not open, and the
                // answer was "No matches ... 0 file(s) searched" about a file nobody read (the
                // Ontheism crystal, 2026-10-08, finding 4).
                None => match (dir.is_file(), dir.parent(), dir.file_name()) {
                    (true, Some(up), Some(leaf)) => {
                        let name = leaf.to_string_lossy().into_owned();
                        (up.to_path_buf(), vec![(name, dir.clone(), false)])
                    },
                    _ => { unopened += 1; continue; },
                },
            };
            let here = ctx.workspace.display_rel(&dir);
            // Sub-directories are pushed in reverse so they pop in name order, which makes the
            // whole walk a repeatable pre-order -- what `offset` needs to page honestly.
            for (name, p, is_dir) in entries.iter().rev() {
                if *is_dir {
                    // Charged before the skip test, and so charged for every entry the walk lays
                    // eyes on: what costs the browser a round trip is reading the entry, not
                    // deciding to descend into it.
                    if !budget.spend(&here) {
                        break; // out of budget: stop growing the walk, and stop below
                    }
                    if opts.walk.skips(name) {
                        stats.skipped += 1;
                        continue;
                    }
                    // Never descend a folder a link carries out of bounds (QA1 F2).
                    if !real_admits(ctx, &ctx.workspace.display_rel(p), p, false) {
                        stats.refused += 1;
                        continue;
                    }
                    stack.push(p.clone());
                }
            }
            for (_, p, is_dir) in &entries {
                if *is_dir {
                    continue;
                }
                if !budget.spend(&here) {
                    break 'walk;
                }
                let rel = ctx.workspace.display_rel(p);
                // The bound, per file, because a walk reaches what the door was never shown.
                // `guard` checks the ONE path a call names, and a search names a starting point --
                // so under a deny-list bound the start is `.`, which no `NoRead` prefix covers,
                // and every file beneath it was read.  This is the same test `file_read` makes,
                // asked once per file rather than once per call.
                if !ctx.may_read(&rel) || !real_admits(ctx, &rel, p, false) {
                    stats.refused += 1;
                    continue;
                }
                // Asked of the path as shown too: the model writes the filter relative to the
                // folder base (F2-FIX M3).
                if let Some(g) = &opts.glob {
                    if !g.matches(&rel) && !g.matches(&ctx.workspace.shown(&rel)) {
                        stats.filtered += 1;
                        continue;
                    }
                }
                // NO SIZE CEILING. It used to be two million bytes, which is how the app's own
                // largest source file came to be the one file its own search could not read.
                // The file is consumed a line at a time now, so its size costs one buffer.
                let file = match std::fs::File::open(p) {
                    Ok(f)  => f,
                    // A file that would not open is a file whose contents are unknown, which is
                    // not the same as a file the pattern did not match.
                    Err(_) => { unread += 1; continue; },
                };
                let mut reader = std::io::BufReader::with_capacity(
                    SEARCH_CHUNK_BYTES as usize, file);
                // Lossy-decoding a binary file used to let its bytes match and be quoted back as
                // though they were source.  Asked of the HEAD rather than of the whole file: a
                // real binary declares itself in its first bytes (see `is_binary`), and reading
                // a file twice to be sure is the cost this whole change is about.
                {
                    use std::io::BufRead;
                    let head = match reader.fill_buf() {
                        Ok(h)  => h,
                        Err(_) => { unread += 1; continue; },
                    };
                    // Trimmed to a character boundary first: the buffer ends where the read
                    // ended, which is mid-character about three times in four, and an
                    // incomplete tail would make every such file read as binary.
                    if is_binary(whole_chars(head)) {
                        stats.binary += 1;
                        continue;
                    }
                }
                stats.files += 1;
                let out = if is_untrusted_path(&rel) { &mut untrusted } else { &mut trusted };
                let mut src = ReaderLines::new(reader);
                if !res!(scan_source(&opts, &ctx.workspace.shown(&rel), &mut src, &mut stats, out)) {
                    break 'walk;
                }
            }
        }
        budget.unwalked(stack.len());
        if let Some(e) = stopped_empty("file_search", &path, &budget, stats.matched) {
            if extract_json_bool(args, "all").unwrap_or(false) {
                return Ok(stopped_wide("file_search", &path));
            }
            return Err(e);
        }
        let mut notes = search_notes(&opts, &stats, &budget, &path);
        notes.push_str(&unopened_residue("file_search", unopened, unread));
        Ok(Self::search_output(ctx, &query, trusted, untrusted, &notes, budget.spent()))
    }


    /// Map a file, reading it a line at a time (native).
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn local_outline<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let path = res!(Self::arg(args, "path"));
        let opts = res!(outline_opts(args));
        let lang = match OutlineLang::of(&path) {
            Some(l) => l,
            None    => return Ok(outline_no_scanner(&path)),
        };
        let abs = match res!(followed(ctx, "outline", &path)) {
            Ok(p)    => p,
            Err(why) => return Ok(why),
        };
        if abs.is_dir() {
            return Err(err!(
                "outline: '{}' is a directory, not a file. file_list answers what is in it.",
                path; Invalid, Input));
        }
        let bytes = match std::fs::metadata(&abs) {
            Ok(m)  => m.len() as usize,
            Err(e) => return Err(err!(e, "outline: cannot read '{}'.", path; IO, File, Read)),
        };
        let file = res!(std::fs::File::open(&abs)
            .map_err(|e| err!(e, "outline: cannot read '{}'.", path; IO, File, Read)));
        let mut src = ReaderLines::new(
            std::io::BufReader::with_capacity(SEARCH_CHUNK_BYTES as usize, file));
        let mut scan = OutlineScan::new(lang);
        while let Some((n, line)) = res!(src.next_line()) {
            scan.feed(n, &line);
        }
        let (items, lines) = scan.finish();
        Ok(outline_report(&path, lines, bytes, &items, &opts))
    }
    /// Find files by path pattern, reading none of them (native).
    ///
    /// # Arguments
    /// * `args` - The raw tool arguments: `pattern`, and optionally `path`, `limit` and `all`.
    /// * `ctx` - The context, whose workspace the walk is rooted in.
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn local_file_glob<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let pattern = res!(Self::arg(args, "pattern"));
        let glob = res!(Glob::new(pattern.trim()).map_err(|e| err!(e,
            "file_glob: 'pattern' is not a glob this build can read."; Invalid, Input)));
        let starts = walk_starts(args, ctx);
        let path = starts_named(&starts);
        let all = extract_json_bool(args, "all").unwrap_or(false);
        let walk = Skips::new(all, &[&path, &pattern]);
        let (limit, page) = GlobPage::of(args);
        let mut hits: Vec<GlobHit> = Vec::new();
        let mut skipped = 0usize;
        let mut refused = 0usize;
        // See the same line in `file_search`, and the reason there.
        let mut unopened = 0usize;
        // The bound on the WALK.  `limit` bounds what comes back, which on a `**` pattern over a
        // machine folder is a handful of paths found by looking at everything there is.
        let mut budget = WalkBudget::new();
        // Each directory with the start its walk came from ([`glob_hits`]).
        let mut stack: Vec<(std::path::PathBuf, String)> = Vec::new();
        for st in starts.iter().rev() {
            match res!(followed(ctx, "file_glob", st)) {
                Ok(p)    => {
                    let from = ctx.workspace.display_rel(&p);
                    stack.push((p, from));
                },
                Err(why) => return Ok(why),
            }
        }
        'walk: while let Some((dir, from)) = stack.pop() {
            let here = ctx.workspace.display_rel(&dir);
            let entries = match Self::local_sorted_entries(&dir) {
                Some(e) => e,
                None    => { unopened += 1; continue; },
            };
            for (name, p, is_dir) in entries {
                if !budget.spend(&here) {
                    break 'walk;
                }
                if is_dir {
                    if walk.skips(&name) {
                        skipped += 1;
                        continue;
                    }
                    // Never descend a folder a link carries out of bounds (QA1 F2).
                    if !real_admits(ctx, &ctx.workspace.display_rel(&p), &p, false) {
                        refused += 1;
                        continue;
                    }
                    stack.push((p, from.clone()));
                    continue;
                }
                let rel = ctx.workspace.display_rel(&p);
                // The bound, per path.  `file_glob` reads nothing, but a path is itself
                // information -- the name of a skill nobody was told about, a file in a folder
                // this turn may not open -- and the tool that lists it must answer by the same
                // rule as the tool that opens it.
                if !ctx.may_read(&rel) || !real_admits(ctx, &rel, &p, false) {
                    refused += 1;
                    continue;
                }
                if !glob_hits(&glob, &rel, &rel, &from) {
                    continue;
                }
                // Nanoseconds since the epoch, and `None` where the platform will not say -- which
                // sorts the file last and is REPORTED as an absence, rather than pretending it
                // was written in 1970 on purpose.
                let when = std::fs::metadata(&p).ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos() as u64);
                // Written back as the model writes it (UNBLOCK-32 F2b: relative to a folder base).
                hits.push(GlobHit { path: ctx.workspace.shown(&rel), when });
            }
        }
        budget.unwalked(stack.len());
        if let Some(e) = stopped_empty("file_glob", &path, &budget, hits.len()) {
            if all {
                return Ok(stopped_wide("file_glob", &path));
            }
            return Err(e);
        }
        let mut out = Self::glob_output(
            &pattern, &path, hits, limit, page, skipped, refused, walk, &budget, "");
        out.push_str(&unopened_residue("file_glob", unopened, 0));
        Ok(out)
    }

    /// Compose a `file_glob` result: the paths, then what the walk did not look in.
    ///
    /// # Arguments
    /// * `pattern` - The pattern, for the summary line.
    /// * `path` - Where the walk started.
    /// * `hits` - What matched.
    /// * `limit` - The most paths to report.
    /// * `skipped` - How many directories were passed over by name.
    /// * `refused` - How many paths this turn's bounds put out of reach.
    /// * `walk` - Which directories this call passed over, and which it walked because it was
    ///   asked to by name.
    /// * `budget` - The entry budget, which says whether the whole tree was walked.
    /// * `here` - The note saying which filesystem an EMPTY answer is about, or empty.
    pub(super) fn glob_output(
        pattern:    &str,
        path:       &str,
        mut hits:   Vec<GlobHit>,
        limit:      usize,
        page:       GlobPage,
        skipped:    usize,
        refused:    usize,
        walk:       Skips,
        budget:     &WalkBudget,
        here:       &str,
    )
        -> String
    {
        let found = hits.len();
        // Most recently written first, ties broken by path so the order is repeatable.  `None`
        // orders below every `Some`, so the paths whose time nobody knows fall to the end in path
        // order -- which is the only order they have -- without a second pass sorting the ones
        // that DO know back into alphabetical.
        hits.sort_by(|a, b| b.when.cmp(&a.when).then(a.path.cmp(&b.path)));
        // The page this call asked for: from `offset`, at most `limit` paths and, where the call
        // named no limit, at most `page.bytes` of them (HATE-17). The first path of a page is
        // always shown, however long, so a page can never be empty while paths remain.
        let from = page.offset.min(found);
        let column = hits.iter().skip(from).take(limit).any(|h| h.when.is_some());
        let mut shown = 0usize;
        let mut spent = 0usize;
        for h in hits.iter().skip(from).take(limit) {
            let len = h.path.len() + 1 + if column { 21 } else { 0 };
            if shown > 0 && spent + len > page.bytes {
                break;
            }
            spent += len;
            shown += 1;
        }
        let by_bytes = from + shown < found && shown < limit;
        // What is true of THESE paths, counted rather than assumed.  The old flag was a property
        // of the build, and it said "no modification times" over a listing half of which had one.
        let stamped = hits.iter().skip(from).take(shown).filter(|h| h.when.is_some()).count();
        let mut out = String::new();
        for h in hits.iter().skip(from).take(shown) {
            out.push_str(&h.path);
            // The column is dropped when not one path in the result has a time: repeating
            // "unknown" down a whole listing costs tokens to say once what the summary line says
            // better, and there is nothing left for a reader to tell apart.
            if stamped > 0 {
                out.push('\t');
                match h.when {
                    Some(ns) => out.push_str(&iso8601_utc(ns / 1_000_000)),
                    None     => out.push_str(GLOB_NO_TIME),
                }
            }
            out.push('\n');
        }
        if found == 0 {
            // The flat sentence is a claim about the whole tree, and a walk that stopped early
            // has not earned it.  This is the line a reader takes the answer from, so it is the
            // line that has to be true.
            if budget.spent() {
                out.push_str(&fmt!(
                    "No paths matching '{}' turned up in the part of '{}' this call reached.\n",
                    pattern, path));
            } else {
                out.push_str(&fmt!("No paths under '{}' match '{}'.\n", path, pattern));
            }
            // Directly under the answer and above every notice, because it is the line that
            // changes how the answer is to be read: see `walked_here`.
            if !here.is_empty() {
                out.push_str(here.trim_start_matches('\n'));
                out.push('\n');
            }
        }
        // Three states, and the middle one is why this is counted per path.  A workspace with a
        // folder open spans the user's disk and the sandbox at once, so a single result can hold
        // both kinds; saying either thing about all of it would be false about half of it.
        let order = if shown == 0 {
            // An ordering claim over nothing is a claim about files that are not there.
            fmt!("nothing to list")
        } else if stamped == 0 {
            fmt!("in path order — no modification time was recorded for any of them")
        } else if stamped == shown {
            fmt!("most recently modified first, each with the UTC time it was last written")
        } else {
            fmt!("most recently modified first, each with the UTC time it was last written; the \
                last {} carry '{}' because no modification time was recorded for those paths, \
                and they are in path order",
                shown - stamped, GLOB_NO_TIME)
        };
        if from == 0 {
            out.push_str(&fmt!(
                "[file_glob] {} of {} path(s) matching '{}' under '{}', {}.",
                shown, found, pattern, path, order));
        } else {
            out.push_str(&fmt!(
                "[file_glob] paths {} to {} of {} matching '{}' under '{}', {}.",
                from + 1, from + shown, found, pattern, path, order));
        }
        // First among the notices, because it changes how the count above is to be read: `found`
        // is what turned up before the walk stopped, not what is there.
        out.push_str(&budget.notice("file_glob", path,
            "Narrow it and ask again: set 'path' to a directory further down -- the walk had got \
            as far as the one named above -- or write the pattern with a directory in it, so each \
            call has less ground to cover."));
        if found > from + shown {
            let why = if by_bytes {
                fmt!("cut at about {} bytes", page.bytes)
            } else {
                fmt!("cut at {} paths", limit)
            };
            out.push_str(&fmt!(
                "\n[file_glob] {} more are NOT shown ({}). Narrow the pattern or the 'path' -- \
                the usual answer -- or page on with \"offset\":{}.",
                found - from - shown, why, from + shown));
        }
        if skipped > 0 {
            out.push_str(&fmt!(
                "\n[file_glob] NOT walked: {} director(ies) named {} (pass \"all\":true to \
                include them, or name one in 'path' or the pattern to walk just that one).",
                skipped, walk.passed_over().join(", ")));
        }
        // Said out loud, because "you asked for .git and this is what is in it" and "there is
        // nothing here" are the two readings of an empty result, and only one of them is true.
        let named = walk.by_name();
        if !named.is_empty() {
            out.push_str(&fmt!(
                "\n[file_glob] WALKED by name: {} -- normally passed over, walked here because \
                you named it.", named.join(", ")));
        }
        if refused > 0 {
            out.push_str(&fmt!(
                "\n[file_glob] NOT listed: {} path(s) out of bounds for this turn.", refused));
        }
        out.push('\n');
        out
    }

    /// Run a shell command and return what it printed, wrapped as a stranger's words.
    ///
    /// A command's output is the largest unmarked surface there is: a `curl`, a `git log`, the
    /// README of a repository someone else wrote -- all of it lands in the turn, and none of it
    /// was written by the user.  The origin named is the command itself, since that is what the
    /// user can check the text against.
    ///
    /// The exit code sits outside the envelope: it is the one part of this result the command
    /// could not forge, and truncation drops the tail, so inside it would be the first thing lost.
    ///
    /// # Arguments
    /// * `args` - The raw tool arguments: `command`.
    /// * `ctx` - The context, whose executor runs it and whose turn is marked by it.
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) async fn local_shell<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let command = res!(Self::arg(args, "command"));
        let cwd = res!(ctx.workspace.resolve(&ctx.cwd));
        let out = res!(ctx.executor.run(&command, &cwd).await);
        let mut s = String::new();
        if !out.stdout.is_empty() { s.push_str(&out.stdout); }
        if !out.stderr.is_empty() {
            if !s.is_empty() && !s.ends_with('\n') { s.push('\n'); }
            s.push_str("[stderr] ");
            s.push_str(&out.stderr);
        }
        let origin = fmt!("shell: {}", command);
        // Defanged before the cut, for the reason given in `mark_if_untrusted`: quoting a forged
        // marker lengthens the text, and the cut can only drop a tail, never make a new marker.
        s = defang(&s);
        let tail = fmt!("\n[exit code: {}]", out.exit_code);
        // The same gate `run` goes through, for the same reason: this door is the one
        // `examples/devcycle_probe.rs` gives a model, and it had the same hole.
        let room = MAX_OUTPUT.saturating_sub(envelope_overhead(&origin) + tail.len());
        let spent = spend_gate(
            &mut s, SpendCall::Command(&command), spend_cap(args), room, ctx.spend_left());
        let mut whole = fmt!("{}{}", ctx.wrap_untrusted(&origin, &s), tail);
        if let Some(said) = spent {
            whole.push_str(&said);
        }
        Ok(whole)
    }

    /// The default hard limit on a command, and the most a caller may ask for.
    ///
    /// A model that has been told a build is slow will ask for a bigger number, and the honest
    /// ceiling is the one past which the user should be told the command is stuck rather than
    /// waited on further.
    pub(super) const RUN_TIMEOUT_DEFAULT_MS: u64 = 120_000;

    /// The largest `timeout_ms` a caller may ask for.
    pub(super) const RUN_TIMEOUT_MAX_MS: u64 = 900_000;

    /// Run one command on the user's machine through the hand.
    ///
    /// Four things happen here and each is load-bearing:
    ///
    /// 1. **`argv` is taken as an array and never joined.** The moment this function built a
    ///    string it would have re-created the injection surface the whole design exists to avoid.
    /// 2. **The environment is not the model's to set.** There is no `env` argument, deliberately:
    ///    a model that could name environment variables could set `LD_PRELOAD`, or smuggle a
    ///    stolen value out through one. What a command inherits is the user's decision, made once
    ///    when they paired the hand -- and, where they granted a [`Toolkit`], the two or three
    ///    names that toolkit needs, taken from a table here and never from `argv`. The push
    ///    credential is the same rule applied to a secret: it enters the environment of one
    ///    command, chosen by [`git_step`] out of what the user set and never out of `argv`, and it
    ///    is in no other command's environment at all.
    /// 3. **The fence comes from the turn's own bounds** (see [`fence_spec`]), and from nothing
    ///    else. A command reaches exactly the files the same turn's `file_read` would have reached:
    ///    both doors read the one [`ToolContext::no_write`] list, so a Diamond-scoped turn is fenced
    ///    to its own directory and its attachments, and an unscoped turn -- the user's own chat,
    ///    which their file tools may read the whole workspace from -- is fenced to the granted
    ///    folder. What is NOT here is any path derived from `argv`: the fence is the same whichever
    ///    program was asked for, so nothing the model says can widen it.
    ///
    ///    **Which turns are actually scoped, as of this writing.** A dispatched worker is: the
    ///    browser calls [`crate::wasm::DaimondApp::set_diamond_scope`] on every one before its
    ///    first turn, and reads the scope back through
    ///    [`crate::wasm::DaimondApp::diamond_scope`] rather than assuming it took -- a scope that
    ///    failed silently would leave the worker fenced to the whole grant, which is failing open.
    ///    A daimon's own steering turn is scoped THE SAME WAY a worker is, since 2026-08-13:
    ///    [`diamond_bounds`] from the marks the browser reports per turn, and a fence built from
    ///    them like any other. This paragraph used to say it was "confined differently and more
    ///    strongly", pinned to `diamonds/<id>` on the OPFS root, and not offered [`Tool::Run`] at
    ///    all "so there is no fence for it to have" -- and those two halves were one argument. A
    ///    turn confined to browser storage has nowhere on the machine to run anything, so `run`
    ///    would have produced nothing but refusals. The pin went when a daimon proved unable to
    ///    read the book attached to its own Diamond; with it went the reason to withhold the tool,
    ///    and the daimon now holds `run`, `file_show` and `typst_compile` like the turns either
    ///    side of it. The user's own chat is deliberately unscoped, as the paragraph above says.
    ///
    ///    For most of a day this paragraph described a design and not the code: nothing anywhere
    ///    called `set_diamond_scope`, so no turn in the browser carried an allow-list and every
    ///    command took `fence_spec`'s unscoped fallback. It is recorded here because a claim about
    ///    reach is worth exactly what its caller is worth.
    ///
    ///    The one thing that sentence still rests on is that the folder the hand granted IS the
    ///    workspace the file tools resolve against. See `hand/REVIEW.md` §1.14: the hand now
    ///    publishes a folder-identity token, and the page's comparison is what settles it.
    /// 4. **A tainted turn does not reach the network without the user's say-so**, which is
    ///    [`egress_check`]'s rule applied to a process rather than a URL. The question is put once
    ///    and the answer holds for the turn (see [`net_step`]); where it cannot be put, or comes
    ///    back no, the command runs with the network refused and is TOLD so, because a command that
    ///    fails to resolve a host with no explanation is a debugging session nobody needed.
    ///
    /// # Arguments
    /// * `args` - The raw tool arguments.
    /// * `ctx` - The turn, which carries the bounds and the taint flag.
    pub(super) async fn run<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let argv = res!(crate::llm::extract_json_string_array(args, "argv")
            .ok_or_else(|| err!(
                "run: 'argv' must be an array of strings -- the program, then each argument \
                separately, e.g. [\"cargo\",\"test\"]. A single string is a shell command line, \
                and there is no shell here."; Invalid, Input)));
        if argv.is_empty() || argv[0].trim().is_empty() {
            return Err(err!(
                "run: 'argv' is empty, so there is no program to run."; Invalid, Input));
        }
        // A verifier, asked for through the wrong door. Answered before the hand is asked whether
        // it is even paired: nothing about the machine changes the answer, and the whole point of
        // the refusal is the turn it saves. See `verifier_refusal` for what that turn cost.
        if let Some(why) = verifier_refusal(&argv) {
            return Ok(why);
        }
        // And a script the fence has taken a capability away from, which is a different fault
        // said in different words: `symlink_refusal` explains why the two are not one rule.
        if let Some(why) = symlink_refusal(&argv) {
            return Ok(why);
        }
        let timeout = extract_json_number(args, "timeout_ms")
            .unwrap_or(Self::RUN_TIMEOUT_DEFAULT_MS)
            .min(Self::RUN_TIMEOUT_MAX_MS);
        let prog = argv[0].clone();
        match res!(Self::run_exec(Self::Run.name(), &prog, &argv, asked_cwd(args), timeout,
            extract_json_string(args, "stdin"), ctx, false).await)
        {
            Exec::Refused(why) => Ok(why),
            Exec::Ran { res, no_net, tainting, read_only, after } =>
                Ok(Self::run_result(&argv, &res, ctx, no_net, tainting, read_only,
                    spend_cap(args)) + &after),
        }
    }

    /// **The one door a command goes through, whoever asked for it.**
    ///
    /// `run` is the model naming a command; `verify` with no name is the PROJECT's own check, and
    /// `serve` is a static server -- and all three are a command a model reached for. So all
    /// three are fenced the same way, asked about the network the same way, put to the user on
    /// the same rung and given the same toolkits: a second exec site is a second set of answers
    /// to those questions, and the one that drifts is the one nobody is reading.
    ///
    /// The exec request is built HERE and nowhere else, which
    /// `test_run_and_verify_share_one_exec_door` holds it to by counting the sites in this file.
    ///
    /// # Arguments
    /// * `tool` - Which tool is asking, for the question put to the user.
    /// * `prog` - What to call the run in the hand's journal, e.g. `verify` or `cargo`.
    /// * `argv` - The program and its arguments, already checked to be non-empty.
    /// * `cwd_rel` - Where to run, workspace-relative, or `None` for this turn's own folder.
    /// * `timeout` - The hard limit in milliseconds, already clamped.
    /// * `stdin` - Text to write to the command's standard input.
    /// * `offline` - Whether the command never needs the network, so none is given and nobody is
    ///   asked: `typst_compile`'s compile (U13b), which reads only the project.
    pub(super) async fn run_exec<H: Host>(
        tool:    &str,
        prog:    &str,
        argv:    &[String],
        cwd_rel: Option<String>,
        timeout: u64,
        stdin:   Option<String>,
        ctx:     &ToolContext<H>,
        offline: bool,
    )
        -> Outcome<Exec>
    {
        // Where the hand's grant reaches on this machine. The page cannot know it -- a real folder
        // arrives through the File System Access API, which hands over a handle and never a path --
        // so the hand is asked, and its answer is what the fence is expressed against.
        let st = res!(ctx.host().exec().status().await);
        // Nothing paired. The relay says WHY -- not installed, the user declined, the hand
        // answered earlier and has now stopped -- and that sentence is the only thing the model
        // can act on: "install it" and "the one you installed stopped" are different instructions
        // to a user, and both used to arrive as the same one.
        if extract_json_bool(&st, "paired") != Some(true) {
            return Ok(Exec::Refused(fmt!("Refused: {}", extract_json_string(&st, "reason").unwrap_or_else(|| fmt!(
                "There is no machine hand paired with this browser, so there is nothing to run a \
                command on. Tell the user, and carry on with the file tools, which do not need it.")))));
        }
        // WHICH HAND SAID ALL THIS, read with the rest of it: the fence below is built from its
        // caps, and the questions between here and the send are time for another to take its
        // place. The request is bound to this link (`bound_to_link`, H3).
        let link = extract_json_number(&st, "link");
        // An ABSENT root and an EMPTY one are the same answer and must be refused alike. They were
        // not: `extract_json_string` returns `Some("")` for `"root":""`, which sailed past a check
        // that only tested for the key's absence -- and an empty root is the worst possible value,
        // because the hand compares paths with `starts_with` and every path on the machine is under
        // "". The fence would have been the whole filesystem.
        let machine = Machine::from_status(&st);
        if !machine.rooted() {
            return Err(err!(
                "The machine hand did not say which folder it was granted, so there is no way to \
                say what this command may touch. It is not safe to guess, so nothing was run.";
                Missing, Configuration));
        }
        let root = machine.root.clone();
        // The fence is only worth building if the hand can enforce one. Release gate 1: a command
        // that cannot be fenced is REFUSED, never run unfenced and mentioned afterwards.
        //
        // `caps` is an ARRAY on the wire, and it is read as one. It was read with
        // `extract_json_string`, which looks for `"caps":"..."` and therefore found NOTHING in
        // `["fence:none"]` -- so the refusal below could not fire at all, and gate 1 on this end
        // was unreachable rather than merely unmet. An absent or empty list is refused alongside
        // `fence:none`, because a hand that will not say what it can enforce has not said that it
        // can enforce anything, and the failure has to close.
        let caps = machine.caps.clone();
        if !fence_enforced(&caps) {
            return Ok(Exec::Refused(fmt!(
                "Refused: the machine hand on this computer {}, so nothing would stop a command \
                reaching the rest of the machine. Daimond will not run commands it cannot \
                contain. Tell the user; the file tools work regardless.",
                if caps.iter().any(|c| c == "fence:none") {
                    "says it cannot fence a command"
                } else {
                    "did not say it can fence a command"
                })));
        }
        // The Diamond's first attached folder is where a command belongs unless the model says
        // otherwise (see `ToolContext::default_cwd`, which is what makes that sentence true for a
        // scoped turn rather than merely intended).
        //
        // A scoped turn that lands on nothing is refused HERE, in the words that describe it. Its
        // own directory is in the browser's storage and not on this machine, so what it has is no
        // machine folder rather than a bad one -- and the alternative is the hand's
        // "cannot be resolved to a directory on this machine", which is true, unhelpful, and points
        // at a path the user never chose.
        let cwd_rel = match cwd_rel {
            Some(c) => c,
            None    => {
                // The refusals below are about having no folder at all, so they ask the start
                // directory; where the command then starts is `run_cwd`'s answer.
                let d = ctx.default_cwd();
                // A chat, or a worker it dispatched, with nothing in scope but its own working
                // folder. Its own words, because the Diamond sentence below would point at a
                // Diamond that does not exist and at a panel that is not where this is fixed.
                // Asked FIRST: both surfaces now carry the same kind of allow-list, so
                // `is_scoped` is true for a chat too and the order is what tells them apart.
                if d.is_empty() && ctx.is_scoped() {
                    return Ok(Exec::Refused(no_folder_refusal(ctx, NoFolder::Run)));
                }
                ctx.run_cwd(root_start(&caps))
            }
        };
        // Before the bounds, and for the same reason the file tools' check comes first: an
        // absolute `cwd` normalises into the allow-list check as `home/u/...` and is refused as
        // out of this Diamond's workspace, which is the wrong problem to hand back. `default_cwd`
        // normalises, so this only ever fires on a path the model wrote.
        if cwd_rel.starts_with('/') {
            return Ok(Exec::Refused(run_cwd_refusal(&cwd_rel, &root)));
        }
        // Asked as a RUN and not as a read. Reading is free now (see `Bound::OnlyWriteUnder`), so
        // `may_read` would answer yes for every path in the workspace and this guard would have
        // quietly stopped guarding -- leaving a command to be refused two layers down by the hand,
        // in a sentence naming an absolute path the user never chose.
        if !ctx.may_start_in(&cwd_rel, root_start(&caps)) {
            return Ok(Exec::Refused(ctx.refuse(&cwd_rel, true)));
        }
        // In scope, and still not a directory on this computer. A chat's scratch and a Diamond's
        // own directory are in the browser's storage whatever folder is open (see
        // `is_store_path`), so they pass the check above -- they ARE in the workspace -- and would
        // then reach the hand as `<granted-root>/chats/<id>/work` for it to fail on. The model has
        // every reason to try one: it is the first place its own refusals name.
        //
        // Answered here so the sentence says what to do about it. The hand's own answer,
        // "'...' cannot be resolved to a directory on this machine", is true and points at a path
        // the user never chose.
        if is_store_path(&normalise(&cwd_rel)) {
            if ctx.is_chat_scoped() {
                return Ok(Exec::Refused(fmt!(
                    "Refused: '{}' is your own working folder, which is in Daimond's storage and \
                    not a place on this computer, so no command can run there. Run in a folder \
                    the user added to this chat's workspace, or ask them to add one with the + \
                    in the Workspace group.", cwd_rel)));
            }
            return Ok(Exec::Refused(fmt!(
                "Refused: '{}' is in Daimond's storage and not a place on this computer, so no \
                command can run there. Run in a folder attached to this Diamond, or ask the user \
                to attach one in the Workspace panel.", cwd_rel)));
        }
        // The rung the user is in, read once so that everything below -- the fence, the question,
        // and the sentence the model reads afterwards -- is describing one decision rather than
        // three reads that a setting changed between could disagree about.
        let mode = mode();
        let cwd_abs = if normalise(&cwd_rel).is_empty() {
            root.clone()
        } else {
            fmt!("{}/{}", root.trim_end_matches('/'), normalise(&cwd_rel))
        };
        // Is there anywhere to run at all? The answer cannot depend on the network -- `fence_spec`
        // reads the roots off the bounds alone -- so it is settled BEFORE anybody is asked
        // anything, and nobody is put a question about a command that was going to be refused.
        //
        // `command_fence` and not `fence_spec`, in both places this function builds one: a hand
        // that cannot meter what a command removes gets nothing writable at all (audit F2).
        let bare = command_fence(&ctx.no_write, &machine, true);
        if bare.rw.is_empty() && bare.ro.is_empty() {
            return Ok(Exec::Refused(fmt!(
                "Refused: this turn's bounds do not describe any folder the command could run in, \
                so there is no fence to run it inside. Nothing was run.")));
        }
        // A toolchain this Diamond lacks is asked for here, on first use (E1), and the fence is
        // then built from the bounds the answer leaves. A yes is recorded on the Diamond by the
        // page (`set_toolkits`) and held for the rest of this turn; a no refuses this command
        // and is not remembered.
        let ask = ctx.kits_to_ask_on(argv, mode, &machine);
        if !ask.is_empty() {
            let names: Vec<String> = ask.iter().map(|k| fmt!("\"{}\"", k.name())).collect();
            let detail = fmt!("{{\"id\":\"{}\",\"kits\":[{}]}}",
                json_escape(&ctx.daimon_of), names.join(","));
            match ctx.host().net().egress_allowed_kit(&ctx.turn_tag(), &argv.join(" "), &detail).await {
                Some(Permit::Allow)  => {},
                Some(Permit::No(no)) => return Ok(Exec::Refused(kit_refusal(argv, &ask, no))),
                None                 => return Ok(Exec::Refused(kit_refusal(argv, &ask,
                    PermitNo::Absent))),
            }
            ctx.grant_kits(&ask);
        }
        let bounds = ctx.run_bounds();
        let bare = command_fence(&bounds, &machine, true);
        // The network, asked about rather than taken away in silence (`hand/REVIEW.md` §1.13).
        //
        // `net_risk`, not the raw taint: an unattended worker is at risk on a clean turn too, and
        // it is the one case with nobody to ask -- so `net_step` answers it `Withhold` and nothing
        // below can turn that into a question.
        //
        // `turn_net`'s lines are mirrored by `test_one_answer_covers_the_whole_turn_and_a_new_turn_
        // asks_again`, which is the only way the browser-only path here can be checked at all.
        // Keep them the same shape.
        let cmd = argv.join(" ");
        // A whole-home command that NAMES a stranger root runs offline and its output taints the
        // turn (U10): the parent denies those roots to any command holding the proxy, so without
        // this `ffmpeg -i ~/Downloads/x.mp4` on a clean chat would be networked and refused its
        // own input.  No question is put; the runner puts none.
        let named = named_stranger_root(&machine, argv, &cwd_abs);
        let gives_net = !offline && !named && Self::turn_net(ctx, &machine, mode, &cmd, &cwd_abs).await;
        // Built from the answer, by the one function that builds a fence, out of the one argument a
        // rung -- or a user -- may move. The withheld fence is the one already in hand, so the
        // second call happens only where the user gave the network back, and everything but that
        // field comes from the turn's bounds and nothing else --
        // `test_a_yes_moves_nothing_but_the_network` holds it to exactly that.
        let fence = if gives_net {
            command_fence(&bounds, &machine, false)
        } else {
            bare
        };
        // Captured HERE, beside the fence, and passed down rather than read again in
        // `run_result`. Asking the context a second time gives the same answer today only because
        // nothing between the two calls taints the turn -- an accident of ordering that the next
        // edit to either function breaks silently (`hand/REVIEW.md` §1.13). This is the flag the
        // command actually ran with.
        let no_net = NetCut::of(fence.net, machine.whole_home());
        // The turn's taint, captured here for the same reason: the runner's parent takes the
        // network from the rest of the run on it (U9), so it is the word the command ran under.
        // A command that names a path the parent denies a clean command is a tainted one from
        // its start (F3-3): its output taints the turn, and the parent must plan it tainted to
        // let it read what it named.  A registry tree is never denied, so naming one (the tool
        // prefix a command installs into) leaves the command clean and the prefix writable.
        let tainted = ctx.is_tainted()
            || (named && machine.whole_home() && names_denied(argv, &cwd_abs, &machine.root));
        // Whether `command_fence` took every folder's writing away, read off the same `caps` it
        // read, for the same reason as the two flags either side of it.
        let read_only = !deletes_metered(&caps);
        // And whether that fence could have reached a stranger's words, captured beside it for
        // exactly the reason above: it is a property of the fence the command RAN inside, and
        // re-deriving it in `run_result` is how the two come to disagree.
        //
        // Never on a whole-home machine (U8, §7b seed cause 1): there the fence reaches the user's
        // own home, so every command "could" read a stranger's words, and its own output tainted
        // the turn and took the next command's network.  Taint on the runner comes from the
        // egress proxy's outside destinations, the page's `markRead` (the errand's `clean` and the
        // runner's taint record), and a command that names a stranger root (U10, `named`).
        let tainting = match machine.whole_home() {
            true    => named,
            false   => fence_reaches_untrusted(&fence, &machine),
        };
        // What to do about a `git` command, decided ONCE and in one place. A refusal returns here,
        // above the rung's own "may this run" question, so the user is never asked to approve a
        // push that was going to be refused; and the credential is attached below out of the same
        // decision, so an `argv` that did not pass this cannot be authenticated by any later step.
        //
        // BELOW the network question deliberately, and it is the one place the "ask last" rule
        // above is given up. A push refused for having no network is §1.13 in its most acute form:
        // the command whose entire purpose is the network, refused for the want of a question
        // nobody had put. So the question is put first, and a `--force` that was going to be
        // refused anyway costs one dialog -- which is not wasted, since the answer covers every
        // later command in the turn.
        let push_env = match git_step(argv, &root, no_net) {
            GitStep::Refuse(why) => return Ok(Exec::Refused(why)),
            GitStep::WithEnv(e)  => e,
            GitStep::Plain       => Vec::new(),
        };
        let argv_json: Vec<String> =
            argv.iter().map(|a| fmt!("\"{}\"", json_escape(a))).collect();
        let stdin_json = match &stdin {
            Some(s) => fmt!("\"{}\"", json_escape(s)),
            None    => "null".to_string(),
        };
        // The question, on the rung that asks it -- and put LAST of the checks, so the user is
        // only ever asked about a command that would otherwise have run. Being asked to approve
        // something that was going to be refused anyway is the fastest way to teach a person to
        // approve without reading.
        if run_needs_consent(mode) {
            let answer = ctx.host().net().egress_allowed_run(&ctx.turn_tag(), tool, &cmd, &cwd_abs).await;
            if let Egress::Refuse(reason) = run_decision(mode, argv, answer) {
                return Ok(Exec::Refused(reason));
            }
        }
        // The environment is still not the model's to set: what goes here is the granted toolkit's
        // own two or three names, from a table in this file, or nothing at all. `argv` never
        // reaches it, so no command can name a variable by asking to be run with one.
        //
        // The push credential joins it here and nowhere else, and it is appended LAST so that a
        // toolkit variable can never overwrite one of git's: the two name-spaces do not overlap
        // today, and "today" is not a property worth resting a credential on.
        let mut env_pairs = match Kit::resolve(&bounds, &machine) {
            Some(kit) => kit.env,
            None      => Vec::new(),
        };
        env_pairs.extend(push_env);
        let env_json = env_json_of(&env_pairs);
        // The granted toolkit names travel WITH the fence, because the hand cannot check the one
        // without the other: a fence naming `~/.cargo/registry` is not under the granted root, and
        // a hand that allowed every toolchain folder regardless would accept a writable
        // `~/.local/bin` from a turn that was granted nothing -- which is a shim on the front of
        // PATH. Read out of the same bounds the fence came from, so `argv` cannot reach it.
        // The turn's deletion allowance travels with every command, and what each command
        // spent comes back on its result, so a loop of small commands meets the same ceiling
        // one large one does. The hand holds the ceiling; this only carries it.
        let (budget, since_ms) = {
            let mut c = lock_cache(&ctx.read_seen);
            if c.turn_ms == 0 {
                c.turn_ms = ctx.host().clock().now_ms() as u64;
            }
            (DELETE_BUDGET.saturating_sub(c.removed), c.turn_ms)
        };
        // Which of the files already there the Diamond made, from its own record: the one
        // engine function the tab's hand and the runner both go through (MADE-1).
        // It is read BEFORE the command starts, so a store that will not say refuses the command,
        // fail-closed, with the keeper, the op and the store's reason (LOUD-FAIL, rc-a ruling F1):
        // nothing is spawned, so nothing is made that the History could neither keep nor undo.
        let mut loud = String::new();
        let made = match ctx.keeper() {
            Some(dia) => match ctx.host().store().made_files(&dia).await {
                Ok(m)  => made_json(&dia, &fence.rw, &m),
                Err(e) => return Ok(Exec::Refused(fmt!("Refused: the store refused made_files for \
                    keeper '{}' ({}), so it cannot say which files here are the Diamond's and \
                    nothing was run. Tell the user; the command can be tried again once the \
                    store answers.", dia, e.plain()))),
            },
            None      => "null".to_string(),
        };
        let spec = bound_to_link(fmt!(
            r#"{{"t":"exec","id":"{}","argv":[{}],"cwd":"{}","env":{},"stdin":{},"timeout_ms":{},"capture":"both","fence":{},"toolkits":{},"meter":{{"budget":{},"since_ms":{}}},"made":{},"tainted":{}}}"#,
            json_escape(&Self::run_id(prog, ctx)),
            argv_json.join(","),
            json_escape(&cwd_abs),
            env_json,
            stdin_json,
            timeout,
            fence.to_json(),
            toolkit_names_json(&bounds),
            budget,
            since_ms,
            made,
            tainted,
        ), link);
        let res = res!(ctx.host().exec().run(&spec).await);
        // WHAT THE COMMAND MADE, as the hand's write meter reported it, into the turn's record
        // under the agent that ran it (MADE-2): so a file a build made in one turn is the
        // Diamond's to the next turn's `rm`, while it holds the bytes the meter saw.
        if let Some(dia) = ctx.keeper() {
            let ran = crate::diamond_versions::RanMade::of(&res);
            if !ran.files.is_empty() || ran.capped {
                // The command has run: a refusal here cannot undo it, so it is said, in this
                // answer and at the turn end in the asker's transcript (LOUD-FAIL B2).
                if let Err(e) = ctx.host().store().ran_made(&dia, ctx.by.clone(), ran.files,
                    ran.capped).await
                {
                    let line = fmt!("The store refused ran_made for keeper '{}' ({}): what this \
                        command made is on the disk, but this turn's record does not hold it.",
                        dia, e.plain());
                    ctx.host().store().trail("RUN NOT RECORDED", &line);
                    note_unkept(&ctx.read_seen, line.clone());
                    loud.push_str(&fmt!("\n[{}]", line));
                }
            }
        }
        if let Some(n) = extract_json_number(&res, "counted") {
            let mut c = lock_cache(&ctx.read_seen);
            c.removed = c.removed.saturating_add(n.min(u32::MAX as u64) as u32);
        }
        // AFTER THE FACT, for what the question above could not see: a wrapper script calling
        // `cargo` is one program to `kits_wanted`, and the shell's "not found" is the first word
        // of the toolkit it needed. The same door, the same answer; the command is not run again
        // here, since it may have done half its work, and the daimon is told to run it again.
        let mut after = String::new();
        if ctx.can_ask_kits_on(mode, &machine) {
            let late = kits_not_found(
                &extract_json_string(&res, "stderr").unwrap_or_default(),
                extract_json_i64(&res, "exit").unwrap_or(-1),
                &toolkits(&bounds));
            if !late.is_empty() {
                let names: Vec<String> = late.iter().map(|k| fmt!("\"{}\"", k.name())).collect();
                let detail = fmt!("{{\"id\":\"{}\",\"kits\":[{}]}}",
                    json_escape(&ctx.daimon_of), names.join(","));
                let answer = ctx.host().net().egress_allowed_kit(&ctx.turn_tag(), &cmd, &detail).await
                    .unwrap_or(Permit::No(PermitNo::Absent));
                if answer == Permit::Allow {
                    ctx.grant_kits(&late);
                }
                after = kit_after_note(argv, &late, answer);
            }
        }
        after.push_str(&loud);
        Ok(Exec::Ran { res, no_net, tainting, read_only, after })
    }

    /// The longest a run's identifier may be.
    ///
    /// The id is echoed on EVERY chunk of output, so its length is subtracted from the room left
    /// for the output itself in a frame that may not exceed 1 MB. It used to be `run-{argv[0]}`
    /// with the program name unbounded and model-chosen: a long enough `argv[0]` made every chunk
    /// too large to send, and the run's whole output was silently dropped.
    pub(super) const RUN_ID_MAX: usize = 48;

    /// How long `serve` waits for `setsid -f` to fork and return.
    ///
    /// Seconds, not minutes: the command this budget is for exits immediately by design, and a
    /// long budget here would only hold the turn open on a machine with no python3.
    pub(super) const SERVE_TIMEOUT_MS: u64 = 20_000;

    /// A short, unique identifier for one run.
    ///
    /// Unique matters as much as short: `Req::Signal` and the hand's journal both key on this, so
    /// two concurrent `cargo` runs sharing an id meant a cancel could reach the wrong one and the
    /// journal could not tell them apart.  The counter is per-context and monotonic, which is
    /// enough -- ids need only be distinct among the runs alive at one moment.
    ///
    /// # Arguments
    /// * `prog` - The program being run, for a person reading the journal.
    /// * `ctx` - The turn, which holds the counter.
    pub(super) fn run_id<H: Host>(prog: &str, ctx: &ToolContext<H>) -> String {
        let n = {
            let mut c = lock_cache(&ctx.read_seen);
            c.runs = c.runs.saturating_add(1);
            c.runs
        };
        // The tail of a path is the useful half: `/usr/bin/cargo` should read as `cargo`.
        let base = prog.rsplit('/').next().unwrap_or(prog);
        let mut name = String::new();
        for ch in base.chars() {
            if name.len() >= Self::RUN_ID_MAX { break; }
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' { name.push(ch); }
        }
        if name.is_empty() { name.push_str("cmd"); }
        fmt!("run-{}-{}", n, name)
    }

    /// The hand's result, as the model reads it.
    ///
    /// Command output is **not the user's words** -- it is whatever the program printed, and a
    /// build log can carry a stranger's text (a dependency's name, a test fixture, a fetched
    /// page). So it goes through the same untrusted envelope `shell` uses, for the same reason --
    /// **on every command, whatever `tainting` says.**  The envelope and the taint used to be one
    /// call and one decision; they are two now, and [`fence_reaches_untrusted`] says why.
    ///
    /// # Arguments
    /// * `argv` - What was run, for the origin line.
    /// * `res` - The hand's JSON result.
    /// * `ctx` - The turn, which `tainting` decides whether to mark.
    /// * `no_net` - Whether the command ran with the network refused, as the fence was built, and
    ///   on whose rule.
    /// * `tainting` - Whether the fence could reach a stranger's words, so that reading this
    ///   output costs the turn its network.  Computed beside the fence in [`Tool::run`] and
    ///   passed down, never re-derived here.
    /// * `read_only` - Whether [`command_fence`] took every folder's writing away, because the
    ///   hand does not meter removals.
    //
    // Available on the native build for its tests only. It is pure string composition over the
    // hand's JSON and it carries the sentence a model has to be able to attribute a failed build
    // to, which is worth rather more than a test that only the browser can run.
    pub(super) fn run_result<H: Host>(
        argv:      &[String],
        res:       &str,
        ctx:       &ToolContext<H>,
        no_net:    NetCut,
        tainting:  bool,
        read_only: bool,
        cap:       Option<usize>,
    )
        -> String
    {
        // A refusal is not output: it is the fence speaking, and it must not be dressed as a
        // program's stderr or the model will try to fix the wrong thing.
        if let Some(reason) = extract_json_string(res, "refused") {
            return refusal_line(&reason);
        }
        let out = extract_json_string(res, "stdout").unwrap_or_default();
        let err = extract_json_string(res, "stderr").unwrap_or_default();
        // NOT `extract_json_number`: it parses a u64, so the one status that means "there was no
        // status" -- the -1 the hand sends when a command was killed or the host died mid-run --
        // failed to parse and defaulted to ZERO. A crashed `cargo test` was then handed to the
        // model as `[exit code: 0]`, and a broken build reads as a green one. There is no more
        // dangerous defect available in this file than a failure reported as a success.
        let exit = extract_json_i64(res, "exit").unwrap_or(-1);
        let timed_out = extract_json_bool(res, "timed_out").unwrap_or(false);
        let killed = extract_json_bool(res, "killed").unwrap_or(false);
        // The byte counts the hand sends are what close the truncation hole: output can go missing
        // between the hand and here (a dropped frame, a chunk too large to send), and a short
        // stream presented as a whole one is a model reasoning about a file it never saw.
        let out_bytes = extract_json_number(res, "out_bytes").unwrap_or(0);
        let err_bytes = extract_json_number(res, "err_bytes").unwrap_or(0);
        let mut s = String::new();
        if !out.is_empty() { s.push_str(&out); }
        if !err.is_empty() {
            if !s.is_empty() && !s.ends_with('\n') { s.push('\n'); }
            s.push_str("[stderr] ");
            s.push_str(&err);
        }
        // Output that went missing is SAID, not smoothed over. The model is about to reason about
        // this text, and a truncated build log it believes to be whole is worse than one it knows
        // is partial.
        let short = (out.len() as u64) < out_bytes || (err.len() as u64) < err_bytes;
        if short {
            s.push_str(&fmt!(
                "\n[some output did not arrive: {} of {} bytes on stdout, {} of {} on stderr]",
                out.len(), out_bytes, err.len(), err_bytes));
        }
        // What the RELAY has to say about the run, as opposed to what the command printed: a hole
        // in the stream, or a hand that disconnected part-way. It is kept out of `stdout` on
        // purpose -- the page's account of a broken link dressed as a program's output is a model
        // debugging the wrong thing -- and it is shown because the alternative is a truncated
        // build log the model believes is whole.
        // What the deletion meter kept. Said so the model knows the removal happened and that
        // it can be undone, without having to infer either from a quiet `rm`.
        if let Some(n) = extract_json_number(res, "counted").filter(|n| *n > 0) {
            // A meter that sends `kept` (METER-KEEP, R2) keeps his file before any change, so
            // Undo covers the whole command.  One that does not kept only what was removed: a
            // file emptied or written over in place lost its bytes (audit F1), and the sentence
            // says where the keeping stops.
            let rest = if extract_json_objects(res, "kept").is_some() {
                "A file changed in place is kept first too, and Undo puts it back"
            } else {
                "A file emptied or written over in place is not kept, and cannot be put back"
            };
            s.push_str(&fmt!(
                "\n[the machine hand: this command removed {} file(s) that existed before this \
                turn; each was kept in the hand's trash first and can be put back. {}]", n, rest));
        }
        if let Some(n) = extract_json_string(res, "note").filter(|n| !n.is_empty()) {
            s.push_str(&fmt!("\n[the machine hand: {}]", n));
        }
        if crate::diamond_versions::RanMade::of(res).capped {
            s.push_str(&fmt!("\n[the machine hand: this command made more files than its report \
                names; only the first {} a turn count as made here, and a later command is \
                refused the rest as the user's]", crate::diamond_versions::MADE_SENT_MAX));
        }
        let origin = fmt!("run: {}", argv.join(" "));
        s = defang(&s);
        let tail = if timed_out {
            fmt!("\n[timed out; the command was killed]")
        } else if killed {
            fmt!("\n[the command was stopped before it finished; there is no exit code]")
        } else if exit < 0 {
            // Not a status. Saying "exit code: -1" invites the model to explain a failure the
            // command never reported; saying what actually happened invites it to run it again.
            fmt!("\n[the command did not finish, so it reported no exit code -- \
                the machine hand stopped or lost it]")
        } else {
            fmt!("\n[exit code: {}]", exit)
        };
        // What this result COULD carry, and what this call agreed to carry. The second is the
        // budget the model can see before it spends; the first has always been here and is a
        // ceiling on the wire, not a budget -- see `RUN_SPEND_UNASKED` for the three runs that
        // proved the difference.
        let room = MAX_OUTPUT.saturating_sub(envelope_overhead(&origin) + tail.len());
        let spent = spend_gate(&mut s, SpendCall::Argv(argv), cap, room, ctx.spend_left());
        // THE ENVELOPE EITHER WAY, THE TAINT ONLY WHERE THE FENCE EARNED IT. The method marks
        // the turn and the free function does not, and that is the whole of the difference: the
        // model reads the same marked output on both branches, and only the network moves.
        let body = if tainting {
            ctx.wrap_untrusted(&origin, &s)
        } else {
            wrap_untrusted(&origin, &s)
        };
        // Why the runner withheld the command's network (U8), FIRST and outside the envelope: it is
        // Kimberlite speaking, and the model must not read a refused connection as a broken tool.
        //
        // On the runner its reason carries the rule in the same line, and the note below is not
        // said again: two `[no network: …]` lines are two accounts of one fact for the model to
        // reconcile.
        let why = extract_json_string(res, "no_net_why").filter(|w| !w.is_empty());
        let mut out = match (&why, no_net) {
            (Some(w), NetCut::Tainted)  => fmt!("[no network: {}. {}]\n{}{}", w, RUNNER_NO_NET_RULE,
                body, tail),
            (Some(w), _)                => fmt!("[no network: {}]\n{}{}", w, body, tail),
            (None, _)                   => fmt!("{}{}", body, tail),
        };
        // A '~' in `argv` cannot be refused outright -- it is legitimate text to `grep` or to a
        // commit message -- so it is explained at the only moment it is worth explaining: a
        // command that failed with one in it. On a success nothing was misread and this would be
        // noise.
        if exit > 0 {
            if let Some(a) = argv.iter().find(|a| a.starts_with("~/") || a.as_str() == "~") {
                let shown: String = a.chars().take(60).collect();
                out.push_str(&fmt!(
                    "\n[the argument '{}' begins with '~', and there is no shell here to expand \
                    it: the program was handed a directory literally named '~'. If that was meant \
                    to be a path, write it out in full from '/'.]", shown));
            }
        }
        // The one refusal that looks like a broken command rather than like a rule.
        //
        // Every fence denies Daimond's own `.daimond` directory, so a walk of the whole workspace
        // -- `find`, `du`, `tar`, `grep -r`, `rg --no-ignore` -- meets it, prints "Permission
        // denied" against that one path, and EXITS NON-ZERO even though every other directory was
        // read. `find /home/u ...` therefore reads as a failure, and the reason is invisible: the
        // path is denied, not missing, and nothing in the output says why.
        //
        // Said here rather than in the machine briefing because the briefing is paid for on every
        // request of every turn, and this is worth one line on the few commands that meet it. Both
        // halves of the test are needed: the directory's name alone appears in any listing of the
        // workspace, and a denial alone is any of a dozen ordinary failures.
        if s.contains(DAIMOND_DIR.trim_end_matches('/'))
            && (s.contains("Permission denied") || s.contains("Operation not permitted"))
        {
            out.push_str(DENIED_DIR_NOTE);
        }
        // The same fence, met through a route `symlink_refusal`'s pre-emptive argv check cannot
        // see: a shell, an interpreter, or a program that links as a side effect made the call
        // itself, so nothing in `argv` names it -- and what comes back is a bare "Permission
        // denied" with no reason attached. Caught here instead, on the stderr the command
        // actually printed, which is the only place such a route can be told apart from an
        // ordinary permission fault.
        if looks_like_symlink_denial(&err) {
            out.push_str(SYMLINK_DENIED_NOTE);
        }
        // Why the build failed, said by the app rather than guessed at by the model.
        //
        // Outside the envelope, because this is Daimond speaking and not the command; and
        // UNCONDITIONALLY rather than only on a failure, because deciding which failures are
        // network failures means matching prose out of cargo, npm, git and everything else, which
        // is exactly the guessing this ends. The cost is one line on a command that did not need
        // the network. The benefit is that the one that did needs no guessing at all.
        if !(no_net == NetCut::Tainted && why.is_some()) {
            out.push_str(no_net.note());
        }
        // Every folder was read-only to this command (`command_fence`), and said on every result
        // for the reason the note above is: "Permission denied" from a build that was never going
        // to be allowed to write is otherwise a model debugging a fence nobody told it about.
        if read_only {
            out.push_str(READ_ONLY_NOTE);
        }
        // LAST, and outside the envelope: it is Daimond speaking about the result, and it is the
        // sentence the model has to act on, so nothing else follows it.
        if let Some(said) = spent {
            out.push_str(&said);
        }
        out
    }

    // ┌───────────────────────────────────────────────────────────────┐
    // │ verify: evidence, and the refusal to report a bare pass        │
    // └───────────────────────────────────────────────────────────────┘

}
