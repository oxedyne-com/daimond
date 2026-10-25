/* stamp.js -- the one rule every synced register stamps a write by, and breaks a
 * tie by (the D-28 state review, 2026-09-25: A1 and A3).
 *
 * A REGISTER is a value that travels in the sync parcel beside the millisecond
 * stamp of the write that set it, and every device keeps the side with the later
 * stamp. Two faults followed from each module writing its own version of that:
 *
 *   A STAMP BELOW THE ONE IT REPLACES. A write stamped `Date.now()` on a device
 *   whose clock is behind the device that wrote the value it replaces carries the
 *   smaller number, so the next exchange puts the old value back on both. The
 *   owner tightened the permission rung on a phone five minutes slow and the
 *   desktop's `bypass` came back (CLK-2). `next(prev)` is `max(now, prev + 1)`:
 *   a write made after seeing a value always outranks it, whatever the clocks.
 *
 *   A TIE KEPT BY WHOEVER HELD IT. Equal stamps kept the local side (or took the
 *   arriving one), so two devices that met at a tie kept different values for
 *   ever and pushed at each other. `beats` breaks it the same way on every
 *   device: the canonically greater value, or, where a register passes a `rank`,
 *   the higher rank -- which is how a safety register makes the stricter value
 *   win (the rung, a scope grant, debug-share).
 *
 * Loaded before every module that writes a register; see index.html.
 */
(function () {
	'use strict';

	function ms(v) {
		var n = Number(v);
		return (isFinite(n) && n > 0) ? Math.floor(n) : 0;
	}

	/// The stamp for a local write that replaces a value stamped `prev`. `now` is the
	/// caller's clock where it passes one (a pure module given its time), else `Date.now()`.
	function next(prev, now) {
		var t = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
		return Math.max(t, ms(prev) + 1);
	}

	/// A value's canonical form: JSON with every object's keys sorted, so two
	/// devices holding the same value compare it as the same string.
	function canon(v) {
		return JSON.stringify(v === undefined ? null : v, function (k, x) {
			if (!x || typeof x !== 'object' || Array.isArray(x)) return x;
			var o = {};
			Object.keys(x).sort().forEach(function (key) { o[key] = x[key]; });
			return o;
		});
	}

	/// Does the arriving `(at, v)` beat the held `(heldAt, held)`? The later stamp
	/// does; at an equal stamp the greater `rank` does, and `rank` defaults to the
	/// canonical form. Equal on both is not a win, so holding a value already held
	/// moves nothing and the next parcel is byte-identical.
	function beats(at, v, heldAt, held, rank) {
		var a = ms(at), b = ms(heldAt);
		if (a !== b) return a > b;
		var f = rank || canon, x = f(v), y = f(held);
		return x > y;
	}

	/// The join of two ONE-WAY taint stamps (H3 TAINT-DURABLE): the earlier SET stamp, or 0
	/// when neither is set. A stamp is set when it is a positive number; anything else is unset.
	///
	/// A monotone OR, so it cannot be widened by any merge: set beats unset in either order, and
	/// two set stamps keep the earlier, which is when the conversation first read outside content.
	/// It is commutative, associative and idempotent, so every device and every merge order
	/// reaches the same value, and joining a record with itself changes nothing.
	function taint(a, b) {
		var x = ms(a), y = ms(b);
		if (!(x > 0)) return y > 0 ? y : 0;
		if (!(y > 0)) return x;
		return x < y ? x : y;
	}

	window.DaimondStamp = { next: next, beats: beats, canon: canon, ms: ms, taint: taint };
})();
