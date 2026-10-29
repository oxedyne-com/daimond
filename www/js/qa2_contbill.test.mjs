/* ============================================================
   Test -- U3a QA2 finding 3 (UNBLOCK-16): a continuation worker bills only
   its own leg, and its tile counts the prior run once.
   ------------------------------------------------------------
   A continuation (dispatched by the same name, or `continue:`) restores the
   matched run's session. It used to restore the prior run's totals onto the new
   app's counters too, and `billAttempt` bills an app's whole cumulative spend:
   a prior run of 9,000 prompt tokens and a 2,000-token leg was billed 11,000,
   and the `finally` added the prior again for a tile of 20,000.

   Runs the REAL continuation restore from `start()`, the REAL `billAttempt`
   closure and `appSpend`, and the `finally`'s REAL total lines, lifted out of
   daimond.js, over a stand-in app that keeps the counters the wasm keeps.
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';

const DAIMOND = readPage(new URL('./daimond.js', import.meta.url), 'utf8');

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log('  ok   ' + name); }
	else { bad++; console.log('  FAIL ' + name + (detail ? '  -- ' + detail : '')); }
};

function lift(name) {
	const a = DAIMOND.indexOf('\tfunction ' + name + '(');
	const b = DAIMOND.indexOf('\n\t}\n', a);
	return a < 0 || b < 0 ? '' : DAIMOND.slice(a, b + 3);
}

// The continuation branch of `start()`, closed where the `run.resume` branch opens.
function liftRestore() {
	const head = 'if (run._priorSession && run._priorSession.length && run.app.restore_session) {';
	const a = DAIMOND.indexOf(head);
	const b = DAIMOND.indexOf('} else if (run.resume) {', a);
	// The branch defines `seedSession`, the one restore every app of the run gets (qr1 #2).
	return a < 0 || b < 0 ? null : DAIMOND.slice(a, b) + '} seedSession();';
}

// The worker's biller, a closure inside its block.
function liftBiller() {
	const a = DAIMOND.indexOf('var wbilled = null;');
	const b = DAIMOND.indexOf('\n\t\t\t};', a);
	return a < 0 || b < 0 ? null : DAIMOND.slice(a, b + 6);
}

// The `finally`'s four total lines.
function liftTotals() {
	const a = DAIMOND.indexOf('run.promptTokens = (run.priorPrompt || 0) + wspent.p;');
	const b = DAIMOND.indexOf('run.costUsd = (run.priorCost || 0) + wspent.cost;', a);
	return a < 0 || b < 0 ? null : DAIMOND.slice(a, b + 'run.costUsd = (run.priorCost || 0) + wspent.cost;'.length);
}

// A stand-in DaimondApp: `restore_session` lays down the counters it is given, as
// `restored_counters` does, and a turn adds its rounds to them.
function fakeApp() {
	return { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cost_usd: 0, restored: null,
		restore_session(msgs, p, c, last, ca, cost) {
			this.restored = msgs;
			this.prompt_tokens = p || 0; this.completion_tokens = c || 0;
			this.cached_tokens = ca || 0; this.cost_usd = cost || 0;
		},
		spend(dp, dc, dca, dcost) {
			this.prompt_tokens += dp; this.completion_tokens += dc;
			this.cached_tokens += dca; this.cost_usd += dcost;
		} };
}

const parts = { restore: liftRestore(), biller: liftBiller(), totals: liftTotals(), appSpend: lift('appSpend') };
check('the restore, the biller, the totals and appSpend are found',
	Object.values(parts).every(Boolean), Object.keys(parts).filter((k) => !parts[k]).join(','));

console.log('a continuation of a 9,000-token run spends 2,000 more');
if (Object.values(parts).every(Boolean)) {
	const billed = [];
	const recordSpend = (model, p, c, ca, cost) => { billed.push({ p, c, ca, cost }); };
	const run = { model: 'm', provider: 'openrouter', diamondId: 'd1', prov: { rid: 'rid-c' },
		_priorSession: [{ role: 'user', content: 'Survey the notes' }, { role: 'assistant', content: 'Read two.' }],
		priorPrompt: 9000, priorCompletion: 600, priorCached: 0, priorCost: 0.06, app: fakeApp() };
	const go = new Function('run', 'recordSpend', parts.appSpend + '\nvar wmeter = null; var self = { persistNow: function () {} };\n'
		+ parts.restore + '\n' + parts.biller + '\n'
		+ 'run.app.spend(2000, 100, 0, 0.01);\nbillAttempt();\n' + parts.totals + '\nreturn wspent;');
	go(run, recordSpend);
	check('the session was restored', !!run.app.restored && run.app.restored.length === 2);
	const p = billed.reduce((s, e) => s + e.p, 0);
	const cost = billed.reduce((s, e) => s + e.cost, 0);
	check('the ledger gets the leg alone (2,000 prompt)', p === 2000, 'p=' + p);
	check('and its cost alone', Math.abs(cost - 0.01) < 1e-9, 'cost=' + cost);
	check('the tile counts the prior run once (11,000 prompt)', run.promptTokens === 11000,
		'total=' + run.promptTokens);
	check('completion likewise (700)', run.completionTokens === 700, 'c=' + run.completionTokens);
}

console.log(`\ncontinuation bill (U3a QA2 #3): ${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
