// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
import { Sbj, qr_matrix } from './wasm.js';
import { TAG_MODE_KEY, TAG_POOL_KEY, pg } from './state.js';
// page-split: end imports
export let esc; // page-split: hoisted
let sbjMissing; // page-split: hoisted
// page-split: install 9
// SEAL-BRIDGE-END

// The same arrangement for the identity format. `identity.js` is a classic
// script and cannot import the module, and there must be exactly ONE
// rendering of a fingerprint and ONE canonical encoding of a card -- a second
// written in JS is how two devices come to draw the same key differently. So
// nothing here computes: each line hands the question to the crate that owns
// it. Nothing throws on this side either; `identity.js` treats a missing
// bridge as "not answerable yet" and shows nothing rather than a second
// answer, which is only honest if this surface never invents one.
//
// Only safe to call after init(), which every caller is: the fingerprint is
// recomputed at unlock and a card is minted from an unlocked identity.
//
// Defined only when the module really carries them. A wrapper that existed
// and threw would pass `identity.js`'s `typeof b.cardEncode === 'function'`
// check and be reported as an encoding failure, which is a different fault
// from the one that happened; absent, it is reported as the missing bridge it
// is.
// EVERY name is checked, not the first: a partial rename would otherwise
// leave a bridge that exists and throws halfway through minting a card.
//
// `PostDraft` is a CLASS rather than a free function, and it is here for the
// same reason as the rest: `typeof` a wasm-bindgen class is 'function', so it
// is checked the same way, and without it `DaimondPost.ready()` is false and
// nothing can be composed at all -- silently, since a missing bridge is by
// design something that cannot stop the app.
// `typeof` a wasm-bindgen class is 'function', so `PostDraft` and `ShareDraft`
// are checked by exactly the same test as the free functions beside them.
var sbjWant = ['identity_fingerprint', 'identity_safety_number', 'card_encode',
	'sbj_signing_input', 'sbj_assemble', 'sbj_address', 'sbj_read', 'PostDraft',
	'ShareDraft', 'share_read'];
// page-split: install 10

// ── Settings (BYOK, localStorage) ──────────────────────────
export var CFG_KEY = 'daimond-byok';

// The cached model list of the ONE provider the app used to hold is gone: `DaimondModels`
// caches a list per provider now, and is the only thing that answers "what can Daimond run".
// The `daimond-models` key it was kept under is still WRITTEN below, because the migration in
// models.js reads it to carry an existing install's models across.

// Curated OpenAI-compatible providers. All five were verified to allow
// direct browser (CORS) calls in Slice 0, so BYOK works with no relay.
// `url` is the chat-completions endpoint; the models endpoint is derived
// from it. `model` is a sensible default where a stable id is known.
export var PROVIDERS = {
	fireworks:  { name: 'Fireworks AI', url: 'https://api.fireworks.ai/inference/v1/chat/completions', model: 'accounts/fireworks/models/glm-5p2' },
	openrouter: { name: 'OpenRouter',   url: 'https://openrouter.ai/api/v1/chat/completions',          model: '' },
	together:   { name: 'Together AI',  url: 'https://api.together.xyz/v1/chat/completions',            model: '' },
	groq:       { name: 'Groq',         url: 'https://api.groq.com/openai/v1/chat/completions',         model: '' },
	deepinfra:  { name: 'DeepInfra',    url: 'https://api.deepinfra.com/v1/openai/chat/completions',    model: '' },
	// Not OpenAI-compatible: its own endpoint, its own auth header, its own
	// listing path. models.js knows all three; nothing here does but the URL.
	anthropic:  { name: 'Anthropic',    url: 'https://api.anthropic.com/v1/messages',                  model: 'claude-opus-5' },
};

// Identify which curated provider a stored base URL belongs to, or
// 'custom' for anything hand-entered.
export function providerForUrl(url) {
	for (var id in PROVIDERS) { if (PROVIDERS[id].url === url) return id; }
	return url ? 'custom' : '';
}

// Derive the `/models` listing endpoint from a turn endpoint.
//
// Delegated to models.js, which knows the providers that do not follow the OpenAI
// shape: Anthropic's listing is a SIBLING of its turn endpoint, so the rule below
// asked `/v1/messages/models` — nobody's endpoint, and a 404 with no explanation.
// The local rule stays as the fallback, for a page where models.js has not loaded.
export function modelsUrl(base) {
	if (window.DaimondModels && DaimondModels.modelsUrl) return DaimondModels.modelsUrl(base);
	if (base.indexOf('/chat/completions') !== -1) return base.replace('/chat/completions', '/models');
	return base.replace(/\/+$/, '') + '/models';
}

/// The headers a model listing needs for `base`.
///
/// Delegated for the same reason as `modelsUrl`: Anthropic refuses a bearer token
/// and wants `x-api-key`, a pinned version, and the header that makes its edge
/// answer a browser at all. A hardcoded bearer got a 401 and looked like a bad key.
export function authHeadersFor(base, key) {
	if (window.DaimondModels && DaimondModels.authHeaders) return DaimondModels.authHeaders(base, key);
	return { 'Authorization': 'Bearer ' + key };
}

