/* ============================================================
   watchclock.js -- when the Typst watch asks its files anything.
   ------------------------------------------------------------
   EVERY ASK IS A `getFile()` PER WATCHED FILE, and Chrome keeps a
   region for each File it hands out until the page lets go of it.
   Asked once a second, a visible tab with nothing being edited grew
   by eleven regions in three minutes (OPFSLEAK, 2026-10-24). So the
   clock asks only when there is reason to think something moved:

   - Where the browser can say what changed (`FileSystemObserver`,
     Chrome), the files are OBSERVED and the caller re-reads just the
     ones named. A full reading every 5 s stays under it as a safety
     net: whether the observer sees a write that bypasses `touched()`
     (cloud sync's `createWritable`, a Worker's sync access handle)
     is not proved, and a missed one would leave stale pages.
   - Where it cannot (Safari, iOS), the files are polled, and the gap
     doubles while nothing changes, 1 s up to 5 s, back to 1 s on any
     change or any edit the app itself made.
   - A hidden tab is neither polled nor observed. Showing it takes
     one full reading at once, then the watch resumes.

   The tick itself still runs once a second while the tab is shown,
   because it is also how the watch notices its pages leaving the
   screen (`poll` in typstwatch.js), and that question costs no file.

   Pure: the timers, the clock and the page are handed in, so
   `watchclock.test.mjs` drives it with fake ones.
   ============================================================ */

/// The gap between asks while files are changing, and between looks, in ms.
export const POLL_MIN = 1000;

/// The longest a quiet project goes unasked while polled, in ms.
export const POLL_MAX = 5000;

/// A clock for one watch.
///
/// # Arguments
/// * `o.tick(files)`     - One look; asks the files too when `files`. Resolves to
///                         `{ asked, changed }`: `asked` false when the look stopped
///                         short (pages off screen, nothing to ask about yet).
/// * `o.observe(onLost)` - Start observing; resolves to a disconnect function, `false`
///                         where the browser cannot observe at all, or `null` where it
///                         cannot this time (asked again on the next wake). `onLost()`
///                         is for an observer that has stopped reporting.
/// * `o.hidden()`        - Is the tab hidden?
/// * `o.set`, `o.clear`, `o.now` - `setTimeout`, `clearTimeout`, `Date.now`.
export function watchClock(o) {
	const set   = o.set   || function (fn, ms) { return setTimeout(fn, ms); };
	const clear = o.clear || function (id) { clearTimeout(id); };
	const now   = o.now   || Date.now;
	const min   = o.min   || POLL_MIN;
	const max   = o.max   || POLL_MAX;
	let on      = false;		// started and not stopped
	let timer   = null;		// the next tick
	let gen     = 0;		// bumped by every stop, sleep and wake: a stale await does nothing
	let mode    = 'poll';		// 'poll' or 'observe'
	let want    = true;		// try to observe on every wake, until the browser says it cannot
	let unobs   = null;		// disconnects the observer
	let wait    = min;		// the gap after the next quiet ask
	let due     = 0;		// when the files are next asked, polled

	function arm() {
		if (!on || timer || o.hidden()) return;
		timer = set(step, min);
	}

	// A change, or an edit, puts the poll back to its quickest.
	function quick() {
		wait = min;
		due  = Math.min(due, now() + min);
	}

	// Record what an ask found, for the poll's next gap.
	function after(r) {
		if (!r || !r.asked) return;
		if (r.changed) wait = min;
		// Observed, the timed reading is only the safety net: never sooner than `max`.
		due  = now() + (mode === 'observe' ? max : wait);
		wait = Math.min(max, wait * 2);
	}

	async function ask(files) {
		try { return await o.tick(files); }
		catch (e) { return null; }		// a look that threw is not a reading
	}

	async function step() {
		timer = null;
		if (!on || o.hidden()) return;
		const g = gen;
		const files = (now() >= due);
		const r = await ask(files);
		if (g !== gen) return;
		if (files) after(r);
		arm();
	}

	function sleep() {
		gen++;
		if (timer) { clear(timer); timer = null; }
		if (unobs) { try { unobs(); } catch (e) { /* already gone */ } unobs = null; }
	}

	// One full reading, then observe (where the browser can) or poll.
	async function wake() {
		sleep();
		const g = gen;
		wait = min;
		const r = await ask(true);
		if (g !== gen) return;
		after(r);
		mode = 'poll';
		if (want && o.observe) {
			let off = null;
			try { off = await o.observe(lost); }
			catch (e) { off = null; }
			if (g !== gen) { if (off) { try { off(); } catch (e) { /* gone */ } } return; }
			if (off) { unobs = off; mode = 'observe'; due = now() + max; }
			else if (off === false) want = false;	// this browser cannot: poll from here on
		}
		arm();
	}

	// The observer stopped reporting: poll, at once.
	function lost() {
		if (unobs) { try { unobs(); } catch (e) { /* gone */ } unobs = null; }
		want = false;
		mode = 'poll';
		wait = min;
		due  = now();
	}

	return {
		start: function () {
			on = true;
			if (o.hidden()) { sleep(); return; }
			wake();
		},
		stop: function () {
			on = false;
			sleep();
		},
		edited: function () { quick(); },
		visibility: function () {
			if (!on) return;
			if (o.hidden()) sleep();
			else wake();
		},
		state: function () {
			return { on: on, mode: mode, wait: wait, due: due, armed: !!timer, observing: !!unobs };
		},
	};
}
