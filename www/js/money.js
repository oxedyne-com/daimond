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
			out.push(rowFor({
				key:   'own',
				label: st.ownOneLabel ? st.ownOneLabel(p.name) : ('Your ' + p.name + ' key'),
				exactUsd:    (c && c.mode === 'auto') ? c.usd : null,
				estimateUsd: (c && c.mode === 'manual') ? c.usd : null,
				spentUsd:    (typeof p.spentUsd === 'number') ? p.spentUsd : null,
			}, rate));
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

	var api = {
		RISK_MINUTES:   RISK_MINUTES,
		runwayMinutes:  runwayMinutes,
		rowFor:         rowFor,
		rows:           rows,
	};
	if (typeof window !== 'undefined') window.DaimondMoney = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
