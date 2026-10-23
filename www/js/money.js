/* ============================================================
   Daimond — whose money, and how much of it (DaimondMoney)
   ============================================================

   The rail used to carry one row, labelled "Credits", showing the
   balance held with Daimond. For somebody running on their own
   provider key that row said **"Credits $0.00"** — while their key
   was funding every turn perfectly well. The one number on screen
   about money told them they were broke, and it was not their money
   it was talking about.

   There are two economies here and they never mix: the balance
   minted with Daimond, and whatever the user holds with a provider
   of their own. So there are up to two rows, and each is NAMED BY
   WHOSE MONEY IT IS.

   ── The four rules ─────────────────────────────────────────

   **1. Never a bare "Credits".** Every label names an owner:
   "Daimond credits", "Your OpenAI key". A label that does not say
   whose money it is cannot be read correctly by somebody who has
   two kinds.

   **2. The strongest true statement, and otherwise nothing.**
   In order: an exact balance the provider reported; an estimate
   (`≈`) from a figure the user typed less what has been spent since;
   what has been spent so far, when no balance is knowable at all.
   If none of those is true, THE ROW IS NOT DRAWN. A dash is not an
   answer -- it occupies the place where the answer goes and says
   nothing, which reads as zero to anybody scanning.

   **3. Warn on runway, not on a threshold.** $2 left is fine at a
   penny an hour and gone in ten minutes during a fan-out. An
   absolute figure cannot know which, and a warning that fires on
   round numbers gets ignored. Time is the honest unit.

   **4. When it is at risk, show the CONSEQUENCE rather than the
   figure.** "About 20 minutes left at this rate" is what the reader
   needs; the number they can still see by opening Credits. A figure
   with a red edge round it makes the reader do the division.

   Pure, and exported for Node, because these are wording rules and
   wording rules should be tested without a browser.
   ============================================================ */
