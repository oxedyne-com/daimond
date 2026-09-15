/* gesture.js — one press-and-drag recogniser, for every surface that drags.
 *
 * Two lanes wanted the same eighty lines at the same time: the Graph, where a
 * link is pulled out of a Diamond's edge and a Diamond is pushed about the
 * canvas, and the Dock, where a panel is carried into a slot. Written twice they
 * would have diverged on the very things a hand notices — how far a press has to
 * travel before it is a drag, how long a finger has to rest before it is one,
 * whether a gesture survives the pointer leaving the thing it started on — and
 * the second one to be written would have been written by reading the first.
 *
 * WHAT IT RECOGNISES, and the words for each part:
 *
 *   press   a pointerdown the caller CLAIMED, by answering `match` with a
 *           context rather than nothing. Nothing has happened yet; a press that
 *           ends here is a click and the caller is told so.
 *   lift    the press became a drag: it travelled `threshold`, or -- on a coarse
 *           pointer, which has no hover to reach anything with -- it rested
 *           `hold` milliseconds without travelling. This is where a ghost
 *           appears, a box goes translucent, a line starts following.
 *   move    the pointer moved after the lift. COALESCED: the last position is
 *           remembered and at most one move is delivered per animation frame,
 *           because a pointer reports far more often than a screen redraws.
 *   drop    the pointer was released. The caller is told whether it had lifted,
 *           so a press that never became a drag can still be a click.
 *   cancel  the system took the pointer away (`pointercancel`), the caller's own
 *           `cancel()` was called -- Escape, usually -- or a hold was refused.
 *
 * THE POINTER IS CAPTURED at the lift, on the element the gesture was bound to.
 * That is what makes a drag survive the pointer leaving the box, which listeners
 * added to `document` for the life of a gesture were standing in for; a capture
 * cannot be left behind by a release nobody saw.
 *
 * Pointer events only. One recogniser serves a mouse, a finger and a pen, which
 * is the whole reason the phone gets the same surface as the desk rather than a
 * second implementation of the same gesture that behaves slightly differently.
 *
 * The state machine is proved in `www/js/gesture.test.mjs`, under node, against
 * a stand-in element: it needs no browser because it touches nothing but its own
 * state and the callbacks it was given.
 */
