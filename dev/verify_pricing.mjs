// verify_pricing.mjs — the cost pipeline's pure core, under Node.
//
// "This session" overstated real OpenRouter spend about six-fold, and not one
// part of that was a counting bug. Four separate things were wrong, and each is
// checked here, on the code as it is now, with the OLD behaviour reproduced
// beside it so the fix stays proven rather than merely asserted:
//
//   1. the rate table held direct-provider list prices 2.3x-4.5x above what a
//      router actually charges;
//   2. cached prompt tokens were billed at the full input rate, because nothing
//      ever supplied a cached count;
//   3. the resolver tested substrings BOTH ways and returned the first hit in
//      object order, so `deepseek/deepseek-v3.2-exp` was billed at v3.1's rate;
//   4. the unknown-model fallback (1.00/3.00) caught most current router ids at
//      roughly four times reality.
//
// It also checks the ledger's new reported-cost path and the gateway's balance
// notice. Everything here is pure: no browser, no network, no gateway. The
// modules are IIFEs guarded on `window`, so they are evaluated in a sandbox with
// a stub -- the same trick verify_governor.mjs uses.
import { readFileSync } from 'fs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── Load the modules under a stub window ───────────────────────────

function loadModule(rel, extra = {}) {
	const src = readFileSync(new URL('../www/' + rel, import.meta.url), 'utf8');
	const names = ['window', ...Object.keys(extra)];
	const vals  = [extra.window, ...Object.keys(extra).map(k => extra[k])];
	// eslint-disable-next-line no-new-func
	new Function(...names, src)(...vals);
	return extra.window;
}

// A localStorage that lives in memory, so the ledger can be driven without a
// browser and without leaving anything behind.
function memStore() {
	const map = new Map();
	return {
		getItem:    k => (map.has(k) ? map.get(k) : null),
		setItem:    (k, v) => { map.set(k, String(v)); },
		removeItem: k => { map.delete(k); },
		_map:       map,
	};
}

const win = {};
const store = memStore();
loadModule('js/pricing.js', { window: win });
loadModule('js/ledger.js',  { window: win, localStorage: store });

const P = win.DaimondPricing;
const L = win.DaimondLedger;
const C = P._core;

// ── 1. The table holds routed prices, not list prices ──────────────
{
	// Measured against openrouter.ai/api/v1/models on 2026-07-30. These are the
	// figures the table was 2.3x-4.5x above.
	const real = [
		['z-ai/glm-5.2',                    0.6153, 1.9338, 0.11427],
		['deepseek/deepseek-r1',             0.70,  2.50,   null],
		['deepseek/deepseek-v4-pro',         0.435, 0.87,   0.003625],
		['openai/gpt-oss-120b',              0.037, 0.17,   null],
		['meta-llama/llama-3.3-70b-instruct', 0.13, 0.40,   null],
		['deepseek/deepseek-chat-v3.1',      0.25,  0.95,   0.13],
		['moonshotai/kimi-k2',               0.57,  2.30,   null],
		['deepseek/deepseek-v3.2',           0.269, 0.40,   0.1345],
		['meta-llama/llama-4-scout',         0.10,  0.30,   null],
		['meta-llama/llama-4-maverick',      0.20,  0.80,   null],
		['qwen/qwen3-235b-a22b',             0.455, 1.82,   null],
	];
	let wrong = [];
	for (const [id, i, o, ca] of real) {
		const r = P.rate(id);
		if (!r) { wrong.push(id + ' unknown'); continue; }
		if (!near(r.inUsdPerM, i) || !near(r.outUsdPerM, o)) {
			wrong.push(`${id} ${r.inUsdPerM}/${r.outUsdPerM} vs ${i}/${o}`);
		}
		if (ca !== null && !near(r.cachedInUsdPerM, ca)) {
			wrong.push(`${id} cached ${r.cachedInUsdPerM} vs ${ca}`);
		}
	}
	check('the table matches the routed prices actually charged', wrong.length === 0,
		wrong.join('; '));

	// The old figures, and what they would have cost. This is the six-fold
	// overstatement in one line, kept so nobody "tidies" the table back.
	const OLD_GLM = { in: 1.40, out: 4.40 };
	const now = P.rate('z-ai/glm-5.2');
	check('glm-5.2 input is no longer more than double reality',
		OLD_GLM.in / now.inUsdPerM > 2.2 && near(now.inUsdPerM, 0.6153),
		`old ${OLD_GLM.in} vs now ${now.inUsdPerM}`);
	check('glm-5.2 output is no longer more than double reality',
		OLD_GLM.out / now.outUsdPerM > 2.2);
}

