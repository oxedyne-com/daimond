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
	var MAX_CONFLICT_RETRIES = 4;	// Bound the pull-merge-retry loop.
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
	var K_VERSION = 'daimond-sync-version';		// Per-account (accounts.js prefixes it).
	var K_LAST    = 'daimond-sync-last';		// When a sync last succeeded, for the chip.
	// The digest of the parcel this device last got into the mailbox, so the FIRST
	// push of a new page can tell that it has nothing to say. Same `daimond-`
	// prefix as the two above and for the same reason: accounts.js namespaces
	// every one of these, so a second account answers its own question.
	var K_SIG     = 'daimond-sync-sig';
	// What this build writes into it. A stored value that does not say this is
	// from another format and reads as no fixed point at all -- which sends.
	var SIG_V     = 1;

	// ── State ──────────────────────────────────────────────────
	var serverVersion = 0;		// The version this device last saw on the server.
	var lastPushed    = null;	// JSON of the state last pushed, to skip no-op pushes.
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
	var lastFocusPull = 0;		// ms of the last pull a focus caused.
	// ms of the last pull that reached the gateway, whatever asked for it. The
	// catch-up below is measured against THIS rather than against its own last
	// go: a device that pulled a second ago because its window was focused has
	// nothing to learn from asking again, and a second reason to ask is not a
	// second thing to know.
	var lastPullAt    = 0;
	var inFlight      = false;	// One sync operation at a time.
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
	async function call(method, body, query) {
		var opts = {
			method:      method,
			credentials: 'same-origin',
			headers:     { 'x-daimond-api': String(DaimondGateway.clientApi()) },
		};
		if (body !== undefined) {
			opts.headers['content-type'] = 'application/json';
			opts.body = JSON.stringify(body);
		}
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
	async function collectParcel() {
		var state = await DaimondCore.collectSync();
		try { if (window.DaimondPause) state.pause = DaimondPause.snapshot(); }
		catch (e) { log('pause snapshot failed', e); }
		// THE PERSISTENT DESKTOP PEER'S LEASE (dev/PEER_DESIGN.md §2). Which device
		// is running a given turn is a fact about the ACCOUNT, carried in the parcel
		// so two devices cannot both bill one turn. Attached beside the pause tree,
		// and merged on the way in by its OWN take-if-vacant rule (see adopt below),
		// NOT the append-only union the rest of the parcel uses -- a lease is a
		// mutable claim, and freshest-scalar would be the double claim.
		try { if (window.DaimondLease) state.leases = DaimondLease.snapshot(); }
		catch (e) { log('lease snapshot failed', e); }
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
				var pst = DaimondPost.snapshot();
				if (pst) state.post = pst;
			}
		} catch (e) { log('post snapshot failed', e); }
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
		// THE LEASE, merged by its OWN take-if-vacant rule (DaimondLease.adopt),
		// NOT the freshest-scalar/union the core parcel uses. This is the ONE
		// non-append-only section, and routing it here -- beside the pause tree,
		// through a named section merge -- is what keeps it off the generic scalar
		// path where last-write-by-clock would be a double claim (§2.3, §3.2).
		if (window.DaimondLease) {
			try { DaimondLease.adopt(state && state.leases); }
			catch (e) { log('lease adopt failed', e); failed.push('leases'); }
		}
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
			try { DaimondPost.adopt(state && state.post); }
			catch (e) { log('post adopt failed', e); failed.push('post'); }
			// A parcel is the fifth occasion the unread count can have changed,
			// and the only one that is not a press: messages read on another
			// device arrive here already read.
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
		try { res = await call('GET'); }
		catch (e) { log('pull network error', e); restStatus(); return -1; }
		if (res.status !== 200 || !res.json) { log('pull status', res.status); restStatus(); return -1; }
		lastPullAt = Date.now();		// asked, and answered: see the catch-up in push().
		var j = res.json;
		// PRESENCE RIDES ALONGSIDE THE PARCEL, in the clear. The gateway stamps a
		// last_seen per awake device in its own clock and includes `now` so this
		// client can convert to its own frame; `ingest` REPLACES the local view
		// (the gateway is the source of truth). Adopted here for free on every pull,
		// whether or not there is a parcel to open below, and off the sealed blob
		// entirely -- presence never touches the parcel now. See beatPresence.
		try {
			if (window.DaimondPresence && j && j.presence) DaimondPresence.ingest(j.presence, j.now);
		} catch (e) { log('presence ingest failed', e); }
		// An empty mailbox is an answer: this device has heard, and there was
		// nothing to hear. See `pulledOk`.
		if (!j.present) { adoptVersion(0, preRead); pulledOk = true; restStatus(); return serverVersion; }
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
			if (!quiet) restStatus();
			return serverVersion;
		}
		lastFailed = await applyParcel(state);
		pulledOk   = true;			// a parcel was read; see `pulledOk`.
		adoptVersion(j.version | 0, preRead);
		noteSynced();
		// A merge that could not finish is not a sync that worked, and it is the
		// user's business: their other device's work is sitting in the mailbox
		// unread on this one.
		if (lastFailed.length) {
			log('pulled version', serverVersion, 'but could not merge', lastFailed.join(','));
			if (!quiet) jam('merge');
			return serverVersion;
		}
		unjam();
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
				// `lastPushed === null` is "this page has not sent anything yet",
				// which is the only moment the carried digest is asked about. Note
				// the short-circuit: on every push after the first, `sigOf` is
				// never called at all.
				var known = (plain === lastPushed)
					|| (lastPushed === null && !!bootSig && (await sigOf(plain)) === bootSig);
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
					lastPushed = plain;
					saveVersion();
					// Beside the version, and only here: this is the one place a
					// parcel is known to have reached the mailbox. A parcel the
					// gateway refused is not one this device has sent, so the 413
					// arm below deliberately does not write it -- storing that
					// digest would have the next page skip a push that never
					// happened.
					saveSig(await sigOf(plain));
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
					if (!mayCommit) log('chunk index not merged on this device — not committing a live set');
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
							}
						}
						catch (e) { log('chunk commit failed', e); }
					}
					tooLarge = false;					// whatever would not fit, fits now
					unjam();							// and whatever would not reconcile, has
					noteSynced();
					setStatus('synced', t('sync.synced'), 2200);
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
					lastPushed = plain;			// don't spin on the same oversize state.
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
	async function beatPresence(deviceId, name) {
		if (!ready() || !entitled) return null;
		try {
			var res = await call('POST',
				{ device_id: String(deviceId || ''), name: String(name || '') }, '?presence=1');
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
				+ location.host + WS_PATH + '?w=' + encodeURIComponent(WAKE_ID);
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

	/// The digest of a parcel, or '' where one could not be taken.
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
		// moment to catch up. The one listener covers both directions.
		document.addEventListener('visibilitychange', function () {
			if (document.hidden) schedule();
			else scheduleFocusPull();
		});
		window.addEventListener('focus', scheduleFocusPull);
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
		window.addEventListener('pagehide', wakeStop);
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
		nudge:   nudge,
		recheck: recheck,
		/// The presence path, off the content parcel: `beatPresence(deviceId, name)`
		/// writes this device's last_seen and adopts the account's fresh map (bumping
		/// no version and waking nobody); `refreshPresence()` reads that map without a
		/// beat, for a dispatch-time refresh. Both ingest through DaimondPresence.
		beatPresence:    beatPresence,
		refreshPresence: refreshPresence,
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
				quiet:        !inFlight && !pushTimer && !focusTimer,
				busyWith:     inFlight ? 'a round is running'
					: (pushTimer ? 'a push is armed'
						: (focusTimer ? 'a focus pull is armed' : '')),
			};
		},
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	} else {
		start();
	}
})();
