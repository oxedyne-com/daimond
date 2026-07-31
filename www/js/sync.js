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
   clobber.

   A push never runs over a live turn (that state is still settling)
   and only fires when the app is idle, mirroring updater.js. A PULL
   also fires when the window is focused, throttled: a device left open
   on a desk otherwise never learned about the other one's work until
   somebody reloaded it, and coming back to a window is exactly when its
   owner expects to see what happened elsewhere.

   WHEN IT CANNOT WORK, IT SAYS SO. Two refusals are permanent until
   something changes -- 402 (the tier is not held) and 413 (the parcel
   is over the gateway's ceiling) -- and both are reported on the status
   chip and nowhere else: state on the chip, reason on hover, never a
   dialog over the app, since nobody asked for the round that failed.
   The 413 used to log to the console alone, so sync stopped and the app
   went on looking exactly as it does when sync is working.
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
	var K_VERSION = 'daimond-sync-version';		// Per-account (accounts.js prefixes it).
	var K_LAST    = 'daimond-sync-last';		// When a sync last succeeded, for the chip.

	// ── State ──────────────────────────────────────────────────
	var serverVersion = 0;		// The version this device last saw on the server.
	var lastPushed    = null;	// JSON of the state last pushed, to skip no-op pushes.
	var entitled      = true;	// Cleared to false on a 402; stops pointless pushes.
	var tooLarge      = false;	// Set on a 413; the parcel will not fit as it stands.
	var lastSynced    = 0;		// ms of the last successful pull or push.
	var pushTimer     = null;	// Debounce handle.
	var focusTimer    = null;	// Focus-pull debounce handle.
	var lastFocusPull = 0;		// ms of the last pull a focus caused.
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
	/// from …". Not trusted by the gateway; purely for display.
	function deviceLabel() {
		try {
			var n = DaimondIdentity.displayName && DaimondIdentity.displayName();
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
				'#sync-chip[data-state="off"]{color:var(--text-secondary,#888)}' +
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

	// ── Pull ───────────────────────────────────────────────────

	/// Fetch the current blob, decrypt it, and merge it into local state.
	/// Returns the server version now known, or -1 on a failure that should not
	/// advance anything. A decrypt failure is swallowed: better to keep local
	/// state than to clobber it with something we cannot read.
	async function pull() {
		if (!ready()) return -1;
		setStatus('syncing', t('sync.syncing'));
		var res;
		try { res = await call('GET'); }
		catch (e) { log('pull network error', e); setStatus(''); return -1; }
		if (res.status !== 200 || !res.json) { log('pull status', res.status); setStatus(''); return -1; }
		var j = res.json;
		if (!j.present) { serverVersion = 0; saveVersion(); setStatus(''); return 0; }
		var state;
		try {
			var plain = await DaimondIdentity.unwrap(j.blob);	// throws on a wrong key.
			state = JSON.parse(plain);
		} catch (e) {
			log('pull decrypt/parse failed; keeping local state');
			serverVersion = j.version | 0;	// still adopt the version, so we can push over it.
			saveVersion();
			return serverVersion;
		}
		try { await DaimondCore.applySync(state); } catch (e) { log('applySync failed', e); }
		serverVersion = j.version | 0;
		saveVersion();
		noteSynced();
		// A pull working says nothing about whether this device's own parcel will
		// fit, so a stall stays on the chip until a PUSH clears it.
		if (tooLarge) showTooLarge();
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
				if (plain === lastPushed && serverVersion > 0) return;	// nothing new to send.

				var blob;
				try { blob = await DaimondIdentity.wrap(plain); }
				catch (e) { log('encrypt failed', e); return; }

				setStatus('syncing', t('sync.syncing'));
				var res;
				try { res = await call('POST', { base_version: serverVersion, device: deviceLabel(), blob: blob }); }
				catch (e) { log('push network error', e); setStatus(''); return; }

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
					noteSynced();
					setStatus('synced', t('sync.synced'), 2200);
					log('pushed version', serverVersion);
					return;
				}
				if (res.status === 409) {
					// Another device moved the blob on. Pull it, merge, retry
					// against the version we just learned.
					log('conflict at base', serverVersion, '— pulling and retrying');
					var v = await pull();
					if (v < 0) return;			// could not reconcile; leave it for next time.
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
					setStatus('off', t('sync.off'), 0, t('sync.off_reason'));
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
					showTooLarge();
					log('blob too large (413); not retrying this payload');
					return;
				}
				log('push status', res.status, '— giving up this round');
				return;
			}
			log('conflict retries exhausted; will try again on the next idle');
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
		nudge:   schedule,
		recheck: recheck,
		version: function () { return serverVersion; },
		entitled: function () { return entitled; },
		/// What the engine would say if asked -- the same facts the chip shows, for
		/// anything that needs them in words rather than as a coloured pill.
		state:   function () {
			return {
				stalled:      tooLarge,
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