// ── 2. A cached token costs less than a fresh one ──────────────────
{
	const M = 1e6;
	const fresh  = P.priceFor('z-ai/glm-5.2', M, 0, 0);
	const cached = P.priceFor('z-ai/glm-5.2', M, 0, M);
	check('priceFor charges a cached prompt less than a fresh one',
		cached.usd < fresh.usd, `${cached.usd} vs ${fresh.usd}`);
	check('a wholly cached prompt costs the published cache rate',
		near(cached.usd, 0.11427), 'got ' + cached.usd);
	// The old call site hardcoded cachedTokens: 0, so this is exactly what the
	// app was paying for -- an agentic loop's prompt is mostly cache.
	check('billing a cached prompt as fresh overstates it by the rate ratio',
		near(fresh.usd / cached.usd, 0.6153 / 0.11427, 1e-6),
		'ratio ' + (fresh.usd / cached.usd).toFixed(3));
	// A cached count larger than the prompt is a provider bug, not a discount.
	check('cached tokens cannot exceed the prompt',
		near(P.priceFor('z-ai/glm-5.2', 1000, 0, 999999).usd,
			P.priceFor('z-ai/glm-5.2', 1000, 0, 1000).usd));
	// A model with no published cache rate bills cache at the input rate, which
	// is the honest reading of "no discount published".
	const noCache = P.rate('deepseek/deepseek-r1');
	check('a model with no published cache rate says so', noCache.cachedInUsdPerM === null);
	check('and its cached tokens bill at the input rate',
		near(P.priceFor('deepseek/deepseek-r1', 1e6, 0, 1e6).usd, 0.70));
}

