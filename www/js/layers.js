/* ============================================================
   Daimond -- the layer stack.
   ------------------------------------------------------------
   Everything the app lays over the chat floor -- the drawer, a sheet, a
   menu, a dialog, the Admin drawer, the palette -- is a LAYER, and the
   platform's Back belongs to the topmost one.

   It exists because the app pushed no history entry for any of them, so
   Back from a sheet went to the page before the app, and on Android the
   system Back button closed the PWA over the sheet. The dead-controls
   crawl found it on every layer (D-20261003-07).

   The rule the mechanism keeps:

     HISTORY IS A COUNT OF LAYERS. The session history holds one entry
     for each layer that is up, on top of the entry the app began on.
     Which entry belongs to which layer does not matter and is not
     tracked; only the depth is. That is what lets layers close in any
     order, close in pairs, or be swapped for one another in one turn
     without the history and the screen ever disagreeing for long.

     OPEN pushes an entry. DONE (a layer closed by its own control, or by
     Escape) takes one off with `history.go`. BACK arrives as `popstate`
     at a shallower depth, and the layers above that depth are closed
     through their own closers, top first. A closer reports itself with
     `done`, as it does when a control closes it; by then the layer is
     already off the stack and `done` finds nothing to do.

     CHANGES ARE APPLIED AT THE END OF THE TURN. A menu swapped for
     another, or a dialog answered by the next one, closes and opens in
     the same turn and is then no navigation at all.

     A TRAVERSAL WE ASKED FOR IS NOT A PERSON'S BACK. Each `go` we issue
     is counted, and the `popstate` it raises is let through. A traversal
     that never lands (history shorter than we thought) stops being
     counted after two seconds, so it cannot swallow a real Back.

     ONE TRAVERSAL AT A TIME. The platform runs a `go` after the call that
     issued it, and fixes its target when it is issued. A `pushState` made
     in between is made from a position the traversal is about to leave:
     the history ends one entry shallower than the layers up, and the next
     close walks off the front of the app (a blank page, found by the
     crawl's seed on 2026-10-05: a menu closed by the press that opens the
     drawer). So nothing is pushed or traversed while one of ours is in
     flight; when it lands, the depth is read from the entry the page is
     on, and the difference to the layer count is settled then.

     A FRAME'S ENTRIES ARE IN THE SAME HISTORY (r533 QA, B-2). The Web sheet
     holds a site nobody here wrote, and every link followed in it is an entry,
     after the sheet's own and before whatever opens next. So "one entry per
     layer" is a count the page cannot keep by itself: closing the sheet took one
     entry off and landed on one of the frame's, where no `popstate` reaches the
     page and Back is dead. The stack therefore records `history.length` as each
     layer's entry is pushed, which fixes where the entry is, and a close goes
     back to the last entry that belongs to the layers still up. The page cannot
     read its position, and a Back inside the frame leaves entries ahead of it, so
     when the length is not what the stack's own pushes made it, it pushes one
     more entry first: a push clears what lies ahead, and the position is then the
     end. A history already at the platform's cap stops growing, the length can no
     longer say what was added, and the stack goes back to one entry per layer.

     A RELOAD LANDS ON NO LAYER. The entry a layer pushed survives a
     reload and the layer does not, so a page that starts on a depth above
     nought takes that entry as its start (`replaceState`, depth nought).
     It does not walk back: the entries below belong to the document that
     is gone, and a traversal onto one loads the page a second time and
     loses what was typed into the first boot (r533 QA, B-1). Back from
     there boots those older entries one by one, each as the app at nought.

   Classic, and loaded before everything that opens a surface, so
   `window.DaimondLayers` is there for the module (daimond.js) and for the
   classic scripts (workspace.js, mobile.js) alike.
   ============================================================ */
