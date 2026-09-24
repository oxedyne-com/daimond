/* ============================================================
   Test — D-20260921-01: turn DURATION and OUTCOME on the local ledger.
   ------------------------------------------------------------
   The model-dashboard build (#2, `modeldash.js`) flagged the gap: a ledger
   entry (`www/js/ledger.js:200`) recorded tokens and cost but no turn
   duration and no completion outcome, so `modeldash.js`'s own `gapFields()`
   had to say "not recorded" for median turn time and a failure/stopped
   rate. This build closes it, additively:

     - `DaimondLedger.record()` accepts `durationMs` / `outcome` and stores
       them as `dur` / `out` on the entry; a caller that never passes them
       (every caller before this build) gets exactly the entry it always
       got.
     - `DaimondLedger.patchOutcome(turnId, durationMs, outcome)` stamps
       both onto the entry already recorded for a turn -- the common case,
       since a turn's cost is known well before its duration and outcome
       are (both settle only once the turn has fully ended).
     - A turn that billed NOTHING at all -- it failed, or was stopped,
       before a single token came back -- has no entry to patch, so
       `record()` is called with `outcomeOnly: true`: no pricing, `u`
       stays 0, and the entry is marked `ol` so `perModel`'s existing
       turn/cost figures -- which counted only billed turns before this
       build -- go on doing exactly that.
     - `DaimondLedger.perModel()` adds `medianTurnMs`, `turnsCompleted`,
       `turnsFailed`, `turnsStopped`, `outcomeTurns`, `failureRate`,
       computed from `dur`/`out` across the window, alongside the
       existing `turns`/`usd`/`tokens` figures it always returned.
     - `daimond.js` classifies the outcome at the ONE place every chat
       turn's ending already funnels through (`runTurn`'s `finally`) and
       the ONE place every daimon turn's does (`doSteer`'s
       `closeFeedTurn`), and calls the new `recordTurnOutcome` there.
       `daimond.js` cannot be loaded standalone here (see `ledger.test.mjs`
       for why); those two are proved as SOURCE guards.

   Each check is proven able to fail:

     node www/js/ledger-turntime.test.mjs --break noguard    # outcome-only entries inflate turns/usd
     node www/js/ledger-turntime.test.mjs --break nomedian   # median() returns the wrong middle
     node www/js/ledger-turntime.test.mjs --break nofallback # a never-billed turn's outcome is dropped
     node www/js/ledger-turntime.test.mjs --break nopatch    # patchOutcome stops finding the entry
     node www/js/ledger-turntime.test.mjs --break noolguard  # reprice() re-marks an `ol` entry `estimated`
     node www/js/ledger-turntime.test.mjs --break sharedtid  # doSteer keys the ledger back on rec.id
     node www/js/ledger-turntime.test.mjs                    # and then, clean

   2026-09-21 audit fixes, both additive, no billing-value change:

     Finding 1 (MEDIUM) -- `reprice()` (`ledger.js:54`) ran on any entry
     lacking `r`/`rp`, and an `ol` (outcome-only) entry has neither, so a
     failed/stopped-before-billing turn got marked `e:true` and painted a
     false "≈ estimated" over an otherwise entirely provider-billed window.
     Fixed by skipping `e.ol` in `reprice()`'s guard -- there is nothing to
     price on an entry that billed nothing.

     Finding 2 (MEDIUM) -- `doSteer`'s ledger calls (`recordTurnOutcome`,
     `meterDiamondTurn`) keyed on `rec.id`, the daimon CHAT's id, the SAME
     string for every steer that Diamond ever runs. `patchOutcome` matches
     the MOST RECENT entry for a tid, so a failing steer's outcome landed on
     the PREVIOUS steer's billed entry instead of its own -- the turn that
     actually failed was never recorded. Fixed by keying both calls on
     `dmid`, `doSteer`'s own per-turn id (`newMid()`, generated fresh every
     call) -- the exact analogue of `runTurn`'s `umid`.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_SRC    = join(HERE, 'ledger.js');
const MODELDASH_SRC = join(HERE, 'modeldash.js');
const DAIMOND_SRC   = join(HERE, 'daimond.js');

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
const KNOWN = ['noguard', 'nomedian', 'nofallback', 'nopatch', 'noolguard', 'sharedtid'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

/// A fresh `{ L, M, store }` -- `DaimondLedger` and `DaimondModelDash`
/// loaded from the real source (optionally patched for `--break`) into one
/// shared stand-in `window`, backed by an in-memory localStorage `store`.
/// The same pattern `modeldash.test.mjs` uses, for the same reason: neither
/// file ever touches the real browser localStorage.
/// `pricing`, when given, is stubbed in as `window.DaimondPricing` before
/// `ledger.js` runs, so `reprice()` has something to call (Finding 1's
/// test needs one; every other test leaves it unset, exactly as before).
function load(store, pricing) {
	store = store || new Map();
	const localStorage = {
		getItem:    (k) => (store.has(k) ? store.get(k) : null),
		setItem:    (k, v) => { store.set(k, String(v)); },
		removeItem: (k) => { store.delete(k); },
	};
	const win = {};
	if (pricing) win.DaimondPricing = pricing;

	let ledgerSrc = readFileSync(LEDGER_SRC, 'utf8');
	if (BREAK === 'noolguard') {
		// Finding 1, reverted: reprice() stops skipping `ol` entries, so an
		// outcome-only turn gets priced and marked `estimated` like any other
		// unreported one.
		const needle = "if (!e || e.r || e.rp || e.ol) continue;\t// `ol`: outcome-only, nothing to price";
		if (!ledgerSrc.includes(needle)) throw new Error('break target not found (noolguard)');
		ledgerSrc = ledgerSrc.replace(needle, "if (!e || e.r || e.rp) continue; // BROKEN: ol guard removed");
	}
	if (BREAK === 'noguard') {
		// The outcome-only guard goes: an `ol` entry counts toward `turns`,
		// `usd` and the token totals as if it had been billed.
		const needle = 'if (!e.ol) {';
		if (!ledgerSrc.includes(needle)) throw new Error('break target not found (noguard)');
		ledgerSrc = ledgerSrc.replace(needle, 'if (true) {  // BROKEN: guard removed');
	}
	if (BREAK === 'nomedian') {
		// The median goes: the array's first element (after an UNSORTED
		// slice), not the true middle.
		const needle = 'function median(nums) {\n\t\tif (!nums || nums.length === 0) return null;\n\t\tvar sorted = nums.slice().sort(function (a, b) { return a - b; });\n\t\tvar mid = Math.floor(sorted.length / 2);\n\t\treturn sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;\n\t}';
		if (!ledgerSrc.includes(needle)) throw new Error('break target not found (nomedian)');
		ledgerSrc = ledgerSrc.replace(needle,
			'function median(nums) { return (nums && nums.length) ? nums[0] : null; } // BROKEN: not a median');
	}
	if (BREAK === 'nopatch') {
		// patchOutcome stops matching by turn id, so it never finds the
		// entry a billed turn already wrote and every outcome falls through
		// to a fresh, unbilled duplicate instead of patching the real one.
		const needle = "if (!e || e.tid !== tid) continue;";
		if (!ledgerSrc.includes(needle)) throw new Error('break target not found (nopatch)');
		ledgerSrc = ledgerSrc.replace(needle, "if (true) continue; // BROKEN: never matches");
	}
	// eslint-disable-next-line no-new-func
	loadStore(win, localStorage);
	new Function('window', 'localStorage', ledgerSrc)(win, localStorage);

	let modeldashSrc = readFileSync(MODELDASH_SRC, 'utf8');
	// eslint-disable-next-line no-new-func
	new Function('window', 'localStorage', modeldashSrc)(win, localStorage);

	return { L: win.DaimondLedger, M: win.DaimondModelDash, store: store };
}

function main() {
	console.log('ledger: record() -- duration and outcome are additive fields');
	{
		const { L, store } = load();
		const noExtra = L.record({ ts: 1000, model: 'm', promptTokens: 10, completionTokens: 5,
			cachedTokens: 0, costUsd: 0.01, provider: 'p' });
		check('a caller that omits them gets no dur/out at all (unchanged shape)',
			!('dur' in noExtra) && !('out' in noExtra), JSON.stringify(noExtra));

		const withExtra = L.record({ ts: 2000, model: 'm', promptTokens: 10, completionTokens: 5,
			cachedTokens: 0, costUsd: 0.01, provider: 'p', turnId: 't1',
			durationMs: 4200, outcome: 'completed' });
		check('a duration is recorded per turn', withExtra.dur === 4200, JSON.stringify(withExtra));
		check('the outcome tag is stored', withExtra.out === 'completed', JSON.stringify(withExtra));
		check('billing fields are untouched by adding duration/outcome',
			withExtra.u === 0.01 && withExtra.p === 10 && withExtra.c === 5, JSON.stringify(withExtra));

		check('an unrecognised outcome string is dropped, not stored verbatim',
			!('out' in L.record({ ts: 3000, model: 'm', promptTokens: 1, completionTokens: 1,
				outcome: 'sideways' })));
		check('a negative duration is dropped, not stored',
			!('dur' in L.record({ ts: 4000, model: 'm', promptTokens: 1, completionTokens: 1,
				durationMs: -5 })));
	}

	console.log('\nledger: record() -- outcomeOnly bills nothing and is marked `ol`');
	{
		const { L } = load();
		const e = L.record({ ts: 5000, model: 'm', provider: 'p', turnId: 't2',
			durationMs: 900, outcome: 'failed', outcomeOnly: true });
		check('no cost is priced for a turn that billed nothing', e.u === 0, JSON.stringify(e));
		check('no tokens are attributed either', e.p === 0 && e.c === 0, JSON.stringify(e));
		check('the entry is marked outcome-only', e.ol === 1, JSON.stringify(e));
		check('duration and outcome still land', e.dur === 900 && e.out === 'failed', JSON.stringify(e));
		check('it is not marked `r` (reported) -- nothing was reported', !e.r, JSON.stringify(e));
	}

	console.log('\nledger: patchOutcome -- stamps the MOST RECENT entry for a turn id');
	{
		const { L, store } = load();
		L.record({ ts: 1000, model: 'm', promptTokens: 1, completionTokens: 1, turnId: 'dup' });
		const second = L.record({ ts: 2000, model: 'm', promptTokens: 1, completionTokens: 1, turnId: 'dup' });
		const patched = L.patchOutcome('dup', 1234, 'completed');
		check('the newest entry sharing the id is the one patched',
			!!patched && patched.t === second.t, JSON.stringify(patched));
		const stored = JSON.parse(store.get('daimond-ledger'));
		const older = stored.find((r) => r.t === 1000);
		check('the older entry sharing the id is untouched', !('dur' in older) && !('out' in older),
			JSON.stringify(older));

		check('patching an id nobody recorded is a no-op, not a throw', L.patchOutcome('never-seen', 1, 'completed') === null);
		check('a falsy turn id is refused outright', L.patchOutcome('', 1, 'completed') === null);
	}

	console.log('\nledger: patchOutcome -- billed figures on the patched entry do not move');
	{
		const { L, store } = load();
		const before = L.record({ ts: 6000, model: 'm', promptTokens: 40, completionTokens: 10,
			costUsd: 0.05, provider: 'p', turnId: 't3' });
		L.patchOutcome('t3', 777, 'interrupted');
		const stored = JSON.parse(store.get('daimond-ledger'));
		const after = stored.find((r) => r.tid === 't3');
		check('cost is unchanged after the patch', after.u === before.u, after.u);
		check('tokens are unchanged after the patch', after.p === before.p && after.c === before.c);
		check('duration and outcome were added', after.dur === 777 && after.out === 'interrupted');
	}

	console.log('\nledger: perModel -- outcome-only entries do NOT inflate the billed turn/cost figures');
	{
		const { L } = load();
		L.record({ ts: Date.now() - 1000, model: 'alpha', promptTokens: 100, completionTokens: 50,
			costUsd: 0.02, turnId: 'a1', durationMs: 2000, outcome: 'completed' });
		// A turn that failed before it billed a single token -- exactly what
		// `recordTurnOutcome`'s fallback in daimond.js writes.
		L.record({ ts: Date.now() - 500, model: 'alpha', turnId: 'a2',
			durationMs: 100, outcome: 'failed', outcomeOnly: true });
		const rows = L.perModel('month');
		const alpha = rows.find((r) => r.model === 'alpha');
		check('turns still counts only the billed turn', alpha.turns === 1, alpha.turns);
		check('usd still counts only the billed turn', Math.abs(alpha.usd - 0.02) < 1e-9, alpha.usd);
		check('tokens still count only the billed turn', alpha.tokens === 150, alpha.tokens);
		check('but BOTH turns count toward the outcome tally',
			alpha.turnsCompleted === 1 && alpha.turnsFailed === 1, JSON.stringify(alpha));
	}

	console.log('\nledger: perModel -- the outcome tag is correct for completed / failed / interrupted');
	{
		const { L } = load();
		const now = Date.now();
		L.record({ ts: now - 5000, model: 'beta', promptTokens: 1, completionTokens: 1,
			turnId: 'b1', durationMs: 1000, outcome: 'completed' });
		L.record({ ts: now - 4000, model: 'beta', promptTokens: 1, completionTokens: 1,
			turnId: 'b2', durationMs: 2000, outcome: 'completed' });
		L.record({ ts: now - 3000, model: 'beta', turnId: 'b3',
			durationMs: 500, outcome: 'failed', outcomeOnly: true });
		L.record({ ts: now - 2000, model: 'beta', turnId: 'b4',
			durationMs: 800, outcome: 'interrupted', outcomeOnly: true });
		const beta = L.perModel('month').find((r) => r.model === 'beta');
		check('turnsCompleted = 2', beta.turnsCompleted === 2, beta.turnsCompleted);
		check('turnsFailed = 1',    beta.turnsFailed === 1,    beta.turnsFailed);
		check('turnsStopped = 1',   beta.turnsStopped === 1,   beta.turnsStopped);
		check('outcomeTurns = 4',   beta.outcomeTurns === 4,   beta.outcomeTurns);
		check('failureRate = (1+1)/4 = 0.5', Math.abs(beta.failureRate - 0.5) < 1e-9, beta.failureRate);
	}

	console.log('\nledger: perModel -- median turn time, even and odd counts');
	{
		const { L } = load();
		const now = Date.now();
		[1000, 3000, 2000].forEach((ms, i) => {
			L.record({ ts: now - i, model: 'gamma-odd', turnId: 'go' + i,
				durationMs: ms, outcome: 'completed', outcomeOnly: true });
		});
		const oddRow = L.perModel('month').find((r) => r.model === 'gamma-odd');
		check('median of [1000,2000,3000] is 2000', oddRow.medianTurnMs === 2000, oddRow.medianTurnMs);

		[1000, 2000, 3000, 4000].forEach((ms, i) => {
			L.record({ ts: now - i, model: 'gamma-even', turnId: 'ge' + i,
				durationMs: ms, outcome: 'completed', outcomeOnly: true });
		});
		const evenRow = L.perModel('month').find((r) => r.model === 'gamma-even');
		check('median of [1000,2000,3000,4000] is 2500', evenRow.medianTurnMs === 2500, evenRow.medianTurnMs);
	}

	console.log('\nledger: perModel -- a model with no duration/outcome data reports null, not zero');
	{
		const { L } = load();
		L.record({ ts: Date.now(), model: 'delta', promptTokens: 1, completionTokens: 1, costUsd: 0.001 });
		const delta = L.perModel('month').find((r) => r.model === 'delta');
		check('medianTurnMs is null, not 0, with nothing recorded', delta.medianTurnMs === null, delta.medianTurnMs);
		check('failureRate is null, not 0, with no outcome data', delta.failureRate === null, delta.failureRate);
		check('outcomeTurns is 0', delta.outcomeTurns === 0, delta.outcomeTurns);
	}

	console.log('\nledger: reprice() -- an outcome-only entry is never priced or marked estimated (Finding 1 audit fix)');
	{
		// A pricing stub that would flip ANY entry it touches: a nonzero cost
		// and `estimated: true`. If `reprice()` still reaches the `ol` entry,
		// this is what it would do to it.
		const pricing = { priceFor: () => ({ usd: 9.99, estimated: true }) };
		const now = Date.now();
		const { L, store } = load(undefined, pricing);

		// The outcome-only entry `recordTurnOutcome`'s fallback writes for a
		// steer that failed before it billed a single token -- no `r`, no `rp`,
		// so it is exactly the shape `reprice()`'s guard must skip.
		const ol = L.record({ ts: now, model: 'm', provider: 'p', turnId: 'f1',
			durationMs: 100, outcome: 'failed', outcomeOnly: true });
		check('the outcome-only entry starts unpriced and unestimated', ol.u === 0 && !ol.e, JSON.stringify(ol));

		// A genuinely provider-billed turn shares the window, so the ONLY thing
		// that could paint the total "estimated" is the ol entry above.
		L.record({ ts: now, model: 'm', promptTokens: 10, completionTokens: 5,
			costUsd: 0.02, provider: 'p', turnId: 'f2', durationMs: 4000, outcome: 'completed' });

		const totals = L.totals();	// forces reprice() to run over both entries
		const stored = JSON.parse(store.get('daimond-ledger')).find((e) => e.tid === 'f1');
		check('reprice() leaves the outcome-only entry unpriced', stored.u === 0, JSON.stringify(stored));
		check('reprice() does not mark the outcome-only entry `e` (estimated)', !stored.e, JSON.stringify(stored));
		check("totals().month.estimated stays false -- an ol entry cannot paint '≈' over real, provider-billed spend",
			totals.month.estimated === false, JSON.stringify(totals.month));
	}

	console.log('\nmodeldash: dashboardRows -- the dashboard computes median-turn-time and failure-rate from fixtures');
	{
		const store = new Map();
		const now = Date.now();
		const fixtures = [
			{ t: now - 1, m: 'omega', p: 10, c: 5, ca: 0, u: 0.01, tid: 'o1', dur: 1000, out: 'completed' },
			{ t: now - 2, m: 'omega', p: 10, c: 5, ca: 0, u: 0.01, tid: 'o2', dur: 3000, out: 'completed' },
			{ t: now - 3, m: 'omega', p: 0,  c: 0,  ca: 0, u: 0,    tid: 'o3', dur: 500,  out: 'failed', ol: 1 },
		];
		store.set('daimond-ledger', JSON.stringify(fixtures));
		const { M } = load(store);
		const row = M.dashboardRows('month').find((r) => r.model === 'omega');
		check('turns is still 2 (billed only)', row.turns === 2, row.turns);
		check('medianTurnMs is 1000 (median of 1000,3000,500)', row.medianTurnMs === 1000, row.medianTurnMs);
		check('failureRate is 1/3', Math.abs(row.failureRate - (1 / 3)) < 1e-9, row.failureRate);
		check('turnsFailed is surfaced', row.turnsFailed === 1, row.turnsFailed);
		check('turnsStopped is surfaced (zero here)', row.turnsStopped === 0, row.turnsStopped);
		check('the honest gap list no longer claims failed/stopped turns are unrecorded',
			!M.gapFields().includes('turnsFailed') && !M.gapFields().includes('turnsStopped'),
			JSON.stringify(M.gapFields()));
		check('the full turn-time spread (a histogram) is still an honest gap',
			M.gapFields().includes('turnSecondsHistogram'), JSON.stringify(M.gapFields()));
	}

	console.log('\ndaimond.js: source guard -- runTurn classifies and records the outcome at the one exit funnel');
	{
		let src = readFileSync(DAIMOND_SRC, 'utf8');
		if (BREAK === 'sharedtid') {
			// Finding 2, reverted: both ledger call sites in `doSteer` go back to
			// keying on `rec.id`, the daimon chat's id -- shared by every steer of
			// that Diamond -- instead of `dmid`, generated fresh per call.
			const needleA = "recordTurnOutcome(dsPair.model, dsPair.provider, dmid, Date.now() - dsT0,";
			const needleB = "meterDiamondTurn(fa, diamondId, dmid);";
			if (!src.includes(needleA)) throw new Error('break target not found (sharedtid A)');
			if (!src.includes(needleB)) throw new Error('break target not found (sharedtid B)');
			src = src.replace(needleA, "recordTurnOutcome(dsPair.model, dsPair.provider, rec.id, Date.now() - dsT0, // BROKEN: shared id");
			src = src.replace(needleB, "meterDiamondTurn(fa, diamondId, rec.id); // BROKEN: shared id");
		}
		if (BREAK === 'nofallback') {
			// The fallback that records a fresh outcome-only entry when nothing
			// was billed to patch goes, so a turn that failed before its first
			// token is left with no duration or outcome anywhere.
			const needle = 'if (!patched) {';
			if (!src.includes(needle)) throw new Error('break target not found (nofallback)');
			src = src.replace(needle, 'if (false) { // BROKEN: fallback removed');
		}
		check('runTurn calls recordTurnOutcome from its finally',
			src.includes("recordTurnOutcome(chat.model, chat.provider, umid, Date.now() - telT0, turnOutcome);"));
		check('the Stop button reads as interrupted', src.includes("var turnOutcome = chat._aborted ? 'interrupted'"));
		check('a page/tab going away reads as interrupted, not failed',
			src.includes("(threw && _unloading) ? 'interrupted'"));
		check('a dropped connection handed back for Continue reads as interrupted',
			src.includes("(threw && handedBack) ? 'interrupted'"));
		check('a genuine provider/model failure is the only case tagged failed',
			src.includes("(threw || sawError) ? 'failed'"));
		// D-20260921 audit fix (Finding 2) -- `dmid`, doSteer's OWN per-turn id
		// (`newMid()`, generated fresh every call), not `rec.id` -- the daimon
		// CHAT's id, the same string for every steer that Diamond ever runs.
		// Keyed on `rec.id`, `patchOutcome` found "the most recent entry with
		// that tid" -- the PREVIOUS steer's billed entry -- and stamped ITS
		// outcome, leaving the turn that actually failed unrecorded.
		check('doSteer closes its turn through the same recordTurnOutcome, keyed on its own dmid',
			src.includes("recordTurnOutcome(dsPair.model, dsPair.provider, dmid, Date.now() - dsT0,"));
		check('doSteer bills the turn (meterDiamondTurn) under that same dmid, not the shared chat id',
			src.includes("meterDiamondTurn(fa, diamondId, dmid);"));
		check('recordTurnOutcome patches the billed entry first',
			src.includes('var patched = DaimondLedger.patchOutcome(turnId, durationMs, outcome);'));
		check('and falls back to an unbilled outcome-only entry when nothing was billed',
			src.includes('outcomeOnly: true') &&
			/if \(!patched\) \{[\s\S]{0,200}?outcomeOnly: true/.test(src));
	}

	console.log('\nledger: patchOutcome -- a failed steer tags ITS OWN turn, never a previous one sharing an id (Finding 2 audit fix)');
	{
		const now = Date.now();

		// The mechanism the finding describes, reproduced directly against the
		// real `patchOutcome`: two steers of ONE Diamond keyed on the SAME id
		// (what `rec.id` gave every steer before this fix) collide -- the
		// second call finds and overwrites the first steer's entry, because
		// `patchOutcome` matches the MOST RECENT entry for a tid and there is
		// only one entry to find.
		{
			const { L, store } = load();
			const sharedId = 'chat-42';	// stands in for the old, buggy `rec.id`
			L.record({ ts: now - 5000, model: 'm', promptTokens: 20, completionTokens: 10,
				costUsd: 0.03, provider: 'p', turnId: sharedId });
			L.patchOutcome(sharedId, 4000, 'completed');	// steer 1 completes
			L.patchOutcome(sharedId, 500, 'failed');	// steer 2 fails, SAME id
			const stored = JSON.parse(store.get('daimond-ledger'));
			check('mechanism confirmed: a shared id lets steer 2\'s failure overwrite steer 1\'s billed entry',
				stored.length === 1 && stored[0].out === 'failed', JSON.stringify(stored));
		}

		// The fix: each steer keyed on its OWN id -- `dmid` in `doSteer`, a
		// fresh `newMid()` every call -- so the two turns cannot collide.
		{
			const { L, store } = load();
			L.record({ ts: now - 5000, model: 'm', promptTokens: 20, completionTokens: 10,
				costUsd: 0.03, provider: 'p', turnId: 'dmid-1' });
			L.patchOutcome('dmid-1', 4000, 'completed');	// steer 1 completes, its own id
			// Steer 2 bills nothing and fails, under ITS OWN id -- `recordTurnOutcome`'s
			// own fallback when the patch finds nothing to patch.
			var patched2 = L.patchOutcome('dmid-2', 500, 'failed');
			if (!patched2) {
				L.record({ ts: now - 1000, model: 'm', provider: 'p', turnId: 'dmid-2',
					durationMs: 500, outcome: 'failed', outcomeOnly: true });
			}
			const stored = JSON.parse(store.get('daimond-ledger'));
			const s1 = stored.find((e) => e.tid === 'dmid-1');
			const s2 = stored.find((e) => e.tid === 'dmid-2');
			check('the earlier, billed steer keeps its own completed outcome',
				!!s1 && s1.out === 'completed', JSON.stringify(s1));
			check('the failed steer lands on its OWN entry, not the earlier completed one',
				!!s2 && s2.out === 'failed' && s2.ol === 1, JSON.stringify(s2));
			check('both turns survive, distinct -- nothing was overwritten',
				stored.length === 2, JSON.stringify(stored));
		}
	}

	console.log('\n' + checks + ' checks, ' + failures + ' failed');
	if (BREAK) {
		console.log('(--break ' + BREAK + ': failures above are the point)');
		process.exit(failures > 0 ? 0 : 1);
	}
	process.exit(failures > 0 ? 1 : 0);
}

main();