// ── 3. The resolver cannot mis-map ─────────────────────────────────
//
// RED FIRST. This is the algorithm and the table as they shipped at seal 45,
// reproduced verbatim, so the defect is demonstrated rather than described.
{
	const OLD_TABLE = {
		'glm-5.2':          { in: 1.40, out: 4.40, alias: ['glm-5p2', 'glm5.2'] },
		'deepseek-v3.1':    { in: 0.60, out: 1.70, alias: ['deepseek-ai/deepseek-v3.1', 'deepseek-v3', 'deepseek-ai/deepseek-v3', 'deepseek-v3p1'] },
		'deepseek-r1':      { in: 3.00, out: 7.00, alias: ['deepseek-ai/deepseek-r1'] },
		'deepseek-v3.2':    { in: 0.26, out: 0.38, alias: ['deepseek-ai/deepseek-v3.2', 'deepseek-v3p2'] },
		'kimi-k2':          { in: 1.00, out: 3.00, alias: ['moonshotai/kimi-k2'] },
	};
	const OLD_INDEX = {};
	for (const id in OLD_TABLE) {
		OLD_INDEX[C.norm(id)] = id;
		for (const a of (OLD_TABLE[id].alias || [])) OLD_INDEX[C.norm(a)] = id;
	}
	// The shipped resolve: exact, then a two-way substring test in object order.
	const oldResolve = (model) => {
		const key = C.norm(model);
		if (!key) return null;
		if (OLD_INDEX[key]) return OLD_TABLE[OLD_INDEX[key]];
		for (const k in OLD_INDEX) {
			if (key.indexOf(k) !== -1 || k.indexOf(key) !== -1) return OLD_TABLE[OLD_INDEX[k]];
		}
		return null;
	};

	const oldHit = oldResolve('deepseek/deepseek-v3.2-exp');
	check('RED: the old resolver billed deepseek-v3.2-exp at v3.1\'s rate',
		oldHit !== null && near(oldHit.in, 0.60),
		'old resolve gave in=' + (oldHit && oldHit.in));
	const nowHit = P.rate('deepseek/deepseek-v3.2-exp');
	check('GREEN: it now resolves to its own entry',
		nowHit !== null && near(nowHit.inUsdPerM, 0.27) && near(nowHit.outUsdPerM, 0.41),
		'now in=' + (nowHit && nowHit.inUsdPerM));
	check('and the v3.2-exp rate is not the v3.2 rate either',
		!near(nowHit.outUsdPerM, 0.40), 'out=' + nowHit.outUsdPerM);

	// The reverse direction was the other half of the fault: a bare id matched a
	// LONGER table key. Shown on the old algorithm, then absent from the new one.
	const oldBare = oldResolve('z-ai/glm-5');
	check('RED: the old resolver matched a bare glm-5 against glm-5.2',
		oldBare !== null && near(oldBare.in, 1.40));
	check('GREEN: glm-5 now gets its own, dearer, rate',
		near(P.rate('z-ai/glm-5').inUsdPerM, 0.95));

	// The property, over the whole table: every canonical id and every alias
	// resolves to its OWN entry, and no id resolves to an entry other than the
	// owner of its longest matching key.
	let selfFails = [];
	for (const id in C.TABLE) {
		if (C.resolve(id) !== C.TABLE[id]) selfFails.push(id);
		for (const a of (C.TABLE[id].alias || [])) {
			if (C.resolve(a) !== C.TABLE[id]) selfFails.push(a + ' → not ' + id);
		}
	}
	check('every canonical id and alias resolves to itself', selfFails.length === 0,
		selfFails.slice(0, 4).join('; '));

	const longestOwner = (model) => {
		const key = C.norm(model);
		if (!key) return null;
		if (C.INDEX[key]) return C.TABLE[C.INDEX[key]];
		let best = null;
		for (const k of Object.keys(C.INDEX)) {
			if (key.indexOf(k) !== -1 && (best === null || k.length > best.length)) best = k;
		}
		return best === null ? null : C.TABLE[C.INDEX[best]];
	};
	// A corpus of real router ids, table members and near-misses.
	const corpus = [
		'z-ai/glm-5.2', 'z-ai/glm-5.1', 'z-ai/glm-5', 'z-ai/glm-5-turbo', 'z-ai/glm-4.6',
		'z-ai/glm-4.7', 'z-ai/glm-4.7-flash', 'z-ai/glm-4.5-air',
		'deepseek/deepseek-chat', 'deepseek/deepseek-chat-v3.1', 'deepseek/deepseek-v3.1-terminus',
		'deepseek/deepseek-v3.2', 'deepseek/deepseek-v3.2-exp', 'deepseek/deepseek-r1',
		'deepseek/deepseek-r1-0528', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash',
		'moonshotai/kimi-k2', 'moonshotai/kimi-k2-0905', 'moonshotai/kimi-k2.5',
		'moonshotai/kimi-k2.6', 'moonshotai/kimi-k2-thinking', 'moonshotai/kimi-k3',
		'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'openai/gpt-5.4', 'openai/gpt-5.2',
		'anthropic/claude-opus-5', 'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4.5',
		'google/gemini-3.1-pro-preview', 'google/gemini-2.5-flash', 'google/gemini-3.6-flash',
		'meta-llama/llama-3.3-70b-instruct', 'meta-llama/llama-4-scout', 'meta-llama/llama-4-maverick',
		'qwen/qwen3-235b-a22b', 'qwen/qwen3-coder', 'qwen/qwen3-max', 'qwen/qwen3.7-plus',
		'minimax/minimax-m2', 'minimax/minimax-m2.5', 'minimax/minimax-m3',
		'x-ai/grok-4.5', 'x-ai/grok-4.3',
		'accounts/fireworks/models/glm-5p2', 'accounts/fireworks/models/deepseek-v4-pro',
	];
	let propFails = [];
	for (const id of corpus) {
		if (C.resolve(id) !== longestOwner(id)) propFails.push(id);
	}
	check('no id resolves to anything but its longest-matching-key owner',
		propFails.length === 0, propFails.slice(0, 5).join(', '));

	// Prove the property test has teeth: the OLD algorithm, run over the NEW
	// table, violates it. A check that cannot fail proves nothing.
	const oldOverNew = (model) => {
		const key = C.norm(model);
		if (!key) return null;
		if (C.INDEX[key]) return C.TABLE[C.INDEX[key]];
		for (const k in C.INDEX) {
			if (key.indexOf(k) !== -1 || k.indexOf(key) !== -1) return C.TABLE[C.INDEX[k]];
		}
		return null;
	};
	let oldViolations = corpus.filter(id => oldOverNew(id) !== longestOwner(id));
	check('RED: the old algorithm violates that property on the new table',
		oldViolations.length > 0, oldViolations.slice(0, 5).join(', '));
}