(function () {
	'use strict';

	// How far a press travels before it is a drag. Four pixels: below it a hand
	// holding still is not asking for anything to move, and a click on a control
	// still means what a click has always meant.
	var THRESHOLD = 4;
	// How long a finger rests before it is a drag, on a pointer with no hover.
	var HOLD = 350;
	// And how far it may wander in that time and still be resting. Larger than
	// the threshold, because a finger on glass is never quite still.
	var HOLD_SLOP = 8;

	/// Does this pointer have no hover to reach anything with?
	///
	/// A finger and a pen, not a mouse. `pointerType` rather than a media query:
	/// a machine with both a touchscreen and a mouse answers the query one way
	/// for both, and then one of the two gestures is wrong.
	function coarse(ev) {
		return !!ev && ev.pointerType !== undefined && ev.pointerType !== 'mouse';
	}

	/// Has the press travelled far enough to be a drag?
	function past(from, at, threshold) {
		return Math.abs(at.x - from.x) >= threshold || Math.abs(at.y - from.y) >= threshold;
	}

	/// Bind a press-and-drag gesture to an element.
	///
	/// # Arguments
	/// * `el`   - The element the presses arrive on, and the one that takes the
	///            pointer capture.
	/// * `opts` - The callbacks and the two numbers:
	///   - `match(ev)`            answer a context to claim this press, or nothing
	///                            to ignore it. The context is handed back to
	///                            every other callback, so it is where a caller
	///                            keeps what it worked out at the press.
	///   - `lift(ev, ctx)`        the press became a drag. Answer `false` to
	///                            refuse, which cancels.
	///   - `move(pt, ctx)`        `{ clientX, clientY }`, once per frame. NOT the
	///                            event: it is delivered a frame later, by which
	///                            time an event's `preventDefault` is too late,
	///                            and holding one across a frame is how a handler
	///                            comes to act on a gesture that has ended.
	///   - `drop(ev, ctx, lifted)`
	///   - `cancel(ctx, lifted)`
	///   - `onHold(ctx)`          what a rest on a coarse pointer means, when it
	///                            is not a lift. Answer `'cancel'` to end the
	///                            gesture -- which is how the Graph raises a
	///                            tile's anchors under a resting finger instead
	///                            of dragging the tile. Absent: a rest lifts.
	///   - `threshold`            pixels, default 4.
	///   - `hold`                 milliseconds, default 350; nought for none.
	///   - `passive`              true to leave the browser's own handling of the
	///                            press alone. By default a claimed press is
	///                            defended, or the browser sweeps a text
	///                            selection across whatever the pointer passes.
	///   - `capture`              `'lift'`, the default, takes the pointer when
	///                            the press becomes a drag; `'press'` takes it at
	///                            once. Take it at once wherever the FIRST move
	///                            may already be outside the element -- a pan
	///                            begun near an edge is the case, and it cost an
	///                            afternoon: the move that would have lifted the
	///                            gesture landed outside, so nothing lifted, so
	///                            nothing was ever captured, and the pan started
	///                            and never moved. Take it at the lift wherever
	///                            the press is ALSO a click, since a captured
	///                            pointer retargets the click that follows it.
	///
	/// Answers a handle: `cancel()` ends whatever is running, `active()` says
	/// whether anything is, `lifted()` whether it has become a drag, and `off()`
	/// unbinds.
	function drag(el, opts) {
		var o = opts || {};
		var threshold = o.threshold === undefined ? THRESHOLD : o.threshold;
		var holdMs    = o.hold === undefined ? HOLD : o.hold;
		var live = null;
		var frame = null, pending = null;

		function fire(fn, a, b, c) {
			if (typeof fn !== 'function') return undefined;
			return fn(a, b, c);
		}

		function perFrame(fn) {
			pending = fn;
			if (frame !== null) return;
			frame = raf(function () {
				frame = null;
				var f = pending;
				pending = null;
				if (f) f();
			});
		}

		function raf(fn) {
			return (typeof requestAnimationFrame === 'function')
				? requestAnimationFrame(fn) : setTimeout(fn, 16);
		}

		function forget() {
			pending = null;
			if (live && live.timer) clearTimeout(live.timer);
			if (live && live.held) release(live.id);
			live = null;
		}

		/// Hold the pointer to this element for the rest of the gesture, so a
		/// move that leaves the element still reports to it.
		function grab() {
			if (!live || live.held) return;
			live.held = true;
			try { if (el.setPointerCapture) el.setPointerCapture(live.id); }
			catch (e) { /* no capture: the gesture still runs, it just ends early */ }
		}

		function release(id) {
			try { if (el.releasePointerCapture) el.releasePointerCapture(id); }
			catch (e) { /* the pointer has already gone */ }
		}

		/// The press becomes a drag. Refused by a `lift` that answers false, which
		/// is how a caller changes its mind about a press it claimed.
		function lift(ev) {
			if (!live || live.lifted) return live && live.lifted;
			if (live.timer) { clearTimeout(live.timer); live.timer = null; }
			if (fire(o.lift, ev, live.ctx) === false) { cancel(); return false; }
			live.lifted = true;
			grab();
			return true;
		}

		function onDown(ev) {
			if (live) return;                       // one gesture at a time
			var ctx = fire(o.match, ev);
			if (!ctx) return;
			if (!o.passive && ev.preventDefault) ev.preventDefault();
			live = {
				id: ev.pointerId, ctx: ctx, lifted: false, timer: null, held: false,
				from: { x: ev.clientX, y: ev.clientY },
				at:   { x: ev.clientX, y: ev.clientY },
			};
			if (o.capture === 'press') grab();
			// A rest on a pointer with no hover. The caller may say what a rest
			// means; by default it means the same as travelling.
			if (holdMs > 0 && coarse(ev)) {
				live.timer = setTimeout(function () {
					if (!live || live.lifted) return;
					live.timer = null;
					if (past(live.from, live.at, HOLD_SLOP)) return;   // it was travelling
					if (fire(o.onHold, live.ctx) === 'cancel') { cancel(); return; }
					lift(null);
				}, holdMs);
			}
			fire(o.start, ev, live.ctx);
		}

		function onMove(ev) {
			if (!live || ev.pointerId !== live.id) return;
			live.at = { x: ev.clientX, y: ev.clientY };
			if (!live.lifted) {
				if (!past(live.from, live.at, threshold)) return;
				if (!lift(ev)) return;
			}
			if (!o.passive && ev.preventDefault) ev.preventDefault();
			var pt = { clientX: ev.clientX, clientY: ev.clientY };
			perFrame(function () { if (live && live.lifted) fire(o.move, pt, live.ctx); });
		}

		function onUp(ev) {
			if (!live || ev.pointerId !== live.id) return;
			var g = live, was = live.lifted;
			forget();
			fire(o.drop, ev, g.ctx, was);
		}

		function onCancel(ev) {
			if (!live || (ev && ev.pointerId !== live.id)) return;
			cancel();
		}

		/// End whatever is running, telling the caller it was cancelled rather
		/// than dropped. Escape lands here.
		function cancel() {
			if (!live) return false;
			var g = live, was = live.lifted;
			forget();
			fire(o.cancel, g.ctx, was);
			return true;
		}

		el.addEventListener('pointerdown', onDown);
		el.addEventListener('pointermove', onMove);
		el.addEventListener('pointerup', onUp);
		el.addEventListener('pointercancel', onCancel);

		return {
			cancel: cancel,
			active: function () { return !!live; },
			lifted: function () { return !!(live && live.lifted); },
			context: function () { return live ? live.ctx : null; },
			off: function () {
				cancel();
				el.removeEventListener('pointerdown', onDown);
				el.removeEventListener('pointermove', onMove);
				el.removeEventListener('pointerup', onUp);
				el.removeEventListener('pointercancel', onCancel);
			},
		};
	}

	window.DaimondGesture = {
		drag:      drag,
		coarse:    coarse,
		past:      past,
		THRESHOLD: THRESHOLD,
		HOLD:      HOLD,
		HOLD_SLOP: HOLD_SLOP,
	};
})();
