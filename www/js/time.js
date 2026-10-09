/* ============================================================
   Daimond — local date/time formatting, on the account's calendar
   ------------------------------------------------------------
   The chat transcript's tile headers put a short, unambiguous "when"
   beside each message (owner, 2026-09-15): the LOCAL calendar date and
   the LOCAL clock time to the second (2026-09-29). No zone suffix on the
   tile itself; the hover title (`fmtFull`) spells out the offset.

   THE CALENDAR IS THE PERSON'S CHOICE (D-20261006-34, D-20261006-30b):
   Holocene (the Gregorian year plus ten thousand, 12026) or Common Era
   (2026). It is an account fact, `{cal, at}` under `daimond-calendar`,
   carried by sync freshest-`at`-wins and written verbatim, the same law
   as support.js's consent record. A new account starts on Common Era;
   an account that was already in use when this arrived is given Holocene
   ONCE, stamped `at: 1`, so any explicit choice on any device beats it
   and a late-migrating device can never take that choice back.

   Every Diamond page gets the same functions in its own frame, fixed to
   the calendar of the moment, through `frameTag` (crystal.js's `armour`).
   `make` is therefore written to stand alone: it is sent as text.

   window.DaimondTime = { fmt, fmtShort, fmtFull, fmtDate, fmtIso, year, calendar,
                          setCalendar, syncSnapshot, adoptSync, frameTag }
   ============================================================ */