// ── 4. The fallback is no longer four times reality ────────────────
{
	check('the fallback input rate is honest', near(P.fallback.inUsdPerM, 0.40),
		'got ' + P.fallback.inUsdPerM);
	check('the fallback output rate is honest', near(P.fallback.outUsdPerM, 1.20));
	check('the fallback publishes a cache discount', P.fallback.cachedInUsdPerM < P.fallback.inUsdPerM);
	// The old 1.00/3.00 against the median of what the table now holds.
	const ins = Object.keys(C.TABLE).map(k => C.TABLE[k].in).sort((a, b) => a - b);
	const median = ins[Math.floor(ins.length / 2)];
	check('and it is within a factor of three of the table median',
		P.fallback.inUsdPerM / median < 3 && median / P.fallback.inUsdPerM < 3,
		`fallback ${P.fallback.inUsdPerM} vs median ${median}`);
	const unknown = P.priceFor('some-vendor/never-heard-of-it', 1e6, 1e6, 0);
	check('an unknown model is marked estimated', unknown.estimated === true);
	check('and a known one is not', P.priceFor('z-ai/glm-5.2', 1000, 100, 0).estimated === false);
	check('the source is named', P.priceFor('z-ai/glm-5.2', 10, 1, 0).source === 'table'
		&& unknown.source === 'fallback');
}

// ── 5. A live rate from the provider beats the table ───────────────
{
	win.DaimondModels = {
		rateFor: (provider, model) => (provider === 'openrouter' && model === 'z-ai/glm-5.2')
			? { inPerM: 0.5, outPerM: 1.5, cachedPerM: 0.05, ctx: 999 } : null,
	};
	const live = P.priceFor('z-ai/glm-5.2', 1e6, 0, 0, 'openrouter');
	check('a live quote is used ahead of the table', near(live.usd, 0.5), 'got ' + live.usd);
	check('a live quote is not called an estimate', live.estimated === false && live.source === 'live');
	check('a live context window wins too', P.contextWindow('z-ai/glm-5.2', 'openrouter') === 999);
	check('without a provider the table still answers',
		near(P.priceFor('z-ai/glm-5.2', 1e6, 0, 0).usd, 0.6153));
	check('an unknown provider falls back to the table',
		near(P.priceFor('z-ai/glm-5.2', 1e6, 0, 0, 'groq').usd, 0.6153));
	delete win.DaimondModels;
}

// ── 6. The ledger stores a reported cost verbatim ──────────────────
{
	store._map.clear();
	const t0 = Date.now();
	// The end-to-end figure from the diagnosis: usage.cost 0.0021.
	const rep = L.record({ ts: t0, model: 'z-ai/glm-5.2', promptTokens: 10240,
		completionTokens: 128, cachedTokens: 9216, costUsd: 0.0021, provider: 'openrouter' });
	check('a reported cost is stored verbatim', rep.u === 0.0021, 'got ' + rep.u);
	check('and flagged as reported', rep.r === 1);
	check('and not marked estimated', !rep.e);
	check('the provider is recorded', rep.pv === 'openrouter');
	// What the table would have said, so the gap is on the record.
	const guess = P.priceFor('z-ai/glm-5.2', 10240, 128, 9216).usd;
	check('the reported figure differs from the table\'s guess', !near(rep.u, guess),
		`reported ${rep.u} vs priced ${guess.toFixed(6)}`);

	const est = L.record({ ts: t0 + 1000, model: 'z-ai/glm-5.2', promptTokens: 100,
		completionTokens: 10, cachedTokens: 0, provider: 'openrouter' });
	check('no reported cost falls back to the table', est.r === undefined && est.u > 0);
	check('and a fallback entry is not flagged reported', !est.r);
	// A zero or nonsense reported cost is not a report.
	const zero = L.record({ ts: t0 + 2000, model: 'z-ai/glm-5.2', promptTokens: 100,
		completionTokens: 10, cachedTokens: 0, costUsd: 0, provider: 'openrouter' });
	check('a reported zero is treated as "did not say"', !zero.r && zero.u > 0);
	const nan = L.record({ ts: t0 + 3000, model: 'z-ai/glm-5.2', promptTokens: 100,
		completionTokens: 10, cachedTokens: 0, costUsd: NaN, provider: 'openrouter' });
	check('a NaN reported cost is ignored', !nan.r && nan.u > 0);

	const tot = L.totals();
	check('the session total separates reported from priced',
		near(tot.session.reportedUsd, 0.0021) && tot.session.usd > tot.session.reportedUsd,
		`reported ${tot.session.reportedUsd} of ${tot.session.usd}`);
}

