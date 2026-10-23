/* ============================================================
   Test -- U3a QRFIX2 F3: a leg is billed ONCE, and a live worker is never another tab's to settle.
   ------------------------------------------------------------
   Runs the REAL persistNow, load, settleCut, holdRunLock and freeRunLock, and the REAL
   `billAttempt` closure of `start()`, over a fake lock manager whose `ifAvailable` is refused
   while a live page holds the run lock. The three paths check A proved (exp_f3.mjs):
   A a second tab opens while a worker runs; B a crash in the 250 ms after the end's bill;
   C a crash after a re-mint's bill. Each must bill what was spent, no more.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// The REAL agent grid helper the Workers record's stampEnds calls (r570s).
globalThis.DaimondAgentGrid = createRequire(import.meta.url)('./agentgrid.js');

const DAIMOND = readFileSync(process.env.DAIMOND_JS || new URL('./daimond.js', import.meta.url), 'utf8');
let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log('  ok   ' + name); }
	else { bad++; console.log('  FAIL ' + name + (detail ? '  -- ' + detail : '')); }
};
function liftMethod(name) {
	const a = DAIMOND.indexOf('\t\t' + name + ': function (');
	if (a < 0) return 'function () {}';	// absent before the fix: the paths below then show the old bills
	const b = DAIMOND.indexOf('\n\t\t},', a);
	return DAIMOND.slice(a + ('\t\t' + name + ': ').length, b + 4).replace(/,$/, '');
}
function liftBillAttempt() {
	const a = DAIMOND.indexOf('var billAttempt = function () {');
	const b = DAIMOND.indexOf('\n\t\t\t};', a);
	return DAIMOND.slice(a + 'var billAttempt = '.length, b + 5).replace(/;$/, '');
}
const store = {};
const bills = [];
const warns = [];
const events = [];
globalThis.localStorage = { setItem(k, v) { store[k] = v; }, getItem(k) { return store[k] ?? null; } };
globalThis.window = { addEventListener() {} };
// The lock manager: one per browser, shared by every tab. A held name refuses `ifAvailable`.
const held = new Set();
const locks = {
	request(name, opts, cb) {
		if (opts.ifAvailable && held.has(name)) return Promise.resolve().then(() => cb(null));
		held.add(name);
		return Promise.resolve().then(() => cb({ name })).finally(() => held.delete(name));
	},
};
const nav = { locks };
const env = 'var WORKERS_KEY="daimond-workers"; var lastHold; function migrateWorkerHold(){} function workersHeld(){return null;}'
	+ ' function dsEvent(n){ events.push(n); } function readJson(k,f){var v=localStorage.getItem(k);return v==null?f:JSON.parse(v);}'
	+ ' function recordSpend(){ bills.push([].slice.call(arguments)); return {}; }'
	+ ' var console = { warn: function (m) { warns.push(m); }, log: function () {} };';
const mk = (src) => new Function('bills', 'warns', 'events', 'navigator', env + '\nreturn (' + src + ');');
const lift = (name) => mk(liftMethod(name));
const M = ['persistNow', 'stampEnds', 'load', 'settleCut', 'holdRunLock', 'freeRunLock'];
const W = (navv) => {
	const w = { runs: [], queue: [], seq: 1, dropped: 0, PERSIST_MAX_CHARS: 1e9, FINISHED_KEEP: 40, RUN_LOCK: 'daimond-run:',
		prune() { return false; }, pinned() { return false; }, persist() {}, render() {}, pump() {} };
	for (const m of M) w[m] = lift(m)(bills, warns, events, navv === undefined ? nav : navv);
	return w;
};
// The real billAttempt, closed over a page `self` and its run as start() closes it.
const mkBill = (self, run) => new Function('bills', 'self', 'run', 'appSpend', 'recordSpend',
	'var wmeter = null; var wbilled = null; var wspent = run._wspent; return (' + liftBillAttempt() + ');')(
	bills, self, run, (a) => ({ p: a.prompt_tokens, c: 0, ca: 0, cost: a.cost_usd }),
	function () { bills.push([].slice.call(arguments)); });
const mkrun = (app) => ({ id: 'w1', name: 'n', task: 't', status: 'running', text: '', said: [], tools: [], model: 'm',
	provider: 'p', diamondId: 'd1', prov: { rid: 'r1' }, promptTokens: 0, completionTokens: 0,
	_wspent: { p: 0, c: 0, ca: 0, cost: 0 }, _billedApp: null, app });
const sum = () => bills.reduce((s, b) => s + b[1], 0);
const tick = () => new Promise((r) => setTimeout(r, 0));
const reset = () => { bills.length = 0; warns.length = 0; events.length = 0; held.clear(); for (const k in store) delete store[k]; };
const crash = (tab) => { for (const r of tab.runs) if (r._unlock) { held.delete('daimond-run:' + r.id); r._unlock = null; } };

console.log('A: a second tab opens while tab A\'s worker runs');
{
	reset();
	const app = { live_prompt_tokens: 50000, live_cost_usd: 0.5, prompt_tokens: 50000, cost_usd: 0.5 };
	const tabA = W(); const run = mkrun(app); tabA.runs = [run];
	tabA.holdRunLock(run); await tick();
	tabA.persistNow();
	const tabB = W(); tabB.load(); await tick();
	check('a new tab never marks another tab\'s live worker interrupted',
		tabB.runs[0].status === 'running' && JSON.parse(store['daimond-workers']).runs[0].status === 'running',
		tabB.runs[0].status);
	app.live_prompt_tokens = app.prompt_tokens = 90000; app.cost_usd = 0.9;
	tabA.persistNow();
	mkBill(tabA, run)(); run.status = 'done'; tabA.freeRunLock(run);
	check('spent 90000, billed 90000', sum() === 90000, 'billed ' + sum() + ' in ' + bills.length);
}
console.log('B: a crash in the 250 ms between the end\'s bill and the debounced persist');
{
	reset();
	const app = { live_prompt_tokens: 90000, live_cost_usd: 0.9, prompt_tokens: 90000, cost_usd: 0.9 };
	const tabA = W(); const run = mkrun(app); tabA.runs = [run];
	tabA.holdRunLock(run); await tick();
	tabA.persistNow();
	mkBill(tabA, run)(); run.status = 'done';
	crash(tabA);
	const b = W(); b.load(); await tick();
	check('spent 90000, billed 90000', sum() === 90000, 'billed ' + sum() + ' in ' + bills.length);
}
console.log('C: a crash after a re-mint\'s bill, before the new app\'s first round end');
{
	reset();
	const old = { live_prompt_tokens: 40000, live_cost_usd: 0.4, prompt_tokens: 40000, cost_usd: 0.4 };
	const tabA = W(); const run = mkrun(old); tabA.runs = [run];
	tabA.holdRunLock(run); await tick();
	tabA.persistNow();
	mkBill(tabA, run)();
	run.app = { live_prompt_tokens: 0, live_cost_usd: 0, prompt_tokens: 0, cost_usd: 0 };
	crash(tabA);
	const b = W(); b.load(); await tick();
	check('spent 40000, billed 40000', sum() === 40000, 'billed ' + sum() + ' in ' + bills.length);
}
console.log('a leg whose page really died is still billed once and marked interrupted');
{
	reset();
	const app = { live_prompt_tokens: 70000, live_cost_usd: 0.7, prompt_tokens: 70000, cost_usd: 0.7 };
	const tabA = W(); const run = mkrun(app); tabA.runs = [run];
	tabA.holdRunLock(run); await tick();
	tabA.persistNow();
	crash(tabA);
	const b = W(); b.load(); await tick();
	check('billed 70000 once', sum() === 70000 && bills.length === 1, JSON.stringify(bills));
	check('marked interrupted, in memory and on the record',
		b.runs[0].status === 'interrupted' && JSON.parse(store['daimond-workers']).runs[0].status === 'interrupted'
		&& !JSON.parse(store['daimond-workers']).runs[0].unbilled);
	const c = W(); c.load(); await tick();
	check('a second load bills nothing', bills.length === 1, JSON.stringify(bills));
}
console.log('with no lock manager, a running record is neither billed nor marked, and said once');
{
	reset();
	const app = { live_prompt_tokens: 60000, live_cost_usd: 0.6, prompt_tokens: 60000, cost_usd: 0.6 };
	const tabA = W({}); const run = mkrun(app); tabA.runs = [run, Object.assign(mkrun(app), { id: 'w2' })];
	tabA.persistNow();
	const b = W({}); b.load(); await tick();
	check('no bill', bills.length === 0, JSON.stringify(bills));
	check('left running', b.runs.every((r) => r.status === 'running'));
	check('said once, by name', warns.length === 1 && /navigator\.locks/.test(warns[0]) && events.filter((e) => e === 'workers.nolocks').length === 1,
		JSON.stringify(warns));
}
console.log('start() takes the run lock before the run reads as running, and gives it back');
{
	const a = DAIMOND.indexOf('\t\tstart: async function (run) {');
	const body = DAIMOND.slice(a, DAIMOND.indexOf('\n\t\t},', a));
	const h = body.indexOf('this.holdRunLock(run);'), s = body.indexOf("run.status = 'running';");
	check('held before `running`', h > 0 && h < s);
	check('given back by closeEarly', /var closeEarly = function \(\) \{\n\t+self2\.freeRunLock\(run\);/.test(body));
	check('given back in the finally after the last bill', /\} finally \{[\s\S]*?billAttempt\(\);\n\t+this\.freeRunLock\(run\);/.test(body));
}
console.log(`\nrun lock (qr2 F3): ${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
