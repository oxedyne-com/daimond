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

	// ── One-time repricing of historical guesses ───────────────
	// Entries priced before 2026-07-31 were guessed from a rate table that ran
	// about six times high (direct-provider list prices, cached tokens billed
	// at the full input rate). The table is fixed, but the old guesses sat in
	// the log and kept inflating every total -- the user rightly did not trust
	// them. So an entry the provider did NOT bill (`r` absent) is re-priced
	// once under the corrected table, keeping the original figure in `u0` so
	// nothing is silently rewritten without a trace. A reported entry is money
	// that actually moved and is never touched.
	var repricedThisLife = false;	// one pass per page life is enough
	function reprice(entries) {
		if (repricedThisLife) return entries;
		if (!window.DaimondPricing || typeof window.DaimondPricing.priceFor !== 'function') {
			return entries;	// pricing not loaded yet -- try again on the next read.
		}
		repricedThisLife = true;
		var changed = false;
		for (var i = 0; i < entries.length; i++) {
			var e = entries[i];
			if (!e || e.r || e.rp) continue;
			var res;
			try { res = window.DaimondPricing.priceFor(e.m || '', e.p || 0, e.c || 0, e.ca || 0, e.pv || ''); }
			catch (err) { continue; }
			if (!res || typeof res.usd !== 'number') continue;
			e.u0 = e.u;	// the figure as originally guessed.
			e.u  = res.usd;
			e.e  = !!res.estimated;
			e.rp = 1;	// repriced -- never again.
			changed = true;
		}
		if (changed) save(entries);
		return entries;
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
	///   costUsd          — what the PROVIDER said the turn cost.
	///   provider         — provider id, for a per-key breakdown.
	///
	/// A reported `costUsd` is stored VERBATIM and the entry is
	/// flagged `r`. It is the money that actually moved, so nothing
	/// re-derives it: pricing a turn from token counts and a rate
	/// table is a guess about a router's negotiated price and a
	/// cache discount, and that guess ran about six times high.
	/// Absent a reported figure the table prices it as before, now
	/// with the real cached count.
	///
	/// The stored entry is compact: `{ t, m, p, c, ca, u, pv, r, e }`
	/// where `u` is USD. Returns the entry, or null when the input is
	/// unusable.
	function record(turn) {
		if (!turn || typeof turn.ts !== 'number') return null;
		var model = turn.model || '';
		var provider = turn.provider || '';
		var p = Math.max(0, turn.promptTokens || 0);
		var c = Math.max(0, turn.completionTokens || 0);
		var ca = Math.max(0, turn.cachedTokens || 0);
		var reported = (typeof turn.costUsd === 'number' && isFinite(turn.costUsd)
			&& turn.costUsd > 0) ? turn.costUsd : null;

		var usd = 0, estimated = false;
		if (reported !== null) {
			usd = reported;
		} else if (window.DaimondPricing && typeof window.DaimondPricing.priceFor === 'function') {
			// Price through DaimondPricing; if it is somehow absent, record
			// a zero-cost entry rather than throwing (tokens are kept).
			var res = window.DaimondPricing.priceFor(model, p, c, ca, provider);
			usd = (res && typeof res.usd === 'number') ? res.usd : 0;
			estimated = !!(res && res.estimated);
		}

		// `e` marks a cost nobody published a rate for, so a total containing one
		// can be shown as approximate rather than stated as fact. `r` marks the
		// opposite and stronger case: the provider said what it charged, so the
		// figure is not an approximation at all and must not be dressed as one.
		var entry = { t: turn.ts, m: model, p: p, c: c, ca: ca, u: usd, e: estimated };
		if (provider) entry.pv = provider;
		if (reported !== null) entry.r = 1;
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

	// Sum a slice of entries into `{ usd, tokens, estimated, reportedUsd }`.
	//
	// `reportedUsd` is the part of the total the providers themselves stated.
	// A caller can then say which it is holding: equal to `usd` means every
	// turn in the window came with a bill, and there is nothing approximate
	// about it. Old entries carry no `r`, so they count as priced -- which is
	// what they were.
	function sum(slice) {
		var usd = 0, tokens = 0, estimated = false, reportedUsd = 0;
		for (var i = 0; i < slice.length; i++) {
			usd += slice[i].u || 0;
			tokens += tokensOf(slice[i]);
			if (slice[i].e) estimated = true;
			if (slice[i].r) reportedUsd += slice[i].u || 0;
		}
		return { usd: usd, tokens: tokens, estimated: estimated, reportedUsd: reportedUsd };
	}

	// The current session: walk the sorted log back from the most
	// recent entry, keeping entries while each is within the
	// session gap of its successor. The first larger gap ends the
	// session, so the slice is the tail of uninterrupted activity.
	//
	// The same gap ends the session against NOW: a tail that stopped
	// twenty minutes ago is the PREVIOUS session, not this one. Without
	// this, last night's spend read as "This session" all morning -- a
	// figure that never moved and so could never be trusted.
	function sessionSlice(entries, now) {
		var sorted = entries
			.filter(function (e) { return e && typeof e.t === 'number'; })
			.sort(function (a, b) { return a.t - b.t; });
		if (sorted.length === 0) return [];
		if (typeof now === 'number' && now - sorted[sorted.length - 1].t >= SESSION_GAP_MS) {
			return [];	// the last activity already ended its session.
		}
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
		var entries = reprice(load());
		var now = Date.now();
		return {
			session: sum(sessionSlice(entries, now)),
			week:    sum(since(entries, now - WEEK_MS)),
			month:   sum(since(entries, now - MONTH_MS)),
		};
	}

	/// Per-model breakdown for a period, for a future UI. `period`
	/// is one of 'session', 'week', 'month' (default 'month').
	/// Returns an array of `{ model, usd, tokens, turns }`, sorted
	/// by descending cost. This getter reads the clock.
	function perModel(period) {
		var entries = reprice(load());
		var now = Date.now();
		var slice;
		if (period === 'session') slice = sessionSlice(entries, now);
		else if (period === 'week') slice = since(entries, now - WEEK_MS);
		else slice = since(entries, now - MONTH_MS);	// default: month

		var by = {};	// model id → accumulator
		for (var i = 0; i < slice.length; i++) {
			var e = slice[i];
			var m = e.m || '';
			if (!by[m]) by[m] = { model: m, usd: 0, tokens: 0, turns: 0, reportedUsd: 0 };
			by[m].usd += e.u || 0;
			by[m].tokens += tokensOf(e);
			by[m].turns += 1;
			if (e.r) by[m].reportedUsd += e.u || 0;
		}
		var out = [];
		for (var k in by) out.push(by[k]);
		out.sort(function (a, b) { return b.usd - a.usd; });
		return out;
	}

	/// Per-provider breakdown from `since` (epoch-ms) to now.
	///
	/// This is what a manual credit tally counts down: the user says
	/// "I had $12 as of now", and what they have left is that figure
	/// minus everything spent on that provider's key SINCE that
	/// moment. So the window is an explicit instant, not one of the
	/// named periods -- a rolling month cannot answer the question.
	///
	/// Entries written before providers were recorded carry no `pv`
	/// and are grouped under `''`; a caller asking about a named
	/// provider therefore never sees them, which is right, since
	/// nothing knows whose key they spent.
	///
	/// Returns `[{ provider, usd, tokens, turns, reportedUsd }]`,
	/// dearest first. Reads no clock: `since` is the whole window.
	function perProvider(sinceMs) {
		var from = (typeof sinceMs === 'number' && isFinite(sinceMs)) ? sinceMs : 0;
		var slice = since(reprice(load()), from);
		var by = {};	// provider id → accumulator
		for (var i = 0; i < slice.length; i++) {
			var e = slice[i];
			var pv = e.pv || '';
			if (!by[pv]) by[pv] = { provider: pv, usd: 0, tokens: 0, turns: 0, reportedUsd: 0 };
			by[pv].usd += e.u || 0;
			by[pv].tokens += tokensOf(e);
			by[pv].turns += 1;
			if (e.r) by[pv].reportedUsd += e.u || 0;
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
		var entries = reprice(load());
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
		return reprice(load()).map(function (e) { return { t: e.t, u: e.u || 0 }; });
	}

	window.DaimondLedger = {
		record:      record,
		totals:      totals,
		perModel:    perModel,
		perProvider: perProvider,
		series:      series,
		samples:     samples,
		clear:       clear,
	};
})();
