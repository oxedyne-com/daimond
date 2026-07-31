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

   WHEN IT CANNOT WORK, IT SAYS SO. Two refusals are permanent until
   something changes -- 402 (the tier is not held) and 413 (the parcel
   is over the gateway's ceiling) -- and both are reported on the status
   chip and nowhere else: state on the chip, reason on hover, never a
   dialog over the app, since nobody asked for the round that failed.
   The 413 used to log to the console alone, so sync stopped and the app
   went on looking exactly as it does when sync is working.

   A jam is the third thing the chip says, and it is the same rule
   applied to the reconcile: retries that ran out, or a parcel that
   arrived and could not be merged, both leave this device's work
   sitting here, and both used to leave "Synced" on the chip -- put
   there by the pull that was only ever half of the round.
   ============================================================ */
(function () {
	'use strict';

	var PATH        = '/api/sync';
	var CLIENT_API  = 1;			// Matches gateway.js; sent so an old tab is refused.
	var HDR_MIN_API = 'x-daimond-min-api';
	var PUSH_DEBOUNCE_MS = 2500;	// Coalesce a flurry of changes into one push.
	var MAX_CONFLICT_RETRIES = 4;	// Bound the pull-merge-retry loop.
	// Focus arrives in bursts -- a click into the window raises focus on the
	// window and a visibilitychange with it -- so the pull is debounced into one,
	// and then rate-limited: returning to a window every few seconds is normal
	// behaviour and must not become a request every few seconds.
	var FOCUS_DEBOUNCE_MS = 400;
	var FOCUS_PULL_MIN_MS = 30000;
	// A push with nothing to send asks anyway, at most this often. See push().
	var IDLE_PULL_MIN_MS  = 5000;
	var K_VERSION = 'daimond-sync-version';		// Per-account (accounts.js prefixes it).
	var K_LAST    = 'daimond-sync-last';		// When a sync last succeeded, for the chip.

	// ── State ──────────────────────────────────────────────────
	var serverVersion = 0;		// The version this device last saw on the server.
	var lastPushed    = null;	// JSON of the state last pushed, to skip no-op pushes.
	var entitled      = true;	// Cleared to false on a 402; stops pointless pushes.
	var tooLarge      = false;	// Set on a 413; the parcel will not fit as it stands.
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

	function log(/* ...args */) {
		try { if (window.console && console.debug) console.debug.apply(console, ['[sync]'].concat([].slice.call(arguments))); }
		catch (e) { /* ignore */ }
	}

	/// Whether sync can run at all right now: an unlocked identity (for the key)
	/// and an authenticated gateway session (for the mailbox).
	function ready() {
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
	// A private fetch wrapper, NOT DaimondGateway.post: sync's 402/409/413 are
	// outcomes to act on, not errors to throw. Returns {status, json}.
	async function call(method, body) {
		var opts = {
			method:      method,
			credentials: 'same-origin',
			headers:     { 'x-daimond-api': String(CLIENT_API) },
		};
		if (body !== undefined) {
			opts.headers['content-type'] = 'application/json';
			opts.body = JSON.stringify(body);
		}
		var r = await fetch(PATH, opts);
		// Honour the version contract exactly as gateway.js does: a tab too old
		// for the gateway must reload rather than talk to it.
		if (r.status === 426) { fireStale(); return { status: 426, json: null }; }
		var min = parseInt(r.headers.get(HDR_MIN_API), 10);
		if (isFinite(min) && min > CLIENT_API) fireStale();
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		return { status: r.status, json: j };
	}

	function fireStale() {
		try { window.dispatchEvent(new Event('daimond:stale')); } catch (e) { /* ignore */ }
	}

	// ── Status indicator ───────────────────────────────────────
	// A small, transient chip in the top bar: "Syncing…" while a push or pull is
	// in flight, "Synced" briefly after, "Sync off" if the tier is not held. It
	// injects itself, so there is no bespoke markup to keep in step.
	var _statusChip = null, _statusTimer = null;
	function statusChip() {
		if (_statusChip) return _statusChip;
		var actions = document.getElementById('top-actions') || document.querySelector('.top-actions');
		if (!actions) return null;
		if (!document.getElementById('sync-status-styles')) {
			var st = document.createElement('style');
			st.id = 'sync-status-styles';
			st.textContent =
				'#sync-chip{display:none;align-items:center;gap:5px;font-size:var(--fs-xs);padding:3px 9px;' +
				'border-radius:999px;border:1px solid var(--border,#333);color:var(--text-secondary,#9aa);' +
				// --surface has never been a token in variables.css, so this always
				// fell through to the literal and the chip was a near-black pill on
				// the light and lollypop themes. --bg-tertiary is the raised surface
				// the rest of the app uses, and it is defined in all three.
				'background:var(--bg-tertiary);white-space:nowrap}' +
				'#sync-chip[data-state="syncing"]{color:var(--accent)}' +
				'#sync-chip[data-state="synced"]{color:var(--ok)}' +
				'#sync-chip[data-state="off"]{color:var(--text-secondary,#888);cursor:pointer}' +
				// A stall is not an error and not a success: something is wrong that
				// the user can fix, which is what --warn is for in the rest of the app.
				'#sync-chip[data-state="stalled"]{color:var(--warn)}' +
				'#sync-chip .sdot{width:6px;height:6px;border-radius:50%;background:currentColor}' +
				'#sync-chip[data-state="syncing"] .sdot{animation:syncpulse 1s ease-in-out infinite}' +
				'@keyframes syncpulse{0%,100%{opacity:.35}50%{opacity:1}}';
			document.head.appendChild(st);
		}
		var c = document.createElement('div');
		c.id = 'sync-chip';
		c.innerHTML = '<span class="sdot"></span><span class="stext"></span>';
		// "Sync off" is the one state the user can do something about, and until now
		// the chip said so and stopped there -- the offer it was pointing at was
		// three clicks away in a drawer they had no reason to open. Clicking it goes
		// where the sentence leads. The other states are reports rather than offers,
		// so they stay inert: a chip that opened a drawer whatever it said would be
		// a trap sitting next to the pairing button.
		c.addEventListener('click', function () {
			if (c.dataset.state !== 'off') return;
			if (window.DaimondAdmin && DaimondAdmin.credits) DaimondAdmin.credits(t('sync.off_pitch'));
		});
		var pair = document.getElementById('pair-link-btn');
		if (pair && pair.parentNode === actions) actions.insertBefore(c, pair);
		else actions.appendChild(c);
		_statusChip = c;
		return c;
	}
	/// Show the chip. `title` is the hover explanation, cleared unless given --
	/// carried here because the chip is the only place a state like "off" is
	/// reported, so its reason has to travel with it rather than into a dialog.
	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	function setStatus(state, text, holdMs, title) {
		var c = statusChip();
		if (!c) return;
		if (_statusTimer) { clearTimeout(_statusTimer); _statusTimer = null; }
		if (!state) { c.style.display = 'none'; return; }
		c.dataset.state = state;
		c.querySelector('.stext').textContent = text;
		// The hover text always ends with when a sync last worked. On a stall that
		// is the most useful sentence there is -- "paused" means nothing without
		// knowing whether the last good sync was a minute or a fortnight ago -- and
		// on a good one it costs a line nobody has to read.
		c.title = [title || '', lastSyncedLine()].filter(Boolean).join('\n');
		c.style.display = 'inline-flex';
		if (holdMs) _statusTimer = setTimeout(function () { c.style.display = 'none'; }, holdMs);
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
	/// The two standing refusals outlive the round that discovered them, so every
	/// path that stops showing "Syncing…" has to come through here rather than
	/// hiding the chip: a pull failing on the network used to blank a "Sync off"
	/// that was still perfectly true, and a pull SUCCEEDING used to show "Synced"
	/// on a device whose pushes were paused by a 402 -- which is the one lie this
	/// chip exists to prevent.
	///
	/// They are ordered rather than allowed to overwrite each other. Not entitled
	/// beats too large: an account that may not sync at all cannot act on a parcel
	/// being oversized, and telling it to go and shrink a Diamond would send it to
	/// do work that changes nothing.
	function restStatus() {
		if (!entitled)     { setStatus('off', t('sync.off'), 0, offReason()); return; }
		if (tooLarge)      { showTooLarge(); return; }
		// Below the two standing refusals, and above nothing at all: a jam is
		// this round's failure rather than a state of the account, so a 402 or a
		// 413 outranks it — an account that may not sync, or a parcel that will
		// not fit, is the thing to say first.
		if (jammed)        { setStatus('stalled', t('sync.paused'), 0, jamReason()); return; }
		setStatus('');
	}

	/// Why sync is off, and what to do about it -- the chip is clickable in this
	/// state, and a hover that did not say so would leave that undiscovered.
	function offReason() {
		return t('sync.off_reason') + '\n' + t('sync.off_click');
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
	async function pull(quiet) {
		if (!ready()) return -1;
		lastFailed = [];		// what follows is the only merge this answers for.
		setStatus('syncing', t('sync.syncing'));
		var res;
		try { res = await call('GET'); }
		catch (e) { log('pull network error', e); restStatus(); return -1; }
		if (res.status !== 200 || !res.json) { log('pull status', res.status); restStatus(); return -1; }
		lastPullAt = Date.now();		// asked, and answered: see the catch-up in push().
		var j = res.json;
		if (!j.present) { serverVersion = 0; saveVersion(); restStatus(); return 0; }
		var state;
		try {
			var plain = await DaimondIdentity.unwrap(j.blob);	// throws on a wrong key.
			state = JSON.parse(plain);
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
			serverVersion = j.version | 0;
			saveVersion();
			if (!quiet) restStatus();
			return serverVersion;
		}
		var report = null;
		try { report = await DaimondCore.applySync(state); }
		catch (e) { log('applySync threw', e); report = { failed: ['all'] }; }
		lastFailed = (report && Array.isArray(report.failed)) ? report.failed : [];
		serverVersion = j.version | 0;
		saveVersion();
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
				var state = await DaimondCore.collectSync();
				var plain = JSON.stringify(state);
				if (plain === lastPushed && serverVersion > 0) {
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
				try { res = await call('POST', { base_version: serverVersion, device: deviceLabel(), blob: blob }); }
				catch (e) { log('push network error', e); restStatus(); return; }

				if (res.status === 200 && res.json && res.json.ok) {
					serverVersion = res.json.version | 0;
					lastPushed = plain;
					saveVersion();
					// The pushed state is now the shared fork point for the file merge.
					try { if (DaimondCore.syncCommitBaseline) await DaimondCore.syncCommitBaseline(); }
					catch (e) { /* baseline advances next time */ }
					// Declare the live chunk set that this state references and let
					// the gateway sweep everything it no longer does. The version
					// is named because the gateway refuses to sweep on behalf of a
					// device working from a stale view of the world — an index
					// built without knowing about someone else's file would
					// otherwise delete it.
					try {
						if (window.DaimondChunks && state.chunked) {
							var tiers = window.DaimondCloud ? DaimondCloud.tierPlan(DaimondCloud.allowance()) : null;
							await DaimondChunks.commit(state.chunked, serverVersion, tiers);
						}
					}
					catch (e) { /* the next successful push commits and sweeps */ }
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

	function saveVersion() {
		try { localStorage.setItem(K_VERSION, String(serverVersion)); } catch (e) { /* ignore */ }
	}
	function loadVersion() {
		serverVersion = parseInt(localStorage.getItem(K_VERSION) || '0', 10) || 0;
		lastSynced    = parseInt(localStorage.getItem(K_LAST) || '0', 10) || 0;
	}

	// ── Lifecycle ──────────────────────────────────────────────

	/// First reconcile once a session exists: pull the other devices' work,
	/// then push this device's, so a returning device both catches up and
	/// contributes in one pass.
	async function onAuthed() {
		if (!ready()) return;
		entitled = true;			// a fresh session may have just bought the tier.
		loadVersion();
		await pull();
		schedule();					// push whatever this device adds over the pulled base.
	}

	function start() {
		if (started) return;
		started = true;
		loadVersion();
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
		// A session becoming available (unlock → gateway bootstrap) starts it all.
		window.addEventListener('daimond:authed', function () { onAuthed(); });
		// If we booted already authed (a returning unlocked tab), reconcile now.
		if (ready()) onAuthed();
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
		version: function () { return serverVersion; },
		entitled: function () { return entitled; },
		/// What the engine would say if asked -- the same facts the chip shows, for
		/// anything that needs them in words rather than as a coloured pill.
		state:   function () {
			return {
				// Anything standing between this device's work and the mailbox:
				// a parcel that will not fit, or a reconcile that gave up.
				stalled:      tooLarge || !!jammed,
				stalledWhy:   tooLarge ? 'too_big' : (jammed || ''),
				failedParts:  lastFailed.slice(),
				entitled:     entitled,
				lastSyncedAt: lastSynced,
				lastSynced:   lastSyncedLine(),
				version:      serverVersion,
			};
		},
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	} else {
		start();
	}
})();
