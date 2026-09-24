/* ============================================================
   Daimond — cross-device sync (sync.js)
   ------------------------------------------------------------
   Carries a user's work from one device to the next through the
   gateway's opaque, end-to-end-encrypted mailbox (/api/sync).

   The gateway never sees the content. This module seals the state
   with DaimondIdentity.wrap() — AES-GCM under the passphrase-derived
   key — before it leaves the browser, and opens it with unwrap()
   after it arrives. What the server stores is ciphertext it holds no
   key for; it is a parcel office, not a filing cabinet.

   Two devices sharing one account share one salt (the identity
   travels whole, salt included — see DaimondIdentity.exportBundle),
   so both derive the same wrapping key and each can open the other's
   blob. A device holding a different identity is a different account
   with a different mailbox and never sees this one's parcels.

   CONCURRENCY. The gateway stores one blob at a monotonic version and
   accepts a push only if it names the version it was based on
   (compare-and-set). A stale push comes back 409 with the current
   blob; this module pulls it, MERGES — union the transcripts, freshest
   scalar wins, tombstones honoured, exactly as the cross-tab path does
   — and retries. So two devices editing at once converge rather than
   clobber. Two rules keep that honest: a merge that did not finish is
   never pushed over (the retry would replace the other device's version
   with one that never took its work), and running out of retries is
   reported rather than logged.

   A push never runs over a live turn (that state is still settling)
   and only fires when the app is idle, mirroring updater.js. A PULL
   also fires when the window is focused, throttled: a device left open
   on a desk otherwise never learned about the other one's work until
   somebody reloaded it, and coming back to a window is exactly when its
   owner expects to see what happened elsewhere.

   AND A PUSH WITH NOTHING TO SEND PULLS INSTEAD. Two windows on two
   machines, both open and both focused, raise no focus event between
   them and end no turns; the only trigger still running on the device
   nobody is typing at is the push, and a push whose parcel matches the
   last one used to return without asking the gateway anything. So the
   device being worked on sent its work and the device being read never
   looked, indefinitely. That skip is now a throttled pull.

   WHEN IT CANNOT WORK, IT SAYS SO. Three refusals are permanent until
   something changes -- 402 (the tier is not held), 413 (the parcel is
   over the gateway's ceiling) and a 401 that a fresh session could not
   clear -- and all three are reported on the status chip and nowhere
   else: state on the chip, reason on hover, never a dialog over the app,
   since nobody asked for the round that failed. The 413 used to log to
   the console alone, so sync stopped and the app went on looking exactly
   as it does when sync is working.

   THE 401 WAS THE ONE THIS LIST NEVER ENUMERATED. The gateway's session
   lives an hour and nothing renewed it, so every request after that was
   refused: the pull called restStatus() and HID the chip, the push fell
   past the 402/413 arms into one console line, and the wake channel
   reconnected on a backoff for ever. A real account spent four hours and
   fifty minutes that way, seven pushes of the user's work discarded with
   the app positively claiming to be connected. A 401 now takes a fresh
   session and sends the request again (see call()), and only says so
   when that could not be done.

   A jam is the last thing the chip says, and it is the same rule
   applied to the reconcile: retries that ran out, or a parcel that
   arrived and could not be merged, both leave this device's work
   sitting here, and both used to leave "Synced" on the chip -- put
   there by the pull that was only ever half of the round.

   THE PARCEL CARRIES THE PAUSE TREE. Which Diamonds, mailboxes and
   folders may spend is a fact about the ACCOUNT, not about the
   browser it was set in: a device paused on one desk that spends
   freely on the other is the control not working. pause.js holds
   that state and answers for it, so it is attached here, at the
   wire, rather than reached for from the collector. Its snapshot is
   one entry per node, SORTED by id, that moves only when a press or
   the app's own write does -- which is the whole of what keeps two
   collects byte-identical, and the reason nothing in this file may
   stamp on the way in.

   AND NOW THE GATEWAY SAYS WHEN. Every trigger above is something
   that happened on THIS device, so a window left open and unfocused
   on a second desk had none: no turn ends there, nothing is renamed,
   nobody comes back to it, and the catch-up in push() is throttled to
   a trickle. It converged when somebody touched it, and not before --
   which is how it was reported from a live account. So the device no
   longer has to guess. It holds a channel open to the gateway, and
   the gateway taps it the moment another device's push lands. What
   crosses that channel is one integer, the new version, and the
   device answers it with the pull it would have run on focus. See
   the wake channel below.

   AND WHERE THE GATEWAY CANNOT SAY, THE DEVICE ASKS. The channel is
   a WebSocket, or a parked request, through whatever front door the
   account is reached by, and a door that carries neither shuts it for
   the life of the page. What was left then was the triggers of the
   first kind again -- and a second browser open on a desk raises none
   of them, so it sat on state from whenever it was last touched. Two
   reports, one cause: turns taken in one browser did not appear in the
   other, and two views of one account showed two different spend
   tallies. So there is a catch-up now, gated on the channel being
   quiet: a device that will be told pays nothing for it. See catchUp.
   ============================================================ */