// ── 7. perProvider sums the right entries and only those ───────────
{
	store._map.clear();
	const base = Date.now() - 60 * 60 * 1000;	// an hour ago
	// Two on the provider we care about, after the base moment.
	L.record({ ts: base + 1000, model: 'm', promptTokens: 1, completionTokens: 1,
		costUsd: 0.10, provider: 'openrouter' });
	L.record({ ts: base + 2000, model: 'm', promptTokens: 1, completionTokens: 1,
		costUsd: 0.25, provider: 'openrouter' });
	// A decoy on another provider.
	L.record({ ts: base + 3000, model: 'm', promptTokens: 1, completionTokens: 1,
		costUsd: 9.99, provider: 'groq' });
	// A decoy BEFORE the base moment: already accounted for in the user's figure.
	L.record({ ts: base - 5000, model: 'm', promptTokens: 1, completionTokens: 1,
		costUsd: 5.55, provider: 'openrouter' });
	// A decoy with no provider at all, as an entry written before `pv` existed.
	L.record({ ts: base + 4000, model: 'm', promptTokens: 1, completionTokens: 1,
		costUsd: 7.77 });

	const rows = L.perProvider(base);
	const byId = {};
	rows.forEach(r => { byId[r.provider] = r; });
	check('perProvider sums only the named provider, only after `since`',
		near(byId.openrouter.usd, 0.35), 'got ' + (byId.openrouter && byId.openrouter.usd));
	check('a decoy on another provider is excluded', near(byId.groq.usd, 9.99));
	check('an entry with no provider groups under the empty id',
		byId[''] !== undefined && near(byId[''].usd, 7.77));
	check('perProvider counts turns', byId.openrouter.turns === 2);
	check('perProvider tracks the reported part', near(byId.openrouter.reportedUsd, 0.35));
	check('rows come back dearest first', rows[0].usd >= rows[rows.length - 1].usd);
	check('an epoch-zero window sees everything',
		near(L.perProvider(0).filter(r => r.provider === 'openrouter')[0].usd, 5.90));
}

// ── 8. Old entries still read — and their guesses are REPRICED ─────
{
	// A store written before `pv` and `r` existed, priced by the old table
	// whose guesses ran ~6x high. Every reader must tolerate the shape — and
	// the first read must reprice the guesses under the corrected table
	// (keeping the original in `u0`), because the stale figures were still
	// inflating every total the user saw.
	store._map.set('daimond-ledger', JSON.stringify([
		{ t: Date.now() - 1000, m: 'glm-5.2', p: 100, c: 10, ca: 0, u: 0.5, e: false },
		{ t: Date.now() - 500,  m: 'glm-5.2', p: 100, c: 10, ca: 0, u: 0.25, e: true },
	]));
	// A fresh module life: repricing runs once per life, on the first read —
	// which is what boot does. The long-lived L above has already spent its
	// pass on earlier sections' stores.
	const win8 = { };
	loadModule('js/pricing.js', { window: win8 });
	loadModule('js/ledger.js',  { window: win8, localStorage: store });
	const L = win8.DaimondLedger;
	const fair = P.priceFor('glm-5.2', 100, 10, 0, '').usd;
	const tot = L.totals();
	check('an old store is repriced under the corrected table, not summed as guessed',
		near(tot.session.usd, 2 * fair) && !near(tot.session.usd, 0.75),
		'session=' + tot.session.usd + ' fair=' + fair);
	check('and reports nothing as reported', near(tot.session.reportedUsd, 0));
	const stored = JSON.parse(store._map.get('daimond-ledger'));
	check('the original guess survives in u0 with the rp mark',
		near(stored[0].u0, 0.5) && stored[0].rp === 1 && near(stored[1].u0, 0.25),
		JSON.stringify(stored[0]));
	check('perModel still works on old entries', L.perModel('month')[0].model === 'glm-5.2');
	check('perProvider groups old entries under the empty id',
		L.perProvider(0)[0].provider === '');
	check('samples still project old entries', L.samples().length === 2);
}

