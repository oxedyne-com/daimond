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
   a SORTED list and a stamp that moves only when the set does --
   which is the whole of what keeps two collects byte-identical, and
   the reason nothing in this file may stamp on the way in.

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
	// after this frees the gate whether or not the socket ever answers. THIS IS
	// PULL-ONLY. A push is NEVER given a signal and NEVER aborted -- a cancelled
	// POST is a piece of the user's work that silently did not travel, which is the
	// seq-228 hand-off-non-delivery regression this file was reverted for. The wake
	// poll parks far longer on purpose and passes its own budget; see wakePoll.
	var PULL_TIMEOUT_MS = 18000;
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
	// ── The streaming progress push ────────────────────────────
	// The minimum spacing between a runner's progress pushes, so a long turn streams
	// as a trickle rather than a flood. Between ~1.5-3s per the streaming design: a
	// peer watching a hand-off sees the thinking and the tool calls appear as the
	// runner produces them, instead of a blank wait until the turn finishes. See
	// pushProgress; the runner's own timer lives in peer.js runErrand.
	var PROGRESS_PUSH_MIN_MS = 1800;
	// The most a single frame may carry, in characters of PLAINTEXT tail. The
	// gateway's own ceiling is 64 KiB of ciphertext and it refuses a frame over it
	// (413, naming the ceiling); this keeps the ordinary frame comfortably under,
	// so the refusal path is for a surprise and not for every long turn. A tail is
	// the END of the transcript, so trimming it loses the oldest lines, which the
	// watching device already has from the frame before.
	var PROGRESS_TAIL_MAX = 48 * 1024;
	// How long a watching device asks the progress door to hold its read. The frame
	// then arrives within a moment of being stored rather than at the next poll, and
	// the gateway clamps this to its own maximum anyway.
	var PROGRESS_WAIT_MS  = 25000;
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
	// The AbortController of a content PULL in flight, so a resume can break a frozen
	// GET at once rather than wait out its budget. Set by `call` ONLY when the caller
	// asks (the content pull does; the push NEVER does). Read by onResume. A push is
	// never registered here, so a resume can never cancel one.
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
	/// # Arguments
	/// * `xtra` - `{ timeoutMs, track }`, and BOTH are for a PULL alone. `timeoutMs`
	///            bounds a GET iOS may have suspended on a backgrounded socket, so its
	///            `finally` frees the gate whether or not the socket ever answers (0 or
	///            absent disables it -- the wake poll parks far longer and passes its
	///            own). `track` registers the GET's controller as `pullAbort` so a
	///            resume can break it at once. A POST passes NEITHER: a push is never
	///            given a signal and never aborted, because a cancelled POST is the
	///            user's work silently not travelling -- the seq-228 regression. The
	///            two callers that set these are the content pull and nothing else.
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
		// Bound and track a PULL, never a push. `method === 'GET'` is the belt to the
		// braces of "only the pull passes xtra": even if a POST caller ever passed one,
		// no signal is attached to it here, so a push cannot be aborted by any path.
		var ac = null, timer = null;
		var budget = (xtra.timeoutMs !== undefined) ? xtra.timeoutMs : PULL_TIMEOUT_MS;
		if (method === 'GET' && (xtra.timeoutMs !== undefined || xtra.track)) {
			try { ac = new AbortController(); } catch (e) { ac = null; }
			if (ac) {
				opts.signal = ac.signal;
				if (budget > 0) timer = setTimeout(function () { try { ac.abort(); } catch (e) {} }, budget);
				if (xtra.track) pullAbort = ac;
			}
		}
		try {
			var r = await DaimondGateway.gwFetch(PATH + (query || ''), opts);
			if (r.status === 426) return { status: 426, json: null };
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
		}
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

	/// Look up somebody else's handle. `{found, handle, fingerprint}`.
	///
	/// The half that makes a handle worth having: a name is only a name if
	/// somebody other than its owner can resolve it. Nothing in the app calls
	/// this yet -- sharing and ratings are the callers it is waiting for -- and
	/// it is here rather than deferred so that what those features need already
	/// exists and has been proved to work.
	async function lookupHandle(wanted) {
		if (!handleReady()) return { found: false };
		var q = '?handle=' + encodeURIComponent(String(wanted || ''));
		var r = await accountCall('GET', undefined, q);
		var j = r.json || {};
		if (r.status !== 200 || !j.ok || !j.found) return { found: false };
		return { found: true, handle: j.handle || '', fingerprint: j.fingerprint || '' };
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

	function setStatus(state, text, holdMs, title) {
		var c = statusChip();
		if (!c) return;
		if (_statusTimer) { clearTimeout(_statusTimer); _statusTimer = null; }
		// `style.display` still carries "is the chip saying anything", because that
		// is what six verifiers read and what `restStatus` means by an empty state.
		// What is new is the other half of the row taking over when it is not.
		if (!state) { c.style.display = 'none'; paintRest(true); return; }
		paintRest(false);
		c.dataset.state = state;
		c.querySelector('.stext').textContent = text;
		// The hover text always ends with when a sync last worked. On a stall that
		// is the most useful sentence there is -- "paused" means nothing without
		// knowing whether the last good sync was a minute or a fortnight ago -- and
		// on a good one it costs a line nobody has to read.
		c.title = [title || '', lastSyncedLine()].filter(Boolean).join('\n');
		c.style.display = 'flex';
		if (holdMs) _statusTimer = setTimeout(function () {
			c.style.display = 'none';
			paintRest(true);
		}, holdMs);
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
	function jam(why) {
		jammed = why;
		restStatus();
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
		// And above nothing at all: a jam is this round's failure rather than a
		// state of this device, so all three standing refusals outrank it.
		if (jammed)        { setStatus('stalled', t('sync.paused'), 0, jamReason()); return; }
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
	/// push" -- the parcel with this device's OWN `seen` stamp masked out. What is
	/// SENT is always the parcel itself; only the comparison reads this.
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
	/// whole point of having one. A build whose core cannot name this device falls
	/// back to the parcel, which is the behaviour this replaces.
	function compareKey(state) {
		var plain = JSON.stringify(state);
		var id = '';
		try {
			if (DaimondCore.syncSelfDeviceId) id = String(DaimondCore.syncSelfDeviceId() || '');
		} catch (e) { id = ''; }
		if (!id || !state || !state.devices || !state.devices[id]) return plain;
		var src = state.devices, devs = {};
		Object.keys(src).forEach(function (k) {
			if (k !== id) { devs[k] = src[k]; return; }
			var line = src[k] || {}, copy = {};
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
		var b64    = 4 * Math.ceil(sealed / 3);
		var env    = utf8Len(JSON.stringify(
			{ base_version: serverVersion, device: deviceLabel(), blob: '', w: WAKE_ID }));
		return env + b64;
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
		try { return await pullOnce(quiet); }
		finally { notePulled(); }
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
		// budget (freeing the gate) or the instant a resume breaks it. PULL ONLY -- the
		// push below is never given a signal.
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
		try {
			// The size of what arrived, before it is opened. Three forms of this
			// pass through in a moment -- the sealed blob, the plain text, and the
			// object graph `JSON.parse` builds from it -- but each is released as
			// soon as the next exists (see below), so no more than two are ever
			// live at once and only the graph survives into the merge. On a phone
			// this is still the single largest allocation the app makes. Bytes
			// only: no content.
			trail('sync pull', Math.round((j.blob || '').length / 1024) + 'K sealed');
			var plain = await DaimondIdentity.unwrap(j.blob);	// throws on a wrong key.
			// The sealed copy has done its work: release it the moment the plain
			// text exists, so the blob and the object graph never coexist. On a
			// phone the three of them together are the single largest allocation
			// the app makes, and iOS kills the tab before they all fit. `j.version`
			// is still read below, so only the blob field goes -- what is applied
			// and the order it is applied in do not change by a byte.
			j.blob = null;
			trail('sync parcel', Math.round(plain.length / 1024) + 'K plain');
			state = JSON.parse(plain);
			// Same again: the plain text is redundant to the graph now, and
			// applyParcel below is the memory-heavy phase, so free it before that
			// runs rather than leaving it alive across the merge.
			plain = null;
			trail('sync parsed');
		} catch (e) {
			// Not readable at all, which is a DIFFERENT thing from readable and
			// not mergeable, and the two must not be handled alike. What cannot
			// be opened is unusable to every device that holds this identity, so
			// the version is adopted and this device's own good state goes over
			// the top of it -- that is how an account recovers from a corrupt or
			// half-written blob at all. Refusing to push here instead would leave
			// the mailbox unreadable and every device silently stuck behind it.
			// `lastFailed` is for sections that ARRIVED and could not be merged;
			// this is not one.
			log('pull decrypt/parse failed; keeping local state');
			adoptVersion(j.version | 0, preRead);
			reapplyDone();
			if (!quiet) restStatus();
			return serverVersion;
		}
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
		lastFailed = await applyParcel(state);
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
			scheduleReapply();
			if (!quiet) jam('merge');
			return serverVersion;		// the last FULLY-applied version, deliberately not j.version.
		}
		adoptVersion(j.version | 0, preRead);
		reapplyDone();				// a clean apply settles any re-pull that was armed.
		unjam();
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
		else if (!entitled || tooLarge) restStatus();
		else setStatus('synced', t('sync.synced'), 1800);
		log('pulled version', serverVersion, 'from', j.device || '?');
		return serverVersion;
	}

	// ── Push ───────────────────────────────────────────────────

	/// Encrypt and push local state under compare-and-set, reconciling a
	/// conflict by pulling, merging and retrying. A no-op when nothing has
	/// changed since the last push, so an idle app is quiet on the wire.
	async function push() {
		if (!ready() || !entitled) return;
		if (window.DaimondCore.busy && DaimondCore.busy()) { schedule(); return; }	// never over a live turn.
		if (inFlight) { schedule(); return; }
		inFlight = true;
		try {
			for (var attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
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
					if (Date.now() - lastPullAt >= IDLE_PULL_MIN_MS) await pull();
					return;
				}

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

				setStatus('syncing', t('sync.syncing'));
				var res;
				// `w` names this tab's wake channel, so the gateway taps the
				// account's OTHER devices and not this one: a device that pulled
				// in answer to its own push would double every round.
				try { res = await call('POST', { base_version: serverVersion, device: deviceLabel(), blob: blob, w: WAKE_ID }); }
				catch (e) { log('push network error', e); restStatus(); return; }

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
								// A refusal is a swept-or-not answer nobody heard: the
								// gateway can decline this commit, and a client that
								// throws the result away cannot tell a sweep that
								// happened from one that did not.
								var swept = await DaimondChunks.commit(state.chunked, serverVersion, tiers);
								if (!swept) log('chunk commit refused at version', serverVersion);
								dsCommit(swept ? 'swept' : 'refused-by-gateway');
							}
						}
						catch (e) { log('chunk commit failed', e); dsCommit('failed'); }
					}
					tooLarge = false;					// whatever would not fit, fits now
					unjam();							// and whatever would not reconcile, has
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
					if (v < 0) { jam('busy'); return; }		// could not reconcile; say so.
					// A merge that did not finish must NOT be pushed over. The
					// retry sends what this device holds, and what this device
					// holds is precisely the state that failed to take the other
					// device's work: pushing it replaces their version in the
					// mailbox with one that never saw it.
					if (lastFailed.length) {
						log('merge incomplete (', lastFailed.join(','), ') — not pushing over it');
						jam('merge');
						return;
					}
					lastPushed = null;			// local state changed under us; force a fresh send.
					// Space the retries with a jittered backoff so three busy devices do
					// not collide on every attempt and exhaust in a burst ("work has not
					// been sent"). Same shape as the lease-take fix: only the retry cadence
					// changes; the pull-merge that converges is untouched.
					if (attempt + 1 < MAX_CONFLICT_RETRIES) {
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
				// Anything else: the round is over, so the chip stops claiming to be
				// syncing and goes back to whatever is standing.
				log('push status', res.status, '— giving up this round');
				restStatus();
				return;
			}
			// Out of attempts. The mailbox moved under every one of them, so this
			// device's work is still only here -- which is exactly the state the
			// chip exists to report. It is not re-armed from here: the next
			// change, the next turn ending, the next focus and the next tab
			// switch all try again, and a loop that retried on its own would
			// spin two busy devices against each other with nobody the wiser.
			log('conflict retries exhausted; this device’s work has not been sent');
			jam('busy');
		} finally {
			inFlight = false;
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
		// Over a live turn push() will not send (it must not churn the parcel while a
		// turn runs), so do not spin: one best-effort attempt and report it unconfirmed.
		if (window.DaimondCore.busy && DaimondCore.busy()) {
			try { await push(); } catch (e) { /* best effort */ }
			return { ok: false, version: serverVersion, why: 'busy' };
		}
		for (var i = 0; i < FLUSH_MAX_ROUNDS; i++) {
			if (tooLarge) return { ok: false, version: serverVersion, why: 'too_large' };
			var cmp;
			// Through compareKey, like push(): a `seen` stamp that moved between the
			// collect and this comparison is not a parcel the mailbox is missing, and
			// reading it as one would spin every round of this loop.
			try { cmp = compareKey(await collectParcel()); }
			catch (e) { return { ok: false, version: serverVersion, why: 'collect_failed' }; }
			// Already committed: the parcel we hold is what the mailbox holds, at
			// serverVersion (lastPushed is set only after a 200 that moved the version).
			if (cmp === lastPushed && serverVersion > 0) return { ok: true, version: serverVersion };
			try { await push(); } catch (e) { return { ok: false, version: serverVersion, why: 'push_failed' }; }
			// Confirm against the live parcel: a change under us forces another round.
			var after = null;
			try { after = compareKey(await collectParcel()); }
			catch (e) { after = null; }
			if (after !== null && after === lastPushed && serverVersion > 0) return { ok: true, version: serverVersion };
			await new Promise(function (r) { setTimeout(r, FLUSH_RETRY_MS); });
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
		if (tooLarge || sessionGone) return;
		if (Date.now() - lastProgressAt < PROGRESS_PUSH_MIN_MS) return;	// throttle the trickle
		if (inFlight) return;			// a round is running; the next tick tries again
		lastProgressAt = Date.now();
		inFlight = true;
		try {
			var state = await collectParcel();
			var plain = JSON.stringify(state);
			var cmp   = compareKey(state);
			// Nothing new since the last send (progress OR ordinary): quiet frame.
			if (cmp === lastPushed && serverVersion > 0) return;
			var blob;
			try { blob = await DaimondIdentity.wrap(plain); }
			catch (e) { log('progress encrypt failed', e); return; }
			var res;
			// `w` names this tab's wake channel, so the gateway taps the OTHER devices --
			// the ones watching the hand-off -- and not this runner. NO xtra: this is a
			// POST and is never given an abort signal.
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
			inFlight = false;
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
	async function beatPresence(deviceId, name, attended, servicing, runner, mobile) {
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
		var leases = (j && j.blob) ? (await leaseUnseal(j.blob)) : null;
		return { version: ver, leases: leases || {} };
	}

	/// Compare-and-set the lease door: seal `proposed`, push it against `base`.
	/// Answers the shape DaimondLease's CAS expects -- `{ ok, version, leases }` --
	/// so a 409 hands back the door's current version and map for the retry.
	async function leaseCommit(base, proposed) {
		var blob = await leaseSeal(proposed);
		var res  = await call('POST', { base_version: base | 0, blob: blob, w: WAKE_ID }, '?lease=1');
		var j    = res && res.json;
		if (res && res.status === 200 && j && j.ok) {
			_leaseVer = (j.version) | 0;
			return { ok: true, version: _leaseVer };
		}
		// 409 (or any refusal): report the door's current state for the re-read.
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
	/// On a `413` the tail is halved and sent ONCE more: the gateway names its
	/// ceiling, so the runner fits it rather than stopping. Every other refusal is
	/// reported and the next tick tries again with a fresher tail.
	async function pushProgressFrame(turnId, tail) {
		var out = { ok: false, seq: 0, bytes: 0, ms: 0 };
		if (!ready() || !entitled || sessionGone) return out;
		if (!turnId || !tail) return out;
		var t0 = Date.now();
		var q  = '?progress=' + encodeURIComponent(String(turnId));
		var text = String(tail);
		if (text.length > PROGRESS_TAIL_MAX) text = text.slice(-PROGRESS_TAIL_MAX);
		for (var attempt = 0; attempt < 2; attempt++) {
			var seq = (_progSeq[turnId] | 0) + 1;
			var blob;
			try { blob = await progSeal({ turn: String(turnId), seq: seq, tail: text }); }
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

	/// Read `turnId`'s latest frame, newer than `since`. `waitMs > 0` asks the door
	/// to PARK rather than answer "nothing" at once, so the frame arrives within a
	/// moment of being stored. Answers `{ seq, tail }`, or null where there is
	/// nothing newer (the door's 204) or it could not be opened.
	async function getProgressFrame(turnId, since, waitMs) {
		if (!ready() || !entitled || sessionGone || !turnId) return null;
		var q = '?progress=' + encodeURIComponent(String(turnId))
			+ '&since=' + (since | 0) + '&w=' + encodeURIComponent(WAKE_ID);
		if (waitMs > 0) q += '&wait=' + (waitMs | 0);
		var res;
		// A parked read is held by the gateway on purpose, so it is given a budget
		// past the park rather than the ordinary pull timeout.
		try {
			res = await call('GET', undefined, q,
				{ timeoutMs: (waitMs > 0) ? (waitMs + 10000) : 0 });
		} catch (e) { return null; }
		if (!res || res.status !== 200 || !res.json || !res.json.blob) return null;
		var frame = await progUnseal(res.json.blob);
		if (!frame || String(frame.turn || '') !== String(turnId)) return null;
		return { seq: res.json.seq | 0, tail: String(frame.tail || '') };
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

	/// Note a version the channel heard about, and pull for it -- once, soon, and
	/// not on the heels of a pull that has just asked the same question.
	function wakeTo(v) {
		v = v | 0;
		if (v > wakeTarget) wakeTarget = v;
		if (v <= serverVersion) return;			// already have it.
		if (wakeSoon) return;					// a pull is already coming.
		var wait = Math.max(0, WAKE_PULL_MIN_MS - (Date.now() - lastPullAt));
		wakeSoon = setTimeout(function () { wakeSoon = null; wakePull(); }, wait);
	}

	/// The pull a wake asks for. Held behind the same `inFlight` gate as every
	/// other round, and re-armed rather than dropped if one is under way: the
	/// news is real, so it must not be lost to a coincidence of timing.
	async function wakePull() {
		if (!ready()) return;
		if (wakeTarget <= serverVersion) return;
		if (inFlight) {
			if (!wakeSoon) wakeSoon = setTimeout(function () { wakeSoon = null; wakePull(); }, 500);
			return;
		}
		wakes++;
		inFlight = true;
		try { await pull(); }
		finally { inFlight = false; }
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
					'?above=' + (serverVersion | 0) + '&ms=' + WAKE_PROBE_MS + '&w=' + encodeURIComponent(WAKE_ID));
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
		};
		sock.onmessage = function (ev) {
			if (gen !== wakeGen) return;
			var v = parseInt(ev.data, 10);
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
				try {
					// A stale loop stops here rather than sleeping and asking
					// again: the backoff it would grow belongs to the live one.
					if (gen !== wakeGen) break;
					res = await call('GET', undefined,
						'?above=' + (serverVersion | 0) + '&ms=' + WAKE_POLL_MS + '&w=' + encodeURIComponent(WAKE_ID));
				} catch (e) {
					// The gateway is down or the network went. Wait, growing,
					// rather than spinning against a closed door.
					if (gen !== wakeGen) break;
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
		finally { inFlight = false; }
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
		finally { inFlight = false; }
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
		// only ever abort a GET -- never the user's work in flight.
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
		if (inFlight) return;			// a round is running, and it is fresher than this one
		if (Date.now() - lastPullAt < EXPEDITE_PULL_MS) return;	// the channel already asked
		inFlight = true;
		try { await pull(); }
		finally { inFlight = false; }
	}

	/// Turn the in-flight poll on or off. daimond.js calls this as a hand-off's
	/// dispatched placeholder appears and clears, so the watching devices pull
	/// promptly for the length of the hand-off and are quiet the rest of the time.
	function setExpedite(on) {
		on = !!on;
		if (on === expediting) return;
		expediting = on;
		if (on) {
			if (!expediteTimer) expediteTimer = setInterval(expeditePull, EXPEDITE_PULL_MS);
			// Ask once now rather than wait a whole tick: the hand-off just went out.
			expeditePull();
		} else if (expediteTimer) {
			clearInterval(expediteTimer);
			expediteTimer = null;
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
		finally { inFlight = false; }
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
	// WHAT THIS DOES NOT FIX, deliberately: a SECOND device still on the old
	// passphrase cannot read this blob, adopts its version, and pushes its own
	// over the top — after which the two clobber each other for ever and nothing
	// tells anyone. That is a known defect of the merge path, it is out of this
	// file's rekey participation, and it is not made better or worse by re-sending
	// here.

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
		pull:    pull,
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
		/// tail)` PUTs one small sealed frame of a running turn's rendered tail and
		/// `getProgressFrame(turnId, since, waitMs)` reads the latest one (parking for
		/// `waitMs` so it arrives promptly). This is what streams a hand-off; the whole
		/// parcel travels only at the turn's end. See the progress door above.
		pushProgressFrame: pushProgressFrame,
		getProgressFrame:  getProgressFrame,
		/// Turn the in-flight poll on/off. daimond.js calls `expedite(true)` while a
		/// hand-off's dispatched placeholder is outstanding and `expedite(false)` when
		/// it clears, so the watching devices pull promptly (EXPEDITE_PULL_MS) for the
		/// length of the hand-off instead of waiting out the 45s wake tick.
		expedite: setExpedite,
		nudge:   nudge,
		recheck: recheck,
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
				stalled:      tooLarge || sessionGone || !!jammed,
				stalledWhy:   tooLarge ? 'too_big' : (sessionGone ? 'signed_out' : (jammed || '')),
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
