/* ============================================================
   Daimond — per-turn cost ledger (DaimondLedger)
   ------------------------------------------------------------
   An append-only record of what each turn cost, kept in
   localStorage so spend survives a reload. Every turn the app
   completes is handed to `record`, which prices it through
   `DaimondPricing` and stores a compact entry. The getters roll the
   log up into day, session, weekly and monthly totals for the meters.

   Storage is bounded: entries older than ~90 days are pruned on
   write AND on every merge (`merge`, used by sync collect, sync
   apply and backup restore alike), so a device that never records
   its own turns cannot hand pruned entries back to one that does.
   A corrupt or absent store degrades to an empty ledger rather
   than throwing.

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
			if (!e || e.r || e.rp || e.ol) continue;	// `ol`: outcome-only, nothing to price
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
		notifyChanged();
	}

	/// Tell whoever is on screen that the ledger moved -- a panel sitting open
	/// in the dock (`modeldash.js`) redraws on this rather than only on its own
	/// Refresh button. The one event name, so a live merge (`daimond.js`'s
	/// `mergeLedgers` call sites, which write the store directly and cannot
	/// call `save` above) fires the exact same signal rather than a second one
	/// nothing listens for. Best-effort: no `window` (a node test harness) or
	/// no `CustomEvent`/`Event` is the ordinary case for most callers of this
	/// file, not a fault.
	function notifyChanged() {
		try { window.dispatchEvent(new Event('daimond:ledger')); } catch (e) { /* no window */ }
	}

	// Drop entries older than the retention window, bounding
	// storage. `now` is supplied so pruning shares the caller's
	// clock with the write that triggered it.
	function prune(entries, now) {
		var cutoff = now - PRUNE_MS;
		return entries.filter(function (e) { return e && typeof e.t === 'number' && e.t >= cutoff; });
	}

	/// The retention window in ms (~90 days), for a caller that needs to
	/// anchor its own cutoff -- `merge` below is the one that should.
	function retentionMs() { return PRUNE_MS; }

	// ── Cross-device merge ──────────────────────────────────────
	// The moment, the model, the token counts and whose key paid -- two
	// ledgers naming the same millisecond, model, tokens and provider are
	// naming one turn. Deliberately NOT the price: an entry the provider
	// never billed is re-priced in place when the rate table is corrected
	// (`u` changes, `u0` keeps the old guess), so a key that included the
	// price would see the same turn twice and double the user's spend on
	// the strength of our own arithmetic.
	function ledgerKey(e) {
		return [e.t, e.m || '', e.p || 0, e.c || 0, e.ca || 0, e.pv || ''].join('|');
	}

	/// Merge two spend ledgers by UNION, keeping `mine` where both hold a
	/// turn, then PRUNE the result -- so pruning holds across every path an
	/// incoming ledger can arrive by (a sync collect, a sync apply, a backup
	/// restore), not only the device that happens to call `record`. Without
	/// this a dispatch-only device that never records hands every entry the
	/// runner already pruned straight back on its next pull, and the runner
	/// re-adds them on its next push -- the ledger never shrinks.
	///
	/// A ledger is an append-only record of money that actually moved, and
	/// two ledgers of one account differ only by turns the other has not
	/// seen -- never by disagreeing about a turn they both hold. So union is
	/// the only merge that cannot lose spend before the prune runs.
	///
	/// The cutoff is `min(now, newest.t + 1 day) - retentionMs()`, anchored
	/// to the NEWEST entry the union holds rather than to `now` alone: a
	/// device whose clock has drifted into the future cannot drag the
	/// window forward and prune entries that are genuinely within 90 days
	/// of the fleet's real activity, and a clock that has drifted into the
	/// past only ever keeps more than the window strictly requires. `now`
	/// still caps it so a clock behind the newest entry cannot treat that
	/// entry as fresher than it is.
	///
	/// Sorted by time, so the result is a function of its inputs and not of
	/// the order they were read in -- the sync parcel is compared
	/// byte-for-byte to decide whether there is anything to push, and a
	/// merge that reordered itself would push for ever.
	///
	/// # Arguments
	/// * `mine` - This device's ledger, which wins any tie.
	/// * `theirs` - The incoming ledger, from a backup file or another device.
	/// * `now` - The caller's clock, epoch-ms.
	function merge(mine, theirs, now) {
		var out = [], seen = {};
		function take(list) {
			(Array.isArray(list) ? list : []).forEach(function (e) {
				if (!e || typeof e.t !== 'number') return;
				var k = ledgerKey(e);
				if (seen[k]) return;
				seen[k] = 1;
				out.push(e);
			});
		}
		take(mine);
		take(theirs);
		if (out.length === 0) return out;
		var newest = out.reduce(function (m, e) { return e.t > m ? e.t : m; }, -Infinity);
		var cutoff = Math.min(now, newest + DAY_MS) - PRUNE_MS;
		out = out.filter(function (e) { return e.t >= cutoff; });
		out.sort(function (a, b) {
			if (a.t !== b.t) return a.t - b.t;
			var ka = ledgerKey(a), kb = ledgerKey(b);
			return ka < kb ? -1 : ka > kb ? 1 : 0;
		});
		return out;
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
	///   turnId           — the turn this entry prices, when the caller ran one
	///                      (chat and daimon-steer turns do; a whole-chat fold
	///                      spends against no single turn and passes none).
	///                      Stored as `tid`, so the debug feed's own `turn.end`
	///                      -- which has always carried the same id -- can join
	///                      this entry to it by identity instead of guessing
	///                      from device, clock skew and prompt size, which is
	///                      what let a synced copy of this entry be shown under
	///                      a device that never ran the turn (`dev/lens.mjs`).
	///
	/// A reported `costUsd` is stored VERBATIM and the entry is
	/// flagged `r`. It is the money that actually moved, so nothing
	/// re-derives it: pricing a turn from token counts and a rate
	/// table is a guess about a router's negotiated price and a
	/// cache discount, and that guess ran about six times high.
	/// Absent a reported figure the table prices it as before, now
	/// with the real cached count.
	///
	/// The stored entry is compact: `{ t, m, p, c, ca, u, pv, r, e, tid, dur, out, ol }`
	/// where `u` is USD. Returns the entry, or null when the input is
	/// unusable.
	///
	/// `durationMs` and `outcome` are additive: how long the turn took, end to
	/// end, and how it ended -- `'completed'`, `'failed'` or `'interrupted'`.
	/// Neither changes what is billed; a caller that never passes them gets
	/// exactly the entry it always got. `outcomeOnly` is for a turn that never
	/// billed anything at all (a failure before a single token came back, or
	/// one the user stopped before that point) -- it skips pricing entirely
	/// (there is nothing to price) and marks the entry `ol`, so the turn/cost
	/// aggregates in `perModel` -- which counted only billed turns before this
	/// build and must go on doing so -- pass over it, while the duration and
	/// outcome it carries are still counted.
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
		if (turn.outcomeOnly) {
			// Nothing was billed -- there is nothing to price, and asking
			// `DaimondPricing` for zero tokens would only risk it marking a
			// true zero as `estimated`.
		} else if (reported !== null) {
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
		if (!turn.outcomeOnly && reported !== null) entry.r = 1;
		if (turn.turnId) entry.tid = String(turn.turnId);
		if (typeof turn.durationMs === 'number' && isFinite(turn.durationMs) && turn.durationMs >= 0) {
			entry.dur = Math.round(turn.durationMs);
		}
		if (turn.outcome === 'completed' || turn.outcome === 'failed' || turn.outcome === 'interrupted') {
			entry.out = turn.outcome;
		}
		if (turn.outcomeOnly) entry.ol = 1;
		var entries = load();
		entries.push(entry);
		entries = prune(entries, turn.ts);
		save(entries);
		return entry;
	}

	/// Attach a duration and an outcome to the entry already recorded for
	/// `turnId` -- for the common case, a billed turn whose cost `record()`
	/// already wrote before its duration and outcome were known (both are
	/// only settled once the turn has fully ended). Finds the MOST RECENT
	/// entry carrying that `tid` and patches it in place; a no-op, returning
	/// null, when no such entry exists -- the caller's own fallback is to
	/// `record` a fresh `outcomeOnly` entry instead, for a turn that billed
	/// nothing to patch.
	///
	/// Best-effort like every other write here: a caller that races this
	/// against nothing (there is no concurrent write path in a single tab)
	/// simply finds what `record` last wrote.
	function patchOutcome(turnId, durationMs, outcome) {
		if (!turnId) return null;
		var entries = load();
		var tid = String(turnId);
		for (var i = entries.length - 1; i >= 0; i--) {
			var e = entries[i];
			if (!e || e.tid !== tid) continue;
			if (typeof durationMs === 'number' && isFinite(durationMs) && durationMs >= 0) {
				e.dur = Math.round(durationMs);
			}
			if (outcome === 'completed' || outcome === 'failed' || outcome === 'interrupted') {
				e.out = outcome;
			}
			save(entries);
			return e;
		}
		return null;
	}

	// ── Aggregation ────────────────────────────────────────────
	// Tokens counted in a total are prompt + completion (cached
	// tokens are a subset of the prompt, so they are not added
	// again).
	function tokensOf(e) { return (e.p || 0) + (e.c || 0); }

	// The middle value of a numeric array, or null when it is empty. The
	// median rather than the mean, so one very slow (or very fast) turn does
	// not swing the figure the way an outlier swings an average -- the same
	// reason the Leaders design (`daimond_leaderboards_design.md`) medians
	// cost-per-turn across contributors instead of summing it.
	function median(nums) {
		if (!nums || nums.length === 0) return null;
		var sorted = nums.slice().sort(function (a, b) { return a - b; });
		var mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	}

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

	/// Rolled-up totals for the meters: `{ day, session, week, month }`,
	/// each `{ usd, tokens }`. Day is local midnight to now -- a calendar
	/// question, so NOT a rolling 24h, which would start the day at a
	/// different time every hour. Session is the tail of activity with
	/// no ≥15 min gap; week and month are the rolling last 7 and 30
	/// days. This getter reads the clock (`Date.now`).
	function totals() {
		var entries = reprice(load());
		var now = Date.now();
		// Midnight today, local, as `series` also takes it: the day window
		// is today's calendar day, not the trailing 24 hours.
		var d0 = new Date();
		d0.setHours(0, 0, 0, 0);
		return {
			day:     sum(since(entries, d0.getTime())),
			session: sum(sessionSlice(entries, now)),
			week:    sum(since(entries, now - WEEK_MS)),
			month:   sum(since(entries, now - MONTH_MS)),
		};
	}

	// The entries a named period covers: 'session', 'week' or 'month'
	// (anything else reads as a month, the widest and safest default).
	function periodSlice(entries, period, now) {
		if (period === 'session') return sessionSlice(entries, now);
		if (period === 'week') return since(entries, now - WEEK_MS);
		return since(entries, now - MONTH_MS);
	}

	/// Per-model breakdown for a period. `period` is one of 'session',
	/// 'week', 'month' (default 'month'). Returns an array of
	/// `{ model, usd, tokens, prompt, completion, turns, reportedUsd,
	/// medianTurnMs, turnsCompleted, turnsFailed, turnsStopped, outcomeTurns,
	/// failureRate }`, sorted by descending cost -- `tokens` is
	/// `prompt + completion` as before, and the two are also split out so a
	/// caller that needs "in vs out" (the model dashboard's contribution
	/// preview, which mirrors the Leaders board's per-field table) does not
	/// re-walk the ledger to get what this function had already summed. This
	/// getter reads the clock.
	///
	/// The outcome fields are read off `dur`/`out`/`ol`, which a turn only
	/// carries once the app has been built with turn-time tracking; an
	/// older entry has neither and is silently excluded from them, the same
	/// way it was excluded from `reportedUsd` before this field existed.
	/// `turnsFailed` and `turnsStopped` use the app's own established words
	/// (`modeldash.js`'s `gapFields`/`gap_note`) for what the ledger itself
	/// stores as the outcome `'failed'` / `'interrupted'`. `medianTurnMs` is
	/// null, and `failureRate` is null, when no turn in the window carries a
	/// duration or an outcome -- a window with no data says so rather than
	/// showing a zero it did not earn.
	function perModel(period) {
		var entries = reprice(load());
		var slice = periodSlice(entries, period, Date.now());

		var by = {};	// model id → accumulator
		for (var i = 0; i < slice.length; i++) {
			var e = slice[i];
			var m = e.m || '';
			if (!by[m]) by[m] = { model: m, usd: 0, tokens: 0, prompt: 0, completion: 0, turns: 0, reportedUsd: 0 };
			// Outcome accumulators, kept off the object literal above (as a
			// separate statement guarded the same way) so the `nosplit` break
			// in modeldash.test.mjs -- which patches that exact literal --
			// still finds it unchanged.
			if (!by[m]._durs) { by[m]._durs = []; by[m]._completed = 0; by[m]._failed = 0; by[m]._interrupted = 0; }
			// An `ol` (outcome-only) entry billed nothing and must not
			// inflate the turn/cost figures the table already showed --
			// only a billed entry (the shape every entry had before this
			// build) counts toward them.
			if (!e.ol) {
				by[m].usd += e.u || 0;
				by[m].tokens += tokensOf(e);
				by[m].prompt += e.p || 0;
				by[m].completion += e.c || 0;
				by[m].turns += 1;
				if (e.r) by[m].reportedUsd += e.u || 0;
			}
			if (typeof e.dur === 'number' && e.dur >= 0) by[m]._durs.push(e.dur);
			if (e.out === 'completed') by[m]._completed += 1;
			else if (e.out === 'failed') by[m]._failed += 1;
			else if (e.out === 'interrupted') by[m]._interrupted += 1;
		}
		var out = [];
		for (var k in by) {
			var acc = by[k];
			var outcomeTurns = acc._completed + acc._failed + acc._interrupted;
			acc.medianTurnMs   = median(acc._durs);
			acc.turnsCompleted = acc._completed;
			acc.turnsFailed    = acc._failed;
			acc.turnsStopped   = acc._interrupted;
			acc.outcomeTurns   = outcomeTurns;
			acc.failureRate    = outcomeTurns > 0 ? (acc._failed + acc._interrupted) / outcomeTurns : null;
			delete acc._durs; delete acc._completed; delete acc._failed; delete acc._interrupted;
			out.push(acc);
		}
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

	/// What the one-time reprice changed inside a period:
	/// `{ turns, usd, was }` over the entries it touched -- `usd` as they
	/// price now, `was` as they were first guessed. `period` is 'session',
	/// 'week' or 'month' (default 'month'). This getter reads the clock.
	///
	/// A total that quietly halves is a total nobody trusts, so the panel
	/// quotes the figure the period used to read. Only an entry carrying
	/// both the `rp` mark and its original `u0` counts: a billed turn was
	/// never touched, and a guess made since the table was fixed was
	/// always right. A window holding none answers with zeros, so the
	/// explanation retires itself as the log ages the old entries out.
	function repriced(period) {
		var slice = periodSlice(reprice(load()), period, Date.now());
		var out = { turns: 0, usd: 0, was: 0 };
		for (var i = 0; i < slice.length; i++) {
			var e = slice[i];
			if (!e || !e.rp || typeof e.u0 !== 'number') continue;
			out.turns += 1;
			out.usd += e.u || 0;
			out.was += e.u0;
		}
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
		record:       record,
		patchOutcome: patchOutcome,
		totals:      totals,
		perModel:    perModel,
		perProvider: perProvider,
		repriced:    repriced,
		series:      series,
		samples:     samples,
		clear:       clear,
		merge:       merge,
		notifyChanged: notifyChanged,	// for a caller that writes the store directly (a sync merge, a backup restore)
		ledgerKey:   ledgerKey,
		retentionMs: retentionMs,
	};
})();
