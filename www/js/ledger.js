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
	//
	// Through `DaimondStore`, so a turn's spend the box refused is still here: held
	// owed in this tab, merged over what is stored, retried and said (SIM-10).
	function load() {
		var arr = window.DaimondStore.get(KEY, []);
		return Array.isArray(arr) ? arr : [];
	}

	/// The owed ledger merged with the stored one by the join law below, which does
	/// not care which side is which: what this tab owes (a patched outcome) is a
	/// field the stored copy lacks, and the join keeps it.
	function law(stored, owed) { return merge(owed, stored, Date.now()); }

	// ── Repricing of historical guesses ────────────────────────
	// Entries priced before 2026-07-31 were guessed from a rate table that ran
	// about six times high (direct-provider list prices, cached tokens billed
	// at the full input rate). The table is fixed, but the old guesses sat in
	// the log and kept inflating every total -- the user rightly did not trust
	// them. So an entry the provider did NOT bill (`r` absent) and that was
	// priced before the correction is shown re-priced under the corrected
	// table, keeping the original figure in `u0` so nothing is silently
	// rewritten without a trace. A reported entry is money that actually moved
	// and is never touched, and an entry priced since the correction was priced
	// by the corrected table and has nothing to migrate.
	//
	// A VIEW, never a write. Saving the mark from a read made the synced entry
	// differ between two devices by when each first looked (soak R1, R2): the
	// store keeps what was recorded, every reader sees the same figure, and an
	// entry an older build already marked arrives marked and joins over the
	// unmarked copy (`join`).
	var CORRECTED_MS = Date.UTC(2026, 6, 31);	// the day the rate table was corrected
	function reprice(entries) {
		if (!window.DaimondPricing || typeof window.DaimondPricing.priceFor !== 'function') {
			return entries;	// pricing not loaded yet -- try again on the next read.
		}
		var out = null;		// copied on the first change only
		for (var i = 0; i < entries.length; i++) {
			var e = entries[i];
			if (!e || e.r || e.rp || e.ol || !(e.t < CORRECTED_MS)) continue;	// `ol`: outcome-only, nothing to price
			var res;
			try { res = window.DaimondPricing.priceFor(e.m || '', e.p || 0, e.c || 0, e.ca || 0, e.pv || ''); }
			catch (err) { continue; }
			if (!res || typeof res.usd !== 'number') continue;
			if (!out) out = entries.slice();
			var v = {};
			for (var k in e) v[k] = e[k];
			v.u0 = e.u;	// the figure as originally guessed.
			v.u  = res.usd;
			v.e  = !!res.estimated;
			v.rp = 1;	// repriced -- never again.
			out[i] = v;
		}
		return out || entries;
	}

	// Persist the log. A write the box refuses never breaks the turn that made
	// it, and is never dropped either: `DaimondStore` holds it owed and says so.
	// True when it landed.
	function save(entries) {
		var ok = window.DaimondStore.put(KEY, entries, law);
		notifyChanged();
		return ok;
	}

	/// Tell whoever is on screen that the ledger moved -- a panel sitting open
	/// in the dock (`modeldash.js`) redraws on this rather than only on its own
	/// Refresh button. `adopt` below fires it too, so a sync merge or a backup
	/// restore raises the one signal a panel listens for. Best-effort: no `window` (a node test harness) or
	/// no `CustomEvent`/`Event` is the ordinary case for most callers of this
	/// file, not a fault.
	function notifyChanged() {
		try { window.dispatchEvent(new Event('daimond:ledger')); } catch (e) { /* no window */ }
	}

	/// The retention window in ms (~90 days), for a caller that needs to
	/// anchor its own cutoff -- `merge` below is the one that should.
	function retentionMs() { return PRUNE_MS; }

	// ── Cross-device merge ──────────────────────────────────────
	// The moment, the model, the token counts and whose key paid -- two
	// ledgers naming the same millisecond, model, tokens and provider are
	// naming one turn. Deliberately NOT the price: an entry the provider
	// never billed is re-priced when the rate table is corrected (`u`
	// changes, `u0` keeps the old guess), so a key that included the price
	// would see the same turn twice and double the user's spend on the
	// strength of our own arithmetic.
	function ledgerKey(e) {
		return [e.t, e.m || '', e.p || 0, e.c || 0, e.ca || 0, e.pv || ''].join('|');
	}

	// ── The join law ────────────────────────────────────────────
	// Two copies of one turn (one `ledgerKey`) join FIELD BY FIELD, each field by
	// its own declared rule, so the join is commutative, associative and
	// idempotent and every device that meets the same copies holds the same
	// bytes -- whichever it met first, whichever the caller named `mine`.
	//
	//   The price -- `u`, `e`, `r`, `rp`, `u0` -- is one claim about what the
	//   turn cost, so it travels whole, from the copy that stands highest: a
	//   billed copy (`r`: money that moved) over a repriced one (`rp`) over a
	//   guess; then the greater `u`, so a join never understates spend; then
	//   the canonical form.
	//
	//   Every other field -- the key's own, `tid`, `dur`, `out`, `ol`, and any
	//   a later build adds -- is present over absent, and on a clash the
	//   greater value: numbers by value, anything else by its JSON text in
	//   code points, so no locale decides it.
	//
	// The result is the entry in ONE key order (`FIELD_ORDER`, then any other
	// field by name), so key order is never content.
	//
	// The turn facts (`ft im ro sg tc te`, MC1) come LAST and in name order: that is
	// exactly where a build that has never heard of them puts them (any other field,
	// by name), so an r541 device and this one write the same bytes for the same
	// entry and a mixed fleet's parcel settles instead of pushing for ever.
	//
	// `tr` (Q27, `markRetried`) is last for the same reason, and its name sorts after `te`
	// so a build that knows neither it nor the turn facts puts it there too.
	var PRICE_FIELDS = ['u', 'e', 'r', 'rp', 'u0'];
	var FIELD_ORDER  = ['t', 'm', 'p', 'c', 'ca', 'u', 'e', 'pv', 'r', 'tid', 'dur', 'out', 'ol', 'u0', 'rp',
		'ft', 'im', 'ro', 'sg', 'tc', 'te', 'tr'];

	function canon(v) { return JSON.stringify(v === undefined ? null : v); }

	// The greater of two field values, `undefined` standing for absent.
	function greater(x, y) {
		if (x === undefined) return y;
		if (y === undefined) return x;
		var nx = typeof x === 'number' && isFinite(x), ny = typeof y === 'number' && isFinite(y);
		if (nx && ny) return y > x ? y : x;
		if (nx !== ny) return nx ? y : x;	// a number is below anything else
		return canon(y) > canon(x) ? y : x;
	}

	function standing(e) { return e.r ? 2 : e.rp ? 1 : 0; }

	// The price group of the copy that stands higher.
	function higherPrice(a, b) {
		var sa = standing(a), sb = standing(b);
		if (sa !== sb) return sa > sb ? a : b;
		var ua = typeof a.u === 'number' ? a.u : 0, ub = typeof b.u === 'number' ? b.u : 0;
		if (ua !== ub) return ua > ub ? a : b;
		var ca = PRICE_FIELDS.map(function (k) { return canon(a[k]); }).join('|');
		var cb = PRICE_FIELDS.map(function (k) { return canon(b[k]); }).join('|');
		return cb > ca ? b : a;
	}

	/// One copy of an entry, in the one key order, with the price from `src` and
	/// every other field the greater of `a` and `b`.
	function build(a, b, src) {
		var seen = {}, names = [];
		function add(e) {
			for (var k in e) if (!seen[k] && e[k] !== undefined) { seen[k] = 1; names.push(k); }
		}
		add(a); add(b);
		var rest = names.filter(function (k) { return FIELD_ORDER.indexOf(k) < 0 && PRICE_FIELDS.indexOf(k) < 0; }).sort();
		var order = FIELD_ORDER.filter(function (k) { return seen[k]; }).concat(rest);
		var out = {};
		for (var i = 0; i < order.length; i++) {
			var k = order[i];
			var v = PRICE_FIELDS.indexOf(k) >= 0 ? src[k] : greater(a[k], b[k]);
			if (v !== undefined) out[k] = v;
		}
		return out;
	}

	/// The join of two copies of one turn: see the law above.
	function join(a, b) { return build(a, b, higherPrice(a, b)); }

	/// Merge two spend ledgers by UNION, joining the copies of a turn both hold
	/// (`join`), then PRUNE the result -- so pruning holds across every path an
	/// incoming ledger can arrive by (a sync collect, a sync apply, a backup
	/// restore), not only the device that happens to call `record`. Without
	/// this a dispatch-only device that never records hands every entry the
	/// runner already pruned straight back on its next pull, and the runner
	/// re-adds them on its next push -- the ledger never shrinks.
	///
	/// A ledger is an append-only record of money that actually moved, and
	/// two ledgers of one account differ by turns the other has not seen, and
	/// by what one copy knows of a turn the other copy has not yet learnt (its
	/// duration, its outcome, a billed figure over a guess). The join keeps
	/// the most each copy knows, so no spend is lost before the prune runs.
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
	/// merge that reordered itself would push for ever. Every entry leaves in
	/// one key order for the same reason.
	///
	/// # Arguments
	/// * `mine` - One ledger, this device's. It has no precedence: the join is
	///   symmetric, and the name is the caller's.
	/// * `theirs` - The other, from a backup file or another device.
	/// * `now` - The caller's clock, epoch-ms.
	function merge(mine, theirs, now) {
		var by = {}, out = [];
		function take(list) {
			(Array.isArray(list) ? list : []).forEach(function (e) {
				if (!e || typeof e.t !== 'number') return;
				var k = ledgerKey(e), held = by[k];
				if (held) { out[held.i] = join(out[held.i], e); return; }
				by[k] = { i: out.length };
				out.push(build(e, e, e));
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
	/// The stored entry is compact: `{ t, m, p, c, ca, u, pv, r, e, tid, dur, out, ol }`,
	/// plus the turn facts (`turn.facts`, see `putFacts`),
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
		putFacts(entry, turn.facts);
		// Through the merge, so the store holds the order every merge makes and
		// adopting this device's own ledger moves nothing (SIM-7).
		save(merge(load(), [entry], turn.ts));
		return entry;
	}

	// ── Turn facts (MC1) ───────────────────────────────────────
	// What the turn was like, written on the device that ran it:
	//   ft  ms from send to the first model event (reasoning, prose or a tool call);
	//   tc  tool calls; te  those the ENGINE says failed (`refused` is the person's or
	//       the policy's, not the model's);
	//   sg  stalls: gaps of `STALL_MS` or more between two model events in ONE provider
	//       call (a tool's own run and the next call's wait are not counted), plus one
	//       for a turn that ended silent, reasoned-only or malformed;
	//   im  images sent to a model; ro  the role that ran it, `c` chat, `d` daimon, `w` worker.
	// Zero is written as absent, so a quiet turn adds only `ft` and `ro`.
	var STALL_MS = 60 * 1000;
	var COUNT_FACTS = ['tc', 'te', 'sg', 'im'];
	var ROLES = { c: 1, d: 1, w: 1 };
	var DEAD_ENDS = { silent: 1, reasoned_only: 1, malformed: 1 };

	function putFacts(entry, f) {
		if (!f) return entry;
		if (typeof f.ft === 'number' && isFinite(f.ft) && f.ft >= 0) entry.ft = Math.round(f.ft);
		COUNT_FACTS.forEach(function (k) {
			var v = f[k];
			if (typeof v === 'number' && isFinite(v) && v >= 0.5) entry[k] = Math.round(v);
		});
		if (typeof f.ro === 'string' && ROLES[f.ro]) entry.ro = f.ro;
		return entry;
	}

	/// A meter for one turn, fed every stream event where the path already receives
	/// it. `t0` is when the turn was sent; `opts.stallMs` lowers the stall threshold
	/// for a test. `see(ev, at)` takes the event; `end(how)` the engine's ending word;
	/// `image(n)` images sent; `facts(role)` what `patchTurn` and `record` take.
	function meter(t0, opts) {
		var stallMs = (opts && opts.stallMs > 0) ? opts.stallMs : STALL_MS;
		var ft, last = null, tc = 0, te = 0, sg = 0, im = 0, ended = false;
		return {
			see: function (ev, at) {
				var now = typeof at === 'number' ? at : Date.now();
				var ty = ev && ev.type;
				if (ty === 'text' || ty === 'thinking' || ty === 'tool_call') {
					if (ft === undefined) ft = Math.max(0, now - t0);
					if (last !== null && now - last >= stallMs) sg++;
					// A tool call closes the provider call: what follows is the tool's
					// own run and then a fresh call, neither of them the model stalling.
					last = ty === 'tool_call' ? null : now;
				} else if (ty === 'tool_result') {
					tc++;
					if (ev.outcome === 'failed') te++;
				} else if (ty === 'round_meta' || ty === 'continued' || ty === 'compacted') {
					last = null;
				}
			},
			end: function (how) {
				if (!ended && DEAD_ENDS[String(how || '')]) { sg++; ended = true; }
			},
			image: function (n) { im += Math.max(0, n | 0); },
			facts: function (role) {
				return { ft: ft, tc: tc, te: te, sg: sg, im: im, ro: role };
			},
		};
	}

	/// Write what is known once a turn has ended onto the entry that turn's own `record`
	/// wrote -- the common case, a billed turn whose cost was known before its duration,
	/// outcome and facts were. `key` is that entry's `ledgerKey`; `facts` is `{ dur, out }`
	/// and the turn facts above. A no-op, returning null, when no entry has that key -- the
	/// caller then `record`s a fresh `outcomeOnly` entry.
	///
	/// By key, never by turn id: every run of a handed-off turn (the runner, Run here, a
	/// take-back, a park recovery) carries the same `tid`, so after a sync "the newest
	/// entry with this tid" can be another run's (r542 QA A F1).
	function patchTurn(key, facts) {
		if (!key) return null;
		var f = facts || {};
		var entries = load();
		for (var i = entries.length - 1; i >= 0; i--) {
			var e = entries[i];
			if (!e || ledgerKey(e) !== key) continue;
			if (typeof f.dur === 'number' && isFinite(f.dur) && f.dur >= 0) {
				e.dur = Math.round(f.dur);
			}
			if (f.out === 'completed' || f.out === 'failed' || f.out === 'interrupted') {
				e.out = f.out;
			}
			putFacts(e, f);
			// Stored in the one key order, as a merge would leave it.
			entries[i] = build(e, e, e);
			save(entries);
			return entries[i];
		}
		return null;
	}

	/// Mark turn `tid` RETRIED (Q27): the person asked it again, so its answer was not wanted, and
	/// `retryTurn` tombstones it out of the transcript. What stays is its spend, and `tr` on every
	/// entry of it names the turn `by` that replaced it, so the model Compare counts the answer as
	/// rejected (`DaimondModelCompare.grid`). A field under the join law above, present over absent,
	/// so the mark syncs with the entry and no device that has it can lose it.
	///
	/// Where this device holds no entry for the turn (its spend not synced in yet, or pruned), one
	/// outcome-only entry carries the mark, `ts` and `model` (the answer's) standing in, so the
	/// rejected answer is still counted. Returns the number of entries marked or written.
	function markRetried(tid, by, ts, model, provider) {
		if (!tid || !by) return 0;
		var id = String(tid), entries = load(), hit = [];
		entries.forEach(function (e) { if (e && e.tid === id) hit.push(Object.assign({}, e, { tr: String(by) })); });
		if (!hit.length) {
			if (typeof ts !== 'number' || !model) return 0;
			var mark = { t: ts, m: String(model), p: 0, c: 0, ca: 0, u: 0, e: false };
			if (provider) mark.pv = String(provider);
			mark.tid = id; mark.ol = 1; mark.tr = String(by);
			hit.push(mark);
		}
		save(merge(entries, hit, typeof ts === 'number' ? ts : Date.now()));
		return hit.length;
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
		window.DaimondStore.remove(KEY);
	}

	/// The ledger as this tab holds it, owed spend included: what the parcel and a
	/// backup carry.
	function entries() { return load(); }

	/// Merge a ledger that arrived -- another device's, or a backup's -- and store
	/// the union. Throws when the box refuses it, so the sync section that called
	/// it is reported failed and re-pulled rather than counted as merged (A5).
	function adopt(theirs) {
		if (!Array.isArray(theirs) || !theirs.length) return false;
		var mine = load(), next = merge(mine, theirs, Date.now());
		if (JSON.stringify(next) === JSON.stringify(mine)) return false;
		window.DaimondStore.putMerged(KEY, next, law);
		notifyChanged();
		return true;
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
		patchTurn:   patchTurn,
		markRetried: markRetried,
		meter:       meter,
		totals:      totals,
		perModel:    perModel,
		perProvider: perProvider,
		repriced:    repriced,
		series:      series,
		samples:     samples,
		clear:       clear,
		entries:     entries,
		adopt:       adopt,
		merge:       merge,
		reprice:     reprice,
		notifyChanged: notifyChanged,
		ledgerKey:   ledgerKey,
		retentionMs: retentionMs,
	};
})();