export function loadCfg() {
	var raw = localStorage.getItem(CFG_KEY);
	// `maxOut` of 0 means AUTO: let `maxOutFor` pick per model. See the
	// "How long a reply may be" section below for why one number for every
	// model was the wrong shape.
	//
	// `pushToken` is deliberately NOT in the stored shape and never read back: the
	// wrapped `pushTokenEnc` is the only form that reaches storage. See `saveCfg`.
	var cfg = { baseUrl: '', apiKey: '', apiKeyEnc: '', model: '', maxOut: 0, maxRounds: 0,
		crystalKb: 0, crystalPageKb: 0, crystalHotKb: 0, versionsKb: 0, tools: true,
		// Files a turn may delete from the open folder before the person is asked; -1 is
		// the engine's own default of eight. Zero is a real answer (ask before every one),
		// so the unset value is not zero.
		deleteAskAfter: -1,
		foldModel: '', foldProvider: '', foldAt: 0, contextCap: 0, spendCap: 0,
		// The compaction and worker-preset knobs, as one flat JSON object -- see
		// `Agent::set_tune`. Empty is how "nobody has tuned anything" travels, and it is
		// what every install holds: the figures it can move were compile-time constants
		// until 2026-09-12, so the default behaviour is the default string.
		tune: '',
		// Whether a chat tile shows the first thing you said in it.
		//
		// ON, and it is the one default here worth arguing. Chats have no
		// names now, so without it a rail of four conversations from this
		// afternoon reads "2 hr ago / 3 hr ago / 4 hr ago" and there is no
		// way to tell them apart at all — a regression somebody meets on
		// their first day with no remedy they would know to look for.
		//
		// Against that: the rail is on screen for the whole session, next to
		// whatever else is being shown, so it puts a line of your own writing
		// in every screenshot and every shared screen — which `Chat-0025`
		// never did. That is a real cost and it is why this is a setting at
		// all rather than a decision. It is one switch away, it is stated in
		// plain words where the switch is, and the lock already blanks the
		// rail outright.
		chatPreview: true,
		pushHost: '', pushUser: '', pushToken: '', pushTokenEnc: '' };
	if (raw) {
		try {
			var j = JSON.parse(raw);
			if (typeof j.baseUrl === 'string') cfg.baseUrl = j.baseUrl;
			if (typeof j.apiKey === 'string') cfg.apiKey = j.apiKey;
			if (typeof j.apiKeyEnc === 'string') cfg.apiKeyEnc = j.apiKeyEnc;
			if (typeof j.model === 'string') cfg.model = j.model;
			// `maxTokens` -- the old field -- is deliberately NOT read. It was never
			// user-facing: it held 4096 on every install because that was the
			// hardcoded internal default, so reading it as a setting would pin
			// every existing user to the very cap this change exists to lift.
			// Nobody ever chose it, so nothing is lost by dropping it. The new
			// field is `maxOut`, and 4096 in it IS a choice.
			if (typeof j.maxOut === 'number') cfg.maxOut = j.maxOut;
			// Zero means the engine's own default, which is also what an absent field means.
			if (typeof j.maxRounds === 'number') cfg.maxRounds = j.maxRounds;
			// Kilobytes; zero is the engine's default ceiling, as an absent field is.
			// A crystal is now two files and each has its own ceiling: the data the
			// daimon reads, and the page that draws it.
			if (typeof j.crystalKb === 'number') cfg.crystalKb = j.crystalKb;
			if (typeof j.versionsKb === 'number') cfg.versionsKb = j.versionsKb;
			if (typeof j.deleteAskAfter === 'number') cfg.deleteAskAfter = j.deleteAskAfter;
			if (typeof j.crystalPageKb === 'number') cfg.crystalPageKb = j.crystalPageKb;
			if (typeof j.crystalHotKb === 'number') cfg.crystalHotKb = j.crystalHotKb;
			if (typeof j.tools === 'boolean') cfg.tools = j.tools;
		if (typeof j.chatPreview === 'boolean') cfg.chatPreview = j.chatPreview;
			// What folds a conversation when it outgrows its window. Empty -- and an
			// absent field -- means the conversation's own model, which is what the
			// engine has always silently done. The provider travels with it for the
			// same reason it does everywhere else: a bare model id no longer says
			// which key to send it with.
			if (typeof j.foldModel === 'string') cfg.foldModel = j.foldModel;
			if (typeof j.foldProvider === 'string') cfg.foldProvider = j.foldProvider;
			// Zero means nobody has chosen and the engine's own figure stands, which is
			// what `set_fold_at` already does with a zero -- so it is passed through
			// rather than special-cased here.
			if (typeof j.foldAt === 'number') cfg.foldAt = j.foldAt;
			// The ceiling `foldAt`'s fraction is held under, in TOKENS. Zero is the engine's
			// own figure, as an absent field is -- the same rule `foldAt` travels by.
			if (typeof j.contextCap === 'number') cfg.contextCap = j.contextCap;
			// The most one TURN may spend, in US DOLLARS. Zero is the engine's own figure, by
			// the rule `foldAt` and `contextCap` travel by.
			if (typeof j.spendCap === 'number') cfg.spendCap = j.spendCap;
			// A STRING AND NOT AN OBJECT, deliberately: the engine parses it, so the page
			// never has to know which keys exist and a knob added in Rust needs no change
			// here. Empty, and an absent field, both mean the shipped figures.
			if (typeof j.tune === 'string') cfg.tune = j.tune;
			// The push credential. The host and the user name it travels as are not
			// secrets and are read as written; the token is only ever read WRAPPED,
			// and a plaintext `pushToken` sitting in the stored blob -- which nothing
			// here writes -- is ignored rather than picked up, so a hand-edited or
			// migrated store cannot promote one into use.
			if (typeof j.pushHost === 'string') cfg.pushHost = j.pushHost;
			if (typeof j.pushUser === 'string') cfg.pushUser = j.pushUser;
			if (typeof j.pushTokenEnc === 'string') cfg.pushTokenEnc = j.pushTokenEnc;
		} catch (e) { /* keep defaults */ }
	}
	return cfg;
}

// TRAINING WHEELS — the debug feed's `settings`. One event per CHANGED key,
// old -> new, found by diffing what is about to be written against what is
// stored. A secret-named key NEVER carries its value, not even a fingerprint:
// it reports the LENGTHS either side, which is enough to see that a key was
// replaced and nothing at all about what it is. Guarded on `isOn` so an
// ordinary save pays a property test rather than a parse. Lifts out in one
// grep of `DEBUG_SHARE`.
function dsScalar(v) {
	if (v === undefined || v === null) return '';
	if (typeof v === 'boolean' || typeof v === 'number') return v;
	return String(v).slice(0, 80);
}
function dsSettingsDiff(next) {
	try {
		if (!(window.DEBUG_SHARE && DEBUG_SHARE.isOn && DEBUG_SHARE.isOn())) return;
		var prev = {};
		try { prev = JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; } catch (e) { prev = {}; }
		Object.keys(next).forEach(function (k) {
			if (prev[k] === next[k]) return;
			// `set`, not `key`: the module's redactor matches a field NAMED `key`
			// and would fingerprint the setting's own name.
			if (/key|token|secret|pass|salt/i.test(k)) {
				dsEvent('settings', { set: k, wasLen: String(prev[k] == null ? '' : prev[k]).length,
					nowLen: String(next[k] == null ? '' : next[k]).length });
			} else {
				dsEvent('settings', { set: k, was: dsScalar(prev[k]), now: dsScalar(next[k]) });
			}
		});
	} catch (e) { /* the feed must never break a save */ }
}

// Persist the config. When a passphrase identity is in use the API key is
// stored *encrypted* (`apiKeyEnc`) and never in the clear; otherwise it is
// stored plaintext (the skippable, browser-only path).
//
// The PUSH token has no such fallback and there is only one line here that
// writes it: `pushTokenEnc`. A provider key is somebody else's bearer token
// against somebody else's billing and its worst case is a bill; a push token
// writes to the user's own repositories, and the plaintext path exists so that
// a browser-only user can get started at all -- not so that a repository-write
// credential can be left in `localStorage` for any script that ever reaches
// this origin. With no identity to wrap it under, nothing is stored: the
// credential is handed to the engine for this tab and asked for again after a
// reload, and the panel says so rather than quietly forgetting it.
export function saveCfg(c) {
	try {
	var stored = {
		baseUrl:   c.baseUrl || '',
		apiKey:    c.apiKeyEnc ? '' : (c.apiKey || ''),
		apiKeyEnc: c.apiKeyEnc || '',
		model:     c.model || '',
		maxOut:    c.maxOut || 0,
	maxRounds: c.maxRounds || 0,
		crystalKb:     c.crystalKb || 0,
		versionsKb:    c.versionsKb || 0,
		deleteAskAfter: typeof c.deleteAskAfter === 'number' ? c.deleteAskAfter : -1,
		crystalPageKb: c.crystalPageKb || 0,
		crystalHotKb:  c.crystalHotKb || 0,
		tools:     c.tools !== false,
		chatPreview: c.chatPreview !== false,
		foldModel:    c.foldModel || '',
		foldProvider: c.foldProvider || '',
		foldAt:       c.foldAt || 0,
		contextCap:   c.contextCap || 0,
		spendCap:     c.spendCap || 0,
		tune:         c.tune || '',
		// Written on every save, not only by the push panel: this function
		// rebuilds the stored object from scratch, so a field it does not know
		// about is a field the next unrelated save DELETES.
		pushHost:     c.pushHost || '',
		pushUser:     c.pushUser || '',
		pushTokenEnc: c.pushTokenEnc || '',
	};
	// BEFORE the write, so the diff has the previous value to compare against.
	dsSettingsDiff(stored);
	localStorage.setItem(CFG_KEY, JSON.stringify(stored));
	}
	// Quota: the in-memory `cfg` the caller passed is still authoritative for
	// this session, so the panel keeps working; only the reload-survival is lost.
	catch (e) { /* quota: config holds for this session, not across a reload */ }
}

