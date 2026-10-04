// models.mjs — THE PANEL. One list of models, and every instrument in dev/ takes it.
//
// **A measurement on one model is a measurement of that model.**  The notes in
// `src/prompts.rs` are written for whatever the user has chosen, and on 2026-08-24 two
// of them turned out to bite on the weaker half of a panel and on nothing else -- which
// is a finding no single-model run could have produced, and which points at composing a
// note CONDITIONALLY rather than keeping or cutting it for everybody.
//
// So the panel is defined here, once, and `dev/reflux.mjs`, `dev/probe_notes.mjs` and
// `dev/prompt_cost.mjs` all read it.  A lane that wants a different set passes `--model`;
// a lane that wants the house set gets it for nothing.
//
// **The slugs are the provider's own and are not to be guessed.**  Every one below was
// checked against OpenRouter's live model list on 2026-08-24; a name invented from a
// press release answers 404 and the run reports it as a model that failed.
//
// The prices are the provider's on that date, in USD per million tokens, and they are
// here to be read BEFORE a sweep rather than after it.  They go stale: they are a guide
// to what to run last, never an accounting.

// ── What each was actually like to measure against, 2026-08-24 ──────
//
// `note` is not a description of the model.  It is what the last lane to point an instrument
// at it found out the hard way, so the next one does not spend an hour rediscovering it.