(function () {
	'use strict';

	var REC_KEY     = 'daimond-calendar';
	var CHECKED_KEY = 'daimond-cal-checked';	// the one-off migration ran
	var USED_KEY    = 'daimond-id-pub';		// an identity: the account was in use
	var CALS        = { he: 1, ce: 1 };

	/// The formatters for one calendar, self-contained so that its source can be
	/// sent into a page frame as it stands.
	function make(cal) {
		function pad2(n) { return (n < 10 ? '0' : '') + n; }
		// `getFullYear` is already negative before 1 CE, and ten thousand on top
		// leaves the Holocene reckoning no year zero to fall through to.
		function year(d) { return cal === 'he' ? d.getFullYear() + 10000 : d.getFullYear(); }
		// Only a real instant draws: a message with no timestamp shows blank
		// rather than an invented date.
		function isInstant(ts) { return typeof ts === 'number' && isFinite(ts); }
		function clock(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
		function day(d) { return year(d) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
		function fmt(ts) {
			if (!isInstant(ts)) return '';
			var d = new Date(ts);
			return day(d) + ' ' + clock(d);
		}
		// The year cut to its last two digits, for a header too narrow for five.
		// Ten thousand is a multiple of a hundred, so both reckonings agree here.
		function fmtShort(ts) {
			if (!isInstant(ts)) return '';
			var d = new Date(ts);
			return pad2(((year(d) % 100) + 100) % 100) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
				+ ' ' + clock(d);
		}
		function fmtFull(ts) {
			if (!isInstant(ts)) return '';
			var d = new Date(ts);
			var off = -d.getTimezoneOffset();		// minutes EAST of UTC
			var oh = pad2(Math.floor(Math.abs(off) / 60)), om = pad2(Math.abs(off) % 60);
			var zone = off === 0 ? 'Z' : ((off < 0 ? '-' : '+') + oh + ':' + om);
			return day(d) + 'T' + clock(d) + zone;
		}
		// The date alone, from an epoch, an ISO instant (read as its LOCAL date) or a
		// bare `YYYY-MM-DD` (that day as written: `Date.parse` would take it as UTC).
		function fmtDate(v) {
			var d = null, m;
			if (isInstant(v)) d = new Date(v);
			else if (typeof v === 'string') {
				m = /^(-?\d{1,6})-(\d\d)-(\d\d)$/.exec(v);
				if (m) d = new Date(+m[1], +m[2] - 1, +m[3], 12);
				else if (/^-?\d{4,6}-\d\d-\d\dT/.test(v) && isFinite(Date.parse(v))) d = new Date(Date.parse(v));
			}
			if (!d || !isFinite(d.getTime())) return '';
			if (m) d.setFullYear(+m[1]);			// two-digit years are not 19xx
			// A day the calendar does not have (2026-13-45) is not a date, not a later one.
			if (m && (d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3])) return '';
			return day(d);
		}
		// A value as a crystal stores it (the contract: store ISO, display through
		// DaimondTime). A calendar date keeps its day, an ISO instant or an epoch reads
		// as `fmt`, and text that is not ISO is shown as stored, never guessed at.
		function fmtIso(v) {
			if (isInstant(v)) return fmt(v);
			if (typeof v !== 'string' || v === '') return '';
			if (/^-?\d{1,6}-\d\d-\d\d$/.test(v)) return fmtDate(v) || v;
			if (/^-?\d{4,6}-\d\d-\d\dT\d\d:\d\d/.test(v)) {
				var t = Date.parse(v);
				if (isInstant(t)) return fmt(t);
			}
			return v;
		}
		return {
			fmt: fmt, fmtShort: fmtShort, fmtFull: fmtFull, fmtDate: fmtDate, fmtIso: fmtIso, year: year,
			calendar: function () { return cal; },
		};
	}

	function ms(v) { var n = Number(v); return (isFinite(n) && n > 0) ? Math.floor(n) : 0; }
	function store() { return window.DaimondStore || null; }

	function readRec() {
		var r = null;
		try { r = store() ? store().get(REC_KEY, null) : JSON.parse(window.localStorage.getItem(REC_KEY) || 'null'); }
		catch (e) { r = null; }
		return (r && typeof r === 'object' && CALS[r.cal] && ms(r.at)) ? { cal: r.cal, at: ms(r.at) } : null;
	}

	/// `b` when it beats `a`: the later stamp, and at a tie the same way on every device.
	function fresher(a, b) {
		if (!b) return a;
		if (!a) return b;
		var S = window.DaimondStamp;
		var wins = S ? S.beats(b.at, b.cal, a.at, a.cal) : (b.at > a.at || (b.at === a.at && b.cal > a.cal));
		return wins ? b : a;
	}

	function writeRec(rec, merged) {
		var S = store();
		if (S) return merged ? S.putMerged(REC_KEY, rec, fresher) : S.put(REC_KEY, rec, fresher);
		try { window.localStorage.setItem(REC_KEY, JSON.stringify(rec)); } catch (e) { /* refused */ }
		return true;
	}

	// The one-off migration, at the first load of this build for the account (accounts.js
	// has already namespaced storage, and switching account is a reload).
	(function migrate() {
		var ls = null;
		try { ls = window.localStorage; if (!ls || ls.getItem(CHECKED_KEY)) return; } catch (e) { return; }
		try {
			if (!readRec() && ls.getItem(USED_KEY)) writeRec({ cal: 'he', at: 1 }, false);
			ls.setItem(CHECKED_KEY, '1');
		} catch (e) { /* tried again next load */ }
	})();

	var rec = readRec();
	var cur = make(rec ? rec.cal : 'ce');

	function tell() {
		try { if (window.DaimondSync && window.DaimondSync.nudge) window.DaimondSync.nudge(); } catch (e) { /* next round */ }
	}
	function changed() {
		try { window.dispatchEvent(new CustomEvent('daimond:calendar', { detail: { cal: cur.calendar() } })); }
		catch (e) { /* no window to tell */ }
	}
	function adopt(next) {
		var was = cur.calendar();
		rec = next;
		if (next.cal !== was) { cur = make(next.cal); changed(); }
	}

	/// The person's own choice, stamped past the one it replaces.
	function setCalendar(cal) {
		if (!CALS[cal]) return;
		var S = window.DaimondStamp, prev = readRec();
		var next = { cal: cal, at: S ? S.next(prev && prev.at) : Math.max(Date.now(), (prev ? prev.at : 0) + 1) };
		writeRec(next, false);
		adopt(next);
		tell();
	}

	/// The choice as it rides the sync parcel, or null when this account never made
	/// one: "nothing to say", so a fresh device cannot override another's choice.
	function syncSnapshot() {
		var r = readRec();
		return r ? { cal: r.cal, at: r.at } : null;
	}

	/// Adopt a choice from another device: the strictly fresher `at` wins and is written
	/// verbatim. A record the box refuses throws, so the section is pulled again.
	function adoptSync(r) {
		if (!r || typeof r !== 'object' || !CALS[r.cal] || !ms(r.at)) return;
		var mine = readRec(), next = { cal: r.cal, at: ms(r.at) };
		if (fresher(mine, next) !== next || (mine && mine.at === next.at && mine.cal === next.cal)) return;
		writeRec(next, true);
		adopt(next);
	}

	/// The formatters as a `<script>` for a page frame, fixed to the current calendar.
	/// The page gets no way to change it: the choice is the account's.
	function frameTag() {
		return '<script>window.DaimondTime=(' + make.toString() + ')(' + JSON.stringify(cur.calendar()) + ');<\/script>';
	}

	window.DaimondTime = {
		fmt:          function (ts) { return cur.fmt(ts); },
		fmtShort:     function (ts) { return cur.fmtShort(ts); },
		fmtFull:      function (ts) { return cur.fmtFull(ts); },
		fmtDate:      function (v) { return cur.fmtDate(v); },
		fmtIso:       function (v) { return cur.fmtIso(v); },
		year:         function (d) { return cur.year(d); },
		calendar:     function () { return cur.calendar(); },
		setCalendar:  setCalendar,
		syncSnapshot: syncSnapshot,        // for collectSync
		adoptSync:    adoptSync,           // for applySync
		frameTag:     frameTag,            // for crystal.js's armour
	};
})();
