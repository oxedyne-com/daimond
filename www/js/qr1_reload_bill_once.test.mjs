/* ============================================================
   Test -- U3a release QA qr1 #3: a leg cut off by a reload is billed EXACTLY ONCE.
   ------------------------------------------------------------
   Runs the REAL persistNow and load: the first load bills the live app's unbilled
   share under the run id; a second load bills nothing; an app already billed by
   `billAttempt` (`run._billedApp`) leaves nothing unbilled; a finished run carries
   no `unbilled` at all, so a normal end is never billed again by a reload.
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// The REAL agent grid helper the Workers record's stampEnds calls (r570s).
globalThis.DaimondAgentGrid = createRequire(import.meta.url)('./agentgrid.js');

const DAIMOND = readPage(new URL('./daimond.js', import.meta.url), 'utf8');
let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log('  ok   ' + name); }
	else { bad++; console.log('  FAIL ' + name + (detail ? '  -- ' + detail : '')); }
};
function liftMethod(name) {
	const a = DAIMOND.indexOf('\t\t' + name + ': function (');
	const b = DAIMOND.indexOf('\n\t\t},', a);
	return DAIMOND.slice(a + ('\t\t' + name + ': ').length, b + 4).replace(/,$/, '');
}
const store = {};
const bills = [];
globalThis.localStorage = { setItem(k, v) { store[k] = v; }, getItem(k) { return store[k] ?? null; } };
globalThis.window = { addEventListener() {} };
const env = 'var WORKERS_KEY="daimond-workers"; var lastHold; function migrateWorkerHold(){} function workersHeld(){return null;}'
	+ ' function dsEvent(){} function readJson(k,f){var v=localStorage.getItem(k);return v==null?f:JSON.parse(v);}'
	+ ' function recordSpend(){ bills.push([].slice.call(arguments)); return {}; }';

// The page that ran the worker is gone, so its run lock is free (U3a QRFIX2 F3: `settleCut`).
const navigator = { locks: { request: (n, o, cb) => Promise.resolve().then(() => cb({ name: n })) } };
const tick = () => new Promise((r) => setTimeout(r, 0));
const mk = (src) => new Function('navigator', 'bills', env + '\nreturn (' + src + ');')(navigator, bills);
const persistNow = mk(liftMethod('persistNow')), load = mk(liftMethod('load')), settleCut = mk(liftMethod('settleCut')), stampEnds = mk(liftMethod('stampEnds'));
const W = () => ({ runs: [], queue: [], seq: 1, dropped: 0, PERSIST_MAX_CHARS: 1e9, FINISHED_KEEP: 40,
	prune() { return false; }, pinned() { return false; }, persist() {}, render() {}, pump() {},
	persistNow() { persistNow.call(this); }, settleCut(r) { settleCut.call(this, r); }, stampEnds });
const LIVE = { live_prompt_tokens: 90000, live_completion_tokens: 6000, live_cached_tokens: 0, live_cost_usd: 0.9 };
const reload = async () => { const b = W(); load.call(b); await tick(); return b; };

console.log('a leg cut off by a reload, then the page reloaded twice');
{
	const a = W();
	a.runs = [{ id: 'w1', name: 'n', task: 't', status: 'running', text: '', said: [], tools: [], model: 'm',
		provider: 'p', diamondId: 'd1', prov: { rid: 'r1' }, promptTokens: 1000, completionTokens: 100,
		priorPrompt: 1000, priorCompletion: 100, priorCost: 0.1, costUsd: 0.1,
		_wspent: { p: 500, c: 50, ca: 0, cost: 0.05 }, app: LIVE }];
	persistNow.call(a);
	const b1 = await reload();
	check('the first load bills the cut leg once, under its run id and Diamond',
		bills.length === 1 && bills[0][1] === 90000 && bills[0][4] === 0.9 && bills[0][6] === 'd1' && bills[0][7] === 'r1',
		JSON.stringify(bills));
	const r = b1.runs[0];
	check('the totals hold prior + billed + live', r.promptTokens === 91500 && Math.abs(r.costUsd - 1.05) < 1e-9,
		r.promptTokens + ' / ' + r.costUsd);
	check('the record no longer carries the unbilled share', !JSON.parse(store['daimond-workers']).runs[0].unbilled);
	await reload();
	check('a second load bills nothing', bills.length === 1, JSON.stringify(bills));
}
console.log('an app already billed (the finally ran) leaves nothing unbilled');
{
	bills.length = 0;
	const a = W();
	a.runs = [{ id: 'w2', name: 'n', task: 't', status: 'running', text: '', said: [], tools: [], model: 'm',
		promptTokens: 0, completionTokens: 0, _wspent: { p: 90000, c: 6000, ca: 0, cost: 0.9 }, app: LIVE }];
	a.runs[0]._billedApp = LIVE;
	persistNow.call(a);
	const b = await reload();
	check('no bill on load', bills.length === 0, JSON.stringify(bills));
	check('the totals still hold the billed leg', b.runs[0].promptTokens === 90000, String(b.runs[0].promptTokens));
}
console.log('a finished run is never billed by a reload');
{
	bills.length = 0;
	const a = W();
	a.runs = [{ id: 'w3', name: 'n', task: 't', status: 'done', text: 'x', said: [], tools: [], model: 'm',
		promptTokens: 90000, completionTokens: 6000, costUsd: 0.9, app: LIVE }];
	persistNow.call(a);
	await reload();
	check('no bill on load', bills.length === 0, JSON.stringify(bills));
}
console.log(`\nreload bill once (qr1): ${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
