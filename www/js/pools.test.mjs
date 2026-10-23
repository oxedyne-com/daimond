/* ============================================================
   Test — UNBLOCK-31 D-20261020-13 PS1: money pools that say true things.
   ------------------------------------------------------------
   The rail said "Your OpenRouter key runs out in ~8 h" of an UNCAPPED key
   holding $20 of account credit: one busy minute of ALL spend on THIS
   device, projected over a day, charged to a pool that had spent nothing.
   Each pool now names its binding number, keeps its own windowed rate
   from the synced ledger, in its own currency, and its full height
   travels with the models parcel.

   Failing-first: `MM_SRC_REV=90eaed81 node www/js/pools.test.mjs` runs
   every arm against the live record's code (money.js, needs.js, ledger.js,
   models.js through testlift.mjs), where the pools are the old money rows
   with the governor's 60 s rate, as daimond.js wired them; each arm fails
   there and passes on the head.

   A8 (PS1 review M1, INT provstatus 23 Oct) fails at MM_SRC_REV=ca893eafe
   and under `node www/js/pools.test.mjs --break ledger`, which puts the
   credits pool back on this device's own last reading.
   ============================================================ */
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { source, liftFn } from './testlift.mjs';

const MIN = 60e3;
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

const bi = process.argv.indexOf('--break');
const BREAK = bi > 0 ? process.argv[bi + 1] : '';
const BREAKS = {
	ledger: ['money.js', (s) => s.replace("'exact', '', ledgerMark(c.entries));", "'exact', '', null);")],
};
if (BREAK && !BREAKS[BREAK]) { console.error(`ABORT: no break called "${BREAK}"`); process.exit(2); }

/// A CommonJS-style module from its source text (rev-aware through testlift).
function load(file) {
	const module = { exports: {} };
	let src = source(file);
	if (BREAK && BREAKS[BREAK][0] === file) {
		const out = BREAKS[BREAK][1](src);
		if (out === src) { console.error(`ABORT: the "${BREAK}" break no longer matches`); process.exit(2); }
		src = out;
	}
	new Function('module', 'window', 'globalThis', src)(module, undefined, {});
	return module.exports;
}
const M = load('money.js');
const N = load('needs.js');
const LEDGER = source('ledger.js');
const rateSrc = liftFn(LEDGER, 'rate');
const rate = rateSrc
	? new Function('HOUR_MS', 'reprice', 'load', rateSrc + '\nreturn rate;')(3600e3, (x) => x, () => [])
	: null;

/// The pools as the record drew them, where `pools` does not exist: the money
/// rows, every pool divided by the governor's rate -- the last 60 s of every
/// pool's spend on THIS device only (`local`).
function legacyPools(st) {
	const local = (st.local || []).filter((e) => e.t > st.now - MIN && e.t <= st.now);
	const perMin = local.reduce((a, e) => a + (e.u || 0), 0);
	const provs = (st.providers || []).map((p) => Object.assign({}, p));
	const own = provs.filter((p) => p.hasKey && !p.paid);
	return M.rows({
		authed: st.authed,
		creditsUsd: st.credits ? st.credits.minor / 100 : null,
		creditsMinor: st.credits ? st.credits.minor : null,
		creditsCurrency: st.credits ? st.credits.currency : null,
		providers: provs,
		rateUsdPerMin: perMin,
	}).filter((r) => r.kind !== 'spent').map((r) => ({
		key: r.key === 'own' && own.length === 1 ? own[0].id : r.key, label: r.label, amount: r.usd,
		currency: 'USD', minutes: r.minutes, minutesDay: r.minutes, rate15: perMin * 60, rateDay: perMin * 60,
	}));
}

/// Pools from the code under test. `log` is the merged ledger; `local` this
/// device's own entries (all the record's governor ever saw).
function poolsOf(st) {
	if (!M.pools) return legacyPools(st);
	return M.pools(Object.assign({
		rateOf: (pv, w) => rate(pv, w, st.now, st.log || []),
		fx: { USD: 1, AUD: 1.52 },
	}, st));
}

const key = (id, name, usd, binds) => ({ id, name, hasKey: true, paid: false,
	credit: { mode: 'auto', usd, binds: binds || 'credit' } });
const spend = (pv, t, u) => ({ t, pv, u, m: 'x', p: 1, c: 1 });
const byKey = (list, k) => list.find((p) => p.key === k);

test('A1: another pool\'s spend never gives an idle pool a runway', () => {
	// Fireworks at $3/h for half an hour; OpenRouter, uncapped with $20, idle.
	const log = [];
	for (let i = 0; i < 30; i++) log.push(spend('fireworks', NOW - i * MIN - 1000, 0.05));
	const list = poolsOf({ now: NOW, log, local: log,
		providers: [key('openrouter', 'OpenRouter', 20), { id: 'fireworks', name: 'Fireworks AI', hasKey: true }] });
	const or = byKey(list, 'openrouter');
	assert.ok(or, 'OpenRouter has a pool');
	assert.equal(or.minutes, null, 'an idle pool has no mileage, whatever another pool spends');
	assert.equal(or.minutesDay, null);
	assert.equal(byKey(list, 'fireworks'), undefined, 'a key that reports no balance has no pool');
});

