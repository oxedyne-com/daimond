/* ============================================================
   Daimond — per-turn cost ledger (DaimondLedger)
   ------------------------------------------------------------
   An append-only record of what each turn cost, kept in
   localStorage so spend survives a reload. Every turn the app
   completes is handed to `record`, which prices it through
   `DaimondPricing` and stores a compact entry. The getters roll the
   log up into session, weekly and monthly totals for the meters.

   Storage is bounded: entries older than ~90 days are pruned on
   write, so the log cannot grow without limit. A corrupt or
   absent store degrades to an empty ledger rather than throwing.

   Depends on `window.DaimondPricing` (loaded first). Attaches a
   single global, `window.DaimondLedger`.
   ============================================================ */
(function () {
	'use strict';

	var KEY = 'daimond-ledger';					// localStorage key
	var DAY_MS = 24 * 60 * 60 * 1000;		// one day in ms
	var PRUNE_MS = 90 * DAY_MS;				// retain ~90 days
	var WEEK_MS = 7 * DAY_MS;				// rolling week
	var MONTH_MS = 30 * DAY_MS;				// rolling month
	var SESSION_GAP_MS = 15 * 60 * 1000;	// a ≥15 min gap ends a session

	// ── Store I/O ──────────────────────────────────────────────
	// Read the whole log. Any parse failure or non-array value
	// yields an empty log so a corrupt store never propagates.
	function load() {
		try {
			var raw = localStorage.getItem(KEY);
			if (!raw) return [];
			var arr = JSON.parse(raw);
			return Array.isArray(arr) ? arr : [];
		} catch (e) {
			return [];
		}
	}

	// Persist the log, swallowing quota/availability errors: a
	// failed write must never break the turn that triggered it.
	function save(entries) {
		try {
			localStorage.setItem(KEY, JSON.stringify(entries));
		} catch (e) {
			/* quota or unavailable — spend stays in-memory this session */
		}
	}

	// Drop entries older than the retention window, bounding
	// storage. `now` is supplied so pruning shares the caller's
	// clock with the write that triggered it.
	function prune(entries, now) {
		var cutoff = now - PRUNE_MS;
		return entries.filter(function (e) { return e && typeof e.t === 'number' && e.t >= cutoff; });
	}

	// ── Recording ──────────────────────────────────────────────

	/// Price and append one completed turn.
	///
	/// The caller supplies `ts` (epoch-ms) so the ledger never
	/// reads the clock on the write path; the getters own the
	/// notion of "now". Fields:
	///   ts               — epoch-ms of the turn.
	///   model            — model id, for pricing and breakdowns.
	///   promptTokens     — input tokens.
	///   completionTokens — output tokens.
	///   cachedTokens     — cached-input tokens (subset of prompt).
	///
	/// The stored entry is compact: `{ t, m, p, c, ca, u }` where
	/// `u` is the computed USD cost. Returns the entry, or null
	/// when the input is unusable.
	function record(turn) {
		if (!turn || typeof turn.ts !== 'number') return null;
		var model = turn.model || '';
		var p = Math.max(0, turn.promptTokens || 0);
		var c = Math.max(0, turn.completionTokens || 0);
		var ca = Math.max(0, turn.cachedTokens || 0);

		// Price through DaimondPricing; if it is somehow absent, record
		// a zero-cost entry rather than throwing (tokens are kept).
		var usd = 0, estimated = false;
		if (window.DaimondPricing && typeof window.DaimondPricing.priceFor === 'function') {
			var res = window.DaimondPricing.priceFor(model, p, c, ca);
			usd = (res && typeof res.usd === 'number') ? res.usd : 0;
			estimated = !!(res && res.estimated);
		}

		// `e` marks a cost the pricing table could only estimate (the model was
		// not in it), so a total containing one can be shown as approximate
		// rather than stated as fact.
		var entry = { t: turn.ts, m: model, p: p, c: c, ca: ca, u: usd, e: estimated };
		var entries = load();
		entries.push(entry);
		entries = prune(entries, turn.ts);
		save(entries);
		return entry;
	}

	// ── Aggregation ────────────────────────────────────────────
	// Tokens counted in a total are prompt + completion (cached
	// tokens are a subset of the prompt, so they are not added
	// again).
	function tokensOf(e) { return (e.p || 0) + (e.c || 0); }

	// Entries at or after `since`, chronologically sorted.
	function since(entries, since) {
		return entries
			.filter(function (e) { return e && typeof e.t === 'number' && e.t >= since; })
			.sort(function (a, b) { return a.t - b.t; });
	}

	// Sum a slice of entries into `{ usd, tokens }`.
	function sum(slice) {
		var usd = 0, tokens = 0, estimated = false;
		for (var i = 0; i < slice.length; i++) {
			usd += slice[i].u || 0;
			tokens += tokensOf(slice[i]);
			if (slice[i].e) estimated = true;
		}
		return { usd: usd, tokens: tokens, estimated: estimated };
	}

	// The current session: walk the sorted log back from the most
	// recent entry, keeping entries while each is within the
	// session gap of its successor. The first larger gap ends the
	// session, so the slice is the tail of uninterrupted activity.
	function sessionSlice(entries) {
		var sorted = entries
			.filter(function (e) { return e && typeof e.t === 'number'; })
			.sort(function (a, b) { return a.t - b.t; });
		if (sorted.length === 0) return [];
		var start = sorted.length - 1;
		for (var i = sorted.length - 1; i > 0; i--) {
			if (sorted[i].t - sorted[i - 1].t < SESSION_GAP_MS) start = i - 1;
			else break;
		}
		return sorted.slice(start);
	}

	/// Rolled-up totals for the meters: `{ session, week, month }`,
	/// each `{ usd, tokens }`. Session is the tail of activity with
	/// no ≥15 min gap; week and month are the rolling last 7 and 30
	/// days. This getter reads the clock (`Date.now`).
	function totals() {
		var entries = load();
		var now = Date.now();
		return {
			session: sum(sessionSlice(entries)),
			week:    sum(since(entries, now - WEEK_MS)),
			month:   sum(since(entries, now - MONTH_MS)),
		};
	}

	/// Per-model breakdown for a period, for a future UI. `period`
	/// is one of 'session', 'week', 'month' (default 'month').
	/// Returns an array of `{ model, usd, tokens, turns }`, sorted
	/// by descending cost. This getter reads the clock.
	function perModel(period) {
		var entries = load();
		var now = Date.now();
		var slice;
		if (period === 'session') slice = sessionSlice(entries);
		else if (period === 'week') slice = since(entries, now - WEEK_MS);
		else slice = since(entries, now - MONTH_MS);	// default: month

		var by = {};	// model id → accumulator
		for (var i = 0; i < slice.length; i++) {
			var e = slice[i];
			var m = e.m || '';
			if (!by[m]) by[m] = { model: m, usd: 0, tokens: 0, turns: 0 };
			by[m].usd += e.u || 0;
			by[m].tokens += tokensOf(e);
			by[m].turns += 1;
		}
		var out = [];
		for (var k in by) out.push(by[k]);
		out.sort(function (a, b) { return b.usd - a.usd; });
		return out;
	}

	// A local calendar day key, 'YYYY-MM-DD', for bucketing a graph.
	function dayKey(d) {
		var y = d.getFullYear();
		var m = d.getMonth() + 1;
		var day = d.getDate();
		return y + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
	}

	/// Daily spend buckets for the last `days` calendar days (default 30),
	/// oldest first, for a time graph. Every day in the window is present even
	/// when nothing was spent, so the graph has no gaps to mislead the eye.
	/// Each bucket is `{ day, ts, usd, tokens, turns }`. Reads the clock.
	function series(days) {
		var n = (typeof days === 'number' && days > 0) ? Math.floor(days) : 30;
		var entries = load();
		// Midnight today, local, is the newest bucket's day.
		var d0 = new Date();
		d0.setHours(0, 0, 0, 0);
		var buckets = [];
		var index = {};	// dayKey → position in buckets
		for (var i = n - 1; i >= 0; i--) {
			var d = new Date(d0.getTime() - i * DAY_MS);
			var key = dayKey(d);
			index[key] = buckets.length;
			buckets.push({ day: key, ts: d.getTime(), usd: 0, tokens: 0, turns: 0 });
		}
		for (var j = 0; j < entries.length; j++) {
			var e = entries[j];
			if (!e || typeof e.t !== 'number') continue;
			var pos = index[dayKey(new Date(e.t))];
			if (pos === undefined) continue;	// outside the window
			buckets[pos].usd += e.u || 0;
			buckets[pos].tokens += tokensOf(e);
			buckets[pos].turns += 1;
		}
		return buckets;
	}

	/// Erase the entire ledger (e.g. a user "clear spend" action).
	function clear() {
		try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
	}

	/// The raw priced turns, `[{ t, u }]` (epoch-ms and USD), for a
	/// consumer that needs the samples themselves rather than a
	/// rolled-up total — the spend governor learns a baseline from
	/// them. A thin projection of the store, so the storage key
	/// stays owned here and is never read twice.
	function samples() {
		return load().map(function (e) { return { t: e.t, u: e.u || 0 }; });
	}

	window.DaimondLedger = {
		record:   record,
		totals:   totals,
		perModel: perModel,
		series:   series,
		samples:  samples,
		clear:    clear,
	};
})();
