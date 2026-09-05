/* pwa.js — what makes Daimond an app on a phone rather than a bookmark.
 *
 * Three small jobs, none of which changes anything a user sees in a browser tab:
 *
 *   1. Register the shell worker (`sw.js`). See that file for the caching rule
 *      and why a product that refuses stale code is allowed a cache at all.
 *   2. Hand the worker the build id `js/updater.js` has just read, so the two
 *      share one notion of which build is live rather than each forming their own.
 *   3. Keep `<meta name="theme-color">` on the palette the user chose. In
 *      standalone mode this is the colour the platform paints its own furniture
 *      with, so a static value would leave a light palette wearing a near-black
 *      status bar.
 *
 * Registration is deliberately quiet: a browser that has no service workers, a
 * page opened over plain http, a user who has switched them off -- each is a
 * normal way to run Daimond, and none of them is worth a message.
 */
(function () {
	'use strict';

	/// The one flag `sw.js` takes, forwarded from the page's own URL.
	///
	/// It can only switch the cache ON, and production has it on regardless, so
	/// the worst it can do is make a dev server behave like production -- which
	/// is exactly what dev/verify_pwa.mjs needs in order to prove the caching
	/// rules against a real browser. See sw.js for why the cache is off on a
	/// loopback host to begin with.
	function scriptUrl() {
		var forced = false;
		try { forced = new URLSearchParams(location.search).get('cache') === 'on'; } catch (e) {}
		return forced ? 'sw.js?cache=on' : 'sw.js';
	}

	/// The live registration, kept so a user's Reload can drive it to its newest
	/// worker rather than trust the browser to have done so on its own.
	var reg = null;

	/// `registration.update()` rejects ASYNCHRONOUSLY -- a worker torn down under
	/// it, an offline check -- and an unhandled rejection is a page error. A
	/// try/catch cannot see it, so every call goes through here, which swallows both
	/// the synchronous throw and the promise rejection. None of these failures is
	/// worth a word: the next check tries again.
	function safeUpdate(r) {
		try {
			var p = r.update();
			if (p && p.catch) p.catch(function () {});
		} catch (e) {}
	}

	function register() {
		if (!('serviceWorker' in navigator)) return;
		// A worker needs a secure context. `file://` and plain http on a LAN
		// address are both ordinary ways to open this, and neither is an error.
		if (!window.isSecureContext) return;
		navigator.serviceWorker.register(scriptUrl(), { scope: './' })
			.then(function (r) { reg = r; watchUpdates(r); })
			.catch(function () { /* no worker, no cache; the app is unaffected. */ });
	}

	/// Re-check `sw.js` now, so a changed worker is fetched without waiting for the
	/// browser's own daily heuristic. Cheap, and exactly what a product that
	/// refuses stale code wants: the sooner the new worker is known, the sooner one
	/// Reload can hand over to it.
	function checkForUpdate() {
		if (reg) { safeUpdate(reg); return; }
		if (!('serviceWorker' in navigator)) return;
		navigator.serviceWorker.getRegistration().then(function (g) {
			if (g) { reg = g; safeUpdate(g); }
		}).catch(function () {});
	}

	/// Look for a new `sw.js` on the events that mean the tab has come back to a
	/// user's attention, and on a slow timer for a tab left open all day. This is
	/// what makes the worker SCRIPT itself current; `js/updater.js` keeps the BUILD
	/// current, and the two together are the whole of the freshness story.
	function watchUpdates(r) {
		try {
			document.addEventListener('visibilitychange', function () {
				if (!document.hidden) checkForUpdate();
			});
			window.addEventListener('focus', checkForUpdate);
		} catch (e) {}
		try { setInterval(checkForUpdate, 300000); } catch (e) {}
		safeUpdate(r);				// once, now, at boot
	}

	/// Drive the registration to its newest worker and resolve once that worker is
	/// in control -- or at once when there is nothing to hand over. A user's Reload
	/// calls this BEFORE it reloads, so one click lands on the newest build even
	/// when the worker script itself changed: a bare `location.reload()` cannot
	/// promise that, because the reloaded page is served by the OLD controller
	/// while the new one is still parked in `waiting`. Never rejects, and never
	/// hangs: a `timeoutMs` cap resolves it whatever the browser does.
	function freshenWorker(timeoutMs) {
		if (!('serviceWorker' in navigator)) return Promise.resolve();
		var nav = navigator.serviceWorker;
		return nav.getRegistration().then(function (r) {
			if (!r) return;
			reg = r;
			return new Promise(function (res) {
				var done = false;
				var finish = function () { if (done) return; done = true; res(); };
				var tell = function (w) {
					if (w) { try { w.postMessage({ type: 'skipWaiting' }); } catch (e) {} }
				};
				var watch = function (w) {
					if (!w) return;
					tell(w);				// installed workers self-skip, but say it anyway
					w.addEventListener('statechange', function () {
						if (w.state === 'installed' || w.state === 'activated') tell(w);
						if (w.state === 'activated') finish();
					});
				};
				// The new worker taking control is the green light to reload onto it.
				nav.addEventListener('controllerchange', finish, { once: true });
				r.addEventListener('updatefound', function () { watch(r.installing); });
				watch(r.installing);
				watch(r.waiting);
				// Kick the check that may PRODUCE a new worker, now that the
				// listeners that will catch it are wired.
				safeUpdate(r);
				// Nothing in flight after the kick settles: nothing to hand over, so
				// do not make the click wait on a handover that will never come.
				setTimeout(function () {
					if (!r.installing && !r.waiting) finish();
				}, 300);
				setTimeout(finish, timeoutMs || 2500);	// never hang a user's click
			});
		}).catch(function () {});
	}

	/// Empty every shell cache, so the next load's requests go to the network and
	/// the freshest bytes come back. The build-keyed worker already sweeps a moved
	/// build's cache on its own; this is the belt to that braces, used on the one
	/// path where a user has explicitly asked for the newest build now.
	function clearShell() {
		if (!('caches' in self)) return Promise.resolve();
		return caches.keys().then(function (names) {
			return Promise.all(names
				.filter(function (n) { return n.indexOf('daimond-shell-') === 0; })
				.map(function (n) { return caches.delete(n); }));
		}).catch(function () {});
	}

	/// Tell the worker which build the server is on.
	///
	/// `js/updater.js` reads build.json no-store, at boot and on every poll, and
	/// calls this with what it found. The worker acts on it immediately: a
	/// different id empties the shell cache there and then, rather than at the
	/// next navigation.
	function tellBuild(build) {
		if (!build || !('serviceWorker' in navigator)) return;
		var c = navigator.serviceWorker.controller;
		if (!c) return;
		try { c.postMessage({ type: 'daimond-build', build: build }); } catch (e) {}
	}

	/// The platform's own furniture, painted the colour of the app's ground.
	///
	/// Read from the live stylesheet rather than listed here, so the eleven
	/// palettes need no second table to fall out of step with.
	function paint() {
		var meta = document.querySelector('meta[name="theme-color"]');
		if (!meta) return;
		var bg = getComputedStyle(document.documentElement)
			.getPropertyValue('--bg-primary').trim();
		if (bg) meta.setAttribute('content', bg);
	}

	function init() {
		register();
		paint();
		// The palette is set by an attribute on <html> -- by the pre-paint script
		// in index.html, and again by DaimondTheme whenever the user picks one.
		// Watching the attribute catches both, and anything added later, without
		// a second place having to remember to call this.
		try {
			new MutationObserver(paint).observe(document.documentElement,
				{ attributes: true, attributeFilter: ['data-theme'] });
		} catch (e) { /* no observer: the boot colour stands. */ }
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

	window.DaimondPWA = {
		tellBuild: tellBuild,
		/// Re-check sw.js now (a changed worker is fetched on demand).
		checkForUpdate: checkForUpdate,
		/// Drive the registration to its newest worker; resolves when it is in
		/// control, or at once when there is nothing to hand over. js/updater.js
		/// calls this before a user-initiated reload. See freshenWorker.
		freshenWorker: freshenWorker,
		/// Empty the shell caches, so the next load fetches the freshest bytes.
		clearShell: clearShell,
		/// What the worker believes, asked of the worker itself. Null when there
		/// is none. Used by dev/verify_pwa.mjs, and worth having on a phone.
		state: function () {
			return new Promise(function (res) {
				var c = navigator.serviceWorker && navigator.serviceWorker.controller;
				if (!c) { res(null); return; }
				var ch = new MessageChannel();
				var done = false;
				ch.port1.onmessage = function (e) { done = true; res(e.data); };
				setTimeout(function () { if (!done) res(null); }, 2000);
				try { c.postMessage({ type: 'daimond-sw-state' }, [ch.port2]); }
				catch (e) { res(null); }
			});
		},
	};
})();