test('A2: $0.50 in one minute then quiet is $2/h over 15 min, and no Top Up at $20', () => {
	const t0 = NOW - 15 * MIN;
	const log = [];
	for (let i = 1; i <= 10; i++) log.push(spend('openrouter', t0 + i * 6000, 0.05));
	const provs = [key('openrouter', 'OpenRouter', 20)];
	for (const now of [t0 + MIN, NOW]) {
		const list = poolsOf({ now, log, local: log, providers: provs });
		const or = byKey(list, 'openrouter');
		assert.ok(Math.abs(or.rate15 - 2) < 1e-9, 'rate15 is $2/h at +' + (now - t0) / MIN + ' min, not ' + or.rate15);
		const rows = N.compute({ pots: list.map((p) => ({ key: p.key, label: p.label,
			minutes: p.minutesDay, minutesDay: p.minutesDay })) });
		assert.deepEqual(rows.map((r) => r.id), [], 'no Status row at a $20 balance');
	}
	// The day's habit still raises it: $0.50 an hour for a day against $5.
	const day = [];
	for (let i = 0; i < 24; i++) day.push(spend('openrouter', NOW - i * 3600e3 - 1000, 0.5));
	const low = poolsOf({ now: NOW, log: day, local: day, providers: [key('openrouter', 'OpenRouter', 5)] });
	const rows = N.compute({ pots: low.map((p) => ({ key: p.key, label: p.label, minutesDay: p.minutesDay })) });
	assert.equal(rows.length, 1, 'a pool lasting ten hours at its day rate raises Top Up');
});

test('A3: the binding number, and an uncapped key named as the account\'s credit', async () => {
	const MODELS = source('models.js');
	const body = liftFn(MODELS, 'askCredit');
	assert.ok(body, 'askCredit present');
	async function ask(keyData, credits) {
		const store = { providers: { openrouter: { name: 'OpenRouter' } } };
		const fetch = async (u) => {
			const leaf = u.split('/').pop();
			const data = leaf === 'key' ? keyData : credits;
			return { ok: !!data, json: async () => ({ data }) };
		};
		const fn = new Function('store', 'providerUrl', 'keyFor', 'canProbeCredit', 'siblingUrl', 'fetch', 'save',
			body + '\nreturn askCredit;')(store, () => 'https://openrouter.ai/api/v1/chat/completions',
			() => 'sk-or-test', () => true, (url, leaf) => 'https://openrouter.ai/api/v1/' + leaf, fetch, () => {});
		await fn('openrouter');
		return store.providers.openrouter.credit;
	}
	const capped = await ask({ limit: 10, limit_remaining: 5 }, { total_credits: 30, total_usage: 28 });
	assert.equal(capped.remainingUsd, 2, 'a capped key holds the smaller of its cap and the account');
	assert.equal(capped.binds, 'credit');
	const cap = await ask({ limit: 10, limit_remaining: 3 }, { total_credits: 30, total_usage: 20 });
	assert.equal(cap.remainingUsd, 3);
	assert.equal(cap.binds, 'limit');
	const open = await ask({ limit: null, limit_remaining: null }, { total_credits: 278.43, total_usage: 258.43 });
	assert.ok(Math.abs(open.remainingUsd - 20) < 1e-9);
	assert.equal(open.binds, 'credit');
	const [or] = poolsOf({ now: NOW, providers: [key('openrouter', 'OpenRouter', 20, 'credit')] });
	assert.doesNotMatch(or.label, /\bkey\b/i, 'the account\'s credit is not "the key": ' + or.label);
	assert.match(or.label, /OpenRouter/);
	const [lim] = poolsOf({ now: NOW, providers: [key('openrouter', 'OpenRouter', 3, 'limit')] });
	assert.match(lim.label, /limit/i, 'a cap that binds is named as the cap');
});

test('A4: two own keys with balances are two pools, never one summed pot', () => {
	const list = poolsOf({ now: NOW, providers: [key('openrouter', 'OpenRouter', 20), key('together', 'Together AI', 7)] });
	assert.deepEqual(list.map((p) => [p.key, p.amount]), [['openrouter', 20], ['together', 7]]);
});

test('A5: spend recorded on another device moves this device\'s dial once merged', () => {
	const provs = [key('openrouter', 'OpenRouter', 20)];
	const mine = [];
	const before = byKey(poolsOf({ now: NOW, log: mine, local: mine, providers: provs }), 'openrouter');
	assert.equal(before.minutes, null);
	const merged = mine.concat([spend('openrouter', NOW - 2 * MIN, 1)]);		// recorded on device B
	const after = byKey(poolsOf({ now: NOW, log: merged, local: mine, providers: provs }), 'openrouter');
	assert.ok(Math.abs(after.rate15 - 4) < 1e-9, 'rate15 $4/h from B\'s dollar, not ' + after.rate15);
	assert.ok(Math.abs(after.minutes - 300) < 1e-6, '$20 at $4/h is 300 min, not ' + after.minutes);
});