// ── 8b. A reported entry is never repriced ─────────────────────────
{
	store._map.set('daimond-ledger', JSON.stringify([
		{ t: Date.now() - 1000, m: 'glm-5.2', p: 100, c: 10, ca: 0, u: 0.0021, r: 1 },
	]));
	// A fresh module life, so the once-per-life guard does not skip the read.
	const win2 = { };
	loadModule('js/pricing.js', { window: win2 });
	loadModule('js/ledger.js',  { window: win2, localStorage: store });
	const t2 = win2.DaimondLedger.totals();
	check('a reported figure is money that moved — repricing never touches it',
		near(t2.session.usd, 0.0021) && !JSON.parse(store._map.get('daimond-ledger'))[0].rp);
}

// ── 8c. A session that stopped is not "this session" ───────────────
{
	const win3 = { };
	loadModule('js/pricing.js', { window: win3 });
	loadModule('js/ledger.js',  { window: win3, localStorage: store });
	const L3 = win3.DaimondLedger;
	// A tail that ended 16 minutes ago: last night's work, not this session.
	store._map.set('daimond-ledger', JSON.stringify([
		{ t: Date.now() - 20 * 60 * 1000, m: 'glm-5.2', p: 100, c: 10, ca: 0, u: 0.001, r: 1 },
		{ t: Date.now() - 16 * 60 * 1000, m: 'glm-5.2', p: 100, c: 10, ca: 0, u: 0.001, r: 1 },
	]));
	const idle = L3.totals();
	check('a tail older than the session gap reads as NO current session',
		near(idle.session.usd, 0) && idle.session.tokens === 0,
		'session=' + idle.session.usd);
	check('the week still counts what the session no longer does',
		near(idle.week.usd, 0.002));
	// A tail that ended five minutes ago is still this session.
	store._map.set('daimond-ledger', JSON.stringify([
		{ t: Date.now() - 5 * 60 * 1000, m: 'glm-5.2', p: 100, c: 10, ca: 0, u: 0.001, r: 1 },
	]));
	const live = L3.totals();
	check('a five-minute-old tail is still this session', near(live.session.usd, 0.001));
}

