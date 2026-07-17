/* ============================================================
   Daimond — spend governor (DaimondGovernor)
   ------------------------------------------------------------
   A quiet speed limit on money, not a fuel gauge on it.

   Every existing spend control in Daimond, and in every rival,
   watches a TOTAL: a monthly budget, a balance, a cap. A total
   is the wrong thing to watch for the failure that actually
   hurts — a fan-out of agents burning a week's credit in
   seconds. That is a RATE, and by the time a total notices, the
   money is gone.

   So this module watches the rate. It does two things, and only
   these two, so that in normal use it is silent and never in the
   way:

     1. A predictive gate on the conductor's fan-out. When a
        Focus dispatches N workers, the cost of that batch is
        known BEFORE a single one runs (N times what a worker
        typically costs). If that would push a burst past its
        budget, the gate pauses and asks — once, at the one
        moment it matters. A batch of a few normal agents sails
        through untouched; a batch of fifty does not.

     2. A learned sense of "faster than usual". The baseline is
        the user's OWN recent spend, so a runaway is defined
        relative to their normal rather than an absolute number
        nobody ever sets. When the live rate runs well above that
        baseline, a calm amber note appears. It informs; it does
        not block. The only thing that ever blocks is (1).

   The decision logic here is pure and separately testable; the
   modal and the DOM live in daimond.js, which owns them. This
   module holds state and answers questions.

   Depends on `window.DaimondLedger` (loaded first) for the
   baseline. Attaches a single global, `window.DaimondGovernor`.
   Also exported for Node, so the pure core can be unit-tested
   without a browser.
   ============================================================ */
