/* safe.js — boot without the machinery that is under suspicion.
 *
 * WHY THIS EXISTS. A phone reported: unlock with a passkey, the app appears for
 * about a second, and the lock screen is back. Six diagnoses have been made
 * across four sessions and all six were wrong, because a phone has no console
 * and every explanation was therefore a guess made from reading source. The
 * trail in breadcrumb.js ended that for what the app SAYS; this ends it for
 * what the app DOES.
 *
 * A safe start does one thing: the sync engine does not run. That is the whole
 * of it, and the narrowness is the point. If the app then stays up, the cause is
 * inside what was skipped, and that is a cleaner answer than any further reading
 * of code. If it loops anyway, sync is exonerated -- which is worth just as much,
 * and nothing else so far has been able to say either.
 *
 * IT ARMS ITSELF. Three boots inside ninety seconds is not something a person
 * does, and a user whose app will not stay open long enough to be used cannot be
 * asked to find a button. So the loop turns it on and the app says so, loudly and
 * permanently, on a chip that turns it back off again. A quiet safe mode would be
 * a device that silently stopped syncing, which is worse than the bug.
 */
(function () {
	'use strict';

	var KEY   = 'daimond-safe-mode';   // '1' while the app must start without sync
	var WKEY  = 'daimond-safe-why';    // 'auto' or 'user', for the trail and the chip
	var BOOTS = 3;                     // in the window below, before it arms itself
	var WINDOW_MS = 90000;

	function trail(w, d) { try { window.DaimondTrail.note(w, d); } catch (e) {} }

	function on() {
		try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
	}

	function why() {
		try { return localStorage.getItem(WKEY) || ''; } catch (e) { return ''; }
	}

	/// Turn a safe start on or off. `reason` is 'auto' (the loop detector) or
	/// 'user' (the chip), and it is kept because the two read differently to
	/// somebody looking at a trail: one is the app protecting itself, the other
	/// is a person choosing.
	function set(v, reason) {
		try {
			if (v) {
				localStorage.setItem(KEY, '1');
				localStorage.setItem(WKEY, reason || 'user');
			} else {
				localStorage.removeItem(KEY);
				localStorage.removeItem(WKEY);
			}
		} catch (e) { /* storage refused: it simply does not persist */ }
		trail(v ? 'SAFE MODE on' : 'safe mode off', reason || 'user');
	}

	/// How many times this app has started in the last ninety seconds.
	///
	/// Read from the trail rather than from a counter of its own, because the
	/// trail is the thing that survives the tab being killed -- and a tab being
	/// killed is precisely the event being counted.
	function bootsRecently() {
		var rows = [];
		try { rows = (window.DaimondTrail && DaimondTrail.rows()) || []; } catch (e) { return 0; }
		var now = Date.now(), n = 0;
		for (var i = 0; i < rows.length; i++) {
			var r = rows[i];
			if (r && r.w === 'boot' && now - r.t < WINDOW_MS) n++;
		}
		return n;
	}

	// Arm on the way in, before anything else has had a chance to start. This
	// runs at script load and not on DOMContentLoaded: sync.js consults `on()`
	// from `ready()`, and `ready()` is asked the moment a session exists.
	if (!on() && bootsRecently() >= BOOTS) {
		set(true, 'auto');
	}
	// Say so on EVERY boot, not only the one that armed it. A trail that showed
	// the arming line once, two hundred rows ago, would leave every later cycle
	// looking like an ordinary boot that happened not to sync.
	if (on()) trail('safe start', why() === 'auto' ? 'armed by the loop' : 'chosen by the user');

	window.DaimondSafe = {
		on:    on,
		why:   why,
		set:   set,
		boots: bootsRecently,
	};
})();
