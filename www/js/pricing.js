/* ============================================================
   Daimond — per-model pricing table (DaimondPricing)
   ------------------------------------------------------------
   A static, offline lookup of per-token prices, used when
   nothing better is available. It is the LAST resort, not the
   first: a turn is costed from what the provider itself
   reported, failing that from the live rates `DaimondModels`
   captured when it listed the provider's models, and only
   failing both from the figures baked in here.

   All rates are USD per 1,000,000 tokens. Where a provider
   publishes a cached-input rate (prompt reuse, a small
   fraction of a fresh read) it is recorded too; otherwise
   cached tokens fall back to the ordinary input rate.

   Pricing source: openrouter.ai/api/v1/models, surveyed
   2026-07-30, converted from per-token to per-million. These
   are the ROUTED prices actually charged, which is the point:
   the table previously held direct-provider list prices 2.3x
   to 4.5x above them (glm-5.2 at 1.40/4.40 against a real
   0.62/1.93, deepseek-r1 at 3.00/7.00 against 0.70/2.50), and
   an "estimate" built from those overstated a session's spend
   roughly six-fold. Prices move; re-verify before relying on
   the absolute figures.

   Attaches a single global, `window.DaimondPricing`.
   ============================================================ */
(function () {
	'use strict';

	// ── Fallback for unknown models ────────────────────────────
	// When nothing knows a model we still want a plausible,
	// non-zero cost so the ledger never silently reads $0. It sits
	// near the middle of the open-model spread rather than at the
	// pricier end: the old 1.00/3.00 caught MOST current router ids
	// -- every anthropic/*, openai/gpt-5*, google/gemini-*, grok,
	// minimax and qwen3-coder id missed the table -- at about four
	// times reality, so the "conservative" figure was the single
	// biggest source of overstatement rather than a safety margin.
	var FALLBACK = { inUsdPerM: 0.40, outUsdPerM: 1.20, cachedInUsdPerM: 0.10 };

	// ── Price table ────────────────────────────────────────────
	// Keyed by a canonical model id. Each entry carries:
	//   in     — input (prompt) USD per 1M tokens.
	//   out    — output (completion) USD per 1M tokens.
	//   cached — cached-input USD per 1M tokens, when published.
	//   ctx    — context window in tokens, or null if unknown.
	//   alias  — extra ids/spellings that map to this entry.
	// Grouped by vendor family. A router may serve the same weights
	// from several hosts at slightly different rates, so a match
	// here is a fair estimate rather than a quote.
	var TABLE = {

		// ── Z.ai (GLM) ─────────────────────────────────────────
		'glm-5.2': {
			in: 0.6153, out: 1.9338, cached: 0.11427, ctx: 1048576,
			alias: ['z-ai/glm-5.2', 'accounts/fireworks/models/glm-5p2', 'glm-5p2', 'glm5.2'],
		},
		'glm-5.1': {
			in: 0.966, out: 3.036, cached: 0.1794, ctx: 204800,
			alias: ['z-ai/glm-5.1', 'accounts/fireworks/models/glm-5p1', 'glm-5p1', 'glm5.1'],
		},
		'glm-5': {
			in: 0.95, out: 2.55, cached: 0.20, ctx: 204800,
			alias: ['z-ai/glm-5'],
		},
		'glm-4.7': {
			in: 0.40, out: 1.75, cached: 0.08, ctx: 204800,
			alias: ['z-ai/glm-4.7'],
		},
		'glm-4.7-flash': {
			in: 0.06, out: 0.40, cached: 0.01, ctx: 202752,
			alias: ['z-ai/glm-4.7-flash'],
		},
		'glm-4.6': {
			in: 0.50, out: 2.00, cached: 0.10, ctx: 204800,
			alias: ['z-ai/glm-4.6'],
		},

		// ── OpenAI open weights ────────────────────────────────
		'gpt-oss-120b': {
			in: 0.037, out: 0.17, cached: null, ctx: 131072,
			alias: ['accounts/fireworks/models/gpt-oss-120b', 'openai/gpt-oss-120b'],
		},
		'gpt-oss-20b': {
			in: 0.03, out: 0.13, cached: 0.03, ctx: 131072,
			alias: ['openai/gpt-oss-20b'],
		},

		// ── DeepSeek ───────────────────────────────────────────
		'deepseek-v4-pro': {
			in: 0.435, out: 0.87, cached: 0.003625, ctx: 1048576,
			alias: ['deepseek/deepseek-v4-pro', 'accounts/fireworks/models/deepseek-v4-pro',
				'deepseek-ai/deepseek-v4-pro'],
		},
		'deepseek-v4-flash': {
			in: 0.14, out: 0.28, cached: 0.028, ctx: 1048576,
			alias: ['deepseek/deepseek-v4-flash'],
		},
		'deepseek-r1': {
			in: 0.70, out: 2.50, cached: null, ctx: 163840,
			alias: ['deepseek/deepseek-r1', 'deepseek-ai/deepseek-r1', 'deepseek-reasoner'],
		},
		// Three near-identical v3 ids at three different prices. Each
		// keeps its own entry: the substring resolver used to fold
		// v3.2-exp onto v3.1 and bill it at more than twice its rate.
		'deepseek-v3.1': {
			in: 0.25, out: 0.95, cached: 0.13, ctx: 163840,
			alias: ['deepseek/deepseek-chat-v3.1', 'deepseek-chat-v3.1',
				'deepseek-ai/deepseek-v3.1', 'deepseek-v3p1'],
		},
		'deepseek-v3.1-terminus': {
			in: 0.27, out: 1.00, cached: 0.135, ctx: 163840,
			alias: ['deepseek/deepseek-v3.1-terminus'],
		},
		'deepseek-v3.2': {
			in: 0.269, out: 0.40, cached: 0.1345, ctx: 163840,
			alias: ['deepseek/deepseek-v3.2', 'deepseek-ai/deepseek-v3.2', 'deepseek-v3p2'],
		},
		'deepseek-v3.2-exp': {
			in: 0.27, out: 0.41, cached: null, ctx: 163840,
			alias: ['deepseek/deepseek-v3.2-exp'],
		},

		// ── Moonshot (Kimi) ────────────────────────────────────
		'kimi-k2': {
			in: 0.57, out: 2.30, cached: null, ctx: 131072,
			alias: ['moonshotai/kimi-k2', 'moonshotai/kimi-k2-instruct', 'kimi-k2-instruct'],
		},
		'kimi-k2.5': {
			in: 0.57, out: 2.85, cached: 0.095, ctx: 262144,
			alias: ['moonshotai/kimi-k2.5'],
		},
		'kimi-k2.6': {
			in: 0.646, out: 2.72, cached: 0.1088, ctx: 262144,
			alias: ['moonshotai/kimi-k2.6', 'accounts/fireworks/models/kimi-k2p6', 'kimi-k2p6',
				'kimi-k2-6'],
		},
		'kimi-k2-thinking': {
			in: 0.60, out: 2.50, cached: 0.15, ctx: 262144,
			alias: ['moonshotai/kimi-k2-thinking'],
		},
		'kimi-k3': {
			in: 3.00, out: 15.00, cached: 0.30, ctx: 1048576,
			alias: ['moonshotai/kimi-k3'],
		},

		// ── Meta (Llama) ───────────────────────────────────────
		'llama-3.3-70b': {
			in: 0.13, out: 0.40, cached: null, ctx: 131072,
			alias: ['llama-3.3-70b-versatile', 'meta-llama/llama-3.3-70b-instruct', 'llama3.3-70b'],
		},
		'llama-4-scout': {
			in: 0.10, out: 0.30, cached: null, ctx: 1310720,
			alias: ['meta-llama/llama-4-scout', 'meta-llama/llama-4-scout-17b-16e-instruct'],
		},
		'llama-4-maverick': {
			in: 0.20, out: 0.80, cached: null, ctx: 1048576,
			alias: ['meta-llama/llama-4-maverick', 'meta-llama/llama-4-maverick-17b-128e-instruct'],
		},

		// ── Qwen ───────────────────────────────────────────────
		'qwen3-235b': {
			in: 0.455, out: 1.82, cached: null, ctx: 131072,
			alias: ['qwen/qwen3-235b-a22b', 'qwen3-235b-a22b', 'qwen/qwen3-235b'],
		},
		'qwen3-coder': {
			in: 0.30, out: 1.00, cached: 0.10, ctx: 262144,
			alias: ['qwen/qwen3-coder'],
		},
		'qwen3-max': {
			in: 0.78, out: 3.90, cached: 0.156, ctx: 262144,
			alias: ['qwen/qwen3-max'],
		},
		'qwen3.7-plus': {
			in: 0.32, out: 1.28, cached: 0.064, ctx: 1000000,
			alias: ['qwen/qwen3.7-plus', 'accounts/fireworks/models/qwen3p7-plus', 'qwen3p7-plus'],
		},

		// ── MiniMax ────────────────────────────────────────────
		'minimax-m2': {
			in: 0.255, out: 1.02, cached: null, ctx: 204800,
			alias: ['minimax/minimax-m2'],
		},
		'minimax-m2.5': {
			in: 0.15, out: 0.90, cached: 0.05, ctx: 204800,
			alias: ['minimax/minimax-m2.5'],
		},
		'minimax-m3': {
			in: 0.30, out: 1.20, cached: 0.06, ctx: 1048576,
			alias: ['minimax/minimax-m3'],
		},

		// ── xAI ────────────────────────────────────────────────
		'grok-4.5': {
			in: 2.00, out: 6.00, cached: 0.30, ctx: 500000,
			alias: ['x-ai/grok-4.5'],
		},
		'grok-4.3': {
			in: 1.25, out: 2.50, cached: 0.20, ctx: 1000000,
			alias: ['x-ai/grok-4.3'],
		},

		// ── Anthropic ──────────────────────────────────────────
		// Reached two ways: through a router, and — since the client
		// learned the Messages API — straight from the browser. The
		// second way is the one these figures have to be right for.
		// A router reports `cost` on every call and that verbatim
		// figure wins; Anthropic reports NO cost at all, so for a
		// direct call this table IS the number the user is shown.
		//
		// Source: the Anthropic pricing table, USD per million tokens,
		// read 2026-08-02. `cached` is the cache-READ rate, a tenth of
		// the input rate on every model here. The cache-WRITE premium
		// (1.25x input for the 5-minute TTL) is not modelled: there is
		// one cached rate per entry, and a write happens once per
		// prefix where a read happens every turn after it. See
		// `AnthUsage::into_usage` in src/llm.rs, which folds writes in
		// with the fresh prompt tokens for the same reason.
		'claude-fable-5': {
			in: 10.00, out: 50.00, cached: 1.00, ctx: 1000000,
			alias: ['anthropic/claude-fable-5'],
		},
		'claude-mythos-5': {
			in: 10.00, out: 50.00, cached: 1.00, ctx: 1000000,
			alias: ['anthropic/claude-mythos-5'],
		},
		'claude-opus-5': {
			in: 5.00, out: 25.00, cached: 0.50, ctx: 1000000,
			alias: ['anthropic/claude-opus-5'],
		},
		'claude-opus-4-8': {
			in: 5.00, out: 25.00, cached: 0.50, ctx: 1000000,
			alias: ['anthropic/claude-opus-4-8'],
		},
		'claude-opus-4-7': {
			in: 5.00, out: 25.00, cached: 0.50, ctx: 1000000,
			alias: ['anthropic/claude-opus-4-7'],
		},
		'claude-opus-4-6': {
			in: 5.00, out: 25.00, cached: 0.50, ctx: 1000000,
			alias: ['anthropic/claude-opus-4-6'],
		},
		// INTRODUCTORY pricing, in force through 2026-08-31. It
		// reverts to 3.00 / 15.00 / 0.30 on 2026-09-01 — update this
		// line then. The intro figure is used rather than the standard
		// one because it is what the user is charged today, and a
		// table that quotes list price against a discounted invoice is
		// the overstatement this file was rewritten to stop.
		'claude-sonnet-5': {
			in: 2.00, out: 10.00, cached: 0.20, ctx: 1000000,
			alias: ['anthropic/claude-sonnet-5'],
		},
		'claude-sonnet-4-6': {
			in: 3.00, out: 15.00, cached: 0.30, ctx: 1000000,
			alias: ['anthropic/claude-sonnet-4-6'],
		},
		'claude-haiku-4.5': {
			in: 1.00, out: 5.00, cached: 0.10, ctx: 200000,
			alias: ['anthropic/claude-haiku-4.5', 'claude-haiku-4-5'],
		},
		// Still served, and still one click away in the picker. Left out,
		// they fell to the unknown-model fallback — which prices an Opus
		// turn at a twelfth of what it costs, and an Opus 4.1 turn at a
		// fortieth. Understating a bill is not the safe direction either.
		'claude-opus-4-5': {
			in: 5.00, out: 25.00, cached: 0.50, ctx: 200000,
			alias: ['anthropic/claude-opus-4-5', 'claude-opus-4-5-20251101'],
		},
		'claude-sonnet-4-5': {
			in: 3.00, out: 15.00, cached: 0.30, ctx: 200000,
			alias: ['anthropic/claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'],
		},
		'claude-opus-4-1': {
			in: 15.00, out: 75.00, cached: 1.50, ctx: 200000,
			alias: ['anthropic/claude-opus-4-1', 'claude-opus-4-1-20250805'],
		},

		// ── Other closed models a router also serves ───────────
		// Not open weights, but one line away in the picker, and the
		// fallback priced them at a quarter of what a turn costs.
		'gpt-5.4': {
			in: 2.50, out: 15.00, cached: 0.25, ctx: 1050000,
			alias: ['openai/gpt-5.4'],
		},
		'gpt-5.4-mini': {
			in: 0.75, out: 4.50, cached: 0.075, ctx: 400000,
			alias: ['openai/gpt-5.4-mini'],
		},
		'gpt-5.2': {
			in: 1.75, out: 14.00, cached: 0.175, ctx: 400000,
			alias: ['openai/gpt-5.2'],
		},
		'gemini-3.1-pro': {
			in: 2.00, out: 12.00, cached: 0.20, ctx: 1048576,
			alias: ['google/gemini-3.1-pro-preview'],
		},
		'gemini-3.6-flash': {
			in: 1.50, out: 7.50, cached: 0.15, ctx: 1048576,
			alias: ['google/gemini-3.6-flash'],
		},
		'gemini-2.5-flash': {
			in: 0.30, out: 2.50, cached: 0.03, ctx: 1048576,
			alias: ['google/gemini-2.5-flash'],
		},
	};

	// ── Normalisation + index ──────────────────────────────────
	// Fold an id to a comparison key: take the last path segment,
	// rewrite a provider's `NpM` spelling to `N.M` (so `glm-5p2`
	// meets `glm-5.2`), then drop every non-alphanumeric. Thus
	// `accounts/fireworks/models/glm-5p2` and `GLM-5.2` both
	// become `glm52`.
	function norm(id) {
		var s = String(id == null ? '' : id).toLowerCase();
		var seg = s.split('/').pop();				// last path segment
		seg = seg.replace(/(\d)p(\d)/g, '$1.$2');	// 5p2 → 5.2
		return seg.replace(/[^a-z0-9]/g, '');		// glm-5.2 → glm52
	}

	// Build a normalised-key → canonical-id index once, covering
	// each canonical id and all its aliases. Keys are also held in
	// longest-first order, which is what `resolve` walks.
	var INDEX = {};
	var KEYS = [];
	(function () {
		for (var id in TABLE) {
			INDEX[norm(id)] = id;
			var aliases = TABLE[id].alias || [];
			for (var i = 0; i < aliases.length; i++) INDEX[norm(aliases[i])] = id;
		}
		KEYS = Object.keys(INDEX).sort(function (a, b) { return b.length - a.length; });
	})();

	// The entry the caller actually named: exact key or alias, and
	// nothing else. A hit here IS the model, so it is the only kind
	// of hit allowed to state a context window.
	function resolveExact(model) {
		var key = norm(model);
		if (!key) return null;
		return INDEX[key] ? TABLE[INDEX[key]] : null;
	}

	// Resolve a caller's model string to a table entry, or null.
	//
	// Exact key or alias first; then the LONGEST table key that the
	// caller's id CONTAINS. The direction matters. This used to test
	// both ways and return the first hit in object order, so
	// `deepseek/deepseek-v3.2-exp` met the earlier `deepseekv3` alias
	// and was billed at v3.1's rate -- more than twice its own. A
	// shorter key can never outrank a longer one now, and a key that
	// merely contains the caller's id (`glm52` offered for a bare
	// `glm5`) is not a match at all.
	//
	// That last guard used to be written here as though it settled
	// the glm-5 / glm-5.2 confusion. It settles ONE HALF of it. The
	// same pair collides the other way round and is not caught:
	// `glm-5.3` normalises to `glm53`, which contains `glm5`, so it
	// lands on the glm-5 entry -- a fifth of glm-5.2's window and a
	// price nobody published. The stated reason ("ids arrive whole")
	// is true and does not help, because a whole id can be a whole
	// DIFFERENT model whose name starts with a table key.
	//
	// Nor can containment be tightened to tell the two cases apart:
	// `norm` has already dropped the separator that carried the
	// difference, so `claudeopus5` + `20251001` (the same model,
	// dated, which should match) and `glm5` + `3` (a version bump,
	// which should not) are one shape by the time this sees them.
	// So the fallback is kept for RATES and marked `near` -- see
	// `entryFor` -- and supplies no context window at all. A wrong
	// price is visible in the spend readout; a wrong window silently
	// clips a conversation.
	function resolve(model) {
		var key = norm(model);
		if (!key) return null;
		if (INDEX[key]) return TABLE[INDEX[key]];		// exact or alias
		for (var i = 0; i < KEYS.length; i++) {
			if (key.indexOf(KEYS[i]) !== -1) return TABLE[INDEX[KEYS[i]]];
		}
		return null;
	}

	// The live rates a provider published when `DaimondModels` last
	// listed its models, in this table's shape. A router's own
	// figures beat anything baked in here, so they are asked first.
	// Absent module, absent provider or absent model: null, and the
	// table answers instead.
	function liveEntry(provider, model) {
		if (!provider || !window.DaimondModels
			|| typeof window.DaimondModels.rateFor !== 'function') return null;
		var r = null;
		try { r = window.DaimondModels.rateFor(provider, model); } catch (e) { return null; }
		if (!r || typeof r.inPerM !== 'number' || typeof r.outPerM !== 'number') return null;
		return {
			in:     r.inPerM,
			out:    r.outPerM,
			cached: (typeof r.cachedPerM === 'number') ? r.cachedPerM : null,
			ctx:    (typeof r.ctx === 'number') ? r.ctx : null,
		};
	}

	// The entry to price with, and how far it is from the model asked
	// about. `live` is a quote from the provider, `table` a surveyed
	// figure for this very model, `near` a surveyed figure for a
	// NEIGHBOUR the id merely contains, `fallback` no figure at all.
	// The last two are estimates: neither is a number anybody
	// published about this model.
	function entryFor(model, provider) {
		var live = liveEntry(provider, model);
		if (live) return { entry: live, source: 'live' };
		var exact = resolveExact(model);
		if (exact) return { entry: exact, source: 'table' };
		// `resolve` has already tried exact, so what is left here is a
		// containment hit and only that.
		var nearby = resolve(model);
		if (nearby) return { entry: nearby, source: 'near' };
		return { entry: FALLBACK_ENTRY(), source: 'fallback' };
	}

	// Is this a figure nobody published about the model asked about?
	function guessed(source) {
		return source === 'fallback' || source === 'near';
	}

	// ── Public API ─────────────────────────────────────────────

	/// Cost a turn for `model` given its token counts.
	///
	/// `cachedTokens` is the portion of `promptTokens` served from
	/// the provider's prompt cache; it is billed at the cached rate
	/// where one is published, and at the ordinary input rate
	/// otherwise. The remaining prompt tokens bill at the input
	/// rate and completion tokens at the output rate.
	///
	/// `provider` is optional and, when given, lets the live rates
	/// captured from that provider's own model list take precedence
	/// over the baked-in table.
	///
	/// Returns `{ usd, estimated, source }`. `estimated` is true
	/// whenever no rate was published for this model itself: the
	/// fallback was applied (`source: 'fallback'`), or the figure was
	/// borrowed from a table entry the id merely contains
	/// (`source: 'near'`).
	function priceFor(model, promptTokens, completionTokens, cachedTokens, provider) {
		var got = entryFor(model, provider);
		var r = got.entry;

		var prompt = Math.max(0, promptTokens || 0);
		var completion = Math.max(0, completionTokens || 0);
		var cached = Math.max(0, Math.min(cachedTokens || 0, prompt));	// a subset of the prompt
		var fresh = prompt - cached;									// prompt tokens billed at input rate

		var cachedRate = (r.cached != null) ? r.cached : r.in;
		var usd = (fresh * r.in + cached * cachedRate + completion * r.out) / 1e6;
		return { usd: usd, estimated: guessed(got.source), source: got.source };
	}

	// The fallback expressed in the same shape as a table entry.
	function FALLBACK_ENTRY() {
		return { in: FALLBACK.inUsdPerM, out: FALLBACK.outUsdPerM, cached: FALLBACK.cachedInUsdPerM, ctx: null };
	}

	/// Context window for `model` in tokens, or null when unknown
	/// (or when the model itself is unknown). A provider's own
	/// figure, where one was captured, beats the table's.
	///
	/// `resolveExact`, not `resolve`: a neighbour's window is not
	/// this model's window, and `glm-5.3` borrowing glm-5's 204,800
	/// clipped a conversation to a fifth of what it could have held,
	/// silently. A null is left alone by every caller -- the agent's
	/// own default assumption is a better guess than a number
	/// invented here, and the reactive fold still catches a refusal.
	function contextWindow(model, provider) {
		var live = liveEntry(provider, model);
		if (live && live.ctx != null) return live.ctx;
		var entry = resolveExact(model);
		return (entry && entry.ctx != null) ? entry.ctx : null;
	}

	/// Display rates for `model` as `{ inUsdPerM, outUsdPerM,
	/// cachedInUsdPerM, source }`, or null when nothing knows the
	/// model. A null `cachedInUsdPerM` means no separate cached rate
	/// is published. `source` is named exactly as `priceFor` names
	/// it, so a display and a charge cannot disagree about how well
	/// the figure is known.
	function rate(model, provider) {
		var live = liveEntry(provider, model);
		var entry = live || resolve(model);
		if (!entry) return null;
		return {
			inUsdPerM:       entry.in,
			outUsdPerM:      entry.out,
			cachedInUsdPerM: (entry.cached != null) ? entry.cached : null,
			source:          live ? 'live' : (resolveExact(model) ? 'table' : 'near'),
		};
	}

	window.DaimondPricing = {
		priceFor:      priceFor,
		contextWindow: contextWindow,
		rate:          rate,
		/// The fallback rate applied to unknown models, for display.
		fallback:      { inUsdPerM: FALLBACK.inUsdPerM, outUsdPerM: FALLBACK.outUsdPerM, cachedInUsdPerM: FALLBACK.cachedInUsdPerM },
		/// The table and both resolvers, for the pure-node hygiene check
		/// in `dev/verify_pricing.mjs`: every canonical id must resolve
		/// to itself, no id may resolve to an entry other than the
		/// owner of its longest matching key, and an id that only
		/// `resolve` can place must carry no window. Read-only by
		/// convention.
		_core: { TABLE: TABLE, INDEX: INDEX, KEYS: KEYS, norm: norm,
			resolve: resolve, resolveExact: resolveExact },
	};
})();
