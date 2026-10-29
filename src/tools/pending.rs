use super::*;

// ── Pending alerts: a daimon's line on the person's Pending panel ──────────────
//
// D-20261016-17, the owner's words: "why not use the Pending panel? The Email diamond will mostly
// sit in the background."  A Diamond that watches something -- a mailbox, a feed, a build -- runs
// on its triggers while nobody has it open, so a fault it finds was a line in a log nobody was
// reading.  `pending_raise` puts the one that NEEDS the person on the panel they do read, on every
// device, and `pending_clear` takes it down when the condition is over.
//
// **The model never names the Diamond.**  The key is namespaced on the page by the turn's own
// Diamond (`ctx.daimon()`), so one Diamond can neither clear nor overwrite another's alert, and a
// turn with no Diamond -- a chat, a dispatched worker -- is refused: it has nowhere to keep one.
// Raising a key that is already up updates that item in place; it never adds a second.

/// The longest alert key, in characters.  A name, not a sentence.
pub(super) const PENDING_KEY_MAX: usize = 64;
/// The longest headline: what happened, in one line of a tile.
pub(super) const PENDING_HEADLINE_MAX: usize = 120;
/// The longest detail: the fix, which is a short paragraph and never a report.
pub(super) const PENDING_DETAIL_MAX: usize = 600;

/// The most alerts one Diamond may hold live at once (review AP-1).  The page holds the alerts,
/// so the page counts and refuses (www/js/alerts.js `LIVE_MAX`); the engine says why.
pub(super) const PENDING_LIVE_MAX: usize = 20;

/// One checked `pending_raise` or `pending_clear`, ready for the page.
#[derive(Debug)]
pub(super) struct PendingCall {
    pub(super) diamond: String,    // the turn's own Diamond, never the model's word
    pub(super) key:     String,    // the alert's name within that Diamond
    pub(super) payload: String,    // what the page is handed, as JSON
}

/// A refusal from these two tools, through [`refusal_line`] so it is booked as one.
pub(super) fn pending_refusal(reason: &str) -> String {
    refusal_line(&fmt!("Nothing was changed on the Pending panel. {}", reason))
}

/// Whether this call may raise (or clear) an alert, and what the page is to be handed if it may.
///
/// Pure, so every bound is tested on a build with no page in it.  Over-long text is REFUSED
/// rather than cut: a detail clipped mid-sentence is a fix with its last step missing, and the
/// model told the bound writes a shorter one.
///
/// # Arguments
/// * `args` - The raw tool arguments.
/// * `daimon` - The Diamond this turn acts for, or `None` for a chat or a worker.
/// * `raise` - `true` for `pending_raise`, `false` for `pending_clear`.
pub(super) fn pending_step(args: &str, daimon: Option<&str>, raise: bool) -> Result<PendingCall, String> {
    let diamond = match daimon {
        Some(d) if !d.trim().is_empty() => d.trim().to_string(),
        _ => return Err(pending_refusal(
            "An alert is kept on a Diamond, and this turn is not working inside one. Only a \
            Diamond's daimon raises alerts; a dispatched worker puts what needs the user in its \
            report instead.")),
    };
    let key = extract_json_string(args, "key").unwrap_or_default().trim().to_string();
    if key.is_empty() {
        return Err(pending_refusal(
            "The call carried no 'key'. Name the alert, e.g. 'imap-login', so raising it again \
            updates it and pending_clear can take it down."));
    }
    if key.chars().count() > PENDING_KEY_MAX
        || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(pending_refusal(&fmt!(
            "The 'key' must be at most {} characters of letters, digits, '-', '_' and '.', \
            e.g. 'imap-login'.", PENDING_KEY_MAX)));
    }
    if !raise {
        let payload = fmt!("{{\"key\":\"{}\"}}", json_escape(&key));
        return Ok(PendingCall { diamond, key, payload });
    }
    let headline = extract_json_string(args, "headline").unwrap_or_default().trim().to_string();
    if headline.is_empty() {
        return Err(pending_refusal(
            "The call carried no 'headline'. Say what happened, in one line the user can read \
            at a glance."));
    }
    if headline.contains('\n') || headline.chars().count() > PENDING_HEADLINE_MAX {
        return Err(pending_refusal(&fmt!(
            "The 'headline' is one line of at most {} characters; it is {}. Put the rest in \
            'detail'.", PENDING_HEADLINE_MAX, headline.chars().count())));
    }
    let detail = extract_json_string(args, "detail").unwrap_or_default().trim().to_string();
    if detail.chars().count() > PENDING_DETAIL_MAX {
        return Err(pending_refusal(&fmt!(
            "The 'detail' may be {} characters and is {}. Say the fix -- what the user should \
            do -- and leave the history in your log.", PENDING_DETAIL_MAX, detail.chars().count())));
    }
    let needs = match crate::llm::extract_json_bool(args, "needs") {
        Some(n) => n,
        None => return Err(pending_refusal(
            "The call carried no 'needs' (true or false). Say true only when the user must act -- \
            a fault to fix, a decision only they can make -- which counts on the Pending badge; \
            say false for something they should see but need not act on, which shows quietly \
            and drops off by itself after 24 hours.")),
    };
    let payload = fmt!("{{\"key\":\"{}\",\"headline\":\"{}\",\"detail\":\"{}\",\"needs\":{}}}",
        json_escape(&key), json_escape(&headline), json_escape(&detail), needs);
    Ok(PendingCall { diamond, key, payload })
}