export function cfgReady(cfg) {
	return !!(cfg.baseUrl && cfg.model && cfg.apiKey);
}
// page-split: install 11

// ── How long a reply may be ────────────────────────────────
//
// Every request carried `max_tokens: 4096`, the same figure for every model,
// described where it was saved as an internal default and not a user-facing
// knob. 4096 OUTPUT tokens is roughly 250 lines of code, so a `file_write` of
// a 400-line module ran out part way -- and because a tool call's arguments
// are themselves a JSON string, what arrived was not a truncated file but a
// malformed tool call. The parse failed, nothing was written, and the model
// was told only that its JSON was bad. Any real coding session met this
// within the hour, and the failure named the wrong cause.
//
// Three things replace the constant, and they only work together:
//
//   AUTO       a per-model default, because a request ABOVE a model's own
//              maximum is an ERROR, not a clamp -- one number for every model
//              is either too small for most or fatal for some;
//   a ceiling  what each model will actually accept, bounding the default and
//              anything the user picks;
//   a knob     `settings.max_tokens` below, because no one figure suits both
//              a one-line answer and a 900-line refactor.
//
// And a fourth, because the ceilings below are incomplete: `noteCapRefused`
// remembers a provider that refused the length asked for, so the refusal
// happens at most once per model rather than every turn.

/// The default reply length, before any per-model ceiling is applied.
///
/// 32,768 output tokens is about 2,000 lines of code -- eight times the old
/// cap, and enough that a whole module arrives in one call. It is deliberately
/// well short of the largest ceilings (128,000 on the current Claude models):
/// `max_tokens` is checked by some providers against what is LEFT of the
/// context window after the prompt, so asking for the maximum on a long
/// conversation is a refusal rather than a longer answer.
export var AUTO_MAX = 32768;

/// The floor a backoff will not go below, and the smallest the setting offers.
export var MIN_MAX = 2048;

/// What a model will accept as `max_tokens`, keyed by the canonical id
/// [`DaimondPricing`] resolves an id to.
///
/// Anthropic rows only, and only because Anthropic publishes the figure per
/// model: 128,000 output tokens across the Claude 5 and 4.6-4.8 generations,
/// 64,000 for Haiku 4.5, 32,000 for Opus 4.1 (Anthropic's published model
/// limits; the current-generation figures were read 2026-08-02). No other
/// provider in the table publishes a ceiling this app can read, so nothing
/// else is written down: an invented ceiling is worse than none, because it
/// would be applied silently. Everything else takes `AUTO_MAX` bounded by the
/// context window -- which providers DO report -- and is corrected by the
/// backoff if that turns out to be too much.
var MAX_OUT = {
	'claude-fable-5':    128000,
	'claude-mythos-5':   128000,
	'claude-opus-5':     128000,
	'claude-opus-4-8':   128000,
	'claude-opus-4-7':   128000,
	'claude-opus-4-6':   128000,
	'claude-sonnet-5':   128000,
	'claude-sonnet-4-6': 128000,
	'claude-haiku-4.5':   64000,
	'claude-opus-4-5':    64000,
	'claude-sonnet-4-5':  64000,
	'claude-opus-4-1':    32000,
};

/// The canonical pricing id a caller's model string resolves to, or ''.
///
/// The resolution is [`DaimondPricing`]'s own -- exact key, then alias, then
/// the LONGEST table key the id contains -- reached through its `_core` export
/// rather than re-implemented here, so `accounts/fireworks/models/glm-5p2` and
/// `GLM-5.2` fold together for the ceiling exactly as they do for the price.
/// A second resolver would be a second set of aliases to keep in step.
function modelFamily(model) {
	var C = window.DaimondPricing && DaimondPricing._core;
	if (!C || !model) return '';
	var key = C.norm(model);
	if (!key) return '';
	if (C.INDEX[key]) return C.INDEX[key];
	for (var i = 0; i < C.KEYS.length; i++) {
		if (key.indexOf(C.KEYS[i]) !== -1) return C.INDEX[C.KEYS[i]];
	}
	return '';
}

/// The largest `max_tokens` this model is known to accept, or 0 when nothing
/// knows. A published context window bounds it whatever the table says: a
/// completion cannot be longer than the window it is generated into.
///
/// `modelFamily`'s containment fallback is left in place here, and the reason is
/// the `Math.min` below rather than any confidence in containment itself.
/// `contextWindow` stopped trusting containment on 2026-08-20 because a borrowed
/// window is applied SILENTLY and in either direction -- `glm-5.3` took glm-5's
/// 204,800 against its own generation's 1,048,576 and clipped every conversation
/// to a fifth. A borrowed OUTPUT ceiling cannot do that, for two reasons that
/// hold together:
///
///   * it can only ever TIGHTEN. `MAX_OUT` holds Anthropic rows alone and every
///     value in it is at or below that model's window, so `min(pub, ctx) <= ctx`
///     -- the answer with a borrowed row is never larger than the answer with no
///     row at all, which is `ctx` or no ceiling. A containment hit therefore
///     cannot produce a request a provider would refuse;
///   * and a ceiling that is too tight is VISIBLE. It shortens one reply, and
///     `capCut` says so in words, naming the limit and the setting that raises
///     it. A refusal in the other direction is caught by `noteCapRefused` and
///     costs one turn, once.
///
/// So the fallback is benign here and the two resolvers may honestly differ.
/// The invariant it rests on -- every `MAX_OUT` value at or below its model's
/// published window -- is checked in `dev/verify_spendowner.mjs`, because it is
/// the thing that would have to change for this note to stop being true.
export function maxOutCeiling(model, provider) {
	var pub = MAX_OUT[modelFamily(model)] || 0;
	var ctx = window.DaimondPricing
		? (DaimondPricing.contextWindow(model, provider || '') || 0) : 0;
	if (pub && ctx) return Math.min(pub, ctx);
	return pub || ctx || 0;
}

// A provider that refused the length we asked for, by "<provider> <model>".
// Kept because the ceilings above are incomplete: without it the same refusal
// would greet every turn on that model, for ever.
var CAPS_KEY = 'daimond-maxout-caps';
function capsLearned() { return readJson(CAPS_KEY, {}); }
function capKey(model, provider) { return (provider || '') + ' ' + (model || ''); }
/// Remember that `n` was refused for this model, so the next request asks for
/// half of it and the user is not shown the same refusal twice.
export function noteCapRefused(model, provider, n) {
	var caps = capsLearned();
	var was = caps[capKey(model, provider)] || n;
	caps[capKey(model, provider)] = Math.max(MIN_MAX, Math.floor(Math.min(was, n) / 2));
	try { localStorage.setItem(CAPS_KEY, JSON.stringify(caps)); } catch (e) { /* best effort */ }
	return caps[capKey(model, provider)];
}

/// The `max_tokens` to send for `model` on `provider`.
///
/// The user's setting when they have made one, `AUTO_MAX` otherwise, and in
/// both cases bounded by the model's ceiling and by anything a refusal has
/// already taught us. Never zero: a zero `max_tokens` is a request for an
/// empty reply, so the floor applies even to a nonsense setting.
export function maxOutFor(model, provider) {
	var want = (typeof pg.cfg.maxOut === 'number' && pg.cfg.maxOut > 0) ? pg.cfg.maxOut : AUTO_MAX;
	return boundMaxOut(want, model, provider);
}

/// What Automatic resolves to for this model, whatever the user has chosen.
/// The setting row names it, so it must not read the setting back.
export function autoMaxOut(model, provider) {
	return boundMaxOut(AUTO_MAX, model, provider);
}

