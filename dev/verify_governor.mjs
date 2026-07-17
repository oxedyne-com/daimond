// verify_governor.mjs — the spend governor's pure decision core.
//
// The governor watches the RATE of spend, not the total, so that a fan-out of
// agents cannot burn a week's credit in a blink. This test drives the pure
// core directly under Node (no browser, no stack): the learned baseline, the
// predictive batch estimate, the dispatch decision, the live rate, and the
// green/amber/tripped level. The wiring into the real page is checked
// separately by verify_governor_ui.mjs against the running app.
//
// Loaded by evaluating www/js/governor.js in a sandbox: the module guards its
// browser globals behind `typeof`, so with `window` passed as undefined only
// the pure core and the Node export run. This is robust to whatever module
// system the app's package.json declares.
import { readFileSync } from 'fs';

const src = readFileSync(new URL('../www/js/governor.js', import.meta.url), 'utf8');
const mod = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('module', 'window', src)(mod, undefined);
const Gov = mod.exports;
const C = Gov._core;

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── The learned baseline ───────────────────────────────────────────
{
	// Too few samples: the baseline is assumed, not measured, and uses the
	// fallback worker cost.
	const thin = C.baselineFrom([{ t: 1, u: 0.05 }, { t: 2, u: 0.05 }]);
	check('thin history is not "learned"', thin.learned === false);
	check('thin baseline falls back to the fallback worker cost',
		near(thin.perTurnUsd, C.consts.FALLBACK_WORKER_USD), 'got ' + thin.perTurnUsd);

	// Enough samples: the per-turn figure is the median of the priced turns,
	// and zero/negative costs are ignored.
	const rich = C.baselineFrom([
		{ t: 1, u: 0.10 }, { t: 2, u: 0.20 }, { t: 3, u: 0.30 },
		{ t: 4, u: 0.40 }, { t: 5, u: 0.50 }, { t: 6, u: 0.60 },
		{ t: 7, u: 0 }, { t: 8, u: -1 },
	]);
	check('rich history is "learned"', rich.learned === true);
	check('baseline per-turn is the median of priced turns',
		near(rich.perTurnUsd, 0.35), 'got ' + rich.perTurnUsd);
	check('baseline rate is floored at the pennies floor',
		rich.rateUsdMin >= C.consts.MIN_RATE_FLOOR_USD_MIN);
}

// ── The predictive estimate ────────────────────────────────────────
{
	const base = { perTurnUsd: 0.10 };
	check('a batch costs N times a worker', near(C.estimateBatch(30, base), 3.0), 'got ' + C.estimateBatch(30, base));
	check('a zero batch costs nothing', C.estimateBatch(0, base) === 0);
	check('a batch with no baseline uses the fallback',
		near(C.estimateBatch(10, null), 10 * C.consts.FALLBACK_WORKER_USD));
}

// ── The auto budget ────────────────────────────────────────────────
{
	// A cheap normal turn: the budget is the floor, not a trivial figure.
	check('auto budget is floored', near(C.autoBudget({ perTurnUsd: 0.02 }), C.consts.DEFAULT_BUDGET_USD));
	// An expensive turn: the budget scales with how the person works.
	check('auto budget scales with a costly turn',
		near(C.autoBudget({ perTurnUsd: 0.50 }), 0.50 * C.consts.BUDGET_TURN_MULTIPLE),
		'got ' + C.autoBudget({ perTurnUsd: 0.50 }));
}

// ── The dispatch decision (the heart) ──────────────────────────────
{
	const base = C.baselineFrom([]);	// fresh account: fallback $0.08/worker, $1 budget
	const budget = C.autoBudget(base);

	// A handful of agents on a fresh burst: silent.
	const few = C.decideDispatch(3, base, 0, budget);
	check('a few agents dispatch silently', few.needsConfirm === false,
		'predicted ' + few.predicted.toFixed(2) + ' vs budget ' + budget.toFixed(2));

	// The "fifty agents in a blink" case: it must ask.
	const many = C.decideDispatch(50, base, 0, budget);
	check('a big fan-out asks first', many.needsConfirm === true,
		'predicted ' + many.predicted.toFixed(2));

	// A burst already near its budget: even a small batch that crosses it asks.
	const nearCap = C.decideDispatch(3, base, budget - 0.10, budget);
	check('a batch that would cross an already-spent budget asks', nearCap.needsConfirm === true);

	// The same batch on a fresh budget passes — the pause is about the runaway,
	// not about the batch in isolation.
	const fresh = C.decideDispatch(3, base, 0, budget);
	check('the same batch on a fresh budget passes', fresh.needsConfirm === false);

	// A user with an expensive normal is not nagged for their normal fan-out:
	// the budget scaled with them.
	const richBase = C.baselineFrom(Array.from({ length: 8 }, (_, i) => ({ t: i, u: 0.40 })));
	const richBudget = C.autoBudget(richBase);
	const richFew = C.decideDispatch(4, richBase, 0, richBudget);
	check('an expensive-normal user is not nagged for a normal fan-out',
		richFew.needsConfirm === false,
		'predicted ' + richFew.predicted.toFixed(2) + ' vs budget ' + richBudget.toFixed(2));
}

// ── The live rate ──────────────────────────────────────────────────
{
	const now = 1_000_000;
	const obs = [
		{ t: now - 90_000, u: 5.00 },	// outside the 60s window — ignored
		{ t: now - 30_000, u: 0.50 },
		{ t: now - 10_000, u: 0.50 },
	];
	// $1.00 in the last minute → $1.00/min.
	check('rate is the last-minute spend per minute',
		near(C.velocityFrom(obs, now, 60_000), 1.0), 'got ' + C.velocityFrom(obs, now, 60_000));
	check('an empty window is a zero rate', C.velocityFrom([], now, 60_000) === 0);
}

// ── The level ──────────────────────────────────────────────────────
{
	const base = { rateUsdMin: 0.50 };	// normal ~ $0.50/min
	const budget = 5.0;
	check('an ordinary rate is green', C.levelFor(0.40, base, 0.20, budget) === 'green');
	// Well above baseline and above the pennies floor.
	check('a fast rate is amber', C.levelFor(3.0, base, 1.0, budget) === 'amber',
		'got ' + C.levelFor(3.0, base, 1.0, budget));
	// Fast but still pennies: never amber (no nagging over nothing).
	check('a fast rate on pennies is still green',
		C.levelFor(0.40, { rateUsdMin: 0.05 }, 0.10, budget) === 'green');
	// A burst that has run past its budget: tripped.
	check('past the budget is tripped', C.levelFor(0.10, base, budget + 1, budget) === 'tripped');
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
