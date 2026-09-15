/* ============================================================
   Daimond — local, Holocene-calendar date/time formatting
   ------------------------------------------------------------
   One pure module the chat transcript's tile headers call to put a
   short, unambiguous "when" beside each message (owner, 2026-09-15):
   the LOCAL calendar date in the Holocene reckoning — the Gregorian
   year plus ten thousand, so a chat from this year reads 12026 rather
   than 2026 — and the LOCAL clock time to the minute. No seconds, no
   zone suffix on the tile itself: the reader is looking at their own
   device's clock, and the one place a full instant is warranted is
   the hover title, which `fmtHoloceneFull` gives with the offset
   spelled out.

   Pure functions, no DOM: `dev/time.test.mjs` drives this module
   directly under `node --test`.

   window.DaimondTime = { fmtHolocene, fmtHoloceneShort, fmtHoloceneFull }
   ============================================================ */
(function () {
	'use strict';

	function pad2(n) { return (n < 10 ? '0' : '') + n; }

	/// The Holocene year for a LOCAL `Date`: the Gregorian year — which
	/// `getFullYear` already gives negative before 1 CE — plus ten
	/// thousand, so the reckoning has no year zero for a date near the
	/// turn of the Gregorian era to fall through to.
	function holoceneYear(d) { return d.getFullYear() + 10000; }

	/// Is `ts` a real instant? Every formatter here draws nothing rather
	/// than a wrong date for anything else -- in particular for a message
	/// with no timestamp at all, which a tile header must show as blank
	/// rather than inventing one.
	function isInstant(ts) { return typeof ts === 'number' && isFinite(ts); }

	/// `12026-09-15 13:12` -- the LOCAL date and time to the minute, in
	/// the Holocene year. `ts` is an epoch-ms instant; anything else (in
	/// particular `undefined`, a message with no `ts` field) answers ''.
	function fmtHolocene(ts) {
		if (!isInstant(ts)) return '';
		var d = new Date(ts);
		return holoceneYear(d) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
			+ ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
	}

	/// The same instant with the year cut to its last two digits --
	/// `26-09-15 13:12` -- for a header too narrow for the full
	/// five-digit Holocene year (see css/responsive.css's narrow-phone
	/// swap). The two digits read the same whichever reckoning is asked
	/// for: ten thousand is a multiple of a hundred, so the Holocene
	/// year's last two digits are always the Gregorian year's.
	function fmtHoloceneShort(ts) {
		if (!isInstant(ts)) return '';
		var d = new Date(ts);
		return pad2(holoceneYear(d) % 100) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
			+ ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
	}

	/// The full instant for a hover title: seconds included and the
	/// local UTC offset spelled out (`+10:00`, `-05:00`, `Z` at zero), so
	/// a reader comparing notes with someone in another zone has the one
	/// figure that means the same thing to both of them.
	function fmtHoloceneFull(ts) {
		if (!isInstant(ts)) return '';
		var d = new Date(ts);
		var off = -d.getTimezoneOffset();		// minutes EAST of UTC
		var sign = off < 0 ? '-' : '+';
		var oh = pad2(Math.floor(Math.abs(off) / 60)), om = pad2(Math.abs(off) % 60);
		var zone = off === 0 ? 'Z' : (sign + oh + ':' + om);
		return holoceneYear(d) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
			+ 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
			+ zone;
	}

	window.DaimondTime = {
		fmtHolocene:      fmtHolocene,
		fmtHoloceneShort: fmtHoloceneShort,
		fmtHoloceneFull:  fmtHoloceneFull,
	};
})();