(function () {
	'use strict';

	/// Below this many minutes of runway a row stops reporting a figure and
	/// starts reporting the consequence. Twenty minutes is about the length of
	/// one working stretch: long enough to finish a thought, short enough that
	/// being told now is useful.
	var RISK_MINUTES = 20;

	/// A rate below this is treated as no rate at all. A near-zero burn divides
	/// into any balance to give a runway of years, which is not information.
	var MIN_RATE_USD_MIN = 0.0001;

	/// How long the money lasts at the current burn, in minutes, or null when
	/// that cannot be said.
	/// An EMPTY pot has no runway, and this is not a rounding detail. Zero
	/// divided by any rate is zero minutes, which reads as "at risk with one
	/// minute left" -- a prediction about the future, made about money that has
	/// already run out. Caught by rendering it: the rail said "Daimond credits,
	/// ~1 min left at this rate" beside a funded key with $42.50 on it.
	function runwayMinutes(usd, rateUsdPerMin) {
		if (typeof usd !== 'number' || !isFinite(usd) || usd <= 0) return null;
		if (typeof rateUsdPerMin !== 'number' || !isFinite(rateUsdPerMin)) return null;
		if (rateUsdPerMin < MIN_RATE_USD_MIN) return null;
		return usd / rateUsdPerMin;
	}

	/// One pot of money, reduced to what can honestly be said about it.
	///
	/// # Arguments
	/// * `pot` - `{ label, exactUsd, estimateUsd, spentUsd }`. Each figure is a
	///   number or null; they are tried in that order, which is rule 2.
	/// * `rate` - Current burn in USD per minute, or null.
	///
	/// # Returns
	/// A row, or `null` when there is nothing true to say -- which is the whole
	/// point of returning null rather than a row with a dash in it.
	function rowFor(pot, rate) {
		if (!pot || !pot.label) return null;
		var usd = null, kind = '';
		if (typeof pot.exactUsd === 'number' && isFinite(pot.exactUsd)) {
			usd = pot.exactUsd; kind = 'exact';
		} else if (typeof pot.estimateUsd === 'number' && isFinite(pot.estimateUsd)) {
			usd = pot.estimateUsd; kind = 'estimate';
		} else if (typeof pot.spentUsd === 'number' && isFinite(pot.spentUsd) && pot.spentUsd > 0) {
			// No balance is knowable -- most providers will not say -- so the
			// strongest true statement left is what has gone through it.
			return { key: pot.key || '', label: pot.label, kind: 'spent',
				usd: pot.spentUsd, tone: 'ok', atRisk: false, minutes: null };
		} else {
			return null;
		}

		var mins = runwayMinutes(usd, rate);
		var atRisk = (mins !== null && mins <= RISK_MINUTES);
		return {
			key:     pot.key || '',
			label:   pot.label,
			kind:    kind,
			usd:     usd,
			minutes: mins,
			atRisk:  atRisk,
			// Amber rather than red: nothing is broken yet, and a red row for
			// money that is merely running low is the boy who cried wolf.
			tone:    atRisk ? 'warn' : 'ok',
		};
	}

	/// Both pots, in the order the reader should meet them.
	///
	/// # Arguments
	/// * `st` - `{ authed, creditsUsd, providers, rateUsdPerMin }` where
	///   `providers` is `DaimondModels.providers()`.
	function rows(st) {
		st = st || {};
		var out = [];
		var rate = (typeof st.rateUsdPerMin === 'number') ? st.rateUsdPerMin : null;
		var list = st.providers || [];

		// The Daimond balance, only for an account that has one. An app with no
		// account has no such pot, and a row saying so would be an advert in the
		// place a fact belongs.
		if (st.authed) {
			var r = rowFor({
				key:   'credits',
				label: st.creditsLabel || 'Daimond credits',
				exactUsd: (typeof st.creditsUsd === 'number') ? st.creditsUsd : null,
				spentUsd: (typeof st.creditsSpentUsd === 'number') ? st.creditsSpentUsd : null,
			}, rate);
			if (r) {
				// Carried through untouched so the caller can print the account's own
				// currency. This module does arithmetic and never formatting: a
				// balance in minor units is the only lossless form of it.
				r.minor    = st.creditsMinor;
				r.currency = st.creditsCurrency;
				out.push(r);
			}
		}

		// The user's own keys. One provider is named; several are not, because
		// four rows of provider names is a list, not a status.
		var own = list.filter(function (p) { return p && !p.paid && p.hasKey; });
		if (own.length === 1) {
			var p = own[0];
			var c = p.credit || null;
			var one = rowFor({
				key:   'own',
				label: st.ownOneLabel ? st.ownOneLabel(p.name) : ('Your ' + p.name + ' key'),
				exactUsd:    (c && c.mode === 'auto') ? c.usd : null,
				estimateUsd: (c && c.mode === 'manual') ? c.usd : null,
				spentUsd:    (typeof p.spentUsd === 'number') ? p.spentUsd : null,
			}, rate);
			// Which provider: the Status exception's Top Up goes to its billing page (needs.js).
			if (one) { one.provider = p.name || ''; one.pid = p.id || ''; }
			out.push(one);
		} else if (own.length > 1) {
			// Summed only where every one of them can be summed. A total that
			// silently omits the two providers that would not answer is a wrong
			// number, and a wrong number is worse than no row.
			var known = own.filter(function (x) { return x.credit && typeof x.credit.usd === 'number'; });
			var spent = own.reduce(function (a, x) {
				return a + (typeof x.spentUsd === 'number' ? x.spentUsd : 0);
			}, 0);
			var all = (known.length === own.length);
			var total = known.reduce(function (a, x) { return a + x.credit.usd; }, 0);
			var anyEstimate = known.some(function (x) { return x.credit.mode === 'manual'; });
			out.push(rowFor({
				key:   'own',
				label: st.ownManyLabel || 'Your own keys',
				exactUsd:    (all && !anyEstimate) ? total : null,
				estimateUsd: (all && anyEstimate) ? total : null,
				spentUsd:    spent,
			}, rate));
		}

		out = out.filter(Boolean);

		// An empty pot is a warning only when it is the ONLY pot. Zero Daimond
		// credits beside a funded key of the user's own is a fact about an
		// account they are not using, and colouring it amber would put a caution
		// on the rail of somebody whose work is fully funded -- which is the same
		// mistake, in a different colour, as the row this module replaced.
		if (out.length === 1 && out[0].kind !== 'spent' && out[0].usd <= 0) {
			out[0].tone = 'warn';
			out[0].empty = true;
		}
		return out;
	}

	// ── Pools (D-20261015-14, D-20261020-13) ───────────────────
	// One pool per paying source, never summed: Daimond credits, and each key of
	// the user's own that reports a balance. A pool's rate is ITS OWN spend from
	// the synced ledger, so another pool's burst never moves this pool's figure,
	// and spend on another device counts once the ledger has merged it.

	var MIN = 60e3;							// one minute in ms
	var RATE_WINDOW_MS = 15 * MIN;			// the dial: a burst shows, a single turn does not swamp it
	var DAY_WINDOW_MS  = 24 * 60 * MIN;		// the Status row: a day's habit, not one busy minute
	var MIN_RATE_USD_H = MIN_RATE_USD_MIN * 60;	// under this a pool is idle and has no mileage

	// The dial's full scale (D-20261022-07): the pool's own 15-min rates over the last
	// 30 days, at their 95th percentile, rounded up to 1, 2 or 5 x 10^n in the pool's
	// currency, so it refines as the history grows. Nothing is stored for it: it is read
	// from the synced ledger, which bounds it at its 90-day retention, and the span
	// bounds the read at 2,880 windows a pool. Under SCALE_MIN_N spending windows there
	// is not enough history, and the scale is SCALE_DEFAULT an hour.
	var SCALE_SPAN_MS  = 30 * 24 * 60 * MIN;	// the history the scale reads
	var SCALE_MIN_N    = 8;					// spending windows before the history decides (two busy hours)
	var SCALE_DEFAULT  = 5;					// per hour, in the pool's currency, until then
	var SCALE_PCT      = 0.95;				// the history's 95th percentile

	/// The top-up mark after a reading of `amount` at `now`. A balance that rose
	/// since the last reading was topped up, and is the new full height from then
	/// on; one that fell or held is being spent. A pool with no mark takes this
	/// reading as its full height. `last` is this device's own last reading and
	/// never travels; `full` and `at` are the synced mark.
	function markNext(prev, amount, now) {
		if (typeof amount !== 'number' || !isFinite(amount)) return prev || null;
		var has = prev && typeof prev.full === 'number' && isFinite(prev.full);
		var last = (prev && typeof prev.last === 'number') ? prev.last : (has ? prev.full : null);
		if (!has || amount > prev.full || (last !== null && amount > last)) {
			return { full: amount, at: now, last: amount };
		}
		return { full: prev.full, at: prev.at || 0, last: amount };
	}

	/// The credits pool's mark as the gateway's ledger has it, from `/api/balance`'s
	/// `entries` (newest first, `{ ts, kind, delta_minor, balance }`, `ts` in Unix ns):
	/// the balance right after the newest credit (a top-up, a grant, an adjustment up),
	/// lowered by every refund since, so a refund is not drawn as spending. `{ full, at }`
	/// in the account's currency, or null when no credit is among the entries returned.
	///
	/// Why the ledger and not `markNext` (PS1 review M1, 23 Oct): `last` is this device's
	/// and is written to disk only when the mark moves, and buying credits reloads the page
	/// (Stripe), so a top-up that left the balance under the old full height read as no
	/// rise: full 50, spent to 10, bought 20, read 30 of 50. The ledger knows it was 30 of 30.
	function ledgerMark(entries) {
		if (!Array.isArray(entries)) return null;
		var cut = 0;	// refunds and adjustments down since the credit, in minor units
		for (var i = 0; i < entries.length; i++) {
			var e = entries[i] || {}, d = +e.delta_minor;
			if (!isFinite(d)) continue;
			if (d > 0 && (e.kind === 'topup' || e.kind === 'grant' || e.kind === 'adjust')) {
				var b = +e.balance;
				if (!isFinite(b)) return null;
				return { full: (b + cut) / 100, at: Math.floor((+e.ts || 0) / 1e6) };
			}
			if (d < 0 && (e.kind === 'refund' || e.kind === 'adjust')) cut += d;
		}
		return null;
	}

	/// Does the mark `a` beat `b`? The later top-up does; at one moment the
	/// greater full height does, so two devices settle on one mark in any order.
	function markWins(a, b) {
		if (!a || typeof a.full !== 'number' || !isFinite(a.full)) return false;
		if (!b || typeof b.full !== 'number' || !isFinite(b.full)) return true;
		var x = +a.at || 0, y = +b.at || 0;
		if (x !== y) return x > y;
		return a.full > b.full;
	}

	/// Merge another device's marks into `mine`, in place, by later top-up time.
	/// A pool `theirs` lacks is left alone, so an old build's parcel, which has no
	/// marks at all, merges as no change. Did anything move?
	///
	/// A mark taken from the other device drops this device's `last`: the top-up
	/// it records is one this device may not have read yet, and its next reading,
	/// above the old `last` but below the new full height, is that top-up already
	/// counted, not a second one.
	function marksMerge(mine, theirs) {
		var moved = false;
		if (!mine || !theirs || typeof theirs !== 'object') return false;
		Object.keys(theirs).sort().forEach(function (k) {
			var r = theirs[k];
			if (!markWins(r, mine[k])) return;
			mine[k] = { full: +r.full, at: +r.at || 0 };
			moved = true;
		});
		return moved;
	}

	/// The marks as they travel: `{ full, at }` per pool, keys sorted, so the
	/// parcel serialises the same on every device.
	function marksParcel(marks) {
		var out = {};
		Object.keys(marks || {}).sort().forEach(function (k) {
			var m = marks[k];
			if (m && typeof m.full === 'number' && isFinite(m.full)) out[k] = { full: m.full, at: +m.at || 0 };
		});
		return out;
	}

	/// A US-dollar rate per hour in the pool's currency, or null when no exchange
	/// rate for it is known: an A$ balance divided by a US$ rate is a wrong number,
	/// and no number is better.
	function inCurrency(usdPerH, ccy, fx) {
		if (typeof usdPerH !== 'number' || !isFinite(usdPerH)) return null;
		if (ccy === 'USD') return usdPerH;
		var k = fx && fx[ccy];
		return (typeof k === 'number' && isFinite(k) && k > 0) ? usdPerH * k : null;
	}

	/// Minutes the pool lasts at `rateUsdPerH`, or null: idle under the floor,
	/// empty, or a rate that cannot be put in the pool's currency.
	function mileage(amount, ccy, rateUsdPerH, fx) {
		if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) return null;
		if (typeof rateUsdPerH !== 'number' || !isFinite(rateUsdPerH) || rateUsdPerH < MIN_RATE_USD_H) return null;
		var r = inCurrency(rateUsdPerH, ccy, fx);
		return (r && r > 0) ? amount / r * 60 : null;
	}

	/// The least 1, 2 or 5 x 10^n at or above `x`.
	function niceUp(x) {
		if (!(x > 0) || !isFinite(x)) return null;
		var e = Math.pow(10, Math.floor(Math.log10(x)));
		var steps = [1, 2, 5, 10];
		for (var i = 0; i < steps.length; i++) {
			// A hair of tolerance, so 2.0000000001 from a sum of floats is still 2.
			if (steps[i] * e >= x * (1 - 1e-9)) return steps[i] * e;
		}
		return 10 * e;
	}

	/// The dial's full scale for a pool, per hour in its currency, from `hist`, its
	/// spending windows' rates in US$ per hour (`DaimondLedger.rateHistory`):
	/// `{ scale, from }`, `from` 'history' or 'default'.
	function fullScale(hist, ccy, fx) {
		var r = (Array.isArray(hist) ? hist : []).map(function (u) { return inCurrency(u, ccy, fx); })
			.filter(function (v) { return typeof v === 'number' && v > 0 && isFinite(v); })
			.sort(function (a, b) { return a - b; });
		if (r.length < SCALE_MIN_N) return { scale: SCALE_DEFAULT, from: 'default' };
		var p = r[Math.max(0, Math.ceil(SCALE_PCT * r.length) - 1)];
		return { scale: niceUp(p) || SCALE_DEFAULT, from: 'history' };
	}

	/// Every paying source with a balance, as a pool.
	///
	/// # Arguments
	/// * `st` - `{ authed, credits: { minor, currency }, providers, rateOf, fx,
	///   marks, now, label }`; `credits.entries` is `/api/balance`'s (`ledgerMark`). `providers` is `DaimondModels.providers()`;
	///   `rateOf(pv, windowMs)` is the ledger's spend in US$ per hour for that
	///   provider id (`DaimondLedger.rate`); `historyOf(pv)` its spending 15-min
	///   windows' rates (`DaimondLedger.rateHistory`); `fx` is units of a currency per US$;
	///   `marks` the synced top-up marks by pool key; `label(kind, name)` words a
	///   pool, kind 'credits' | 'credit' | 'limit'.
	///
	/// Each pool: `{ key, label, provider, currency, amount, kind, binds, full,
	/// level, mark, rate15, rateDay, minutes, minutesDay, empty, scale, scaleFrom }`,
	/// the rates and the dial's full scale per hour in the pool's currency (null when they cannot be put in it). A key
	/// that reports no balance has no pool.
	function pools(st) {
		st = st || {};
		var now = (typeof st.now === 'number') ? st.now : Date.now();
		var marks = st.marks || {};
		var word = st.label || function (kind, name) {
			return kind === 'credits' ? 'Daimond credits'
				: kind === 'limit' ? name + ' key limit' : name + ' credit';
		};
		var rateOf = st.rateOf || function () { return null; };
		var historyOf = st.historyOf || function () { return []; };
		var out = [];
		function add(key, label, provider, ccy, amount, kind, binds, led) {
			var r15 = rateOf(key, RATE_WINDOW_MS), rd = rateOf(key, DAY_WINDOW_MS);
			// The ledger's mark stands while the reading is under it; a reading above it is a
			// credit the last `/api/balance` had not seen yet, and `markNext` takes the rise.
			var mark = (led && led.full > 0 && amount <= led.full)
				? { full: led.full, at: led.at, last: amount }
				: markNext(marks[key], amount, now);
			var sc = fullScale(historyOf(key), ccy, st.fx);
			out.push({
				key:        key,
				label:      label,
				provider:   provider,
				currency:   ccy,
				amount:     amount,
				kind:       kind,
				binds:      binds,
				full:       mark.full,
				level:      (mark.full > 0 && amount > 0) ? Math.min(1, amount / mark.full) : 0,
				mark:       mark,
				rate15:     inCurrency(r15, ccy, st.fx),
				rateDay:    inCurrency(rd, ccy, st.fx),
				minutes:    mileage(amount, ccy, r15, st.fx),
				minutesDay: mileage(amount, ccy, rd, st.fx),
				empty:      !(amount > 0),
				scale:      sc.scale,
				scaleFrom:  sc.from,
			});
		}
		var c = st.credits;
		if (st.authed && c && typeof c.minor === 'number' && isFinite(c.minor)) {
			// The gateway's minor units are hundredths of the account's currency
			// (DaimondI18n.moneyMinor reads them so), and the pool stays in it.
			add('credits', word('credits', ''), '', String(c.currency || 'usd').toUpperCase(),
				c.minor / 100, 'exact', '', ledgerMark(c.entries));
		}
		(st.providers || []).forEach(function (p) {
			if (!p || p.paid || !p.hasKey) return;
			var cr = p.credit;
			if (!cr || typeof cr.usd !== 'number' || !isFinite(cr.usd)) return;
			var binds = cr.mode === 'auto' ? (cr.binds || 'credit') : '';
			add(p.id, word(binds === 'limit' ? 'limit' : 'credit', p.name), p.name, 'USD',
				Math.max(0, cr.usd), cr.mode === 'auto' ? 'exact' : 'estimate', binds);
		});
		return out;
	}

	var api = {
		RATE_WINDOW_MS: RATE_WINDOW_MS,
		DAY_WINDOW_MS:  DAY_WINDOW_MS,
		MIN_RATE_USD_H: MIN_RATE_USD_H,
		SCALE_SPAN_MS:  SCALE_SPAN_MS,
		SCALE_MIN_N:    SCALE_MIN_N,
		SCALE_DEFAULT:  SCALE_DEFAULT,
		pools:          pools,
		niceUp:         niceUp,
		fullScale:      fullScale,
		markNext:       markNext,
		ledgerMark:     ledgerMark,
		markWins:       markWins,
		marksMerge:     marksMerge,
		marksParcel:    marksParcel,
		mileage:        mileage,
		RISK_MINUTES:   RISK_MINUTES,
		runwayMinutes:  runwayMinutes,
		rowFor:         rowFor,
		rows:           rows,
	};
	if (typeof window !== 'undefined') window.DaimondMoney = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
