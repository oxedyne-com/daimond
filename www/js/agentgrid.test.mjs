/* ============================================================
   Test — the Agents panel's grid and the rail's credit cylinders
   (D-20261015-10, D-20261015-14).
   ------------------------------------------------------------
   Drives the real agentgrid.js with no browser: what colour a run
   is, how runs fall into rows by origin, that nothing is pinned
   unless a person pinned it (a waiting run is amber, not opened),
   and the cylinder's full height and level.

     node --test www/js/agentgrid.test.mjs
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const G = require('./agentgrid.js');

const run = (id, status, o) => Object.assign({ id, status, name: id, task: 't ' + id }, o || {});

test('state: one colour per state, and waiting on you beats everything', () => {
	assert.equal(G.stateOf(run('w1', 'running')), 'run');
	assert.equal(G.stateOf(run('w1', 'queued')), 'que');
	assert.equal(G.stateOf(run('w1', 'done')), 'done');
	assert.equal(G.stateOf(run('w1', 'error')), 'fail');
	assert.equal(G.stateOf(run('w1', 'interrupted')), 'fail');
	assert.equal(G.stateOf(run('w1', 'capped')), 'fail');
	assert.equal(G.stateOf(run('w1', 'spend_cap')), 'fail');
	assert.equal(G.stateOf(run('w1', 'blocked')), 'fail');
	assert.equal(G.stateOf(run('w1', 'paused')), 'stop');
	assert.equal(G.stateOf(run('w1', 'stopped')), 'stop');
	assert.equal(G.stateOf(run('w1', 'running'), true), 'wait');
});

test('rows: one per origin, newest origin first, start order within, the thread first', () => {
	// Workers.runs is newest first (dispatch unshifts).
	const runs = [
		run('w5', 'running', { chatId: 'c1' }),
		run('w4', 'queued',  { diamondId: 'd1' }),
		run('w3', 'done',    { chatId: 'c1' }),
		run('w2', 'running', { diamondId: 'd1' }),
		run('w1', 'done',    { diamondId: 'd1' }),
	];
	const rows = G.rows(runs, {});
	assert.deepEqual(rows.map(r => r.key), ['c:c1', 'd:d1']);
	assert.deepEqual(rows[1].items.map(i => i.id), ['w1', 'w2', 'w4']);
	assert.deepEqual(rows[0].items.map(i => i.id), ['w3', 'w5']);
	assert.equal(rows[1].orch.st, 'run');
	const quiet = G.rows([run('w1', 'done', { diamondId: 'd1' })], {});
	assert.equal(quiet[0].orch.st, 'done');
});

test('rows: a waiting run is amber, and its thread is live', () => {
	const runs = [run('w1', 'running', { diamondId: 'd1' })];
	const rows = G.rows(runs, { w1: true });
	assert.equal(rows[0].items[0].st, 'wait');
	assert.equal(rows[0].orch.st, 'run');
});

test('done fades with age: the oldest finished square is the faintest', () => {
	const runs = [run('w3', 'done'), run('w2', 'done'), run('w1', 'done')];
	const it = G.rows(runs, {})[0].items;
	assert.ok(it[0].fade < it[2].fade, 'oldest (w1) fainter than newest (w3)');
	assert.ok(it[2].fade <= 0.85 && it[0].fade >= 0.25);
});

test('pins: nothing is pinned by itself, a press toggles, a gone run drops out', () => {
	assert.deepEqual(G.prunePins([], [run('w1', 'running')], { w1: true }), [],
		'a waiting run is not opened below on its own');
	let p = G.togglePin([], 'w1');
	p = G.togglePin(p, 'w2');
	assert.deepEqual(p, ['w1', 'w2']);
	assert.deepEqual(G.togglePin(p, 'w1'), ['w2']);
	assert.deepEqual(G.prunePins(['w1', 'w9'], [run('w1', 'done')]), ['w1']);
});

test('cylinder: full height is the balance right after the last top-up', () => {
	let s = G.peakNext(null, 10);
	assert.deepEqual(s, { peak: 10, last: 10 });
	s = G.peakNext(s, 6);                 // spending: the full height holds
	assert.equal(s.peak, 10);
	s = G.peakNext(s, 4);
	assert.equal(s.peak, 10);
	s = G.peakNext(s, 9);                 // a top-up from 4 to 9: the new full height is 9
	assert.equal(s.peak, 9);
	s = G.peakNext(s, 9);
	assert.equal(s.peak, 9);
	assert.equal(G.level(4.5, 9), 0.5);
	assert.equal(G.level(0, 10), 0);
	assert.equal(G.level(12, 10), 1);
	assert.equal(G.level(5, 0), 0);
});

test('cylinder: drawn as an svg with a glass body and a level, every pool identical', () => {
	const a = G.cylinderSvg(0.5, false, 'A');
	const b = G.cylinderSvg(0.5, false, 'B');
	assert.match(a, /^<svg /);
	assert.match(a, /class="glass"/);
	assert.match(a, /class="liq"/);
	assert.equal(a.replace(/\bA\b/g, 'B'), b);
	assert.doesNotMatch(G.cylinderSvg(0, false, 'E'), /class="liq"/, 'an empty pool has no liquid');
	assert.match(G.cylinderSvg(0.1, true, 'L'), /class="cyl low"/);
});

test('pools: one cylinder per pool with a known balance, low only under a day', () => {
	const rows = [
		{ key: 'credits', label: 'Daimond credits', kind: 'exact', usd: 0, minutes: null },
		{ key: 'own', label: 'Your OpenRouter key', kind: 'estimate', usd: 37.18, minutes: 1212 },
		{ key: 'x', label: 'Spent only', kind: 'spent', usd: 4, minutes: null },
	];
	const store = {};
	const p = G.pools(rows, store);
	assert.equal(p.length, 2, 'a pool with no balance has no cylinder');
	assert.deepEqual(p.map((x) => x.key), ['credits', 'own']);
	assert.equal(p[1].low, true);
	assert.equal(p[0].low, false, 'an empty pool has no runway, so it is not "running out"');
	assert.equal(p[1].level, 1, 'the first reading is the full height');
	assert.deepEqual(store.own, { peak: 37.18, last: 37.18 });
	// Spending lowers the level against the stored full height.
	const q = G.pools([{ key: 'own', label: 'k', kind: 'exact', usd: 18.59, minutes: 2000 }], store);
	assert.equal(q[0].level, 0.5);
	assert.equal(q[0].low, false);
	assert.equal(G.runwayPool(p).key, 'own');
	assert.equal(G.runwayPool(q), null);
	assert.equal(G.runwayHours(p[1]), 20);
});

test('lens: State paints nothing over the state colour; Cost is lightness by spend, log scale', () => {
	assert.equal(G.LENSES.join('|'), 'state|cost|rating|device');
	assert.equal(G.lensPaint('state', run('a', 'done', { costUsd: 1 })), '');
	const pct = (s) => Number(/(\d+)%/.exec(s)[1]);
	const cheap = G.lensPaint('cost', run('a', 'done', { costUsd: 0.002 }));
	const dear  = G.lensPaint('cost', run('b', 'done', { costUsd: 0.9 }));
	const none  = G.lensPaint('cost', run('c', 'queued', { costUsd: 0 }));
	assert.ok(pct(dear) > pct(cheap) && pct(cheap) > pct(none), cheap + ' / ' + dear + ' / ' + none);
	assert.ok(pct(G.lensPaint('cost', run('d', 'done', { costUsd: 50 }))) === 100, 'a dollar and up is full ink');
	// One decade of spend is the same step anywhere on the scale.
	const a = pct(G.lensPaint('cost', run('e', 'done', { costUsd: 0.01 })));
	const b = pct(G.lensPaint('cost', run('f', 'done', { costUsd: 0.1 })));
	assert.ok(b > a);
});

test('lens: Rating is green or red only for a rated run; Device is one hue per device', () => {
	assert.equal(G.lensPaint('rating', run('a', 'done')), 'var(--agl-neutral)');
	assert.match(G.lensPaint('rating', run('a', 'done', { rating: 1 })), /--success/);
	assert.match(G.lensPaint('rating', run('a', 'done', { rating: -1 })), /--danger/);
	const d1 = G.lensPaint('device', run('a', 'done', { deviceId: 'dev-argonaut' }));
	const d1b = G.lensPaint('device', run('b', 'running', { deviceId: 'dev-argonaut' }));
	const d2 = G.lensPaint('device', run('c', 'done', { deviceId: 'dev-gilgamesh' }));
	assert.equal(d1, d1b, 'the same device, the same colour');
	assert.notEqual(d1, d2);
	assert.equal(G.lensPaint('device', run('d', 'done')), 'var(--agl-neutral)', 'no device recorded: neutral');
	assert.equal(G.lensPaint('nonsense', run('a', 'done')), '', 'an unknown lens is State');
});

test('last hour: the spend of the ledger entries in the last sixty minutes, and nothing older', () => {
	const now = 10 * 3600e3;
	const e = [{ t: now - 61 * 60e3, u: 5 }, { t: now - 59 * 60e3, u: 0.25 }, { t: now - 1000, u: 1.5 },
		{ t: now - 10, u: undefined }, null, { t: 'x', u: 9 }];
	assert.equal(G.lastHourUsd(e, now), 1.75);
	assert.equal(G.lastHourUsd([], now), 0);
	assert.equal(G.lastHourUsd(null, now), 0);
});

test('budget: this turn\'s spend over its cap fills a running square bottom-up, capped at full', () => {
	assert.deepEqual(G.budget(run('a', 'running', { costUsd: 1.8, capUsd: 5 })), { spent: 1.8, cap: 5, f: 0.36 });
	// A resumed run carries its earlier legs in priorCost: the cap is per turn, so they do not count.
	assert.deepEqual(G.budget(run('b', 'running', { costUsd: 2.5, priorCost: 2, capUsd: 0.5 })), { spent: 0.5, cap: 0.5, f: 1 });
	assert.equal(G.budget(run('c', 'running', { costUsd: 9, capUsd: 5 })).f, 1);
	// A run from before caps were recorded has no meter: nothing invented.
	assert.equal(G.budget(run('d', 'running', { costUsd: 1 })), null);
	assert.equal(G.budget(run('e', 'running', { costUsd: 0, capUsd: 5 })).f, 0);
});

test('24 h: a finished square fades by its age, and one ended over a day ago leaves the grid', () => {
	const H = 3600e3, now = 100 * H;
	const runs = [run('w4', 'running'), run('w3', 'done', { endedAt: now - 2 * H }), run('w2', 'error', { endedAt: now - 30 * H }),
		run('w1', 'done', { endedAt: now - 20 * H }), run('w0', 'done', { endedAt: now - 25 * H })];
	const it = G.rows(runs, {}, { now })[0].items;
	assert.deepEqual(it.map((x) => x.id), ['w1', 'w3', 'w4'], 'the two ended over 24 h ago are gone');
	assert.equal(it[1].fade, 0.8, 'two hours old: nearly full');
	assert.equal(it[0].fade, 0.35, 'twenty hours old: faint');
	// A search still finds them: the old ones are kept when asked.
	assert.equal(G.rows(runs, {}, { now, keepOld: true })[0].items.length, 5);
	// A run never seen ending (saved before endedAt existed) keeps the order fade and stays.
	const legacy = G.rows([run('a', 'done'), run('b', 'done')], {}, { now })[0].items;
	assert.equal(legacy.length, 2);
	assert.ok(legacy[0].fade < legacy[1].fade);
	// A waiting run is live whatever its stored end.
	assert.equal(G.rows([run('q', 'done', { endedAt: now - 30 * H })], { q: 1 }, { now })[0].items.length, 1);
});

test('endedAt: stamped once when a run ends, cleared when it lives again', () => {
	assert.equal(G.endedAtNext({ status: 'done' }, 500), 500);
	assert.equal(G.endedAtNext({ status: 'error', endedAt: 200 }, 500), 200, 'kept, not moved');
	assert.equal(G.endedAtNext({ status: 'running', endedAt: 200 }, 500), 0, 'resumed: no end');
	assert.equal(G.endedAtNext({ status: 'queued', endedAt: 200 }, 500), 0);
	assert.equal(G.endedAtNext({ status: 'paused' }, 500), 0);
});

test('nested: each later orchestrating turn in a row opens with its own diamond, its runs after it', () => {
	// Newest first, as Workers.runs holds them. Turn t1 sent a and b; the gather round t2 sent c
	// and d; a Diamond's own fan-out with no turn id groups by its batch.
	const runs = [run('d', 'running', { chatId: 'c1', parentId: 't2' }), run('c', 'done', { chatId: 'c1', parentId: 't2' }),
		run('b', 'done', { chatId: 'c1', parentId: 't1' }), run('a', 'done', { chatId: 'c1', parentId: 't1' })];
	const row = G.rows(runs, {})[0];
	assert.deepEqual(row.items.map((x) => x.id), ['a', 'b', 'c', 'd']);
	assert.equal(row.nested.length, 1, 'the first turn sits under the thread diamond; only later ones get their own');
	assert.deepEqual({ at: row.nested[0].at, key: row.nested[0].key, st: row.nested[0].st }, { at: 2, key: 't2', st: 'run' });
	assert.equal(row.nested[0].first.id, 'd', 'named by its newest run');
	// Runs saved before parents were kept are one group: no diamonds invented.
	assert.equal(G.rows([run('x', 'done', { chatId: 'c' }), run('y', 'done', { chatId: 'c' })], {})[0].nested.length, 0);
	// Interleaved starts still group by parent, groups in the order they first began.
	const mix = [run('q', 'done', { parentId: 'p1' }), run('p', 'done', { parentId: 'p2' }), run('o', 'done', { parentId: 'p1' })];
	const r2 = G.rows(mix, {})[0];
	assert.deepEqual(r2.items.map((x) => x.id), ['o', 'q', 'p']);
	assert.equal(r2.nested[0].st, 'done');
});

test('thread: a diamond opens the thread its run came from, a Diamond before a chat', () => {
	assert.deepEqual(G.threadOf(run('a', 'done', { diamondId: 'd1', chatId: 'c1' })), { kind: 'diamond', id: 'd1' });
	assert.deepEqual(G.threadOf(run('b', 'done', { chatId: 'c1' })), { kind: 'chat', id: 'c1' });
	assert.equal(G.threadOf(run('c', 'done')), null, 'nowhere to go: the diamond is not pressable');
});

// AGENT-GRID lead decision (r569 3a): a running square whose provider states no cost fills
// from the same estimate its tile shows, so one figure stands everywhere.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const APP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'daimond.js'), 'utf8');
function lift(name) {
	const m = new RegExp('\\n\\t+function ' + name + '\\(').exec(APP);
	if (!m) return '';
	let d = 0, i = APP.indexOf('{', m.index);
	for (; i < APP.length; i++) { if (APP[i] === '{') d++; else if (APP[i] === '}' && --d === 0) { i++; break; } }
	return APP.slice(m.index + 1, i);
}
test('a running square with no stated cost fills from the tile\'s estimate', () => {
	const window = { DaimondPricing: { priceFor: (m, pt, ct) => ({ usd: (pt + ct) / 1e6, estimated: true }) } };
	const agentBudget = new Function('window', 'DaimondAgentGrid', 'DaimondPricing',
		lift('agentRunSpend') + '\n' + lift('agentBudget') + '\nreturn agentBudget;')(window, G, window.DaimondPricing);
	const r = run('w1', 'running', { model: 'm', capUsd: 5, app: {
		live_prompt_tokens: 400000, live_completion_tokens: 100000, live_cached_tokens: 0, live_cost_usd: 0 } });
	const b = agentBudget(r);
	assert.equal(b.spent, 0.5, 'the square ignored the estimate the tile shows');
	assert.equal(b.f, 0.1);
	// A stated cost still wins over the table.
	r.app.live_cost_usd = 0.2;
	assert.equal(agentBudget(r).spent, 0.2);
});