(function () {
	'use strict';

	var KEY     = 'dlayers';	// the state each entry carries: { dlayers: depth }
	var STALE   = 2000;			// ms after which an unlanded traversal stops being counted

	function depthOf(state) {
		var d = state && typeof state === 'object' ? state[KEY] : 0;
		return d > 0 ? Math.floor(d) : 0;
	}

	function make(win) {
		var api       = {};
		var stack     = [];		// { id, close }, bottom first
		var pos       = 0;		// the history depth we believe the page is at
		var pending   = [];		// when each traversal we issued was issued
		var scheduled = false;
		var retry     = null;	// the timer that settles again once an unlanded traversal is given up
		var seq       = 0;
		var base      = [];		// base[d]: history.length just after depth d's entry was pushed
		var capped    = false;	// the history stopped growing as entries were pushed: lengths say nothing

		function hist() { return win.history; }
		function now()  { return api.clock(); }

		/// Forget traversals that never landed, and believe the page about where it is.
		function sweep() {
			var t = now(), k = pending.length;
			while (pending.length && t - pending[0] > STALE) pending.shift();
			if (pending.length < k) {
				try { pos = depthOf(hist().state); } catch (e) { /* keep the count */ }
			}
		}

		/// How far back to go, in entries, to land on the last entry that belongs to the layers at depth `n` and
		/// below: the entry before the one that opened depth n + 1, which is where a frame in that layer left the
		/// page. With only our own entries in the history that is one for each layer closed.
		function back(h, n) {
			var top = base[pos], low = base[n + 1], probed = false;
			if (capped || !(top > 0) || !(low > 1)) return n - pos;
			var len = h.length;
			if (len !== top) {
				// Entries we did not push (a frame's), or entries ahead of the page. Push one more, which clears
				// what lies ahead, so that the page stands on the last entry and the length is its position.
				var s = {};
				s[KEY] = pos;
				h.pushState(s, '');
				len = h.length;
				probed = true;
			}
			var d = (low - 2) - (len - 1);
			return d < 0 ? d : n - pos - (probed ? 1 : 0);
		}

		/// Bring the history depth to the layer count: push for each layer
		/// that has none, and take back the surplus in one traversal.
		function settle() {
			scheduled = false;
			var h = hist();
			if (!h) return;
			sweep();
			if (pending.length) {
				// Our own traversal is in flight: its `popstate` settles again. If it never comes, so does this.
				if (!retry && typeof setTimeout === 'function') {
					retry = setTimeout(function () { retry = null; later(); }, STALE + 50);
				}
				return;
			}
			var n = stack.length;
			try {
				while (pos < n) {
					pos++;
					var s = {};
					s[KEY] = pos;
					h.pushState(s, '');
					base[pos] = h.length;
					// A deeper entry always lengthens the history, unless the history is at its cap.
					if (pos > 1 && !(base[pos] > base[pos - 1])) capped = true;
				}
				if (pos > n) {
					var d = back(h, n);
					pos = n;
					pending.push(now());
					h.go(d);
				}
			} catch (e) { /* no history to keep: the layers still work, only Back is the platform's */ }
		}

		function later() {
			if (scheduled) return;
			scheduled = true;
			Promise.resolve().then(settle);
		}

		function indexOf(id) {
			for (var i = stack.length - 1; i >= 0; i--) if (stack[i].id === id) return i;
			return -1;
		}

		/// A layer is up. Opening one already up only replaces its closer.
		api.open = function (id, close) {
			var i = indexOf(id);
			if (i >= 0) stack[i].close = close;
			else stack.push({ id: id, close: close });
			later();
			return id;
		};

		/// A layer has closed. Nothing happens for one that is not up.
		api.done = function (id) {
			var i = indexOf(id);
			if (i < 0) return;
			stack.splice(i, 1);
			later();
		};

		api.uid    = function (kind) { seq++; return kind + '#' + seq; };
		api.depth  = function () { return stack.length; };
		api.top    = function () { return stack.length ? stack[stack.length - 1].id : null; };
		api.has    = function (id) { return indexOf(id) >= 0; };
		api.settle = settle;
		api.clock  = function () { return Date.now(); };

		/// Where a floating layer may stand so that it lies inside the glass.
		///
		/// # Arguments
		/// * `o.top`    - the top edge it was asked to stand at, in px.
		/// * `o.height` - its height at that width, already capped by its own CSS.
		/// * `o.view`   - the height of the glass.
		/// * `o.inset`  - what lies over the top of the glass (the status bar).
		/// * `o.gap`    - the margin kept to every edge.
		///
		/// The result is a `top` and a `max` height, which is null when the box
		/// fits and otherwise what it must be held to, so that it scrolls inside
		/// itself with its head still on screen.
		api.fit = function (o) {
			var lo = o.inset + o.gap, hi = o.view - o.gap;
			var top = Math.max(o.top, lo);
			if (top + o.height > hi) top = Math.max(lo, hi - o.height);
			return { top: top, max: top + o.height > hi ? hi - top : null };
		};

		/// The person pressed Back (or Forward). Close the layers above the
		/// depth the page has arrived at, top first.
		function onPop(ev) {
			sweep();
			if (pending.length) {
				// Ours has landed. The page is where the platform put it, not where we meant it to be.
				pending.shift();
				pos = depthOf(ev && ev.state);
				settle();
				return;
			}
			var d = depthOf(ev && ev.state);
			pos = d;
			var k = stack.length - d;
			for (var i = 0; i < k && stack.length; i++) {
				var l = stack.pop();
				try { l.close(); } catch (e) { /* a closer that fails still leaves the stack */ }
			}
			settle();
		}

		if (win.addEventListener) win.addEventListener('popstate', onPop);
		// A page that begins on a layer's entry is a reload of one (or a Back onto an entry an earlier page pushed).
		// The entries below it belong to a document that is gone, so a traversal onto one is a second full load of
		// the page, and whatever the person typed into this boot, a passphrase at unlock, is lost. The entry stands
		// as the start instead, at depth nought; the entries behind it are only history.
		try {
			var h0 = hist(), st0 = h0 && h0.state;
			pos = depthOf(st0);
			if (pos > 0) {
				var s0 = {};
				for (var k0 in st0) if (Object.prototype.hasOwnProperty.call(st0, k0)) s0[k0] = st0[k0];
				s0[KEY] = 0;
				h0.replaceState(s0, '');
				pos = 0;
			}
		} catch (e) { pos = 0; }

		return api;
	}

	if (typeof window !== 'undefined') window.DaimondLayers = make(window);
})();