test('A6: an A$ credits pool is measured against its rate in A$', () => {
	const log = [];
	for (let k = 0; k < 15; k++) log.push(spend('credits', NOW - k * MIN - 30e3, 1 / 60));	// US$1/h
	const list = poolsOf({ now: NOW, log, local: log, authed: true, credits: { minor: 1520, currency: 'aud' } });
	const c = byKey(list, 'credits');
	assert.equal(c.currency, 'AUD');
	assert.ok(Math.abs(c.amount - 15.2) < 1e-9);
	assert.ok(Math.abs(c.rate15 - 1.52) < 1e-9, 'A$1.52/h, not ' + c.rate15);
	assert.ok(Math.abs(c.minutes - 600) < 1e-6, 'A$15.20 at A$1.52/h is 600 min, not ' + c.minutes);
	// A currency no exchange rate is known for gives no mileage, never a mixed one.
	const x = byKey(poolsOf({ now: NOW, log, local: log, authed: true, credits: { minor: 1520, currency: 'xts' } }), 'credits');
	assert.equal(x.minutes, null);
	assert.equal(x.rate15, null);
});

test('A7: a top-up mark set on A draws the same level on B; an old parcel changes nothing', () => {
	const provs = (usd) => [key('openrouter', 'OpenRouter', usd)];
	const A = {}, B = {};
	const step = (marks, usd, now) => {
		const [p] = M.pools({ now, providers: provs(usd), marks });
		marks[p.key] = p.mark;
		return p;
	};
	step(A, 10, NOW - 60 * MIN); step(B, 10, NOW - 60 * MIN);
	step(A, 4, NOW - 50 * MIN); step(B, 4, NOW - 50 * MIN);
	step(A, 30, NOW - 40 * MIN);							// topped up, seen on A
	const parcel = JSON.parse(JSON.stringify({ topups: M.marksParcel(A) }));
	assert.deepEqual(Object.keys(parcel.topups.openrouter).sort(), ['at', 'full'], 'only the mark travels');
	assert.equal(M.marksMerge(B, parcel.topups), true);
	const a = step(A, 25, NOW), b = step(B, 25, NOW);
	assert.equal(a.full, 30);
	assert.equal(b.full, 30, 'B holds A\'s top-up, and does not count it twice');
	assert.equal(a.level, b.level);
	assert.equal(M.marksMerge(A, B), false, 'the two agree: nothing moves back');
	const held = JSON.stringify(B);
	assert.equal(M.marksMerge(B, undefined), false, 'an old build\'s parcel has no marks');
	assert.equal(JSON.stringify(B), held);
	// The parcel field rides the models store, merged on its own time.
	const MODELS = source('models.js');
	assert.match(liftFn(MODELS, 'exportSync'), /out\.topups = /);
	assert.match(liftFn(MODELS, 'applySync'), /remote\.topups[\s\S]*marksMerge/);
});

test('A8: a reload between a spend and a top-up still reads the top-up as full (the ledger\'s mark)', () => {
	// Full 50, spent to 10 in the last session, whose `last` never reached the disk: the
	// stored mark is the one written at the 50. Then $20 through Stripe, a reload, 30.
	const NS = 1e6;	// the ledger's ts is Unix ns
	const t0 = NOW - 3 * 24 * 60 * MIN, t1 = NOW - 5 * MIN;
	const stored = { credits: { full: 50, at: t0, last: 50 } };
	const entries = [	// newest first, as /api/balance sends them
		{ ts: t1 * NS, kind: 'topup', delta_minor: 2000, balance: 3000 },
		{ ts: (t1 - 60 * MIN) * NS, kind: 'spend', delta_minor: -4000, balance: 1000 },
		{ ts: t0 * NS, kind: 'topup', delta_minor: 5000, balance: 5000 },
	];
	const st = (minor, list) => ({ authed: true, now: NOW, marks: stored, providers: [],
		credits: { minor, currency: 'usd', entries: list } });
	const c = byKey(poolsOf(st(3000, entries)), 'credits');
	assert.ok(c, 'the credits pool is drawn');
	assert.equal(c.full, 30, 'full is the balance right after the newest top-up');
	assert.equal(c.level, 1, 'a fresh top-up reads full, not 0.60');
	// Spend from there reads against it.
	assert.equal(byKey(poolsOf(st(1500, entries)), 'credits').level, 0.5);
	// A refund since the top-up lowers the full height rather than reading as spending.
	const refunded = [{ ts: NOW * NS, kind: 'refund', delta_minor: -1000, balance: 2000 }].concat(entries);
	const r = byKey(poolsOf(st(2000, refunded)), 'credits');
	assert.equal(r.full, 20);
	assert.equal(r.level, 1);
	// A credit the last /api/balance had not seen yet is still a rise.
	assert.equal(byKey(poolsOf(st(6000, entries)), 'credits').full, 60);
	// No credit among the entries returned: the synced mark stands.
	const spends = entries.slice(1, 2);
	assert.equal(byKey(poolsOf(st(1000, spends)), 'credits').full, 50);
	// And the rail hands the pools the ledger it holds.
	assert.match(liftFn(source('daimond.js'), 'moneyPools'), /credits:[^\n]*entries: st\.entries/);
});
