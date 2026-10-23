/* ============================================================
   Test -- U3a LOCKSTOP: locking the app is a Stop of every running worker, never an emptied record.
   ------------------------------------------------------------
   `lockApp` emptied `Workers.runs` while workers ran. The running worker's `finally` then saved
   the record from that empty list, so its run dropped off the record and the screen: the work,
   its spend and its tile gone, with nothing said. The ruling (rulings §1, one rule for every
   Stop): locking is a Stop through the SAME `stop` a person's Stop uses -- each running worker
   keeps its partial answer, is marked stopped, is billed once and its run lock freed, and the
   record is saved BEFORE the list is cleared. A save while locked refuses, named, said once.

   Runs the REAL stop, persistNow, load, holdRunLock, freeRunLock and lockStop, and the REAL
   `billAttempt` closure of `start()`, wired to the run as `start()` wires it.
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
// Before the fix there is no `lockStop`: `lockApp` did `Workers.runs = []`, which is what stands in.
const TODAY = 'function () { this.runs = []; }';
function liftMethod(name) {
	const a = DAIMOND.indexOf('\t\t' + name + ': function (');
	if (a < 0) return name === 'lockStop' ? TODAY : 'function () {}';
	const b = DAIMOND.indexOf('\n\t\t},', a);
	return DAIMOND.slice(a + ('\t\t' + name + ': ').length, b + 4).replace(/,$/, '');
}
function liftBillAttempt() {
	const a = DAIMOND.indexOf('var billAttempt = function () {');
	const b = DAIMOND.indexOf('\n\t\t\t};', a);
	return DAIMOND.slice(a + 'var billAttempt = '.length, b + 5).replace(/;$/, '');
}
const store = {};
const bills = [], warns = [], events = [];
globalThis.localStorage = { setItem(k, v) { store[k] = v; }, getItem(k) { return store[k] ?? null; } };
globalThis.window = { addEventListener() {} };
const held = new Set();
const nav = { locks: {
	request(name, opts, cb) {
		if (opts.ifAvailable && held.has(name)) return Promise.resolve().then(() => cb(null));
		held.add(name);
		return Promise.resolve().then(() => cb({ name })).finally(() => held.delete(name));
	},
} };
const env = 'var WORKERS_KEY="daimond-workers"; var lastHold; function migrateWorkerHold(){} function workersHeld(){return null;}'
	+ " var RESUMABLE_ENDINGS = ['paused', 'interrupted', 'capped', 'spend_cap', 'timed_out'];"
	+ ' function dsEvent(n){ events.push(n); } function readJson(k,f){var v=localStorage.getItem(k);return v==null?f:JSON.parse(v);}'
	+ ' function recordSpend(){ bills.push([].slice.call(arguments)); return {}; }'
	+ ' var console = { warn: function (m) { warns.push(m); }, log: function () {} };';
const lift = (name) => new Function('bills', 'warns', 'events', 'navigator', env + '\nreturn (' + liftMethod(name) + ');');
const M = ['stop', 'persistNow', 'stampEnds', 'load', 'holdRunLock', 'freeRunLock', 'lockStop'];
const W = () => {
	const w = { runs: [], queue: [], seq: 1, dropped: 0, PERSIST_MAX_CHARS: 1e9, FINISHED_KEEP: 40, RUN_LOCK: 'daimond-run:',
		prune() { return false; }, pinned() { return false; }, persist() {}, render() {}, pump() {}, settleCut() {} };
	for (const m of M) w[m] = lift(m)(bills, warns, events, nav);
	return w;
};
const mkBill = (self, run) => new Function('bills', 'self', 'run', 'appSpend', 'recordSpend',
	'var wmeter = null; var wbilled = null; var wspent = run._wspent; return (' + liftBillAttempt() + ');')(
	bills, self, run, (a) => ({ p: a.prompt_tokens, c: 0, ca: 0, cost: a.cost_usd }),
	function () { bills.push([].slice.call(arguments)); });
const mkrun = (id, app) => ({ id, name: 'n', task: 't', status: 'running', text: 'half an answer', said: [], tools: [],
	model: 'm', provider: 'p', diamondId: 'd1', prov: { rid: 'r' + id }, promptTokens: 0, completionTokens: 0,
	priorPrompt: 1000, _wspent: { p: 0, c: 0, ca: 0, cost: 0 }, _billedApp: null, app });
const tick = () => new Promise((r) => setTimeout(r, 0));
const record = () => JSON.parse(store['daimond-workers'] || '{"runs":[]}').runs;
const sum = () => bills.reduce((s, b) => s + b[1], 0);
// The tail of `start()`'s `finally` as it bears on the record: the last bill, the lock, the totals, a save.
const finish = (w, run, bill) => {
	bill(); w.freeRunLock(run);
	run.promptTokens = (run.priorPrompt || 0) + run._wspent.p;
	w.persistNow();
};

console.log('(a) lock while a worker runs: the run stays on the record, stopped, with its partial answer');
{
	const app = { live_prompt_tokens: 50000, live_cost_usd: 0.5, prompt_tokens: 50000, cost_usd: 0.5, abort() { this.aborted = true; } };
	const w = W(); const run = mkrun('w1', app);
	const done = mkrun('w2', null); done.status = 'done'; done.text = 'a whole answer';
	w.runs = [done, run];
	w.holdRunLock(run); await tick();
	const bill = mkBill(w, run); run._bill = bill;	// as start() wires it
	w.persistNow();
	w.lockStop();
	check('the in-memory list is cleared', w.runs.length === 0, String(w.runs.length));
	const before = record().find((r) => r.id === 'w1');
	check('the run is on the record before any finally runs', !!before, JSON.stringify(record().map((r) => r.id)));
	check('marked stopped through stop(): the app was aborted', run.status === 'stopped' && app.aborted === true, run.status);
	check('billed once at the lock', bills.length === 1 && sum() === 50000, JSON.stringify(bills));
	const unlockedNow = !run._unlock; await tick(); await tick();
	check('its run lock is freed', unlockedNow && !held.has('daimond-run:w1'));
	check('the record carries its spend', before && before.promptTokens === 51000, before && before.promptTokens);
	// The aborted worker's finally runs after the lock.
	finish(w, run, bill);
	const after = record();
	check('the finally after the lock does not drop it', after.some((r) => r.id === 'w1' && r.status === 'stopped'
		&& r.text === 'half an answer'), JSON.stringify(after.map((r) => [r.id, r.status])));
	check('the finished run is kept as well', after.some((r) => r.id === 'w2' && r.text === 'a whole answer'));
	check('still billed once after the finally', bills.length === 1 && sum() === 50000, JSON.stringify(bills));
	// Unlock: the record comes back, and the stopped run is not a cut-off leg to settle again.
	const u = W(); u.load(); await tick();
	check('unlock brings the stopped run back', u.runs.some((r) => r.id === 'w1' && r.status === 'stopped'));
	check('and bills nothing more', bills.length === 1, JSON.stringify(bills));
}
console.log('(b) a save while locked refuses; it never writes an empty list');
{
	for (const k in store) delete store[k]; bills.length = 0; warns.length = 0; events.length = 0;
	const w = W(); const run = mkrun('w3', null); run.status = 'done';
	w.runs = [run]; w.persistNow();
	w.lockStop();
	w.persistNow(); w.persistNow();
	check('the record still holds the run', record().some((r) => r.id === 'w3'), JSON.stringify(record()));
	const said = warns.filter((m) => /locked/.test(m));
	check('refused, named, said once', said.length === 1 && events.filter((e) => e === 'workers.persist_locked').length === 1,
		JSON.stringify(warns) + ' ' + JSON.stringify(events));
	// After unlock, saving works again.
	w.load(); w.runs.push(Object.assign(mkrun('w4', null), { status: 'done' })); w.persistNow();
	check('after unlock (load) the record is written again', record().some((r) => r.id === 'w4'), JSON.stringify(record().map((r) => r.id)));
}
console.log('wiring: lockApp stops through lockStop, and start() hands the run its biller');
{
	const a = DAIMOND.indexOf('\tfunction lockApp(keepSession) {');
	const body = DAIMOND.slice(a, DAIMOND.indexOf('\n\t}\n', a));
	check('lockApp calls Workers.lockStop()', /Workers\.lockStop\(\);/.test(body));
	check('lockApp no longer empties the list itself', !/Workers\.runs = \[\];/.test(body));
	const s = DAIMOND.indexOf('\t\tstart: async function (run) {');
	const sb = DAIMOND.slice(s, DAIMOND.indexOf('\n\t\t},', s));
	check('start() sets run._bill = billAttempt', /run\._bill = billAttempt;/.test(sb));
}
console.log(`\nlockstop (u3a): ${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
