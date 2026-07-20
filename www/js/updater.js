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

	var SRC      = 'build.json';   // the version stamp, at the site root
	var POLL_MS  = 120000;         // re-check on this timer while in the foreground
	var KEY      = 'daimond-updated-to';
	var FKEY     = 'daimond-forced-from';   // the build a forced reload last left, to break loops

	var booted   = null;           // the build id this tab is running
	var pending  = null;           // a newer build id, once seen
	var note     = '';             // a one-line "what changed", if the stamp carries one
	var stale    = false;          // the gateway has declared this tab too old to serve
	var applying = false;
	var chip     = null;

	/// Read the stamp, never from cache -- the whole point is to see the server's current truth.
	/// Any failure (offline, no stamp deployed, bad JSON) resolves to null and is simply ignored;
	/// a broken check must never break the app or nag the user.
	function readStamp() {
		return fetch(SRC, { cache: 'no-store' })
			.then(function (r) { return r.ok ? r.json() : null; })
			.then(function (j) { return (j && typeof j.build === 'string') ? j : null; })
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
	function apply(force) {
		if (applying || !pending) return;
		if (busy()) return;                       // never interrupt a running turn or agent
		if (!force) {
			if (!document.hidden) return;         // automatic: background tabs only
			if (composerHasText()) return;        // and nothing half-typed
		}
		applying = true;
		try { sessionStorage.setItem(KEY, pending); } catch (e) {}
		try { if (window.DaimondJournal) DaimondJournal.flush(); } catch (e) {}
		location.reload();
	}

	var checking = false;
	/// A user-initiated check. If a newer build turns up it becomes "ready"; if
	/// not, a brief tick confirms the tab is current, so the click always answers.
	function manualCheck() {
		if (checking || stale) return;
		checking = true;
		chip.title = 'Checking for updates…';
		readStamp().then(function (j) {
			checking = false;
			onFound(j);
			if (!pending && !stale) {
				chip.dataset.state = 'done';
				chip.title = 'You are on the latest version';
				chip.hidden = false;
				setTimeout(reflect, 1400);
			}
		});
	}

	function setChip(state) {
		if (!chip) return;
		chip.dataset.state = state;
		var label = {
			current: 'Daimond is up to date',
			ready:   'Update ready' + (note ? ' — ' + note : '') + '. Click to update now.',
			busy:    'Update ready — it will apply when this finishes, or click to force it.',
			done:    'Daimond updated' + (note ? ' — ' + note : ''),
			stale:   'Daimond is out of date and must reload to keep working. Click to reload.',
		}[state] || '';
		chip.title = label;
		chip.setAttribute('aria-label', label);
		chip.hidden = false;
	}

	/// The update state, reflected on the chip. Stale (the gateway refuses this tab) is the loudest
	/// and outranks the rest; otherwise ready when it could apply, "busy" while a turn must finish.
	function reflect() {
		if (stale)    { setChip('stale');   return; }
		if (!pending) { setChip('current'); return; }
		setChip(busy() ? 'busy' : 'ready');
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
	function onStale() {
		stale = true;
		reflect();
		var guarded = false;
		try { guarded = sessionStorage.getItem(FKEY) === booted; } catch (e) {}
		readStamp().then(function (j) {
			pending = (j && j.build) || pending || (booted ? booted + '!' : 'stale');
			if (j && typeof j.note === 'string') note = j.note;
			reflect();
			if (guarded) { setChip('stale'); return; }   // already tried from this build; wait for a click
			try { if (booted) sessionStorage.setItem(FKEY, booted); } catch (e) {}
			apply(true);
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

		if (booted && was && was === booted) {
			note = first && typeof first.note === 'string' ? first.note : '';
			setChip('done');
			setTimeout(function () { if (!pending) setChip('current'); }, 6000);
		} else if (booted) {
			setChip('current');
		} else if (chip) {
			chip.hidden = true;                   // no stamp deployed yet: no version system, stay silent
		}

		setInterval(poll, POLL_MS);
		document.addEventListener('visibilitychange', function () {
			if (!document.hidden) poll();         // shown: re-check, and reflect any pending state
			else if (pending) apply(false);       // hidden: the ideal moment to apply invisibly
		});
		window.addEventListener('focus', poll);
		// When a turn ends the app is idle again; a deferred update can go, and the chip settles.
		window.addEventListener('daimond:idle', function () {
			if (stale) { apply(true); return; }          // a forced reload was only waiting on the turn
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
		check:   poll,
	};
})();
