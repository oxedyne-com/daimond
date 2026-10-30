/* ============================================================
   Daimond -- the one history mover (Stack A4i).
   ------------------------------------------------------------
   The session history has two owners: the layer stack (layers.js: a drawer,
   sheet, menu or dialog is an entry) and the phone's page stack
   (page/phone_stack.js: a page is an entry). Each used to move history itself,
   and each then had to wait on the other's traversal; when both stepped back in
   one task (a phone widened with a menu up, QA phone_shell HX) the two steps
   added up and walked off the front of the app.

   This script is the only code that calls `pushState`, `replaceState`, `back`
   and `go` on the page's history, and the only `popstate` listener
   (layers.wiring.test.mjs fails any other). Its rules:

     EVERY ENTRY CARRIES THE WHOLE STATE. A push or replace names only the keys
     its owner keeps, and is merged over the state of the entry the page is on,
     so a layer's entry still says which page is in view and a page's entry
     still says how many layers are up (QA ccp29 F2).

     ONE TRAVERSAL AT A TIME. A browser runs a `go` later, from the position it
     was issued at, so a push made before it lands is undone by the landing.
     While one is in flight every move is queued, and the queue is run, in order,
     once it lands. An owner whose move depends on where history stands asks for
     `run(fn)`: `fn` is called at once when nothing is in flight, otherwise after
     the landing, against the entry history is then on.

     NEVER BELOW THE FLOOR. The entry the page booted on is the app's floor.
     Each entry above it carries how many pushes lie between it and the floor,
     and the history length when it was pushed (which counts a frame's entries,
     which carry no state of ours), so a step back is cut to the floor.

     EVERY LANDING IS TOLD. Each owner's listener hears every `popstate` with
     the state landed on and whether it was a Back (or Forward) of a person's,
     or the landing of a traversal of ours. A traversal that never lands (a
     history shorter than believed) is given up after two seconds and told as a
     landing on the entry the page is on, so it cannot swallow a real Back.

   Loaded before layers.js (index.html), as a classic script, because
   layers.js reads and rewrites the entry it boots on before any module runs.
   ============================================================ */

