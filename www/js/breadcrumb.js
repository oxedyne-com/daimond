/* breadcrumb.js — a short, durable trail of what the app just did.
 *
 * WHY THIS EXISTS. A bug was reported from an iPhone: unlock with a passkey,
 * the app appears for about a second, and then the lock screen is back. It has
 * been reported three times across three sessions and diagnosed twice, both
 * times from reading code rather than from evidence, and both diagnoses were
 * wrong. Nobody could see the console, because seeing a console on iOS needs a
 * Mac attached, so every report was a description and every fix was a guess.
 *
 * So the app writes its own trail. Twenty lines, in localStorage, surviving the
 * reload that would otherwise erase the reason for it, shown on the lock screen
 * behind a link that is only there when there is something to say.
 *
 * WHAT IS NEVER WRITTEN. No passphrase, no key, no token, no message text, no
 * file name, no address. This is a list of EVENTS -- "unlocked", "gateway said
 * 426", "forced reload refused" -- with a clock and nothing else. It is meant
 * to be pasted into a bug report by a person who can read every word of it
 * first, which is only true if there is nothing in it to leak.
 */
(function () {
	'use strict';

	var KEY = 'daimond-trail';
	var MAX = 40;
	var t0  = Date.now();

	function read() {
		try { return JSON.parse(localStorage.getItem(KEY) || '[]') || []; }
		catch (e) { return []; }
	}

	/// Add one event. `what` is a short fixed string from the app's own code --
	/// never anything a user or a model typed, so a trail cannot be made to
	/// carry content by writing it into a chat.
	function note(what, detail) {
		if (!what) return;
		try {
			var rows = read();
			rows.push({
				// Wall clock, because the question is always "what happened
				// between the unlock and the lock", and a monotonic counter
				// resets on the reload that is the thing under suspicion.
				t: Date.now(),
				// How long this PAGE had been alive. A reload shows as a small
				// number after a large one, which is what makes a reload loop
				// legible in the trail at a glance.
				a: Date.now() - t0,
				w: String(what).slice(0, 40),
				d: detail == null ? undefined : String(detail).slice(0, 60),
			});
			if (rows.length > MAX) rows = rows.slice(rows.length - MAX);
			localStorage.setItem(KEY, JSON.stringify(rows));
		} catch (e) { /* quota, or storage refused: a trail is never worth an error */ }
	}

	/// The trail as text, for a person to read and paste.
	function text() {
		var rows = read();
		if (!rows.length) return '';
		var out = [];
		for (var i = 0; i < rows.length; i++) {
			var r = rows[i];
			var when = new Date(r.t).toISOString().slice(11, 23);
			out.push(when + '  +' + String(Math.round((r.a || 0) / 100) / 10) + 's  '
				+ r.w + (r.d ? '  ' + r.d : ''));
		}
		return out.join('\n');
	}

	function clear() { try { localStorage.removeItem(KEY); } catch (e) {} }

	// The boot itself, which is the line that makes a loop visible: several
	// "boot" rows a second or two apart is a reloading tab, and no amount of
	// describing it over a chat says it as plainly.
	note('boot', (document.visibilityState || '?')
		+ ' ' + (window.matchMedia && matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser'));

	// An unhandled error or rejection is exactly what a phone cannot show, and
	// exactly what would explain a screen that goes away again.
	window.addEventListener('error', function (e) {
		note('page error', (e && e.message) || '?');
	});
	window.addEventListener('unhandledrejection', function (e) {
		var r = e && e.reason;
		note('unhandled rejection', (r && (r.message || r)) || '?');
	});
	// The page going away, and why it might be about to.
	window.addEventListener('pagehide', function (e) {
		note('pagehide', e && e.persisted ? 'into the back/forward cache' : 'unloading');
	});

	window.DaimondTrail = { note: note, text: text, clear: clear, rows: read };
})();
