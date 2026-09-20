/* ============================================================
   Test — the private per-model dashboard (modeldash.js), pure half.
   ------------------------------------------------------------
   Two claims, proved against the REAL `ledger.js` and `modeldash.js`
   source, run under node with no browser and no network:

     (a) AGGREGATION. `DaimondModelDash.dashboardRows(period, L)` reports
         the right tokens (in AND out, separately), cost and turn count
         per model, for fixture entries seeded straight into the
         `daimond-ledger` store `ledger.js` itself reads -- proving this
         file reads the ledger the design calls `daimond-ledger`, not a
         private copy of it.

     (b) THE RATING PERSISTS. A tap through `DaimondModelDash.rate()`
         survives a fresh load of the module against the SAME
         localStorage (what a page reload is, for this store), and
         `clearRatings()` genuinely empties it again -- the revert this
         file's own "nothing sent, everything local" claim depends on.

   Each check is proven able to fail:

     node www/js/modeldash.test.mjs --break nosplit    # perModel stops splitting prompt/completion
     node www/js/modeldash.test.mjs --break noaccum     # rate() overwrites instead of accumulating
     node www/js/modeldash.test.mjs                     # and then, clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_SRC    = join(HERE, 'ledger.js');
const MODELDASH_SRC = join(HERE, 'modeldash.js');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 ? (process.argv[i + 1] || '') : '';
})();
const KNOWN = ['nosplit', 'noaccum'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

/// A fresh `{ L, M, store }` -- `DaimondLedger` and `DaimondModelDash` loaded
/// from the real source (optionally patched for `--break`) into ONE shared
/// stand-in `window`, backed by an in-memory localStorage `store` (a Map, so
/// two calls to `load()` sharing the same `store` is what re-reading the
/// module after a reload means here). Neither file is ever `require`d from
/// node_modules or touches the real browser localStorage.
function load(store) {
	store = store || new Map();
	const localStorage = {
		getItem:    (k) => (store.has(k) ? store.get(k) : null),
		setItem:    (k, v) => { store.set(k, String(v)); },
		removeItem: (k) => { store.delete(k); },
	};
	const win = {};

	let ledgerSrc = readFileSync(LEDGER_SRC, 'utf8');
	if (BREAK === 'nosplit') {
		// perModel goes back to summing only the combined `tokens` figure --
		// exactly the shape it had before this build needed "in vs out".
		const needle = "if (!by[m]) by[m] = { model: m, usd: 0, tokens: 0, prompt: 0, completion: 0, turns: 0, reportedUsd: 0 };";
		if (!ledgerSrc.includes(needle)) throw new Error('break target not found (nosplit)');
		ledgerSrc = ledgerSrc
			.replace(needle, "if (!by[m]) by[m] = { model: m, usd: 0, tokens: 0, turns: 0, reportedUsd: 0 };")
			.replace('by[m].prompt += e.p || 0;\n\t\t\tby[m].completion += e.c || 0;\n', '');
	}
	// eslint-disable-next-line no-new-func
	new Function('window', 'localStorage', ledgerSrc)(win, localStorage);

	let modeldashSrc = readFileSync(MODELDASH_SRC, 'utf8');
	if (BREAK === 'noaccum') {
		// A tap SETS the count instead of adding to it, so a second tap on the
		// same model erases the first rather than building on it.
		const needle = "r[dir] = (r[dir] || 0) + 1;";
		if (!modeldashSrc.includes(needle)) throw new Error('break target not found (noaccum)');
		modeldashSrc = modeldashSrc.replace(needle, "r[dir] = 1; // BROKEN: overwrites, does not accumulate");
	}
	// modeldash.js's DOM half returns early when `document` is undefined
	// (the same guard `dockdrag.js` uses), which is exactly what makes the
	// pure half here safe to load with no DOM at all.
	// eslint-disable-next-line no-new-func
	new Function('window', 'localStorage', modeldashSrc)(win, localStorage);

	return { L: win.DaimondLedger, M: win.DaimondModelDash, store: store };
}

/// A minimal ledger entry, the shape `ledger.js` stores and `record()`
/// writes: epoch-ms, model, prompt/completion/cached tokens, USD.
function entry(t, m, p, c, u) {
	return { t: t, m: m, p: p, c: c, ca: 0, u: u };
}

function main() {
	console.log('modeldash: aggregation -- reads the real daimond-ledger key and splits tokens correctly');
	{
		const store = new Map();
		const now = Date.now();
		const fixtures = [
			entry(now - 1000, 'alpha/one', 100, 50, 0.010),
			entry(now - 2000, 'alpha/one', 200, 80, 0.020),
			entry(now - 3000, 'beta/two',  40,  10, 0.004),
		];
		store.set('daimond-ledger', JSON.stringify(fixtures));
		const { M } = load(store);

		const rows = M.dashboardRows('month');
		const alpha = rows.find((r) => r.model === 'alpha/one');
		const beta  = rows.find((r) => r.model === 'beta/two');

		check('both models are reported', !!alpha && !!beta, JSON.stringify(rows));
		check('alpha turns = 2', alpha && alpha.turns === 2, alpha && alpha.turns);
		check('alpha tokens in (prompt) = 300', alpha && alpha.promptTokens === 300, alpha && alpha.promptTokens);
		check('alpha tokens out (completion) = 130', alpha && alpha.completionTokens === 130, alpha && alpha.completionTokens);
		check('alpha total tokens = 430', alpha && alpha.tokens === 430, alpha && alpha.tokens);
		check('alpha cost = 0.03 (within float tolerance)',
			alpha && Math.abs(alpha.usd - 0.03) < 1e-9, alpha && alpha.usd);
		check('beta turns = 1, tokens in = 40, tokens out = 10',
			beta && beta.turns === 1 && beta.promptTokens === 40 && beta.completionTokens === 10,
			JSON.stringify(beta));
		check('a model never rated reports zero ratings',
			alpha && alpha.up === 0 && alpha.down === 0, JSON.stringify(alpha));
	}

	console.log('\nmodeldash: aggregation -- an empty ledger reports no rows, not an error');
	{
		const { M } = load(new Map());
		const rows = M.dashboardRows('month');
		check('empty in, empty out', Array.isArray(rows) && rows.length === 0, JSON.stringify(rows));
	}

	console.log('\nmodeldash: rating -- one tap accumulates, does not overwrite');
	{
		const { M } = load(new Map());
		check('unrated model starts at zero', JSON.stringify(M.ratingsFor('gamma')) === JSON.stringify({ up: 0, down: 0 }));
		M.rate('gamma', 'up');
		M.rate('gamma', 'up');
		const after = M.rate('gamma', 'down');
		check('two up-taps and one down-tap all counted',
			after.up === 2 && after.down === 1, JSON.stringify(after));
		check('an unrecognised direction is a no-op, not a throw',
			JSON.stringify(M.rate('gamma', 'sideways')) === JSON.stringify({ up: 2, down: 1 }));
	}

	console.log('\nmodeldash: rating -- persists across a reload (same localStorage, a fresh module load)');
	{
		const store = new Map();
		const { M: first } = load(store);
		first.rate('delta/four', 'up');
		first.rate('delta/four', 'up');
		first.rate('delta/four', 'down');

		// A "reload" is a fresh evaluation of the module against the SAME
		// backing store -- nothing about the rating lives in a JS variable
		// that a page refresh would lose.
		const { M: second } = load(store);
		const reread = second.ratingsFor('delta/four');
		check('the rating survived the reload', reread.up === 2 && reread.down === 1, JSON.stringify(reread));

		// The dashboard row for this model carries the same figures, so the
		// contribution preview and the rating buttons never disagree.
		store.set('daimond-ledger', JSON.stringify([entry(Date.now(), 'delta/four', 10, 10, 0.001)]));
		const { M: third } = load(store);
		const row = third.dashboardRows('month').find((r) => r.model === 'delta/four');
		check('dashboardRows carries the same reloaded rating', row && row.up === 2 && row.down === 1, JSON.stringify(row));
	}

	console.log('\nmodeldash: rating -- clearRatings genuinely reverts to empty, not just to this session');
	{
		const store = new Map();
		const { M: first } = load(store);
		first.rate('epsilon', 'up');
		check('rating is set before the revert', first.ratingsFor('epsilon').up === 1);

		first.clearRatings();
		check('rating is gone in the SAME instance', first.ratingsFor('epsilon').up === 0);

		// And the revert is real storage state, not an in-memory flag: a fresh
		// module load against the same store sees the empty store too.
		const { M: second } = load(store);
		check('and stays gone after a reload', second.ratingsFor('epsilon').up === 0);
		check('the store key itself was removed', !store.has(second.RATINGS_KEY), JSON.stringify([...store.keys()]));
	}

	console.log('\nmodeldash: a corrupt rating store degrades to empty rather than throwing');
	{
		const store = new Map();
		store.set('daimond-model-ratings', 'not json{{{');
		const { M } = load(store);
		check('corrupt store reads as no ratings', JSON.stringify(M.ratingsFor('x')) === JSON.stringify({ up: 0, down: 0 }));
		check('and a tap still works afterwards', M.rate('x', 'up').up === 1);
	}

	console.log('\n' + checks + ' checks, ' + failures + ' failed');
	if (BREAK) {
		console.log('(--break ' + BREAK + ': failures above are the point)');
		process.exit(failures > 0 ? 0 : 1);
	}
	process.exit(failures > 0 ? 1 : 0);
}

main();