(function () {
	'use strict';

	var KEY   = 'dh';	// each entry's { n: pushes above the floor, at: history.length just after its push }
	var STALE = 2000;	// ms after which a traversal that never landed is given up

	function make(win) {
		var api     = {};
		var owners  = [];		// listeners, in the order they asked: f(state, { back, lost })
		var queue   = [];		// moves asked for while a traversal is in flight, oldest first
		var flight  = null;		// when the traversal in flight was issued
		var timer   = null;		// gives up a traversal that never lands
		var floorAt = 0;		// history.length just after the floor entry (an upper bound, tightened by each push)
		var capped  = false;	// the history stopped growing at the platform's cap: lengths say nothing

		function hist() { return win.history; }
		function now()  { return api.clock(); }
		function cur() {
			try { var h = hist(); return h ? h.state : null; } catch (e) { return null; }
		}
		function mark(st) {
			var m = st && typeof st === 'object' ? st[KEY] : null;
			return m && typeof m === 'object' ? m : { n: 0, at: 0 };
		}
		function merged(patch) {
			var s = {}, c = cur(), k;
			if (c && typeof c === 'object') for (k in c) if (Object.prototype.hasOwnProperty.call(c, k)) s[k] = c[k];
			if (patch && typeof patch === 'object') for (k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) s[k] = patch[k];
			return s;
		}

		/// How many entries back the floor is from the entry the page is on: at least the pushes between, and
		/// on an entry we pushed, its distance in history length, which counts a frame's entries too.
		function above() {
			var m = mark(cur()), n = m.n > 0 ? Math.floor(m.n) : 0;
			var by = !capped && m.at > 0 ? m.at - floorAt : 0;
			return by > n ? by : n;
		}

		function tell(st, how) {
			for (var i = 0; i < owners.length; i++) {
				try { owners[i](st, how); } catch (e) { /* one owner's fault must not stop the others hearing */ }
			}
		}

		function drain() {
			while (queue.length && !flight) {
				var q = queue.shift();
				if (q[0] === 'run') q[1]();
				else if (q[0] === 'push') push(q[1]);
				else if (q[0] === 'replace') replace(q[1]);
				else if (q[0] === 'go') go(q[1]);
				else if (q[0] === 'back') back();
			}
		}

		/// Give up a traversal that never landed: the page is wherever it is.
		function lost() {
			if (flight === null) return;
			flight = null;
			if (timer) { clearTimeout(timer); timer = null; }
			tell(cur(), { back: false, lost: true });
			drain();
		}

		function sweep() {
			if (flight !== null && now() - flight > STALE) lost();
		}

		function push(patch) {
			var h = hist();
			if (!h) return;
			var n = mark(cur()).n;
			var s = merged(patch);
			n = (n > 0 ? Math.floor(n) : 0) + 1;
			var at = h.length + 1;	// fixed: a push clears what lies ahead, so the new entry ends the history
			s[KEY] = { n: n, at: at };
			h.pushState(s, '');
			// At the platform's cap the length stops growing and the oldest entry, the floor first, is let go:
			// lengths say nothing then, and the count of pushes alone holds.
			if (h.length !== at) { capped = true; return; }
			if (at - n < floorAt) floorAt = at - n;
		}

		function replace(patch) {
			var h = hist();
			if (h) h.replaceState(merged(patch), '');
		}

		function go(d) {
			var h = hist();
			if (!h || !d) return 0;
			if (d < 0) {
				var room = above();
				if (-d > room) d = -room;
				if (!d) return 0;
			}
			flight = now();
			if (typeof setTimeout === 'function') {
				timer = setTimeout(function () { timer = null; lost(); }, STALE);
				if (timer && timer.unref) timer.unref();	// a timer must not hold a test runner open
			}
			h.go(d);
			return d;
		}

		function back() {
			var h = hist();
			if (!h || above() < 1) return false;
			h.back();
			return true;
		}

		/// Is a traversal of ours in flight?
		api.busy = function () { sweep(); return flight !== null; };
		/// The state of the entry the page is on.
		api.state = cur;
		/// Push an entry: `patch` over the current state.
		api.push = function (patch) { if (api.busy()) queue.push([ 'push', patch ]); else push(patch); };
		/// Rewrite the entry the page is on: `patch` over its state.
		api.replace = function (patch) { if (api.busy()) queue.push([ 'replace', patch ]); else replace(patch); };
		/// Step `d` entries (back when negative, never below the floor). The steps issued, 0 for none or queued.
		api.go = function (d) {
			if (api.busy()) { queue.push([ 'go', d ]); return 0; }
			return go(d);
		};
		/// A person's Back (the installed app's edge swipe): told as a Back when it lands. Was one taken?
		api.back = function () {
			if (api.busy()) { queue.push([ 'back' ]); return true; }
			return back();
		};
		/// Call `fn` once nothing is in flight: now, or after the landing (once, however often it is asked).
		api.run = function (fn) {
			if (!api.busy()) { fn(); return; }
			for (var i = 0; i < queue.length; i++) if (queue[i][0] === 'run' && queue[i][1] === fn) return;
			queue.push([ 'run', fn ]);
		};
		/// Change the address shown, on the entry the page is on, and nothing else.
		api.url = function (u) {
			var h = hist();
			if (h) h.replaceState(h.state, '', u);
		};
		/// Hear every landing: `f(state, { back, lost })`.
		api.listen = function (f) { owners.push(f); };
		/// How many entries back the floor is.
		api.above = above;
		api.clock = function () { return Date.now(); };

		function onPop(ev) {
			var ours = flight !== null;
			flight = null;
			if (timer) { clearTimeout(timer); timer = null; }
			tell(ev ? ev.state : null, { back: !ours, lost: false });
			drain();
		}

		if (win.addEventListener) win.addEventListener('popstate', onPop);

		// The entry the page boots on is the floor, whatever an earlier document left on it: an entry it pushed
		// (a reload of one) is made the floor, and an entry with no mark already reads as the floor.
		try {
			var h0 = hist();
			if (h0) {
				floorAt = h0.length;
				var m0 = mark(cur());
				if (m0.n || m0.at) {
					var s0 = merged(null);
					s0[KEY] = { n: 0, at: 0 };
					h0.replaceState(s0, '');
				}
			}
		} catch (e) { /* no history to keep */ }

		return api;
	}

	if (typeof window !== 'undefined') window.DaimondHistory = make(window);
})();