/// `want`, brought within this model's ceiling and anything a refusal has
/// already taught us. Never zero: a `max_tokens` of nought is a request for an
/// empty reply, so the floor applies even to a nonsense figure.
function boundMaxOut(want, model, provider) {
	var ceil = maxOutCeiling(model, provider);
	if (ceil > 0) want = Math.min(want, ceil);
	var learned = capsLearned()[capKey(model, provider)] || 0;
	if (learned > 0) want = Math.min(want, learned);
	return Math.max(MIN_MAX, Math.round(want));
}

/// A token count for a label. Powers of two — which is what the ladder offers
/// — read as 32k rather than the 33k a decimal thousand would give.
export function fmtTok(n) {
	return (n % 1024 === 0) ? (n / 1024) + 'k' : fmtCtx(n);
}

/// Is this failure the provider refusing the reply LENGTH that was asked for,
/// rather than the prompt, the key or the model?
///
/// Both halves are required. `max_tokens` alone appears in messages about the
/// prompt being too long for the window, which the agent's own fold handles
/// and which halving the reply would not fix.
export function capRefused(raw) {
	var s = String(raw == null ? '' : (raw && raw.message ? raw.message : raw));
	if (!/max_?(?:completion_|output_)?tokens/i.test(s)) return false;
	return /too (?:large|long|big|high)|exceed|less than|at most|no more than|maximum|greater than|must be|out of range|invalid/i.test(s);
}

/// A rejection the provider gave no readable reason for.
///
/// The browser transport builds its error from the STATUS LINE alone — see
/// `wasm_fetch` in `src/llm.rs`, which drops the response body that the
/// native path keeps — so a provider answering "max_tokens is too large:
/// this model supports at most 8192 completion tokens" reaches this half as
/// "HTTP error: 400 Bad Request." and nothing more. `capRefused` above can
/// therefore never match in the browser today; it is kept because it is the
/// right test and starts working the moment the body is carried through.
///
/// Until then a bare 400 is treated as a possible reply-length refusal,
/// which is safe for one specific reason: the reply length is the only part
/// of the request this app can try SMALLER without changing what was asked.
/// The smaller ask is the test — it is only believed, and only remembered,
/// if it succeeds. 401/403/404/429 are excluded because each already has its
/// own handling and none of them is about length.
export function opaqueRefusal(raw) {
	var s = String(raw == null ? '' : (raw && raw.message ? raw.message : raw));
	if (/\b(401|403|404|429)\b/.test(s)) return false;
	return /\b400\b/.test(s);
}

/// Did this tool call's arguments arrive incomplete?
///
/// The arguments of a tool call are a JSON string, so a reply that stops at
/// the length limit part-way through one leaves an unclosed string or object.
/// Every tool here takes a JSON object, so anything that will not parse is
/// truncation — and truncation is the ONE cause, because the provider assembles
/// the fragments and would not send syntactically broken JSON otherwise.
/// An absent or empty argument list is not truncation: a no-argument tool
/// sends `{}`, or nothing at all.
export function truncatedArgs(raw) {
	var s = String(raw == null ? '' : raw).trim();
	if (!s || s === '{}') return false;
	try { JSON.parse(s); return false; }
	catch (e) { return true; }
}

/// Keep `cfg` as the resolved DEFAULT model, so everything that used to read one provider out
/// of it still reads the right one out of many.
///
/// `cfg` was the whole configuration; it is now a view of whichever model is starred in
/// [`DaimondModels`]. Making it a view rather than a second copy is the point: two places
/// holding "the current model" is how they come to disagree, and the one the user starred is
/// the one that is true.
export function syncCfgFromModels() {
	if (!window.DaimondModels) return;
	var r = DaimondModels.resolve('', '');
	pg.cfg.baseUrl = r ? r.baseUrl : '';
	pg.cfg.apiKey  = r ? r.apiKey  : '';
	pg.cfg.model   = r ? r.model   : '';
}

/// What a chat should actually run: the model it was started on, or the default.
///
/// A chat records its provider as well as its model, so starring a different default later
/// does not silently move a conversation in progress onto another provider's model. A chat
/// from before providers existed carries only a model id and falls back to the default.
export function appCfgFor(holder) {
	var r = window.DaimondModels
		&& DaimondModels.resolve(holder && holder.provider, holder && holder.model);
	if (r) return r;
	return { baseUrl: pg.cfg.baseUrl, apiKey: pg.cfg.apiKey, model: (holder && holder.model) || pg.cfg.model };
}
// page-split: install 12
// WHICH CHAT WAS ON SCREEN, so a reload comes back to it.
//
// `renderAll` opened `chats.find(c => !c.diamondId)` — the first record the
// store enumerated, which IndexedDB hands back in key order, which is the
// OLDEST chat. The rail is sorted newest-first, so a phone waking up put the
// bottom of the rail on screen while the tile the reader wanted sat at the
// top. From the reader's seat their transcript had vanished, and tapping the
// tile brought it back — which is exactly what was reported, with the record
// never having left the disk.
//
// ── WHERE THIS TAB IS: one owner, and it is per tab (2026-10-12) ─────────
//
// The open chat or Diamond, the face it is on and the open panels were kept
// in localStorage, which every tab of the origin shares. So a BACKGROUND tab
// that moved -- a Diamond opened, a daimon showing a file in Doc -- rewrote
// "where was I" for the tab being read, and that tab's next reload obeyed
// it: the owner's tab came back on another tab's Diamond with an empty Doc
// panel open. `dev/verify_viewpertab.mjs` holds the rule.
//
// So the view lives in sessionStorage, which survives a reload of THIS tab
// and dies with it. A tab with no view of its own -- a new tab, or a phone
// whose app was killed, the case that put this in localStorage to begin
// with -- seeds from the DEVICE's last view, and only a FOCUSED tab writes
// that: on every move it makes, and again whenever it gains focus. A tab in
// the background never does, so the device's answer is always the last tab
// the user was actually looking at.
//
// Whichever was selected last wins within the record: a chat clears the
// Diamond and a Diamond clears the chat, so there is one answer to "where
// was I" and not two. The panels' device copy is the layout's own
// `open`/`stage`/`dock` (DaimondPanels), written under the same focus rule.
var TAB_VIEW_KEY     = 'daimond-tab-view';		// sessionStorage, per account: this tab's view
var LAST_VIEW_KEY    = 'daimond-last-view';		// localStorage: the focused tab's view, the seed for a new tab
var OPEN_CHAT_KEY    = 'daimond-open-chat';		// legacy device keys: read once to seed, removed on the first publish
var OPEN_DIAMOND_KEY = 'daimond-open-diamond';
var tabView = null;		// this tab's view, read once

/// sessionStorage is not under the accounts shim, so the account goes in the
/// key by hand: an account switch is a reload of this same tab.
function tabViewKey() {
	var pre = '';
	try { pre = window.DaimondAccounts ? (DaimondAccounts.prefix() || '') : ''; } catch (e) { /* no accounts module */ }
	return pre + TAB_VIEW_KEY;
}

function cleanView(v) {
	v = (v && typeof v === 'object') ? v : {};
	var out = {
		chat:    typeof v.chat === 'string' ? v.chat : '',
		diamond: typeof v.diamond === 'string' ? v.diamond : '',
		face:    (v.face === 'chat' || v.face === 'crystal') ? v.face : '',
	};
	if (v.panels && typeof v.panels === 'object') out.panels = v.panels;
	return out;
}

