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

	function register() {
		if (!('serviceWorker' in navigator)) return;
		// A worker needs a secure context. `file://` and plain http on a LAN
		// address are both ordinary ways to open this, and neither is an error.
		if (!window.isSecureContext) return;
		navigator.serviceWorker.register(scriptUrl(), { scope: './' })
			.catch(function () { /* no worker, no cache; the app is unaffected. */ });
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