(function () {
	'use strict';

	// ── Tunables ───────────────────────────────────────────────
	// Deliberately generous. The cost of a false alarm is a user
	// who learns to ignore the gate, so every threshold errs
	// towards silence and only the genuinely surprising trips it.

	var SETTINGS_KEY = 'daimond-governor';		// per-account (accounts.js namespaces daimond-*)

	// What one worker costs when there is no history to say
	// otherwise. A new account has no baseline, so the gate falls
	// back to this — small enough that a handful of agents never
	// trips, large enough that a big fan-out does.
	var FALLBACK_WORKER_USD = 0.08;

	// The auto-derived per-burst budget: the larger of this floor
	// and a multiple of the user's typical turn, so it scales with
	// how the person actually works.
	var DEFAULT_BUDGET_USD = 1.00;
	var BUDGET_TURN_MULTIPLE = 12;

	// A gap longer than this ends a "burst": a stretch of activity
	// with no real pause. Runaways happen inside one burst; a burst
	// that has gone quiet resets the running total.
	var BURST_GAP_MS = 45 * 1000;

	// The window over which the live rate is measured.
	var RATE_WINDOW_MS = 60 * 1000;

	// Below this the rate is never called fast, however it compares
	// to the baseline: nobody wants an amber note over pennies.
	var MIN_RATE_FLOOR_USD_MIN = 0.50;

	// The live rate must exceed the baseline by this factor to go
	// amber.
	var AMBER_MULTIPLE = 3;

	// Minimum ledger samples before a learned baseline is trusted;
	// below it, the fallbacks stand in.
	var MIN_SAMPLES = 6;

	// ── Pure core ──────────────────────────────────────────────
	// No DOM, no storage, no clock. Everything a decision needs is
	// passed in, so the same functions run under Node in the tests.

	/// The median of a numeric array, or 0 for an empty one.
	function median(xs) {
		if (!xs || !xs.length) return 0;
		var s = xs.slice().sort(function (a, b) { return a - b; });
		var m = Math.floor(s.length / 2);
		return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
	}

	/// A learned baseline from raw ledger samples `[{ t, u }]`.
	///
	/// Returns `{ perTurnUsd, rateUsdMin, n, learned }`. When there
	/// are too few priced turns to trust, `learned` is false and the
	/// figures are the fallbacks — a caller can still use them, it
	/// just knows they are assumed rather than measured.
	function baselineFrom(samples) {
		var costs = [];
		for (var i = 0; samples && i < samples.length; i++) {
			var u = samples[i] && samples[i].u;
			if (typeof u === 'number' && u > 0) costs.push(u);
		}
		var learned = costs.length >= MIN_SAMPLES;
		var perTurn = learned ? median(costs) : FALLBACK_WORKER_USD;
		if (!(perTurn > 0)) perTurn = FALLBACK_WORKER_USD;
		// A "normal fast" pace: about two typical turns a minute,
		// never below the pennies floor. This is what the live rate
		// is judged against, not an absolute the user must invent.
		var rate = Math.max(MIN_RATE_FLOOR_USD_MIN, perTurn * 2);
		return { perTurnUsd: perTurn, rateUsdMin: rate, n: costs.length, learned: learned };
	}

	/// The predicted cost of dispatching `n` workers, given a
	/// baseline. Pure multiplication — the point is that it is known
	/// before any worker runs.
	function estimateBatch(n, baseline) {
		var per = (baseline && baseline.perTurnUsd > 0) ? baseline.perTurnUsd : FALLBACK_WORKER_USD;
		return Math.max(0, (n || 0)) * per;
	}

	/// The auto budget for one burst, from the baseline: a multiple
	/// of a typical turn, floored so it is never trivially small.
	function autoBudget(baseline) {
		var per = (baseline && baseline.perTurnUsd > 0) ? baseline.perTurnUsd : FALLBACK_WORKER_USD;
		return Math.max(DEFAULT_BUDGET_USD, per * BUDGET_TURN_MULTIPLE);
	}

	/// Decide whether a dispatch of `n` workers needs a look.
	///
	/// `runSpent` is what the current burst has already cost;
	/// `budget` is the burst's ceiling. The batch needs confirming
	/// when what the burst has spent plus what this batch is
	/// predicted to spend would cross the budget. That is the whole
	/// rule: cheap batches, and batches inside a fresh budget, pass
	/// silently; the one that would run the burst away does not.
	///
	/// Returns `{ needsConfirm, predicted, perWorker, runSpent,
	/// budget, projected }`.
	function decideDispatch(n, baseline, runSpent, budget) {
		var per = (baseline && baseline.perTurnUsd > 0) ? baseline.perTurnUsd : FALLBACK_WORKER_USD;
		var predicted = estimateBatch(n, baseline);
		var spent = Math.max(0, runSpent || 0);
		var cap = (budget > 0) ? budget : autoBudget(baseline);
		var projected = spent + predicted;
		return {
			needsConfirm: projected > cap,
			predicted:    predicted,
			perWorker:    per,
			runSpent:     spent,
			budget:       cap,
			projected:    projected,
			n:            Math.max(0, n || 0),
		};
	}

	/// The live rate, in dollars per minute, from observations
	/// `[{ t, u }]` and a `now`, over the rate window.
	function velocityFrom(obs, now, windowMs) {
		var w = windowMs || RATE_WINDOW_MS;
		var since = now - w;
		var usd = 0;
		for (var i = 0; obs && i < obs.length; i++) {
			if (obs[i] && obs[i].t >= since) usd += (obs[i].u || 0);
		}
		return usd / (w / 60000);		// per minute
	}

	/// Classify the current state: 'green', 'amber' or 'tripped'.
	///
	/// Amber is "faster than usual and above the pennies floor".
	/// Tripped is reserved for the burst having already run past its
	/// budget — a state the dispatch gate normally prevents, kept so
	/// a caller can show it if a burst gets there another way.
	function levelFor(rateUsdMin, baseline, runSpent, budget) {
		var base = (baseline && baseline.rateUsdMin > 0) ? baseline.rateUsdMin : MIN_RATE_FLOOR_USD_MIN;
		var cap = (budget > 0) ? budget : autoBudget(baseline);
		if ((runSpent || 0) > cap) return 'tripped';
		if (rateUsdMin > MIN_RATE_FLOOR_USD_MIN && rateUsdMin > base * AMBER_MULTIPLE) return 'amber';
		return 'green';
	}

	// ── Stateful shell ─────────────────────────────────────────
	// The browser side: reads the ledger for a baseline, keeps the
	// recent observations and the current burst, and reads the
	// clock. None of this runs under Node — the export at the foot
	// hands out the pure core only.

	var _obs = [];			// recent observations {t,u}, pruned to the burst window
	var _burstStart = 0;	// epoch-ms the current burst began
	var _burstSpent = 0;	// USD spent since _burstStart
	var _lastObs = 0;		// epoch-ms of the last observation

	function now() {
		return (typeof Date !== 'undefined') ? Date.now() : 0;
	}

	function readSettings() {
		try {
			var raw = localStorage.getItem(SETTINGS_KEY);
			var o = raw ? JSON.parse(raw) : {};
			return (o && typeof o === 'object') ? o : {};
		} catch (e) { return {}; }
	}

	function writeSettings(o) {
		try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(o || {})); } catch (e) { /* quota */ }
	}

	/// The learned baseline from the live ledger, or the fallbacks
	/// if the ledger is absent or thin.
	function baseline() {
		var samples = [];
		try {
			if (window.DaimondLedger && typeof DaimondLedger.samples === 'function') {
				samples = DaimondLedger.samples();
			}
		} catch (e) { samples = []; }
		return baselineFrom(samples);
	}

	/// The current burst's budget: the user's set figure if they
	/// have one, else the auto figure from the baseline.
	function budget() {
		var s = readSettings();
		if (typeof s.budgetUsd === 'number' && s.budgetUsd > 0) return s.budgetUsd;
		return autoBudget(baseline());
	}

	/// Feed one completed turn to the governor. Accepts a ledger
	/// entry (`{ t, u }`) or a plain `{ ts, usd }`; anything without
	/// a usable cost is ignored. Rolls the burst forward, starting a
	/// fresh one after a real pause.
	function observe(entry) {
		if (!entry) return;
		var t = (typeof entry.t === 'number') ? entry.t : entry.ts;
		var u = (typeof entry.u === 'number') ? entry.u : entry.usd;
		if (typeof t !== 'number') t = now();
		if (typeof u !== 'number' || !(u >= 0)) return;

		if (_burstStart === 0 || (t - _lastObs) > BURST_GAP_MS) {
			// A new burst: the last one has gone quiet.
			_burstStart = t;
			_burstSpent = 0;
			_obs = [];
		}
		_lastObs = t;
		_burstSpent += u;
		_obs.push({ t: t, u: u });
		// Keep only what the rate window and burst need.
		var cutoff = t - Math.max(RATE_WINDOW_MS, BURST_GAP_MS);
		_obs = _obs.filter(function (o) { return o.t >= cutoff; });
	}

	/// Assess a dispatch of `n` workers against the current burst.
	/// Pure decision, live inputs. daimond.js turns a
	/// `needsConfirm: true` into the app's own confirm modal.
	function assessDispatch(n) {
		// A dispatch that lands after a pause opens its own burst, so
		// its budget is fresh rather than charged with an idle history.
		var t = now();
		var spent = (t - _lastObs > BURST_GAP_MS) ? 0 : _burstSpent;
		return decideDispatch(n, baseline(), spent, budget());
	}

	/// The current state for the quiet meter: level, live rate, and
	/// what the burst has spent against its budget.
	function status() {
		var t = now();
		var b = baseline();
		var cap = budget();
		var stale = (t - _lastObs) > BURST_GAP_MS;
		var spent = stale ? 0 : _burstSpent;
		var rate = stale ? 0 : velocityFrom(_obs, t, RATE_WINDOW_MS);
		return {
			level:      stale ? 'green' : levelFor(rate, b, spent, cap),
			rateUsdMin: rate,
			burstSpent: spent,
			budget:     cap,
			baseline:   b,
		};
	}

	/// Read/adjust the per-burst budget. `setBudget(null)` clears it
	/// back to the auto figure.
	function getBudget() { return budget(); }
	function setBudget(usd) {
		var s = readSettings();
		if (usd == null || !(usd > 0)) delete s.budgetUsd;
		else s.budgetUsd = usd;
		writeSettings(s);
	}

	/// Forget the current burst (e.g. on unlock/account switch), so
	/// one account's activity never colours another's.
	function reset() { _obs = []; _burstStart = 0; _burstSpent = 0; _lastObs = 0; }

	var api = {
		// Live API used by daimond.js.
		observe:       observe,
		assessDispatch: assessDispatch,
		status:        status,
		baseline:      baseline,
		getBudget:     getBudget,
		setBudget:     setBudget,
		reset:         reset,
		// Pure core, exposed for tests and for reuse.
		_core: {
			median:         median,
			baselineFrom:   baselineFrom,
			estimateBatch:  estimateBatch,
			autoBudget:     autoBudget,
			decideDispatch: decideDispatch,
			velocityFrom:   velocityFrom,
			levelFor:       levelFor,
			consts: {
				FALLBACK_WORKER_USD:     FALLBACK_WORKER_USD,
				DEFAULT_BUDGET_USD:      DEFAULT_BUDGET_USD,
				BUDGET_TURN_MULTIPLE:    BUDGET_TURN_MULTIPLE,
				BURST_GAP_MS:            BURST_GAP_MS,
				RATE_WINDOW_MS:          RATE_WINDOW_MS,
				MIN_RATE_FLOOR_USD_MIN:  MIN_RATE_FLOOR_USD_MIN,
				AMBER_MULTIPLE:          AMBER_MULTIPLE,
				MIN_SAMPLES:             MIN_SAMPLES,
			},
		},
	};

	if (typeof window !== 'undefined') window.DaimondGovernor = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