export function tabViewGet() {
	if (tabView) return tabView;
	var v = null;
	try { v = JSON.parse(sessionStorage.getItem(tabViewKey()) || 'null'); } catch (e) { /* none, or private mode */ }
	if (v && typeof v === 'object') return (tabView = cleanView(v));
	// No view of its own: seed from the device. No panels in the seed -- the
	// layout already is the device's copy of them, and `load` reads it.
	var d = readJson(LAST_VIEW_KEY, null);
	if (!d) {
		d = {};
		try {
			var oc = localStorage.getItem(OPEN_CHAT_KEY) || '';
			var od = localStorage.getItem(OPEN_DIAMOND_KEY) || '';
			if (od) d.diamond = od; else d.chat = oc;
		} catch (e) { /* private mode */ }
	}
	tabView = cleanView(d);
	delete tabView.panels;
	writeTabView();
	return tabView;
}

function writeTabView() {
	try { sessionStorage.setItem(tabViewKey(), JSON.stringify(tabView)); } catch (e) { /* private mode: this tab forgets */ }
}

/// Is this the tab the user is looking at? Only it may speak for the device.
export function tabForeground() {
	try { return document.visibilityState !== 'hidden' && document.hasFocus(); } catch (e) { return false; }
}

function publishLastView() {
	var v = tabViewGet();
	try {
		localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({ chat: v.chat, diamond: v.diamond, face: v.face }));
		localStorage.removeItem(OPEN_CHAT_KEY);
		localStorage.removeItem(OPEN_DIAMOND_KEY);
	} catch (e) { /* quota or private mode: a new tab falls back to the newest chat */ }
}

export function tabViewSet(patch) {
	var v = tabViewGet();
	Object.keys(patch).forEach(function (k) { v[k] = patch[k]; });
	writeTabView();
	if (tabForeground()) publishLastView();
}

/// Gaining focus makes this tab the device's answer again, panels included.
function tabGainedFocus() {
	if (!tabForeground()) return;
	publishLastView();
	try { window.dispatchEvent(new Event('daimond:tabfocus')); } catch (e) { /* old engine */ }
}
// page-split: install 13

/// A message id minted by the scheme that named a message by its POSITION ALONE.
///
/// `legacy-0000` is message one of EVERY chat stored before mids existed, and the
/// tombstone map it is written into is global and travels in the sync parcel. So
/// clearing one daimon's transcript deleted the opening messages of every other
/// pre-mid conversation, on every device, silently. Seen here it is not honoured.
export var OLD_LEGACY = /^legacy-\d+$/;

/// How long a deletion is remembered.
///
/// THIS WAS SEVEN DAYS AND IT WAS TOO SHORT BY THE WIDTH OF THE RETENTION.
/// A tombstone is the only thing that can defeat a peer's copy of a record,
/// and a peer holds a trashed chat -- and packs it into every parcel, which
/// `storedChats` does deliberately so a trashing can travel -- until its own
/// retention is up. So: delete something permanently on day one, be away
/// from the other device for nine days, and the tombstone had aged out while
/// the peer still had the chat and the trash record. The next parcel handed
/// it back, and both devices agreed a permanently deleted chat was in the
/// trash again. That is what was seen and this is why.
///
/// It is therefore the retention plus a grace, worked out in one place --
/// `DaimondPolicy` in js/trash.js, which also has to answer it for the
/// restore records that face the identical hazard from the other side. It is
/// a HIGH-WATER of every retention this device has seen rather than the
/// current one, because the retention is an operator setting now and can be
/// lowered: a peer that has not heard is still working to the old figure.
///
/// A function and not a constant, for that reason. Every caller reads it
/// afresh, so an operator raising the retention lengthens the memory of a
/// deletion on the next read rather than on the next release.
export function tombTtl() {
	try { return DaimondPolicy.tombTtlMs(); }
	catch (e) { return 37 * 24 * 3600 * 1000; }   // no policy module: 30 + 7
}
export function readJson(key, fallback) {
	try {
		var raw = localStorage.getItem(key);
		return raw ? JSON.parse(raw) : fallback;
	} catch (e) { return fallback; }
}

// ── Masked secret inputs ───────────────────────────────────
// Secrets (the API key, the push token, a prompt's passphrase) are held in
// plain *text* inputs masked by JS rather than `type="password"`, so no
// browser or password manager offers to save them. The mask, the reveal and
// the eye every secret field wears are one component, www/js/secret.js.
// Functions, not aliases: each reaches the module when called, so a closure
// lifted out of this file by a test does not need secret.js to load.
export function installSecretMask(el, v) { return DaimondSecret.mask(el, v); }
export function getSecret(el)            { return DaimondSecret.get(el); }
export function setSecret(el, v)         { return DaimondSecret.set(el, v); }
export function setSecretRevealed(el, s) { return DaimondSecret.reveal(el, s); }
export function hideSecret(el)           { return DaimondSecret.hide(el); }
export function secretEye(el)            { return DaimondSecret.eye(el); }

// ── What the app says ──────────────────────────────────────
// The table lives in i18n/en.js and the engine in i18n.js; these are the
// two names the rest of this file uses.
export function t(k, vars)     { return DaimondI18n.t(k, vars); }
export function tn(k, n, vars) { return DaimondI18n.tn(k, n, vars); }
/// Set a string a widget was HANDED, and leave a trail back to its key.
///
/// The generic machinery -- a dialog, a form, the drawer's heading -- takes
/// finished strings from its callers, so it has no key to put in the markup
/// and nothing repaints it. `mark` looks the key up from the string and
/// stamps it, after which the ordinary `data-i18n` repaint covers it. A
/// string the table never produced (a Diamond's name, a figure) is set and
/// left alone.
export function mark(node, attr, text) { return DaimondI18n.mark(node, attr, text); }
/// Whether figures are being shown in the currency they are billed in.
/// When they are not, a purchase point owes the user a sentence.
export function usdDisplay()   { return DaimondI18n.currency() === 'USD'; }
// Folds commit directly now (owner decision 2026-09-04), so there is no pending
// fold proposal to hold: `pendingFolds` and its Accept/Reject diff were removed.

// Tags are the user's filing system and nothing more. A tag is never sent
// to a model, never written into a crystal, and never changes a prompt; no
// behaviour anywhere reads what a tag says. These four are a nudge for an
// empty tag editor, offered by this screen alone -- the store normalises
// tags but knows nothing of these, and holds no tag to be special.
// They are translated, because a filing system you are invited into in a
// language you do not read is not an invitation. They are also DATA rather
// than labels: adopting one files that word, and it stays that word if the
// interface later changes language -- which is right, since it is then the
// user's tag and not our suggestion.
//
// Normalised here rather than trusted from the table. The store lowercases a
// tag and collapses its spaces, so a translator writing "Projekt" -- correct
// German, and every noun in the language -- would put a chip on screen
// reading "Projekt" that filed "projekt", and the two would not match. Doing
// it here means the table can be written naturally in any language.
export function starterTags() {
	return t('tag.starters').split(',')
		.map(function (x) { return x.split(/\s+/).join(' ').trim().toLowerCase(); })
		.filter(function (x, i, a) { return x && a.indexOf(x) === i; });
}
// page-split: install 14

