/* updater.js — pull a new version into a running tab, safely and quietly.
 *
 * A browser tab loads Daimond's code once and would otherwise run it untouched for days, long
 * after a newer version was deployed. This watches for one, and applies it at a moment that
 * costs the user nothing: when the tab is in the background and idle. It never reloads over a
 * turn in flight or a half-typed prompt.
 *
 * The signal is `build.json` at the site root -- a tiny file whose `build` id changes with every
 * deploy (see dev/stamp-build.mjs). The tab reads it once at boot to learn the version it is
 * running, then re-reads it on a timer and whenever the tab is shown, and compares. A different
 * id means a newer build is live.
 *
 * "Safe" here is only about not losing work; authenticity is not in question, because the code
 * comes from Daimond's own origin over TLS -- there is no third party in this path. The reload
 * is lossless because the durability journal already makes every boot a clean recovery; this
 * just chooses a good time to do it, and never interrupts a running turn to do it.
 *
 * There is deliberately no way to REFUSE a version. A web app cannot coherently run an old build
 * against a new server, and the new build is the same app, from the same people, the user is
 * already trusting. The only question is WHEN, never WHETHER: the chip offers "now" on a click,
 * and otherwise waits for a quiet, hidden moment.
 */
(function () {
	'use strict';

	/// What the app says.
	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// One line in the durable trail, for a bug that can only be seen on a phone.
	function trail(w, d) { try { window.DaimondTrail.note(w, d); } catch (e) {} }

	var SRC      = 'build.json';   // the version stamp, at the site root
	var POLL_MS  = 120000;         // re-check on this timer while in the foreground
	var KEY      = 'daimond-updated-to';
	var FKEY     = 'daimond-forced-from';   // the build a forced reload last left, to break loops
	// The last-resort cap on forced reloads, in localStorage.
	//
	// A forced reload is the one thing in this file that can loop, and the guard
	// against it was `sessionStorage[FKEY] === booted` -- which is right, and
	// which ONLY `onStale` consulted. The `daimond:idle` handler called
	// `apply(true)` directly, so once `stale` was true every turn that ended
	// forced another reload, with no loop-breaker at all, three lines below the
	// loop-breaker. Both doors go through `force()` now.
	//
	// The cap below is what the per-build guard cannot do: `booted` is null while
	// build.json has not been read and stays null if it cannot be read at all,
	// which is the state a phone on a bad connection is in; and a standalone PWA
	// on iOS can start a fresh session on each launch, so a loop that reloads the
	// app is a loop that clears a sessionStorage guard. Three forced reloads in
	// ninety seconds is not an update arriving, it is a tab that cannot settle.
	var TKEY      = 'daimond-forced-at';
	var COOLDOWN  = 90000;
	var MAX_FORCED = 3;            // in one cooldown window, before it stops for good
	var NKEY      = 'daimond-forced-n';

	// ── The stuck-worker escape ────────────────────────────────
	//
	// The trap reference_daimond_pwa_sw_staleness describes: a controlling service
	// worker from before the network-first rewrite keeps serving an OLD shell across
	// every reload, so a deployed fix looks broken for hours and nothing SAYS why --
	// the device silently serves stale for ever. Network-first (seq 206) governs
	// freshness only once the browser is ON that worker; a browser still held by a
	// pre-206 worker cannot be freed by any reload, only by unregistering it (close
	// and reopen, or clear site data).
	//
	// This detects it without ever looping and without auto-wiping anything: when a
	// reload we performed TO a newer build lands back on the SAME build it left --
	// proof the worker served stale again -- it counts that, and after a couple in a
	// row PROMPTS the one escape a reload cannot do. `PREV_KEY` records the build a
	// reload is leaving (set in `apply`, read once at boot); coming back on the
	// identical build is the stuck signal, advancing to ANY other build clears it.
	var PREV_KEY   = 'daimond-reload-from';  // the build the last apply() reloaded away from
	var STUCK_N    = 'daimond-stuck-n';      // consecutive reloads that did not advance the build
	var STUCK_B    = 'daimond-stuck-build';  // the build those non-advancing reloads are stuck on
	var STUCK_MAX  = 2;                       // this many in a row before the escape prompt shows
	var stuck      = false;                   // a controlling worker will not advance to the served build

	var booted   = null;           // the build id this tab is running
	var pending  = null;           // a newer build id, once seen
	var note     = '';             // a one-line "what changed", if the stamp carries one
	var stale    = false;          // the gateway has declared this tab too old to serve
	var applying = false;
	var chip     = null;

	// An ACTIVE session should not be reloaded out from under the user. A soft
	// update waits for a hidden tab OR a foreground one left untouched this long; a
	// forced one (the gateway refusing the tab) never reloads mid-turn and waits a
	// short pause after the last keystroke rather than yank the page mid-sentence.
	// `lastActive` is user INPUT only -- a turn ending is not input, so a forced
	// reload applies as soon as a turn finishes (unless a key was just pressed).
	var QUIESCE_MS = 600000;       // ~10 min of no input: a safe moment for a soft update
	var GRACE_MS   = 20000;        // a short pause after the last keystroke before a forced reload
	var lastActive = Date.now();   // epoch-ms of the last keydown/pointerdown (a fresh tab counts as just-active)
	var graceTimer = null;
	function quietFor() { return Date.now() - lastActive; }

	/// Read the stamp, never from cache -- the whole point is to see the server's current truth.
	/// Any failure (offline, no stamp deployed, bad JSON) resolves to null and is simply ignored;
	/// a broken check must never break the app or nag the user.
	///
	/// The shell worker is told every id this reads. It caches code, so it must
	/// never hold a build the server has moved past, and this is the one place in
	/// the app that knows -- so the worker takes ITS answer rather than forming a
	/// second opinion on a timer of its own. See www/sw.js.
	function readStamp() {
		return fetch(SRC, { cache: 'no-store' })
			.then(function (r) { return r.ok ? r.json() : null; })
			.then(function (j) { return (j && typeof j.build === 'string') ? j : null; })
			.then(function (j) {
				if (j) { try { window.DaimondPWA.tellBuild(j.build); } catch (e) {} }
				return j;
			})
			.catch(function () { return null; });
	}

	function busy() {
		var C = window.DaimondCore;
		return !!(C && C.busy && C.busy());
	}
	function composerHasText() {
		var C = window.DaimondCore;
		return !!(C && C.composerHasText && C.composerHasText());
	}

	/// Apply the pending update by reloading. `force` is a user click: it may reload a foreground
	/// tab, but even then it will NOT interrupt a running turn -- work in flight is never lost to
	/// an update. The automatic path is stricter still: only a hidden, idle tab, with nothing
	/// half-typed, so the user never sees a page reload out from under them.
	/// Returns true only when it actually reloaded, so a caller can tell a reload
	/// from one deferred until the turn ends. The forced path counts on that: a
	/// guard spent on an attempt that was deferred is a guard that then refuses
	/// the reload it was waiting for.
	function apply(force) {
		if (applying || !pending) return false;
		if (busy()) return false;                 // never interrupt a running turn or agent
		if (!force) {
			// NEVER silently reload an UNLOCKED tab. The passphrase key lives in memory
			// only, so a reload re-seals it and the tab comes back at the login/unlock
			// gate -- and the silent reload also pre-empts the "New version -- Reload"
			// banner. So a backgrounded desktop that learned of a new build would reload
			// itself and drop to login. Instead the update stays pending: the banner
			// offers Reload on focus and the user reloads on click (which comes back
			// through here with `force`). A LOCKED tab has nothing to lose and still
			// auto-updates; a forced or stale reload via `force()` is untouched.
			try { if (window.DaimondIdentity && DaimondIdentity.isUnlocked()) return false; } catch (e) {}
			// A soft update applies at a quiet moment: a hidden tab, or a foreground
			// one left untouched for QUIESCE_MS -- never over a half-typed prompt, and
			// (via the busy() check above) never over a running turn.
			if (!document.hidden && quietFor() < QUIESCE_MS) return false;
			if (composerHasText()) return false;
		}
		applying = true;
		try { sessionStorage.setItem(KEY, pending); } catch (e) {}
		// The build we are reloading AWAY from. If the next boot comes back on this
		// same id, the controlling worker served stale and the reload did not advance
		// -- the stuck-worker signal `init` reads. Session-scoped, so it is about THIS
		// reload only.
		try { if (booted) sessionStorage.setItem(PREV_KEY, booted); } catch (e) {}
		try { if (window.DaimondJournal) DaimondJournal.flush(); } catch (e) {}
		doReload();
		return true;
	}

	/// Reload onto the newest build in ONE go. A bare `location.reload()` reboots a
	/// tab whose controlling worker is still the OLD one -- fine when the worker
	/// script did not change (it re-reads build.json and serves fresh), but no
	/// guarantee when it did: the new worker sits in `waiting` and the reloaded
	/// page is served by the old one, so the user reloads and reloads and stays put.
	/// So before reloading: drive the registration to its newest worker (update →
	/// skipWaiting → it takes control), then empty the shell caches so the next
	/// load fetches the freshest bytes. Both are bounded and neither can throw, and
	/// the reload happens exactly once whatever the worker does -- a safety timer
	/// fires it even if the handshake stalls, so a click is never lost.
	function doReload() {
		var went = false;
		var go = function () {
			if (went) return;
			went = true;
			try { location.reload(); } catch (e) {}
		};
		var safety = setTimeout(go, 3000);
		var pwa = window.DaimondPWA;
		var fresh = (pwa && pwa.freshenWorker) ? pwa.freshenWorker(2500) : Promise.resolve();
		fresh
			.then(function () { return (pwa && pwa.clearShell) ? pwa.clearShell() : null; })
			.then(function () { clearTimeout(safety); go(); },
			      function () { clearTimeout(safety); go(); });
	}

	var checking = false;
	/// A user-initiated check. If a newer build turns up it becomes "ready"; if
	/// not, a brief tick confirms the tab is current, so the click always answers.
	function manualCheck() {
		if (checking || stale) return;
		checking = true;
		chip.title = t('update.checking');
		readStamp().then(function (j) {
			checking = false;
			onFound(j);
			if (!pending && !stale) {
				chip.dataset.state = 'done';
				chip.title = t('update.latest');
				chip.hidden = false;
				setTimeout(reflect, 1400);
			}
		});
	}

	function setChip(state) {
		if (!chip) return;
		chip.dataset.state = state;
		var label = {
			current: t('topbar.up_to_date'),
			// The transparency note is NOT shown to the user (it is a developer commit
			// subject, not user copy) -- the chip and banner say only that an update waits.
			ready:   t('update.ready') + ' ' + t('update.click_now'),
			busy:    t('update.ready_help'),
			done:    t('update.updated'),
			stale:   t('update.stale'),
			stuck:   t('update.stuck'),
		}[state] || '';
		chip.title = label;
		chip.setAttribute('aria-label', label);
		chip.hidden = false;
	}

	/// The update state, reflected on the chip. Stale (the gateway refuses this tab) is the loudest
	/// and outranks the rest; otherwise ready when it could apply, "busy" while a turn must finish.
	function reflect() {
		// Stuck outranks stale: when a reload cannot shift the build, "reload to keep
		// working" (stale) is the very advice that keeps failing, so the escape prompt
		// -- close and reopen / clear site data -- is the more actionable word.
		if (stuck)    { setChip('stuck');   syncBanner('stuck');   return; }
		if (stale)    { setChip('stale');   syncBanner('stale');   return; }
		if (!pending) { setChip('current'); syncBanner('current'); return; }
		var st = busy() ? 'busy' : 'ready';
		setChip(st);
		syncBanner(st);
	}

	// ── The banner ──────────────────────────────────────────────────────────
	//
	// The chip alone was too quiet. It is an 18px mark in a row of them and its
	// whole message lives in a `title` nobody hovers -- so a foreground tab, the
	// one case the soft path deliberately will NOT auto-reload (the user is here,
	// working), was the one case with no visible word that a new build was waiting.
	// The owner sat on a superseded build for exactly this reason: a UI-only deploy
	// does not trip the gateway's stale path, so the pulsing chip was the only sign,
	// and it went unseen. This is the word the chip could not say: a line at the
	// foot of the window with a Reload button, shown only when a pending build is
	// one the tab will not quietly take on its own. It is dismissible, and a
	// dismissal stands only for the build in hand -- a newer one brings it back.
	var banner         = null;
	var dismissedFor   = null;    // the pending build the user has waved away
	var stuckDismissed = false;   // the stuck prompt waved away for this session (returns next boot)

	function buildBanner() {
		var b = document.createElement('div');
		b.className = 'update-banner';
		b.setAttribute('role', 'status');
		b.setAttribute('aria-live', 'polite');
		b.hidden = true;
		var msg = document.createElement('span');
		msg.className = 'update-banner-msg';
		var go = document.createElement('button');
		go.className = 'update-banner-go';
		go.type = 'button';
		// A user click, so `apply(true)` -- which flushes the journal and reloads,
		// but still refuses to interrupt a running turn. Stale goes through `force`
		// for its loop guard. Stuck goes through `repair`, which clears the shell
		// caches before its ONE guarded reload -- the only reload with a chance of
		// shifting a worker that keeps serving stale, and itself loop-guarded so a
		// stuck device cannot reload-storm. Neither can lose work in flight.
		go.addEventListener('click', function () {
			if (stuck) { repair('stuck worker: cache clear + reload'); return; }
			if (stale) { force(); return; }
			apply(true);
		});
		var x = document.createElement('button');
		x.className = 'update-banner-x';
		x.type = 'button';
		x.textContent = '×';
		x.addEventListener('click', function () {
			if (stuck) stuckDismissed = true; else dismissedFor = pending;
			hideBanner();
		});
		b.appendChild(msg);
		b.appendChild(go);
		b.appendChild(x);
		document.body.appendChild(b);
		banner = { el: b, msg: msg, go: go, x: x };
	}

	function hideBanner() { if (banner) banner.el.hidden = true; }

	/// Show, hide or relabel the banner to match the chip's state, so the loud line
	/// and the quiet mark never disagree about whether an update is waiting. Shown
	/// for `ready` (a new build the foreground tab is holding) and `stale` (the
	/// gateway has refused the tab); hidden otherwise -- including `busy`, where a
	/// reload would be wrong and the amber chip already says "waiting on this turn".
	function syncBanner(state) {
		var want = state === 'ready' || state === 'stale' || state === 'stuck';
		// A dismissal silences only the ready banner, and only for the build that
		// was pending when it was waved away. Stale is not dismissible: ignoring
		// the gateway's refusal is not a state the app can keep working in. Stuck is
		// dismissible (the device can keep working on the stale build meanwhile) and
		// returns on the next stuck observation.
		if (state === 'ready' && dismissedFor && dismissedFor === pending) want = false;
		if (state === 'stuck' && stuckDismissed) want = false;
		if (!want) { hideBanner(); return; }
		if (!banner) buildBanner();
		// The user line is deliberately note-free: `note` carries the deploy's
		// TRANSPARENCY-CHAIN summary (a developer commit subject), which is not
		// user-facing copy and read as garbage in a popup. See `onFound`.
		banner.msg.textContent = state === 'stuck'
			? t('update.stuck')
			: (state === 'stale' ? t('update.stale') : t('update.available'));
		// The stuck button offers the guarded cache-clear reload -- the one worth
		// trying -- while the message names the sure escape (close and reopen).
		banner.go.textContent = state === 'stuck' ? t('update.stuck_reload') : t('update.reload');
		banner.x.setAttribute('aria-label', t('update.dismiss'));
		banner.x.hidden = state === 'stale';
		banner.el.dataset.state = state;
		banner.el.hidden = false;
	}

	function onFound(j) {
		if (!j || j.build === booted || j.build === pending) return;
		pending = j.build;
		note = typeof j.note === 'string' ? j.note : '';
		reflect();
		apply(false);                             // try now; may simply wait for a hidden moment
	}

	/// One check. Once an update is known, stop asking and just watch for a safe moment to apply.
	function poll() {
		if (pending) { apply(false); return; }
		readStamp().then(onFound);
	}

	/// The gateway has refused this tab as too old (426, or it advertised a floor above our version).
	/// This is not "an update is available", it is "you cannot keep working" -- so it reloads as soon
	/// as the tab is idle, in the foreground too, but still never over a running turn. A once-per-build
	/// guard stops a reload loop during the brief window where a new gateway is live but the new bundle
	/// is not yet on disk: after one try from a given build, it leaves the chip red for the user.
	/// May a FORCED reload happen right now?
	///
	/// One per cooldown, counted in localStorage so it survives the reload it is
	/// guarding against. Returns false and leaves the chip red when it will not:
	/// if reloading did not clear the staleness the first time, reloading again
	/// is a loop, and a red chip the user can press is strictly better than an
	/// app that will not stay open long enough to be used.
	/// May a forced reload happen? Asked before every one, and it SPENDS NOTHING
	/// -- see `spendForce`, which is called only once a reload really starts.
	function mayForce() {
		// THE PRIMARY GUARD IS PER BUILD, and it was already right: one forced
		// reload from a given build, because if reloading did not change the
		// build there is nothing a second reload can do. What was wrong was that
		// only ONE of the two doors consulted it.
		var guarded = false;
		try { guarded = sessionStorage.getItem(FKEY) === booted; } catch (e) {}
		if (guarded && booted) return false;

		// A LAST RESORT, in localStorage so it survives the reload it guards
		// against. The per-build guard above cannot help when `booted` is null --
		// build.json unreadable, which is the state a phone on a bad connection
		// is in -- and a standalone PWA on iOS can start a fresh session on each
		// launch, so a loop that reloads the app is a loop that clears a
		// sessionStorage guard. Three in ninety seconds is not an update
		// arriving; it is a tab that cannot settle.
		var now = Date.now(), at = 0, n = 0;
		try { at = parseInt(localStorage.getItem(TKEY), 10) || 0; } catch (e) {}
		try { n  = parseInt(localStorage.getItem(NKEY), 10) || 0; } catch (e) {}
		if (now - at > COOLDOWN) n = 0;              // a quiet window: start counting again
		if (n >= MAX_FORCED) return false;
		return true;
	}

	/// Record a forced reload that is HAPPENING. Split from `mayForce` because a
	/// forced reload is often deferred -- `apply` refuses over a running turn --
	/// and marking the guard on the attempt made the tab refuse the very reload
	/// it was waiting for the turn to end for. `verify_updates` caught exactly
	/// that: "stale applies the moment the turn ends" went red.
	function spendForce() {
		var now = Date.now(), at = 0, n = 0;
		try { at = parseInt(localStorage.getItem(TKEY), 10) || 0; } catch (e) {}
		try { n  = parseInt(localStorage.getItem(NKEY), 10) || 0; } catch (e) {}
		if (now - at > COOLDOWN) n = 0;
		try { localStorage.setItem(TKEY, String(now)); } catch (e) {}
		try { localStorage.setItem(NKEY, String(n + 1)); } catch (e) {}
		try { if (booted) sessionStorage.setItem(FKEY, booted); } catch (e) {}
	}

	/// The one door a forced reload goes through. Both callers -- the gateway
	/// refusing this tab, and a turn ending while it is already refused -- come
	/// here, so neither can reload past the guard.
	function force() {
		if (!mayForce()) {
			trail('forced reload REFUSED', 'loop guard held');
			setChip('stale');
			return false;
		}
		// Never reload mid-keystroke. If the composer holds text and a key was
		// pressed within the grace, wait out the remaining pause and retry -- the tab
		// stays refused (the red chip says so) but the reload lands at the next
		// natural break, not the middle of a sentence. A running turn is handled by
		// apply(true), which defers until daimond:idle.
		if (composerHasText() && quietFor() < GRACE_MS) {
			if (graceTimer) clearTimeout(graceTimer);
			graceTimer = setTimeout(force, GRACE_MS - quietFor() + 100);
			return false;
		}
		if (!apply(true)) return false;            // deferred over a running turn
		trail('forced reload', 'the gateway refused this build');
		spendForce();
		return true;
	}

	/// A MISMATCHED PAIR: the wasm the page fetched and the JS glue running beside it
	/// were built at different times, so an import the module needs is not the one the
	/// glue defines. wasm-bindgen derives every one of those names from a signature, so
	/// they all move with a build -- which makes this unrecoverable in the page and
	/// trivially repairable by taking both files again.
	///
	/// It exists because the cache logic protects an invariant one file short of the real
	/// one. `www/sw.js` is careful never to leave two builds in ONE CACHE, and that is
	/// true and not sufficient: a tab that loaded build A's JS, and then fetches the wasm
	/// after a deploy has landed, never puts two builds in a cache at all. The mismatch is
	/// in memory, between a file already executing and a file just arrived.
	///
	/// The caches go first. A reload that kept them would be served the same stale glue
	/// and fail again, which is a loop rather than a repair.
	function repair(why) {
		if (!mayForce()) { trail('repair reload REFUSED', 'loop guard held'); return false; }
		spendForce();
		trail('repair reload', why || 'a mismatched engine pair');
		// Record the build we are leaving, so if this reload ALSO fails to advance
		// (a worker that will not let go), the next boot counts it toward the stuck
		// prompt rather than losing the evidence -- repair does not go through apply().
		try { if (booted) sessionStorage.setItem(PREV_KEY, booted); } catch (e) {}
		var go = function () { try { location.reload(); } catch (e) {} };
		try {
			if (window.caches && caches.keys) {
				caches.keys()
					.then(function (ns) {
						return Promise.all(ns.map(function (n) { return caches.delete(n); }));
					})
					.then(go, go);
				return true;
			}
		} catch (e) { /* no Cache Storage; the reload alone is still worth taking */ }
		go();
		return true;
	}

	/// A reload that WORKED clears the counter. Called from `init` when the build
	/// on disk is not the one this tab last forced away from: whatever was wrong
	/// is over, and the next genuine update must not be refused because of it.
	function forgetForced() {
		try {
			localStorage.removeItem(TKEY);
			localStorage.removeItem(NKEY);
		} catch (e) {}
	}

	function onStale() {
		trail('gateway says stale', booted || 'build unknown');
		stale = true;
		reflect();
		readStamp().then(function (j) {
			pending = (j && j.build) || pending || (booted ? booted + '!' : 'stale');
			if (j && typeof j.note === 'string') note = j.note;
			reflect();
			force();
		});
	}

	async function init() {
		chip = document.getElementById('update-chip');
		// Pending → apply it. Otherwise it is a manual "check now", with a tick of
		// feedback, so the chip never feels like a dead button.
		if (chip) chip.addEventListener('click', function () {
			if (pending) { apply(true); return; }
			manualCheck();
		});

		// Did this very load just replace an older build? Say so, briefly.
		var was = null;
		try { was = sessionStorage.getItem(KEY); } catch (e) {}
		try { if (was) sessionStorage.removeItem(KEY); } catch (e) {}

		var first = await readStamp();
		booted = first ? first.build : null;
		// Into the trail, and into storage for the next boot's `boot` row. Without
		// it a trail from a device cannot be attributed to a release, and one
		// already could not be -- which cost a whole cycle to discover.
		try { window.DaimondTrail.setBuild(booted); } catch (e) {}

		// A reload that landed on a DIFFERENT build did its job, so the forced
		// counter starts again. Without this, one bad afternoon leaves a phone
		// refusing the next genuine update until the cooldown expires.
		var forcedFrom = null;
		try { forcedFrom = sessionStorage.getItem(FKEY); } catch (e) {}
		if (booted && forcedFrom && forcedFrom !== booted) forgetForced();

		// ── Did a reload we performed FAIL to advance the build? ──
		//
		// `PREV_KEY` is the build the last `apply()`/`repair()` reloaded away from.
		// Coming back on the SAME id means the controlling worker served the stale
		// shell again -- the reload did not take. Count these; advancing to ANY other
		// build clears the count. Only meaningful under a controlling worker: a tab
		// with none always fetches fresh, so it can never be "stuck on a worker".
		var reloadFrom = null;
		try { reloadFrom = sessionStorage.getItem(PREV_KEY); } catch (e) {}
		try { if (reloadFrom) sessionStorage.removeItem(PREV_KEY); } catch (e) {}
		var controlled = false;
		try { controlled = !!(navigator.serviceWorker && navigator.serviceWorker.controller); } catch (e) {}
		if (booted && reloadFrom && reloadFrom === booted && controlled) {
			var sn = 0, sb = '';
			try { sn = parseInt(localStorage.getItem(STUCK_N), 10) || 0; } catch (e) {}
			try { sb = localStorage.getItem(STUCK_B) || ''; } catch (e) {}
			sn = (sb === booted) ? sn + 1 : 1;    // a new stuck build restarts the count
			try { localStorage.setItem(STUCK_N, String(sn)); } catch (e) {}
			try { localStorage.setItem(STUCK_B, booted); } catch (e) {}
			if (sn >= STUCK_MAX) stuck = true;
		} else if (booted && reloadFrom && reloadFrom !== booted) {
			// The reload advanced to another build: whatever was stuck is unstuck.
			try { localStorage.removeItem(STUCK_N); localStorage.removeItem(STUCK_B); } catch (e) {}
		}

		if (stuck) {
			// The reload cannot shift this worker: surface the escape prompt at once,
			// outranking the ordinary current/done chip. No reload here -- the prompt
			// only offers the guarded cache-clear reload and names the sure escape.
			reflect();
		} else if (booted && was && was === booted) {
			note = first && typeof first.note === 'string' ? first.note : '';
			setChip('done');
			setTimeout(function () { if (!pending && !stuck) setChip('current'); }, 6000);
		} else if (booted) {
			setChip('current');
		} else if (chip) {
			chip.hidden = true;                   // no stamp deployed yet: no version system, stay silent
		}

		// User input, for the quiescence and typing-grace thresholds above. Capture
		// phase so it counts even when a downstream handler stops propagation.
		var bump = function () { lastActive = Date.now(); };
		document.addEventListener('keydown', bump, true);
		document.addEventListener('pointerdown', bump, true);

		setInterval(poll, POLL_MS);
		document.addEventListener('visibilitychange', function () {
			if (!document.hidden) poll();         // shown: re-check, and reflect any pending state
			else if (pending) apply(false);       // hidden: the ideal moment to apply invisibly
		});
		window.addEventListener('focus', poll);
		// When a turn ends the app is idle again; a deferred update can go, and the chip settles.
		window.addEventListener('daimond:idle', function () {
			// THROUGH `force`, not `apply(true)`. This line used to force a reload
			// on every idle event for as long as `stale` was true, with no
			// loop-breaker at all -- so a tab the gateway kept refusing reloaded
			// again every time a turn ended, for ever.
			if (stale) { force(); return; }              // was only waiting on the turn
			if (pending) { reflect(); apply(false); }
		});
		// The gateway declared this tab too old: escalate to a forced reload.
		window.addEventListener('daimond:stale', onStale);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

	// A small surface for tests and for the app to nudge a check.
	window.DaimondUpdater = {
		pending: function () { return pending; },
		booted:  function () { return booted; },
		/// Is this device stuck on an old build a reload will not shift? True once a
		/// couple of reloads in a row have failed to advance under a controlling worker.
		stuck:   function () { return stuck; },
		check:   poll,
		repair:  repair,
	};
})();