// ── 8d. What the reprice changed is readable, per period ───────────
{
	// The correction only earns trust if it can be shown. `repriced` answers
	// what the touched entries cost now and what they were first guessed at,
	// within the window the panel is showing, so the view can quote the figure
	// the user remembers instead of dropping the total in silence.
	const win4 = { };
	loadModule('js/pricing.js', { window: win4 });
	loadModule('js/ledger.js',  { window: win4, localStorage: store });
	const L4 = win4.DaimondLedger;
	const DAY = 86400000, now = Date.now();
	store._map.set('daimond-ledger', JSON.stringify([
		// Two already-repriced guesses inside the week.
		{ t: now - 2 * DAY,  m: 'glm-5.2', p: 100, c: 10, ca: 0, u: 0.05, u0: 0.30, rp: 1 },
		{ t: now - 3 * DAY,  m: 'glm-5.2', p: 100, c: 10, ca: 0, u: 0.03, u0: 0.18, rp: 1 },
		// A third, older than the week but inside the month.
		{ t: now - 20 * DAY, m: 'glm-5.2', p: 100, c: 10, ca: 0, u: 0.01, u0: 0.06, rp: 1 },
		// A billed turn the reprice never touched.
		{ t: now - 1 * DAY,  m: 'glm-5.2', p: 100, c: 10, ca: 0, u: 0.02, r: 1 },
	]));
	check('the ledger can say what the reprice changed', typeof L4.repriced === 'function');
	const m = (typeof L4.repriced === 'function') ? L4.repriced('month') : { turns: 0, usd: 0, was: 0 };
	const w = (typeof L4.repriced === 'function') ? L4.repriced('week')  : { turns: 0, usd: 0, was: 0 };
	check('repriced() gives the corrected and the original total for the period',
		m.turns === 3 && near(m.usd, 0.09) && near(m.was, 0.54), JSON.stringify(m));
	check('repriced() honours the period window',
		w.turns === 2 && near(w.usd, 0.08) && near(w.was, 0.48), JSON.stringify(w));
	check('a billed turn is money that moved, so it is not part of the correction',
		m.turns === 3 && !near(m.usd, 0.11), JSON.stringify(m));
	// A window holding nothing repriced answers with zeros, so the note the
	// panel draws from this ages out on its own as the 90-day log retires them.
	store._map.set('daimond-ledger', JSON.stringify([
		{ t: now - 1 * DAY, m: 'glm-5.2', p: 100, c: 10, ca: 0, u: 0.02, r: 1 },
	]));
	const none = (typeof L4.repriced === 'function') ? L4.repriced('month') : null;
	check('a period with no repriced turn reports nothing to explain',
		!!none && none.turns === 0 && near(none.usd, 0) && near(none.was, 0), JSON.stringify(none));
}

// ── 9. The gateway's balance notice ────────────────────────────────
{
	// gateway.js needs rather more of a browser than the other two, so it is
	// given only what `noteBalance` touches. Everything else in the file is
	// declaration-only until called.
	const events = [];
	const gwin = {
		dispatchEvent: (ev) => { events.push(ev); return true; },
		location: { href: 'https://example.test/', origin: 'https://example.test' },
		addEventListener: () => {},
		localStorage: store,
		navigator: { language: 'en-AU', languages: ['en-AU'] },
		setTimeout: setTimeout,
	};
	class FakeCustomEvent {
		constructor(type, init) { this.type = type; this.detail = (init || {}).detail; }
	}
	const src = readFileSync(new URL('../www/js/gateway.js', import.meta.url), 'utf8');
	// eslint-disable-next-line no-new-func
	new Function('window', 'localStorage', 'navigator', 'document', 'CustomEvent', 'Intl', src)(
		gwin, store, gwin.navigator, { addEventListener: () => {} }, FakeCustomEvent, Intl);
	const G = gwin.DaimondGateway;
	check('gateway.js exposes noteBalance', typeof G.noteBalance === 'function');

	G.noteBalance({ ok: true, credits_minor: 1234, currency: 'aud' });
	check('a numeric balance is taken', G.state().credits === 1234);
	check('and the currency with it', G.state().currency === 'aud');
	check('and the event fires', events.length === 1 && events[0].type === 'daimond:credits'
		&& events[0].detail.credits === 1234);

	G.noteBalance({ ok: true });
	check('an absent balance changes nothing', G.state().credits === 1234 && events.length === 1);
	G.noteBalance({ ok: true, credits_minor: null });
	check('a null balance changes nothing', G.state().credits === 1234 && events.length === 1);
	G.noteBalance({ ok: true, credits_minor: '900' });
	check('a string balance changes nothing', G.state().credits === 1234 && events.length === 1);
	G.noteBalance(null);
	G.noteBalance(undefined);
	G.noteBalance('nope');
	check('a non-object is ignored', G.state().credits === 1234 && events.length === 1);
	G.noteBalance({ credits_minor: 0 });
	check('a real zero IS taken — spent out is not unknown',
		G.state().credits === 0 && events.length === 2);
}

// ── Result ─────────────────────────────────────────────────────────
console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) {
	console.log('FAILED: ' + bad.join(', '));
	process.exit(1);
}
console.log('pricing, ledger and balance-notice core verified');