/// The client's OWN words for a road that failed, which is what it says on every browser.
///
/// `TransportErr::crossed` (src/llm.rs) puts the reason in front of the error before it
/// leaves the engine, so these arrive whatever the browser calls a dead fetch. Quoted rather
/// than paraphrased, and the coupling is deliberate: one of these strings changing in
/// src/llm.rs must break a test here rather than quietly stop classifying.
///
/// `daimond-road` is the newest of them and is the only one set outside the LLM client: it is
/// stamped on a rejected `fetch` by `roadMark` in js/gateway.js, so a TOOL that died on the
/// road carries the same mark a provider call does and reaches the same recovery. It is the
/// one entry here that is a token rather than a sentence, which is deliberate — it is matched
/// EXACTLY in src/tools.rs (`ROAD_MARK`), where the surrounding prose is untrusted and a
/// pattern would be dangerous, and the two spellings are bound together by
/// dev/verify_toolroad.mjs.
var CLIENT_ROAD = /daimond-road|could not reach|could not send the request|closed before replying|the reply was cut short|the reply carried no stream|the stream broke|TLS handshake with|read stream chunk failed/i;

/// And the browser's own words, for a failure that never reached the engine at all.
///
/// A FALLBACK, NOT THE DEFINITION. Every vendor has its own sentence for the same event --
/// Chromium says `Failed to fetch`, WebKit says `Load failed`, and WebKit says
/// `The network connection was lost` when a live connection goes -- so a classifier built
/// on these alone is a classifier that works on the browser it was written in. That is
/// exactly what happened: `Load failed` was absent, so on iOS a turn that died before the
/// first token was read as a provider refusal and thrown away.
///
/// MEASURED, NOT GUESSED. A connection destroyed part way through an answer produces, in
/// WebKit and Chromium alike:
///
///     LLM: read stream chunk failed: TypeError: network error
///
/// `NetworkError` was in the list; `network error`, with the space, was not — so the
/// commonest real transport failure there is fell through every branch below and reached
/// the user as that raw sentence, source frames and all. `\s*` covers both spellings.
/// `connection refused` and NOT a bare `refused`: this codebase refuses things for a living,
/// and `refusal_line` opens some twenty tool sentences with the word. A file_edit refused at a
/// crystal's hot ceiling read as a dead road and was shown to the reader as "could not reach
/// that endpoint" -- eleven times in one turn, while the actual sentence said what to change.
/// Every real transport wording keeps its own token here: ECONNREFUSED, ERR_CONNECTION.
var BROWSER_ROAD = /Failed to fetch|Load failed|The network connection was lost|network\s*error|ERR_CONNECTION|ENOTFOUND|ECONNREFUSED|connection refused|dns/i;

/// Strip terminal control sequences from anything on its way to the DOM.
///
/// fe2o3 colours its `Outcome` chains for a terminal, and those bytes cross
/// the tool boundary intact. A browser has no terminal to interpret them, so
/// an SGR introducer lands in the middle of a sentence as a replacement box
/// followed by the literal text "[91m". This was done for chat errors only,
/// inside friendlyError -- the Workspace panel prints tool output straight
/// through, which is where those codes reached the user.
///
/// Wider than SGR alone: a CSI sequence may end in any byte from @ to ~, and
/// an OSC title sequence left half-matched would swallow the rest of the line.
export function stripAnsi(raw) {
	var s = String(raw == null ? '' : raw);
	s = s.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '');	// OSC ... BEL | ST
	s = s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');		// CSI ... final
	s = s.replace(/\x9b[0-9;?]*[ -\/]*[@-~]/g, '');		// the 8-bit introducer takes no '['
	return s.replace(/[\x1b\x9b]/g, '');			// a lone introducer
}

/// Did the NETWORK fail, rather than the provider answering?
///
/// One definition, read twice: `friendlyError` turns a yes into the sentence the user sees,
/// and `runTurn`'s catch turns it into the difference between a turn thrown away and a turn
/// handed back. Two copies of this test would be two answers to "was that our fault or the
/// road's", and the second would drift.
///
/// # Arguments
/// * `s` - The error text, already stripped of ANSI and of `src/*.rs:NN` frames -- which
///   matters, because a source frame carrying a line number reads as an HTTP status.
export function isUnreachable(s) {
	return CLIENT_ROAD.test(s) || BROWSER_ROAD.test(s);
}

/// The HTTP status a failure is reporting, or 0 when it is not reporting one.
///
/// **A bare number is not a status code.** The tests here were `\b429\b` and `\b5\d\d\b`
/// over whatever text arrived, and a tool refusal is text with numbers in it: a crystal write
/// refused at its hot ceiling names the ceiling and the size, and was shown to the reader as
/// the provider having a server error -- so the one sentence that said what to change never
/// reached them, and the same edit was tried eleven times. So the number has to be ADJACENT
/// to the word that makes it a status, or in a sentence that is plainly about one.
///
/// The wordings are the engine's own: `LLM: HTTP error: 401 Unauthorized`, `HTTP 429`,
/// `the provider returned HTTP 500` (src/llm.rs), and the gateway's `status 502`.
export function httpStatus(s) {
	var m = /\b(?:HTTP|status)(?:\s+error)?\s*:?\s*(\d{3})\b/i.exec(s);
	if (m) return Number(m[1]);
	// The code quoted away from the word, in a sentence that still names one. Narrowed to
	// the 4xx/5xx shape, because a three-digit number in a sentence about anything else is
	// a number.
	if (/\bHTTP\b|\bstatus\b/i.test(s)) {
		m = /\b([45]\d\d)\b/.exec(s);
		if (m) return Number(m[1]);
	}
	return 0;
}