/// How `pending_result` opens when the alert is on the panel (raised or updated) or was taken
/// off it.  Read back by [`pending_landed`], so the two cannot drift apart.
pub(super) const PENDING_RAISED:  &str = "Raised.";
pub(super) const PENDING_UPDATED: &str = "Updated in place.";
pub(super) const PENDING_CLEARED: &str = "Cleared.";
// What `pending_none` answers: the turn's word is in, so the model ends the turn.
pub(super) const PENDING_NONE_SAID: &str = "Noted: nothing raised. End now, with no reply.";

/// `pending_none`, the quiet end of a turn that reports through the Pending panel alone.  Offered
/// on every turn so the tool list never changes (r578b A1), so the refusal is made here, at the
/// call, in both builds: a turn with a person waiting on it answers them in its chat.
pub(super) fn pending_none<H: Host>(ctx: &ToolContext<H>) -> Outcome<String> {
    if !ctx.pending_only_on() {
        return Err(err!(
            "Tool 'pending_none' ends a turn that reports through the Pending panel alone; this \
            turn has a person waiting on it, so answer them in the chat."; Invalid, Input));
    }
    Ok(PENDING_NONE_SAID.to_string())
}

/// Did this `pending_raise` / `pending_clear` result change the panel?  A clear that found
/// nothing and a raise the person had already dismissed are `Done` but changed nothing, so they
/// are not a turn's report (src/agent.rs `Claims::alerted`, review AP-3).
pub(crate) fn pending_landed(result: &str) -> bool {
    [PENDING_RAISED, PENDING_UPDATED, PENDING_CLEARED].iter().any(|o| result.starts_with(o))
}

/// What the model is told, from what the page answered.
///
/// A page that did not say it acted has not acted, so `ok` absent or false is a refusal carrying
/// the page's reason: a model told "raised" of an alert nobody can see would stop looking.
///
/// # Arguments
/// * `raise` - Which of the two tools this answers.
/// * `key` - The alert's key, as checked.
/// * `answer` - The page's JSON answer.
pub(super) fn pending_result(raise: bool, key: &str, answer: &str) -> String {
    if !crate::llm::extract_json_bool(answer, "ok").unwrap_or(false) {
        // QA ccp4-b K1: a runner's turn carries its alerts home on one report, bounded as the
        // panel is, so a new key past the bound is this turn's limit, not the panel's.
        let full = crate::llm::extract_json_bool(answer, "full").unwrap_or(false);
        if full && extract_json_string(answer, "was").as_deref() == Some("carried") {
            return pending_refusal(&fmt!(
                "'{}' was not {}: this turn already carries {} alerts home on its report, the \
                most one report holds. Raise or clear one of those keys again to change it, or \
                say this in your reply.", key, if raise { "raised" } else { "cleared" },
                PENDING_LIVE_MAX));
        }
        if full {
            return pending_refusal(&fmt!(
                "This Diamond already has {} alerts up on the Pending panel, the most it may hold, \
                so '{}' was not raised. Update one of them by raising its key again, or take down \
                one that is over with pending_clear, then raise this.", PENDING_LIVE_MAX, key));
        }
        let why = extract_json_string(answer, "reason").unwrap_or_else(|| fmt!("the page did not say"));
        return pending_refusal(&fmt!("The panel did not take it: {}.", why));
    }
    // KT-5d: a runner's turn has no page, so its alert goes home on the turn's report and the
    // asking tab puts it on the panel when that report reaches it.
    let carried = extract_json_string(answer, "was").as_deref() == Some("carried");
    if carried {
        return match raise {
            true    => fmt!(
                "{} '{}' goes on the user's Pending panel, with a link back to this Diamond, when \
                this turn's report reaches them. Raising the same key again updates it in place. \
                Clear it with pending_clear {{\"key\":\"{}\"}} the moment the condition is \
                over.", PENDING_RAISED, key, key),
            false   => fmt!(
                "{} The alert '{}' comes off the user's Pending panel when this turn's report \
                reaches them.", PENDING_CLEARED, key),
        };
    }
    if !raise {
        return if crate::llm::extract_json_bool(answer, "cleared").unwrap_or(false) {
            fmt!("{} The alert '{}' is off the user's Pending panel, on every device.", PENDING_CLEARED, key)
        } else {
            fmt!("Done: nothing under '{}' was on the Pending panel, so there was nothing to clear.", key)
        };
    }
    match extract_json_string(answer, "was").as_deref() {
        Some("updated") => fmt!(
            "{} The alert '{}' was already on the user's Pending panel and now \
            says this instead; no second item was added. Clear it with pending_clear \
            {{\"key\":\"{}\"}} the moment the condition is over.", PENDING_UPDATED, key, key),
        Some("dismissed") => fmt!(
            "Not raised again: the user dismissed this same alert '{}' already. Raise it with a \
            different headline or detail only if something has changed.", key),
        _ => fmt!(
            "{} '{}' is on the user's Pending panel, on every device of theirs, with a link \
            back to this Diamond. Raising the same key again updates it in place. Clear it with \
            pending_clear {{\"key\":\"{}\"}} the moment the condition is over: an alert left up \
            after its fault is fixed teaches the user to ignore the panel.", PENDING_RAISED, key, key),
    }
}


