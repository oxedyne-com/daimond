/* ============================================================
   Daimond — per-model pricing table (DaimondPricing)
   ------------------------------------------------------------
   A static, offline lookup of per-token prices for the open
   models Daimond's curated providers serve. No network fetch: the
   figures are baked in and refreshed by hand, so a turn can be
   costed the instant its token counts land.

   All rates are USD per 1,000,000 tokens. Where a provider
   publishes a cached-input rate (a discount for prompt reuse)
   it is recorded too; otherwise cached tokens fall back to the
   ordinary input rate.

   Pricing source: provider pricing pages (Fireworks serverless
   pricing docs, Groq, Together AI, DeepInfra, OpenRouter),
   surveyed 2026-07-11. Prices move often — re-verify before
   relying on the absolute figures. Where no published figure
   could be found for a model it is omitted rather than guessed.

   Attaches a single global, `window.DaimondPricing`.
   ============================================================ */
(function () {
	'use strict';

	// ── Fallback for unknown models ────────────────────────────
	// When a model is not in the table we still want a plausible,
	// non-zero cost so the ledger never silently reads $0. The
	// fallback sits at the pricier end of the open-model spread so
	// an estimate errs towards over-stating rather than under-
	// stating spend. Cached tokens reuse the input rate.
	var FALLBACK = { inUsdPerM: 1.00, outUsdPerM: 3.00, cachedInUsdPerM: 1.00 };

	// ── Price table ────────────────────────────────────────────
	// Keyed by a canonical model id. Each entry carries:
	//   in     — input (prompt) USD per 1M tokens.
	//   out    — output (completion) USD per 1M tokens.
	//   cached — cached-input USD per 1M tokens, when published.
	//   ctx    — context window in tokens, or null if unknown.
	//   alias  — extra ids/spellings that map to this entry.
	// Grouped by the provider whose published price it reflects;
	// the same open weights are often served by several providers
	// at similar rates, so a match here is a fair estimate even
	// when the user runs the model elsewhere.
	var TABLE = {

		// ── Fireworks AI ───────────────────────────────────────
		// From docs.fireworks.ai/serverless/pricing (standard
		// tier), 2026-07-11.
		'glm-5.2': {
			in: 1.40, out: 4.40, cached: 0.14, ctx: 1048576,
			alias: ['accounts/fireworks/models/glm-5p2', 'glm-5p2', 'glm5.2'],
		},
		'glm-5.1': {
			in: 1.40, out: 4.40, cached: 0.26, ctx: 200000,
			alias: ['accounts/fireworks/models/glm-5p1', 'glm-5p1', 'glm5.1'],
		},
		'gpt-oss-120b': {
			in: 0.15, out: 0.60, cached: 0.015, ctx: 131072,
			alias: ['accounts/fireworks/models/gpt-oss-120b', 'openai/gpt-oss-120b'],
		},
		'deepseek-v4-pro': {
			in: 1.74, out: 3.48, cached: 0.145, ctx: 1048576,
			alias: ['accounts/fireworks/models/deepseek-v4-pro', 'deepseek-ai/deepseek-v4-pro'],
		},
		'kimi-k2.6': {
			in: 0.95, out: 4.00, cached: 0.16, ctx: 262144,
			alias: ['accounts/fireworks/models/kimi-k2p6', 'kimi-k2p6', 'moonshotai/kimi-k2.6', 'kimi-k2-6'],
		},
		'qwen3.7-plus': {
			in: 0.40, out: 1.60, cached: 0.08, ctx: 262144,
			alias: ['accounts/fireworks/models/qwen3p7-plus', 'qwen3p7-plus', 'qwen/qwen3.7-plus'],
		},

		// ── Groq ───────────────────────────────────────────────
		// From groq.com/pricing, 2026-07-11. Groq bills a cached-
		// input rate on some models.
		'llama-3.3-70b': {
			in: 0.59, out: 0.79, cached: null, ctx: 131072,
			alias: ['llama-3.3-70b-versatile', 'meta-llama/llama-3.3-70b-instruct', 'llama3.3-70b'],
		},
		'kimi-k2': {
			in: 1.00, out: 3.00, cached: 0.50, ctx: 262144,
			alias: ['moonshotai/kimi-k2-instruct', 'moonshotai/kimi-k2', 'kimi-k2-instruct'],
		},

		// ── Together AI ────────────────────────────────────────
		// From together.ai/pricing, 2026-07-11.
		'deepseek-v3.1': {
			in: 0.60, out: 1.70, cached: null, ctx: 131072,
			alias: ['deepseek-ai/deepseek-v3.1', 'deepseek-v3', 'deepseek-ai/deepseek-v3', 'deepseek-v3p1'],
		},
		'deepseek-r1': {
			in: 3.00, out: 7.00, cached: null, ctx: 131072,
			alias: ['deepseek-ai/deepseek-r1', 'deepseek-reasoner'],
		},

		// ── DeepInfra ──────────────────────────────────────────
		// From deepinfra.com/pricing, 2026-07-11.
		'deepseek-v3.2': {
			in: 0.26, out: 0.38, cached: null, ctx: 131072,
			alias: ['deepseek-ai/deepseek-v3.2', 'deepseek-v3p2'],
		},
		'llama-4-scout': {
			in: 0.08, out: 0.30, cached: null, ctx: null,
			alias: ['meta-llama/llama-4-scout', 'meta-llama/llama-4-scout-17b-16e-instruct'],
		},

		// ── OpenRouter ─────────────────────────────────────────
		// From openrouter.ai/pricing, 2026-07-11. OpenRouter is a
		// router, so a given id may bill at the underlying
		// provider's rate; these are representative figures.
		'llama-4-maverick': {
			in: 0.15, out: 0.60, cached: null, ctx: 1048576,
			alias: ['meta-llama/llama-4-maverick', 'meta-llama/llama-4-maverick-17b-128e-instruct'],
		},
		'qwen3-235b': {
			in: 0.09, out: 0.10, cached: null, ctx: 262144,
			alias: ['qwen/qwen3-235b-a22b', 'qwen3-235b-a22b', 'qwen/qwen3-235b'],
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
	// each canonical id and all its aliases.
	var INDEX = {};
	(function () {
		for (var id in TABLE) {
			INDEX[norm(id)] = id;
			var aliases = TABLE[id].alias || [];
			for (var i = 0; i < aliases.length; i++) INDEX[norm(aliases[i])] = id;
		}
	})();

	// Resolve a caller's model string to a table entry, or null.
	// Matching is progressively looser: exact/alias key, then a
	// two-way substring test on the normalised keys (so a longer
	// vendor id containing a known model name still resolves).
	function resolve(model) {
		var key = norm(model);
		if (!key) return null;
		if (INDEX[key]) return TABLE[INDEX[key]];		// exact or alias
		// Substring either way: `glm52fast` ⊃ `glm52`, or a bare
		// `kimi` request ⊂ the fuller `kimik2` key.
		for (var k in INDEX) {
			if (key.indexOf(k) !== -1 || k.indexOf(key) !== -1) return TABLE[INDEX[k]];
		}
		return null;
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
	/// Returns `{ usd, estimated }`. `estimated` is true when the
	/// model was not found and the conservative fallback rate was
	/// applied.
	function priceFor(model, promptTokens, completionTokens, cachedTokens) {
		var entry = resolve(model);
		var estimated = !entry;
		var r = entry || FALLBACK_ENTRY();

		var prompt = Math.max(0, promptTokens || 0);
		var completion = Math.max(0, completionTokens || 0);
		var cached = Math.max(0, Math.min(cachedTokens || 0, prompt));	// a subset of the prompt
		var fresh = prompt - cached;									// prompt tokens billed at input rate

		var cachedRate = (r.cached != null) ? r.cached : r.in;
		var usd = (fresh * r.in + cached * cachedRate + completion * r.out) / 1e6;
		return { usd: usd, estimated: estimated };
	}

	// The fallback expressed in the same shape as a table entry.
	function FALLBACK_ENTRY() {
		return { in: FALLBACK.inUsdPerM, out: FALLBACK.outUsdPerM, cached: FALLBACK.cachedInUsdPerM, ctx: null };
	}

	/// Context window for `model` in tokens, or null when unknown
	/// (or when the model itself is unknown).
	function contextWindow(model) {
		var entry = resolve(model);
		return (entry && entry.ctx != null) ? entry.ctx : null;
	}

	/// Display rates for `model` as `{ inUsdPerM, outUsdPerM,
	/// cachedInUsdPerM }`, or null when the model is unknown. A
	/// null `cachedInUsdPerM` means the provider publishes no
	/// separate cached rate.
	function rate(model) {
		var entry = resolve(model);
		if (!entry) return null;
		return {
			inUsdPerM:       entry.in,
			outUsdPerM:      entry.out,
			cachedInUsdPerM: (entry.cached != null) ? entry.cached : null,
		};
	}

	window.DaimondPricing = {
		priceFor:      priceFor,
		contextWindow: contextWindow,
		rate:          rate,
		/// The fallback rate applied to unknown models, for display.
		fallback:      { inUsdPerM: FALLBACK.inUsdPerM, outUsdPerM: FALLBACK.outUsdPerM, cachedInUsdPerM: FALLBACK.cachedInUsdPerM },
	};
})();