export function friendlyError(raw) {
	var s = String(raw == null ? '' : (raw && raw.message ? raw.message : raw));
	s = stripAnsi(s);
	// Strip the fe2o3 source frames BEFORE reading any status code out of
	// the text. They carry line numbers, and a frame like `src/llm.rs:507`
	// otherwise matches the 5xx test — so an unreachable endpoint was being
	// reported to the user as the provider having a server error.
	s = s.replace(/src\/[^\s":]+\.rs:\d+:?/g, ' ');
	// A transport failure is not a provider response, so test it first.
	if (isUnreachable(s)) {
		return t('err.unreachable');
	}
	// Map the common upstream-provider HTTP statuses to actionable copy. A STATUS, never
	// a number: see `httpStatus`.
	var code = httpStatus(s);
	if (code === 401) return t('err.rejected_401');
	if (code === 403) return t('err.denied_403');
	if (code === 404) return t('err.notfound_404');
	if (code === 429) return t('err.ratelimit_429');
	if (code >= 500 && code <= 599) return t('err.server_5xx');
	// Otherwise, strip the remaining fe2o3 framing and return what is left:
	// the error kind (`[IO File]`), the wrapper struct, the JsValue box, and
	// the trailing `undefined` a missing DOMException message leaves behind.
	s = s.replace(/^\s*Error:\s*/i, '')
		.replace(/[A-Za-z]+Err\{/g, ' ')
		.replace(/JsValue\(/g, ' ')
		// `[A-Z][a-z]+` missed an all-caps kind word, so `[IO Missing]` -- the
		// commonest one there is -- survived into the user's sentence.
		.replace(/\[[A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)*\]/g, ' ')
		.replace(/\bundefined\b/g, ' ')
		// Parentheses are kept: `JsValue(` has its own rule above, and stripping
		// every bracket turned "(an older Safari, or Private Browsing)" into a
		// clause floating loose in the middle of the sentence.
		.replace(/["{}]/g, ' ')
		.replace(/\s*:\s*$/, '')
		.replace(/\s+/g, ' ')
		.replace(/\s+([.,;:])/g, '$1')
		.trim()
		.replace(/[\s.:;,-]+$/, '');
	// Do NOT capitalise a leading `snake_case` identifier: a tool's name is a
	// name, and `file_edit: old_string not found` shown as `File_edit: ...`
	// reads as a typo in the product rather than as the tool that refused.
	if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+\b/.test(s)) return s ? s + '.' : t('err.generic');
	return s ? s.charAt(0).toUpperCase() + s.slice(1) + '.' : t('err.generic');
}

// ── Meters ─────────────────────────────────────────────────
export function fmtCtx(n) {
	if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
	if (n >= 1000) return Math.round(n / 1000) + 'k';
	return '' + n;
}

/// Lock: take the user's content OFF the screen.
///
/// The old lock was a modal laid over a live app — every chat, every name,
/// the spend row and any turn still streaming were all legible behind it,
/// before a passphrase was typed. So it emptied the DOM of nothing and
/// protected nothing. This clears the rendered content, stops the app
/// spending money, and only then asks for the passphrase.
/// One line in the durable trail. See www/js/breadcrumb.js.
export function trail(w, d) { try { window.DaimondTrail.note(w, d); } catch (e) {} }

export function dsEvent(kind, payload) {
	try {
		if (window.DEBUG_SHARE && DEBUG_SHARE.event) DEBUG_SHARE.event(kind, payload);
	} catch (e) { /* the feed must never break the app */ }
}

export function install() { // page-split: install
	// page-split: install 9

	if (typeof marked !== 'undefined') {
		marked.setOptions({ breaks: true });
	}

	/* var */ esc = (window.DaimondRender && DaimondRender.escapeHtml) || function (s) {
		return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
			.replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	};

	// Surface the wasm QR encoder for the pairing UI, which is a classic script
	// and cannot import the module. Only safe to call after init(), which pairing
	// always is (it runs post-auth). Returns the module grid row-major, one byte
	// per module (1 = dark); an empty array means "could not encode".
	window.DaimondQR = {
		matrix: function (text) {
			try { return qr_matrix(String(text)); }
			catch (e) { return new Uint8Array(0); }
		},
	};

	// The seal (S1 SEAL, 16 Oct 2026): the DPS1 post record and the peer envelope's framing are
	// written and read by the Rust in `src/seal/`, the same code the native runner runs, and
	// post.js / peer.js reach it only through this bridge. The keys stay with identity.js: a
	// DPS1 open hands the wasm the 32 bytes of the agreement identity.js made, never the secret.
	//
	// EVERY entry point awaits `ready`, which settles when the wasm is instantiated, so a send
	// made before `init()` has finished WAITS rather than throwing on an unbound module (and a
	// boot that failed rejects it, so nothing waits forever). A refusal a person should read
	// rejects with an Error whose `code` names it (`short`, `not_sealed`, `not_for_you`,
	// `bad_key`, `damaged`, ...), which post.js turns into its translated sentence.
	//
	// The block between the markers is also evaluated by dev/seal_compat.mjs over a Node wasm,
	// so it may name only `window` and `Sbj`.
	// SEAL-BRIDGE-BEGIN
	(function () {
		var want = ['seal_post', 'seal_post_epk', 'seal_post_open', 'seal_scheme',
			'seal_peer_frame', 'seal_peer_aad', 'errand_digest', 'errand_make'];
		var missing = want.filter(function (n) { return typeof Sbj[n] !== 'function'; });
		var settle = {};
		var ready = new Promise(function (res, rej) { settle.res = res; settle.rej = rej; });
		// An unhandled rejection is not this promise's to report; each caller sees it.
		ready.catch(function () {});
		function live() {
			if (missing.length) return false;
			try { Sbj.seal_peer_aad(); return true; } catch (e) { return false; }
		}
		function u8(b) { return (b instanceof Uint8Array) ? b : new Uint8Array(b); }
		// The wasm TYPES its refusals (`e.refusal`, src/wasm/seal.rs): only those carry a
		// code, as `code` and as `refusal` (post.js `isRefusal`, TAKEROW), and are final.
		// Anything else -- a trap, a caller's bad input -- is a failure that may pass (S1 D2).
		function refusal(e) {
			var code = (e && typeof e.refusal === 'string') ? e.refusal : '';
			var msg = String((e && e.message) || e);
			var m = code ? /seal:[a-z_]+:\s*([^\n]*)/.exec(msg) : null;
			var out = new Error(m ? m[1].replace(/\s*\[.*$/, '') : msg);
			out.code = code || 'error';
			if (code) out.refusal = code;
			return out;
		}
		async function call(fn) {
			if (missing.length) {
				var err = new Error('This build cannot seal: its wasm lacks ' + missing.join(', ')
					+ '. Rebuild www/pkg (dev/build-wasm.sh).');
				err.code = 'no_bridge';
				throw err;
			}
			await ready;
			try { return fn(); } catch (e) { throw refusal(e); }
		}
		// A log entry point this wasm may lack (a page ahead of its pkg): named, not a trap.
		function logCall(name, fn) {
			if (typeof Sbj[name] !== 'function') {
				var err = new Error('This build cannot read the chat log: its wasm lacks ' + name + '.');
				err.code = 'no_bridge';
				return Promise.reject(err);
			}
			return call(fn);
		}
		window.DaimondSeal = {
			ready: ready,
			markReady: function () { settle.res(true); },
			markFailed: function (e) { settle.rej(e || new Error('The wasm module did not start.')); },
			// The chat log, written (P2.3b): the engine's `row::Writer` and row cut, so the tab and
			// the runner write one log the same way. `rowAad` is the reader's (P2.3a), below.
			/// A row body's plaintext for `{head, body}`, to seal under `rowAad()`.
			rowSeal: function (head, body) {
				return call(function () { return Sbj.row_seal(JSON.stringify(head), JSON.stringify(body)); });
			},
			/// The wire row for a header and its sealed body.
			rowWire: function (head, sealed) {
				return call(function () { return JSON.parse(Sbj.row_wire(JSON.stringify(head), u8(sealed))); });
			},
			/// A turn's changes since `writer` last looked at `msgs`, and its `end` when given:
			/// `{writer, changes}`.
			logDiff: function (writer, msgs, end) {
				return call(function () {
					return JSON.parse(Sbj.log_diff(JSON.stringify(writer || {}), JSON.stringify(msgs),
						end ? JSON.stringify(end) : ''));
				});
			},
			/// A change's rows numbered from `n`, each plaintext within `plainMax`: `[{head, body}]`.
			logRows: function (turn, daimon, n, change, plainMax) {
				return call(function () {
					return JSON.parse(Sbj.log_rows(turn, daimon || '', n, JSON.stringify(change), plainMax));
				});
			},
			/// Seal bytes to a list of 32-byte X25519 public keys (DPS1).
			sealPost: function (recipients, plain) {
				return call(function () {
					var cat = new Uint8Array(recipients.length * 32);
					for (var i = 0; i < recipients.length; i++) cat.set(u8(recipients[i]), i * 32);
					return Sbj.seal_post(cat, u8(plain));
				});
			},
			/// Seal bytes to ONE runner's 32-byte Ed25519 device key: a one-slot DPS1 to its
			/// X25519 form (R2d1, `src/seal/runner.rs`). Only that runner's keeper opens it.
			sealRunnerBundle: function (edPk, plain) {
				if (typeof Sbj.seal_runner_bundle !== 'function') {
					var err = new Error('This build cannot seal to a runner: its wasm lacks seal_runner_bundle.');
					err.code = 'no_bridge';
					return Promise.reject(err);
				}
				return call(function () { return Sbj.seal_runner_bundle(u8(edPk), u8(plain)); });
			},
			/// The ephemeral key of a DPS1 record, its header checked.
			postEpk: function (bytes) {
				return call(function () { return Sbj.seal_post_epk(u8(bytes)); });
			},
			/// Open a DPS1 record with the agreement already made: `{ plain, ck }`.
			openPost: function (bytes, shared, ownPub) {
				return call(function () {
					var out = Sbj.seal_post_open(u8(bytes), u8(shared), u8(ownPub));
					return { ck: out.slice(0, 32), plain: out.slice(32) };
				});
			},
			/// 'DPY2', 'DPY1', 'DPS1', or '' for a body with no known tag.
			scheme: function (bytes) {
				return call(function () { return Sbj.seal_scheme(u8(bytes)); });
			},
			/// DPY2 ‖ body, for a body identity.js sealed under `peerAad()`.
			peerFrame: function (body) {
				return call(function () { return Sbj.seal_peer_frame(u8(body)); });
			},
			/// The purpose a DPY2 body is bound to.
			peerAad: function () {
				return call(function () { return Sbj.seal_peer_aad(); });
			},
			/// The 32 bytes the account key signs for an envelope (`sigv:2`, the engine's
			/// `errand::codec::signed_bytes`): the one codec, so tab and runner agree.
			errandDigest: function (json) {
				return call(function () { return Sbj.errand_digest(json); });
			},
			/// The envelope's text with `sigv:2`, `author` and `sig` (raw bytes) set.
			errandMake: function (json, author, sig) {
				return call(function () { return Sbj.errand_make(json, u8(author), u8(sig)); });
			},
			// The chat log, read (P2.3a): `rowSealed`, identity.js unwraps under `rowAad`, then
			// `rowOpen`; `turnviewApply` is the one end-of-turn decision. Strings in, strings out.
			rowAad: function () {
				return logCall('row_aad', function () { return Sbj.row_aad(); });
			},
			rowSealed: function (wire) {
				return logCall('row_sealed', function () { return Sbj.row_sealed(wire); });
			},
			rowOpen: function (wire, plain) {
				return logCall('row_open', function () { return Sbj.row_open(wire, u8(plain)); });
			},
			turnviewApply: function (view, row) {
				return logCall('turnview_apply', function () { return Sbj.turnview_apply(view, row); });
			},
		};
		// Already instantiated (a harness that initialised the module first): ready now.
		if (live()) settle.res(true);
	})();
	// page-split: install 10
	/* var */ sbjMissing = sbjWant.filter(function (n) { return typeof Sbj[n] !== 'function'; });
	if (!sbjMissing.length) {
		window.DaimondCrypto = {
			fingerprint:  function (b) { return Sbj.identity_fingerprint(b); },
			safetyNumber: function (a, b) { return Sbj.identity_safety_number(a, b); },
			cardEncode:   function (label, enc, prev) { return Sbj.card_encode(label, enc, prev); },
			signingInput: function (p, s, a, t) { return Sbj.sbj_signing_input(p, s, a, t); },
			assemble:     function (p, s, a, t, sig) { return Sbj.sbj_assemble(p, s, a, t, sig); },
			address:      function (p) { return Sbj.sbj_address(p); },
			read:         function (b) { return Sbj.sbj_read(b); },
			/// A message being written, held on the wasm side while it is built.
			postDraft:    function (body, to, nonce) { return new Sbj.PostDraft(body, to, nonce); },
			/// A Diamond being shared, and the reading of one that arrives. Same
			/// seam as the message above: the crate encodes and says what to sign,
			/// this file signs with a key that never crosses the boundary.
			shareDraft:   function (name, to, nonce) { return new Sbj.ShareDraft(name, to, nonce); },
			shareRead:    function (b) { return Sbj.share_read(b); },
		};
	} else {
		// SAID OUT LOUD, because the whole point of reading these off a namespace
		// is that their absence cannot stop the app -- and something that cannot
		// stop the app is something nobody notices. A stale `www/pkg` is the
		// ordinary cause and the fix is to rebuild it; a name missing from a
		// FRESH build is a rename, and this is the line that says which.
		try {
			console.warn('Daimond: the wasm module is missing ' + sbjMissing.join(', ')
				+ ' — identity fingerprints and cards are unavailable. Rebuild www/pkg '
				+ '(dev/build-wasm.sh); if a fresh build still lacks them, they were renamed.');
		} catch (e) { /* no console */ }
		trail('sbj bridge absent', sbjMissing.join(','));
	}
	// page-split: install 11

	// ── The two secrets THIS file seals, surviving a passphrase change ──
	//
	// `apiKeyEnc` and `pushTokenEnc`, both written by `saveCfg` above and both
	// sealed with `DaimondIdentity.wrap`. They were the only two on the old
	// hand-written list in `doChangePassphrase`, and they are registered here for
	// the same reason every other module registers beside its own seal: the list
	// is gone, and a secret takes part by saying so where it is sealed.
	//
	// Neither has a read-out phase. `cfg.apiKey` and `cfg.pushToken` are held
	// decrypted in memory for the length of an unlocked session — `afterUnlock`
	// puts them there — so there is nothing to read out under the old key. That is
	// the `models.js` shape, not the `mail.js` one.
	//
	// SEPARATELY, not as one participant, because they fail separately: a refused
	// API key must cost the push token nothing, and two participants is how the
	// registry states that rather than how a comment claims it.
	if (window.DaimondRekey) {
		DaimondRekey.register({
			name:   'apikey',
			reseal: async function () {
				if (!pg.cfg.apiKey) return { failed: [] };
				try { pg.cfg.apiKeyEnc = await DaimondIdentity.wrap(pg.cfg.apiKey); saveCfg(pg.cfg); }
				catch (e) { return { failed: [t('changepass.the_api_key')] }; }
				return { failed: [] };
			},
			// One secret, so the sentence names the thing rather than a list of one.
			sentence: function () { return t('changepass.key_not_resealed'); },
			// This device has been removed and the key that sealed it is gone for
			// good: drop the ciphertext AND the plaintext held in memory, so a
			// stray `cfg.apiKey` cannot be read off this device once it no longer
			// has a passphrase to prove it holds the account's own.
			purge: function () {
				pg.cfg.apiKey = ''; pg.cfg.apiKeyEnc = ''; saveCfg(pg.cfg);
			},
		});
		DaimondRekey.register({
			name:   'push',
			reseal: async function () {
				// Sealed under the passphrase that has just changed, so without this it
				// would unwrap to nothing on the next load and every push would be
				// refused with no reason on screen. The engine's copy is untouched, so
				// pushing goes on working until the tab is reloaded.
				if (!pg.cfg.pushToken) return { failed: [] };
				try { pg.cfg.pushTokenEnc = await DaimondIdentity.wrap(pg.cfg.pushToken); saveCfg(pg.cfg); }
				catch (e) { return { failed: [t('push.the_token')] }; }
				return { failed: [] };
			},
			sentence: function () { return t('push.not_resealed'); },
			purge: function () {
				pg.cfg.pushToken = ''; pg.cfg.pushTokenEnc = ''; saveCfg(pg.cfg);
			},
		});
	}
	// page-split: install 12
	/* var */ pg.cfg = loadCfg();
} // page-split: end install

export function install_2() { // page-split: install
	// page-split: install 13
	window.addEventListener('focus', tabGainedFocus);
	document.addEventListener('visibilitychange', tabGainedFocus);
	window.DaimondTabView = { get: function () { return cleanView(tabViewGet()); }, foreground: tabForeground };
} // page-split: end install

export function install_3() { // page-split: install
	// page-split: install 14
	/* var */ pg.tagMode = readJson(TAG_MODE_KEY, 'all') === 'any' ? 'any' : 'all';
	/* var */ pg.tagPoolOpen  = readJson(TAG_POOL_KEY, false) === true;
} // page-split: end install