/// Whether this call may publish at all, and what the panel is to compose if it may.
///
/// Pure, so the whole of the policy is testable on a build with no browser in it, and so the
/// refusals below are read in a test rather than only in a transcript.
///
/// **A DISPATCHED WORKER MAY NOT PUBLISH, APPROVED OR NOT**, and that is the one thing here that
/// is not about the arguments.  `verify` refused a worker on the ground that a verifier runs
/// outside the fence until the owner lifted that on 2026-09-12; this refusal stands on a nearer
/// footing and is not touched by it.  Every other gate on this panel ends
/// in a question, and the whole of the owner's ruling is that the question gets asked -- but a
/// worker is the turn with nobody watching, several run at once, and `parkConsent` would put a
/// public post about the user's own product on a tile for somebody to approve out of the context
/// that produced it.  The daimon that dispatched the worker is supervised, is answerable for the
/// work, and is where a decision to say something in the user's name belongs.  So this is a
/// refusal and not a diversion, and it says what to do instead.
///
/// # Arguments
/// * `args` - The raw tool arguments.
/// * `alone` - Whether this turn is a dispatched worker, acting with nobody watching.
pub(super) fn social_send_step(args: &str, alone: bool) -> Result<String, String> {
    if alone {
        return Err(publish_refusal(
            "say something in the user's name",
            "You are a dispatched worker, and nobody is reading this transcript. Publishing in \
            somebody's name is the decision of the daimon that dispatched you, who is answerable \
            for this work and can put the question."));
    }
    let act = match extract_json_string(args, "act") {
        Some(a) => match SocialAct::from_id(a.trim()) {
            Some(a) => a,
            None    => return Err(publish_refusal(
                "publish something",
                &fmt!("'{}' is not one of the acts this panel has. They are {}.",
                    a.trim().chars().take(40).collect::<String>(), SocialAct::names()))),
        },
        None => return Err(publish_refusal(
            "publish something",
            &fmt!("The call named no 'act'. It is one of {}.", SocialAct::names()))),
    };
    match act {
        SocialAct::Propose => {
            let title = extract_json_string(args, "title").unwrap_or_default();
            if title.trim().is_empty() {
                return Err(publish_refusal("open a proposal",
                    "A proposal needs a 'title' -- one line saying what this is about. It is the \
                    line everybody reads first, so it cannot be empty."));
            }
            if title.contains('\n') {
                return Err(publish_refusal("open a proposal",
                    "The 'title' holds a newline. The title is ONE line; everything after it \
                    belongs in 'body'."));
            }
            let body = extract_json_string(args, "body").unwrap_or_default();
            if title.chars().count() + body.chars().count() > SOCIAL_MAX_CHARS {
                return Err(publish_refusal("open a proposal",
                    &fmt!("A note may be {} characters and this one is longer. Cut it down: the \
                        people reading it want what happened and what you expected instead.",
                        SOCIAL_MAX_CHARS)));
            }
            Ok(fmt!(r#"{{"act":"propose","title":"{}","body":"{}"}}"#,
                json_escape(&title), json_escape(&body)))
        },
        SocialAct::Vote => {
            let n = match extract_json_number(args, "n") {
                Some(n) if n > 0 => n,
                _ => return Err(publish_refusal("vote",
                    "A vote needs 'n', the number of the proposal it is about. Read the panel \
                    with 'social_read' first; every proposal it lists carries its number.")),
            };
            // The three directions are WORDS and not the forge's own 1, -1 and 0.  A model
            // writing a schema field it half remembers writes a plausible integer, and the
            // plausible wrong integer here is 0 -- which the forge reads as a withdrawal.  The
            // words cannot be got wrong quietly: a fourth one is refused by name.
            let d = match extract_json_string(args, "d") {
                Some(d) => match Vote::from_id(d.trim()) {
                    Some(v) => v,
                    None    => return Err(publish_refusal("vote",
                        &fmt!("'{}' is not a vote. It is one of {}.",
                            d.trim().chars().take(40).collect::<String>(), Vote::names()))),
                },
                None => return Err(publish_refusal("vote",
                    &fmt!("A vote needs 'd', which is one of {}.", Vote::names()))),
            };
            Ok(fmt!(r#"{{"act":"vote","n":{},"d":{}}}"#, n, d.wire()))
        },
        SocialAct::Comment => {
            let n = match extract_json_number(args, "n") {
                Some(n) if n > 0 => n,
                _ => return Err(publish_refusal("comment",
                    "A comment needs 'n', the number of the proposal it is about. Read the panel \
                    with 'social_read' first; every proposal it lists carries its number.")),
            };
            let said = extract_json_string(args, "said").unwrap_or_default();
            if said.trim().is_empty() {
                return Err(publish_refusal("comment",
                    "The call named no 'said', so there is nothing to publish."));
            }
            if said.chars().count() > SOCIAL_MAX_CHARS {
                return Err(publish_refusal("comment",
                    &fmt!("A comment may be {} characters and this one is longer.",
                        SOCIAL_MAX_CHARS)));
            }
            Ok(fmt!(r#"{{"act":"comment","n":{},"said":"{}"}}"#, n, json_escape(&said)))
        },
        // The feed's own gate is the gateway's (Pro, follower caps, the meter) -- this checks
        // only what the model can get wrong before a round trip: something to say, and short
        // enough. The "publish this?" question the user answers still gates every call, exactly
        // as it does the other three acts.
        SocialAct::FeedPost => {
            let body = extract_json_string(args, "body").unwrap_or_default();
            if body.trim().is_empty() {
                return Err(publish_refusal("post to your followers",
                    "The call named no 'body', so there is nothing to publish."));
            }
            if body.len() > FEED_POST_MAX_BYTES {
                return Err(publish_refusal("post to your followers",
                    &fmt!("A post may be {} bytes of UTF-8 and this one is longer. Cut it down.",
                        FEED_POST_MAX_BYTES)));
            }
            Ok(fmt!(r#"{{"act":"feed_post","body":"{}"}}"#, json_escape(&body)))
        },
    }
}


/// Which view a `social_read` call is asking for, and the request the panel is handed for it.
///
/// Pure, for [`social_send_step`]'s reason.  It refuses nothing on grounds of permission -- the
/// owner's ruling is that reading is immediate -- so every refusal here is about the arguments.
///
/// # Arguments
/// * `args` - The raw tool arguments.
pub(super) fn social_read_step(args: &str) -> Result<String, String> {
    let view = match extract_json_string(args, "view") {
        Some(v) => match SocialView::from_id(v.trim()) {
            Some(v) => v,
            None    => return Err(refusal_line(&fmt!(
                "Nothing was read. '{}' is not one of the Social panel's views. They are {}.",
                v.trim().chars().take(40).collect::<String>(), SocialView::names()))),
        },
        // The panel opens on Proposals and so does this, rather than refusing: a model that has
        // just been told a Social panel exists and wants to know what is on it should not have
        // to be right about a vocabulary first.
        None => SocialView::Proposals,
    };
    let n = extract_json_number(args, "n").unwrap_or(0);
    if matches!(view, SocialView::Proposal) && n == 0 {
        return Err(refusal_line(&fmt!(
            "Nothing was read. The 'proposal' view reads ONE proposal in full and the call named \
            no 'n'. Read '{}' first; every proposal it lists carries its number.",
            SocialView::Proposals.id())));
    }
    let limit = extract_json_number(args, "limit").unwrap_or(SOCIAL_PAGE).clamp(1, SOCIAL_PAGE_MAX);
    Ok(fmt!(r#"{{"view":"{}","n":{},"limit":{}}}"#, view.id(), n, limit))
}


// ─────────────────────────────────────────────────────────────────────────────
// PDF and image text extraction (OCR)
//
// THE MODEL ONLY EVER RECEIVES TEXT.  A PDF or a photograph is turned into text by
// a server-side parser and only that text reaches the turn -- never the page
// pixels, never a base64 data URL in the context.  So `file_read` on a `.pdf` and
// the `ocr` tool both do their work in a throwaway request whose IMAGES stay on
// the far side, and hand back the transcript alone.
//
// Two request shapes, both verified against OpenRouter's and Mistral's live docs
// on 2026-08-31:
//
//   PDF   OpenRouter chat/completions with the `file-parser` plugin.  The engine
//         is chosen in the BODY (`plugins:[{id:"file-parser",pdf:{engine}}]`),
//         NOT a header.  The parsed text comes back as `annotations` on the
//         assistant message -- `choices[].message.annotations[].file.content[]`,
//         each a `{type:"text",text}` item -- which is the verbatim layer, read
//         directly rather than trusting the model to re-type it.  `cloudflare-ai`
//         is free and pulls an existing text layer; a scanned page has none, so
//         the free pass comes back empty and the caller escalates to
//         `mistral-ocr` ($2/1,000 pages), which reads the pixels server-side.
//
//   IMAGE Mistral's own OCR endpoint (`/v1/ocr`, `mistral-ocr-latest`) takes a
//         bare bitmap as `document:{type:"image_url",image_url:<data url>}` and
//         answers `pages[].markdown` -- TEXT, the cheap path.  Where no Mistral
//         key is configured the fallback is a vision model reading an `image_url`
//         part; that loads the picture into the THROWAWAY call's context (never
//         the turn's), so it is the token-heavier route and is flagged as such.
//
// Born-digital PDFs carry a real text layer that could be pulled locally, for
// free and offline -- a future fe2o3 upstream (fe2o3_stds has the `Media` sniff
// but no PDF reader today).  Logged, not blocked on: the free `cloudflare-ai`
// pass covers the same case over the wire until that lands.

/// OpenRouter's free PDF engine: lifts an existing text layer, no charge.
pub(super) const PDF_ENGINE_FREE: &str = "cloudflare-ai";

/// OpenRouter's paid OCR engine, for a scanned PDF with no text layer.
pub(super) const PDF_ENGINE_OCR: &str = "mistral-ocr";

/// Mistral's OCR model, for the direct image endpoint.
pub(super) const MISTRAL_OCR_MODEL: &str = "mistral-ocr-latest";

/// The cheap throwaway model the file-parser call names.  Its own words are
/// discarded -- the text is read from the `annotations`, not the reply -- so the
/// only thing asked of it is to be inexpensive and to accept a file part.
pub(super) const OCR_RELAY_MODEL: &str = "openai/gpt-4o-mini";

/// The vision model the image fallback names, where no text-returning OCR is
/// configured.  Must read pictures; `gpt-4o-mini` does and is cheap.
pub(super) const OCR_VISION_MODEL: &str = "openai/gpt-4o-mini";

/// What the vision fallback asks for: the words, and nothing else.
pub(super) const OCR_IMAGE_PROMPT: &str =
    "Transcribe every word of text in this image, verbatim and in reading order. \
     Output only that text: no description, no commentary, no code fences.";

/// US dollars `mistral-ocr` charges per page ($2 per 1,000 pages).
pub(super) const OCR_USD_PER_PAGE: f64 = 0.002;

/// How much extracted text counts as "something came back".  A scanned PDF put
/// through the free text-layer engine yields nothing, or a few stray ligatures;
/// below this many non-whitespace characters the free pass is treated as empty
/// and the caller escalates to real OCR.
pub(super) const OCR_EMPTY_FLOOR: usize = 8;

/// An OpenRouter chat body that runs the file-parser over one PDF at `engine`.
///
/// `data_url` is `data:application/pdf;base64,…`.  `max_tokens` is tiny because
/// the reply is thrown away; the text is taken from the annotations.
pub(super) fn ocr_pdf_body(data_url: &str, engine: &str) -> String {
    fmt!(
        r#"{{"model":"{}","max_tokens":16,"messages":[{{"role":"user","content":[{{"type":"text","text":"Parse this document."}},{{"type":"file","file":{{"filename":"document.pdf","file_data":"{}"}}}}]}}],"plugins":[{{"id":"file-parser","pdf":{{"engine":"{}"}}}}]}}"#,
        OCR_RELAY_MODEL, json_escape(data_url), engine)
}

/// A Mistral `/v1/ocr` body that transcribes one bitmap image to markdown text.
pub(super) fn ocr_image_mistral_body(data_url: &str) -> String {
    fmt!(
        r#"{{"model":"{}","document":{{"type":"image_url","image_url":"{}"}}}}"#,
        MISTRAL_OCR_MODEL, json_escape(data_url))
}

/// A vision chat body that asks a model to read the text off one image.
pub(super) fn ocr_image_vision_body(data_url: &str) -> String {
    fmt!(
        r#"{{"model":"{}","max_tokens":8192,"messages":[{{"role":"user","content":[{{"type":"text","text":"{}"}},{{"type":"image_url","image_url":{{"url":"{}"}}}}]}}]}}"#,
        OCR_VISION_MODEL, json_escape(OCR_IMAGE_PROMPT), json_escape(data_url))
}

/// Read one JSON string literal that starts at `bytes[i]` (the opening quote),
/// decoding the escapes JSON allows.  Returns the value and the index just past
/// the closing quote, or `None` if the literal never closes.
pub(super) fn read_json_string(bytes: &[u8], mut i: usize) -> Option<(String, usize)> {
    if i >= bytes.len() || bytes[i] != b'"' { return None; }
    i += 1;
    let mut out: Vec<u8> = Vec::new();
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\\' && i + 1 < bytes.len() {
            match bytes[i + 1] {
                b'"'  => { out.push(b'"');  i += 2; }
                b'\\' => { out.push(b'\\'); i += 2; }
                b'/'  => { out.push(b'/');  i += 2; }
                b'n'  => { out.push(b'\n'); i += 2; }
                b't'  => { out.push(b'\t'); i += 2; }
                b'r'  => { out.push(b'\r'); i += 2; }
                b'b'  => { out.push(0x08);  i += 2; }
                b'f'  => { out.push(0x0c);  i += 2; }
                // `\uXXXX`, which providers use for non-ASCII in some builds.  A
                // surrogate pair is decoded to the character it names; a lone one
                // is passed through as the replacement rather than dropped.
                b'u'  => {
                    match hex4(bytes, i + 2) {
                        Some(hi) if (0xD800..=0xDBFF).contains(&hi)
                            && bytes.get(i + 6) == Some(&b'\\')
                            && bytes.get(i + 7) == Some(&b'u') => {
                            match hex4(bytes, i + 8) {
                                Some(lo) if (0xDC00..=0xDFFF).contains(&lo) => {
                                    let c = 0x10000
                                        + ((hi as u32 - 0xD800) << 10)
                                        + (lo as u32 - 0xDC00);
                                    push_char(&mut out, c);
                                    i += 12;
                                }
                                _ => { push_char(&mut out, 0xFFFD); i += 6; }
                            }
                        }
                        Some(cp) => { push_char(&mut out, cp as u32); i += 6; }
                        None     => { out.push(b'\\'); out.push(b'u'); i += 2; }
                    }
                }
                other => { out.push(b'\\'); out.push(other); i += 2; }
            }
        } else if b == b'"' {
            return Some((String::from_utf8_lossy(&out).to_string(), i + 1));
        } else {
            out.push(b);
            i += 1;
        }
    }
    None
}

/// Parse four hex digits at `bytes[i..i+4]` into a code point, or `None`.
pub(super) fn hex4(bytes: &[u8], i: usize) -> Option<u16> {
    if i + 4 > bytes.len() { return None; }
    let mut v: u16 = 0;
    for k in 0..4 {
        let d = match bytes[i + k] {
            b @ b'0'..=b'9' => (b - b'0') as u16,
            b @ b'a'..=b'f' => (b - b'a' + 10) as u16,
            b @ b'A'..=b'F' => (b - b'A' + 10) as u16,
            _ => return None,
        };
        v = v * 16 + d;
    }
    Some(v)
}

/// Append the UTF-8 of a Unicode scalar to `out`, or the replacement character.
pub(super) fn push_char(out: &mut Vec<u8>, cp: u32) {
    let c = char::from_u32(cp).unwrap_or('\u{FFFD}');
    let mut buf = [0u8; 4];
    out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
}

/// Every value of `"<key>":"…"` in `region`, in order, decoded.
///
/// A deliberately shallow scan rather than a full parse: it is fed a slice that
/// already begins at the annotations, where the only `"text"` (or `"markdown"`)
/// keys are the parsed content items, so collecting them in document order
/// reassembles the transcript without a schema.
pub(super) fn json_values_for_key(region: &str, key: &str) -> Vec<String> {
    let needle = fmt!("\"{}\"", key);
    let bytes  = region.as_bytes();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = region[from..].find(&needle) {
        let at = from + rel;
        // Only a real key: preceded by `{`, `,` or whitespace, and it must be a
        // key (a colon follows, past any spaces) whose value is a string.
        let ok_prefix = at == 0 || {
            let p = bytes[at - 1];
            p == b'{' || p == b',' || p.is_ascii_whitespace()
        };
        let mut j = at + needle.len();
        while j < bytes.len() && bytes[j].is_ascii_whitespace() { j += 1; }
        if ok_prefix && j < bytes.len() && bytes[j] == b':' {
            j += 1;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() { j += 1; }
            if let Some((val, next)) = read_json_string(bytes, j) {
                out.push(val);
                from = next;
                continue;
            }
        }
        from = at + needle.len();
    }
    out
}

/// The verbatim text OpenRouter's file-parser returned, or empty when the parse
/// found none (a scanned page under the free engine).
///
/// Defensive by construction: the text is taken from the `annotations` -- both
/// the success shape (`choices[].message.annotations`) and the parse-succeeded-
/// but-generation-failed shape (`error.metadata.file_annotations`) -- and where
/// neither is present it falls back to the assistant's own `content`, so a build
/// that ever stops attaching annotations degrades to the reply rather than to
/// nothing.  A live smoke test still matters: reports have the endpoint drifting
/// from its docs, which is exactly what this fallback ladder absorbs.
pub(super) fn ocr_pdf_text(body: &str) -> String {
    for anchor in ["\"annotations\"", "\"file_annotations\""] {
        if let Some(pos) = body.find(anchor) {
            let joined = join_nonempty(&json_values_for_key(&body[pos..], "text"));
            if !joined.trim().is_empty() {
                return joined;
            }
        }
    }
    // Last resort: the model's own reply, scoped to the message so a request
    // echo cannot be mistaken for it.
    let scope = body.find("\"message\"").map(|p| &body[p..]).unwrap_or(body);
    extract_json_string(scope, "content").unwrap_or_default()
}

/// The text a vision model replied with: its message `content`.
pub(super) fn ocr_vision_text(body: &str) -> String {
    let scope = body.find("\"message\"").map(|p| &body[p..]).unwrap_or(body);
    extract_json_string(scope, "content").unwrap_or_default()
}

/// The markdown text a Mistral `/v1/ocr` reply carried, one page per item.
pub(super) fn ocr_mistral_text(body: &str) -> String {
    join_nonempty(&json_values_for_key(body, "markdown"))
}

/// Pages a Mistral OCR reply says it processed, where it says so.
pub(super) fn ocr_mistral_pages(body: &str) -> Option<u32> {
    extract_json_number(body, "pages_processed")
        .map(|n| n as u32)
        .filter(|n| *n > 0)
}

/// Join non-empty pieces with a blank line, trimming trailing whitespace.
pub(super) fn join_nonempty(parts: &[String]) -> String {
    parts.iter()
        .map(|s| s.trim_end())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Is this extraction empty enough to escalate from the free engine to OCR?
pub(super) fn ocr_text_empty(s: &str) -> bool {
    s.chars().filter(|c| !c.is_whitespace()).count() < OCR_EMPTY_FLOOR
}

/// A rough page count read straight from the PDF bytes, for the cost line.
///
/// Counts `/Type /Page` objects (never `/Pages`, the tree node), tolerating the
/// optional space PDF writers vary on.  Approximate on purpose: it prices the
/// OCR to the right order without a full PDF parser, and the note says "about".
pub(super) fn pdf_page_count(bytes: &[u8]) -> Option<u32> {
    let mut n = 0u32;
    let mut i = 0;
    let pat = b"/Type";
    while i + pat.len() < bytes.len() {
        if &bytes[i..i + pat.len()] == pat {
            let mut j = i + pat.len();
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\r'
                || bytes[j] == b'\n' || bytes[j] == b'\t') { j += 1; }
            if j + 5 <= bytes.len() && &bytes[j..j + 5] == b"/Page" {
                // `/Page` but not `/Pages`: the char after must not be a name char.
                let after = bytes.get(j + 5).copied().unwrap_or(b' ');
                if !after.is_ascii_alphabetic() {
                    n += 1;
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }
    if n > 0 { Some(n) } else { None }
}

/// The dollar cost of OCR'ing `pages` at Mistral's rate.
pub(super) fn ocr_cost_usd(pages: u32) -> f64 {
    pages as f64 * OCR_USD_PER_PAGE
}

/// The one-line record `file_read` and `ocr` append: which engine ran, and what
/// it cost.  No consent, no gate -- the cost is stated for the record, after the
/// fact, exactly as the owner's no-spend-gate autonomy design requires.
///
/// # Arguments
/// * `tag`    - the tool tag the note opens with, e.g. `"file_read"` or `"ocr"`.
/// * `what`   - `"a PDF"` or `"an image"`, for the sentence.
/// * `engine` - a human name for the engine: `"the free text layer"`, etc.
/// * `pages`  - pages processed, where known.
/// * `paid`   - whether this engine charges, so a cost is worth stating.
pub(super) fn ocr_note(tag: &str, what: &str, engine: &str, pages: Option<u32>, paid: bool) -> String {
    let mut s = fmt!("\n[{}] read as {} via {}", tag, what, engine);
    match (paid, pages) {
        (true, Some(p)) =>
            s.push_str(&fmt!("; about {} page(s), ${:.3} on your OpenRouter key.", p,
                ocr_cost_usd(p))),
        (true, None) =>
            s.push_str("; paid OCR on your OpenRouter key, about $0.002 per page."),
        (false, Some(p)) =>
            s.push_str(&fmt!("; {} page(s), no charge.", p)),
        (false, None) =>
            s.push_str(", no charge."),
    }
    s
}

/// The message `ocr` gives a file it cannot transcribe: the format, named, and
/// what to do instead.  Never a silent failure -- the caller reads this and acts.
///
/// `ocr` takes a PDF, the four common bitmaps, and every picture
/// `fe2o3_graphics::convert` can turn into one (BMP, TIFF, HEIC, ICO), converting it
/// itself.  An SVG is text, so it is sent to `file_read`.  What is left is named and
/// turned away, and never with "convert it": the daimon has nothing to convert with.
pub(super) fn ocr_unsupported(path: &str, bytes: &[u8]) -> String {
    match Media::sniff(bytes) {
        Media::Svg => fmt!(
            "ocr: '{}' is an SVG drawing, which is TEXT -- read it with file_read, not OCR.",
            path),
        m @ (Media::Tiff | Media::Bmp | Media::Heic | Media::Avif | Media::Ico) => fmt!(
            "ocr: '{}' is a {} this cannot read, so its text cannot be got at here. Tell the \
             person, naming the file; file_show may still display it.",
            path, m.label()),
        _ => fmt!(
            "ocr: '{}' is neither a PDF nor a picture this reads (PNG, JPEG, WebP, GIF, BMP, \
             TIFF, HEIC or ICO). A document is read by file_read.",
            path),
    }
}

/// The picture or pictures `ocr` sends for a file that is not a PDF, each as a `data:` URL the
/// OCR services take.  A common bitmap goes as it is; anything else is the refusal
/// [`ocr_unsupported`] words.
pub(super) fn ocr_images(path: &str, bytes: &[u8]) -> Outcome<Vec<String>> {
    use oxedyne_fe2o3_graphics::convert;
    match ImageMedia::sniff(bytes) {
        Some(m) => Ok(vec![fmt!("data:{};base64,{}", m.mime(), base64::encode(bytes))]),
        // A BMP, TIFF, HEIC or icon is converted here, every page of it: the daimon has nothing
        // to convert with, so sending it away to do so was a dead end (UNBLOCK-25).
        None if convert::decodable(Media::sniff(bytes)) => {
            let pages = match convert::to_common(bytes) {
                Ok(p)  => p,
                Err(e) => return Err(err!(e, "ocr: '{}' is a {} this could not read.", path,
                    Media::sniff(bytes).label(); Invalid, Input)),
            };
            if pages.is_empty() {
                return Err(err!("ocr: '{}' holds no pages.", path; Invalid, Input));
            }
            Ok(pages.iter().map(|c| c.data_url()).collect())
        }
        None    => Err(err!("{}", ocr_unsupported(path, bytes); Invalid, Input)),
    }
}

/// One transcript already extracted, kept for a free re-read.
#[derive(Clone)]
pub(super) struct OcrHit {
    pub(super) text:   String,         // the verbatim transcript
    pub(super) what:   &'static str,   // "a PDF" or "an image", for the note
    pub(super) engine: String,         // which engine ran
    pub(super) pages:  Option<u32>,    // pages processed, where known
    pub(super) paid:   bool,           // whether the engine charged
}

// Transcripts extracted this session, by content hash, so re-reading the same
// PDF or image costs nothing.  Memory only, on purpose: it need not outlive the
// page, and a cache written into the workspace would be a file the user sees and
// a device syncs.  Wasm is single-threaded, so a `thread_local` is the whole of
// the concurrency story (and per thread off the browser, which is all a cache needs).
thread_local! {
    pub(super) static OCR_CACHE: std::cell::RefCell<std::collections::HashMap<u64, OcrHit>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}