/// One model the instruments can be pointed at.
export const MODEL_PANEL = [
	// **DO NOT PLAN A SWEEP AROUND THIS ONE.**  It was put at the head of the panel so that a
	// broad sweep could be run for nothing and real money spent only where the free run showed
	// a difference.  That did not work: on 2026-08-24 it answered 429 to fifty consecutive
	// requests -- `upstream_provider_shared_pool`, from `Decart`, not from OpenRouter -- so the
	// whole free sweep came back `UNAVAIL` and the paid models carried it.  Try it by all
	// means; do not build a plan on it answering.
	{ slug: 'z-ai/glm-5.2:free',            in: 0.00, out: 0.00, open: true,
		note: 'free, and 429 from a shared upstream pool for 50 straight requests on 2026-08-24' },
	{ slug: 'deepseek/deepseek-v4-pro',     in: 0.53, out: 1.05, open: true,
		note: 'the one model that needs VERIFY_NOTE and does not need QUIET_NOTE; high variance turn to turn' },
	{ slug: 'anthropic/claude-haiku-4.5',   in: 1.00, out: 5.00, open: false, note: 'baseline; reaches verify without the note' },
	{ slug: 'z-ai/glm-5.2',                 in: 0.97, out: 3.04, open: true, note: '' },
	// A `TRUNC` column is a FACT ABOUT THE MODEL and not a missing result.  It ran past
	// `--max-tokens 1200-1600` on most long answers, so its fold and crystal columns are
	// truncations rather than verdicts.  Raise the cap before believing anything about it.
	{ slug: 'z-ai/glm-5.3',                 in: 1.40, out: 4.40, open: true,
		note: 'truncates long answers at 1200-1600 max_tokens; raise the cap or its columns are TRUNC' },
	{ slug: 'anthropic/claude-sonnet-4.5',  in: 3.00, out: 15.00, open: false, note: 'baseline; folds as rarely as haiku' },
	{ slug: 'qwen/qwen3.8-max',             in: 2.00, out: 6.00, open: false,
		note: 'PROPRIETARY, not open weight: the Max models are API-only and only the parameter-named Qwen releases are open. Dearest output — run last; the only model that folds when told to' },

	// ── The open-weight half, added 2026-08-25 ──────────────────
	//
	// **`open` says whether the weights are published**, and it is here because the owner asked
	// for open models specifically and the panel had fewer than it looked like it had.  A slug
	// is not evidence of a licence, so a new entry gets the flag set deliberately or not at all.
	//
	// **Every one of these was added under the BASELINE GATE and none is evidence about a prompt
	// until it has passed it.**  `dev/probe_register.mjs --gate` runs the bare arm first and
	// refuses the rest where the model cannot do the task with no standing prompt at all.  That
	// is what stops a tool-calling weakness being reported as a finding about a register, and on
	// the models already here it has caught two.
	{ slug: 'openai/gpt-oss-120b',          in: 0.04, out: 0.17, open: true,
		note: 'fifty times cheaper in than qwen3.8-max; trained for tool use with a reasoning-effort dial' },
	// **THE FREE TIER THAT ANSWERS**, and the one to plan a cost discipline around, which is
	// what `z-ai/glm-5.2:free` above could not be.  Measured 2026-08-25: eight consecutive
	// requests, eight HTTP 200s from `GMICloud`; it then passed `dev/probe_register.mjs --gate`
	// three bare samples out of three and drove the whole tool loop -- twenty-four calls in
	// twelve rounds, running the owner's own checkers and landing inside his sentence band.
	//
	// **It has two costs and neither is money, so a sweep planned on the price alone is
	// planned wrong twice.**
	//
	// - **About three minutes a run**, against fifty seconds on `anthropic/claude-haiku-4.5`.
	//   Free makes it a WALL-CLOCK decision rather than a budget one, so a broad sweep wants
	//   its own unit and hours rather than a slot in a serial run.
	// - **It runs past a 1,600-token cap on a long answer**, like `moonshotai/kimi-k2.7-code`
	//   below: on the fold questions of 2026-08-25 it truncated 3 of 5 replies on one arm.  A
	//   truncation is a fact about the cap and not a verdict, so raise `--max-tokens` before
	//   believing any column of long-form answers from it.
	// - **It is a reasoning model whose reply can carry `reasoning` with a NULL `content`.**  A
	//   caller that reads `content` alone sees an empty turn and scores it as a failure: with
	//   `max_tokens` at 8 it returned `finish_reason: length` and the whole answer in
	//   `reasoning`.  Read both, and pass `reasoning` back between rounds -- see
	//   `dev/HATES.md`, where dropping it is written up as the defect that spoils a
	//   measurement silently.
	{ slug: 'minimax/minimax-m2.7:free',    in: 0.00, out: 0.00, open: true,
		note: 'FREE AND IT ANSWERS: 8/8 on 2026-08-25, through the gate, drove the whole loop. ~3 min a run, and its reply can carry reasoning with a null content' },
	{ slug: 'minimax/minimax-m2.7',         in: 0.30, out: 1.20, open: true,
		note: 'cheap agentic coding; the paid twin of the free entry above' },
	{ slug: 'mistralai/devstral-2512',      in: 0.44, out: 2.20, open: true,
		note: 'built to run inside a harness and edit a repository' },
	// **PASSED THE BASELINE GATE, and with the best bare arm on the panel**: measured
	// 2026-08-25 it moved the owner's paragraph in 2 bare samples of 3, twice at decode-load 1
	// and once dead inside his band, where sonnet-4.5's bare arm sits at decode-load 2.  Its
	// price per COMPLETED task is $0.1969 -- level with haiku-4.5 rather than the tenth its
	// per-token price suggests, because a register takes it from 2 calls to 21.
	//
	// **It runs past a 1,600-token cap on a long answer**, like `z-ai/glm-5.3` above: on the
	// fold questions of 2026-08-25 it truncated 4 of 5 replies on one arm and 3 of 8 on
	// another, and a truncation is a fact about the cap rather than a verdict.  Raise
	// `--max-tokens` before believing any column of long-form answers from it.
	{ slug: 'moonshotai/kimi-k2.7-code',    in: 0.67, out: 3.40, open: true,
		note: 'best bare arm on the panel; $0.1969 a completed task; truncates long answers at 1600 max_tokens' },
];

/// The models whose weights are published, cheapest output first.
export const OPEN = MODEL_PANEL.filter((m) => m.open).map((m) => m.slug);

/// Every slug in the panel, cheapest output first, which is the order to sweep in.
export const PANEL = MODEL_PANEL.map((m) => m.slug);

/// The two the standing findings of 2026-08-24 were made on.  Kept named so a later run
/// can be compared with them rather than with nothing.
export const BASELINE = ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-4.5'];

/// The free one -- which on the day this was written could not be used at all; see its entry.
export const FREE = 'z-ai/glm-5.2:free';

/// What a run of `n` tokens in and `m` out costs on one model, in USD.
///
/// A guide to what to run last and never an accounting: the table above is dated.
export function priceOf(slug, promptTokens, outTokens) {
	const m = MODEL_PANEL.find((x) => x.slug === slug);
	if (!m) return null;
	return (promptTokens * m.in + outTokens * m.out) / 1e6;
}