(function () {
	'use strict';

	var PATH        = '/api/sync';
	var WS_PATH     = '/api/sync/ws';	// The wake channel's WebSocket form.
	// The contract version this build speaks is gateway.js's to own, and it is
	// read from there (`DaimondGateway.clientApi()`) rather than copied: two
	// constants that have to match are two constants that will eventually not.

	var PUSH_DEBOUNCE_MS = 2500;	// Coalesce a flurry of changes into one push.
	var MAX_CONFLICT_RETRIES = 8;	// Bound the pull-merge-retry loop (was 4): more headroom under 3-device churn.
	var CONFLICT_BACKOFF_MS  = 200;	// Jittered wait between conflict retries so busy devices do not collide every attempt.
	var UNSENT_RETRY_MIN_MS  = 1000;	// First retry of work a push left unsent (`unsent`).
	var UNSENT_RETRY_MAX_MS  = 60000;	// Its backoff never grows past this after a conflict, and has no try limit (was 8 s: D110).
	var UNSENT_RETRY_TRIES   = 2;	// An owed retry's conflict tries: the one it sends, and one rebased on the pull that answers it.
	var UNSENT_WIRE_MAX_MS   = 300000;	// Nor past this after any other failure. See armUnsent.
	var RETRY_AFTER_MAX_MS   = 3600000;	// A gateway's Retry-After past this is read as this.
	var FLUSH_MAX_ROUNDS     = 6;	// Bound flush()'s push-and-confirm loop.
	var FLUSH_RETRY_MS       = 300;	// Wait between flush() rounds while a push is in flight elsewhere.
	// Focus arrives in bursts -- a click into the window raises focus on the
	// window and a visibilitychange with it -- so the pull is debounced into one,
	// and then rate-limited.
	var FOCUS_DEBOUNCE_MS = 400;
	// THIRTY SECONDS WAS TOO LONG, AND THE NUMBER WAS THE WHOLE DEFECT. Working in
	// one browser and glancing at the other is something people do all afternoon,
	// and a glance that landed inside the window showed whatever the previous one
	// had left -- which is indistinguishable from sync not working, and was
	// reported as exactly that. What a throttle is for here is a click storm, and
	// the debounce above already deals with one; what is left is a single small
	// GET per return to a window, which is cheap, and a return to a window is
	// precisely when its owner expects to see the other device's work.
	var FOCUS_PULL_MIN_MS = 3000;
	// A push with nothing to send asks anyway, at most this often. See push().
	var IDLE_PULL_MIN_MS  = 5000;
	// ── The front door, in bytes of HTTP BODY ──────────────────
	//
	// Steel terminates TLS in FRONT of the gateway on jarrah and the key is absent
	// from the deployed config, so fe2o3_steel's `http_max_body_bytes` default
	// stands. It is the smallest of the three ceilings over a parcel -- the
	// gateway's own /api/sync `max_bytes` is 32 MiB and its body cap 16 MiB -- so it
	// is the only one anything ever reaches, and a parcel over it 413s or, worse,
	// looks like a connection reset, because Steel answers and closes while the
	// browser is still writing the body.
	//
	// WHAT IS MEASURED AGAINST IT IS NOT THE PARCEL. The body is a JSON envelope
	// carrying base64 of the SEALED parcel: four bytes for every three of
	// ciphertext, and the ciphertext is the UTF-8 of the parcel plus a 12-byte IV
	// and a 16-byte GCM tag. `wireBytes` does that arithmetic; daimond.js
	// `SYNC_PARCEL_MAX` is the budget derived FROM it, which is a different number
	// and in different units (UTF-16 code units, counted with String.length).
	var WIRE_DOOR_BYTES   = 8 * 1024 * 1024;
	// ── The pull budget and the resume ─────────────────────────
	// A GET iOS suspended on a backgrounded tab never rejects until the socket
	// resolves on resume, and while it hangs it pins `inFlight` so every re-open
	// trigger stands down behind it. So a content PULL carries a budget: an abort
	// after this frees the gate whether or not the socket ever answers. Every other
	// read gets the same budget unless it names its own; the wake poll parks far
	// longer on purpose and passes 0; see wakePoll.
	var PULL_TIMEOUT_MS = 18000;
	var GATE_WAIT_MS    = 250;		// how often a caller outside the engine looks for the gate to free
	// ── The write deadline ─────────────────────────────────────
	// EVERY WRITE HAS A DEADLINE: this long, plus its body at the slowest upload
	// that still counts as a link, and never more than the ceiling. A push used to
	// have none, because an aborted POST was the user's work silently not travelling
	// (the seq-228 regression). Since release 4 a push that does not land is OWED and
	// retried on the wire's ladder (`armUnsent`), so an abort loses nothing. What had
	// no deadline did lose something: a POST the network black-holed, or iOS froze at
	// suspension, held `inFlight` for as long as the OS kept the socket, so every pull
	// stood down behind it and the chip said "Syncing…" throughout (P1a H3,
	// 2026-09-25). A write is still never registered as `pullAbort`, so a resume
	// cannot cancel one: only its own deadline ends it.
	var WRITE_DEADLINE_MS     = 60000;
	var WRITE_FLOOR_BPS       = 65536;		// 64 KiB/s
	var WRITE_DEADLINE_MAX_MS = 300000;
	// A hidden spell shorter than this is an alt-tab glance, not a re-open: it keeps
	// the ordinary throttled focus pull, so flipping between tabs does not become a
	// GET storm. Longer -- or a bfcache restore, or a pull left frozen -- is a
	// genuine resume, which re-arms the channel and pulls PROMPTLY through the one
	// throttled focus path (never a burst). This is what keeps the normal foreground
	// cadence unchanged.
	var RESUME_MIN_HIDDEN_MS = 3000;
	// While a hand-off is in flight (a turn dispatched to another device and its
	// answer not yet here), the watching devices poll this often rather than wait out
	// the 45s wake tick -- the net under a backgrounded iOS tab whose wake park iOS
	// has frozen. Throttled against the last pull of ANY kind (like the catch-up), so
	// where the wake channel IS delivering the progress pushes this mostly stands
	// down and costs nothing; where the park is frozen, it is the thing that asks.
	// A GET, served to every device, so it is never a per-turn charge.
	var EXPEDITE_PULL_MS = 4000;
	// A hand-off's answer arrives within one of these of the dispatch on any healthy
	// path (the runner claims, runs, pushes; the streaming frames land throughout). A
	// placeholder still outstanding past this is a STUCK hand-off -- a peer that never
	// claimed, an errand merely HELD on the relay -- and pulling the whole 1.4 MB parcel
	// every 4 s for it is the amplifier that fed the request storm. Past this the expedite
	// poll stands down and the 45 s wake tick plus the dispatcher's ~95 s recovery backstop
	// carry it, so the full-parcel poll is bounded to the window a live hand-off needs and
	// a stuck one no longer floods. A GET only -- the single-runner lease is untouched.
	var EXPEDITE_MAX_MS = 120000;
	// How often a page following progress frames reads them itself, while its wake
	// channel has not been heard to tap it: no channel at all, or a gateway older than
	// the tap, which never sends one. See `progressTick`.
	var PROGRESS_TICK_MS = 4000;
	// ── The streaming progress push ────────────────────────────
	// The minimum spacing between the OLD-gateway whole-parcel progress pushes. On a
	// current gateway a hand-off streams through the lightweight frame door
	// (pushProgressFrame) and this whole-parcel `pushProgress` is NOT taken at all --
	// the runner's frame dep falls back to it only when the door is absent (a pre-door
	// gateway). So this floor now bounds only that fallback, and it is raised to 10 s:
	// a whole-account `collectSync` every 1.8 s is the ~40 MB-per-frame cost the S1
	// collect fix exists to avoid, and on a pre-door gateway a slower stream is the
	// right trade against it. The runner's own timer lives in peer.js runErrand.
	var PROGRESS_PUSH_MIN_MS = 10000;
	// The most a single frame may carry, in characters of PLAINTEXT tail. The
	// gateway's own ceiling is 64 KiB of ciphertext and it refuses a frame over it
	// (413, naming the ceiling); this keeps the ordinary frame comfortably under,
	// so the refusal path is for a surprise and not for every long turn. A tail is
	// the END of the transcript, so trimming it loses the oldest lines, which the
	// watching device already has from the frame before.
	var PROGRESS_TAIL_MAX = 48 * 1024;
	// ── Wake channel ───────────────────────────────────────────
	// A wake is EVIDENCE that the mailbox moved, which the speculative triggers
	// above are not, so it has a throttle of its own and a much shorter one: the
	// only pull a wake needs to stand down for is one that has just this second
	// asked the same question.
	var WAKE_PULL_MIN_MS  = 1000;
	// How long the gateway is asked to hold a parked request. Under a minute, so
	// no intermediary decides it has stalled; the gateway clamps it anyway.
	var WAKE_POLL_MS      = 45000;
	// A floor under the poll loop, so a gateway answering instantly (or a proxy
	// answering for it) can never become a hot loop.
	var WAKE_POLL_FLOOR_MS = 800;
	// Reconnect backoff after a socket that HAD opened went away. Jittered, so a
	// gateway restart does not bring every device back in the same millisecond.
	var WAKE_RETRY_MIN_MS = 1000;
	var WAKE_RETRY_MAX_MS = 30000;
	// Consecutive sockets that closed without ever opening before the channel
	// gives up on WebSocket and parks plain requests instead. Two: one to be
	// unlucky, one to be sure.
	var WAKE_WS_TRIES     = 2;
	// The park the channel makes before it reaches for a socket. Short: it is
	// asking whether there is a gateway there, not waiting for news.
	var WAKE_PROBE_MS     = 1000;
	// How often the channel is checked against what the app is doing -- signed
	// in or not, entitled or not. Cheap, and it means no other file has to raise
	// an event this one listens for.
	var WAKE_WATCH_MS     = 10000;
	// ── The catch-up ───────────────────────────────────────────
	// Every trigger above is either something that happened on THIS device or the
	// gateway's own tap, and the tap is a WebSocket -- or a parked request --
	// through whatever front door the account is reached by. Where that door
	// carries neither, `wakeMode` goes to 'off' for the life of the page, and the
	// second device is back to triggers of the first kind. A window nobody is
	// typing at has none of them: no turn ends there, nothing is renamed, nobody
	// comes back to it. It converged when somebody touched it, and not before.
	//
	// That was reported twice from one real account and read as two faults --
	// turns taken in one desktop browser not appearing in the other, and two views
	// of one account showing two different token cost tallies. Both are the one
	// thing: the reading device never asked.
	//
	// So a device that cannot be TOLD, asks. Only then: a channel that is carrying
	// makes this cost nothing, which is why it is gated on the channel rather than
	// run unconditionally -- a pull on every open tab on a timer is a real bill on
	// a real account, and the wake channel exists so that nobody pays it.
	var CATCHUP_MS      = 20000;	// How stale a device with no channel may get.
	// How often that is checked, which is NOT the same number: a tick equal to the
	// threshold puts the real ceiling at twice it.
	var CATCHUP_TICK_MS = 5000;
	// ── The re-apply ───────────────────────────────────────────
	// A pull that read a parcel but could not MERGE one of its sections does not
	// adopt the version any more (see pullOnce): the client stays at the version it
	// last fully applied, so it is not falsely caught up to work it never took. The
	// section that failed is the news it is missing, and nothing else will fetch it
	// -- a wake pull fires only for a HIGHER version, and the focus and idle pulls
	// are throttled -- so this re-pulls the SAME version itself, on a backoff, until
	// the merge finishes. The store being read (the common cause -- a cold tab that
	// pulled before its first store read) or a transient quota clearing both end it.
	// Bounded, so a section that fails for a reason that will NOT clear on a re-read
	// (a genuinely malformed parcel) cannot become a hot loop: after the cap the
	// auto-retry stands down and the version is simply left un-adopted, and the
	// ordinary triggers (a higher version, a focus, the idle catch-up) go on trying.
	var REAPPLY_BASE_MS  = 1500;	// First re-pull this soon after a failed merge.
	var REAPPLY_MAX_MS   = 60000;	// The backoff never grows past this.
	var REAPPLY_MAX_TRIES = 6;		// Auto-retries for one un-adopted version before standing down.
	var K_VERSION = 'daimond-sync-version';		// Per-account (accounts.js prefixes it).
	var K_LAST    = 'daimond-sync-last';		// When a sync last succeeded, for the chip.
	// The digest of the parcel this device last got into the mailbox, so the FIRST
	// push of a new page can tell that it has nothing to say. Same `daimond-`
	// prefix as the two above and for the same reason: accounts.js namespaces
	// every one of these, so a second account answers its own question.
	var K_SIG     = 'daimond-sync-sig';
	// What this build writes into it. A stored value that does not say this is
	// from another format and reads as no fixed point at all -- which sends.
	//
	// 2 since the digest is taken over the COMPARISON KEY rather than the parcel
	// (see compareKey): a v1 digest is of different bytes, and letting it stand
	// would have a freshly updated page read "nothing to send" wrongly in one
	// direction or push once for nothing in the other. One push on the first boot
	// after the update, and never again.
	var SIG_V     = 2;

	// ── State ──────────────────────────────────────────────────
	var serverVersion = 0;		// The version this device last saw on the server.
	var lastPushed    = null;	// comparison key of the state last pushed (see compareKey).
	// THE SAME FACT, CARRIED ACROSS A RELOAD, and consulted by the first push of a
	// page and by nothing else.
	//
	// `lastPushed` above is memory, so it begins every page as null and the guard
	// in push() could not match after a refresh -- the whole parcel went up
	// whether or not a byte had changed. The owner saw it as the sync chip cycling
	// twice a couple of seconds apart after a hard refresh: the boot pull, and
	// then a push with nothing in it to send. Measured at 163 KB on an account
	// holding one chat, on every reload.
	//
	// DELIBERATELY ONLY THE FIRST PUSH. Once this page has sent something,
	// `lastPushed` is the exact answer and this is not consulted again -- so
	// nothing about the steady state of a running tab is changed by it, and the
	// digest is computed once per page rather than once per push. A wider version
	// of this cost six checks in dev/verify_sync.mjs's park-fallback section: the
	// guard reached pushes it had never reached before, and a device that skipped
	// one left the mailbox where it was and the other device's parked request
	// unanswered.
	var bootSig       = '';		// '' means no fixed point, which always sends.
	var entitled      = true;	// Cleared to false on a 402; stops pointless pushes.
	var tooLarge      = false;	// Set on a 413; the parcel will not fit as it stands.
	// Set on a 401 that a fresh session could not clear. Standing, like the two
	// above: until there is a session again nothing leaves this device.
	var sessionGone   = false;
	// A reconcile that could not finish: '' | 'busy' (the retries ran out) |
	// 'merge' (what arrived could not be merged here). Both mean this device's
	// work did NOT leave, and both are cleared by the next round that works.
	var jammed        = '';
	var lastFailed    = [];		// Sections the last merge could not apply.
	// THE NEWEST VERSION THIS DEVICE PULLED AND COULD NOT MERGE, or 0. That version is
	// the bounded re-pull's (`scheduleReapply`), never the wake channel's: the channel
	// used to park `?above=serverVersion`, which a failed merge deliberately leaves
	// behind, so the gateway answered every park at once and the channel pulled the
	// same whole parcel about once a second for as long as the merge kept failing --
	// 565 GETs and 772 MB in ten minutes (P1a H2, 2026-09-25). See `heardUpTo`.
	var failedVersion = 0;
	// Work that has not reached the mailbox, and its retry. OWED FROM THE MOMENT A PUSH
	// HAS SOMETHING NEW TO SEND, and paid only when one lands (`paid`). It used to be owed
	// only by the failure branches that remembered to (a 409 whose pull failed, and
	// running out of conflict tries), so a POST that threw, any 5xx or 429, and a 409
	// whose merge was incomplete all left the work in this device's store with no retry
	// and a chip that said nothing was wrong (R3 sync QA S5, S6, 2026-09-24). Unlike
	// `jammed`, which a clean pull clears, this stands until a push lands, because a pull
	// is not a send.
	var unsent            = false;
	var unsentTimer       = null;
	var unsentDue         = 0;	// when the armed retry fires, so a Retry-After can move it
	var unsentFailVersion = 0;	// the mailbox version when an owed push last failed
	var unsentTries       = 0;
	var failKind          = '';	// 'conflict', 'merge', or anything else: which ladder the retry climbs. See armUnsent.
	var holdUntil         = 0;	// the time a gateway's 429 or 503 asked this device not to return before
	// A passphrase was changed on another device and this one is BEHIND the epoch chain
	// -- it could not walk the links to the account's current key (a missing link, or a
	// chain longer than this build kept). It cannot read the account and must NOT push
	// its own over the top, so this is sticky: it stands until the device is linked again
	// (importBundle brings it to the current epoch) or adopts a record it can walk. Set
	// in pullOnce, cleared by a successful adopt.
	var rekeyBehind   = false;
	// The in-flight epoch adoption, or null. Two pulls (a focus pull and the timer,
	// say) can arrive with the same rekey record at once; each would run readAll /
	// swap / resealAll, and the second would readAll under a key the first has already
	// changed. `withAdoptLock` serialises them behind this one promise (D7), so only
	// one adoption runs and the other sees the epoch already advanced.
	var adopting      = null;
	var lastSynced    = 0;		// ms of the last successful pull or push.
	var pushTimer     = null;	// Debounce handle.
	var focusTimer    = null;	// Focus-pull debounce handle.
	var reapplyTimer  = null;	// The re-pull-the-same-version handle; see the re-apply.
	var reapplyTries  = 0;		// How many auto-retries this un-adopted version has had.
	var lastFocusPull = 0;		// ms of the last pull a focus caused.
	// ms of the last pull that reached the gateway, whatever asked for it. The
	// catch-up below is measured against THIS rather than against its own last
	// go: a device that pulled a second ago because its window was focused has
	// nothing to learn from asking again, and a second reason to ask is not a
	// second thing to know.
	var lastPullAt    = 0;
	var inFlight      = false;	// One sync operation at a time.
	// A PARCEL WRITE is what holds the gate: push() or a progress frame. Owed work is
	// "Syncing…" only while one of these is sending it; a PULL round is not a send, and
	// reading "a round is running" as "the work is going" is what let the chip rest
	// with work owed (SIM-8). See owedNow and endRound.
	var pushing       = false;
	// The AbortController of a content PULL in flight, so a resume can break a frozen
	// GET at once rather than wait out its budget. Set by `call` ONLY when the caller
	// asks (the content pull does; a write NEVER is). Read by onResume. A push is
	// never registered here, so a resume can never cancel one; its deadline can.
	var pullAbort     = null;
	// ms the tab last went hidden (0 = visible, or never hidden this page). Used by
	// onResume to tell a genuine re-open from an alt-tab glance.
	var hiddenAt      = 0;
	// ms of the last progress push, to throttle the runner's streaming trickle.
	var lastProgressAt = 0;
	// Whether a hand-off is in flight and this device is watching for its answer: the
	// dispatcher, and any paired device holding the dispatched placeholder. Set by
	// daimond.js through the `expedite` verb; drives the short in-flight poll.
	var expediting    = false;
	var expediteTimer = null;	// The in-flight-poll interval, live only while expediting.
	var expediteSince = 0;		// when the current expedite window began, for EXPEDITE_MAX_MS
	var started       = false;	// The engine has attached its listeners.
	var catchupTimer  = null;	// The catch-up supervisor, for a device with no channel.
	// This device has read the mailbox and knows what is in it -- a parcel it
	// merged, or an empty mailbox. Only then may it publish an account-wide fact
	// nobody has told it, which at the moment means the look and nothing else.
	// See collectParcel.
	var pulledOk      = false;
	// Whether this device had already synced THIS account when the page loaded.
	// Read once, at start, before this session's own rounds move the cursor, and
	// it is the only honest evidence that a device is not new to the account:
	// storage full of `daimond-` keys is not, since the app writes a default
	// theme and skin on every boot including the first. What turns on it is
	// whether a look that arrives is worn or merely recorded -- see pairing.js.
	var knownDevice   = false;

	// ── Wake channel state ─────────────────────────────────────
	// This tab's own channel id, named on the channel AND on every push, so the
	// gateway can wake the account's other devices without waking this one. It
	// starts with a letter so it is unambiguously a string in a query.
	var WAKE_ID = 'wk' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
	var wakeMode    = '';		// '' | 'ws' | 'poll' | 'off'
	var wakeSock    = null;		// The live WebSocket, if there is one.
	var wakeTimer   = null;		// Reconnect handle.
	var wakeWatcher = null;		// The supervisor interval.
	var wakeFails   = 0;		// Sockets that closed without ever opening.
	var wakeWorked  = false;	// A socket has opened at least once on this page.
	var wakeBackoff = WAKE_RETRY_MIN_MS;
	var wakePolling = false;	// A park loop is running.
	var wakeProbing = false;	// The one-shot park that decides the transport is out.
	var wakeGen     = 0;		// Bumped on teardown, so an in-flight loop stands down.
	// WHICH GENERATION each of those two belongs to, and the whole reason they are
	// here: a teardown can stand a loop down but it cannot take back the request
	// that loop is parked on, and the gateway holds one of those for three
	// quarters of a minute. For all that time `wakePolling` was true of a loop
	// that had already stopped listening -- so the re-armed channel turned round
	// at its own front door (`if (wakePolling) return`) and parked NOTHING, and
	// `wake()` reported a channel that was open on the strength of the same flag.
	// A generation beside each flag is what tells a live park from an abandoned
	// one. Start below zero, which is no generation at all.
	var wakePollGen  = -1;
	var wakeProbeGen = -1;
	var wakeTarget  = 0;		// The highest version the channel has heard about.
	var wakeSoon    = null;		// The coalescing timer for the pull a wake asks for.
	// Whether the channel was shut ON PURPOSE, which is a different fact from
	// `wakeMode === 'off'`. The road refusing to carry a channel is exactly what
	// the catch-up is for; somebody asking for this device to go quiet is exactly
	// what it must not talk over. See `wakeVia` and `catchUp`.
	var wakeShut    = false;
	var wakes       = 0;		// Wakes acted on, for the verifier and for debugging.
	// The park the poll transport is holding, so a change in what it must listen for
	// can end it at once rather than wait out forty-five seconds. See `wakePoll`.
	var wakeHold    = { ac: null };
	var wakeKicked  = false;	// The held park was ended on purpose, not by a fault.

	// ── Progress watch state ───────────────────────────────────
	// Every stream of progress frames this page follows, by key -> { since, onFrame }.
	// A key is a handed-off turn or a compile. See `watchProgress`.
	var progWatch   = Object.create(null);
	var progSweeping = false;	// A sweep is reading the door.
	var progAgain    = false;	// A tap arrived during the sweep: read once more after it.
	var progTaps     = 0;		// Taps heard, for the verifier and for debugging.
	var progTapGen   = -1;		// The wake generation the gateway last tapped, -1 for none.
	var progTimer    = null;	// The tick that reads the frames where no tap comes.

	function log(/* ...args */) {
		try { if (window.console && console.debug) console.debug.apply(console, ['[sync]'].concat([].slice.call(arguments))); }
		catch (e) { /* ignore */ }
	}

	/// One line in the durable trail, for a bug only a phone can see.
	function trail(w, d) { try { window.DaimondTrail.note(w, d); } catch (e) {} }

	/// One line in the opt-in diagnostics ring (www/js/diag.js). A no-op when
	/// Diagnostics is off; ids, counts and versions only, never content.
	function diag(tag, d) { try { if (window.DaimondDiag) DaimondDiag.log(tag, d); } catch (e) {} }

	/// Lift a safe start, and reload so the engine gets its boot back.
	///
	/// A reload rather than a `start()` here: everything this file does at a boot
	/// has already not happened, and half-starting it into a running page would
	/// leave listeners registered twice. Asked first, because a mis-tap on a chip
	/// must not throw away what the user is in the middle of.
	async function turnSyncBackOn() {
		var ok = true;
		try {
			if (window.DaimondCore && DaimondCore.confirm) {
				ok = await DaimondCore.confirm(t('safe.turn_on_ask'), t('safe.turn_on_ok'),
					{ title: t('safe.turn_on_title'), danger: false });
			}
		} catch (e) { ok = false; }			// no dialog available: do nothing rather than reload
		if (!ok) return;
		DaimondSafe.set(false, 'user');
		location.reload();
	}

	/// Whether sync can run at all right now: an unlocked identity (for the key)
	/// and an authenticated gateway session (for the mailbox).
	///
	/// A SAFE START is refused here and nowhere else. Every entry point in this
	/// file already asks -- pull, push, the debounce, the wake channel, the
	/// re-check after a tier change -- so one gate stops all of them, and there is
	/// no second copy of the rule to fall out of step with this one. See safe.js
	/// for why the app can be asked to start without sync at all.
	function ready() {
		if (window.DaimondSafe && DaimondSafe.on()) return false;
		return !!(window.DaimondIdentity && DaimondIdentity.isUnlocked()
			&& window.DaimondGateway && DaimondGateway.state && DaimondGateway.state().authed
			&& window.DaimondCore && DaimondCore.collectSync);
	}

	/// A short label for this device, shown on the other device as "last saved
	/// from …". Not trusted by the gateway; purely for display. The gateway
	/// stores it in the clear beside the sealed blob, so it must describe the
	/// BROWSER, never the user: the account's chosen name is the user's own
	/// words, and sending it here was the one readable thing sync leaked.
	function deviceLabel() {
		try {
			var n = window.DaimondCore && DaimondCore.deviceSelfName && DaimondCore.deviceSelfName();
			return (n && String(n).trim()) || 'a device';
		} catch (e) { return 'a device'; }
	}

	// ── Transport ──────────────────────────────────────────────

	/// One request, with the one refusal this engine can put right by itself.
	///
	/// The gateway's session lasts an hour and nothing renewed it, so an hour into
	/// a sitting every request here became a 401 -- and a 401 fell past the 409,
	/// 402 and 413 arms into a `console.debug` line. Seven pushes of a real user's
	/// work were refused and discarded that way in one afternoon, with the chip
	/// showing nothing and the account dot claiming to be connected.
	///
	/// So a 401 asks the gateway for a new session and sends the request again --
	/// through `DaimondGateway.gwFetch`, which is the ONE place that rule lives.
	/// This file used to hold its own copy of it, one of five identical copies
	/// across the app; a rule about not losing the user's work is not a rule that
	/// should exist in five places. Renew once, retry once, and otherwise the
	/// original 401 comes back and the chip says so, because an identity that
	/// genuinely cannot authenticate must surface rather than spin against a door
	/// that is not going to open.
	///
	/// NOT DaimondGateway.post: sync's 402/409/413 are outcomes to act on, not
	/// errors to throw, so this keeps its own shape -- {status, json} -- and reads
	/// the reply itself. The version contract is honoured on the way past, by
	/// `gwFetch`: a tab too old for the gateway is told to reload rather than go
	/// on talking to it.
	/// EVERY REQUEST HERE HAS A DEADLINE. A write's is `writeDeadline` of its body,
	/// whoever sends it; a read's is `PULL_TIMEOUT_MS` unless it names its own.
	///
	/// # Arguments
	/// * `xtra` - `{ timeoutMs, track, hold }`, and all three are for a READ alone.
	///            `timeoutMs` replaces a GET's budget (0 disables it -- the wake poll
	///            parks far longer and passes 0). `track` registers the GET's
	///            controller as `pullAbort` so a resume can break it at once; only the
	///            content pull sets it. `hold`, an object, is handed the GET's
	///            controller as `hold.ac` for as long as it is in flight; the wake park
	///            uses it to end itself when what it must listen for changes. A write
	///            reads none of them: its deadline is its size's, and nothing but that
	///            deadline can abort it -- never a resume, which is the seq-228
	///            regression (a dispatch push cancelled on resume never reached peers).
	async function call(method, body, query, xtra) {
		xtra = xtra || {};
		var opts = {
			method:      method,
			credentials: 'same-origin',
			headers:     { 'x-daimond-api': String(DaimondGateway.clientApi()) },
		};
		if (body !== undefined) {
			opts.headers['content-type'] = 'application/json';
			opts.body = JSON.stringify(body);
		}
		// Bound every request; track and hand out a READ's controller only, so a push
		// can be ended by its own deadline and by nothing else.
		var ac = null, timer = null;
		var read   = method === 'GET';
		var budget = !read ? writeDeadline(opts.body ? opts.body.length : 0)
			: ((xtra.timeoutMs !== undefined) ? xtra.timeoutMs : PULL_TIMEOUT_MS);
		if (budget > 0 || (read && (xtra.track || xtra.hold))) {
			try { ac = new AbortController(); } catch (e) { ac = null; }
			if (ac) {
				opts.signal = ac.signal;
				if (budget > 0) timer = setTimeout(function () { try { ac.abort(); } catch (e) {} }, budget);
				if (read && xtra.track) pullAbort = ac;
				// `hold` hands the controller to the caller, so the wake park can be
				// ended when what it listens for changes. See `setProgressWanted`.
				if (read && xtra.hold) xtra.hold.ac = ac;
			}
		}
		try {
			var r = await DaimondGateway.gwFetch(PATH + (query || ''), opts);
			if (r.status === 426) return { status: 426, json: null };
			if (r.status === 429 || r.status === 503) noteRetryAfter(r);
			var j = null;
			try { j = await r.json(); } catch (e) { j = null; }
			var res = { status: r.status, json: j };
			if (r.status !== 401) { clearSessionGone(r.status); return res; }
			// Still refused after a renewal that either failed or did not help. This
			// device's work is not travelling and the user has to be able to find
			// that out; see restStatus.
			if (!sessionGone) { sessionGone = true; restStatus(); }
			return res;
		} finally {
			if (timer) clearTimeout(timer);
			if (ac && xtra.track && pullAbort === ac) pullAbort = null;
			if (ac && xtra.hold && xtra.hold.ac === ac) xtra.hold.ac = null;
		}
	}

	/// How long a write of `chars` body characters may take before it is a failure.
	/// The body is JSON around base64, so characters are bytes.
	function writeDeadline(chars) {
		return Math.min(WRITE_DEADLINE_MAX_MS,
			WRITE_DEADLINE_MS + Math.ceil((chars | 0) / WRITE_FLOOR_BPS) * 1000);
	}

	/// A request that was served is proof the session is back. Only a round that
	/// actually reached the mailbox counts -- a 502 from a gateway that is
	/// restarting says nothing about whether this device is signed in.
	function clearSessionGone(status) {
		if (!sessionGone) return;
		if (status !== 200 && status !== 402 && status !== 409 && status !== 413) return;
		sessionGone = false;
		restStatus();
	}

	// ── The account's public handle ────────────────────────────
	//
	// Two halves live here because both are the wire. The parcel carries the
	// handle between the account's own devices (see collectParcel), and these
	// two functions are how the device talks to the party that OWNS the name:
	// the gateway mints it, reserves it, and is the only thing that can say
	// whether a name is free.
	//
	// Not in identity.js, which is a crypto module and makes no requests; not in
	// gateway.js, whose account call is the authentication and must never answer
	// its own 401 by authenticating again. Here, beside the other thing that
	// keeps two devices agreeing about one account.

	var ACCOUNT_PATH = '/api/account';

	/// Whether there is a session to ask about the handle through.
	///
	/// Deliberately NOT `ready()`, which also requires the sync tier: every
	/// account has a handle, including the ones that will never buy Pro, and a
	/// name that only paying accounts could see would be no use to a rating.
	function handleReady() {
		if (window.DaimondSafe && DaimondSafe.on()) return false;
		return !!(window.DaimondIdentity && DaimondIdentity.isUnlocked()
			&& window.DaimondGateway && DaimondGateway.state && DaimondGateway.state().authed);
	}

	/// One request to the account endpoint. `{status, json}`, never a throw.
	///
	/// Through `gwFetch` like everything else here, though with one difference
	/// worth knowing: `/api/account` is on gateway.js's authentication path, so
	/// a 401 comes straight back rather than triggering a renewal. That is
	/// right -- a handle is not worth re-authenticating for, and the next unlock
	/// asks again.
	async function accountCall(method, body, query) {
		var opts = {
			method:      method,
			credentials: 'same-origin',
			headers:     { 'x-daimond-api': String(DaimondGateway.clientApi()) },
		};
		if (body !== undefined) {
			opts.headers['content-type'] = 'application/json';
			opts.body = JSON.stringify(body);
		}
		try {
			var r = await DaimondGateway.gwFetch(ACCOUNT_PATH + (query || ''), opts);
			var j = null;
			try { j = await r.json(); } catch (e) { j = null; }
			return { status: r.status, json: j };
		} catch (e) {
			// The gateway is optional: an account works offline on a BYOK key,
			// and a name it cannot ask about is not a failure worth showing.
			log('account call failed', e);
			return { status: 0, json: null };
		}
	}

	/// Ask the gateway what this account is called, and adopt the answer.
	///
	/// The gateway mints a handle for an account that has none -- including one
	/// registered before handles existed -- so this both learns the name and is
	/// how an older account comes to have one.
	///
	/// The answer is adopted through `adoptHandle`, which takes the LARGER
	/// record and writes it verbatim. Hearing the same name again therefore
	/// changes nothing and schedules no push: the stamp came from the gateway
	/// both times, so the two records are equal rather than merely equivalent.
	async function refreshHandle() {
		if (!handleReady()) return null;
		var r = await accountCall('GET');
		if (r.status !== 200 || !r.json || r.json.ok === false) return null;
		// The card the gateway is serving under this name, compared with the one
		// this device holds. Fired and forgotten: a name is not worth waiting on
		// a second request for, and the next unlock asks again.
		try { publishCard(r.json.card || '').catch(function (e) { log('card publish failed', e); }); }
		catch (e) { log('card publish threw', e); }
		var rec = { h: r.json.handle || '', t: r.json.handle_ts || 0 };
		if (!rec.h) return null;
		var moved = false;
		try { moved = DaimondIdentity.adoptHandle(rec); } catch (e) { log('adoptHandle threw', e); }
		// A handle that moved is account state like any other, and the other
		// devices are entitled to hear about it. Only on a real change, so a
		// refresh that confirmed what we knew sends nothing.
		if (moved) nudge();
		return DaimondIdentity.handle();
	}

	/// Ask for a different handle. `{ok, reason, message, handle}`.
	///
	/// The refusals are the reason this returns a shape rather than a boolean.
	/// A name somebody else holds, a name that is not a name, and a name the
	/// operator keeps are three different things to tell a user, and a caller
	/// that could only see failure would have to invent which.
	///
	/// The gateway's own English is ignored in favour of the catalogue: the
	/// sentence a user reads has to be in their language, and the wire carries a
	/// token (`reason`) precisely so it can be.
	async function claimHandle(wanted) {
		if (!handleReady()) return { ok: false, reason: 'offline', message: t('handle.failed') };
		var r = await accountCall('POST', { handle: String(wanted || '') }, '?op=handle');
		var j = r.json || {};
		if (r.status === 200 && j.ok) {
			// `setHandle`, not the merge: this is the gateway answering the
			// question this device just asked, so it is the authority. A merge
			// would refuse it if this device happened to hold a stamp further
			// ahead, and the rename would be reported as having worked while the
			// old name stayed on screen.
			try { DaimondIdentity.setHandle({ h: j.handle, t: j.handle_ts }); }
			catch (e) { log('setHandle threw', e); }
			nudge();		// the other devices are owed the new name
			return { ok: true, reason: j.reason || 'claimed', handle: DaimondIdentity.handle() };
		}
		var reason = j.reason || 'failed';
		return { ok: false, reason: reason, message: handleMessage(reason) };
	}

	/// The sentence behind a refusal, in the user's language.
	function handleMessage(reason) {
		if (reason === 'taken')    return t('handle.taken');
		if (reason === 'invalid')  return t('handle.invalid');
		if (reason === 'reserved') return t('handle.reserved');
		if (reason === 'confusable') return t('handle.confusable');
		return t('handle.failed');
	}

	/// `refreshHandle`, fired and forgotten, with the rejection swallowed.
	///
	/// Nothing waits for a name, and an unhandled rejection from a background
	/// request is a console error the whole suite reads as a page fault.
	function askHandle() {
		try { refreshHandle().catch(function (e) { log('handle refresh failed', e); }); }
		catch (e) { log('handle refresh threw', e); }
	}

	/// Look up somebody else's handle. `{found, handle, fingerprint, card, why}`.
	///
	/// The half that makes a handle worth having: a name is only a name if
	/// somebody other than its owner can resolve it. `card` is the account's
	/// signed identity card, base64, and it is what People's "Find somebody"
	/// turns into a person -- a key that a message can be sealed to.
	///
	/// WHAT THIS DOES NOT DO, and it is the root of the whole trust model: a card
	/// that came back from here came through something that could have replaced
	/// it. `trust.js` records it as a LOOKUP and draws the key as new, for ever,
	/// until a human compares a safety number out of band.
	///
	/// `why` tells the three kinds of nothing apart, because they are three
	/// different sentences on screen: `none` (nobody holds that name), `busy`
	/// (the cap, or no session) and `off` (this device cannot ask at all).
	async function lookupHandle(wanted) {
		if (!handleReady()) return { found: false, why: 'off' };
		var q = '?handle=' + encodeURIComponent(String(wanted || ''));
		var r = await accountCall('GET', undefined, q);
		var j = r.json || {};
		if (r.status === 404) return { found: false, why: 'none' };
		if (r.status !== 200 || !j.ok || !j.found) return { found: false, why: 'busy' };
		return {
			found:       true,
			handle:      j.handle || '',
			fingerprint: j.fingerprint || '',
			card:        j.card || '',
		};
	}

	/// Publish this device's identity card, if the gateway is not already
	/// serving it. `served` is what the account's own record came back with.
	///
	/// WHY THE COMPARISON IS AGAINST THE SERVER'S COPY and not a marker kept
	/// here: a marker is a second record of one fact, and it is wrong on every
	/// device that has not published from this browser -- a phone carrying a
	/// paired identity would sit on an unpublished card for ever because some
	/// other device once wrote "sent". The account record is the only authority
	/// on what is being served.
	///
	/// A card is minted here when this device holds none, because an account
	/// nobody can look up is the whole defect this closes and the mint costs one
	/// signature.
	async function publishCard(served) {
		if (!handleReady()) return false;
		var mine = '';
		try {
			mine = DaimondIdentity.card() || '';
			if (!mine) {
				var made = await DaimondIdentity.mintCard();
				if (!made || !made.ok) return false;
				mine = DaimondIdentity.card() || '';
			}
		} catch (e) { return false; }
		if (!mine || mine === served) return false;
		var r = await accountCall('POST', { card: mine }, '?op=card');
		if (r.status !== 200) {
			log('card publish refused', r.status, (r.json || {}).error || '');
			return false;
		}
		return true;
	}

	// ── Status indicator ───────────────────────────────────────
	// The rail's status strip carries one row for sync: "Syncing…" while a push
	// or pull is in flight, "Synced" briefly after, "Sync off" if the tier is not
	// held, and a standing refusal for as long as one stands. When there is none
	// of that, the row says when a sync last worked (see `paintRest`), so the row
	// is never empty and never has to be waited for.
	//
	// IT WAS A PILL IN THE TOP BAR, and it moved everything beside it. The bar's
	// right-hand group shrank to its contents, so a chip appearing there took
	// 86px out of the chip row and out of the icon buttons -- measured 2026-08-28
	// at 1440px -- twice a round, at moments nobody controls. A status that
	// arrives and departs does not belong among things people press. The strip is
	// where this app already puts "the state of the machine, at a glance and
	// without asking", and every row in it is the answer to one question.
	//
	// The element keeps its id, its `data-state`, its `.sdot`/`.stext` children,
	// its hover title and its click: what changed is where it hangs and how it is
	// drawn. Its rules are with the other status rows in css/app.css rather than
	// injected here, now that there is a row in the markup for it to sit in.
	var _statusChip = null, _statusTimer = null;
	/// The row the chip lives in, and the resting line it shares the row with.
	function statusRow() {
		return document.getElementById('astat-sync');
	}
	function statusChip() {
		if (_statusChip) return _statusChip;
		var host = statusRow() || document.getElementById('admin-status')
			|| document.querySelector('.admin-status');
		if (!host) return null;
		var c = document.createElement('div');
		c.id = 'sync-chip';
		// The INLINE style carries "is it saying anything", because that is what
		// six verifiers read (`c.style.display !== 'none'`). The stylesheet's
		// `display: none` would leave it empty until the first `setStatus`, so a
		// chip built at boot and asked before it had anything to report would
		// answer that it was showing.
		c.style.display = 'none';
		// It goes syncing -> synced -> stalled -> off on its own, with nothing the
		// user pressed to cause it. `role="status"` is enough here: it changes
		// rarely and says one short thing, which is the case a polite live region
		// is actually for.
		c.setAttribute('role', 'status');
		c.innerHTML = '<span class="sdot"></span><span class="stext"></span>';
		// "Sync off" is the one state the user can do something about, and until now
		// the chip said so and stopped there -- the offer it was pointing at was
		// three clicks away in a drawer they had no reason to open. Clicking it goes
		// where the sentence leads. The other states are reports rather than offers,
		// so they stay inert: a chip that opened a drawer whatever it said would be
		// a trap sitting next to the pairing button.
		c.addEventListener('click', function () {
			if (c.dataset.state !== 'off') return;
			// A safe start is the one "off" the user can lift themselves, so the
			// press has to lift it rather than sell them a tier they may already
			// hold. It takes effect on the next start, because everything this
			// engine does at a boot has already not happened.
			if (window.DaimondSafe && DaimondSafe.on()) {
				turnSyncBackOn();
				return;
			}
			if (window.DaimondAdmin && DaimondAdmin.credits) DaimondAdmin.credits(t('sync.off_pitch'));
		});
		host.appendChild(c);
		_statusChip = c;
		return c;
	}

	/// Say when a sync last worked, in the row, while the chip has nothing to say.
	///
	/// The chip used to fade 1.8 seconds after "Synced" and leave the bar with no
	/// sync state on it at all, which is fine for a pill nobody was looking at and
	/// no use as an answer to "has my work travelled". The row cannot fade -- it
	/// would take its neighbours up the strip with it -- so what it does instead is
	/// fall back to the fact that is always true and always worth having.
	function paintRest(show) {
		var row = statusRow();
		if (!row) return;
		var dot  = document.getElementById('sync-rest-dot');
		var text = document.getElementById('sync-rest');
		if (dot) {
			dot.style.display = show ? '' : 'none';
			// Green once something has actually travelled; grey until it has. The
			// same three classes the rows above this one use.
			dot.className = 'astat-dot' + (lastSynced ? ' ok' : ' off');
		}
		if (text) {
			text.style.display = show ? '' : 'none';
			if (show) text.textContent = lastSyncedLine();
		}
	}

	/// Show the chip. `title` is the hover explanation, cleared unless given --
	/// carried here because the chip is the only place a state like "off" is
	/// reported, so its reason has to travel with it rather than into a dialog.
	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// A string from the table, or the English written here where the table has no entry
	/// for it yet -- the same device identity.js and voice.js use. The rekey chip's copy
	/// is carried this way until its keys land in i18n/en.js and zh-Hans.js, so a device
	/// behind the epoch chain reads a sentence rather than a key.
	function tOr(key, fallback) {
		var s = t(key);
		return (s !== key) ? s : fallback;
	}

	function setStatus(state, text, holdMs, title) {
		var c = statusChip();
		if (!c) return;
		if (_statusTimer) { clearTimeout(_statusTimer); _statusTimer = null; }
		// `style.display` still carries "is the chip saying anything", because that
		// is what six verifiers read and what `restStatus` means by an empty state.
		// What is new is the other half of the row taking over when it is not.
		if (!state) { c.style.display = 'none'; paintRest(true); announceChip(); return; }
		paintRest(false);
		c.dataset.state = state;
		c.querySelector('.stext').textContent = text;
		// The hover text always ends with when a sync last worked. On a stall that
		// is the most useful sentence there is -- "paused" means nothing without
		// knowing whether the last good sync was a minute or a fortnight ago -- and
		// on a good one it costs a line nobody has to read.
		c.title = [title || '', lastSyncedLine()].filter(Boolean).join('\n');
		c.style.display = 'flex';
		announceChip();
		// The hold's expiry must not blank the chip outright: a stall (owed work, a
		// standing refusal) can arrive during the hold and must still be shown once it
		// ends, rather than being painted over by a transient "Synced" fading to nothing
		// (F-S5-3). restStatus() blanks on its own when nothing stands.
		if (holdMs) _statusTimer = setTimeout(function () {
			_statusTimer = null;
			restStatus();
		}, holdMs);
	}

	/// What the chip stands at, in one word, for the rail's one-line summary.
	///
	/// 'syncing', 'synced', 'stalled' or 'off' while the chip is saying something;
	/// 'synced' when it is silent and a round has worked at some point; '' when it
	/// is silent and none ever has. It reports what is ON SCREEN rather than
	/// re-deriving it, so the line and the chip can never disagree -- which is the
	/// whole failure `restStatus` was written against, one level up.
	function chipState() {
		var c = document.getElementById('sync-chip');
		if (c && c.style.display !== 'none') return String(c.dataset.state || '');
		return lastSynced ? 'synced' : '';
	}

	/// Tell the rail when that word changes, so its summary is redrawn with the chip
	/// rather than whenever something else happens to repaint it. Once per change.
	var _announcedChip = null;
	function announceChip() {
		var now = chipState();
		if (now === _announcedChip) return;
		_announcedChip = now;
		try { window.dispatchEvent(new CustomEvent('daimond:sync-chip', { detail: { state: now } })); }
		catch (e) { /* no window to tell */ }
	}

	/// A short relative age, in the app's own language.
	function whenAgo(ms) {
		var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
		if (s < 60) return t('sync.when_just_now');
		var m = Math.round(s / 60);
		if (m < 60) return t('sync.when_mins', { n: m });
		var h = Math.round(m / 60);
		if (h < 24) return t('sync.when_hours', { n: h });
		return t('sync.when_days', { n: Math.round(h / 24) });
	}

	/// "Last synced 4m ago." -- or the honest admission that nothing ever has.
	function lastSyncedLine() {
		if (!lastSynced) return t('sync.last_never');
		return t('sync.last_synced', { when: whenAgo(lastSynced) });
	}

	/// Note a round that worked, so the chip has a moment to report.
	function noteSynced() {
		lastSynced = Date.now();
		try { localStorage.setItem(K_LAST, String(lastSynced)); } catch (e) { /* private mode */ }
	}

	/// Put the too-large refusal on the chip, and leave it there. No hold time: it
	/// is true until the parcel changes, and a chip that faded would be the same
	/// silence this exists to end.
	function showTooLarge() {
		setStatus('stalled', t('sync.too_big'), 0, t('sync.too_big_reason'));
	}

	/// Note that a reconcile did not finish, and say so on the chip.
	///
	/// Both causes end the same way -- this device's work is still here and the
	/// mailbox does not have it -- and both used to end in one console.debug
	/// line, with the chip left showing the "Synced" that the reconciling PULL
	/// had just put there. A device whose work never left looked exactly like a
	/// device that had just saved, which is the one thing this chip exists to
	/// prevent.
	///
	/// Only the chip. Owing the work is `push()`'s, from the moment it has news to send,
	/// so every exit that did not land is retried whether or not it came through here.
	function jam(why) {
		jammed = why;
		restStatus();
	}

	/// Arm the one retry of owed work, on a ladder whose ceiling is set by what failed.
	///
	/// IT USED TO WAIT FOR "THE NEXT CHANGE", and on a device that has just finished a
	/// hand-off there is none: the runner's answer sat in its store while the phone that
	/// sent the turn waited for a parcel that was never retried (2026-09-24,
	/// `verify_handoff_slowparcel` CASE 1). A retry that pulls first cannot spin two
	/// busy devices against each other: it sends nothing until it has read the mailbox.
	///
	/// ONE LADDER, TWO CEILINGS (S2, 2026-09-24). A conflict clears once the other device
	/// stops moving the mailbox, so it keeps the shorter `UNSENT_RETRY_MAX_MS` -- a minute
	/// since P1a M2 (D110): at 8 s, a device that kept losing to a busy one spent a
	/// whole-parcel round every few seconds for as long as the other kept landing, and a
	/// landed pull on any trigger still sends conflict-owed work at once. Nothing
	/// else does: a link too slow to finish the pull fails the same way every time, and at
	/// an 8 s ceiling the retry downloaded the whole parcel for up to `PULL_TIMEOUT_MS`,
	/// waited 4-12 s and began again from byte 0, for as long as the tab was open -- 450
	/// attempts an hour. So every other failure, the wire's and any exit nobody classified,
	/// climbs on to `UNSENT_WIRE_MAX_MS`, about twenty rounds in the first hour. The tries
	/// are shared, so a device that has been failing for a while is not sent back to the
	/// bottom by a change of kind, and only `paid()` and a link coming back (`onOnline`)
	/// reset them. A pull that lands is not a reset: a pull that lands followed by an
	/// upload that fails is the other half of the same slow link.
	///
	/// A GATEWAY THAT SAID WHEN TO COME BACK IS OBEYED. A 429 or 503 carrying Retry-After
	/// (`noteRetryAfter`) is a floor under the wait, jittered above it so a fleet told the
	/// same number does not return in the same second, and it moves a retry already armed
	/// sooner than it.
	///
	/// With no kind, the ladder keeps the one it was last armed for. 'merge' is a version the
	/// re-pull gave up on: the long ceiling, from the first wait.
	function armUnsent(kind) {
		if (kind) failKind = kind;
		if (!unsent) return;
		var now   = Date.now();
		var floor = Math.max(0, holdUntil - now);
		var wait  = 0;
		if (unsentTimer) {
			// One is coming. Only a Retry-After that reaches past it moves it.
			if (!floor || unsentDue >= now + floor) return;
			clearTimeout(unsentTimer);
			unsentTimer = null;
		} else {
			var cap  = (failKind === 'conflict') ? UNSENT_RETRY_MAX_MS : UNSENT_WIRE_MAX_MS;
			// A version the re-pull gave up on has had its quick tries (`scheduleReapply`),
			// so it goes straight to the ceiling rather than back to the bottom (S3).
			var grow = (failKind === 'merge') ? cap
				: Math.min(cap, UNSENT_RETRY_MIN_MS * Math.pow(2, unsentTries));
			unsentTries++;
			// Jittered, as the conflict backoff is, so devices that failed together do not
			// retry together.
			wait = Math.round(grow * (0.5 + Math.random()));
		}
		if (floor > 0) wait = Math.max(wait, Math.round(floor * (1 + 0.5 * Math.random())));
		diag('push retry armed', 'try=' + unsentTries + ' ' + (failKind || 'unclassified')
			+ (floor > 0 ? ' retry-after=' + floor + 'ms' : '') + ' in ' + wait + 'ms');
		unsentDue   = now + wait;
		unsentTimer = setTimeout(function () { unsentTimer = null; retryUnsent(); }, wait);
	}

	/// Note a gateway's Retry-After on a 429 or 503, in seconds or as an HTTP date. Kept as
	/// a time rather than a wait, so whichever retry is armed next reads what is left of it.
	/// The latest answer stands, longer or shorter: it is the gateway's newest word.
	function noteRetryAfter(r) {
		var h = '';
		try { h = String((r.headers && r.headers.get && r.headers.get('retry-after')) || '').trim(); }
		catch (e) { h = ''; }
		if (!h) return;
		var ms = /^\d+$/.test(h) ? Number(h) * 1000 : Date.parse(h) - Date.now();
		if (!isFinite(ms) || ms <= 0) return;
		holdUntil = Date.now() + Math.min(ms, RETRY_AFTER_MAX_MS);
	}

	/// A push landed, or found the mailbox already holding this device's state.
	function paid() {
		if (unsent && unsentTries) diag('push retry settled', 'after ' + unsentTries + ' tries');
		unsent      = false;
		unsentTries = 0;
		failKind    = '';
		if (unsentTimer) { clearTimeout(unsentTimer); unsentTimer = null; }
	}

	/// Does the browser know there is no link at all?
	///
	/// Only `false` is believed. `navigator.onLine === true` means an interface is up, not
	/// that the gateway can be reached, so it proves nothing and the retry still runs.
	function offline() {
		return !!(window.navigator && window.navigator.onLine === false);
	}

	/// The link is back. A retry that stood down while there was no link (`retryUnsent`)
	/// re-arms at its own due time; one already armed is left alone. A link that flaps
	/// while the upload keeps failing must not restart the ladder at its 1 s bottom on
	/// every flap -- only `paid()` resets it.
	function onOnline() {
		if (!unsent || unsentTimer) return;
		var wait = Math.max(UNSENT_RETRY_MIN_MS, unsentDue - Date.now());
		unsentDue = Date.now() + wait;
		unsentTimer = setTimeout(function () { unsentTimer = null; retryUnsent(); }, wait);
	}

	/// Why a push must wait rather than send, or ''. 'busy' over this device's own live
	/// turn; else the id of another device's live hand-off this device is no part of. A
	/// third device's push during a hand-off wins the compare-and-set and sends the
	/// RUNNER's push of the answer into a 409 -> pull -> merge -> retry, which cost the
	/// owner 20 s of a 58.9 s hand-off and then five more 409s on the phone. Deferred, not
	/// refused: the caller re-arms, and the bound is the lease's own liveness, so a runner
	/// that dies holds nobody off past its deadline.
	function pushWaits() {
		if (window.DaimondCore && DaimondCore.busy && DaimondCore.busy()) return 'busy';	// never over a live turn.
		try {
			if (window.DaimondPeer && DaimondPeer.deferPushFor && window.DaimondLease) {
				return DaimondPeer.deferPushFor(DaimondLease.snapshot(), selfDeviceId(),
					Date.now(), ownDispatch) || '';
			}
		} catch (e) { /* no stand-off can be read, so none is kept */ }
		return '';
	}

	/// One retry of unsent work: read the mailbox, and only once that lands, push. A pull
	/// that still fails costs a GET and no parcel collect, and re-arms, longer.
	async function retryUnsent() {
		if (!unsent) return;
		// A standing refusal outranks the retry, and its own triggers take over: an unlock,
		// a re-check of the licence, a link, a smaller parcel.
		if (!ready() || !entitled || rekeyBehind || tooLarge || sessionGone) return;
		// NO LINK, NO REQUEST. A device the browser knows is offline would spend each round
		// on a request that cannot leave it, so the retry stands down and `onOnline` starts
		// it again when the link returns. A landed pull on any other trigger still sends it.
		if (offline()) { diag('push retry', 'offline; waiting for the link'); return; }
		if (inFlight) { armUnsent(); return; }
		// A PUSH THAT WOULD WAIT IS NOT RETRIED BY PULLING (QA 2026-09-24). Over a live turn
		// here, or another device's hand-off, `push()` defers and re-arms itself on its own
		// cheap timer, and the turn's end (`daimond:idle`) sends it. A pull here would only
		// fetch the whole parcel every few seconds for the length of the turn.
		if (pushWaits()) { schedule(); return; }
		var v = -1;
		inFlight = true;
		try { v = await pull(true); }
		catch (e) { v = -1; }
		finally { endRound(); }
		// A merge that could not finish is the re-pull's (`scheduleReapply`), which is
		// bounded; a clean re-pull that lands sends the owed parcel (`pullOnce`), and one
		// that gives up hands the version back to this retry, at its ceiling.
		if (v >= 0 && lastFailed.length) { restStatus(); return; }
		// The mailbox could not be read: the wire's ladder, not the conflict's (S2).
		if (v < 0) { restStatus(); armUnsent('wire'); return; }
		// A throw here (F-S5-4) must not escape as an unhandled rejection: a collect that
		// keeps throwing would otherwise leave every retry rejecting silently, and on
		// this harness kills the process outright. The work stays owed; `push()`'s own
		// `finally` has already armed the next retry.
		//
		// The work is owed, so push() spends one rebased attempt, not eight (P1a M2): this
		// retry has just read the mailbox, and the ladder, not a burst, is what waits
		// for another device to stop landing.
		try { await push(); } catch (e) { log('owed push threw', e); }
		// Deferred rather than refused (over a live turn, or a push already in flight):
		// still owed, so the backoff goes on. A push that went and did not land has
		// already re-armed, in its own `finally`.
		armUnsent();
	}

	/// Nothing is standing in the way any more: the round that just worked
	/// clears whatever the last one could not do.
	function unjam() {
		jammed     = '';
		lastFailed = [];
	}

	/// Why a reconcile stopped, for the chip's hover.
	function jamReason() {
		return jammed === 'merge' ? t('sync.merge_reason') : t('sync.busy_reason');
	}

	/// Is work owed with no push running to send it? The chip's test and `state()`'s, so
	/// the two cannot disagree; an account not entitled shows "Sync off" instead.
	///
	/// NOT "NO ROUND RUNNING". It read `!inFlight`, and a pull round holds the gate as
	/// well: a pull that ended inside an owed wait -- the catch-up asks every few seconds
	/// while the link is down -- painted its own ending while the work read as not owed,
	/// and the round then freed the gate without painting again, so the chip rested on
	/// "Last synced" with the work stranded (SIM-8, 2026-09-25).
	function owedNow() { return unsent && !pushing && entitled; }

	/// A round is over: free the gate, and put the chip back to what is true where the
	/// round left it saying what no longer is -- "Syncing…" with nothing running, or a
	/// resting line over owed work. Every round ends here.
	function endRound() {
		inFlight = false;
		var c = document.getElementById('sync-chip');
		var busyShown = !!(c && c.style.display !== 'none' && c.dataset.state === 'syncing');
		if (owedNow() || busyShown) restStatus();
	}

	/// Put the chip back to what is TRUE when nothing is in flight.
	///
	/// The three standing refusals outlive the round that discovered them, so
	/// every path that stops showing "Syncing…" has to come through here rather
	/// than hiding the chip: a pull failing on the network used to blank a "Sync off"
	/// that was still perfectly true, and a pull SUCCEEDING used to show "Synced"
	/// on a device whose pushes were paused by a 402 -- which is the one lie this
	/// chip exists to prevent.
	///
	/// They are ordered rather than allowed to overwrite each other. Not entitled
	/// beats too large: an account that may not sync at all cannot act on a parcel
	/// being oversized, and telling it to go and shrink a Diamond would send it to
	/// do work that changes nothing.
	function restStatus() {
		// ABOVE EVERYTHING. A safe start is the app deliberately not syncing, and
		// it must never be silent: a device that quietly stopped saving to the
		// account would be a worse bug than the one it was armed against. It is
		// also the only state here the user can lift with one press, which is why
		// it outranks refusals they can do nothing about.
		if (window.DaimondSafe && DaimondSafe.on()) {
			setStatus('off', t('safe.chip'), 0, t('safe.chip_reason') + '\n' + t('safe.chip_click'));
			return;
		}
		if (!entitled)     { setStatus('off', t('sync.off'), 0, offReason()); return; }
		if (tooLarge)      { showTooLarge(); return; }
		// Below both of those. An account that may not sync at all, and a parcel
		// that will not fit, are true whatever the session is doing; a session
		// that has gone is the narrower fact and would be noise over either.
		if (sessionGone)   { setStatus('stalled', t('sync.signed_out'), 0, t('sync.signed_out_reason')); return; }
		// A device behind the epoch chain cannot read the account and must not push over
		// it, so this is a standing refusal like the two above and outranks a jam. The
		// copy is carried in English until the two i18n keys land (see tOr).
		if (rekeyBehind)   {
			setStatus('stalled',
				tOr('sync.rekey_needed', 'Passphrase changed'),
				0,
				// Not "too far behind": the stranding also happens one epoch apart (N vs
				// N+1) when the link cannot be walked, or at the SAME epoch when two
				// devices diverged and this one holds no previous key to cross with. The
				// honest fact is that it cannot catch up on its own; the remedy is the
				// same either way.
				tOr('sync.rekey_needed_reason',
					'The passphrase was changed on another device, and this one cannot catch up on '
					+ 'its own. Link it again to this account.'));
			return;
		}
		// And above nothing at all: a jam is this round's failure rather than a
		// state of this device, so all three standing refusals outrank it.
		if (jammed)        { setStatus('stalled', t('sync.paused'), 0, jamReason()); return; }
		// Below a jam, which names why. Not while a push is running: a push in flight is
		// owed until it lands, and that is "Syncing", not a stall.
		if (owedNow())     { setStatus('stalled', t('sync.unsent'), 0, t('sync.unsent_reason')); return; }
		setStatus('');
	}

	/// Why sync is off, and what to do about it -- the chip is clickable in this
	/// state, and a hover that did not say so would leave that undiscovered.
	function offReason() {
		return t('sync.off_reason') + '\n' + t('sync.off_click');
	}

	// ── The parcel ─────────────────────────────────────────────
	// Everything daimond.js owns comes from `collectSync`/`applySync`. The pause
	// tree does not: pause.js holds it, and hanging it here keeps the collector
	// free of a module it has no other business with. Both functions are the ONLY
	// way a parcel is packed or unpacked in this file, so what a verifier drives
	// and what a push sends cannot drift apart.

	/// What push() sends: the core parcel with the pause tree on the end.
	///
	/// `snapshot()` sorts and stamps only on a real change, so two collects with
	/// nothing between them are byte-identical -- which is the whole contract the
	/// no-op guard in push() rests on. Attached last, so its position in the
	/// serialisation never moves either.
	/// What this module compares when it asks "has anything changed since the last
	/// push" -- the parcel with EVERY roster line's `seen` stamp masked out. What
	/// is SENT is always the parcel itself; only the comparison reads this.
	///
	/// NOT THE PARCEL ITSELF, AND THAT IS THE FIX. `touchSelfDevice` (daimond.js)
	/// moves this device's roster `seen` every SEEN_REFRESH_MS -- five minutes --
	/// whether or not anything else moved. On a device nobody is typing at, that is
	/// the only thing that ever moves, so the skip in `push` never took: two idle
	/// desktops each put their whole ~8 MB parcel on the wire every 300 s with no
	/// turn behind it, every push woke the others, and each of those pulled and
	/// re-collected. Measured on the owner's fleet, 2026-09-12.
	///
	/// MASKED, NOT FROZEN. The stamp is still written locally, so this device's own
	/// list is right and the roster bound still works, and it still rides out on the
	/// next push that has a reason of its own. What it can no longer do is BE the
	/// reason.
	///
	/// EVERY LINE, NOT ONLY OURS, AND THAT IS THE SECOND HALF OF THE SAME FIX.
	/// Masking our own line alone left the echo: a pull that merges a peer's newer
	/// roster line (`mergeDevices` takes its `seen`) makes the next idle collect
	/// differ from the last thing we sent, so this device pushes a parcel that is
	/// byte-different and size-identical -- and the peer, pulling that, does the
	/// same back. Measured on the owner's fleet 2026-09-13: version 8355 and
	/// version 8358 both weighed 1,524,815 bytes on the wire with not one chat,
	/// Diamond or file different between them, and each real change cost two or
	/// three of those before the pair settled.
	///
	/// A PEER'S STAMP IS NOT NEWS TO ANYBODY. It is the words "last seen" on a row
	/// in the devices panel, and the device it describes is the one that pushed it
	/// -- so the account already has it, at the version it arrived in. Everything
	/// else on the line still counts: `build` (an update the fleet must hear
	/// about), `label` and `namedAt` (the owner naming a device), `created`, and
	/// the line's arrival or departure. What can no longer BE the reason for a
	/// push is a clock nobody set.
	///
	/// AND IT IS NOT HOW A DEVICE IS KNOWN TO BE ALIVE. Liveness is the presence
	/// door below -- `beatPresence` / `refreshPresence`, read back through
	/// `DaimondPresence` -- which left the parcel for exactly this reason (see
	/// "PRESENCE IS NOT IN THE PARCEL" in collectParcel). `rosterLiveness`, the
	/// dispatch election and the hand-off seat all read that beat and never this
	/// stamp; the roster `seen` is the "last seen" words on a row, and a row for a
	/// beating device reads its stamp from the beat. So nothing that DECIDES
	/// anything is slowed by this, and a live device is still live within
	/// DISPATCH_FRESH_MS.
	///
	/// The key is built preserving every field and key order, so two collects of an
	/// otherwise unchanged account still give byte-identical keys -- which is the
	/// whole point of having one. A parcel with no roster in it is its own key:
	/// there is nothing to mask and nothing to throw.
	function compareKey(state) {
		var plain = JSON.stringify(state);
		if (!state || !state.devices || typeof state.devices !== 'object') return plain;
		var src = state.devices, devs = {};
		Object.keys(src).forEach(function (k) {
			var line = src[k];
			if (!line || typeof line !== 'object') { devs[k] = line; return; }
			var copy = {};
			Object.keys(line).forEach(function (f) { copy[f] = (f === 'seen' ? 0 : line[f]); });
			devs[k] = copy;
		});
		var out = {};
		Object.keys(state).forEach(function (k) { out[k] = (k === 'devices' ? devs : state[k]); });
		return JSON.stringify(out);
	}

	// ── What the parcel will weigh on the wire ─────────────────
	//
	// Every budget in daimond.js is counted in `String.length` -- UTF-16 code units
	// -- and the wire carries UTF-8 base64 of ciphertext. So a parcel that is
	// comfortably inside SYNC_PARCEL_MAX can still be over the front door, and the
	// only evidence anybody had of that was a 413 (or a reset) after the bytes had
	// been encrypted and sent. One account's phone measured 6,065,784 UTF-16 units
	// and ~8.09 MB of body: 300 KB under the door, with four sections spending
	// against budgets that sum to more than the door allows. These three functions
	// are so that the number is known BEFORE the push, said in one line, and
	// refused here rather than at the far end.

	/// The UTF-8 byte length of a string, WITHOUT encoding it.
	///
	/// `new TextEncoder().encode(s).length` is the obvious answer and the wrong one
	/// at this size: it allocates a second copy of an 8 MB parcel beside the string
	/// and the sealed blob, on the device least able to afford it (see the release
	/// dance in pullOnce for how seriously this file takes that). A scan costs one
	/// pass and no memory.
	///
	/// A surrogate PAIR is one code point of four bytes; a lone surrogate is
	/// replaced by U+FFFD on encoding, which is three -- so it is counted as three,
	/// the same as the encoder would write.
	function utf8Len(s) {
		var n = 0, len = s.length;
		for (var i = 0; i < len; i++) {
			var c = s.charCodeAt(i);
			if (c < 0x80) { n += 1; continue; }
			if (c < 0x800) { n += 2; continue; }
			if (c >= 0xD800 && c <= 0xDBFF && i + 1 < len) {
				var d = s.charCodeAt(i + 1);
				if (d >= 0xDC00 && d <= 0xDFFF) { n += 4; i++; continue; }
			}
			n += 3;
		}
		return n;
	}

	/// The HTTP body a push would write for a parcel of `pbytes` UTF-8 bytes.
	///
	/// base64(IV(12) || AES-GCM(parcel) || tag(16)) inside the same JSON envelope
	/// `push` sends, measured with an empty blob and the real blob length added --
	/// so the device label and the wake id are counted as they will actually travel
	/// rather than guessed at. base64 is ASCII and btoa pads, so 4 per 3 is exact.
	///
	/// It takes the COUNT rather than the string because the caller needs that
	/// count as well (see parcelSizes) and the scan is the expensive half.
	function wireBytes(pbytes) {
		var sealed = pbytes + 12 + 16;
		// At epoch >= 1 the push wraps the sealed parcel in the rekey envelope (the
		// DRK1 header and the record JSON) INSIDE this same base64, so the record's
		// kilobytes actually travel on the wire. Count them, or a parcel that fits with
		// an empty envelope 413s at the gateway the moment the record is added -- the
		// blind stop WS-BRICK removed (D6). The envelope base64s the whole concatenated
		// buffer at once, so the overhead is added to the RAW bytes before the 4/3, to
		// match `wrapEnvelope` exactly. Zero at epoch 0: byte-identical to before.
		var b64 = 4 * Math.ceil((sealed + envelopeOverheadBytes()) / 3);
		var env = utf8Len(JSON.stringify(
			{ base_version: serverVersion, device: deviceLabel(), blob: '', w: WAKE_ID }));
		return env + b64;
	}

	/// The RAW bytes the rekey envelope adds around the sealed parcel at epoch >= 1:
	/// the 8-byte DRK1 header and the record JSON. Zero at epoch 0 (no envelope emitted),
	/// so a never-rekeyed account measures byte-identically to before the chain existed.
	/// See wireBytes (D6) and wrapEnvelope.
	function envelopeOverheadBytes() {
		try {
			if (!window.DaimondIdentity || !DaimondIdentity.epoch || !DaimondIdentity.rekeyRecord) return 0;
			if ((DaimondIdentity.epoch() | 0) <= 0) return 0;
			var rec = DaimondIdentity.rekeyRecord();
			if (!rec) return 0;
			return 8 + utf8Len(JSON.stringify(rec));
		} catch (e) { return 0; }
	}

	/// Where the parcel's bytes actually are, section by section, in UTF-8 bytes.
	///
	/// Compact keys, because this rides in a 360-byte feed event: `f` files,
	/// `c` chats, `ci` the transcripts still INLINE inside them, `k` the chunk
	/// index, `d` diamonds, `l` ledger, `md` models, `ml` mail, `o` everything
	/// else. A section weighing nothing is left out rather than reported as zero.
	///
	/// ONE SECTION AT A TIME, and never the whole parcel again. `plain` is already
	/// live when this runs; stringifying the sections into one object would put a
	/// second whole copy beside it. Each section's text is released before the next
	/// is taken, so the extra live bytes are the LARGEST section and not the sum.
	///
	/// `o` is arrived at by subtraction from the parcel that is already in hand, so
	/// it cannot drift from the total the way a tenth measurement would: whatever
	/// this function has not learned to name turns up there by construction. That
	/// matters, because the sections it does not name -- the ledger aside -- are
	/// exactly the ones no budget bounds.
	var SECTION_KEYS = { files: 'f', chats: 'c', chunked: 'k', diamonds: 'd',
		ledger: 'l', models: 'md', mail: 'ml' };
	function parcelSizes(state, total) {
		var out = {}, named = 0;
		if (!state || typeof state !== 'object') return out;
		Object.keys(SECTION_KEYS).forEach(function (k) {
			var n = 0;
			try { n = (state[k] === undefined || state[k] === null) ? 0 : utf8Len(JSON.stringify(state[k])); }
			catch (e) { n = 0; }
			named += n;
			if (n) out[SECTION_KEYS[k]] = n;
		});
		// The transcripts riding INLINE, which is the half of `chats` a budget is
		// meant to bound -- a chat that offloaded leaves a `messagesRef` of a few
		// hundred bytes here and its weight is in the chunk store, not the parcel.
		var ci = 0;
		try {
			var list = state.chats || [];
			for (var i = 0; i < list.length; i++) {
				if (list[i] && list[i].messages) ci += utf8Len(JSON.stringify(list[i].messages));
			}
		} catch (e) { ci = 0; }
		if (ci) out.ci = ci;
		var other = (total | 0) - named;
		if (other > 0) out.o = other;
		return out;
	}

	/// The section sizes as one line, largest first, for the console.
	function sizesLine(sizes) {
		return Object.keys(sizes).sort(function (a, b) { return sizes[b] - sizes[a]; })
			.map(function (k) { return k + '=' + Math.round(sizes[k] / 1024) + 'K'; }).join(' ');
	}

	/// Over this many distinct addresses, the parcel's ref list is left off the push:
	/// it rides in the clear beside the blob, and a store large enough to have this
	/// many chunks would add megabytes to every push for a belt the client already
	/// carries (`DaimondCore.parcelRefs`) and the gateway's version guard already
	/// backs. Well under the gateway's own `MAX_COMMIT_ENTRIES`.
	var PARCEL_REFS_MAX = 50000;

	/// Every distinct chunk address the parcel `state` references -- the index union
	/// every `messagesRef`/`dataRef`/`msgRef` it carries -- for the gateway's
	/// "do not sweep what a live parcel names" belt. `null` when the list is too long
	/// to send or the belt is unavailable, in which case the push carries no `refs`.
	function parcelRefAddrs(state) {
		if (!window.DaimondCore || !DaimondCore.parcelRefs) return null;
		var m;
		try { m = DaimondCore.parcelRefs(state); } catch (e) { return null; }
		if (!m || typeof m !== 'object') return null;
		var seen = {}, out = [];
		var keys = Object.keys(m);
		for (var i = 0; i < keys.length; i++) {
			var ent = m[keys[i]];
			if (!ent || !Array.isArray(ent.chunks)) continue;
			for (var j = 0; j < ent.chunks.length; j++) {
				var c = ent.chunks[j];
				if (c && c.addr && !seen[c.addr]) {
					seen[c.addr] = 1;
					out.push(c.addr);
					if (out.length > PARCEL_REFS_MAX) return null;	// too many: gateway skips, belt holds
				}
			}
		}
		return out;
	}

	async function collectParcel() {
		var state = await DaimondCore.collectSync();
		try { if (window.DaimondPause) state.pause = DaimondPause.snapshot(); }
		catch (e) { log('pause snapshot failed', e); }
		// THE LEASE IS NOT IN THE PARCEL any more. Which device runs a turn is a fact
		// about the account, but riding it in the parcel made a lease CLAIM a
		// whole-parcel compare-and-set that stormed under multi-device churn (see the
		// lease door in this file). It now travels on its own lightweight CAS door
		// (leaseGet / leaseCommit) and is adopted through adoptLeaseDoor -- on every
		// ordinary pull (where `j.lease` is read) -- off the parcel entirely, exactly
		// as presence was moved below.
		// PRESENCE IS NOT IN THE PARCEL. Which devices are awake used to ride here as
		// a freshest-scalar section, but its moving lastSeen made the parcel a moving
		// target -- never a fixed point -- and re-uploaded the whole ~163K parcel
		// every beat, waking every other device for a fact that wakes nobody. It now
		// travels on the gateway's own lightweight, non-waking presence path
		// (DaimondSync.beatPresence / refreshPresence) and is adopted through
		// DaimondPresence.ingest, off the parcel entirely.
		// Where the Diamonds sit in the graph, under the same rule: sorted keys,
		// three fields each, stamped per Diamond rather than once over the map --
		// two devices that each moved a different Diamond must keep both moves,
		// where a whole-map stamp would let the later one silently replace the
		// other's whole arrangement. The pan is deliberately NOT carried: it is a
		// scroll offset into a picture whose size depends on this window.
		try { if (window.DaimondGraph) state.graph = DaimondGraph.snapshot(); }
		catch (e) { log('graph snapshot failed', e); }
		// WHAT IS IN THE TRASH, which is a fact about the ACCOUNT and not about
		// the browser it was deleted in. Deleting already propagates through
		// tombstones, so a trash that stayed local would be strictly worse than
		// no trash at all: a restore on this device would be silently undone by
		// the other one, which had buried the same chat and never heard
		// otherwise. Attached here, beside the pause tree and the graph, because
		// trash.js holds the state and answers for it.
		//
		// Its snapshot is a SORTED map of two stamps per id and moves only when a
		// stamp does, which is the whole of what keeps two collects
		// byte-identical -- the same contract the pause tree keeps above.
		try { if (window.DaimondTrash) state.trash = DaimondTrash.snapshot(); }
		catch (e) { log('trash snapshot failed', e); }
		// THE ACCOUNT'S PUBLIC HANDLE -- the name other people see, as opposed to
		// `displayName()`, which labels this device's keypair and travels
		// nowhere. It is a fact about the account, so a second device that shows
		// a different one is showing a name its owner does not have.
		//
		// The gateway is the authority: it mints the handle, it owns the
		// namespace, and every stamp on the record is its clock. This carries a
		// copy so a device that is offline, or newly adopted by pairing, still
		// knows the account's name -- and identity.js writes what arrives
		// verbatim, so nothing on this path can stamp. See `handleSnapshot`.
		try { if (window.DaimondIdentity) state.handle = DaimondIdentity.handleSnapshot(); }
		catch (e) { log('handle snapshot failed', e); }
		// AND HOW THE ACCOUNT LOOKS, for the device that has not been dressed.
		// A pairing bundle carries this to a device linked by a code; nothing
		// carried it to one brought across by a passkey, or to one that simply
		// holds the identity and was unlocked with the passphrase. The mailbox is
		// the only channel all three end at. pairing.js holds the state and
		// answers for it, as pause.js and trash.js do above.
		//
		// `pulledOk` is the same rule the chunk index is committed under: a device
		// may not publish a look it has not been told about until it has heard
		// from the mailbox once, or a new device's factory defaults would go over
		// the account's real look with a fresh stamp.
		try {
			if (window.DaimondPairing && DaimondPairing.look) {
				var look = DaimondPairing.look.record(pulledOk, knownDevice);
				if (look) state.look = look;
			}
		} catch (e) { log('look snapshot failed', e); }
		// Private messages, and WHY THE NULL MATTERS: `snapshot()` answers null while
		// the identity is locked, and a section left off is a section the other device
		// keeps. An empty record here would read to the merge as a deletion.
		try {
			if (window.DaimondPost) {
				// `snapshotRefs` offloads the message tail to content chunks under a
				// byte budget (the chats' treatment); a build without it carries the
				// whole record inline as before. Either way the section is left OFF
				// when null -- an empty record reads to the merge as a deletion.
				var pst = DaimondPost.snapshotRefs
					? await DaimondPost.snapshotRefs() : DaimondPost.snapshot();
				if (pst) state.post = pst;
			}
		} catch (e) { log('post snapshot failed', e); }
		// RE-READ THE CHUNK INDEX after the post offload, for the same reason
		// collectSync re-reads it after the Diamond and chat collectors: the `@m/`
		// manifests `snapshotRefs` just wrote must be in the set the ONE commit in
		// push() declares live, or the file-only commit would sweep the very chunks
		// this parcel now references. A no-op offload wrote nothing, so on a quiet
		// round this is byte-identical to what collectSync already put here.
		try { if (window.DaimondCloud) state.chunked = DaimondCloud.index(); }
		catch (e) { log('chunk index re-read failed', e); }
		// THE FORGE VOICE, wrapped under the account's shared identity so it is
		// decryptable on every paired device but was never carried to one. It is
		// a fact about the account like the handle above, not about this browser.
		// The wrapped record travels verbatim -- voice.js never unwraps it -- and
		// `null` (no voice held) is omitted, so a device with no voice does not
		// read to the merge as one deleting it.
		try {
			if (window.DaimondVoice && DaimondVoice.snapshot) {
				var vce = DaimondVoice.snapshot();
				if (vce) state.voice = vce;
			}
		} catch (e) { log('voice snapshot failed', e); }
		return state;
	}

	/// Merge a parcel into this device. Returns the sections that would not apply.
	///
	/// Pause goes FIRST, because a merge that cannot finish must not also lose the
	/// news about what may spend: a Diamond section that fails costs a name, a
	/// pause that fails costs money. And nothing here may stamp on the way in --
	/// `adopt()` moves the stamp only for a record that is later or larger, so
	/// applying a parcel this device already agrees with leaves the next parcel
	/// unchanged. A section that restamped itself on apply is exactly the
	/// `touchSelfDevice` bug that had a freshly paired phone always holding news,
	/// and two devices pushing at each other about once a second.
	async function applyParcel(state) {
		var failed = [];
		if (window.DaimondPause) {
			try { DaimondPause.adopt(state && state.pause); }
			catch (e) { log('pause adopt failed', e); failed.push('pause'); }
		}
		// The lease is NOT adopted here any more: it left the parcel (see
		// collectParcel) and is adopted from its own gateway door through
		// adoptLeaseDoor -- on every ordinary pull, where `j.lease` is read -- by the
		// same take-if-vacant merge (DaimondLease.adopt), off the parcel entirely.
		// Presence is NOT adopted here any more: it left the parcel (see
		// collectParcel) and is ingested from the gateway's own presence path
		// through DaimondPresence.ingest -- on every ordinary pull (see pullOnce,
		// where `j.presence` is read) and on each beat.
		// Always through `adopt`, never by writing `daimond-graph`: graph.js caches
		// the record in memory and re-reads it only on a cross-tab `storage` event
		// or an account switch, so a same-tab write is invisible to it and the next
		// save overwrites it.
		if (window.DaimondGraph) {
			try { DaimondGraph.adopt(state && state.graph); }
			catch (e) { log('graph adopt failed', e); failed.push('graph'); }
		}
		// BEFORE the chats and the Diamonds, and that ordering is the whole of it.
		// `applySync` below rebuilds both lists from their stores, and what those
		// lists may contain is decided by this record: adopting it afterwards
		// would put a chat the other device deleted back on the rail until
		// something else happened to redraw it.
		//
		// The merge itself takes the LATER of each stamp independently, so a
		// deletion cannot resurrect and a restore cannot be buried whichever
		// order the parcels arrive in -- see js/trash.js.
		if (window.DaimondTrash) {
			try { DaimondTrash.adopt(state && state.trash); }
			catch (e) { log('trash adopt failed', e); failed.push('trash'); }
		}
		// The forge voice, under the same rule as everything above it: the record
		// with the newer `at` wins, so a re-issued voice propagates and an older
		// one never buries a newer local one. voice.js writes it verbatim, `s`
		// still wrapped, at the key it reads from.
		if (window.DaimondVoice && DaimondVoice.adopt) {
			try { DaimondVoice.adopt(state && state.voice); }
			catch (e) { log('voice adopt failed', e); failed.push('voice'); }
		}
		if (window.DaimondPost) {
			// `adoptRefs` hydrates any offloaded rows (fetching only a message this
			// device does not already hold) BEFORE the synchronous flags-merge; a
			// build without it merges the whole inline record as before.
			try {
				if (DaimondPost.adoptRefs) await DaimondPost.adoptRefs(state && state.post);
				else DaimondPost.adopt(state && state.post);
			}
			catch (e) { log('post adopt failed', e); failed.push('post'); }
			// A parcel is the one occasion the unread count can have changed that
			// is neither a press nor an arrival on this device: messages read on
			// another device arrive here already read.
			try { if (window.DaimondBadge && DaimondBadge.post) DaimondBadge.post(); }
			catch (e) { /* no badge in this build */ }
		}
		// The account's public handle, under the same rule as everything above
		// it: `adoptHandle` takes the larger record and writes it VERBATIM, so a
		// parcel this device already agrees with moves nothing and the next
		// parcel is the one that arrived, byte for byte.
		if (window.DaimondIdentity && DaimondIdentity.adoptHandle) {
			try { DaimondIdentity.adoptHandle(state && state.handle); }
			catch (e) { log('handle adopt failed', e); failed.push('handle'); }
		}
		// How the account looks, under the same rule again -- the later record,
		// stored verbatim -- with one thing on top of it: a device that has never
		// had a look of its own PUTS THIS ON. Awaited, because dressing sets the
		// language, and the language is fetched before it is written.
		if (window.DaimondPairing && DaimondPairing.look) {
			try { await DaimondPairing.look.adopt(state && state.look, knownDevice); }
			catch (e) { log('look adopt failed', e); failed.push('look'); }
		}
		var report = null;
		try { report = await DaimondCore.applySync(state); }
		catch (e) { log('applySync threw', e); report = { failed: ['all'] }; }
		var core = (report && Array.isArray(report.failed)) ? report.failed : [];
		return failed.concat(core);
	}

	// ── Pull ───────────────────────────────────────────────────

	/// Fetch the current blob, decrypt it, and merge it into local state.
	/// Returns the server version now known, or -1 on a failure that should not
	/// advance anything. A decrypt failure is swallowed: better to keep local
	/// state than to clobber it with something we cannot read.
	///
	/// `quiet` is for the pull INSIDE a reconcile: the round is not over, so it
	/// must not paint "Synced" over a push that has not landed yet.
	///
	/// Whether the merge finished is recorded in `lastFailed`, because a merge
	/// that did not is a reason not to push over the parcel it came from.
	/// Announce that a pull has RUN -- landed, found nothing, or failed on the
	/// wire. Once per boot, and the distinction that matters is "this device has
	/// asked the other ones", not "the answer was good news".
	///
	/// The retention sweep waits on this. A device coming back after a month
	/// holds trash records that may have been restored elsewhere meanwhile, and
	/// destroying on them before hearing is how a restore is defeated by a
	/// tombstone -- so the sweep is held until the mailbox has been read. A
	/// failed pull releases it too: a device that cannot reach the gateway must
	/// still eventually destroy what its own records say is due, or an account
	/// whose gateway is down would keep everything for ever.
	var announcedPull = false;
	function notePulled() {
		if (announcedPull) return;
		announcedPull = true;
		try { window.dispatchEvent(new Event('daimond:pulled')); } catch (e) { /* no window */ }
	}

	async function pull(quiet) {
		if (!ready()) return -1;
		// The merge reads and writes the cloud index; wait for it to have loaded out
		// of IndexedDB (and migrated off the box) before the first one.
		if (window.DaimondCloud && DaimondCloud.ready) { try { await DaimondCloud.ready(); } catch (e) { /* fallback path stays active */ } }
		try { return await pullOnce(quiet); }
		finally { notePulled(); }
	}

	/// The pull other modules call: through the one-round gate, as every round here is.
	///
	/// `DaimondSync.pull` WAS THE RAW `pull`. Every internal caller takes `inFlight`
	/// first; the hand-off waits and the return recovery (daimond.js) did not, so a
	/// pull of theirs ran beside a push reconciling a 409, and two merges of one parcel
	/// interleaved their read-modify-writes -- the Diamond import, which rewrites a
	/// Diamond's directory with no transaction, among them (P1a M4, 2026-09-25). This
	/// waits for the gate, which no round can now hold past its deadline, and answers
	/// -1, as a pull that could not reach the mailbox does, if it has not freed within
	/// `PULL_TIMEOUT_MS`.
	async function gatedPull(quiet) {
		var until = Date.now() + PULL_TIMEOUT_MS;
		while (inFlight) {
			if (Date.now() >= until) return -1;
			await new Promise(function (r) { setTimeout(r, GATE_WAIT_MS); });
		}
		inFlight = true;
		try { return await pull(quiet); }
		finally { endRound(); }
	}

	async function pullOnce(quiet) {
		lastFailed = [];		// what follows is the only merge this answers for.
		setStatus('syncing', t('sync.syncing'));
		// What the cursor held before this read left. A push that moves it past this
		// while the read is in flight makes the version this read returns with stale,
		// and it must not overwrite the push's. See `adoptVersion`.
		var preRead = serverVersion;
		var res;
		var tGet = Date.now();		// the /api/sync GET round-trip, for the sync-latency picture
		// Tracked and budgeted: a GET iOS froze on a backgrounded socket aborts at the
		// budget (freeing the gate) or the instant a resume breaks it. Only a pull is
		// tracked; the push below ends at its own deadline and never on a resume.
		try { res = await call('GET', undefined, undefined, { track: true }); }
		catch (e) { diag('pull GET error', (Date.now() - tGet) + 'ms'); log('pull network error', e); restStatus(); return -1; }
		if (res.status !== 200 || !res.json) { diag('pull GET status', res.status + ' after ' + (Date.now() - tGet) + 'ms'); log('pull status', res.status); restStatus(); return -1; }
		lastPullAt = Date.now();		// asked, and answered: see the catch-up in push().
		var j = res.json;
		// The round-trip and the sealed parcel size -- bytes only, no content. A slow
		// GET or a large parcel is the first thing the "sync is slow" question asks.
		diag('pull GET', (Date.now() - tGet) + 'ms present=' + (j.present ? 'Y' : 'N')
			+ ' ' + Math.round(((j.blob || '').length) / 1024) + 'K');
		// PRESENCE RIDES ALONGSIDE THE PARCEL, in the clear. The gateway stamps a
		// last_seen per awake device in its own clock and includes `now` so this
		// client can convert to its own frame; `ingest` REPLACES the local view
		// (the gateway is the source of truth). Adopted here for free on every pull,
		// whether or not there is a parcel to open below, and off the sealed blob
		// entirely -- presence never touches the parcel now. See beatPresence.
		try {
			if (window.DaimondPresence && j && j.presence) DaimondPresence.ingest(j.presence, j.now);
		} catch (e) { log('presence ingest failed', e); }
		// The lease, folded into the same pull off its own door (like presence), so a
		// device that only watches a hand-off it dispatched still advances its footer.
		try { if (j && j.lease) await adoptLeaseDoor(j.lease); }
		catch (e) { log('lease door adopt failed', e); }
		// An empty mailbox is an answer: this device has heard, and there was
		// nothing to hear. See `pulledOk`.
		if (!j.present) { diag('pull', 'v' + (j.version | 0) + ' empty mailbox'); adoptVersion(0, preRead); reapplyDone(); pulledOk = true; restStatus(); return serverVersion; }
		var state;
		// ── Read the parcel, EPOCH-AWARE ──────────────────────────
		//
		// The blob may carry a rekey record (see openEnvelope). Which of three things it
		// is turns on how the record's epoch compares to this device's, and getting that
		// comparison right is the whole of the anti-fork fix: the corruption recovery
		// below must fire ONLY on genuine same-epoch corruption, never across an epoch
		// change, or the two devices clobber each other for ever.
		//
		// The size of what arrived, before it is opened. Bytes only, no content: a slow
		// or large pull is the first thing the "sync is slow" question asks.
		trail('sync pull', Math.round((j.blob || '').length / 1024) + 'K sealed');
		var env = openEnvelope(j.blob);
		// Release the raw blob the moment the envelope has been split off it, so the blob
		// and the object graph never coexist -- the iOS memory ceiling this whole path is
		// written against. `env.sealed` holds its own reference to what still has to open.
		j.blob = null;
		// GATE THE RECORD BEFORE IT STEERS THE PULL (Gap 1, the DoS). Every branch below
		// turns on `env.rec.epoch` and `env.rec.salt` -- but nothing has authenticated the
		// record yet. A forged, UNSIGNED `{v:1, epoch:le+1, pub:<account pub>}` would drive
		// this device to `rekeyBehind = true` and a standing push lockout (adoptRekey would
		// refuse it 'unsigned', which the re>le branch reads as "behind"), and a same-epoch
		// salt-diverged forgery would drive a needless yield -- a forged mailbox write
		// standing every device down. So a record that does not VERIFY against this account
		// (its pub is the account's own trusted pub AND its body is signed by it) is treated
		// as ABSENT: `re` becomes 0, the pull degrades to the corruption-recovery path a
		// legacy blob already takes, and `rekeyBehind` can never be set by a forgery.
		// `rekeyBehind` is thereby reserved for a VERIFIED record this device genuinely
		// cannot walk. A never-rekeyed account (le=0) meeting a forgery behaves EXACTLY as
		// it does today -- re===le===0, no record, straight to recovery.
		if (env.rec && !(window.DaimondIdentity && DaimondIdentity.verifyRecord
			&& await DaimondIdentity.verifyRecord(env.rec))) {
			log('pull: rekey record did not verify against this account; treating it as absent');
			env.rec = null;
		}
		var re  = env.rec ? (env.rec.epoch | 0) : 0;		// the parcel's epoch
		var le  = (window.DaimondIdentity && DaimondIdentity.epoch) ? (DaimondIdentity.epoch() | 0) : 0;
		if (re > le) {
			// A passphrase was changed on another device. Adopt the epoch -- walk the
			// chain, swap the key, reseal every store -- and only then open the parcel
			// under the NEW key. A device that CANNOT walk the chain (a gap, or one too
			// far behind) must not adopt the version and must not push: it would replace
			// the account with a blob nobody else can open. That is the sticky 'rekey'
			// chip, and the one place this pull returns -1 rather than the version.
			var adopted = await withAdoptLock(function () { return adoptEpoch(env.rec); });
			// A concurrent pull may already have walked us to this epoch (or past it)
			// while this one waited on the lock -- `adoptRekey` then answers 'stale'.
			// That is not "behind": we hold the key, so treat it as adopted and fall
			// through to open under it, rather than false-setting rekeyBehind (D7).
			var nowEp = (window.DaimondIdentity && DaimondIdentity.epoch) ? (DaimondIdentity.epoch() | 0) : 0;
			if (!adopted.ok && !(adopted.reason === 'stale' && nowEp >= re)) {
				rekeyBehind = true;
				log('pull: behind the account epoch (' + adopted.reason
					+ '); not adopting, not pushing — this device must be linked again');
				if (!quiet) restStatus();
				return -1;
			}
			rekeyBehind = false;
			try {
				var plainA = await DaimondIdentity.unwrap(env.sealed);
				state = JSON.parse(plainA);
				plainA = null;
			} catch (e) {
				// The new key was adopted and proven against the record's own private
				// key, so a parcel that still will not open under it is genuine
				// corruption of THIS blob, not an epoch mismatch. Today's recovery.
				log('pull: adopted the new epoch but the parcel would not open; keeping local state');
				adoptVersion(j.version | 0, preRead);
				reapplyDone();
				if (!quiet) restStatus();
				return serverVersion;
			}
			trail('sync parsed');
		} else if (re === le) {
			var okB = null;
			try {
				var plainB = await DaimondIdentity.unwrap(env.sealed);	// throws on a wrong key.
				trail('sync parcel', Math.round(plainB.length / 1024) + 'K plain');
				okB = JSON.parse(plainB);
				plainB = null;
			} catch (e) { okB = null; }
			if (okB) {
				state = okB;
				trail('sync parsed');
			} else {
				// It did not open under our key. Two very different things look alike
				// here and MUST NOT be handled alike:
				//   * the record carries a DIFFERENT salt from ours -> two devices both
				//     rekeyed to THIS epoch on their own before either pulled. That is
				//     DIVERGENCE, never corruption. Firing recovery would clobber the
				//     other branch, and it would clobber back -- the ping-pong fork this
				//     fix removes (D2).
				//   * same salt (or no record at all) -> a genuinely corrupt or
				//     half-written blob at our own epoch, which recovery is for.
				var localSalt = (window.DaimondIdentity && DaimondIdentity.saltB64)
					? DaimondIdentity.saltB64() : null;
				if (env.rec && env.rec.salt && localSalt && env.rec.salt !== localSalt) {
					// DETERMINISTIC YIELD. The branch with the lexicographically SMALLER
					// salt wins, so the LARGER-salt side adopts the other branch by
					// walking the one link both chains share (from the previous epoch,
					// under the key it kept from its own change). Symmetric and stable:
					// each device compares the same two salts and exactly one yields.
					if (localSalt > env.rec.salt) {
						var yld = await withAdoptLock(function () { return adoptDivergedEpoch(env.rec); });
						if (yld.ok) {
							rekeyBehind = false;
							try {
								var plainY = await DaimondIdentity.unwrap(env.sealed);
								state = JSON.parse(plainY);
								plainY = null;
								trail('sync parsed');
							} catch (e2) {
								// Crossed to the other branch but its parcel still will not
								// open under the now-proven key: genuine corruption of that
								// blob. Keep local state and let our own go over it.
								log('pull: yielded to the diverged branch but the parcel would not open; keeping local state');
								adoptVersion(j.version | 0, preRead);
								reapplyDone();
								if (!quiet) restStatus();
								return serverVersion;
							}
						} else {
							// Cannot cross (no previous key held this session): stand behind
							// the chain rather than clobber the winning branch. A re-link
							// brings this device onto it and clears the state.
							rekeyBehind = true;
							log('pull: diverged at the same epoch and cannot yield (' + yld.reason
								+ '); not pushing — this device must be linked again');
							if (!quiet) restStatus();
							return -1;
						}
					} else {
						// OUR salt is the smaller: our branch wins. Keep local state and let
						// the retry carry our record over the other branch; the other side
						// yields to us on its next pull. Not corruption -- but the mechanics
						// (adopt the version, push our own) are the same and are right here.
						log('pull: diverged at the same epoch; holding our branch (smaller salt wins)');
						adoptVersion(j.version | 0, preRead);
						reapplyDone();
						if (!quiet) restStatus();
						return serverVersion;
					}
				} else {
					// Same salt (or no record): a corrupt or half-written blob at our own
					// epoch. Adopt the version and let our good state go over the top of
					// it -- how an account recovers from a bad blob at all. `lastFailed`
					// is for sections that ARRIVED and could not be merged; this is not one.
					log('pull decrypt/parse failed; keeping local state');
					adoptVersion(j.version | 0, preRead);
					reapplyDone();
					if (!quiet) restStatus();
					return serverVersion;
				}
			}
		} else {
			// re < le: a device BEHIND us pushed, at an older epoch. If it is exactly one
			// epoch back, or a pre-change blob with no record at all, and this session
			// still holds the previous key (set when this device changed or adopted the
			// passphrase), open it with that and merge -- the lost-edit race, closed. The
			// retry then pushes our own state, at the current epoch and with our record,
			// so nothing is lost and the lagging device adopts from it on its next pull.
			var got = null;
			// A pre-change / old-build blob: try the current key first, then the previous.
			if (!env.rec) {
				try { got = JSON.parse(await DaimondIdentity.unwrap(env.sealed)); }
				catch (e) { got = null; }
			}
			if (!got && (re === le - 1 || !env.rec)
				&& window.DaimondIdentity && DaimondIdentity.hasPrevKey && DaimondIdentity.hasPrevKey()) {
				try { got = JSON.parse(await DaimondIdentity.unwrapPrev(env.sealed)); }
				catch (e) { got = null; }
			}
			if (!got) {
				// Older than the previous key we hold, or none held (a fresh page): carry
				// our record over it. Finite -- the lagging device adopts on its next pull.
				log('pull sealed under an older epoch; carrying our record over it');
				adoptVersion(j.version | 0, preRead);
				reapplyDone();
				if (!quiet) restStatus();
				return serverVersion;
			}
			state = got;
			trail('sync parsed');
		}
		// A parcel opened, so this device is not behind the chain -- clears the sticky
		// 'rekey' state a re-link (importBundle brings the epoch forward) or an adopt
		// resolves, whichever it was.
		rekeyBehind = false;
		// The parcel PULLED, at its version and with the ids it carried, into the
		// opt-in ring. `applyChats` records what the merge then DID with each; this
		// records what arrived, so the two read together as "carried X, kept Y".
		try {
			diag('pull', 'v' + (j.version | 0)
				+ ' chats=' + ((state.chats || []).map(function (c) { return c && c.id; })
					.filter(Boolean).join(',') || 'none')
				+ ' tombs=' + Object.keys(state.tombs || {}).join(',')
				+ ' msgTombs=' + Object.keys(state.msgTombs || {}).length);
		} catch (e) {}
		// A VERSION THIS DEVICE HAS ALREADY FULLY MERGED IS NOT MERGED AGAIN.
		// `applyParcel` is idempotent -- every section is freshest-wins, union or
		// tombstone, all stamp-ordered -- so re-running it changes nothing; but the
		// files section pays for a folder walk to find that out, and on a
		// folder-mounted desktop that walk is the whole cost of the round. `pulledOk`
		// keeps this from firing on the very first pull of a session (nothing is
		// "already adopted" yet) and `reapplyTries` keeps it from firing while a
		// PRIOR merge of this same version is still being retried -- that pass has
		// not finished and must still run.
		//
		// AND ONLY WHILE THE RECORD OF THAT MERGE IS STILL THERE. `serverVersion` is a
		// variable; `daimond-sync-version` is the durable note of it, written by
		// `adoptVersion` and by every landed push. A device whose note has gone has lost
		// the state the note was about -- site data cleared under a live tab, or a
		// fixture standing in for an install that has never seen this mailbox -- and the
		// one thing that would repair it is the merge this skip declines. So the claim
		// is only made where it can still be shown. A read that THROWS is not evidence
		// of loss (a browser with no storage at all never had a note to lose), so only a
		// read that succeeds and disagrees defeats the skip.
		var noted = serverVersion;
		try {
			var rawV = localStorage.getItem(K_VERSION);
			noted = rawV === null ? -1 : (parseInt(rawV, 10) || 0);
		} catch (e) { /* cannot tell; leave the claim standing */ }
		if (j.version === serverVersion && noted === serverVersion && pulledOk && reapplyTries === 0) {
			// ONE TRAIL LINE STANDS IN FOR THE SECTION THIS PULL DID NOT RUN. Skipping
			// `applyParcel` outright means `applySync`'s own `section('files', …)` never
			// fires, and a trail that goes silent here is exactly the failure mode its own
			// comment warns against -- a merge nobody can tell was ever looked at. This
			// names the version and says why, in the same 'sync files' slot the walk would
			// have logged into, but without the walk.
			trail('sync files', 'v' + (j.version | 0) + ' already adopted, no walk');
			lastFailed = [];
		} else {
			lastFailed = await applyParcel(state);
		}
		pulledOk   = true;			// a parcel was read; see `pulledOk`.
		noteSynced();
		// A merge that could not finish is not a sync that worked, and it is the
		// user's business: their other device's work is sitting in the mailbox
		// unread on this one.
		//
		// AND THE VERSION IS NOT ADOPTED. Adopting it here -- BEFORE this check, as
		// it used to be -- was the strand: a section that threw (the chats section
		// on a cold tab whose store had not been read, most often) left this device
		// recorded as caught up to a parcel it had never merged. Nothing then
		// re-applied it: a wake pull fires only for a HIGHER version, the mailbox
		// was not moving, and the focus and idle pulls are throttled -- so a chat
		// the other device deleted lived on for ever while the chip read "Synced".
		// Leaving the cursor where it was keeps the news outstanding, and
		// `scheduleReapply` re-pulls this same version until the merge finishes.
		// The whole parcel is re-applied on each retry, which is safe: every
		// section's merge is idempotent (freshest-wins / union / tombstone, all
		// stamp-ordered), so re-applying a section that already took changes
		// nothing. See the re-apply notes above.
		if (lastFailed.length) {
			diag('pull merge FAILED', 'sections=' + lastFailed.join(',') + ' v=' + (j.version | 0)
				+ ' -> re-pull scheduled (not adopting)');
			log('pulled version', j.version | 0, 'but could not merge', lastFailed.join(','),
				'- not adopting; scheduling a re-pull of the same version');
			if ((j.version | 0) > failedVersion) failedVersion = j.version | 0;
			scheduleReapply();
			if (!quiet) jam('merge');
			return serverVersion;		// the last FULLY-applied version, deliberately not j.version.
		}
		adoptVersion(j.version | 0, preRead);
		reapplyDone();				// a clean apply settles any re-pull that was armed.
		unjam();
		// THE PULL LANDED, and work a refused push left unsent can go now, on the next
		// push rather than at the end of its backoff. Not from inside a push (`quiet`),
		// whose own retry is about to send. But a pull only proves GETs work, and says
		// nothing about the write path an armed ladder is already climbing (F-S5-1), so
		// it must not send wire-owed work straight past that retry. The one exception is
		// a pull whose version moved since the failure: another device's push got
		// through, so the write path is back and the ladder's wait is over.
		//
		// CONFLICT-OWED WORK IS THE LADDER'S TOO, WITH NO EXCEPTION (P1a M2, D110). A
		// pull that lands after a conflict is, nearly always, the other device landing
		// again -- the wake channel pulls on every one -- so sending at once raced it on
		// every landing: 2,896 whole-parcel POSTs in half an hour against a device landing
		// every 5 s, the ladder never consulted. Its version always moves, so the
		// exception above cannot apply to it. Only a version that would not merge, and
		// now has, is sent at once.
		var ladderOwns = !!unsentTimer && failKind !== 'merge';
		if (unsent && !quiet && ladderOwns && failKind !== 'conflict' && serverVersion > unsentFailVersion) {
			clearTimeout(unsentTimer); unsentTimer = null; ladderOwns = false;
		}
		if (unsent && !quiet && !ladderOwns) schedule();
		// TRAINING WHEELS — remove with the DEBUG_SHARE module. The debug feed's
		// `sync`, pull half: direction, the version this device moved to, and the
		// round trip. Counts and versions only -- never a section's contents, which
		// are the chats. A no-op unless the share switch is on. Lifts out in one
		// grep of `DEBUG_SHARE`.
		try {
			if (window.DEBUG_SHARE && DEBUG_SHARE.event) {
				DEBUG_SHARE.event('sync', { dir: 'pull', to: serverVersion | 0,
					ms: Date.now() - tGet, from: String(j.device || '').slice(0, 12) });
			}
		} catch (e) { /* the feed must never break a sync */ }
		// A pull working says nothing about whether this device's own parcel will
		// EVER leave -- a GET is served to everyone, a push is not -- so a standing
		// refusal stays on the chip rather than being painted over with "Synced".
		if (quiet) { /* the push that called this is still running */ }
		// F-S5-3: work owed at this point (a failed push whose retry has not yet
		// re-sent) must not be painted over as "Synced", which then fades to a clear
		// chip and a green "Last synced just now" while the state is still `unsent`.
		else if (!entitled || tooLarge || owedNow()) restStatus();
		else setStatus('synced', t('sync.synced'), 1800);
		log('pulled version', serverVersion, 'from', j.device || '?');
		return serverVersion;
	}

	// ── Push ───────────────────────────────────────────────────

	/// Encrypt and push local state under compare-and-set, reconciling a
	/// conflict by pulling, merging and retrying. A no-op when nothing has
	/// changed since the last push, so an idle app is quiet on the wire.
	///
	/// WORK THAT ALREADY FAILED TO LAND GETS ONE REBASED ATTEMPT A ROUND (P1a M2,
	/// D110): `UNSENT_RETRY_TRIES` rather than `MAX_CONFLICT_RETRIES`, whatever
	/// started the round, and the ladder (`armUnsent`) paces the rounds. Eight
	/// whole-parcel POST+GET pairs per round against a device that keeps landing was
	/// 1,552 POSTs and 1,745 GETs in half an hour. Fresh work keeps the eight, which
	/// is what gets a hand-off's answer past a brief race.
	///
	/// # Arguments
	/// * `opts.tries` - conflict tries this round may spend, in place of the rule above.
	async function push(opts) {
		var tries = (opts && opts.tries > 0) ? opts.tries
			: (unsent ? UNSENT_RETRY_TRIES : MAX_CONFLICT_RETRIES);
		if (!ready() || !entitled) return;
		// BEHIND THE EPOCH CHAIN: never overwrite the account. A device that could not
		// walk the chain to the account's current key (rekeyBehind, set in pullOnce)
		// holds a parcel sealed under a key the account has moved past; pushing it would
		// replace the account with a blob the other devices cannot open. It must be
		// linked again first, which brings its epoch forward and clears this on the next
		// pull. See the `re > le` branch in pullOnce.
		if (rekeyBehind) { restStatus(); return; }
		if (inFlight) { schedule(); return; }
		var standOff = pushWaits();
		if (standOff) {
			if (standOff !== 'busy') diag('push deferred', 'turn=' + standOff.slice(0, 12) + ' is running on another device');
			schedule();
			return;
		}
		inFlight = true;
		pushing  = true;
		// OWED FROM HERE (F-S5-4). A throw anywhere below -- collectParcel, sigOf, the
		// encryption -- must not leave the work looking paid: a push that could not even
		// tell what it would send is owed, not clear. `known` (below) already calls
		// paid() when there is nothing new, so this mark is undone at once when it is
		// wrong. The flag only: a timer armed now would fire during a slow upload, find
		// `inFlight` and climb the ladder for nothing.
		unsent   = true;
		failKind = '';
		try {
			// The collectors record manifests in the cloud index; wait for it to have
			// loaded out of IndexedDB before collecting, so `index()` is authoritative.
			if (window.DaimondCloud && DaimondCloud.ready) { try { await DaimondCloud.ready(); } catch (e) { /* fallback path stays active */ } }
			for (var attempt = 0; attempt < tries; attempt++) {
				var state = await collectParcel();
				var plain = JSON.stringify(state);
				// What is SENT is `plain`; what is COMPARED is the key. See compareKey.
				var cmp   = compareKey(state);
				// `lastPushed === null` is "this page has not sent anything yet",
				// which is the only moment the carried digest is asked about. Note
				// the short-circuit: on every push after the first, `sigOf` is
				// never called at all.
				var known = (cmp === lastPushed)
					|| (lastPushed === null && !!bootSig && (await sigOf(cmp)) === bootSig);
				if (known && serverVersion > 0) {
					// Nothing new to send -- but the round is not wasted, and this
					// is the trigger that has to catch up.
					//
					// A window that is open and FOCUSED raises no focus event and
					// ends no turn, so on a device nobody is typing at, this push
					// is the only thing that still runs. It used to return here
					// without asking the gateway anything at all, so two devices
					// on two desks never learned about each other: the one being
					// worked on pushed, and the one being read never looked. That
					// is a device that is not editing NEVER converging, which is
					// how it was reported.
					//
					// Throttled against the last pull of ANY kind, because a
					// device that is quiet is quiet for a long time and this
					// must not become a poll -- nor a second GET on the heels
					// of the one a focus just made.
					paid();			// the mailbox already holds what this device has
					if (Date.now() - lastPullAt >= IDLE_PULL_MIN_MS) await pull();
					// TELL flush() the live parcel is already what the mailbox holds, so it
					// need not pay a second whole-parcel collect to find that out (the ~40 MB
					// collect the S1 fix bounds -- flush ran three per round). Only this
					// branch reports it; every other exit returns undefined and flush confirms
					// against a fresh collect, exactly as before.
					return { committed: true };
				}

				// A GATEWAY'S Retry-After IS A FLOOR ON EVERY PUSH, NOT ONLY THE
				// LADDER'S OWN TIMER (F-S5-5). `holdUntil` is otherwise read only in
				// `armUnsent`, so a landed pull or a local change could still fire a push
				// straight through a 429 or 503's asked-for wait. The work stays owed;
				// `finally` re-arms it at the floor.
				if (Date.now() < holdUntil) { log('push held by Retry-After'); return; }

				// WHAT THIS WILL WEIGH, BEFORE A BYTE OF IT IS ENCRYPTED. Counted
				// here rather than inferred from a 413: the refusal comes back after
				// the whole body has been written, Steel may close mid-write so the
				// browser reports a reset instead, and neither says WHICH section
				// grew. See wireBytes and parcelSizes.
				var pbytes = utf8Len(plain);			// scanned once; both of the next two want it
				var wire   = wireBytes(pbytes);
				var sizes  = parcelSizes(state, pbytes);
				log('parcel', Math.round(wire / 1024) + 'K on the wire of'
					+ ' ' + Math.round(WIRE_DOOR_BYTES / 1024) + 'K allowed —', sizesLine(sizes));
				diag('push size', Math.round(wire / 1024) + 'K ' + sizesLine(sizes));

				// OVER THE FRONT DOOR: refuse it HERE. Sending it cannot work, and
				// the two ways it fails -- a 413, or a reset from a door that answered
				// and closed mid-body -- are a wasted encryption of the whole parcel
				// and, in the reset case, an error that names nothing. Nothing is
				// dropped or shed to get under the door: the parcel stands as it is,
				// the chip carries the same too-large refusal a 413 raises, and the
				// section sizes say where the bytes went.
				if (wire > WIRE_DOOR_BYTES) {
					tooLarge   = true;
					lastPushed = cmp;			// don't spin on the same oversize state
					restStatus();
					log('parcel over the front door (' + Math.round(wire / 1024) + 'K >'
						+ ' ' + Math.round(WIRE_DOOR_BYTES / 1024) + 'K) — refused here, not sent');
					// TRAINING WHEELS — the debug feed's `sync`, commit half, in the
					// same shape the chunk-commit refusals use, so one filter finds
					// every round that did not land. Lifts out in one grep of
					// DEBUG_SHARE.
					try {
						if (window.DEBUG_SHARE && DEBUG_SHARE.event) {
							var ev = { dir: 'push', commit: 'refused', why: 'too-large',
								wire: wire, door: WIRE_DOOR_BYTES, at: serverVersion | 0 };
							Object.keys(sizes).forEach(function (k) { ev[k] = sizes[k]; });
							DEBUG_SHARE.event('sync', ev);
						}
					} catch (e) { /* the feed must never break a sync */ }
					return;
				}

				var blob;
				try { blob = await DaimondIdentity.wrap(plain); }
				catch (e) { log('encrypt failed', e); return; }
				// Carry the rekey record for a device on an older epoch to adopt, when
				// this device is at epoch >= 1. A no-op at epoch 0 -- the blob stays
				// byte-identical to today, so a never-rekeyed account needs no gateway
				// change and is untouched. The record is public (ciphertexts only), so it
				// rides in the clear inside the base64. See wrapEnvelope.
				blob = wrapEnvelope(blob);

				setStatus('syncing', t('sync.syncing'));
				var res;
				// EVERY ADDRESS THIS PARCEL REFERENCES, so the gateway can protect them
				// from a sweep by ANY device -- an old client, or a peer whose own index
				// omits them -- not only from this device's own commit (the www belt).
				// The gateway keeps the latest parcel's refs and treats them as live; a
				// commit against a stale version is refused by the version guard, so the
				// latest is the only set that matters. A store too large to list them all
				// sends none, and the client-side `parcelRefs` belt still holds. Optional
				// on the wire: a gateway without the belt ignores the field.
				//
				// AND ONLY WHILE THEY FIT UNDER THE DOOR. `refs` rides in the clear beside
				// the blob and is NOT in the wire weigh above, so a near-door parcel plus a
				// long ref list would exceed Steel's front door and turn a push that would
				// have landed into a reset. So they are attached only when the blob leaves
				// room for them; dropped, the www belt still holds. ~68 bytes per hex
				// address with its quotes and comma.
				var refs = parcelRefAddrs(state);
				var body = { base_version: serverVersion, device: deviceLabel(), blob: blob, w: WAKE_ID };
				if (refs && refs.length && wire + refs.length * 68 <= WIRE_DOOR_BYTES) body.refs = refs;
				// `w` names this tab's wake channel, so the gateway taps the
				// account's OTHER devices and not this one: a device that pulled
				// in answer to its own push would double every round.
				//
				// A throw is the wire, and so is the deadline (`writeDeadline`): owed,
				// and retried on the wire's ladder. A POST the gateway stored but whose
				// answer never came back costs one redundant version: the retry pulls
				// that version, finds its own parcel in it, and sends again.
				try { res = await call('POST', body); }
				catch (e) { log('push network error', e); failKind = 'wire'; restStatus(); return; }

				if (res.status === 200 && res.json && res.json.ok) {
					serverVersion = res.json.version | 0;
					lastPushed = cmp;
					saveVersion();
					// Beside the version, and only here: this is the one place a
					// parcel is known to have reached the mailbox. A parcel the
					// gateway refused is not one this device has sent, so the 413
					// arm below deliberately does not write it -- storing that
					// digest would have the next page skip a push that never
					// happened.
					saveSig(await sigOf(cmp));
					// The pushed state is now the shared fork point for the file merge.
					try { if (DaimondCore.syncCommitBaseline) await DaimondCore.syncCommitBaseline(); }
					catch (e) { /* baseline advances next time */ }
					// Declare the live chunk set that this state references and let
					// the gateway sweep everything it no longer does. The version
					// is named because the gateway refuses to sweep on behalf of a
					// device working from a stale view of the world — an index
					// built without knowing about someone else's file would
					// otherwise delete it.
					//
					// And ONLY from a device that merged the index it is about to
					// declare. `applyChunked` refuses the merge whenever the
					// workspace is not syncable -- a real folder is open, the tools
					// are not up -- and this device then held nothing but its own
					// view. Committing that view named none of the other device's
					// files and the gateway swept every one of them. The same
					// condition gates both, so what cannot be merged cannot be
					// declared.
					// Wait for the collectors' index writes to reach IndexedDB before asking
					// whether the index is durable: the write is now async, so the gate must
					// be consulted after it lands, not during it.
					if (window.DaimondCloud && DaimondCloud.settle) { try { await DaimondCloud.settle(); } catch (e) { /* the gate reads dirty regardless */ } }
					var mayCommit = !!(DaimondCore.syncMayCommitChunks && DaimondCore.syncMayCommitChunks());
					// TRAINING WHEELS — the debug feed's `sync`, COMMIT half. A device
					// whose chunk index has not merged refuses every commit and says so
					// only to a console nobody is reading; that state is what stood
					// behind a lost turn, so each of the four outcomes is now an event.
					// Lifts out in one grep of `DEBUG_SHARE`.
					var dsCommit = function (outcome, why) {
						try {
							if (window.DEBUG_SHARE && DEBUG_SHARE.event) {
								var ev = { dir: 'push', commit: outcome, at: serverVersion | 0 };
								if (why) ev.why = why;
								DEBUG_SHARE.event('sync', ev);
							}
						} catch (e) { /* the feed must never break a sync */ }
					};
					if (!mayCommit) {
						// NAME THE CONDITION. Which of the three it is decides what the
						// user can do about it, and the line said only that something was.
						var why = (DaimondCore.syncCommitBlockedReason && DaimondCore.syncCommitBlockedReason()) || 'unknown';
						log('chunk index not merged on this device — not committing a live set (' + why + ')');
						dsCommit('refused', why);
					}
					else {
						try {
							if (window.DaimondChunks && state.chunked) {
								var tiers = window.DaimondCloud ? DaimondCloud.tierPlan(DaimondCloud.allowance()) : null;
								// THE LIVE SET IS THE PARCEL'S, not the index's alone. The
								// index can name fewer addresses than the parcel points at --
								// a manifest write lost to quota -- and committing the index
								// would then sweep the very chunks this parcel references.
								// `parcelRefs` is the index UNION every `messagesRef`/
								// `dataRef`/`msgRef` the parcel carries, so the declared set
								// can never omit one; on a durable round it equals the index.
								var live = (DaimondCore.parcelRefs)
									? DaimondCore.parcelRefs(state) : state.chunked;
								// A refusal is a swept-or-not answer nobody heard: the
								// gateway can decline this commit, and a client that
								// throws the result away cannot tell a sweep that
								// happened from one that did not.
								var swept = await DaimondChunks.commit(live, serverVersion, tiers);
								if (!swept) log('chunk commit refused at version', serverVersion);
								dsCommit(swept ? 'swept' : 'refused-by-gateway');
							}
						}
						catch (e) { log('chunk commit failed', e); dsCommit('failed'); }
					}
					tooLarge = false;					// whatever would not fit, fits now
					unjam();							// and whatever would not reconcile, has
					paid();								// and nothing is owed
					noteSynced();
					setStatus('synced', t('sync.synced'), 2200);
					// TRAINING WHEELS — the debug feed's `sync`, push half. The parcel's
					// SIZE in bytes and the version it landed at; never its contents.
					try {
						if (window.DEBUG_SHARE && DEBUG_SHARE.event) {
							// `bytes` is the parcel in UTF-16 units, which is what every
							// budget in daimond.js counts; `wire` is the body that actually
							// travelled. The two differ by half again on a parcel of
							// Japanese transcripts, and reading one as the other is how a
							// parcel inside its budget reached the door anyway.
							var pev = { dir: 'push', to: serverVersion | 0,
								bytes: (plain && plain.length) | 0, wire: wire, tries: attempt + 1 };
							Object.keys(sizes).forEach(function (k) { pev[k] = sizes[k]; });
							DEBUG_SHARE.event('sync', pev);
						}
					} catch (e) { /* the feed must never break a sync */ }
					log('pushed version', serverVersion);
					return;
				}
				if (res.status === 409) {
					// Another device moved the blob on. Pull it, merge, retry
					// against the version we just learned. `quiet`: the round is
					// still running, so the pull must not report "Synced" over a
					// push that has not landed.
					log('conflict at base', serverVersion, '— pulling and retrying');
					var v = await pull(true);
					if (v < 0) { failKind = 'conflict'; jam('busy'); return; }		// could not reconcile; say so.
					// A merge that did not finish must NOT be pushed over. The
					// retry sends what this device holds, and what this device
					// holds is precisely the state that failed to take the other
					// device's work: pushing it replaces their version in the
					// mailbox with one that never saw it.
					if (lastFailed.length) {
						log('merge incomplete (', lastFailed.join(','), ') — not pushing over it');
						// Owed like every other exit (S6). The bounded re-pull owns the
						// version that would not merge, and its clean landing sends this.
						failKind = 'conflict';
						jam('merge');
						return;
					}
					lastPushed = null;			// local state changed under us; force a fresh send.
					// Space the retries with a jittered backoff so three busy devices do
					// not collide on every attempt and exhaust in a burst ("work has not
					// been sent"). Same shape as the lease-take fix: only the retry cadence
					// changes; the pull-merge that converges is untouched.
					if (attempt + 1 < tries) {
						await new Promise(function (r) {
							setTimeout(r, Math.round(CONFLICT_BACKOFF_MS * (0.5 + Math.random())));
						});
					}
					continue;
				}
				if (res.status === 402) {
					// Not on the sync tier. Nobody asked for this push -- it is the
					// engine's own idle round -- so the refusal is reported where a
					// user can find it and nowhere else. It used to raise a dialog
					// over the whole app and open Credits, which interrupted people
					// who had one device and had never wanted sync.
					entitled = false;			// stop trying until re-checked.
					restStatus();				// and it outranks a stall: see restStatus.
					log('sync not entitled (402); pausing pushes');
					return;
				}
				if (res.status === 413) {
					// The parcel is over the gateway's ceiling, so this device's work
					// stops travelling until something in it gets smaller. That is a
					// thing the user can act on -- almost always one enormous Diamond
					// or one enormous workspace file -- and for it to be actionable it
					// has to be visible. It used to be a console line.
					tooLarge   = true;
					lastPushed = cmp;			// don't spin on the same oversize state.
					restStatus();
					log('blob too large (413); not retrying this payload');
					return;
				}
				// Anything else -- a 5xx, a 429, a gateway restarting -- is not this
				// parcel's fault and is not permanent: owed, and retried on the wire's
				// ladder, no sooner than any Retry-After it carried (`noteRetryAfter`).
				log('push status', res.status, '— retrying on the backoff');
				failKind = 'wire';
				restStatus();
				return;
			}
			// Out of attempts. The mailbox moved under every one of them, so this
			// device's work is still only here -- which is exactly the state the
			// chip exists to report. It is owed, so `finally` arms the retry: tried
			// again on a backoff that reads the mailbox before it sends anything,
			// so two busy devices do not spin against each other, and it is never
			// left for a next change that may not come.
			log('conflict retries exhausted; this device’s work has not been sent');
			failKind = 'conflict';
			jam('busy');
		} finally {
			pushing = false;
			// Whatever did not land is owed; `paid()` has already cleared the flag on
			// both paths that did. The chip is told now that the round has stopped.
			if (unsent) { unsentFailVersion = serverVersion; armUnsent(failKind); }
			endRound();
		}
	}

	/// Push until the CURRENT local parcel is committed on the server, and answer the
	/// version it committed at. A single `await push()` is NOT enough for a caller that
	/// must know a version genuinely CONTAINS the state it just added (a hand-off
	/// dispatcher, whose errand carries that version for the peer to pull to): `push()`
	/// returns early -- sending nothing -- when another push is already in flight, over
	/// a live turn, or when it 409-retries and exhausts. A dispatcher that then read
	/// `version()` would stamp the errand with a version that predates the new chat, and
	/// the peer would reach that version holding no chat. This loops -- push, then
	/// confirm the live parcel equals what last committed -- until the parcel is on the
	/// server or it gives up. Answers `{ ok, version, why? }`; `ok:false` (not entitled,
	/// too large, over a live turn, or the mailbox kept moving) lets the caller fall
	/// back to what a bare push()+version() would have given, and the receiver's own
	/// progress-based catch-up is the further net.
	async function flush() {
		if (!ready() || !entitled) return { ok: false, version: serverVersion, why: 'not_entitled' };
		// Behind the epoch chain: never overwrite the account (see push()).
		if (rekeyBehind) return { ok: false, version: serverVersion, why: 'rekey' };
		// Over a live turn push() will not send (it must not churn the parcel while a
		// turn runs), so do not spin: one best-effort attempt and report it unconfirmed.
		if (window.DaimondCore.busy && DaimondCore.busy()) {
			try { await push(); } catch (e) { /* best effort */ }
			return { ok: false, version: serverVersion, why: 'busy' };
		}
		for (var i = 0; i < FLUSH_MAX_ROUNDS; i++) {
			if (tooLarge) return { ok: false, version: serverVersion, why: 'too_large' };
			// ONE collect per round, not three. push() already collects the parcel and
			// compares it against lastPushed; a pre-push collect here just paid for a
			// second whole-parcel collect of the same state, and this loop ran a third to
			// confirm -- three ~40 MB collects a round on the runner, the S1 the collect
			// fix bounds. So push() does the one collect and, when it finds the live
			// parcel is ALREADY on the server, says so (`committed`), which is the settled
			// case done in one collect. Otherwise a single confirm collect catches a
			// change that landed DURING the push, so a caller is never handed a version
			// that predates the state it just added.
			var r;
			try { r = await push(); } catch (e) { return { ok: false, version: serverVersion, why: 'push_failed' }; }
			// A REFUSAL FOR SIZE IS NOT A LANDING. Both refusals (the front door here, a 413
			// from the gateway) set `lastPushed` to the live parcel so that push() does not
			// spin on it, and the confirm below read that as committed: `ok:true` at the
			// version the mailbox already had, and a dispatcher stamped its errand with a
			// version that does not hold the chat it had just added (P1a M1, 2026-09-25).
			if (tooLarge) return { ok: false, version: serverVersion, why: 'too_large' };
			if (r && r.committed && serverVersion > 0) return { ok: true, version: serverVersion };
			// Confirm against the live parcel: a change under us forces another round.
			// Through compareKey, like push(): a `seen` stamp that moved between the
			// collect and this comparison is not a parcel the mailbox is missing, and
			// reading it as one would spin every round of this loop. And never while the
			// work is owed: owed is exactly "has not landed", whatever `lastPushed` says.
			var after = null;
			try { after = compareKey(await collectParcel()); }
			catch (e) { after = null; }
			if (after !== null && after === lastPushed && serverVersion > 0 && !unsent) return { ok: true, version: serverVersion };
			await new Promise(function (r2) { setTimeout(r2, FLUSH_RETRY_MS); });
		}
		return { ok: false, version: serverVersion, why: 'not_confirmed' };
	}

	// ── The streaming progress push ────────────────────────────
	//
	// A hand-off used to be invisible until it FINISHED: the runner captured and
	// pushed the parcel once, at completion, so a peer watching the turn saw a blank
	// placeholder for the whole run and then the finished turn all at once. This is
	// the push that fills that gap. The runner calls it on a throttled timer through
	// the length of a dispatched turn (peer.js runErrand), and each call sends the
	// transcript AS IT STANDS -- the thinking and the tool calls already in the
	// chat's messages -- so a peer pulling mid-turn watches it unfold.
	//
	// IT IS THE SAME PUSH, MINUS FOUR THINGS. Same account parcel, same mailbox, same
	// compare-and-set, same wake of the OTHER devices. What it is NOT is a new turn or
	// a new lease -- the runner already holds the one lease, the turn is billed once
	// where it runs, and this moves no money. And it deliberately does the LESS of the
	// final push: it does not write the carried fixed point (`saveSig`), advance the
	// file-merge baseline, or commit a live chunk set -- those settle the FINISHED
	// state, and committing a live set mid-turn could sweep a chunk the turn is about
	// to reference. The final `pushResult` does all four; this is only a frame.
	//
	// UNLIKE push(), IT DOES NOT STAND DOWN OVER A LIVE TURN -- streaming the live
	// turn is the whole point. It still shares the one-round gate, so it never
	// overlaps the final push (the runner stops the progress timer BEFORE completing),
	// and it is a no-op when the parcel has not moved, so a quiet stretch of a turn is
	// quiet on the wire. A conflict or a refusal simply drops the frame: the next
	// frame, and failing that the final pushResult (which DOES pull-merge-retry),
	// reconciles. Nothing here ever waits, so it cannot stall the turn it is watching.
	async function pushProgress() {
		if (!ready() || !entitled) return;
		if (rekeyBehind) return;			// behind the epoch chain: never overwrite the account (see push())
		if (tooLarge || sessionGone) return;
		if (Date.now() - lastProgressAt < PROGRESS_PUSH_MIN_MS) return;	// throttle the trickle
		if (inFlight) return;			// a round is running; the next tick tries again
		lastProgressAt = Date.now();
		inFlight = true;
		pushing  = true;
		try {
			var state = await collectParcel();
			var plain = JSON.stringify(state);
			var cmp   = compareKey(state);
			// Nothing new since the last send (progress OR ordinary): quiet frame.
			if (cmp === lastPushed && serverVersion > 0) return;
			var blob;
			try { blob = await DaimondIdentity.wrap(plain); }
			catch (e) { log('progress encrypt failed', e); return; }
			// Carry the rekey record, exactly as the ordinary push does (D3). A progress
			// frame is a full parcel write to the SAME mailbox, so at epoch >= 1 a bare
			// blob would reach a watcher on an older epoch as an unreadable parcel it
			// could neither open nor adopt -- and it would then clobber the account
			// mid-turn. A no-op at epoch 0, byte-identical to today. See wrapEnvelope.
			blob = wrapEnvelope(blob);		// D3: carry the record on the progress path too
			var res;
			// `w` names this tab's wake channel, so the gateway taps the OTHER devices --
			// the ones watching the hand-off -- and not this runner. Bounded by its
			// size's deadline, like every write: a frame that hangs must not hold the
			// gate the final push needs.
			try { res = await call('POST', { base_version: serverVersion, device: deviceLabel(), blob: blob, w: WAKE_ID }); }
			catch (e) { log('progress push network error', e); return; }
			if (res.status === 200 && res.json && res.json.ok) {
				serverVersion = res.json.version | 0;
				lastPushed    = cmp;
				saveVersion();
				noteSynced();
				diag('progress push', 'v' + serverVersion);
				return;
			}
			// A 409 (someone moved the mailbox on) or any refusal: drop this frame. NOT
			// a pull-merge-retry -- that would churn the runner's live chat and could
			// stall the turn; the final pushResult reconciles. A stale cursor after a
			// 409 simply means later frames 409 too and the stream pauses until the
			// final push, which is the safe direction to fail.
			diag('progress push skipped', 'status=' + res.status);
		} finally {
			pushing = false;
			endRound();
		}
	}

	// ── Presence ───────────────────────────────────────────────
	// A separate, lightweight door from push/pull. A beat WRITES this device's
	// last_seen and READS the account's whole fresh map back in one round; it bumps
	// no blob version and wakes no other device, so it can fire every ~45s without
	// the cost push() carries. That is the whole point of moving presence off the
	// content parcel: the moving timestamp no longer re-uploads ~163K and taps every
	// device. The map comes back stamped in the SERVER clock with a `now`, and
	// `DaimondPresence.ingest` converts it into this client's frame.

	/// Beat this device's presence and adopt the authoritative map. `deviceId` and
	/// `name` are passed in by the caller (daimond.js), so this file need not reach
	/// for identity. A missed beat is safe -- the freshness window and the lease
	/// catch a peer that actually slept -- so an error is swallowed rather than
	/// surfaced. Answers the response JSON, or null.
	/// This device's own id, for the lease comparisons. Through DaimondIdentity, which
	/// is where every other per-device decision in this app reads it.
	function selfDeviceId() {
		try {
			return (window.DaimondIdentity && DaimondIdentity.deviceId)
				? String(DaimondIdentity.deviceId() || '') : '';
		} catch (e) { return ''; }
	}

	/// Did THIS device dispatch `turnId`? Read from the dispatched placeholder it
	/// holds for that turn, which carries `dispatchedBy`. A device with no placeholder
	/// for the turn did not send it -- and answering false is the safe direction,
	/// because it only ever makes this device MORE willing to stand off the door.
	function ownDispatch(turnId) {
		try {
			var me = selfDeviceId();
			if (!me) return false;
			var cs = (window.DaimondCore && DaimondCore.chats) ? DaimondCore.chats() : [];
			for (var i = 0; i < (cs || []).length; i++) {
				var msgs = (cs[i] && cs[i].messages) || [];
				for (var j = 0; j < msgs.length; j++) {
					var m = msgs[j];
					if (m && String(m.iturn || '') === String(turnId) && m.dispatchedBy) {
						return String(m.dispatchedBy) === me;
					}
				}
			}
		} catch (e) { /* fall through */ }
		return false;
	}

	async function beatPresence(deviceId, name, attended, servicing, runner, mobile,
		hand, folder) {
		if (!ready() || !entitled) return null;
		if (_removedSelf) return null;		// removed: the door will only refuse it again
		try {
			// `attended` is the attention signal (foreground + recent interaction) a
			// live consent routes on. `servicing` says this device is genuinely running
			// the errand long-poll now (not merely beating) -- the signal a peer's
			// eligibility gate reads to exclude a throttled background tab. Both are sent
			// so a gateway that stores them can relay them (`attended_at`/`serviced_at`); a
			// gateway that does not carry a field ignores it, and the client then falls
			// back safely (no attended peer -> park; no serviced signal -> the bare beat
			// stands and the dispatcher-side recovery timer is the backstop).
			var body = { device_id: String(deviceId || ''), name: String(name || ''), attended: !!attended };
			if (servicing) body.servicing = true;
			// The nominated machine's own posture (runner.js): set up to stay awake and
			// listening, so every other device can tell the nomination from a machine that
			// is actually arranged to honour it. Sent only when true, so an ordinary
			// device's beat is unchanged on the wire.
			if (runner) body.runner = true;
			// `mobile` is this MACHINE's own answer about whether it is a phone or tablet,
			// the signal the hand-off election seats a worker on. Sent EXPLICITLY, both ways,
			// because the alternative the gateway relayed was the device's NAME: a phone
			// called "gilgamesh" read as a desktop and was handed turns it could not hold.
			// Omitted only when this device genuinely cannot say, which a gateway relays as
			// absent so the peer falls back to the old inference rather than to "desktop".
			if (typeof mobile === 'boolean') body.mobile = mobile;
			// THE TWO PLACEMENT FIELDS: can this machine reach a machine hand, and does it
			// hold the real mounted folder rather than a browser replica. They are what
			// lets another device place a compile or a publish without asking -- a phone
			// that cannot hold a book's files hands the layout to a machine that can.
			//
			// Sent EXPLICITLY, both ways, and NOT sticky at the gateway. A hand unplugged
			// and a folder grant withdrawn are both live changes, and only an explicit
			// false can say so; absence then genuinely means "this build cannot say", which
			// the election reads as unknown and NAMES rather than striking out. `runner`'s
			// send-only-when-true shape would leave a withdrawn hand reading as present for
			// as long as the device kept beating.
			if (typeof hand === 'boolean')   body.hand = hand;
			if (typeof folder === 'boolean') body.folder = folder;
			// The running build id, so the gateway (once it relays this field) can show the
			// fleet's build spread in its log and every device can de-prefer a peer on a
			// superseded build at hand-off. A gateway that does not carry the field ignores
			// it and the roster's last-known build stands in, exactly like `servicing`.
			try {
				var b = window.DaimondUpdater && DaimondUpdater.booted && DaimondUpdater.booted();
				if (b) body.build = String(b);
			} catch (e) { /* build not read yet: the beat still stands */ }
			var res = await call('POST', body, '?presence=1');
			// REMOVED. The beat is the door a removed device meets first and most often,
			// so it is where the device finds out -- and, because the gateway refuses the
			// beat before it records it, the same answer is what takes this device out of
			// every other device's presence map. `notedRemoval` raises the one event that
			// wipes and locks, once.
			if (notedRemoval(res)) return null;
			if (res.status === 200 && res.json && res.json.presence && window.DaimondPresence) {
				DaimondPresence.ingest(res.json.presence, res.json.now);
			}
			return res.json || null;
		} catch (e) { log('presence beat failed', e); return null; }
	}

	/// Read the account's presence map WITHOUT writing a beat -- a GET to
	/// `?presence=1` -- and adopt it, for a dispatch-time refresh so the decision
	/// sees the freshest peers. Quiet on error, like the beat.
	async function refreshPresence() {
		if (!ready() || !entitled) return null;
		try {
			var res = await call('GET', undefined, '?presence=1');
			if (res.status === 200 && res.json && res.json.presence && window.DaimondPresence) {
				DaimondPresence.ingest(res.json.presence, res.json.now);
			}
			return res.json || null;
		} catch (e) { log('presence refresh failed', e); return null; }
	}

	// ── Removal: the device that really is gone ────────────────
	// Owner ruling 2026-09-12: "Remove device" must REALLY remove. Pairing copies the
	// account keypair whole, so nothing on the removed device can be revoked -- what
	// the gateway can do is refuse the id at every door a device reaches it by, and
	// tell the device so at its next beat. `?removed=1` is a QUERY DOOR on this route,
	// exactly as presence and the lease took theirs: a new path would need the Steel
	// front door's own route table brought forward before a browser could reach it.

	/// Remove a device from this account, on the gateway. After this the gateway
	/// refuses that id's presence beats and post-box parks (410, `removed:true`) and
	/// stops waking it -- which is what makes the removal real rather than a line off
	/// a list. Answers `{ ok }`.
	async function removeDeviceRemote(deviceId) {
		var id = String(deviceId || '');
		if (!id) return { ok: false, why: 'no-device' };
		// AUTHORITATIVE self-removal guard, before any network call. The panel's own
		// UI already hides the ✕ on this device's own row (daimond.js), but that is
		// a belt, not the buckle: the gateway's `removed_op` accepts any hex id
		// including the caller's own, since the removal POST carries no `by` field
		// yet (see the fix plan's item 5, a gateway-side follow-up). A caller that
		// reaches this function directly -- the API, or a UI path that bypasses the
		// hidden ✕ -- must not be able to remove the device it is running on.
		if (id === selfDeviceIdForDoor()) return { ok: false, why: 'self' };
		if (!ready()) return { ok: false, why: 'offline' };
		try {
			var res = await call('POST', { device: id }, '?removed=1');
			return { ok: !!(res && res.status === 200 && res.json && res.json.ok),
				status: (res && res.status) | 0 };
		} catch (e) { log('device removal failed', e); return { ok: false, why: 'error' }; }
	}

	// THIS DEVICE WAS REMOVED. Raised ONCE, the first time any door answers 410 with
	// `removed:true`, and it is the end of this device's life on the account: the
	// event is what daimond.js wipes the account's key material and locks on. Latched,
	// because every door will answer the same way and a second wipe is noise.
	var _removedSelf = false;

	/// Did this answer say THIS DEVICE has been removed? Keyed on the flag rather than
	/// the status alone, so a proxy that rewrote a 410 could not turn a removal into an
	/// ordinary failure -- and so an unrelated 410 from somewhere else cannot lock a
	/// device nobody removed.
	function notedRemoval(res) {
		var removed = !!(res && res.status === 410 && res.json && res.json.removed === true);
		if (!removed || _removedSelf) return removed;
		_removedSelf = true;
		log('this device was removed from the account');
		try { window.dispatchEvent(new CustomEvent('daimond:device-removed')); }
		catch (e) { /* no window: the next door says the same thing */ }
		return true;
	}

	/// Has this device been told it is removed? Read by the beat loops, so they stop
	/// asking rather than hammering a door that will refuse them for ever.
	function removedSelf() { return _removedSelf; }

	/// This device's id, for the doors that name it -- the wake socket, and (in
	/// post.js) the errand park. Read at call time rather than cached: a device that is
	/// not unlocked yet has none, and an empty id is exactly what an older client sent,
	/// so the door refuses nothing by id and behaves as it always did.
	function selfDeviceIdForDoor() {
		try { return String((window.DaimondIdentity && DaimondIdentity.deviceId()) || ''); }
		catch (e) { return ''; }
	}

	// ── The lease door ─────────────────────────────────────────
	// WHICH DEVICE IS RUNNING A TURN used to ride the content parcel as a section,
	// so a lease CLAIM was a whole-parcel compare-and-set: under three busy devices
	// the parcel version churned faster than a claim could land, and the loser of a
	// hand-off race stormed the gateway with 409s (up to the take loop times the
	// push loop) before it stood down. The lease now has its own lightweight CAS
	// door on the gateway (`?lease=1`), exactly as presence took its own door: a
	// claim is a ~100-byte compare-and-set that does not touch the parcel and does
	// not contend with content churn. The arbitration is unchanged -- it still lives
	// in DaimondLease's take-if-vacant merge and the merge-trust re-read, so exactly
	// one runner still wins a turn; only the CAS substrate moved off the parcel.
	//
	// The blob is the lease map, AES-GCM-sealed under the account key with the lease
	// purpose bound in (so the gateway holds an opaque record and a lease blob is
	// cryptographically distinct from a parcel or an envelope). A tiny marker inside
	// guards against ever reading some other blob as a lease.
	var LEASE_AAD  = 'daimond/peer/lease/1';
	var LEASE_MARK = 'dlease1';
	var _leaseVer  = 0;			// the door's version this device last saw.

	// Base64 of raw bytes and back -- the door blob is bytes, unlike the parcel
	// which travels as a string through DaimondIdentity.wrap.
	function b64FromBytes(bytes) {
		var b = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
		var s = '';
		for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
		return btoa(s);
	}
	function bytesFromB64(s) {
		var raw = atob(String(s));
		var out = new Uint8Array(raw.length);
		for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
		return out;
	}

	// ── The rekey envelope, carried INSIDE the sync blob ───────
	//
	// A passphrase change on one device forks the account: a second device on the old
	// salt cannot read a byte the changer pushes, adopts its version, and pushes its own
	// over the top, and the two clobber each other for ever (the corruption recovery in
	// pullOnce, misfiring across an epoch change). The fix carries the change TO the
	// lagging device: identity.js seals the new key bits under the old key into a rekey
	// record, and that record rides here, in the clear, alongside the sealed parcel.
	//
	// THE GATEWAY NEVER SEES IT. `blob_b64` is stored opaque and validated only as
	// base64 and size, so the envelope lives INSIDE the base64 the gateway already
	// accepts -- no gateway change, and an account at epoch 0 emits NO envelope, so its
	// blob is byte-identical to what it was before any of this existed.
	//
	// The wire shape: base64( 'DRK1' ‖ u32-BE(len) ‖ utf8(record JSON) ‖ IV‖ct ). The
	// record carries only ciphertexts and public values (a wrapped private key, a salt,
	// a public key, the chain of links each of which is itself a ciphertext), so it is
	// safe in the clear -- nothing a passphrase gates is legible in it.
	var DRK_B0 = 68, DRK_B1 = 82, DRK_B2 = 75, DRK_B3 = 49;	// 'D','R','K','1'

	/// Wrap a sealed parcel in the rekey envelope when this device is at epoch >= 1.
	/// At epoch 0 (or with no record) the blob is returned unchanged -- byte-identical to
	/// today. Never throws over the envelope: a failure here falls back to the bare blob,
	/// which a same-epoch device still reads.
	function wrapEnvelope(sealedB64) {
		try {
			if (!window.DaimondIdentity || !DaimondIdentity.epoch || !DaimondIdentity.rekeyRecord) return sealedB64;
			var ep  = DaimondIdentity.epoch() | 0;
			var rec = DaimondIdentity.rekeyRecord();
			if (ep <= 0 || !rec) return sealedB64;
			var json   = new TextEncoder().encode(JSON.stringify(rec));
			var sealed = bytesFromB64(sealedB64);
			var out    = new Uint8Array(8 + json.length + sealed.length);
			out[0] = DRK_B0; out[1] = DRK_B1; out[2] = DRK_B2; out[3] = DRK_B3;
			out[4] = (json.length >>> 24) & 255; out[5] = (json.length >>> 16) & 255;
			out[6] = (json.length >>> 8) & 255;  out[7] = json.length & 255;
			out.set(json, 8);
			out.set(sealed, 8 + json.length);
			return b64FromBytes(out);
		} catch (e) { log('rekey envelope not written', e); return sealedB64; }
	}

	/// Split a pulled blob into its rekey record (or null) and the sealed parcel.
	///
	/// A legacy / epoch-0 blob is base64 of `IV‖ct` with no header, and is returned as
	/// `{ rec: null, sealed: <the blob unchanged> }`. Only a blob whose first four
	/// decoded bytes are 'DRK1' AND whose length and JSON both parse cleanly is read as
	/// an envelope; a random legacy IV beginning 'DRK1' is 2^-32, and the parse fallback
	/// catches even that. `sealed` is what DaimondIdentity.unwrap / unwrapPrev opens.
	function openEnvelope(b64) {
		try {
			var bytes = bytesFromB64(b64);
			if (bytes.length >= 8
				&& bytes[0] === DRK_B0 && bytes[1] === DRK_B1
				&& bytes[2] === DRK_B2 && bytes[3] === DRK_B3) {
				var len = ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0;
				if (8 + len <= bytes.length) {
					var rec = JSON.parse(new TextDecoder().decode(bytes.slice(8, 8 + len)));
					if (rec && rec.v === 1 && typeof rec.epoch === 'number') {
						return { rec: rec, sealed: b64FromBytes(bytes.slice(8 + len)) };
					}
				}
			}
		} catch (e) { /* not an envelope: fall through to the legacy reading */ }
		return { rec: null, sealed: b64 };
	}

	/// Adopt a passphrase change carried in a pulled record: read the app's sealed
	/// secrets out under the OLD key, swap to the new key (via `swap`), and put them
	/// back under it.
	///
	/// The same three-step shape as `doChangePassphrase` (daimond.js), and for the same
	/// reason: mail/voice/post hold secrets ONLY sealed, so they must be read out before
	/// the key changes and resealed after. The identity swap itself (`adoptRekey` or
	/// `adoptDiverged`) touches only the identity's own keys and names no module; this
	/// runs the DaimondRekey registry around it. On a failure to walk the chain the
	/// registry's `forgetAll` drops whatever was read out -- the old key is still in
	/// force, so nothing is lost.
	///
	/// Any reseal FAILURE is carried out in `sentences` and surfaced to the user, on
	/// this adopting device, via the `daimond:rekey` event -- the same words the
	/// changer's own notice carries (D5). A secret that could not be resealed is lost
	/// to this device otherwise, silently.
	/// Run `run` (an adoption) with at most one adoption in flight at a time (D7).
	/// A second caller waits for the first to finish -- by then the epoch has moved,
	/// so it sees 'stale' rather than resealing over a key the first already changed.
	/// The set of `adopting` happens with no await between the wait and the set, so it
	/// cannot race in this single-threaded engine.
	async function withAdoptLock(run) {
		while (adopting) { try { await adopting; } catch (e) { /* its own caller handled it */ } }
		var p = run();
		adopting = p;
		try { return await p; }
		finally { if (adopting === p) adopting = null; }
	}

	async function runAdopt(swap, rec) {
		if (window.DaimondRekey && DaimondRekey.readAll) {
			try { await DaimondRekey.readAll(); }
			catch (e) { /* a participant that could not read is forgotten below on failure */ }
		}
		var ad;
		try { ad = await swap(rec); }
		catch (e) { ad = { ok: false, reason: 'threw' }; }
		if (!ad || !ad.ok) {
			if (window.DaimondRekey && DaimondRekey.forgetAll) {
				try { DaimondRekey.forgetAll(); } catch (e) { /* each caught its own */ }
			}
			return { ok: false, reason: (ad && ad.reason) || 'bad' };
		}
		// Back under the new key, and -- via the sync participant's own reseal --
		// `lastPushed` is dropped so this device carries the record onward on its next
		// push. `resealAll` collects each participant's failure sentences rather than
		// stopping on the first, exactly as the changer's own path does.
		var sentences = [];
		if (window.DaimondRekey && DaimondRekey.resealAll) {
			try {
				var rr = await DaimondRekey.resealAll();
				if (rr && rr.sentences && rr.sentences.length) sentences = rr.sentences;
			}
			catch (e) { /* a reseal failure is not a reason to fork; the notice still fires */ }
		}
		// ONE shell notification for the whole adoption, fired AFTER the reseal so it
		// can carry what did not survive it (D5). The identity swap fires nothing; this
		// is the single `daimond:rekey` the shell listens for. Any reseal sentences ride
		// in the detail so the notice on this device reads like the changer's own.
		try {
			window.dispatchEvent(new CustomEvent('daimond:rekey', { detail: { sentences: sentences } }));
		} catch (e) {
			try { window.dispatchEvent(new Event('daimond:rekey')); } catch (e2) { /* no window */ }
		}
		return { ok: true, sentences: sentences };
	}

	/// Adopt a record from a HIGHER epoch -- a device behind the chain catching up.
	function adoptEpoch(rec) {
		return runAdopt(function (r) { return DaimondIdentity.adoptRekey(r); }, rec);
	}

	/// Yield to the OTHER branch of a same-epoch divergence (D2): the larger-salt side
	/// walks the shared link onto the incoming branch. `adoptDiverged` needs the
	/// previous-epoch key; without it this returns `{ ok:false, reason:'noprev' }` and
	/// the caller stands the device behind the chain rather than clobber.
	function adoptDivergedEpoch(rec) {
		return runAdopt(function (r) { return DaimondIdentity.adoptDiverged(r); }, rec);
	}

	/// Seal a lease map for the door, or '' when there is nothing (or no key) to
	/// send -- an empty blob is a vacant door, which the gateway stores verbatim.
	async function leaseSeal(map) {
		if (!map || !Object.keys(map).length) return '';
		if (!window.DaimondIdentity || !DaimondIdentity.wrapBytesAad
			|| (DaimondIdentity.isUnlocked && !DaimondIdentity.isUnlocked())) return '';
		var plain = new TextEncoder().encode(JSON.stringify({ k: LEASE_MARK, v: map }));
		return b64FromBytes(await DaimondIdentity.wrapBytesAad(plain, LEASE_AAD));
	}

	/// Open a door blob back to a lease map, or null when it is empty, unopenable,
	/// or not a lease record (the marker did not match).
	async function leaseUnseal(b64) {
		if (!b64) return null;
		if (!window.DaimondIdentity || !DaimondIdentity.unwrapBytesAad
			|| (DaimondIdentity.isUnlocked && !DaimondIdentity.isUnlocked())) return null;
		try {
			var pt  = await DaimondIdentity.unwrapBytesAad(bytesFromB64(b64), LEASE_AAD);
			var obj = JSON.parse(new TextDecoder().decode(pt));
			return (obj && obj.k === LEASE_MARK && obj.v) ? obj.v : null;
		} catch (e) { return null; }
	}

	/// Read the lease door: its version and the decrypted lease map. Empty map on a
	/// vacant or unopenable door. Caches the version so a later fallback getter and
	/// the claim path agree on the base.
	async function leaseGet() {
		var res = await call('GET', undefined, '?lease=1');
		var j   = res && res.json;
		var ver = (j && j.version) | 0;
		_leaseVer = ver;
		// Phase B: the gateway serves the door's cap on this answer. `learn` ignores an
		// absent field, so a Phase-A gateway that sends none changes nothing.
		if (window.DaimondWire && j && j.max) DaimondWire.learn({ lease: j.max });
		var leases = (j && j.blob) ? (await leaseUnseal(j.blob)) : null;
		return { version: ver, leases: leases || {} };
	}

	/// Compare-and-set the lease door: seal `proposed`, push it against `base`.
	/// Answers the shape DaimondLease's CAS expects -- `{ ok, version, leases }` --
	/// so a 409 hands back the door's current version and map for the retry.
	async function leaseCommit(base, proposed) {
		// Behind the epoch chain: never overwrite a shared door (see push()) (D8). This
		// device's wrap key is stale, so a lease blob it sealed would be unreadable to
		// the devices on the current epoch -- the same reason push/flush/pushProgress
		// all stand down. Reported as a no-op CAS the take loop drops.
		if (rekeyBehind) return { ok: false, why: 'rekey', version: base | 0, leases: proposed };
		var blob = await leaseSeal(proposed);
		// WEIGH BEFORE THE CAS. The gateway refuses a lease blob over LEASE_MAX_BYTES
		// with a 413 (sync.rs:423); measuring the sealed size against the same rule here
		// means an over-large door is answered `too_large` with ZERO requests, rather
		// than the take loop spinning MAX_TAKE_TRIES times against a size refusal read as
		// a 409. `proposed` is handed back so the caller's merge/re-read is unchanged.
		if (blob && window.DaimondWire && !DaimondWire.fits('lease', blob.length)) {
			log('lease blob would not fit the door (' + blob.length + ' b64 chars); not sending');
			return { ok: false, why: 'too_large', version: base | 0, leases: proposed };
		}
		var res  = await call('POST', { base_version: base | 0, blob: blob, w: WAKE_ID }, '?lease=1');
		var j    = res && res.json;
		if (res && res.status === 200 && j && j.ok) {
			_leaseVer = (j.version) | 0;
			return { ok: true, version: _leaseVer };
		}
		// A real 413: the door weighed it and it does not fit. Report it as such and
		// hold the base version (NOT the 0 an empty-body refusal would zero it to), so
		// the take path stands down at once with `too_large` instead of spinning.
		if (res && res.status === 413) {
			return { ok: false, why: 'too_large', version: base | 0, leases: proposed };
		}
		// 409 (or any other refusal): report the door's current state for the re-read.
		var ver = (j && j.version) | 0;
		_leaseVer = ver;
		return { ok: false, version: ver, leases: (j && j.blob) ? (await leaseUnseal(j.blob)) || {} : {} };
	}

	/// Adopt the lease map folded into an ordinary pull (like presence), so a device
	/// that dispatched -- and is only WATCHING, never claiming -- still sees the peer
	/// take and run the turn and advances its footer (D4). `j.lease` is the door's
	/// {version, blob}; a moved merge fires DaimondLease.onChange for the redraw.
	async function adoptLeaseDoor(lease) {
		if (!lease || !window.DaimondLease) return;
		_leaseVer = (lease.version) | 0;
		// Phase B: the door's cap rides the folded lease dat too. Absent on a Phase-A
		// gateway, which `learn` tolerates.
		if (window.DaimondWire && lease.max) DaimondWire.learn({ lease: lease.max });
		var map = lease.blob ? (await leaseUnseal(lease.blob)) : null;
		try { DaimondLease.adopt(map || {}); } catch (e) { log('lease adopt failed', e); }
	}

	// ── The streaming progress door (`?progress=<turnId>`) ─────
	//
	// WHAT IT REPLACED, and why the replacement is not the same push made smaller.
	// The runner used to stream a handed-off turn by pushing the WHOLE content parcel
	// every two seconds (pushProgress, below), and the watching device pulled the
	// whole parcel back: megabytes each way for a few hundred new characters. Worse,
	// the push was a compare-and-set on the parcel, so a 409 from ANY other device
	// DROPPED the frame, and one refusal for size (`tooLarge`) stopped the stream for
	// the rest of the turn. A watcher then saw nothing until the turn ended, which is
	// the complaint this door answers.
	//
	// A frame here is the turn's rendered TAIL -- the daimon's text so far, its tool
	// calls as one-line summaries, its thinking as a count -- sealed under the account
	// key, at most PROGRESS_TAIL_MAX of plaintext, written to a record of its own per
	// turn. The gateway assigns the seq, so there is nothing to be stale against and
	// no frame can be refused by another device's activity. The full parcel push is
	// still what settles the FINISHED turn (pushResult); this is only the view.
	var PROG_AAD  = 'daimond/peer/progress/1';
	var PROG_MARK = 'dprog1';

	/// Seal a frame for the door, or '' when there is no key to seal it with. The
	/// marker guards against ever reading some other blob as a progress frame, as
	/// the lease's does.
	async function progSeal(obj) {
		if (!window.DaimondIdentity || !DaimondIdentity.wrapBytesAad
			|| (DaimondIdentity.isUnlocked && !DaimondIdentity.isUnlocked())) return '';
		var plain = new TextEncoder().encode(JSON.stringify({ k: PROG_MARK, v: obj }));
		return b64FromBytes(await DaimondIdentity.wrapBytesAad(plain, PROG_AAD));
	}

	/// Open a frame, or null when it is empty, unopenable, or not a frame.
	async function progUnseal(b64) {
		if (!b64) return null;
		if (!window.DaimondIdentity || !DaimondIdentity.unwrapBytesAad
			|| (DaimondIdentity.isUnlocked && !DaimondIdentity.isUnlocked())) return null;
		try {
			var pt  = await DaimondIdentity.unwrapBytesAad(bytesFromB64(b64), PROG_AAD);
			var obj = JSON.parse(new TextDecoder().decode(pt));
			return (obj && obj.k === PROG_MARK && obj.v) ? obj.v : null;
		} catch (e) { return null; }
	}

	// This device's own frame counter per turn, carried INSIDE the sealed frame. The
	// gateway's seq is what a watcher orders by; this is what the runner can say
	// about its own sending, and what the feed event reports.
	var _progSeq = {};

	/// PUT one frame of `turnId`'s transcript tail. Answers
	/// `{ ok, seq, bytes, ms, why? }` -- never throws, because a dropped frame is a
	/// slower stream and nothing more.
	///
	/// `final` marks THE LAST FRAME OF THE TURN: the turn has ended and this tail is
	/// the whole of what it produced. A watcher draws it and stops following (see
	/// `foldProgress`, peer.js), which is what lets the originating device show the
	/// finished answer without waiting for the account parcel -- the parcel was
	/// 20.3 s of the owner's 58.9 s hand-off, spent entirely after the turn was over.
	///
	/// On a `413` the tail is halved and sent ONCE more: the gateway names its
	/// ceiling, so the runner fits it rather than stopping. Every other refusal is
	/// reported and the next tick tries again with a fresher tail.
	async function pushProgressFrame(turnId, tail, final) {
		var out = { ok: false, seq: 0, bytes: 0, ms: 0 };
		if (!ready() || !entitled || sessionGone) return out;
		if (rekeyBehind) return out;			// behind the epoch chain: never overwrite the account (see push())
		if (!turnId || !tail) return out;
		var t0 = Date.now();
		var q  = '?progress=' + encodeURIComponent(String(turnId));
		var text = String(tail);
		if (text.length > PROGRESS_TAIL_MAX) text = text.slice(-PROGRESS_TAIL_MAX);
		for (var attempt = 0; attempt < 2; attempt++) {
			var seq = (_progSeq[turnId] | 0) + 1;
			var blob;
			try { blob = await progSeal({ turn: String(turnId), seq: seq, tail: text, final: !!final }); }
			catch (e) { out.why = 'seal'; return out; }
			if (!blob) { out.why = 'locked'; return out; }
			var res;
			try { res = await call('PUT', { blob: blob, w: WAKE_ID }, q); }
			catch (e) { out.why = 'network'; return out; }
			if (res.status === 200 && res.json && res.json.ok) {
				_progSeq[turnId] = seq;
				out.ok    = true;
				out.seq   = res.json.seq | 0;
				out.bytes = blob.length;
				out.ms    = Date.now() - t0;
				noteSynced();
				feedProgress(turnId, out);
				return out;
			}
			// The ceiling, named by the gateway: halve the tail and send once more.
			// NOT a stop -- stopping on one oversized frame is the fault this door
			// removes, and the next frame would be oversized too.
			if (res.status === 413 && attempt === 0) {
				text = text.slice(-Math.max(2048, Math.floor(text.length / 2)));
				continue;
			}
			out.why = 'status=' + res.status;
			diag('progress frame skipped', out.why);
			return out;
		}
		return out;
	}

	/// Read `turnId`'s latest frame, newer than `since`: `{ seq, tail, final }`, or null
	/// where there is nothing newer (the door's 204) or it could not be opened.
	///
	/// NEVER PARKED, and that is the fix of 2026-09-23. A watcher used to hold one read
	/// per watched turn at the door for 25 s at a time. The front door is HTTP/1.1, so
	/// the browser allows six connections to the origin, and two such reads held for
	/// twelve hours queued every pull behind them: 2,534 aborts on gilgamesh and pulls
	/// fifty times slower. News of a frame now arrives on the wake channel, which is
	/// held once per page however many turns are watched, and this read answers at once.
	async function getProgressFrame(turnId, since) {
		if (!ready() || !entitled || sessionGone || !turnId) return null;
		var q = '?progress=' + encodeURIComponent(String(turnId))
			+ '&since=' + (since | 0) + '&w=' + encodeURIComponent(WAKE_ID);
		var res;
		try { res = await call('GET', undefined, q, { timeoutMs: PULL_TIMEOUT_MS }); }
		catch (e) { return null; }
		if (!res || res.status !== 200 || !res.json || !res.json.blob) return null;
		var frame = await progUnseal(res.json.blob);
		if (!frame || String(frame.turn || '') !== String(turnId)) return null;
		return { seq: res.json.seq | 0, tail: String(frame.tail || ''), final: !!frame.final };
	}

	/// Follow `key`'s progress frames: `onFrame(frame)` is called with each frame newer
	/// than the last one seen, until `unwatchProgress(key)`. Watching again replaces the
	/// callback and keeps the place.
	///
	/// ONE READER FOR EVERY STREAM. The gateway taps the account's wake channel whenever
	/// any device stores a frame (`p<seq>` on the socket, `progress:true` on a park), and
	/// a tap reads each watched key once, one short request after another. So the page
	/// holds the one wake channel it holds anyway, whatever it watches, and a frame is
	/// read within a moment of being stored. A new watch is read at once, because a
	/// frame stored before it began is not going to be tapped again.
	function watchProgress(key, onFrame) {
		key = String(key || '');
		if (!key || typeof onFrame !== 'function') return;
		var had = !!progWatch[key];
		progWatch[key] = { since: had ? progWatch[key].since : 0, onFrame: onFrame };
		if (!had) {
			setProgressWanted();
			progressSweep();
		}
	}

	function unwatchProgress(key) {
		key = String(key || '');
		if (!progWatch[key]) return;
		delete progWatch[key];
		setProgressWanted();
	}

	/// The keys being followed, for the verifier and for debugging.
	function progressWatched() { return Object.keys(progWatch); }

	/// The gateway says a frame was stored for one of the account's turns. The tap
	/// carries no turn -- a frame's seq counts per turn and names nothing -- so each
	/// watched key is read once, and a key with nothing newer answers 204 at once.
	function progressTap() {
		progTaps++;
		progressSweep();
	}

	/// The gateway itself tapped this generation of the channel: from here on the taps
	/// carry the stream and the tick stands down.
	function progressTapped() {
		progTapGen = wakeGen;
		if (Object.keys(progWatch).length) progressTap();
	}

	/// Read the watched frames on a timer, WHERE NO TAP WILL COME. A gateway older than
	/// the tap sends only parcel versions, so a page that trusted the channel alone read
	/// a hand-off's first frame and nothing after it until the answer merged (2026-09-23
	/// audit F1: a page can be deployed ahead of its gateway). So the tick reads while
	/// the channel is shut, or open but not yet heard to tap in this generation; once
	/// the gateway has tapped, the tick costs nothing. Owned by the watch set, not by
	/// the hand-off poll, because a compile is watched with no hand-off out.
	function progressTick() {
		if (!Object.keys(progWatch).length) return;
		if (wakeOpen() && progTapGen === wakeGen) return;
		progressSweep();
	}

	/// Read every watched key once, in turn. Coalesced: a tap during a sweep asks for
	/// one more pass after it rather than a second sweep beside it, so there is never
	/// more than one progress read in flight.
	async function progressSweep() {
		if (progSweeping) { progAgain = true; return; }
		progSweeping = true;
		try {
			do {
				progAgain = false;
				var keys = Object.keys(progWatch);
				for (var i = 0; i < keys.length; i++) {
					var w = progWatch[keys[i]];
					if (!w) continue;					// unwatched while the sweep ran
					var frame = null;
					try { frame = await getProgressFrame(keys[i], w.since); } catch (e) { frame = null; }
					if (!frame || progWatch[keys[i]] !== w) continue;
					if ((frame.seq | 0) > w.since) w.since = frame.seq | 0;
					try { w.onFrame(frame); } catch (e) { /* a watcher's fault stays its own */ }
				}
			} while (progAgain && Object.keys(progWatch).length);
		} finally {
			progSweeping = false;
		}
	}

	/// Tell the wake channel whether this page wants progress taps. The socket carries
	/// them always and costs nothing to ignore; a PARK is answered by each one, so it
	/// asks for them (`&prog=1`) only while something is watched. When that changes,
	/// the held park is ended so the next one asks the right question.
	var wakeProgWanted = false;
	function setProgressWanted() {
		var on = Object.keys(progWatch).length > 0;
		if (on && !progTimer) progTimer = setInterval(progressTick, PROGRESS_TICK_MS);
		if (!on && progTimer) { clearInterval(progTimer); progTimer = null; }
		if (on === wakeProgWanted) return;
		wakeProgWanted = on;
		if (wakeMode === 'poll' && wakeHold.ac) {
			wakeKicked = true;
			try { wakeHold.ac.abort(); } catch (e) { /* already answered */ }
		}
	}

	/// Report a frame to the debug-share feed: how big it was and how long it took,
	/// so the streaming path is visible in the feed rather than inferred from the
	/// transcript that eventually appears.
	function feedProgress(turnId, out) {
		try {
			if (window.DEBUG_SHARE && DEBUG_SHARE.event) {
				DEBUG_SHARE.event('progress', {
					turn:  String(turnId).slice(0, 16),
					seq:   out.seq,
					bytes: out.bytes,
					ms:    out.ms,
				});
			}
		} catch (e) { /* the feed never breaks a frame */ }
	}

	// ── Wake channel ───────────────────────────────────────────
	// The trigger that was missing. Every other trigger in this file is something
	// that happened HERE -- a turn ended, the window came back, a Diamond was
	// renamed -- so a window left open and unfocused had none at all, and sat on
	// stale state until somebody touched it. This one comes from the gateway,
	// which is the only party that knows when the mailbox moved.
	//
	// WHAT ARRIVES IS A NUMBER. The gateway sends the account's new blob version
	// and nothing else: no content, no device label, no account name. A version
	// higher than the one this device holds runs the SAME pull the focus path
	// runs, over the same authenticated request. The end-to-end story does not
	// change by a byte, because nothing new crosses the wire.
	//
	// TWO WAYS IN, AND IT ASKS BEFORE IT PICKS. The first thing the channel does
	// is park one short plain request, which answers whether there is a gateway
	// there, whether it speaks this, and whether it already has news. Only then
	// does it reach for a WebSocket; where the front door will not carry one, it
	// goes on parking requests for three quarters of a minute at a time, which
	// any proxy in the world will forward. Parking is not a consolation prize: a
	// completed response wakes a throttled background tab exactly as a frame
	// does, which is the property that matters here.
	//
	// If neither works the channel turns itself off and the app is exactly what
	// it was before -- focus, settling, and the throttled catch-up in push().

	/// The newest version the wake channel has nothing to pull for: the one this device
	/// merged, or a newer one it pulled and could not merge. The second belongs to the
	/// bounded re-pull, which already has it on a backoff, so the channel parks above it
	/// and wakes only for a version genuinely newer (P1a H2).
	function heardUpTo() {
		return Math.max(serverVersion | 0, failedVersion | 0);
	}

	/// Note a version the channel heard about, and pull for it -- once, soon, and
	/// not on the heels of a pull that has just asked the same question.
	function wakeTo(v) {
		v = v | 0;
		if (v > wakeTarget) wakeTarget = v;
		if (v <= heardUpTo()) return;			// already have it, or the re-pull owns it.
		if (wakeSoon) return;					// a pull is already coming.
		var wait = Math.max(0, WAKE_PULL_MIN_MS - (Date.now() - lastPullAt));
		wakeSoon = setTimeout(function () { wakeSoon = null; wakePull(); }, wait);
	}

	/// The pull a wake asks for. Held behind the same `inFlight` gate as every
	/// other round, and re-armed rather than dropped if one is under way: the
	/// news is real, so it must not be lost to a coincidence of timing.
	async function wakePull() {
		if (!ready()) return;
		if (wakeTarget <= heardUpTo()) return;
		if (inFlight) {
			if (!wakeSoon) wakeSoon = setTimeout(function () { wakeSoon = null; wakePull(); }, 500);
			return;
		}
		wakes++;
		inFlight = true;
		try { await pull(); }
		finally { endRound(); }
	}

	/// Whether the channel should be running at all: sync can run, and this
	/// account is allowed to push. A 402 stops the channel with the pushes -- an
	/// account that may not sync has nothing to be woken for.
	function wakeWanted() {
		return ready() && entitled && wakeMode !== 'off';
	}

	/// Open the channel, by whichever transport is still on the table.
	function wakeStart() {
		if (!wakeWanted()) return;
		if (wakeMode === 'poll') { wakePoll(); return; }
		if (wakeMode === '')     { wakeProbe(); return; }
		wakeSocket();
	}

	/// Ask once, over plain HTTP, before reaching for a socket.
	///
	/// A short parked request settles three questions in one go: whether there is
	/// a gateway there at all, whether it understands the channel, and whether it
	/// already has news. Only then is a WebSocket attempted.
	///
	/// The order matters for a reason that has nothing to do with the protocol: a
	/// WebSocket that cannot connect writes a line to the browser's console that
	/// no application code can suppress. Opening one speculatively -- against a
	/// gateway that is not running, or a stubbed one in a test -- fills the console
	/// with failures of a thing that was working as designed. Asking first costs
	/// one request and about a second.
	async function wakeProbe() {
		if (wakeSock || wakeTimer) return;
		// A probe belonging to a torn-down generation is not this channel's: it
		// stood down at the teardown, and the request it is parked on will answer
		// to nobody. Only a probe of the CURRENT generation is a reason not to
		// make another one, or a re-arm waits out a park it has already abandoned.
		if (wakeProbing && wakeProbeGen === wakeGen) return;
		var gen = wakeGen;
		wakeProbing  = true;
		wakeProbeGen = gen;
		try {
			var res;
			try {
				res = await call('GET', undefined,
					'?above=' + heardUpTo() + '&ms=' + WAKE_PROBE_MS + '&w=' + encodeURIComponent(WAKE_ID));
			} catch (e) {
				if (gen === wakeGen) wakeRetry();		// nothing answering; try again later.
				return;
			}
			// THE NEWS FIRST, WHATEVER GENERATION HEARD IT. That the mailbox has
			// moved is a fact about the ACCOUNT, not about the channel that
			// happened to be holding the question, so a teardown arriving between
			// the asking and the answering is no reason to throw it away. Only
			// `wakeWanted()` may refuse it: a device that has signed out, or been
			// put deliberately on 'off', has no business pulling.
			if (res.status === 200 && res.json && res.json.waited === true
				&& res.json.changed && wakeWanted()) {
				wakeTo(res.json.version | 0);
			}
			// Everything below decides what the channel does NEXT, which is the
			// live generation's business and nobody else's.
			if (gen !== wakeGen || !wakeWanted()) return;
			if (res.status !== 200) { wakeRetry(); return; }
			if (!res.json || res.json.waited !== true) {
				log('wake channel: this gateway does not park requests; channel off');
				wakeMode = 'off';
				return;
			}
			wakeBackoff = WAKE_RETRY_MIN_MS;
			wakeMode    = 'ws';
			wakeSocket();
		} finally {
			// Only the probe that still OWNS the flag may clear it. A stale one
			// finishing late would otherwise report the live one's park as over,
			// and the supervisor would open a second.
			if (wakeProbeGen === gen) wakeProbing = false;
		}
	}

	/// Open the WebSocket. Only ever reached once the probe above has shown there
	/// is a gateway on the other end that speaks this.
	function wakeSocket() {
		if (!wakeWanted()) return;
		if (wakeSock || wakeTimer) return;
		var url;
		try {
			url = (location.protocol === 'https:' ? 'wss://' : 'ws://')
				+ location.host + WS_PATH + '?w=' + encodeURIComponent(WAKE_ID)
				// WHICH DEVICE holds this socket, so a removal can refuse it and evict it
				// (owner ruling 2026-09-12): the socket is the third door a REMOVED device
				// reaches the account by, and without the id the relay would go on pushing
				// parcel versions at it until the socket happened to die. Empty on a device
				// with no identity yet, which upgrades exactly as an older client did.
				+ '&device=' + encodeURIComponent(selfDeviceIdForDoor());
		} catch (e) { wakeMode = 'poll'; wakePoll(); return; }

		var sock, opened = false, gen = wakeGen;
		try { sock = new WebSocket(url); }
		catch (e) { wakeGiveUpOnSockets(); return; }
		wakeSock = sock;
		sock.onopen = function () {
			if (gen !== wakeGen) { try { sock.close(); } catch (e) {} return; }
			opened      = true;
			wakeMode    = 'ws';
			wakeFails   = 0;
			wakeWorked  = true;
			wakeBackoff = WAKE_RETRY_MIN_MS;
			log('wake channel open (ws)');
			// Frames stored while there was no socket were tapped to nobody: read once.
			if (Object.keys(progWatch).length) progressTap();
		};
		sock.onmessage = function (ev) {
			if (gen !== wakeGen) return;
			// `p<seq>`: a progress frame was stored for one of the account's turns. A bare
			// integer is the parcel version, as it always was.
			var d = String(ev.data);
			if (d.charAt(0) === 'p') { progressTapped(); return; }
			var v = parseInt(d, 10);
			if (isFinite(v)) wakeTo(v);
		};
		sock.onerror = function () { /* a close always follows; handled there. */ };
		sock.onclose = function () {
			if (wakeSock === sock) wakeSock = null;
			if (gen !== wakeGen) return;
			if (!opened && !wakeWorked) {
				// Never opened, and none ever has here. Two of these and the front
				// door is not carrying upgrades, whatever the reason, so stop
				// asking it to. A socket that HAS worked on this page is a
				// different story -- the gateway is restarting, or the network
				// went -- and that is waited out, not given up on.
				wakeFails++;
				if (wakeFails >= WAKE_WS_TRIES) { wakeGiveUpOnSockets(); return; }
			}
			// Go back through the plain probe rather than straight at another
			// socket. A refused UPGRADE is the one failure this channel cannot
			// read: the browser hands back a close with no status, so a session
			// that had gone looked exactly like a network that had. This device
			// reconnected on a jittered backoff for four hours and fifty minutes
			// against a gateway answering 401 to every one -- about two hundred
			// and forty refusals an hour, and not one of them said why. The probe
			// is an ordinary request through call(), which takes a fresh session
			// when that is what is wrong and gives up loudly when it cannot.
			if (wakeMode === 'ws') wakeMode = '';
			wakeRetry();
		};
	}

	/// The WebSocket is not going to work here. Park plain requests instead --
	/// same wake, same latency, and nothing between here and the gateway has to
	/// understand anything but HTTP.
	function wakeGiveUpOnSockets() {
		if (wakeMode === 'off') return;
		log('wake channel: no websocket through this front door; parking requests instead');
		wakeMode = 'poll';
		wakePoll();
	}

	/// Come back to the socket after a pause that grows, with jitter on it.
	function wakeRetry() {
		if (wakeTimer || !wakeWanted()) return;
		var wait = Math.min(WAKE_RETRY_MAX_MS, wakeBackoff);
		wakeBackoff = Math.min(WAKE_RETRY_MAX_MS, wakeBackoff * 2);
		var jittered = wait * (0.5 + Math.random());
		wakeTimer = setTimeout(function () { wakeTimer = null; wakeStart(); }, jittered);
	}

	/// Park a request at the gateway naming the version this device holds, and
	/// let it answer when there is a newer one. Loops until the channel is torn
	/// down or the gateway shows it does not park.
	async function wakePoll() {
		var gen = wakeGen;
		// Only a loop of the CURRENT generation stands in the way of another. One
		// left over from a teardown is parked on a request that may not answer for
		// forty-five seconds, and treating that as "a park loop is running" is
		// what left a re-armed channel with nothing parked at all until the
		// supervisor's next tick -- half a minute of a device hearing nothing,
		// measured. See `wakePollGen`.
		if (wakePolling && wakePollGen === gen) return;
		wakePolling = true;
		wakePollGen = gen;
		try {
			while (gen === wakeGen && wakeWanted() && wakeMode === 'poll') {
				var began = Date.now();
				var res;
				// Progress taps are asked for only while something is watched: each one
				// answers the park, so a device watching nothing is not woken by them.
				var prog = wakeProgWanted;
				try {
					// A stale loop stops here rather than sleeping and asking
					// again: the backoff it would grow belongs to the live one.
					if (gen !== wakeGen) break;
					wakeKicked = false;
					res = await call('GET', undefined,
						'?above=' + heardUpTo() + '&ms=' + WAKE_POLL_MS + '&w=' + encodeURIComponent(WAKE_ID)
						+ (prog ? '&prog=1' : ''), { timeoutMs: 0, hold: wakeHold });
				} catch (e) {
					if (gen !== wakeGen) break;
					// Ended on purpose (`setProgressWanted`): park again at once, asking
					// the new question. Anything else is the gateway down or the network
					// gone -- wait, growing, rather than spinning against a closed door.
					if (wakeKicked) {
						wakeKicked = false;
						if (prog && Object.keys(progWatch).length) progressTap();
						continue;
					}
					await wakeSleep(Math.min(WAKE_RETRY_MAX_MS, wakeBackoff) * (0.5 + Math.random()));
					wakeBackoff = Math.min(WAKE_RETRY_MAX_MS, wakeBackoff * 2);
					continue;
				}
				// THE NEWS FIRST, WHATEVER GENERATION HEARD IT -- see wakeProbe.
				// This is the half that made the re-arm cost news rather than just
				// time: the answer to the abandoned park says the mailbox moved,
				// and the loop used to break on the generation two lines above
				// reading it and discard the very thing it had been waiting for.
				if (res.status === 200 && res.json && res.json.waited === true
					&& res.json.changed && wakeWanted()) {
					wakeTo(res.json.version | 0);
				}
				if (res.status === 200 && res.json && res.json.progress === true
					&& gen === wakeGen) {
					progressTapped();
				}
				if (gen !== wakeGen) break;
				if (res.status !== 200) {
					// A refusal, or a 502 from a gateway that is restarting: both
					// temporary, and neither a reason to give the channel up. Wait,
					// growing, and ask again. Turning the channel off here is what a
					// restart used to do to it -- the device went quiet for good over
					// an outage that lasted twenty seconds. A 401 does not reach here
					// on the first go: call() answers it with a fresh session, and
					// only a renewal that failed comes back refused -- at which point
					// `wakeWanted()` is false and the loop below ends rather than
					// parking against a door that is shut.
					await wakeSleep(Math.min(WAKE_RETRY_MAX_MS, wakeBackoff) * (0.5 + Math.random()));
					wakeBackoff = Math.min(WAKE_RETRY_MAX_MS, wakeBackoff * 2);
					continue;
				}
				if (!res.json || res.json.waited !== true) {
					// Answered, and did not park. Either the gateway is too old to
					// know how, or something between here and it dropped the query
					// and served an ordinary pull. That is a property of the road,
					// not of the moment, so this one does end the channel -- one
					// such answer per page load is the whole cost of finding out.
					//
					// AND IT IS THE ONLY DOOR OUT OF THIS CHANNEL THAT DOES NOT
					// COME BACK. Everything else recovers: a socket that had
					// opened and went away is waited out, two that never opened
					// fall through to parking, a 401 takes a fresh session and a
					// 5xx from a restarting gateway backs off and asks again.
					// `wakeMode = 'off'` alone makes `wakeWanted()` false, and
					// with it the supervisor, the retry and `onAuthed`'s own
					// `wakeStart()` all decline -- so nothing but a reload or
					// `wakeVia` re-arms it. That is right for a road that strips
					// queries and wrong for a 200 that was not a park for some
					// passing reason, and the catch-up below is what now bounds
					// the second case at twenty seconds instead of the session.
					//
					// OXEDYNE'S OWN ROAD DOES CARRY IT, checked 2026-08-28 rather
					// than assumed: jarrah's `daimond.oxedyne.com` vhost reaches
					// the gateway through a Steel `proxy_route` on `/api/`, which
					// re-appends the query verbatim on the plain hop and on the
					// upgrade, and tunnels the WebSocket. It is Steel's OTHER
					// shape that would break this -- an `api_route` in proxy mode
					// forwards a configured path and never reads the query at all
					// -- so a front door moved onto one would take every device's
					// channel with it and say nothing.
					log('wake channel: this gateway does not park requests; channel off');
					wakeMode = 'off';
					break;
				}
				wakeBackoff = WAKE_RETRY_MIN_MS;
				// The news itself was acted on above, before the generation was
				// consulted, because it is true of the account either way.
				// However fast that answered, the next one is not immediate.
				var spent = Date.now() - began;
				if (spent < WAKE_POLL_FLOOR_MS) await wakeSleep(WAKE_POLL_FLOOR_MS - spent);
			}
		} finally {
			// Only the loop that still OWNS the flag may clear it, or a stale one
			// finishing late would declare the live one's park over.
			if (wakePollGen === gen) wakePolling = false;
		}
	}

	function wakeSleep(ms) {
		return new Promise(function (r) { setTimeout(r, ms); });
	}

	/// Shut the channel. Everything in flight stands down on the generation
	/// counter, so a loop that is mid-await cannot come back and reopen it.
	function wakeStop() {
		wakeGen++;
		if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; }
		if (wakeSoon)  { clearTimeout(wakeSoon);  wakeSoon  = null; }
		if (wakeSock)  { try { wakeSock.close(); } catch (e) { /* already gone */ } wakeSock = null; }
	}

	/// Is the channel in a position to be told when the mailbox moves?
	///
	/// One rule, one copy: `wake()` reports it and `catchUp()` stands down on it,
	/// and a second copy of it is a second thing to fall out of step with this
	/// one. A park that belongs to a torn-down generation is not this channel
	/// being open, however long the gateway goes on holding it.
	function wakeOpen() {
		return !!(wakeSock && wakeSock.readyState === 1)
			|| (wakePolling && wakePollGen === wakeGen);
	}

	/// Whether a park or a probe of the CURRENT generation is outstanding.
	///
	/// The question the supervisor actually wants answered. A park left over from
	/// a teardown is not the channel doing anything -- it is a request the gateway
	/// has not finished holding -- and counting it as one is what left this device
	/// with no channel, and no complaint, for the length of a park.
	function wakeLive() {
		return (wakePolling && wakePollGen === wakeGen)
			|| (wakeProbing && wakeProbeGen === wakeGen);
	}

	/// Keep the channel matching what the app is doing.
	///
	/// A poll rather than an event, because the two things that end a channel --
	/// locking the identity and logging out of the gateway -- are done in other
	/// files that raise nothing. Ten seconds is far inside a session's life and
	/// costs two boolean reads.
	function wakeWatch() {
		if (wakeWanted()) {
			if (!wakeSock && !wakeTimer && !wakeLive()) wakeStart();
		} else if (wakeSock || wakeTimer || wakeLive()) {
			log('wake channel closing: sync cannot run here just now');
			wakeStop();
		}
	}

	// ── Scheduling ─────────────────────────────────────────────

	/// Push after a quiet period, coalescing rapid triggers into one send.
	function schedule() {
		if (pushTimer) return;
		pushTimer = setTimeout(function () { pushTimer = null; push(); }, PUSH_DEBOUNCE_MS);
	}

	/// Coming back to the window: catch up on what the other device did.
	///
	/// A pull, not a push -- the point is to LEARN something, and the idle and
	/// tab-hidden triggers already cover contributing. Debounced, because one
	/// click into the window raises several of these; and rate-limited, because
	/// alt-tabbing is something people do all afternoon.
	function scheduleFocusPull() {
		if (focusTimer) return;
		focusTimer = setTimeout(function () { focusTimer = null; focusPull(); }, FOCUS_DEBOUNCE_MS);
	}

	/// Re-pull the SAME version, because the last pull read a parcel it could not
	/// fully merge and so did not adopt it. On a backoff, and bounded: a section
	/// that will never merge (a malformed parcel) must not become a hot loop, so
	/// after `REAPPLY_MAX_TRIES` the auto-retry stands down -- the version stays
	/// un-adopted and the ordinary triggers go on trying, but this stops arming.
	/// See the re-apply notes at the top of the file.
	function scheduleReapply() {
		if (reapplyTimer) return;				// one already coming.
		if (reapplyTries >= REAPPLY_MAX_TRIES) {
			diag('re-pull GAVE UP', 'after ' + reapplyTries + ' tries; version left un-adopted');
			log('re-apply: gave up auto-retrying after', reapplyTries,
				'tries; version left un-adopted, ordinary triggers will retry');
			// Owed work is not left behind with it (S3): the owed retry takes it over.
			if (unsent) armUnsent('merge');
			return;
		}
		var grow = Math.min(REAPPLY_MAX_MS, REAPPLY_BASE_MS * Math.pow(2, reapplyTries));
		reapplyTries++;
		var wait = Math.round(grow * (0.5 + Math.random()));
		// THE RE-PULL LOOP, made obvious: the try counter and the interval, so a
		// section that keeps failing on iOS shows here as a rising count at a
		// widening interval -- the churn the owner reports, paired with the
		// 'pull merge FAILED sections=...' line that says WHICH section.
		diag('re-pull armed', 'try=' + reapplyTries + '/' + REAPPLY_MAX_TRIES + ' in ' + wait + 'ms');
		// Jittered, for the same reason the conflict backoff is: several devices that
		// all failed the same parcel must not re-pull in the same millisecond.
		reapplyTimer = setTimeout(function () {
			reapplyTimer = null;
			reapplyPull();
		}, wait);
	}

	/// A clean apply (or an adopted version) settled it: forget the backoff and
	/// disarm any pending re-pull.
	function reapplyDone() {
		if (reapplyTries > 0) diag('re-pull settled', 'after ' + reapplyTries + ' tries');
		reapplyTries = 0;
		if (reapplyTimer) { clearTimeout(reapplyTimer); reapplyTimer = null; }
	}

	async function reapplyPull() {
		if (!ready()) { reapplyDone(); return; }
		if (inFlight) { scheduleReapply(); return; }	// a round is running; re-arm, do not drop.
		inFlight = true;
		try { await pull(); }				// success clears the backoff; another failure re-arms it.
		finally { endRound(); }
	}

	async function focusPull() {
		if (!ready()) return;
		if (inFlight) return;			// a round is already under way; it is fresher than ours
		if (Date.now() - lastFocusPull < FOCUS_PULL_MIN_MS) return;
		lastFocusPull = Date.now();
		// Held for the duration, so a push arriving mid-pull waits its turn rather
		// than sending state that is halfway through being replaced.
		inFlight = true;
		try { await pull(); }
		finally { endRound(); }
	}

	/// Coming back to a tab that was backgrounded, by whichever signal fired --
	/// `visibilitychange`→visible, `focus`, or `pageshow`.
	///
	/// THE SAFE HALF OF THE SEQ-227 RE-OPEN. A hand-off finished on another device
	/// while this phone was backgrounded; on re-open the wire is fast, but the phone
	/// did not ASK until the rigid 45s wake tick, because an iOS-frozen wake park
	/// still reports itself live. The seq-228 version of this fix fired a BURST of
	/// immediate pulls (immediate + a 300ms retry + a wake re-arm), each ending in a
	/// renderHistory full rebuild that wrote scrollTop mid-scroll -- the transcript
	/// shook -- and it aborted the dispatch PUSH on resume, so a new chat's hand-off
	/// never reached peers. It was reverted for both.
	///
	/// This is the version that keeps neither fault. It breaks a FROZEN PULL (a GET
	/// only, never a push), re-arms the wake channel, and then pulls through the ONE
	/// throttled focus path -- a single coalesced pull, never a burst -- so the pull's
	/// re-render is the ordinary scroll-anchored one. An alt-tab glance keeps the
	/// plain focus pull, so the normal foreground cadence is untouched.
	function onResume(why, persisted) {
		if (!started) return;
		var now = Date.now();
		var hid = hiddenAt;			// captured before it is cleared below.
		hiddenAt = 0;
		// The initial `pageshow` of a fresh load is not a resume: nothing was hidden
		// and the boot path already pulls. Only a bfcache restore (`persisted`) or a
		// tab that had actually gone away is.
		if (why === 'pageshow' && !persisted && !hid) return;
		var hiddenMs = hid ? (now - hid) : 0;
		// A genuine re-open, as opposed to an alt-tab glance: a bfcache restore, or a
		// spell in the background long enough that the wake park is probably frozen.
		var reopen = persisted || (hiddenMs >= RESUME_MIN_HIDDEN_MS);
		diag('resume', 'why=' + why + (persisted ? ' bfcache' : '')
			+ ' hidden=' + (hid ? hiddenMs + 'ms' : 'n')
			+ (reopen ? ' reopen' : ' glance'));
		if (!reopen) { scheduleFocusPull(); return; }		// glance: ordinary cadence.
		// Break a PULL iOS froze on the backgrounded socket, so the gate frees now
		// rather than at the 18s budget. A push is never tracked here, so this can
		// only ever abort a GET -- never the user's work in flight, which ends only
		// at its own deadline and is then owed.
		if (pullAbort) { try { pullAbort.abort(); } catch (e) {} pullAbort = null; }
		// Re-arm the channel rather than trust it: an iOS-frozen park is replaced,
		// which closes the `wakeLive()===true`-but-dead gap catchUp falls into.
		try { wakeStop(); wakeStart(); } catch (e) { /* channel not wanted here */ }
		// Pull PROMPTLY, but through the one throttled focus path: clear the focus
		// throttle so the coalesced pull fires at once (a real return is long past the
		// throttle window anyway), then schedule it. One pull, one scroll-safe render.
		lastFocusPull = 0;
		scheduleFocusPull();
	}

	/// The in-flight poll, live only while a hand-off is out and this device is
	/// watching for its answer (see `expedite`). It pulls at EXPEDITE_PULL_MS rather
	/// than wait out the 45s wake tick -- the net for a backgrounded iOS tab whose
	/// wake park iOS has frozen. Throttled against the last pull of ANY kind, so where
	/// the wake channel IS delivering the runner's progress pushes it mostly stands
	/// down; where the park is dead, it is the thing that asks.
	async function expeditePull() {
		if (!expediting) return;
		if (!ready() || !entitled) return;
		// A hand-off outstanding past EXPEDITE_MAX_MS is stuck, not live: stand the full-
		// parcel poll down (the wake tick and the recovery backstop carry it) rather than
		// pull 1.4 MB every 4 s for ever. The flag stays on so a fresh hand-off arriving
		// re-arms the window through setExpedite's rising edge.
		if (expediteSince && Date.now() - expediteSince > EXPEDITE_MAX_MS) return;
		if (inFlight) return;			// a round is running, and it is fresher than this one
		if (Date.now() - lastPullAt < EXPEDITE_PULL_MS) return;	// the channel already asked
		inFlight = true;
		try { await pull(); }
		finally { endRound(); }
	}

	/// Turn the in-flight poll on or off. daimond.js calls this as a hand-off's
	/// dispatched placeholder appears and clears, so the watching devices pull
	/// promptly for the length of the hand-off and are quiet the rest of the time.
	function setExpedite(on) {
		on = !!on;
		if (on === expediting) return;
		expediting = on;
		if (on) {
			expediteSince = Date.now();		// the rising edge: a fresh window for EXPEDITE_MAX_MS
			if (!expediteTimer) expediteTimer = setInterval(expeditePull, EXPEDITE_PULL_MS);
			// Ask once now rather than wait a whole tick: the hand-off just went out.
			expeditePull();
		} else {
			expediteSince = 0;
			if (expediteTimer) {
				clearInterval(expediteTimer);
				expediteTimer = null;
			}
		}
	}

	/// Ask the gateway what it is holding, on a device nothing else will prompt.
	///
	/// Measured against the last pull of ANY kind rather than against its own last
	/// go -- the same rule the idle branch of `push()` keeps, and for the same
	/// reason: a device that pulled a second ago because its window was focused
	/// has nothing to learn from asking again, and a second reason to ask is not a
	/// second thing to know.
	async function catchUp() {
		if (!ready() || !entitled) return;
		if (wakeShut) return;			// somebody asked this device to be quiet
		// The gateway will say. Asking as well only spends the account's money on
		// news it is already going to be given.
		if (wakeOpen() || wakeLive()) return;
		if (inFlight) return;			// a round is running, and it is fresher than this one
		if (Date.now() - lastPullAt < CATCHUP_MS) return;
		// Held for the duration, exactly as the focus pull holds it, so a push
		// arriving mid-pull waits its turn rather than sending state that is
		// halfway through being replaced.
		inFlight = true;
		try { await pull(); }
		finally { endRound(); }
	}

	/// A stored thing changed outside a turn: push it soon.
	///
	/// The two triggers above are a turn ENDING and the tab going AWAY, and most
	/// of what a person does to a Diamond is neither. Renaming one, tagging it,
	/// linking it, editing its crystal by hand, deleting it — none of those take
	/// a turn, so a user who renamed a Diamond and then left the tab open and
	/// focused scheduled no push at all, and the other device's focus pull found
	/// nothing to fetch. The rename simply never travelled.
	///
	/// It rides the same debounce as every other trigger, so a burst of edits
	/// leaves as one parcel, and it costs nothing when there is nothing to send:
	/// an unchanged parcel is already skipped before any request is made.
	///
	/// Dropped outright when the engine could not push anyway — no identity, no
	/// session, or a standing 402 — rather than arming a timer to find that out.
	/// A stall (413) is NOT in that list: the nudge after the user shrinks
	/// whatever would not fit is exactly the push that clears it.
	function nudge() {
		if (!ready() || !entitled) return;
		schedule();
	}

	// ── Surviving a passphrase change ──────────────────────────
	//
	// THE PARCEL IS SEALED AT REST TOO, so this file takes part — but it is the
	// one participant with nothing to read out and nothing to hold. The blob is
	// built from live state on every push (`collectParcel` + `JSON.stringify`), so
	// it is a DERIVED COPY: there is no secret here that exists only in the
	// ciphertext, and re-sealing it means nothing more than sending it again.
	//
	// Sending it again is not automatic, which is why this is a participant and
	// not an exemption. `push()` skips a parcel identical to the one it last sent
	// — and a passphrase change does not change the parcel, only the key it goes
	// under. So without this the blob in the mailbox stays sealed under a key
	// nobody has any more: the account's cloud copy is dead, silently, until some
	// unrelated edit happens to change the state. Forgetting what was last pushed
	// is the whole of the fix, and the next round re-seals it.
	//
	// The old defect this once could not touch -- a SECOND device still on the old
	// passphrase reading this blob as corruption, adopting its version and pushing its
	// own over the top, the two clobbering each other for ever -- is now closed by the
	// epoch chain: the record rides beside the blob (wrapEnvelope), the lagging device
	// adopts the change from it (pullOnce's re>le branch) rather than treating it as a
	// bad blob, and a same-epoch divergence is settled by the deterministic yield (D2).
	// This participation's part in that is only to make sure the resealed blob is sent
	// again, below; the anti-fork logic itself lives in pullOnce.

	/// Re-seal the mailbox copy: forget what was last sent, so the next push
	/// genuinely sends, and ask for that push.
	function resealAfterRekey() {
		lastPushed = null;
		// On disk as well. The blob in the mailbox is sealed under a key nobody
		// has any more, and a digest that survived the reload would have the next
		// page agree there was nothing to send -- leaving the account's cloud copy
		// dead and silent, which is the whole failure this participation exists to
		// prevent.
		saveSig('');
		schedule();
		return { failed: [] };
	}

	if (window.DaimondRekey) {
		DaimondRekey.register({
			name:   'sync',
			reseal: resealAfterRekey,
		});
	}

	function saveVersion() {
		try { localStorage.setItem(K_VERSION, String(serverVersion)); } catch (e) { /* ignore */ }
	}

	/// Take the version a pull read off the mailbox, unless a push moved the cursor
	/// on WHILE that read was in flight.
	///
	/// `serverVersion` is one cursor and both the pull and the push mutate it. A
	/// pull reads the mailbox, then merges what it found -- the heaviest step the
	/// app has -- and only then writes the version it saw. A push that lands in
	/// that gap sets the cursor to the newer version first; the pull then overwrites
	/// it with the OLDER one it read before the push existed. The device's own
	/// just-sent work is then reported as never sent, its version a step behind the
	/// mailbox -- a lost update, and under load it is what left a renewed session's
	/// push looking like it never landed.
	///
	/// The refusal is narrow. A downgrade is dropped ONLY when a push actually
	/// advanced the cursor during this read (`serverVersion > preRead`); a reset
	/// lowers the version with no push behind it, so `preRead` still equals the
	/// cursor and the lower version is taken as it must be.
	function adoptVersion(v, preRead) {
		// Whatever this adopts, the mailbox was read and taken, so no version is left
		// over for the re-pull: it merged, the mailbox moved on past it, or the mailbox
		// was reset below it. Cleared before the race check, which only keeps the push's
		// newer cursor.
		failedVersion = 0;
		if (v < serverVersion && serverVersion > preRead) return;	// a stale read raced a push; keep the push's cursor.
		serverVersion = v;
		saveVersion();
	}
	function loadVersion() {
		serverVersion = parseInt(localStorage.getItem(K_VERSION) || '0', 10) || 0;
		lastSynced    = parseInt(localStorage.getItem(K_LAST) || '0', 10) || 0;
		loadSig();
	}

	// ── The carried fixed point ────────────────────────────────
	//
	// EVERY PATH HERE FAILS TOWARDS SENDING, and that is the whole rule. A digest
	// that cannot be taken, cannot be read, or was written by a build that did not
	// mean this one reads as '' -- no fixed point -- and '' never matches, so the
	// parcel goes. Sending one that was not needed costs bytes, which is the
	// behaviour this replaces; skipping one that WAS needed leaves the user's work
	// on this device with nothing anywhere saying so.
	//
	// AND IT IS READ BY THE PUSH AND BY NOTHING ELSE. `pullOnce` fetches and merges
	// unconditionally and must go on doing so: a device that consulted a stored
	// fixed point before deciding whether to LOOK would conclude it need not, and
	// sit on its own stale copy while another device's work waited in the mailbox.
	// That failure was hypothesised and disproved on 2026-08-27; it must not be
	// introduced by the cure for a different one.

	/// The digest of a parcel's comparison key, or '' where one could not be taken.
	///
	/// `DaimondCloud.sha256` rather than a fourth copy of six lines that already
	/// exist in cloud.js and chunks.js. A build without cloud.js therefore carries
	/// no fixed point and pushes on every reload, which is what this file did
	/// before there was one.
	async function sigOf(plain) {
		try {
			if (!window.DaimondCloud || !DaimondCloud.sha256) return '';
			return await DaimondCloud.sha256(plain);
		} catch (e) { log('could not digest the parcel', e); return ''; }
	}

	/// Write the carried fixed point down, or clear it when given ''.
	function saveSig(sig) {
		bootSig = sig || '';
		try {
			if (bootSig) localStorage.setItem(K_SIG, JSON.stringify({ v: SIG_V, sig: bootSig }));
			else localStorage.removeItem(K_SIG);
		} catch (e) { /* private mode: this page keeps its own copy and that is all */ }
	}

	/// Take up the one a previous page left, if it is one this build wrote.
	function loadSig() {
		bootSig = '';
		try {
			var raw = localStorage.getItem(K_SIG);
			if (!raw) return;
			var rec = JSON.parse(raw);
			if (!rec || rec.v !== SIG_V || typeof rec.sig !== 'string') return;
			bootSig = rec.sig;
		} catch (e) { /* unreadable is the same as absent, and absent sends */ }
	}

	// ── Lifecycle ──────────────────────────────────────────────

	/// First reconcile once a session exists: pull the other devices' work,
	/// then push this device's, so a returning device both catches up and
	/// contributes in one pass.
	async function onAuthed() {
		if (!ready()) return;
		entitled    = true;			// a fresh session may have just bought the tier.
		sessionGone = false;		// and there is demonstrably a session again.
		loadVersion();
		await pull();
		schedule();					// push whatever this device adds over the pulled base.
		// And open the channel that means the next catch-up needs no trigger here
		// at all. After the first pull, so it parks on a version this device has
		// actually reconciled rather than on a stale cursor.
		wakeStart();
	}

	function start() {
		if (started) return;
		started = true;
		// Begin loading the cloud index out of IndexedDB (and migrating it off the
		// localStorage box) now, so a device at quota is relieved before its first
		// round rather than waiting on it. The sync entry points await this too.
		if (window.DaimondCloud && DaimondCloud.ready) { try { DaimondCloud.ready(); } catch (e) { /* awaited again at pull/push */ } }
		loadVersion();
		// The row is in the markup and empty until something writes to it, and on a
		// device that never syncs nothing ever would: the honest admission that
		// nothing has travelled is itself the answer.
		//
		// The chip is built HERE rather than on the first status it has to report.
		// It cost nothing to defer while it was injecting a stylesheet and finding
		// a place in the top bar; now that it has a row waiting for it, deferring
		// only means a device that never reaches a gateway has no `#sync-chip` in
		// the DOM at all -- and `dev/verify_sweep_seen.mjs` says in as many words
		// that it could not test the one element the owner actually reported,
		// because a world with no gateway never holds one.
		statusChip();
		paintRest(true);
		// Before anything this session pulls: a cursor that is already here can
		// only have been left by this device reading this account's mailbox on an
		// earlier visit. See `knownDevice`.
		knownDevice = serverVersion > 0;
		// The app settling (a turn or agent run just ended) is the moment to
		// push: state is consistent and the user is between actions.
		window.addEventListener('daimond:idle', schedule);
		// Leaving the tab is a natural save point; coming back to it is a natural
		// moment to catch up. The one listener covers both directions: hiding stamps
		// `hiddenAt` (so a return can tell a re-open from a glance) and schedules the
		// save; returning goes through onResume, which pulls promptly on a genuine
		// re-open and keeps the plain throttled focus pull for an alt-tab glance.
		document.addEventListener('visibilitychange', function () {
			if (document.hidden) { hiddenAt = Date.now(); schedule(); }
			else onResume('visible');
		});
		window.addEventListener('focus', scheduleFocusPull);
		// iOS wakes a backgrounded tab through `pageshow`, not always a clean
		// `visibilitychange`, and a bfcache restore ONLY raises `pageshow`. Route it
		// through the same safe resume.
		window.addEventListener('pageshow', function (e) {
			onResume('pageshow', !!(e && e.persisted));
		});
		// Pausing something is a change to what this account may spend, and nothing
		// else here would notice one: it ends no turn, touches no Diamond and
		// leaves the tab where it was. It only announces on a REAL move -- `set`
		// returns false and stays quiet when the set is unchanged, and so does an
		// `adopt` that took nothing new -- so a pull that agreed with us schedules
		// no push, which is what stops the two devices telling each other.
		try { if (window.DaimondPause) DaimondPause.subscribe(nudge); }
		catch (e) { /* no pause module in this build */ }
		// A session becoming available (unlock → gateway bootstrap) starts it all.
		// The handle is asked for separately, and on the event rather than inside
		// `onAuthed`: that path returns early without the sync tier, and an
		// account without Pro still has a name.
		window.addEventListener('daimond:authed', function () { askHandle(); onAuthed(); });
		// The channel is torn down when the page goes, so the gateway is not left
		// holding a socket for a tab that has closed. `pagehide` and not `unload`:
		// a page restored from the back/forward cache raises `pageshow`, and the
		// supervisor opens it again on its next tick.
		window.addEventListener('pagehide', function () { hiddenAt = Date.now(); wakeStop(); });
		// Owed work waits out an offline spell rather than retrying into it. See onOnline.
		window.addEventListener('online', onOnline);
		// Keep the channel matching the app. See wakeWatch.
		wakeWatcher = setInterval(wakeWatch, WAKE_WATCH_MS);
		// And the one trigger that needs neither this device nor the gateway to
		// raise anything. See catchUp: it stands down whenever the channel is
		// carrying, which on a device that can reach the gateway is always.
		catchupTimer = setInterval(catchUp, CATCHUP_TICK_MS);
		// If we booted already authed (a returning unlocked tab), reconcile now.
		if (ready()) onAuthed();
		askHandle();
		// A safe start reaches nothing that would paint the chip -- `ready()` is
		// false, so every path above returns before `restStatus`. Say it here, or
		// the one state the user has to be told about is the one state that never
		// appears. Deferred a tick because the rail's status strip is built by
		// daimond.js.
		if (window.DaimondSafe && DaimondSafe.on()) setTimeout(restStatus, 0);
		log('started');
	}

	// ── Public surface ─────────────────────────────────────────
	/// Re-enable sync after a tier change -- a Pro purchase just landed -- and
	/// reconcile at once. A 402 earlier set `entitled = false` and stopped the
	/// pushes; this lifts that without waiting for the next unlock.
	function recheck() {
		if (!ready()) return;
		entitled = true;
		onAuthed();
	}

	window.DaimondSync = {
		pull:    gatedPull,
		/// Has a pull run this session -- landed, found nothing, or failed on the wire?
		/// The same once-per-boot fact `daimond:pulled` announces, for a caller that
		/// arrives after it fired.
		pulled:  function () { return announcedPull; },
		push:    function () { return push(); },
		/// Push and CONFIRM the current parcel is committed, answering the version it
		/// committed at -- `{ ok, version, why? }`. Used by the hand-off dispatcher so
		/// the errand's parcelVersion genuinely contains the chat it just added.
		flush:   flush,
		/// Stream one frame of a running turn to the mailbox. The runner of a
		/// dispatched turn calls this on a throttled timer (peer.js runErrand) so peers
		/// watching the hand-off see the transcript grow rather than a blank wait. The
		/// SAME account parcel under compare-and-set -- no new turn, no new lease, no
		/// second charge. See pushProgress.
		pushProgress: pushProgress,
		/// The streaming progress door, off the content parcel: `pushProgressFrame(turnId,
		/// tail, final)` PUTs one small sealed frame of a running turn's rendered tail,
		/// and `watchProgress(key, onFrame)` follows a turn's frames as the wake channel
		/// taps them, until `unwatchProgress(key)`. This is what streams a hand-off; the
		/// whole parcel travels only at the turn's end. `final` says the turn has ENDED
		/// and this tail is the whole of it, so a watcher can show the finished answer
		/// without the account parcel.
		pushProgressFrame: pushProgressFrame,
		watchProgress:     watchProgress,
		unwatchProgress:   unwatchProgress,
		progressWatched:   progressWatched,
		/// Turn the in-flight poll on/off. daimond.js calls `expedite(true)` while a
		/// hand-off's dispatched placeholder is outstanding and `expedite(false)` when
		/// it clears, so the watching devices pull promptly (EXPEDITE_PULL_MS) for the
		/// length of the hand-off instead of waiting out the 45s wake tick.
		expedite: setExpedite,
		nudge:   nudge,
		recheck: recheck,
		/// What the chip stands at, in one word, for the rail's one-line summary; see
		/// `chipState`. `daimond:sync-chip` fires when it changes.
		///
		/// IT WAS A SECOND `state` KEY in this literal (D072). The later `state`, the
		/// engine's facts as an object, silently replaced it, so the rail's summary was
		/// handed an object, matched none of its words and said "This device only"
		/// through every stall (P1a M7, 2026-09-25).
		chip: chipState,
		/// The presence path, off the content parcel: `beatPresence(deviceId, name)`
		/// writes this device's last_seen and adopts the account's fresh map (bumping
		/// no version and waking nobody); `refreshPresence()` reads that map without a
		/// beat, for a dispatch-time refresh. Both ingest through DaimondPresence.
		beatPresence:    beatPresence,
		refreshPresence: refreshPresence,
		/// REAL REMOVAL (owner ruling 2026-09-12). `removeDevice(id)` tells the gateway
		/// to refuse that device at every door it reaches the account by -- presence,
		/// the post-box park, the wake relay -- so a removal is a revocation of the
		/// device's SEAT rather than a line off a list. `removedSelf()` is whether THIS
		/// device has been told it is removed, so a caller can stop asking;
		/// `daimond:device-removed` fires once when it first is.
		removeDevice:    removeDeviceRemote,
		removedSelf:     removedSelf,
		/// The lease door, off the content parcel: `leaseGet()` reads the door's
		/// {version, leases}; `leaseCommit(base, proposed)` compare-and-sets it. The
		/// peer lease CAS (daimond.js peerSyncShim) binds to these, and `leaseVersion`
		/// is the last version seen, for the CAS's synchronous fallback getter.
		leaseGet:     leaseGet,
		leaseCommit:  leaseCommit,
		leaseVersion: function () { return _leaseVer | 0; },
		/// The pure arithmetic this file decides things with, for the one test that
		/// can measure it: `www/js/synckey.test.mjs`. The push-skip's comparison key,
		/// the UTF-8 scan, the wire estimate, the section census and the door they
		/// are all measured against. Reached by nothing in the app.
		forTest: {
			compareKey:  compareKey,
			utf8Len:     utf8Len,
			wireBytes:   wireBytes,
			parcelSizes: parcelSizes,
			door:        WIRE_DOOR_BYTES,
		},
		/// Exactly what a push would send, and exactly what a pull would merge.
		///
		/// A verifier comparing `DaimondCore.collectSync()` is comparing the core
		/// parcel only, and would miss anything hung on it here -- so the fixed
		/// point has to be measured through these two rather than around them.
		parcel:  function () { return collectParcel(); },
		apply:   function (state) { return applyParcel(state); },
		/// The account's public handle, and the three things anyone does with
		/// it. `handle()` is what this device knows; `refreshHandle()` asks the
		/// gateway, which mints one if the account has none; `claimHandle()`
		/// renames, and says which kind of no it got; `lookupHandle()` resolves
		/// somebody ELSE's name, which is the half that makes it a public name
		/// rather than a label.
		handle:        function () {
			try { return DaimondIdentity.handle(); } catch (e) { return ''; }
		},
		refreshHandle: refreshHandle,
		claimHandle:   claimHandle,
		lookupHandle:  lookupHandle,
		/// Publish this device's card, given what the gateway is serving.
		/// Published so a verifier can drive the same door `refreshHandle` uses.
		publishCard:   publishCard,
		version: function () { return serverVersion; },
		entitled: function () { return entitled; },
		/// The wake channel, as it stands. Nothing in the app turns on this; it
		/// is what a verifier reads to tell "converged because it was told" from
		/// "converged because something happened to the window".
		wake:    function () {
			return {
				mode:      wakeMode,				// '' | 'ws' | 'poll' | 'off'
				id:        WAKE_ID,
				// A park that belongs to a torn-down generation is not this
				// channel being open, however long the gateway goes on holding
				// it -- reporting it as open is how a device with no live park
				// looked exactly like one that had just made a fresh one.
				open:      wakeOpen(),
				probing:   wakeProbing && wakeProbeGen === wakeGen,
				heard:     wakeTarget,				// highest version the channel reported
				wakes:     wakes,					// pulls this channel has caused
				progTaps:  progTaps,				// progress taps it has carried
				progTapped: progTapGen === wakeGen,	// the gateway has tapped this channel
			};
		},
		/// Force the channel onto one transport, or shut it.
		///
		/// `'poll'` parks plain requests, so the fallback can be seen working
		/// rather than waited for; `'off'` puts this device back to what it was
		/// before there was a channel at all, which is what a test asserts the
		/// absence of convergence against; anything else starts over with the
		/// socket.
		wakeVia: function (mode) {
			wakeStop();
			wakeMode    = (mode === 'poll' || mode === 'off') ? mode : '';
			// 'off' here is a request, not a diagnosis, so the catch-up honours it:
			// this verb is what a test asserts the absence of convergence against,
			// and a timer that went on asking would answer that test itself.
			wakeShut    = wakeMode === 'off';
			wakeFails   = 0;
			wakeWorked  = false;
			wakeBackoff = WAKE_RETRY_MIN_MS;
			if (wakeMode !== 'off') wakeStart();
			return wakeMode;
		},
		/// What the engine would say if asked -- the same facts the chip shows, for
		/// anything that needs them in words rather than as a coloured pill.
		state:   function () {
			return {
				// Anything standing between this device's work and the mailbox: a
				// parcel that will not fit, a session that has gone, or a reconcile
				// that gave up. Ordered as the chip orders them, so what this says
				// and what the chip shows can never disagree.
				stalled:      tooLarge || sessionGone || rekeyBehind || !!jammed || owedNow(),
				stalledWhy:   tooLarge ? 'too_big'
					: (sessionGone ? 'signed_out'
						: (rekeyBehind ? 'rekey'
							: (jammed || (owedNow() ? 'unsent' : '')))),
				/// A passphrase was changed elsewhere and this device is too far behind
				/// the epoch chain to catch up on its own; it must be linked again.
				rekeyBehind:  rekeyBehind,
				failedParts:  lastFailed.slice(),
				entitled:     entitled,
				/// Whether a 401 is standing that a fresh session could not clear.
				sessionGone:  sessionGone,
				lastSyncedAt: lastSynced,
				lastSynced:   lastSyncedLine(),
				version:      serverVersion,
				/// Is the engine doing nothing, and is nothing armed to start?
				///
				/// `inFlight` alone is not the question. A round that has FINISHED may have
				/// left a debounce armed, and a caller that waited only for the flag to drop
				/// would go on to act in the gap before the timer fires. All three, so "quiet"
				/// means no round is running and none is coming.
				///
				/// Nothing in the app reads this; it is here for the same reason `wake()` is,
				/// and for a defect it fixes. `dev/verify_mailfolders.mjs` deletes a mailbox
				/// behind the app's back and pushes a census that no longer names it. If a
				/// pull was already in flight when it did, that pull adopts the mail back
				/// AFTER the fixture has checked -- correctly, since a file present at the
				/// gateway and absent here is one this device has not seen. The fixture read
				/// its own success and the run then measured the PREVIOUS run's mail. It cost
				/// two failures in eight cold runs on 2026-08-24, each blamed on the product.
				/// Waiting for this removes the race; polling for the mailbox to stay gone
				/// only narrows it.
				quiet:        !inFlight && !pushTimer && !focusTimer && !reapplyTimer,
				busyWith:     inFlight ? 'a round is running'
					: (pushTimer ? 'a push is armed'
						: (focusTimer ? 'a focus pull is armed'
							: (reapplyTimer ? 're-applying a version that would not merge' : ''))),
			};
		},
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	} else {
		start();
	}
})();
