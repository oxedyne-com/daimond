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
   and only fires when the app is idle, mirroring updater.js.
   ============================================================ */
(function () {
	'use strict';

	var PATH        = '/api/sync';
	var CLIENT_API  = 1;			// Matches gateway.js; sent so an old tab is refused.
	var HDR_MIN_API = 'x-daimond-min-api';
	var PUSH_DEBOUNCE_MS = 2500;	// Coalesce a flurry of changes into one push.
	var MAX_CONFLICT_RETRIES = 4;	// Bound the pull-merge-retry loop.
	var K_VERSION = 'daimond-sync-version';		// Per-account (accounts.js prefixes it).

	// ── State ──────────────────────────────────────────────────
	var serverVersion = 0;		// The version this device last saw on the server.
	var lastPushed    = null;	// JSON of the state last pushed, to skip no-op pushes.
	var entitled      = true;	// Cleared to false on a 402; stops pointless pushes.
	var pushTimer     = null;	// Debounce handle.
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
				'background:var(--surface,#1b1b1f);white-space:nowrap}' +
				'#sync-chip[data-state="syncing"]{color:var(--accent,#4a7)}' +
				'#sync-chip[data-state="synced"]{color:#4a7}' +
				'#sync-chip[data-state="off"]{color:var(--text-secondary,#888)}' +
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
	function setStatus(state, text, holdMs) {
		var c = statusChip();
		if (!c) return;
		if (_statusTimer) { clearTimeout(_statusTimer); _statusTimer = null; }
		if (!state) { c.style.display = 'none'; return; }
		c.dataset.state = state;
		c.querySelector('.stext').textContent = text;
		c.style.display = 'inline-flex';
		if (holdMs) _statusTimer = setTimeout(function () { c.style.display = 'none'; }, holdMs);
	}

	// ── Pull ───────────────────────────────────────────────────

	/// Fetch the current blob, decrypt it, and merge it into local state.
	/// Returns the server version now known, or -1 on a failure that should not
	/// advance anything. A decrypt failure is swallowed: better to keep local
	/// state than to clobber it with something we cannot read.
	async function pull() {
		if (!ready()) return -1;
		setStatus('syncing', 'Syncing…');
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
		setStatus('synced', 'Synced', 1800);
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

				setStatus('syncing', 'Syncing…');
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
					// the gateway sweep everything it no longer does.
					try { if (window.DaimondChunks && state.chunked) await DaimondChunks.commit(state.chunked); }
					catch (e) { /* the next successful push commits and sweeps */ }
					setStatus('synced', 'Synced', 2200);
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
					entitled = false;			// not on the sync tier; stop trying until re-checked.
					setStatus('off', 'Sync off');
					log('sync not entitled (402); pausing pushes');
					try { window.dispatchEvent(new CustomEvent('daimond:sync-locked',
						{ detail: res.json || {} })); } catch (e) { /* ignore */ }
					return;
				}
				if (res.status === 413) {
					log('blob too large (413); not retrying this payload');
					lastPushed = plain;			// don't spin on the same oversize state.
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

	function saveVersion() {
		try { localStorage.setItem(K_VERSION, String(serverVersion)); } catch (e) { /* ignore */ }
	}
	function loadVersion() {
		serverVersion = parseInt(localStorage.getItem(K_VERSION) || '0', 10) || 0;
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
		// Leaving the tab is a natural save point too.
		document.addEventListener('visibilitychange', function () {
			if (document.hidden) schedule();
		});
		// A session becoming available (unlock → gateway bootstrap) starts it all.
		window.addEventListener('daimond:authed', function () { onAuthed(); });
		// If we booted already authed (a returning unlocked tab), reconcile now.
		if (ready()) onAuthed();
		log('started');
	}

	// ── Public surface ─────────────────────────────────────────
	window.DaimondSync = {
		pull:    pull,
		push:    function () { return push(); },
		nudge:   schedule,
		version: function () { return serverVersion; },
		entitled: function () { return entitled; },
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	} else {
		start();
	}
})();
