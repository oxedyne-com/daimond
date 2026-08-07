/* ============================================================
   Daimond — browser-only agent UI (Stage 5a)
   ------------------------------------------------------------
   The whole application now runs in the browser: an ES module
   that drives the wasm `DaimondApp` (daimond compiled to wasm)
   directly, with no server. It reuses the existing four-panel
   shell, CSS and `DaimondRender` from the retiring server UI:
     - Rail    : chats list + new chat.
     - AI     : the conversation, streamed live.
     - Agents  : per-turn tool activity.
     - Workspace: an OPFS file tree over `run_tool`.

   Security (H5): the frontend is the whole app, so every
   interpolation of model output, file names or file contents
   is HTML-escaped, and markdown passes through the sanitiser in
   render.js. No untrusted string reaches innerHTML unescaped.

   Bring-your-own-key settings (base URL, key, model, max
   tokens) live in localStorage for now; passphrase-wrapping is
   a later hardening stage (see the TODO in index.html).
   ============================================================ */
// The whole wasm surface, as a namespace, BESIDE the named imports below.
//
// A named import of something the module does not export is a link-time error
// that takes the entire app down before a line of it runs, so anything this page
// asks for CONDITIONALLY has to be reached as a property instead. The terminal
// panel's `open` request is composed on the Rust side (see DaimondTerm), and a
// build whose wasm predates that edge must refuse the terminal rather than fail
// to boot.
import * as Wasm from '../pkg/oxedyne_daimond.js';

/// Read a file's BYTES, for anything that is not a model.
///
/// `run_tool('file_read')` is a MODEL-FACING RENDERING, not a file reader: it
/// prefixes every line with its number and a TAB, says when it truncates, and
/// wraps anything under an untrusted path in an envelope. Handed to something
/// that treats the result as the file, every line gains `1\t`, `2\t`, and so on.
///
/// This has shipped as a live bug FOUR times, each found only after the last was
/// written down: the Doc panel showed and then SAVED the numbered rendering; the
/// Email panel read every message header through it and showed "(unknown)"; the
/// `conductor` -> `daimon` prompt migration wrote the numbered text into the new
/// file; and the Web panel rendered an agent-written page with the numbers in it.
/// The rule is one line long and keeps being missed, so it now has one function
/// to be missed in.
///
/// Use `run_tool('file_read')` ONLY to ask a model-shaped question — chiefly "does
/// this file exist", where the answer is the error prefix and not the content.
function readBytes(path) {
	return Wasm.read_file(path);
}
import init, {
	DaimondApp,
	builtin_tools,
	qr_matrix,
	set_account_ns,
	install_panic_hook,
	set_workspace_dir,
	use_opfs_workspace,
	compose_prompt,
	default_prompt,
	safety_clause,
} from '../pkg/oxedyne_daimond.js';

(function () {
	'use strict';

	if (typeof marked !== 'undefined') {
		marked.setOptions({ breaks: true });
	}

	var esc = (window.DaimondRender && DaimondRender.escapeHtml) || function (s) {
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

	// The prompt each kind of agent runs under is the user's, held as a file in
	// their workspace (prompts/<role>.md) and read by `Prompts` below. The text
	// itself lives in Rust (src/prompts.rs) so there is one definition of what a
	// model is really sent -- a copy here would drift from it -- and so the rules
	// a user's edit cannot remove travel with every composition.
	//
	// SYSTEM_PROMPT is what a chat is told, composed from that file plus those
	// rules. It is a function, not a constant, because the file can change under
	// a running app.
	function SYSTEM_PROMPT() { return Prompts.role('chat'); }

	// ── Settings (BYOK, localStorage) ──────────────────────────
	var CFG_KEY = 'daimond-byok';

	// The cached model list of the ONE provider the app used to hold is gone: `DaimondModels`
	// caches a list per provider now, and is the only thing that answers "what can Daimond run".
	// The `daimond-models` key it was kept under is still WRITTEN below, because the migration in
	// models.js reads it to carry an existing install's models across.

	// Curated OpenAI-compatible providers. All five were verified to allow
	// direct browser (CORS) calls in Slice 0, so BYOK works with no relay.
	// `url` is the chat-completions endpoint; the models endpoint is derived
	// from it. `model` is a sensible default where a stable id is known.
	var PROVIDERS = {
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
	function providerForUrl(url) {
		for (var id in PROVIDERS) { if (PROVIDERS[id].url === url) return id; }
		return url ? 'custom' : '';
	}

	// Derive the `/models` listing endpoint from a turn endpoint.
	//
	// Delegated to models.js, which knows the providers that do not follow the OpenAI
	// shape: Anthropic's listing is a SIBLING of its turn endpoint, so the rule below
	// asked `/v1/messages/models` — nobody's endpoint, and a 404 with no explanation.
	// The local rule stays as the fallback, for a page where models.js has not loaded.
	function modelsUrl(base) {
		if (window.DaimondModels && DaimondModels.modelsUrl) return DaimondModels.modelsUrl(base);
		if (base.indexOf('/chat/completions') !== -1) return base.replace('/chat/completions', '/models');
		return base.replace(/\/+$/, '') + '/models';
	}

	/// The headers a model listing needs for `base`.
	///
	/// Delegated for the same reason as `modelsUrl`: Anthropic refuses a bearer token
	/// and wants `x-api-key`, a pinned version, and the header that makes its edge
	/// answer a browser at all. A hardcoded bearer got a 401 and looked like a bad key.
	function authHeadersFor(base, key) {
		if (window.DaimondModels && DaimondModels.authHeaders) return DaimondModels.authHeaders(base, key);
		return { 'Authorization': 'Bearer ' + key };
	}

	function loadCfg() {
		var raw = localStorage.getItem(CFG_KEY);
		// `maxOut` of 0 means AUTO: let `maxOutFor` pick per model. See the
		// "How long a reply may be" section below for why one number for every
		// model was the wrong shape.
		//
		// `pushToken` is deliberately NOT in the stored shape and never read back: the
		// wrapped `pushTokenEnc` is the only form that reaches storage. See `saveCfg`.
		var cfg = { baseUrl: '', apiKey: '', apiKeyEnc: '', model: '', maxOut: 0, maxRounds: 0, crystalKb: 0, tools: true,
			foldModel: '', foldProvider: '',
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
				if (typeof j.crystalKb === 'number') cfg.crystalKb = j.crystalKb;
				if (typeof j.tools === 'boolean') cfg.tools = j.tools;
				// What folds a conversation when it outgrows its window. Empty -- and an
				// absent field -- means the conversation's own model, which is what the
				// engine has always silently done. The provider travels with it for the
				// same reason it does everywhere else: a bare model id no longer says
				// which key to send it with.
				if (typeof j.foldModel === 'string') cfg.foldModel = j.foldModel;
				if (typeof j.foldProvider === 'string') cfg.foldProvider = j.foldProvider;
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
	function saveCfg(c) {
		localStorage.setItem(CFG_KEY, JSON.stringify({
			baseUrl:   c.baseUrl || '',
			apiKey:    c.apiKeyEnc ? '' : (c.apiKey || ''),
			apiKeyEnc: c.apiKeyEnc || '',
			model:     c.model || '',
			maxOut:    c.maxOut || 0,
		maxRounds: c.maxRounds || 0,
			crystalKb: c.crystalKb || 0,
			tools:     c.tools !== false,
			foldModel:    c.foldModel || '',
			foldProvider: c.foldProvider || '',
			// Written on every save, not only by the push panel: this function
			// rebuilds the stored object from scratch, so a field it does not know
			// about is a field the next unrelated save DELETES.
			pushHost:     c.pushHost || '',
			pushUser:     c.pushUser || '',
			pushTokenEnc: c.pushTokenEnc || '',
		}));
	}

	function cfgReady(cfg) {
		return !!(cfg.baseUrl && cfg.model && cfg.apiKey);
	}

	// ── The credential a push travels with ─────────────────────
	//
	// The engine holds it in ONE `thread_local` belonging to the wasm instance, and
	// a reload builds a fresh instance -- so the engine's copy is gone on every
	// load, and every account boundary (switch, add, erase, restore, take an
	// update) IS a reload. The page is therefore the only thing that can bring it
	// back, and it has to do so on every path that ends in a usable app: a push
	// that worked yesterday and silently refuses today is the failure this exists
	// to prevent.
	//
	// There is exactly one such path, and it is established from the code rather
	// than assumed. A reload always locks -- `identity.js` holds the wrapping key
	// in memory alone, so `isUnlocked()` is false at boot however the tab got there
	// -- and every way past the gate ends in `completeUnlock`: a typed passphrase
	// and a freshly created account both through `idPrimary`, a passkey and a
	// passkey adoption both through `passkeyUnlock`. `completeUnlock` awaits
	// `afterUnlock`, which is where the replay goes. The one boot that does NOT
	// reach it is the browser-only path with no identity at all -- and that path
	// has nothing stored to replay, because storing it needs an identity to wrap
	// it under.
	//
	// So: `afterUnlock` replays, `lockApp` clears, `doChangePassphrase` re-seals,
	// and nothing else touches it.

	/// Hand the held credential to the engine, or clear it there.
	///
	/// The engine holds one credential for the whole wasm instance rather than one
	/// per agent, so any built app will do; `tools()` is simply the one that always
	/// exists. An empty token CLEARS it, which is what makes this the same call for
	/// setting and for forgetting.
	///
	/// # Returns
	/// Whether a credential is held afterwards.
	function applyPushCred() {
		try {
			return !!tools().set_push_cred(
				cfg.pushHost || '', cfg.pushUser || '', cfg.pushToken || '');
		} catch (e) {
			// A host the engine will not have, or a token carrying something that
			// cannot travel in a header. This is the SILENT path -- the replay, and the
			// clear -- so there is nobody to tell; the panel reports its own failures
			// where the user is standing in front of it. A credential the engine
			// refuses is a credential that is not held, which is the safe reading.
			return false;
		}
	}

	/// The host the ENGINE says a push would reach, or empty.
	///
	/// Asked of the engine and never of storage. Those two differ in exactly the
	/// case that matters: a reload empties the engine's copy, and a panel drawn
	/// from `localStorage` would report a push configured while every push was
	/// being refused.
	function pushHostHeld() {
		try { return tools().push_host() || ''; } catch (e) { return ''; }
	}

	/// The user name a token travels as at `host`.
	///
	/// Inferred rather than asked for, and that is the whole reason there are two
	/// boxes and not three. It is a per-forge constant and not a choice: GitHub
	/// wants `x-access-token`, which the engine supplies for an empty value, and
	/// GitLab wants `oauth2`. A box labelled "user name" is a box a person fills in
	/// with their own login, which authenticates nowhere and fails with a message
	/// that names neither the box nor the reason.
	///
	/// # Arguments
	/// * `host` - The bare host, as typed.
	function pushUserFor(host) {
		return /gitlab/i.test(String(host || '')) ? 'oauth2' : '';
	}

	/// Draw the push panel: the host that is set, and an empty token box.
	///
	/// The token box starts empty every time and is emptied again after a save. The
	/// token is write-only from here on -- there is no accessor for it in the
	/// engine and no reason for it to be back on screen, and a field redrawn with a
	/// secret in it is a secret in the DOM for anything that can read the DOM.
	function fillPushSettings() {
		var h = document.getElementById('cfg-push-host');
		if (h) h.value = cfg.pushHost || '';
		setSecret(document.getElementById('cfg-push-token'), '');
		var n = document.getElementById('push-note');
		if (n) n.textContent = '';
		renderPushState();
	}

	/// The one line that says what a push would do right now.
	function renderPushState() {
		var el = document.getElementById('push-state');
		if (!el) return;
		var held = pushHostHeld();
		el.textContent = held ? t('push.set', { host: held }) : t('push.none');
	}

	/// Take what is in the two boxes and make it the credential, or remove the one
	/// held.
	///
	/// The engine is asked BEFORE anything is stored, because the engine is the one
	/// place that decides what a host and a token may be -- so a refusal leaves
	/// nothing behind in storage to be replayed on the next load.
	async function savePushCred() {
		var note = document.getElementById('push-note');
		var hostEl = document.getElementById('cfg-push-host');
		var tokEl  = document.getElementById('cfg-push-token');
		if (!note || !hostEl || !tokEl) return;
		var host  = (hostEl.value || '').trim();
		var token = getSecret(tokEl).trim();
		note.textContent = '';
		// An empty token REMOVES the credential rather than storing an empty one, so
		// it is not an error and it needs no host. Same call, and the engine's own
		// rule: "there is no credential" is a sentence a model can act on where
		// "authentication failed" is not.
		if (!token) {
			cfg.pushHost = ''; cfg.pushUser = ''; cfg.pushToken = ''; cfg.pushTokenEnc = '';
			saveCfg(cfg);
			applyPushCred();
			hostEl.value = '';
			setSecret(tokEl, '');
			renderPushState();
			note.textContent = t('push.cleared');
			return;
		}
		if (!host) { note.textContent = t('push.err_host'); hostEl.focus(); return; }
		var user = pushUserFor(host);
		var held;
		try { held = tools().set_push_cred(host, user, token); }
		catch (e) { note.textContent = friendlyError(e); hostEl.focus(); return; }
		if (!held) { note.textContent = t('push.err_not_held'); return; }
		// The engine folds the host -- 'GitHub.com/' becomes 'github.com' -- so what
		// is stored is what a push will actually reach, and the box agrees with it.
		cfg.pushHost  = pushHostHeld() || host;
		cfg.pushUser  = user;
		cfg.pushToken = token;
		// Wrapped, or not stored at all. There is no plaintext fallback here: see
		// `saveCfg`. The host and the inferred user name are not secrets and are
		// kept either way, so a browser-only user retypes only the token.
		var kept = false;
		cfg.pushTokenEnc = '';
		if (window.DaimondIdentity && DaimondIdentity.isUnlocked()) {
			try { cfg.pushTokenEnc = await DaimondIdentity.wrap(token); kept = true; }
			catch (e) { cfg.pushTokenEnc = ''; }
		}
		saveCfg(cfg);
		hostEl.value = cfg.pushHost;
		setSecret(tokEl, '');
		renderPushState();
		note.textContent = kept ? t('push.saved') : t('push.session_only');
	}

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
	var AUTO_MAX = 32768;

	/// The floor a backoff will not go below, and the smallest the setting offers.
	var MIN_MAX = 2048;

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
	function maxOutCeiling(model, provider) {
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
	function noteCapRefused(model, provider, n) {
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
	function maxOutFor(model, provider) {
		var want = (typeof cfg.maxOut === 'number' && cfg.maxOut > 0) ? cfg.maxOut : AUTO_MAX;
		return boundMaxOut(want, model, provider);
	}

	/// What Automatic resolves to for this model, whatever the user has chosen.
	/// The setting row names it, so it must not read the setting back.
	function autoMaxOut(model, provider) {
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
	function fmtTok(n) {
		return (n % 1024 === 0) ? (n / 1024) + 'k' : fmtCtx(n);
	}

	/// Is this failure the provider refusing the reply LENGTH that was asked for,
	/// rather than the prompt, the key or the model?
	///
	/// Both halves are required. `max_tokens` alone appears in messages about the
	/// prompt being too long for the window, which the agent's own fold handles
	/// and which halving the reply would not fix.
	function capRefused(raw) {
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
	function opaqueRefusal(raw) {
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
	function truncatedArgs(raw) {
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
	function syncCfgFromModels() {
		if (!window.DaimondModels) return;
		var r = DaimondModels.resolve('', '');
		cfg.baseUrl = r ? r.baseUrl : '';
		cfg.apiKey  = r ? r.apiKey  : '';
		cfg.model   = r ? r.model   : '';
	}

	/// What a chat should actually run: the model it was started on, or the default.
	///
	/// A chat records its provider as well as its model, so starring a different default later
	/// does not silently move a conversation in progress onto another provider's model. A chat
	/// from before providers existed carries only a model id and falls back to the default.
	function appCfgFor(holder) {
		var r = window.DaimondModels
			&& DaimondModels.resolve(holder && holder.provider, holder && holder.model);
		if (r) return r;
		return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: (holder && holder.model) || cfg.model };
	}

	// ── State ──────────────────────────────────────────────────
	var cfg = loadCfg();
	var chats = [];             // { id, name, app, messages:[{role,content}], promptTokens, completionTokens }
	var current = null;         // active chat object
	var _unloading = false;     // the page is on its way out — an aborted request is not a failure

	// Persist chats (minus the non-serialisable DaimondApp) so they survive a
	// reload; the app is rebuilt lazily by ensureApp on the next turn.
	//
	// Two tabs share one localStorage, and each holds its own in-memory
	// `chats` array. Writing that array wholesale means the last tab to
	// save silently destroys every chat the other one created. So a save
	// MERGES: it reads what is stored, takes the newer of each chat by id,
	// keeps chats it has never heard of, and honours tombstones for the
	// ones this tab deleted on purpose.
	var CHATS_KEY = 'daimond-chats';
	var TOMBS_KEY = 'daimond-chats-deleted';
	// Diamonds live in OPFS, which fires no event when another tab writes to it,
	// so two windows of the same account went on showing two different rails for
	// ever -- a Diamond made in one was invisible in the other, and re-making it
	// there looked like nothing happening. localStorage DOES fire across tabs, so
	// a nonce bumped on every Diamond mutation is the signal OPFS does not give:
	// the value means nothing, the CHANGE is the whole message.
	var DIAMONDS_KEY = 'daimond-diamonds-rev';
	// Diamonds deleted on purpose, by id. A Diamond lives in OPFS, and the sync
	// merge carries what the store HAS -- so a Diamond deleted here and still
	// present on the other device would simply be handed back on the next pull,
	// for ever. A tombstone is how a deletion survives that, exactly as it does
	// for chats.
	var DIAMOND_TOMBS_KEY = 'daimond-diamond-tombs';
	var MSG_TOMBS_KEY = 'daimond-msgs-deleted';   // individual messages removed (a continued interrupted turn)
	var TOMB_TTL  = 7 * 24 * 3600 * 1000;   // a deletion outlives any live tab

	/// Messages removed on purpose, by id. The transcript merge is an append-only UNION, so a
	/// message dropped from this tab's array is silently re-added from what another tab (or this
	/// tab a moment ago) stored. A tombstone is how a removal survives the union — used when a
	/// continued interrupted turn is replaced, so it does not resurrect on the next reload.
	function loadMsgTombs() {
		var t = readJson(MSG_TOMBS_KEY, {}), now = Date.now(), out = {};
		Object.keys(t).forEach(function (id) { if (now - t[id] < TOMB_TTL) out[id] = t[id]; });
		return out;
	}
	function msgTombstone(mids) {
		if (!mids || !mids.length) return;
		var t = loadMsgTombs(), now = Date.now();
		mids.forEach(function (id) { if (id) t[id] = now; });
		try { localStorage.setItem(MSG_TOMBS_KEY, JSON.stringify(t)); } catch (e) { /* best effort */ }
	}

	// Every message carries an id, so two tabs appending to the same chat union
	// their turns instead of one overwriting the other.
	var midSeq = 0;
	function newMid() {
		midSeq += 1;
		return Date.now().toString(36) + '-' + midSeq.toString(36) + '-' + Math.random().toString(36).slice(2, 7);
	}
	function stampMessages(msgs) {
		(msgs || []).forEach(function (m, i) {
			if (!m.mid) m.mid = 'legacy-' + ('0000' + i).slice(-4);
			if (!m.ts) m.ts = 0;
		});
		return msgs || [];
	}
	/// Union two transcripts of the same chat, in time order, keeping every turn — except a message
	/// that has been tombstoned, which stays gone however many copies of it the union sees.
	///
	/// When the same message arrives twice, the FULLER copy is kept. A tool result is shortened on
	/// its way into storage (`slimMessages`), so without that rule a merge against the store would
	/// hand this tab's whole result back to it truncated — the store's copy is written first, and
	/// first used to win.
	function mergeMessages(a, b) {
		var at = {}, out = [], tombs = loadMsgTombs();
		stampMessages(a).concat(stampMessages(b)).forEach(function (m) {
			if (tombs[m.mid]) return;
			var had = at[m.mid];
			if (had === undefined) { at[m.mid] = out.length; out.push(m); return; }
			if ((out[had].elided || 0) && !(m.elided || 0)) out[had] = m;
		});
		out.sort(function (x, y) {
			if ((x.ts || 0) !== (y.ts || 0)) return (x.ts || 0) - (y.ts || 0);
			return String(x.mid).localeCompare(String(y.mid));
		});
		return out;
	}

	// `provider` is written and read back with the model. Without it a reload would leave a chat
	// holding a model id and no idea whose key it belonged to, and it would silently fall back to
	// the default provider -- the exact drift a chat records its provider in order to prevent.
	///
	/// The cached and cost counters travel with the token counters, and for the same reason: the
	/// next turn is metered by the GROWTH of each, so a counter that restarted at zero after a
	/// reload would bill the whole restored session again as one turn.
	///
	/// `session` is the conversation the MODEL holds, which is not the same object as the
	/// transcript on screen: it carries the provider's own tool-call ids, and it is the folded
	/// list once compaction has run. See `captureSession`.
	/// `workerModel`/`workerProvider` travel for the same reason the chat's own pair does: they are
	/// a decision the user made when the chat was created, and a device that did not receive them
	/// would put this chat's workers back on whatever IT has starred. Empty means "not chosen", and
	/// every reader takes that as the chat's own model -- never the default.
	/// `diamondId` is what makes a record a DAIMON'S conversation rather than a chat.
	///
	/// It travels for the same reason the rest does: the daimon is persistent, and a
	/// device that received the Diamond but not the conversation would show an empty
	/// chat view beside a crystal full of work. One field, because everything else
	/// about the record is the same — which is the whole reason a Diamond's chat is an
	/// ordinary chat record and not a second kind of transcript with a second renderer,
	/// a second store and a second merge.
	function slimChat(c) {
		return { id: c.id, name: c.name, messages: c.messages, model: c.model, provider: c.provider || '',
			diamondId: c.diamondId || '',
			workerModel: c.workerModel || '', workerProvider: c.workerProvider || '',
			status: c.status || 'active',
			session: c.session || null,
			promptTokens: c.promptTokens || 0, completionTokens: c.completionTokens || 0,
			cachedTokens: c.cachedTokens || 0, costUsd: c.costUsd || 0,
			prevPrompt: c.prevPrompt || 0, prevCompletion: c.prevCompletion || 0, lastPrompt: c.lastPrompt || 0,
			prevCached: c.prevCached || 0, prevCost: c.prevCost || 0,
			updatedAt: c.updatedAt || 0, foldedInto: c.foldedInto || null };
	}
	function readJson(key, fallback) {
		try {
			var raw = localStorage.getItem(key);
			return raw ? JSON.parse(raw) : fallback;
		} catch (e) { return fallback; }
	}
	function loadTombs() {
		var t = readJson(TOMBS_KEY, {}), now = Date.now(), out = {};
		Object.keys(t).forEach(function (id) { if (now - t[id] < TOMB_TTL) out[id] = t[id]; });
		return out;
	}
	function tombstone(id) {
		var t = loadTombs();
		t[id] = Date.now();
		try { localStorage.setItem(TOMBS_KEY, JSON.stringify(t)); } catch (e) { /* best effort */ }
	}
	/// The Diamonds deleted on purpose, by id, with anything past its TTL pruned.
	function loadDiamondTombs() {
		var t = readJson(DIAMOND_TOMBS_KEY, {}), now = Date.now(), out = {};
		Object.keys(t).forEach(function (id) { if (now - t[id] < TOMB_TTL) out[id] = t[id]; });
		return out;
	}
	/// Record that a Diamond was deleted on purpose, so the other device deletes
	/// it too rather than handing it back.
	function diamondTombstone(id) {
		if (!id) return;
		var t = loadDiamondTombs();
		t[id] = Date.now();
		try { localStorage.setItem(DIAMOND_TOMBS_KEY, JSON.stringify(t)); } catch (e) { /* best effort */ }
	}

	// ── Where a transcript actually lives ──────────────────────
	//
	// It lived in localStorage, which holds about five megabytes for the whole
	// origin. A day of coding — two hundred tool calls at eight kilobytes of result
	// apiece — is a megabyte and a half in ONE chat, and `setItem` throws when the
	// origin is full. The throw was caught and dropped:
	//
	//     catch (e) { /* quota or unavailable — chats stay in-memory this session */ }
	//
	// so the work went on being shown and went on being answered, and simply stopped
	// being saved. The user found out on the next reload, when it was gone. That is
	// the same shape as the tag-loss incident — a store quietly doing something other
	// than what its reader assumed — and the rule that came out of that one is that
	// what is lost is SAID.
	//
	// So chats live in IndexedDB now: sized in hundreds of megabytes, structured
	// (no stringify of the whole store on every save), and it reports its failures.
	// journal.js already keeps the write-ahead log there and `daimond-fsa` keeps the
	// directory handle, so this follows the shape they set — a database name per
	// account, one object store, the connection dropped and reopened when the account
	// changes underneath it.
	//
	// Three things localStorage did that IndexedDB does not, and what replaces each:
	//
	//   - It was SYNCHRONOUS, and `persistChats()` is called from a dozen places that
	//     cannot await. So the store keeps a MIRROR of its own contents in memory: a
	//     save merges against the mirror at once and reaches disk behind it.
	//   - It fired a `storage` event in the other tab. IndexedDB fires nothing, so a
	//     nonce is bumped in localStorage after every write — the trick DIAMONDS_KEY
	//     already plays for OPFS, where the value means nothing and the change is the
	//     whole message.
	//   - It was there before this version was. So the old key is still read, and what
	//     it holds is carried across the first time this store opens.
	var CHATS_DB      = 'daimond-chats';           // the IndexedDB database, per account
	var CHATS_STORE   = 'chats';
	var CHATS_REV     = 'daimond-chats-rev';       // the cross-tab nonce
	var CHATS_LEGACY  = 'daimond-chats-legacy';    // what localStorage held before the move

	var ChatStore = (function () {
		var db      = null;      // the open connection, or null when there is none
		var dbOpen  = null;      // the name it is open on, to notice an account switch
		var mirror  = [];        // what the store holds, as of the last read or write
		var disk    = {};        // id → stamp of what we believe is actually written
		var writing = null;      // the write in flight, so two saves queue rather than race
		var queued  = null;      // the next list to write, replacing any earlier one
		var usable  = false;     // the store opened and was read at least once

		function dbName() {
			var ns = (window.DaimondAccounts && DaimondAccounts.opfsNs()) || '';
			return ns ? CHATS_DB + '-' + ns : CHATS_DB;
		}

		function open(name) {
			return new Promise(function (resolve, reject) {
				if (!window.indexedDB) { reject(new Error('this browser offers no IndexedDB')); return; }
				var req = indexedDB.open(name, 1);
				req.onupgradeneeded = function () {
					var d = req.result;
					if (!d.objectStoreNames.contains(CHATS_STORE)) {
						d.createObjectStore(CHATS_STORE, { keyPath: 'id' });
					}
				};
				req.onsuccess = function () { resolve(req.result); };
				req.onerror   = function () { reject(req.error || new Error('the store would not open')); };
				req.onblocked = function () { reject(new Error('another tab is holding the store open')); };
			});
		}

		/// The open connection, reopening when the account has changed under us.
		async function conn() {
			var want = dbName();
			if (db && dbOpen === want) return db;
			if (db) { try { db.close(); } catch (e) { /* already */ } db = null; disk = {}; }
			db = await open(want);
			dbOpen = want;
			db.onclose        = function () { db = null; dbOpen = null; };
			db.onversionchange = function () { try { db.close(); } catch (e) { /* already */ } db = null; dbOpen = null; };
			return db;
		}

		function tx(mode) {
			var t = db.transaction(CHATS_STORE, mode);
			return { store: t.objectStore(CHATS_STORE), done: new Promise(function (res, rej) {
				t.oncomplete = res;
				t.onerror    = function () { rej(t.error || new Error('the write failed')); };
				t.onabort    = function () { rej(t.error || new Error('the write was aborted')); };
			}) };
		}

		async function readAll() {
			await conn();
			var t = tx('readonly'), rows = [];
			await new Promise(function (res, rej) {
				var cur = t.store.openCursor();
				cur.onsuccess = function () { var c = cur.result; if (c) { rows.push(c.value); c.continue(); } else res(); };
				cur.onerror   = function () { rej(cur.error || new Error('the store would not be read')); };
			});
			await t.done;
			return rows;
		}

		/// A stamp that changes whenever a chat's stored bytes would, without
		/// stringifying a megabyte of transcript to find out. `updatedAt` moves on every
		/// mutation (`touchChat` is called before every save) and the message count moves
		/// when another tab's turns are unioned in.
		function stampOf(c) {
			return String(c.updatedAt || 0) + ':' + ((c.messages || []).length)
				+ ':' + ((c.session && c.session.msgs) ? c.session.msgs.length : 0);
		}

		async function write(list) {
			try {
				// Only when there is no usable connection. This is the difference
				// between the new store and the old one: `localStorage.setItem` was
				// synchronous, so a reload a heartbeat after a turn always saw the
				// turn. `db.transaction()` and `store.put()` are synchronous too — it
				// is only the RESULT that is async — and IndexedDB commits a
				// transaction whose requests are already queued even if the page goes
				// away in the next moment. So with the connection kept warm from boot,
				// the puts below are queued inside the same tick as `save()`, and the
				// only await is for the answer. An `await conn()` in front of them
				// would push them to the next microtask and hand back the very gap
				// this store was moved to avoid.
				if (!db || dbOpen !== dbName()) {
					await conn();
				}
				var t = tx('readwrite');
				var seen = {};
				list.forEach(function (c) {
					if (!c || !c.id) return;
					seen[c.id] = true;
					// Only what has moved. A `put` of every chat on every turn rewrites the
					// whole store for one appended message.
					if (disk[c.id] !== stampOf(c)) t.store.put(c);
				});
				// A DELETION IS A TOMBSTONE, NOT AN ABSENCE.
				//
				// This used to delete every id the list did not mention, which made a
				// short list — for any reason, from any caller — a permanent, silent
				// deletion of the chats it happened to leave out. Everything else in
				// this app deletes on a tombstone and nothing else, and there was one
				// reason for the asymmetry: with `localStorage.setItem` of the whole
				// array there was no gap in which a list could be short. IndexedDB is
				// asynchronous, so there is.
				//
				// `removeChat` is the only path that removes a chat, and it writes the
				// tombstone before it saves, so every intended deletion still happens
				// here. What no longer happens is the unintended one. A chat left out
				// by accident stays on disk and comes back on the next read, which is
				// the right way round: a resurrected chat is a nuisance, a deleted one
				// is gone. The same rule that came out of the tag-loss incident.
				var tombs = loadTombs();
				var kept = {};
				Object.keys(disk).forEach(function (id) {
					if (seen[id]) return;
					if (tombs[id]) { t.store['delete'](id); return; }
					kept[id] = disk[id];
				});
				var keptN = Object.keys(kept).length;
				if (keptN) {
					try { console.warn('Daimond: ' + keptN + ' chat(s) were left out of a save without a tombstone; kept on disk.'); }
					catch (e) { /* no console */ }
				}
				await t.done;
				// A kept row is still IN the database, so it stays in the store's
				// account of the database. Rebuilding `disk` from the list alone
				// would forget it, and the tombstoned deletion that arrived a
				// moment later would then find nothing to delete -- a chat the user
				// deleted on purpose, left behind for the next read to resurrect.
				var next = {};
				list.forEach(function (c) { if (c && c.id) next[c.id] = stampOf(c); });
				Object.keys(kept).forEach(function (id) { if (!next[id]) next[id] = kept[id]; });
				disk = next;
				usable = true;
				storageAlarmClear();          // a save landed: whatever it said is over
				return true;
			} catch (e) {
				storageAlarm(storeReason(e));
				return false;
			}
		}

		function schedule(list) {
			if (writing) { queued = list; return; }
			writing = write(list).then(function () {
				writing = null;
				if (queued) { var next = queued; queued = null; schedule(next); }
			});
		}

		/// What localStorage still holds under the old key, or under the archive the
		/// move leaves behind. Read on every boot, not once behind a flag: a user who
		/// restores an old backup, or opens a profile this build has never run in, has
		/// chats sitting there and no reason to know it.
		function legacy() {
			var a = readJson(CHATS_KEY, []);
			if (Array.isArray(a) && a.length) return a;
			var b = readJson(CHATS_LEGACY, []);
			return Array.isArray(b) ? b : [];
		}

		/// Union `incoming` into `base` by id, taking the fresher of any two and
		/// unioning their transcripts — the same rule the cross-tab and cross-device
		/// merges use, because migration is the same problem.
		function mergeInto(base, incoming) {
			var byId = {};
			(base || []).forEach(function (c) { if (c && c.id) byId[c.id] = c; });
			(incoming || []).forEach(function (c) {
				if (!c || !c.id) return;
				var st = byId[c.id];
				if (!st) { byId[c.id] = c; return; }
				var merged = slimChat((c.updatedAt || 0) > (st.updatedAt || 0) ? c : st);
				merged.messages = slimMessages(mergeMessages(st.messages, c.messages));
				if (!merged.session && st.session) merged.session = st.session;
				byId[c.id] = merged;
			});
			return Object.keys(byId).map(function (id) { return byId[id]; });
		}

		return {
			/// Open the store, read it, and take in anything the old localStorage key
			/// still holds. Never throws: a browser that will not give us IndexedDB —
			/// a locked-down private window — falls back to reading localStorage and
			/// SAYS so, rather than opening on an empty rail as though there had never
			/// been anything there.
			boot: async function () {
				try {
					mirror = await readAll();
					mirror.forEach(function (c) { if (c && c.id) disk[c.id] = stampOf(c); });
					usable = true;
					storageAlarmClear();
				} catch (e) {
					usable = false;
					mirror = legacy();
					storageAlarm(storeReason(e));
					return mirror.slice();
				}
				var old = readJson(CHATS_KEY, []);
				if (Array.isArray(old) && old.length) {
					mirror = mergeInto(mirror, old);
					if (await write(mirror)) {
						// Only once it is safely in the new store. Kept rather than deleted —
						// a copy of the transcript in a place a person can still read is worth
						// the bytes it already occupied — but MOVED, so nothing unions it back
						// in on the next boot and resurrects a chat deleted after the move.
						try { localStorage.setItem(CHATS_LEGACY, JSON.stringify(old)); }
						catch (e2) { /* no room for the archive; the store above has it */ }
						try { localStorage.removeItem(CHATS_KEY); } catch (e3) { /* best effort */ }
					}
				}
				return mirror.slice();
			},
			/// What the store holds, without a read. This is what makes `persistChats()`
			/// able to stay synchronous.
			stored: function () { return mirror.slice(); },
			/// Re-read from disk — after another tab has written.
			///
			/// Never PAST a write of our own. The mirror runs ahead of the disk from
			/// the moment `save()` returns until the transaction behind it lands, and
			/// a read taken in that window hands back the contents from before the
			/// save and installs them as the mirror. `applyChats` does exactly that —
			/// save the merge, then refresh — so a merged parcel could be read back
			/// out again a moment after it went in. It healed itself on the next
			/// push, at the cost of a flicker and a wasted round; waiting for the
			/// write is cheaper than either. Bounded, so a tab saving continuously
			/// cannot hold a read off for ever.
			refresh: async function () {
				for (var i = 0; i < 8 && (writing || queued); i++) {
					try { await writing; } catch (e) { break; }
				}
				try {
					mirror = await readAll();
					disk = {};
					mirror.forEach(function (c) { if (c && c.id) disk[c.id] = stampOf(c); });
					usable = true;
				} catch (e) { storageAlarm(storeReason(e)); }
				return mirror.slice();
			},
			/// Store `list`, which is already the merged truth. Returns at once; the
			/// mirror is current now and the disk write happens behind it.
			save: function (list) {
				mirror = list;
				bumpChats();
				schedule(list);
			},
			/// Try the last write again, for the button on the alarm.
			retry: function () { schedule(mirror); },
			/// Is the real store working? False means this session is running on the
			/// fallback and the alarm is up.
			usable: function () { return usable; },
			/// Forget everything — an account being forgotten takes its chats with it.
			wipe: async function () {
				mirror = []; disk = {};
				try { await conn(); var t = tx('readwrite'); t.store.clear(); await t.done; }
				catch (e) { /* nothing to clear */ }
			},
		};
	})();

	/// Say what went wrong with the store in words the user can act on.
	function storeReason(e) {
		var name = (e && e.name) || '';
		var msg  = String((e && e.message) || e || 'unknown');
		if (name === 'QuotaExceededError' || /quota/i.test(msg)) {
			return t('store.full') === 'store.full'
				? 'there is no room left in this browser’s storage for this site'
				: t('store.full');
		}
		return msg;
	}

	/// Tell the other tabs that the chats moved. IndexedDB fires no cross-tab event,
	/// so this nonce in localStorage is the signal; the value is never read.
	function bumpChats() {
		try { localStorage.setItem(CHATS_REV, String(Date.now()) + '.' + Math.random()); }
		catch (e) { /* private mode: this tab is the only one that can see them anyway */ }
	}

	// ── When saving stops working, say so ──────────────────────
	//
	// Not a toast. A toast fades, and the whole failure of the code this replaces was
	// that it said nothing at the moment the user could still act. This stays up until
	// a save lands, and it carries the one move that rescues the work now — writing it
	// to a file.
	var storageAlarmEl = null;
	var storageAlarmWhy = '';

	/// Raise the standing warning that conversations are not being saved.
	function storageAlarm(why) {
		storageAlarmWhy = String(why || '');
		try { console.error('Daimond: conversations are not being saved — ' + storageAlarmWhy); } catch (e) {}
		if (storageAlarmEl) {
			var line = storageAlarmEl.querySelector('.storage-alarm-why');
			if (line) line.textContent = storageAlarmWhy;
			return;
		}
		var box = document.createElement('div');
		box.className = 'storage-alarm';
		box.setAttribute('role', 'alert');
		box.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:10000;'
			+ 'max-width:min(720px,92vw);padding:12px 16px;border-radius:10px;font-size:var(--fs-sm);'
			+ 'background:var(--warn-bg);color:var(--text-primary);border:1px solid var(--danger);'
			+ 'box-shadow:0 6px 20px rgba(0,0,0,.32);display:flex;gap:12px;align-items:flex-start;';
		var text = document.createElement('div');
		text.style.cssText = 'flex:1 1 auto;';
		var head = document.createElement('strong');
		head.textContent = tOr('store.alarm', 'Your conversations are not being saved.');
		var why = document.createElement('div');
		why.className = 'storage-alarm-why';
		why.style.cssText = 'margin-top:4px;opacity:.85;';
		why.textContent = storageAlarmWhy;
		var advice = document.createElement('div');
		advice.style.cssText = 'margin-top:4px;';
		advice.textContent = tOr('store.alarm_advice',
			'Everything on screen is still here, but a reload would lose it. Download a copy now.');
		text.appendChild(head); text.appendChild(why); text.appendChild(advice);
		var acts = document.createElement('div');
		acts.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex:0 0 auto;';
		var dl = document.createElement('button');
		dl.type = 'button';
		dl.className = 'btn-secondary';
		dl.textContent = tOr('store.alarm_download', 'Download a copy');
		dl.addEventListener('click', function () { downloadChatsNow(); });
		var again = document.createElement('button');
		again.type = 'button';
		again.className = 'btn-secondary';
		again.textContent = tOr('store.alarm_retry', 'Try again');
		again.addEventListener('click', function () { ChatStore.retry(); });
		acts.appendChild(dl); acts.appendChild(again);
		box.appendChild(text); box.appendChild(acts);
		document.body.appendChild(box);
		storageAlarmEl = box;
	}

	/// Take the warning down, because a save has landed.
	function storageAlarmClear() {
		if (!storageAlarmEl) return;
		if (storageAlarmEl.parentNode) storageAlarmEl.parentNode.removeChild(storageAlarmEl);
		storageAlarmEl = null;
		storageAlarmWhy = '';
	}

	/// Write every chat this tab holds to a file, right now.
	///
	/// The escape hatch behind the alarm: whatever is wrong with the store, the
	/// transcript is still in memory, and a file on the user's disk is somewhere the
	/// browser cannot take it back. Deliberately the same shape as a backup export, so
	/// `doImport` reads it.
	function downloadChatsNow() {
		var out = {
			format:   'daimond-backup',
			version:  1,
			exported: new Date().toISOString(),
			partial:  true,        // chats only; no workspace files, no Diamonds
			chats:    chats.map(slimChat),
		};
		var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
		var a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'daimond-chats-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
		a.click();
		setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
	}

	// How much of a tool result is kept in the STORED transcript.
	//
	// The model had the whole thing while the turn ran, and still does: its own copy of
	// the conversation is stored separately and whole (see `captureSession`). What is
	// kept here is the human's scrollback, and eighty kilobytes of a directory listing
	// is not scrollback — it is the reason a day's work stopped being saved.
	var TOOL_KEEP = 2048;

	/// Group a number with commas, for a count of characters in a marker.
	function withCommas(n) {
		return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	}

	/// Shorten the tool results in a transcript on its way into storage, saying in the
	/// record itself how much went. Idempotent: a message already shortened carries
	/// `elided` and is passed through untouched.
	function slimMessages(msgs) {
		return (msgs || []).map(function (m) {
			if (!m || m.role !== 'tool_log' || m.elided) return m;
			var body = String(m.content == null ? '' : m.content);
			if (body.length <= TOOL_KEEP) return m;
			var gone = body.length - TOOL_KEEP;
			var out = {};
			for (var k in m) { if (Object.prototype.hasOwnProperty.call(m, k)) out[k] = m[k]; }
			out.content = body.slice(0, TOOL_KEEP) + '\n\n[' + withCommas(gone)
				+ ' more characters of this result were not saved. The model was given the whole thing.]';
			out.elided = gone;
			return out;
		});
	}

	function persistChats() {
		try {
			var stored = ChatStore.stored();
			var byId = {};
			stored.forEach(function (c) { if (c && c.id) byId[c.id] = c; });
			// This tab's version of a chat wins only if it is at least as
			// fresh as the stored one — so a tab that has been idle cannot
			// roll back a turn another tab has just taken.
			chats.forEach(function (c) {
				var st = byId[c.id];
				if (!st) { byId[c.id] = slimChat(c); return; }
				// The transcript is append-only: union it. Everything else is a
				// scalar, so the fresher tab's value wins.
				var merged = slimChat((c.updatedAt || 0) >= (st.updatedAt || 0) ? c : st);
				merged.messages = slimMessages(mergeMessages(st.messages, c.messages));
				// The model's own conversation is this device's state, not something two
				// tabs union: keep whichever copy has one when the other does not, or a
				// save from an idle tab would drop the tool history the working tab holds.
				if (!merged.session && st.session) merged.session = st.session;
				byId[c.id] = merged;
			});
			var tombs = loadTombs();
			Object.keys(tombs).forEach(function (id) { delete byId[id]; });
			ChatStore.save(Object.keys(byId).map(function (id) { return byId[id]; }));
			// Same reason as bumpDiamonds: renaming or deleting a chat, or folding
			// one into a Diamond, is not a turn and does not hide the tab, so
			// nothing else would ever schedule the push that carries it.
			nudgeSync();
		} catch (e) {
			// The merge itself broke, which is not the store's fault and is not
			// something to swallow either: from here on nothing is being written.
			storageAlarm(String((e && e.message) || e));
		}
	}
	function hydrateChat(c) {
		return { id: c.id, name: c.name, app: null, messages: stampMessages(Array.isArray(c.messages) ? c.messages : []), model: c.model,
			provider: c.provider || '',
			// Which Diamond's daimon this conversation belongs to, or '' for an
			// ordinary chat. It has to come back: a record that lost it becomes a chat
			// with a tile in the rail, and `daimonChat` — finding nothing bound to the
			// Diamond — starts the daimon over with an empty conversation beside it.
			diamondId: c.diamondId || '',
			// A chat stored before workers had a model of their own carries neither, and reads
			// as "the chat's own model" everywhere. See `slimChat`.
			workerModel: c.workerModel || '', workerProvider: c.workerProvider || '',
			status: c.status || 'active',
			promptTokens: c.promptTokens || 0, completionTokens: c.completionTokens || 0,
			cachedTokens: c.cachedTokens || 0, costUsd: c.costUsd || 0,
			prevPrompt: c.prevPrompt || 0, prevCompletion: c.prevCompletion || 0, lastPrompt: c.lastPrompt || 0,
			prevCached: c.prevCached || 0, prevCost: c.prevCost || 0,
			session: c.session || null,
			updatedAt: c.updatedAt || 0, foldedInto: c.foldedInto || null };
	}
	/// Open the store and hand back what it holds, hydrated.
	async function loadChats() {
		var tombs = loadTombs();
		var stored = await ChatStore.boot();
		return stored
			.filter(function (c) { return c && c.id && !tombs[c.id]; })
			.map(hydrateChat);
	}
	/// The stored chats as the store last saw them, with no read and no wait. For the
	/// places that want a list of names rather than a conversation.
	function storedChats() {
		var tombs = loadTombs();
		return ChatStore.stored().filter(function (c) { return c && c.id && !tombs[c.id]; });
	}
	/// Stamp a chat as touched, so the merge above can order concurrent writes.
	function touchChat(c) { if (c) c.updatedAt = Date.now(); }

	// Another tab changed the chats: adopt anything new without disturbing a
	// turn in flight here. Chats this tab already holds keep their live
	// DaimondApp; chats it has never seen are added; chats deleted elsewhere go.
	async function onChatsChangedElsewhere() {
		var tombs = loadTombs();
		var stored = (await ChatStore.refresh()).filter(function (c) { return c && c.id && !tombs[c.id]; });
		var mine = {};
		chats.forEach(function (c) { mine[c.id] = c; });
		var merged = stored.map(function (s) {
			var c = mine[s.id];
			if (!c) return hydrateChat(s);
			// Update a chat we already hold IN PLACE. Replacing the object would
			// orphan `current` and any turn in flight that closed over it — the
			// turn would then look like it belonged to a deleted chat and its
			// reply would be thrown away.
			c.messages = mergeMessages(s.messages, c.messages);
			if ((s.updatedAt || 0) > (c.updatedAt || 0) && !c._generating) {
				c.name             = s.name;
				c.model            = s.model;
				c.status           = s.status || 'active';
				c.promptTokens     = s.promptTokens || 0;
				c.completionTokens = s.completionTokens || 0;
				c.cachedTokens     = s.cachedTokens || 0;
				c.costUsd          = s.costUsd || 0;
				c.prevPrompt       = s.prevPrompt || 0;
				c.prevCompletion   = s.prevCompletion || 0;
				c.prevCached       = s.prevCached || 0;
				c.prevCost         = s.prevCost || 0;
				c.lastPrompt       = s.lastPrompt || 0;
				c.foldedInto       = s.foldedInto || c.foldedInto || null;
				c.updatedAt        = s.updatedAt || 0;
				// The model's conversation only ever moves forward, so a stored copy is
				// taken when there is one and never traded for nothing: a tab that saved
				// without one would otherwise wipe the tool history held here.
				if (s.session) c.session = s.session;
			}
			return c;
		});
		// A chat created here but not yet saved must not be dropped.
		chats.forEach(function (c) {
			if (!merged.some(function (m) { return m.id === c.id; }) && !tombs[c.id]) merged.push(c);
		});
		chats = merged;
		if (current && !current._generating && chats.indexOf(current) !== -1) {
			renderHistory(current.messages);      // another tab may have added turns
		}
		if (current && !chats.some(function (c) { return c.id === current.id; })) {
			current = null;
			sessionNameEl.textContent = t('chat.no_chat');
			renderEmptyState();
			chatInputBar.style.display = 'none';
			updateMeters();
		}
		renderSessionList();
	}
	// Another tab changed the Diamonds. Re-read the rail from the store, which
	// is the truth; a turn in flight here is not disturbed, because nothing but
	// the list is touched. A Diamond deleted elsewhere while it was the one on
	// screen leaves the Centre showing something that no longer exists, so the
	// Centre goes back to the empty state rather than to a ghost.
	async function onDiamondsChangedElsewhere() {
		var had = currentDiamond && currentDiamond.id;
		await loadDiamonds();
		if (!had) return;
		var still = diamonds.find(function (x) { return x.id === had; });
		if (still) {
			// Renamed or re-cut elsewhere: adopt the fresh record without
			// disturbing what is on screen.
			currentDiamond = still;
			if (centreMode === 'focus') {
				sessionNameEl.textContent = still.name;
				aiMeter.textContent = 'crystal v' + (still.crystal_version || 0)
					+ (still.updated ? ' · ' + relTime(still.updated) : '');
			}
			return;
		}
		// Gone. A steer or fold running against it has nothing left to write to.
		currentDiamond = null;
		signalDiamondChanged();
		delete pendingFolds[had];
		sessionNameEl.textContent = t('chat.no_chat');
		showCentre('chat');
		renderEmptyState();
	}

	/// Tell the sync engine that a stored thing moved, so it pushes without
	/// waiting for a turn to end or the tab to be hidden.
	///
	/// The two funnels below are where every mutation already arrives, so this is
	/// wired there rather than at the two dozen UI handlers that reach them: one
	/// call site for every Diamond change, one for every chat change.
	///
	/// Suppressed while collectSync() is packing the parcel. It calls
	/// persistChats() on the way past, and a nudge from inside the push would
	/// re-arm the debounce on every push, turning it into a timer poll that never
	/// stops.
	var packingParcel = false;
	function nudgeSync() {
		if (packingParcel) return;
		try { if (window.DaimondSync && DaimondSync.nudge) DaimondSync.nudge(); }
		catch (e) { /* sync is not up on this device */ }
	}

	/// Say that the Diamonds changed, to whatever other tabs are open, and to the
	/// other DEVICES. Called after every mutation; the value is a nonce and is
	/// never read back.
	///
	/// The nudge is here because a Diamond is worked on without turns: renaming,
	/// tagging, linking and hand-editing a crystal all end here and none of them
	/// ends a turn, so before this they scheduled no push and the change stayed
	/// on the machine that made it.
	function bumpDiamonds() {
		try { localStorage.setItem(DIAMONDS_KEY, String(Date.now()) + '.' + Math.random()); }
		catch (e) { /* private mode: this tab is the only one that can see them anyway */ }
		nudgeSync();
	}

	window.addEventListener('storage', function (e) {
		// CHATS_REV is the nonce IndexedDB cannot fire for itself; CHATS_KEY is still
		// watched because a tab running the previous build writes it directly.
		if (e.key === CHATS_REV || e.key === CHATS_KEY || e.key === TOMBS_KEY) onChatsChangedElsewhere();
		else if (e.key === DIAMONDS_KEY) onDiamondsChangedElsewhere();
	});

	// ── Cross-device sync (sync.js is the transport; this is the state) ──
	// Sync across devices is the same problem as sync across tabs: union the
	// transcripts, take the freshest scalar of each chat, and honour tombstones.
	// So the network path reuses exactly the merge above rather than inventing a
	// second one. sync.js encrypts what collectSync() returns, ships the
	// ciphertext through the gateway's opaque mailbox, and feeds what comes back
	// to applySync().

	/// Union an incoming tombstone map into a stored one, keeping the later time
	/// for any id in both and pruning anything past its TTL.
	function mergeTombMap(key, incoming) {
		var t = readJson(key, {}), now = Date.now();
		if (incoming && typeof incoming === 'object') {
			Object.keys(incoming).forEach(function (id) {
				var ts = incoming[id];
				if (typeof ts === 'number' && (!t[id] || ts > t[id])) t[id] = ts;
			});
		}
		var out = {};
		Object.keys(t).forEach(function (id) { if (now - t[id] < TOMB_TTL) out[id] = t[id]; });
		try { localStorage.setItem(key, JSON.stringify(out)); } catch (e) { /* best effort */ }
		return out;
	}

	/// A stored tombstone map, with anything past its TTL pruned. The generic form
	/// of loadTombs/loadMsgTombs/loadDiamondTombs above, written once so a module
	/// that keeps its own map — models.js, mail.js — does not have to keep its own
	/// TTL with it.
	function loadTombMap(key) {
		var t = readJson(key, {}), now = Date.now(), out = {};
		Object.keys(t).forEach(function (id) { if (now - t[id] < TOMB_TTL) out[id] = t[id]; });
		return out;
	}

	/// Record that something was deleted on purpose, so the other device deletes
	/// it too rather than handing it back on the next pull.
	function tombstoneIn(key, id) {
		if (!key || !id) return;
		var t = loadTombMap(key);
		t[id] = Date.now();
		try { localStorage.setItem(key, JSON.stringify(t)); } catch (e) { /* best effort */ }
	}

	// ── The devices that sync this account ────────────────────
	// Pairing moves the identity WHOLE, so a second device ends up holding the
	// SAME keypair: the gateway cannot tell the two apart, and a redeemed pairing
	// leaves no record on the server to read back. So there is no list to fetch.
	// What can still be told is built the way everything else in this file is —
	// each device writes its own line, the parcel carries the lines, the merge
	// unions them — and it answers exactly one question: is this account on more
	// than one device? Not which paired with which, and not a way to sign one
	// out: under one shared keypair nothing could enforce a revocation, and a
	// button that pretended otherwise would be worse than no button.
	//
	// A line carries TWO names. What the device says about itself ("Chromium on
	// Linux") is all it can know unaided, and two of a user's machines say it
	// identically; what its owner calls it ("Kitchen laptop") is the useful one,
	// and only the user can supply it. The chosen one is kept separately, with a
	// stamp of its own, so a rename typed on ANY device reaches the rest — see
	// mergeDevices for why it cannot ride on `seen`.
	var DEVICE_ID_KEY  = 'daimond-device-id';	// this device's own id
	var DEVICES_KEY    = 'daimond-devices';		// the merged roster: id -> { name, label, created, namedAt, seen }
	// A name typed into the pairing dialog on a device that has no roster line
	// yet. pairing.js writes it; the first collect here takes it and clears it.
	var DEVICE_PAIR_LABEL_KEY = 'daimond-pair-label';
	// How stale this device's own `seen` may get before a collect refreshes it.
	// NOT every collect: sync skips a push whose parcel stringifies to what it
	// last sent, and a stamp that moved every time would defeat that skip and put
	// the whole parcel back on the wire for nothing. Five minutes is finer than
	// anything the roster shows, so the reading loses nothing by it.
	var SEEN_REFRESH_MS   = 5 * 60 * 1000;
	var DEVICE_ROSTER_MAX = 24;			// keeps the parcel, and the list, bounded.
	var DEVICE_NAME_MAX   = 64;			// a name, not a paragraph. Both names share it.
	var DEVICE_ID_RE      = /^[0-9a-f]{16}$/;

	/// A millisecond stamp, or 0 when there is none to be had.
	///
	/// NOT `n | 0`: an epoch-ms value is far past 32 bits, and the truncation is
	/// inconsistently wrong — a fresher stamp can come out smaller than an older
	/// one, so the freshest side loses. (models.js keeps its own copy of this for
	/// the same reason; each file here is its own closure.)
	function ms(v) {
		return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : 0;
	}

	/// Held only when storage refuses to keep an id (private mode). Without it,
	/// every call would mint another and the roster would fill with devices that
	/// existed for one function call.
	var _deviceIdFallback = null;

	/// This device's id: 16 hex characters from the CSPRNG, minted on first use
	/// and kept beside the account's other keys — so it is per ACCOUNT as well as
	/// per device, and two accounts at one browser are never linkable by it.
	/// Nothing about the machine is measured; two devices are told apart because
	/// each wrote down a different random number.
	///
	/// Sixteen characters can never be an array index (a sixteen-digit number
	/// without a leading zero is past 2^32), so a map keyed by these keeps its
	/// insertion order through JSON.stringify — which is what the sorted, stable
	/// serialisation below rests on.
	function deviceId() {
		var id = null;
		try { id = localStorage.getItem(DEVICE_ID_KEY); } catch (e) { id = null; }
		if (typeof id === 'string' && DEVICE_ID_RE.test(id)) return id;
		if (_deviceIdFallback) return _deviceIdFallback;
		var b = new Uint8Array(8);
		crypto.getRandomValues(b);
		id = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
		try { localStorage.setItem(DEVICE_ID_KEY, id); } catch (e) { /* private mode */ }
		var back = null;
		try { back = localStorage.getItem(DEVICE_ID_KEY); } catch (e) { back = null; }
		if (back !== id) _deviceIdFallback = id;
		return id;
	}

	/// The browser a user-agent string names, for anything that does not offer
	/// `navigator.userAgentData`. Order matters: every one of these also says
	/// "Safari" or "Chrome" somewhere, so the specific tokens are tested first.
	function uaBrand(ua) {
		if (/\bFirefox\//.test(ua))        return 'Firefox';
		if (/\bEdg\//.test(ua))            return 'Edge';
		if (/\bOPR\//.test(ua))            return 'Opera';
		if (/\bSamsungBrowser\//.test(ua)) return 'Samsung Internet';
		if (/\b(Chrome|CriOS)\//.test(ua)) return 'Chrome';
		if (/\bSafari\//.test(ua))         return 'Safari';
		return '';
	}

	/// The platform a user-agent string names. Coarse on purpose: "Windows", not
	/// a version — the roster answers "which of my devices", not "what is
	/// installed on it".
	function uaPlatform(ua) {
		if (/\bAndroid\b/.test(ua))            return 'Android';
		if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return 'iOS';
		if (/\bCrOS\b/.test(ua))               return 'ChromeOS';
		if (/\bMac OS X\b/.test(ua))           return 'macOS';
		if (/\bWindows\b/.test(ua))            return 'Windows';
		if (/\bLinux\b/.test(ua))              return 'Linux';
		return '';
	}

	/// How this device describes itself, worked out once when it first joins the
	/// roster. Only what the browser volunteers about itself is used — brands and
	/// platform, nothing measured, nothing that would narrow this browser down to
	/// this browser. An environment that says nothing recognisable is simply
	/// "This device", which is still an honest answer to "how many".
	function deviceName() {
		var brand = '', plat = '';
		try {
			var d = navigator.userAgentData;
			if (d) {
				plat = String(d.platform || '');
				var b = d.brands || [];
				for (var i = 0; i < b.length; i++) {
					var n = b[i] && b[i].brand;
					if (!n || /not.*brand/i.test(n)) continue;	// the deliberate nonsense entry
					// A named browser beats the engine it is built on.
					if (!brand || /^chromium$/i.test(brand)) brand = String(n);
				}
			}
		} catch (e) { /* fall through to the user-agent string */ }
		var ua = '';
		try { ua = String(navigator.userAgent || ''); } catch (e) { ua = ''; }
		if (!brand) brand = uaBrand(ua);
		if (!plat)  plat  = uaPlatform(ua);
		if (brand && plat) return t('devices.on_platform', { brand: brand, platform: plat });
		return brand || plat || t('devices.unknown');
	}

	/// One roster line, cleaned: two names that fit, and stamps that are stamps.
	///
	/// A FIXED field order, for the same reason saveDevices sorts the ids: the
	/// same line has to serialise to the same bytes every time, or sync stops
	/// skipping the push it should skip.
	///
	/// A line written before names existed has neither field, and decodes to an
	/// empty label stamped 0. Zero is the right absence here — unlike the `touched`
	/// stamp elsewhere, where it meant "never touched" and lost real edits —
	/// because no name at all SHOULD lose to any name anybody has actually given.
	function deviceEntry(d) {
		return {
			name:    String((d && d.name) || '').slice(0, DEVICE_NAME_MAX),
			label:   String((d && d.label) || '').slice(0, DEVICE_NAME_MAX),
			created: ms(d && d.created),
			namedAt: ms(d && d.namedAt),
			seen:    ms(d && d.seen),
		};
	}

	/// What a device is called on screen: the user's name for it when they have
	/// given one, otherwise what the device says about itself.
	function deviceShownName(d) {
		return (d && d.label) || (d && d.name) || t('devices.unknown');
	}

	/// The name typed into the pairing dialog on this device, taken and cleared.
	///
	/// Redeeming a pairing code happens BEFORE this device has a roster line: the
	/// line is minted on the first collect, which is after the reload the dialog
	/// performs. So pairing.js parks the name here and the mint consumes it —
	/// once, so it names this device and no other.
	function pendingDeviceLabel() {
		var v = null;
		try { v = localStorage.getItem(DEVICE_PAIR_LABEL_KEY); } catch (e) { return ''; }
		if (v == null) return '';
		try { localStorage.removeItem(DEVICE_PAIR_LABEL_KEY); } catch (e) { /* best effort */ }
		return String(v).trim().slice(0, DEVICE_NAME_MAX);
	}

	/// The stored roster, with anything that is not a device dropped.
	function loadDevices() {
		var raw = readJson(DEVICES_KEY, {}), out = {};
		if (!raw || typeof raw !== 'object') return out;
		Object.keys(raw).forEach(function (id) {
			if (DEVICE_ID_RE.test(id) && raw[id] && typeof raw[id] === 'object') out[id] = deviceEntry(raw[id]);
		});
		return out;
	}

	/// Write the roster back, and return what was written.
	///
	/// SORTED by id, and each line built in a fixed field order, so the same set
	/// of devices is always the same bytes. Anything whose serialisation followed
	/// enumeration order would look like a change on every collect and push for
	/// ever — the same trap the provider export above is written to avoid.
	function saveDevices(reg) {
		var ids = Object.keys(reg);
		if (ids.length > DEVICE_ROSTER_MAX) {
			// Bounded, dropping the least recently seen — but never this device,
			// which is the one line the user is certain to be looking for.
			var self = deviceId();
			var keep = ids.slice().sort(function (a, b) { return ms(reg[b].seen) - ms(reg[a].seen); })
				.slice(0, DEVICE_ROSTER_MAX);
			if (reg[self] && keep.indexOf(self) === -1) keep[keep.length - 1] = self;
			ids = keep;
		}
		var out = {};
		ids.sort().forEach(function (id) { out[id] = deviceEntry(reg[id]); });
		try { localStorage.setItem(DEVICES_KEY, JSON.stringify(out)); } catch (e) { /* best effort */ }
		return out;
	}

	/// This device's own line, refreshed. Its `seen` only moves once it is stale
	/// enough to be worth moving (see SEEN_REFRESH_MS), so a collect that changes
	/// nothing else changes nothing here either.
	function touchSelfDevice(reg) {
		var id = deviceId(), now = Date.now(), me = reg[id];
		if (!me) me = reg[id] = { name: deviceName(), label: '', created: now, namedAt: 0, seen: now };
		else if (now - ms(me.seen) >= SEEN_REFRESH_MS) me.seen = now;
		// A name chosen while pairing, on a device that had no line to put it on
		// until this moment.
		//
		// Only when it CHANGES the name. `pendingDeviceLabel` consumes the parked value with a
		// `removeItem` whose failure is swallowed, so a browser that declines the delete hands
		// the same name back on every collect -- and stamping `namedAt` with the clock each time
		// makes this device's parcel differ from the one it last sent, for ever. `push` then
		// never takes its skip branch, every push wakes the other device, whose merge sees a
		// strictly newer `namedAt` and pushes back. That is an endless loop between two devices
		// that are both behaving correctly, and it can only start on a device that has just
		// redeemed a pairing code -- which is where it was reported from.
		var chosen = pendingDeviceLabel();
		if (chosen && chosen !== me.label) { me.label = chosen; me.namedAt = now; }
		return reg;
	}

	/// Give a device the name its owner calls it by, or clear it back to what the
	/// device says about itself. Returns the roster as written, or null for an id
	/// that is not on it.
	///
	/// Any device on the roster, not only this one. A user standing at their
	/// laptop is exactly who wants to say which of these lines is the phone, and
	/// the stamp is what carries that back to the phone.
	function renameDevice(id, label) {
		var reg = loadDevices(), d = reg[id];
		if (!d) return null;
		var next = String(label == null ? '' : label).trim().slice(0, DEVICE_NAME_MAX);
		if (next === d.label) return reg;			// nothing changed, nothing to push
		d.label   = next;
		d.namedAt = Date.now();
		return saveDevices(reg);
	}

	/// The roster as it goes into the parcel, and as the drawer draws it: this
	/// device's line refreshed, the rest exactly as they were merged.
	function collectDevices() {
		return saveDevices(touchSelfDevice(loadDevices()));
	}

	/// Merge a roster that arrived from another device.
	///
	/// Per line, the freshest `seen` wins, STRICTLY — equal stamps keep what is
	/// here, so a device that has not moved is never rewritten and the parcel does
	/// not change for nothing. A line neither side has seen simply unions in, and
	/// a parcel with no roster at all is a device that predates this: nothing
	/// happens, in either direction.
	///
	/// The user's name for a device is merged SEPARATELY, on its own `namedAt`
	/// stamp, and it cannot be otherwise. Each device refreshes only its OWN
	/// `seen`, so a name typed on the laptop for the phone sits on a line the
	/// laptop never touches again: on the next pull the phone's own fresher line
	/// would win and the name would vanish, on the very device it was meant for.
	/// With its own stamp the two decisions cross in either direction — the phone
	/// keeps saying where it has been, the laptop keeps saying what it is called.
	function mergeDevices(incoming) {
		if (!incoming || typeof incoming !== 'object') return;
		var reg = loadDevices(), changed = false;
		Object.keys(incoming).forEach(function (id) {
			if (!DEVICE_ID_RE.test(id) || !incoming[id] || typeof incoming[id] !== 'object') return;
			var r = deviceEntry(incoming[id]), mine = reg[id];
			if (!mine) { reg[id] = r; changed = true; return; }
			// Strictly newer, like `seen`, and for the same reason: an equal stamp
			// keeps what is here rather than rewriting a line for nothing.
			var namedWins = r.namedAt > mine.namedAt;
			if (!namedWins) { r.label = mine.label; r.namedAt = mine.namedAt; }
			if (r.seen > mine.seen) {
				// A device is created once, so the EARLIER stamp is the true one: a
				// copy that reached us later cannot have been created later.
				if (mine.created && (!r.created || mine.created < r.created)) r.created = mine.created;
				reg[id] = r;
				changed = true;
			} else if (namedWins) {
				// The line itself is older than ours, but the naming of it is not.
				mine.label   = r.label;
				mine.namedAt = r.namedAt;
				changed = true;
			}
		});
		if (changed) saveDevices(reg);
	}

	// ── Workspace files (the other half of "the work") ─────────
	// Chats have a natural merge (union transcripts); files do not, so they use
	// a 3-way compare against a stored per-file hash BASELINE — the state as of
	// the last successful sync. That lets a pull tell "the other device changed
	// this" from "I changed this" without any modification time (file_list gives
	// none), and it NEVER clobbers: a file changed on both sides differently is
	// preserved as a `.synced` sidecar rather than overwritten. Only the OPFS
	// sandbox is synced — a real folder is the user's own disk, device-specific.
	var SYNC_FILE_MAX        = 128 * 1024;		// carry inline in the blob up to here.
	var SYNC_FILES_TOTAL_MAX = 8 * 1024 * 1024;	// budget for all inline file bytes.
	// The ceiling on one offloaded file. The pipeline streams now -- a slice is
	// read, sealed, sent and dropped -- so this is no longer a memory limit but a
	// manifest one: every chunk becomes an entry inside the sync blob, and the
	// blob has its own ceiling. The chunk size grows with the file to keep that
	// entry count in hand (chunks.js chunkSizeFor).
	var SYNC_CHUNK_FILE_MAX  = 1024 * 1024 * 1024;
	var SYNC_CHUNK_TOTAL_MAX = 4 * 1024 * 1024 * 1024;	// budget for all offloaded bytes.
	// What the WHOLE parcel has to stay under, and it is not the 32 MiB the gateway
	// advertises. `max_bytes` on /api/sync is 32 MiB and refuses an oversized push
	// with a 413 that sync.js draws on the chip -- but the parcel never gets that
	// far. The gateway caps an HTTP BODY at 16 MiB (gateway/src/app_main.rs,
	// MAX_BODY_BYTES), the reader rejects a larger one before dispatch, and
	// `handle_connection` logs the read error and closes: no status line, no 413,
	// nothing for the chip to show. The browser sees a dropped connection and takes
	// sync.js's network-error arm, which is silent by design because a flaky network
	// is not news. Base64 costs a third on top of the parcel, so 16 MiB of body is
	// about 12 MiB of parcel, and the 413 arm is unreachable behind that.
	//
	// 10 MiB, so the Diamonds are budgeted with room for the rest of the parcel --
	// every transcript, the mailboxes, the ledger, the model tables and the chunk
	// manifest, none of which is capped here.
	var SYNC_PARCEL_MAX      = 10 * 1024 * 1024;
	// And the most the Diamonds may take of it, so a store that grows without limit
	// cannot crowd out the workspace files it shares the parcel with.
	var SYNC_DIAMONDS_MAX    = 6 * 1024 * 1024;
	var SYNC_FILEBASE_KEY    = 'daimond-sync-filebase';
	// The cloud index has its own fork point, kept apart from the inline one so
	// the two 3-way merges can never read each other's hashes.
	var SYNC_CLOUDBASE_KEY   = 'daimond-cloud-base';
	var SYNC_SKIP_ROOT_DIRS  = { diamonds: 1 };		// Daimond's own per-diamond store.

	/// A cheap, non-cryptographic content fingerprint — enough to tell whether a
	/// file changed, which is all the 3-way merge asks of it.
	function fileHash(s) {
		var h = 5381;
		for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
		return (h >>> 0).toString(36) + ':' + s.length;
	}

	/// Parse one `file_list` listing (a local copy of the Files panel's parser,
	/// which is closed over there).
	function parseSyncListing(text) {
		var out = [];
		if (/ is empty\.$/.test(String(text).trim())) return out;
		String(text).split('\n').forEach(function (line) {
			if (!line) return;
			if (line.charAt(line.length - 1) === '/') { out.push({ name: line.slice(0, -1), dir: true, size: 0 }); return; }
			// A file the listing marks as in cloud storage is not on this device,
			// so there is nothing here to read or to re-offload.
			var c = /^(.*?)\s{2}\((\d+) bytes, in cloud storage\)$/.exec(line);
			if (c) { out.push({ name: c[1], dir: false, size: parseInt(c[2], 10), cloud: true }); return; }
			var m = /^(.*?)\s{2}\((\d+) bytes\)$/.exec(line);
			if (m) out.push({ name: m[1], dir: false, size: parseInt(m[2], 10) });
			else out.push({ name: line, dir: false, size: 0 });
		});
		return out;
	}

	/// Whether workspace files can be synced now: tools are up and the active
	/// root is the OPFS sandbox, not a real on-disk folder.
	function filesSyncable() {
		if (!window.DaimondTools) return false;
		try { if (Files && Files.folder && Files.folder()) return false; } catch (e) { return false; }
		return true;
	}

	/// Walk the OPFS workspace and read every syncable text file into
	/// `{ path: content }`, skipping dotfiles, Daimond's own `diamonds` store, binary
	/// files, and anything over the per-file or total budget.
	///
	/// `complete` says whether the walk actually enumerated the whole workspace.
	/// It is the ONLY thing that entitles the far side to read an absent path as a
	/// deletion, so it is false the moment anything is missed for any reason —
	/// folder mode, no tools, a directory that would not list, a file skipped for
	/// budget. An incomplete census still carries the files it did find; it simply
	/// carries no news about the ones it did not.
	async function collectFiles() {
		// `bytes` is what the inline files came to, so the Diamonds can be budgeted
		// against what is left of the parcel rather than against a number chosen in
		// ignorance of them.
		var out = { files: {}, large: {}, skipped: 0, oversize: [], bytes: 0, complete: false };
		if (!filesSyncable()) return out;
		var app; try { app = tools(); } catch (e) { return out; }
		out.complete = true;						// until something below is missed.
		var total = 0, largeTotal = 0, todo = [''], guard = 0;
		while (todo.length && guard++ < 5000) {
			var dir = todo.shift();
			var res;
			try { res = await app.run_tool('file_list', JSON.stringify({ path: dir || '.' })); }
			catch (e) { out.complete = false; continue; }
			if (typeof res !== 'string' || /^\s*Error\b/i.test(res)) { out.complete = false; continue; }
			var entries = parseSyncListing(res);
			for (var i = 0; i < entries.length; i++) {
				var e = entries[i];
				if (e.name.charAt(0) === '.') continue;					// dotfiles/dirs
				var full = dir ? (dir + '/' + e.name) : e.name;
				if (e.dir) { if (!(!dir && SYNC_SKIP_ROOT_DIRS[e.name])) todo.push(full); continue; }
				// In cloud storage but not on this device: already safe, and there
				// are no local bytes to collect.
				if (e.cloud) continue;
				if (e.size > SYNC_CHUNK_FILE_MAX) { out.oversize.push(full); out.skipped++; continue; }

				// Anything past the inline ceiling is offloaded, and is NOT read here:
				// the offload streams it from disk a chunk at a time, so a file far
				// larger than this tab could hold still travels. Reading it in order to
				// decide was the old ceiling, and it was the wrong one.
				if (e.size > SYNC_FILE_MAX) {
					if (largeTotal + e.size > SYNC_CHUNK_TOTAL_MAX) { out.skipped++; continue; }
					out.large[full] = { size: e.size };
					largeTotal += e.size;
					continue;
				}

				// Small enough to ride inside the blob -- if it is text. Read the bytes
				// and find out, rather than going through file_read, which lossily
				// converts anything that is not.
				var f = null;
				try { f = await DaimondCloud.fileAt(full); } catch (e2) { f = null; }
				if (!f) { out.skipped++; continue; }
				var raw;
				try { raw = new Uint8Array(await f.arrayBuffer()); } catch (e2) { out.skipped++; continue; }
				var content = null;
				try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
				catch (e2) { content = null; }						// not text at all.
				if (content !== null && content.indexOf('\u0000') !== -1) content = null;	// binary tell.
				if (content === null) {
					// A small binary file cannot ride in the blob, so it is offloaded like
					// a large one. Being small is no longer the same question as being
					// carryable.
					if (largeTotal + e.size > SYNC_CHUNK_TOTAL_MAX) { out.skipped++; continue; }
					out.large[full] = { size: e.size };
					largeTotal += e.size;
					continue;
				}
				if (total + content.length > SYNC_FILES_TOTAL_MAX) { out.skipped++; continue; }
				out.files[full] = content; total += content.length;
			}
		}
		// Anything skipped -- for budget, for size, for an unreadable byte -- and a
		// walk that hit the loop guard with directories still queued, are both a
		// census that did not see everything.
		if (out.skipped || todo.length) out.complete = false;
		out.bytes = total;
		return out;
	}

	/// Write a workspace file, best-effort (a failure drops that one file, not
	/// the whole sync).
	async function writeSyncFile(app, path, content) {
		try { await app.run_tool('file_write', JSON.stringify({ path: path, content: content })); return true; }
		catch (e) { return false; }
	}

	/// Delete a workspace file, best-effort. Used to propagate a deletion made on
	/// another device.
	async function deleteSyncFile(app, path) {
		try { await app.run_tool('file_delete', JSON.stringify({ path: path })); return true; }
		catch (e) { return false; }
	}

	/// Set the file baseline to the current local files: this is "what both
	/// devices agree on now", the fork point the next 3-way merge measures from.
	async function commitFileBaseline() {
		if (!filesSyncable()) return;
		var col = await collectFiles();
		var base = {};
		Object.keys(col.files).forEach(function (p) { base[p] = fileHash(col.files[p]); });
		try { localStorage.setItem(SYNC_FILEBASE_KEY, JSON.stringify(base)); } catch (e) { /* best effort */ }
		// The cloud index forked at the same moment, and its residency list is
		// only true once the push that carried it has landed.
		commitCloudBaseline();
		if (window.DaimondCloud) {
			try { await DaimondCloud.refreshPaths(); } catch (e) { /* best effort */ }
			// A push is the safe moment to free space: everything held is now
			// recorded in cloud storage, so anything evicted can be fetched back.
			try { await DaimondCloud.reclaim(false); } catch (e) { /* best effort */ }
		}
	}

	/// Merge pulled files into the workspace by a 3-way compare against the
	/// baseline. New remote files are written; a file changed on only one side
	/// takes that side; a file changed on BOTH, differently, keeps the local
	/// copy and lands the remote one beside it as `<path>.synced`, so nothing is
	/// ever silently overwritten.
	///
	/// `remoteComplete` is the sender's word that its census enumerated the whole
	/// workspace, and NOTHING is deleted without it. Every other store in this app
	/// deletes on a tombstone; files delete on absence, and absence has four
	/// innocent causes -- the sender had a real folder open, its tools were not up,
	/// a directory would not list, or a file was left out for budget. Each of those
	/// used to arrive as `files: {}` and read as "the user deleted everything",
	/// which is how a workspace was lost account-wide. A parcel that does not say
	/// its census was complete is no news, never a deletion; a device too old to
	/// say so is treated the same way.
	async function applyFiles(remoteFiles, remoteComplete) {
		if (!remoteFiles || typeof remoteFiles !== 'object' || !filesSyncable()) return;
		var app; try { app = tools(); } catch (e) { return; }
		var base  = readJson(SYNC_FILEBASE_KEY, {});
		var local = (await collectFiles()).files;
		// What this round establishes the two devices actually HOLD IN COMMON, path by path.
		// It is not "everything local", which is what the baseline used to be set to on the way
		// out of here -- see the commit below.
		var agreed = {}, gone = {};
		var paths = {};
		Object.keys(local).forEach(function (p) { paths[p] = 1; });
		Object.keys(remoteFiles).forEach(function (p) { paths[p] = 1; });
		for (var p in paths) {
			if (!Object.prototype.hasOwnProperty.call(paths, p)) continue;
			var l = local[p], r = remoteFiles[p];
			if (r == null) continue;								// only local has it: keep, it will push.
			if (l == null) { await writeSyncFile(app, p, r); agreed[p] = fileHash(r); continue; }	// only remote: adopt.
			var lh = fileHash(l), rh = fileHash(r);
			if (lh === rh) { agreed[p] = lh; continue; }			// identical: genuinely shared.
			var bh = base[p] || null;
			var localChanged  = (lh !== bh);
			var remoteChanged = (rh !== bh);
			if (remoteChanged && !localChanged) { await writeSyncFile(app, p, r); agreed[p] = rh; }
			else if (localChanged && !remoteChanged) { /* keep local; it will push. */ }
			else { await writeSyncFile(app, p + '.synced', r); }	// both diverged: preserve both.
		}
		// Deletions: a file both devices once agreed on (in the baseline) that the
		// remote no longer has was deleted there. Propagate it here ONLY if it is
		// unchanged locally since that fork — a local edit after the remote delete
		// keeps the file, because an edit must never be lost to a delete.
		if (remoteComplete === true) {
			for (var bp in base) {
				if (!Object.prototype.hasOwnProperty.call(base, bp)) continue;
				if (Object.prototype.hasOwnProperty.call(remoteFiles, bp)) continue;	// remote still has it.
				var lv = local[bp];
				if (lv == null) continue;							// already gone here.
				if (fileHash(lv) === base[bp]) { await deleteSyncFile(app, bp); gone[bp] = 1; }	// unchanged: honour the delete.
			}
		}
		// ONLY what was shared. This used to be `commitFileBaseline()`, which records every file
		// this device is holding -- including one created here and never yet sent anywhere. The
		// baseline means "the state both devices agreed on", and the deletion branch above reads
		// it as exactly that: a path in the baseline that a COMPLETE remote census does not carry
		// is treated as deleted there and removed here. So a file that had never left this device
		// was entered as agreed by the pull that carried no news of it, and the next complete
		// census from the other device deleted it. A file cannot be agreed until it has been sent,
		// and the moment it has is a successful push -- which is what `commitFileBaseline` is for
		// and where sync.js already calls it.
		await commitAgreedFiles(agreed, gone);
	}

	/// Fold what this round proved the two devices hold in common into the fork point, and drop
	/// what was deleted. Paths this device kept a newer copy of are deliberately absent: the
	/// other side has not seen them yet, and recording agreement early is what turned a pull into
	/// a delete.
	///
	/// # Arguments
	/// * `agreed` - Path to hash, for the paths both devices now hold identically.
	/// * `gone` - Paths the merge has just deleted here, which leave the fork point with them.
	function commitAgreedFiles(agreed, gone) {
		var base = readJson(SYNC_FILEBASE_KEY, {}), next = {};
		// Carry forward what was already agreed, minus anything the merge just deleted here --
		// leaving a deleted path in the fork point would put the same question to the next round.
		Object.keys(base).forEach(function (p) {
			if (!Object.prototype.hasOwnProperty.call(gone || {}, p)) next[p] = base[p];
		});
		Object.keys(agreed).forEach(function (p) { next[p] = agreed[p]; });
		try { localStorage.setItem(SYNC_FILEBASE_KEY, JSON.stringify(next)); }
		catch (e) { /* best effort */ }
	}

	/// The serialisable state to encrypt and push: every stored chat, both
	/// tombstone maps so a deletion travels as surely as a creation, and the
	/// workspace files. In-memory chats are flushed to storage first so a turn
	/// just finished is included. Async because reading the workspace is.
	/// Offload the large workspace files this device is holding, record their
	/// manifests in the cloud index, and return THE WHOLE INDEX — not merely
	/// what was found locally.
	///
	/// Returning the whole index is the point. The gateway sweeps every chunk
	/// the committed index does not name, so a device that reported only what it
	/// happened to be holding would delete every file resident elsewhere. The
	/// index is merged state; this adds to it and never narrows it.
	///
	/// Needs an unlocked identity (a chunk is sealed with its key) and the chunk
	/// module. Without either, nothing new is offloaded this round, but the
	/// index still travels intact.
	async function collectChunked(large) {
		if (!window.DaimondCloud) return {};
		if (!window.DaimondChunks || !DaimondCloud.available()) return DaimondCloud.index();
		for (var p in (large || {})) {
			if (!Object.prototype.hasOwnProperty.call(large, p)) continue;
			var f = null;
			try { f = await DaimondCloud.fileAt(p); } catch (e) { f = null; }
			if (!f) continue;						// vanished since the walk.
			// Offload streams the file and asks the gateway which of its pieces
			// are missing, so an unchanged file costs one `have` call and a read,
			// and a file whose chunks were swept is refilled rather than left
			// unfetchable with the index still promising it. The only thing worth
			// skipping outright is a file identical in length and untouched since
			// its own upload.
			var known = DaimondCloud.manifest(p);
			if (known && known.bytes === f.size && known.mtime === f.lastModified && known.key) continue;
			try {
				var mani = await DaimondChunks.offloadFile(p, f);
				await DaimondCloud.put(p, mani, mani.key);
			} catch (e) { /* offload failed: retry next sync, index unharmed */ }
		}
		return DaimondCloud.index();
	}

	/// Merge a pulled cloud index into the local one. Nothing is downloaded: a
	/// manifest is a reference, and adopting it costs no bytes.
	///
	/// This used to reconstruct every large file the device lacked, which meant
	/// the smallest device still had to hold the whole workspace — the ceiling
	/// the chunk store exists to lift. A file now stays in cloud storage until
	/// it is asked for, by the user or by the agent through `file_fetch`.
	/// # Arguments
	/// * `remoteChunked` - The other device's cloud index.
	/// * `base` - The fork point, READ BEFORE THIS ROUND MOVED IT. It must be an argument:
	///   `applyFiles` runs first in `applySync` and ends in `commitFileBaseline`, which rewrites
	///   the cloud baseline to whatever this device is holding right now. Reading the key here
	///   therefore compared local against itself, `localChanged` was false for every path, the
	///   remote won unconditionally, and `cloud.js`'s both-sides-diverged branch -- the one that
	///   preserves the loser as `.synced` -- could never run at all.
	async function applyChunked(remoteChunked, base) {
		if (!window.DaimondCloud || !filesSyncable()) return;
		DaimondCloud.merge(remoteChunked, base || {});
		await DaimondCloud.refreshPaths();
	}

	/// Set the cloud index's fork point to what it holds now, alongside the
	/// inline files' baseline, so the next merge can tell which side moved.
	function commitCloudBaseline() {
		if (!window.DaimondCloud) return;
		var ix = DaimondCloud.index(), base = {};
		Object.keys(ix).forEach(function (p) { base[p] = ix[p].hash; });
		try { localStorage.setItem(SYNC_CLOUDBASE_KEY, JSON.stringify(base)); } catch (e) { /* best effort */ }
	}

	// ── Diamonds across devices ────────────────────────────────
	// A Diamond is a DIRECTORY in OPFS, not a record, so it travels as one:
	// export_diamond packs every file under `diamonds/<id>/` and import_diamond
	// lays the lot back down. Nothing here knows what those files are called,
	// which is the point -- a per-Diamond file added later travels without this
	// having to learn about it.
	//
	// The merge is deliberately coarse. Chats union because a transcript is
	// append-only; a Diamond has no such structure, so the freshest copy wins
	// WHOLESALE. Two devices that edited the same Diamond between syncs lose the
	// older side entirely, links included, and that is accepted rather than
	// fixed: reconciling two crystals is a reduction, and a reduction is a model
	// turn, not a merge rule.
	//
	// Freshness is `touched`, NOT `updated`. `updated` means worked on and orders
	// the rail, so tagging deliberately leaves it alone -- and while the merge
	// read it, a tag-only change was invisible across devices, and the untagged
	// copy on the other device became strictly fresher the moment anything there
	// was renamed or edited, at which point it replaced the tagged one and the
	// tags were gone. `touched` moves on every change, including a tag, and
	// including a link. Two parts of a Diamond went that way, because a link was
	// stored in a sidecar inside the directory and stamped nothing either.
	//
	// Those two are also the only parts that can be put back together without a
	// model turn, and where the two copies are equally fresh they are: the tags
	// union, and so do the links. Everything else at an equal stamp is left as
	// it is, which is what "the merge does not choose" means.

	/// Every Diamond this device holds that fits, packed for the parcel: the id,
	/// both stamps, the whole directory, and which model it thinks with.
	///
	/// `{ list, left, complete }`. `left` names the Diamonds this parcel could not
	/// carry, so the caller can say so; `complete` is false when anything at all was
	/// missed, including a Diamond that would not export.
	///
	/// WHY THERE IS A BUDGET AT ALL. A Diamond carries its crystal, every version of
	/// it, its log and its sidecars, and the whole store rides in one array with
	/// nothing bounding it. Past the parcel ceiling the push does not fail loudly --
	/// see `SYNC_PARCEL_MAX` -- it fails as a dropped connection, and the account
	/// stops syncing ALTOGETHER: no transcripts, no files, no mail, and a chip that
	/// says nothing is wrong. Leaving out the Diamonds that do not fit costs the
	/// user the ones named in `left` and keeps everything else moving.
	///
	/// NOT A LOSS AT THE FAR END, AND NOT A SILENT ONE HERE. A Diamond is deleted on
	/// a tombstone and never on absence (see `applyDiamonds`), so one left out of a
	/// parcel is a Diamond that has not travelled YET, not one the other device is
	/// entitled to delete. `diamondsComplete` says so in the parcel, and the caller
	/// tells the user which ones stayed behind -- a census that quietly drops content
	/// is the defect `dev/verify_dataloss.mjs` exists about.
	///
	/// Freshest first, so what the user is working on is what travels when not all of
	/// it does; ties broken by id, because the parcel is compared byte-for-byte
	/// against the last one pushed and an order that depended on how the store
	/// enumerated would push for ever.
	///
	/// # Arguments
	/// * `budget` - The most exported bytes the Diamonds may take of this parcel.
	async function collectDiamonds(budget) {
		var out = { list: [], left: [], complete: true }, tombs = loadDiamondTombs(), held;
		try { held = JSON.parse(await diamondApp().list_diamonds()); }
		catch (e) { out.complete = false; return out; }   // no store to read: send nothing, delete nothing
		var models = diamondModels();
		// A Diamond deleted here is on its way out, not on its way over.
		held = held.filter(function (d) { return d && d.id && !tombs[d.id]; });
		held.sort(function (a, b) {
			return diamondStamp(b) - diamondStamp(a) || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0));
		});
		var used = 0;
		for (var i = 0; i < held.length; i++) {
			var d = held[i], data;
			try { data = await diamondApp().export_diamond(d.id); }
			catch (e) { out.complete = false; continue; }  // one unreadable Diamond must not hold up the rest
			// `continue`, not `break`: one enormous Diamond must not stop the small
			// fresh ones behind it from travelling.
			if (used + data.length > budget) {
				out.left.push({ id: d.id, name: d.name || d.id });
				out.complete = false;
				continue;
			}
			used += data.length;
			out.list.push({
				id:      d.id,
				updated: d.updated || 0,
				// A device that predates the second stamp sends none, and the
				// receiver falls back to `updated` — which is what `touched`
				// means on such a device anyway.
				touched: d.touched || d.updated || 0,
				model:   models[d.id] || null,
				data:    data,
			});
		}
		return out;
	}

	/// The Diamonds the last parcel could not carry, told once per set.
	///
	/// Said out loud rather than logged. What the user has to act on is one Diamond
	/// they can see the name of -- prune its versions, or delete it -- and a
	/// `console.warn` is not a place anyone looks. Deduplicated on the set, so a push
	/// every few seconds does not become a toast every few seconds; a set that
	/// changes, or one that empties and comes back, is news again.
	var _leftTold = null;
	function noteDiamondsLeft(left) {
		var sig = left.map(function (d) { return d.id; }).sort().join(',');
		if (sig === _leftTold) return;
		_leftTold = sig;
		if (!left.length) return;
		var names = left.slice(0, 3).map(function (d) { return d.name; });
		if (left.length > names.length) names.push('…');
		toast(tn('sync.diamonds_left', left.length, { names: names.join(', ') }), true);
	}

	/// How fresh a Diamond is, for the merge alone.
	///
	/// `touched` moves on every change; `updated` moves only when the Diamond is
	/// WORKED on, and orders the rail. A parcel from a device that predates the
	/// second stamp carries only the first, and on such a device every change
	/// moved it -- so it stands in exactly, and old parcels merge as they always
	/// did.
	function diamondStamp(d) {
		return (d && (d.touched || d.updated)) || 0;
	}

	/// The tags a Diamond export is carrying, read out of the packed metadata.
	///
	/// The pack was written by another device, so every step is defensive: a
	/// merge must not be the thing that throws. `.red/` is where the store lived
	/// before the rename, and a device that has not been opened since then still
	/// sends that path.
	function packTags(data) {
		try {
			var files = (JSON.parse(data) || {}).files || {};
			var meta  = JSON.parse(files['.daimond/meta.json'] || files['.red/meta.json'] || '{}');
			return Array.isArray(meta.tags)
				? meta.tags.filter(function (x) { return typeof x === 'string' && x; })
				: [];
		} catch (e) { return []; }
	}

	/// Give a Diamond the tags of BOTH copies when the two are equally fresh.
	/// True when something was written.
	///
	/// Equal stamps mean neither side is the newer one, so a wholesale replace
	/// would be a coin toss and is refused above. Tags are the one part of a
	/// Diamond that can be reconciled without a model turn -- they are a set of
	/// short strings, and the union of two sets is not a judgement about either.
	/// This is what lets two stores that ALREADY diverged (tagged here, not
	/// there, and stamped identically because the tagging never moved a stamp)
	/// come back together, rather than needing the user to re-tag by hand.
	///
	/// It settles. Writing the union moves `touched`, so this side becomes the
	/// fresher one and the union travels back on the next push, where it is taken
	/// wholesale -- an import lays the stamps down as they arrived, so nothing
	/// bounces back again. And once the two sets agree, the union adds nothing,
	/// nothing is written and no stamp moves. At most two rounds, then quiet.
	///
	/// The store owns normalisation and caps the list at eight, so a union that
	/// overflows is trimmed there; the extra write that costs is harmless, and
	/// the round after it agrees.
	async function unionDiamondTags(app, r, mine) {
		var here  = Array.isArray(mine && mine.tags) ? mine.tags : [];
		var there = packTags(r.data);
		if (!there.length) return false;
		var union = here.slice();
		for (var i = 0; i < there.length; i++) {
			if (union.indexOf(there[i]) === -1) union.push(there[i]);
		}
		if (union.length === here.length) return false;		// the other side had nothing new
		try { await app.set_tags(r.id, JSON.stringify(union)); }
		catch (e) { return false; }							// it goes on the next pull
		return true;
	}

	/// The link sidecar a Diamond export is carrying, as its stored text.
	///
	/// Read as defensively as `packTags` and for the same reason, `.red/` legacy
	/// path included: the pack was written by another device, and a merge must
	/// not be the thing that throws.
	function packLinks(data) {
		try {
			var files = (JSON.parse(data) || {}).files || {};
			var text  = files['.daimond/links.jsonl'] || files['.red/links.jsonl'] || '';
			return typeof text === 'string' ? text : '';
		} catch (e) { return ''; }
	}

	/// Give a Diamond the links of BOTH copies when the two are equally fresh.
	/// True when something was written.
	///
	/// The links are the other half of what the single stamp lost. A link lives
	/// in a sidecar inside the Diamond's own directory, so it travelled on the
	/// wholesale copy and nothing else -- and asserting one moved no stamp, so
	/// two stores could hold different links at identical stamps indefinitely,
	/// and the first thing either of them stamped took the other's links with
	/// it. Tags and links are the two parts of a Diamond that reconcile without
	/// a model turn: both are sets of records, and a union of two sets is not a
	/// judgement about either.
	///
	/// Identity is the link's own id, which the store owns and which travels
	/// with the record. Two devices that each drew "the same" line drew two
	/// links, and both survive -- the same acceptance the wholesale replace
	/// makes when it keeps whichever copy it kept.
	///
	/// It settles for the reason `unionDiamondTags` does: the store writes only
	/// when it has something to add, writing moves `touched`, this side becomes
	/// the fresher one, and the union is taken wholesale on the way back. Once
	/// the two sidecars agree nothing is written and no stamp moves.
	///
	/// It cannot undo a deletion. Removing a link stamps the Diamond, so the copy
	/// that lost the link is the fresher one and is taken wholesale, and this
	/// runs only where neither copy is fresher. What it can repair is therefore
	/// only the divergence the missing stamp left behind, which is what it is
	/// for.
	async function unionDiamondLinks(app, r) {
		var there = packLinks(r.data);
		if (!there.trim()) return false;
		try { return (await app.union_links(r.id, there)) === true; }
		catch (e) { return false; }							// it goes on the next pull
	}

	/// Merge the pulled Diamonds into the store. Tombstones first, so a deletion
	/// on either device wins; then any Diamond this device lacks, or holds an
	/// older copy of, is replaced wholesale; and where the two copies are equally
	/// fresh, their tags and their links are unioned rather than one side's
	/// being dropped.
	async function applyDiamonds(remote) {
		var tombs = mergeTombMap(DIAMOND_TOMBS_KEY, remote.diamondTombs);
		var incoming = Array.isArray(remote.diamonds) ? remote.diamonds : [];
		var deletions = Object.keys(tombs);
		// A v1 parcel carries neither section. Nothing to import, and no
		// tombstone that did not already come from this device.
		if (!incoming.length && !deletions.length) return;
		var app = diamondApp(), local = {};
		try {
			JSON.parse(await app.list_diamonds()).forEach(function (d) { if (d && d.id) local[d.id] = d; });
		} catch (e) { return; }
		var changed = false;
		for (var j = 0; j < deletions.length; j++) {
			var dead = deletions[j];
			if (!local[dead]) continue;
			try { await app.delete_diamond(dead); delete local[dead]; changed = true; }
			catch (e) { /* it goes on the next pull */ }
		}
		for (var i = 0; i < incoming.length; i++) {
			var r = incoming[i];
			if (!r || !r.id || !r.data || tombs[r.id]) continue;
			var mine = local[r.id];
			// STRICTLY newer: equal stamps keep what is here, so a Diamond that
			// has not moved is not rewritten on every pull.
			if (mine && !(diamondStamp(r) > diamondStamp(mine))) {
				// Neither copy is newer. Nothing is replaced -- but where the
				// two disagree about the TAGS or the LINKS, both sides can have
				// them all. Both unions run: one answering false says only that
				// it had nothing to add, not that the other has nothing.
				if (diamondStamp(r) === diamondStamp(mine)) {
					var tagged = await unionDiamondTags(app, r, mine);
					var linked = await unionDiamondLinks(app, r);
					if (tagged || linked) changed = true;
				}
				continue;
			}
			try { await app.import_diamond(r.data); changed = true; }
			catch (e) { continue; }
			// Best effort: the model may be one this device has no key for, and
			// the Diamond then shows as unable to run, which is already a state
			// the rail draws.
			if (r.model && r.model.model) setDiamondModel(r.id, r.model);
		}
		if (!changed) return;
		bumpDiamonds();                            // tell the other TABS
		await onDiamondsChangedElsewhere();        // and this one: same reconciliation
		signalLinksChanged();                      // links ride with their Diamond, so the graph moved
	}

	async function collectSync() {
		// persistChats() nudges the sync engine, and this IS the sync engine
		// asking for the parcel: without the flag every push would arm the next
		// one and the debounce would become a poll that never stopped.
		packingParcel = true;
		try { persistChats(); }
		finally { packingParcel = false; }
		var fileCol = await collectFiles();
		var chunked = await collectChunked(fileCol.large);
		// What is left of the parcel after the inline files, and never more than the
		// Diamonds' own share of it. Taking the files off first is deliberate: they
		// have already been read and counted, and a budget that ignored them would
		// let the two sections agree to overrun the ceiling between them.
		var dCol = await collectDiamonds(
			Math.max(0, Math.min(SYNC_DIAMONDS_MAX, SYNC_PARCEL_MAX - fileCol.bytes)));
		noteDiamondsLeft(dCol.left);
		// v2 adds `diamonds` and `diamondTombs`. The version is informational:
		// every section is read by name and a missing one is a no-op, so a v1
		// device and a v2 device sync happily in both directions -- the v1 side
		// ignores what it does not know, and the v2 side sees no Diamonds rather
		// than an error.
		return {
			v:            2,
			// Without the model's own conversation: it holds one provider's call ids,
			// it is this device's copy of what its agent was told, and it would roughly
			// double a parcel that is already every transcript the account has. The
			// other device rebuilds it from the transcript it does receive.
			chats:        storedChats().map(function (c) {
				var out = slimChat(c);
				out.session = null;
				return out;
			}),
			tombs:        readJson(TOMBS_KEY, {}),
			msgTombs:     readJson(MSG_TOMBS_KEY, {}),
			files:        fileCol.files,
			// Whether `files` above is the WHOLE workspace. Only a complete census
			// entitles the receiver to delete by absence; see applyFiles.
			filesComplete: fileCol.complete === true,
			chunked:      chunked,
			diamonds:     dCol.list,
			// Whether `diamonds` above is the WHOLE store. Nothing reads it today and
			// nothing needs to: a Diamond is deleted on a tombstone, so absence is not
			// news and cannot be mistaken for one. It is carried because the day
			// somebody makes Diamonds delete by absence -- as files once did -- this is
			// the flag that stops a budgeted parcel reading as a mass deletion, and the
			// receiver that has to check it will only exist if the sender said it.
			diamondsComplete: dCol.complete === true,
			diamondTombs: readJson(DIAMOND_TOMBS_KEY, {}),
			// The providers, their model lists and their SEALED keys. Deterministic
			// by construction -- models.js sorts every id, every model list and every
			// rate table -- which is what the push-skip comparison requires: anything
			// whose serialisation followed enumeration order would push for ever.
			models:       window.DaimondModels ? DaimondModels.exportSync() : null,
			// The mailboxes, with their WRAPPED passwords. Same trust model as the
			// sealed provider keys above: both devices hold one identity, so what
			// opens here opens there, and the parcel is sealed over the top of it
			// again before it leaves. What does NOT travel is the per-folder UID
			// state -- it is rebuilt per device in a sync or two and would only
			// give the merge a conflict to have.
			mail:         (window.DaimondMail && DaimondMail.exportSync) ? DaimondMail.exportSync() : null,
			// Which devices sync this account. Deterministic by construction — the
			// ids are sorted and each line has a fixed field order — and this
			// device's own stamp only moves when it is stale, so the parcel is the
			// same bytes between real changes and the push skip still holds.
			devices:      collectDevices(),
			// What the account has spent, turn by turn.
			//
			// The provider keys and their credit bases already travel, so without
			// this the two devices held the same "you put $40 on this key" and
			// subtracted different spend from it: each knew only its own turns, and
			// so each showed a different figure for the same key on the same day.
			// A ledger merges by union (see `mergeLedgers`), which is what lets both
			// arrive at the one number.
			//
			// Passed through the merge with nothing, which sorts it and drops any
			// duplicate: the parcel is compared byte-for-byte against the last one
			// pushed, so an order that depended on how storage enumerated would push
			// for ever.
			ledger:       mergeLedgers(readJson('daimond-ledger', []), []),
		};
	}

	/// Merge the chats out of a pulled parcel. Tombstones union first so a
	/// deletion on either device wins; then remote chats merge into stored chats
	/// by the same freshest-wins, union-the-transcript rule the cross-tab path
	/// uses; then the in-memory array and the UI are reconciled without
	/// disturbing a turn in flight.
	function applyChats(remote) {
		var tombs = mergeTombMap(TOMBS_KEY, remote.tombs);
		mergeTombMap(MSG_TOMBS_KEY, remote.msgTombs);
		var byId = {};
		var stored = ChatStore.stored();
		(Array.isArray(stored) ? stored : []).forEach(function (c) { if (c && c.id) byId[c.id] = c; });
		(Array.isArray(remote.chats) ? remote.chats : []).forEach(function (r) {
			if (!r || !r.id) return;
			var st = byId[r.id];
			if (!st) { byId[r.id] = r; return; }
			var merged = slimChat((r.updatedAt || 0) >= (st.updatedAt || 0) ? r : st);
			merged.messages = slimMessages(mergeMessages(st.messages, r.messages));
			// A parcel carries no session (collectSync strips it), so the freshest-wins
			// rule above would trade this device's model memory for the remote's nothing.
			if (!merged.session && st.session) merged.session = st.session;
			byId[r.id] = merged;
		});
		Object.keys(tombs).forEach(function (id) { delete byId[id]; });
		ChatStore.save(Object.keys(byId).map(function (id) { return byId[id]; }));
		onChatsChangedElsewhere();
	}

	/// Merge a pulled remote state into local storage, then refresh the live
	/// view in place. Chats, Diamonds, workspace files, the chunk store, the
	/// providers and the mailboxes, each by its own rule.
	///
	/// EVERY section is applied on its own, and nothing here throws. A parcel is
	/// another device's work — a version behind, a version ahead, or half
	/// written when it was packed — so one part of it that cannot be read must
	/// cost only itself. The chats used to run outside any guard at the top,
	/// which meant a transcript that was not a list took the whole merge with
	/// it: Diamonds, files, providers and mail were never reached, and the pull
	/// that called this logged one `console.debug` line, hidden in DevTools
	/// unless Verbose is on. Two real devices went a week without converging on
	/// exactly that.
	///
	/// Returns `{ failed: [section, …] }`, so the caller can say the merge did
	/// not finish rather than push its own state over what it could not read.
	async function applySync(remote) {
		var failed = [];
		if (!remote || typeof remote !== 'object') return { failed: ['parcel'] };
		/// Run one section, and NOTE a failure rather than let it out.
		async function section(name, fn) {
			try { await fn(); }
			catch (e) {
				failed.push(name);
				// Loud on purpose: a merge that silently did half its work is the
				// bug this whole function is shaped around.
				try { console.warn('[sync] merge failed in section "' + name + '"', e); } catch (e2) {}
			}
		}
		// The roster first: it is pure localStorage, and doing it here means a
		// Diamond or a file failing below never costs the user the answer to "how
		// many devices". A parcel without a given field is a no-op throughout.
		await section('devices',  function () { mergeDevices(remote.devices); });
		// Read before any section runs: `applyFiles` commits a new fork point on its way
		// out, so a later reader gets this round's own state rather than the one both
		// devices last agreed on.
		var cloudBase = readJson(SYNC_CLOUDBASE_KEY, {});
		await section('chats',    function () { applyChats(remote); });
		await section('diamonds', function () { return applyDiamonds(remote); });
		await section('files',    function () { return applyFiles(remote.files, remote.filesComplete === true); });
		// The large files held in the chunk store, reconstructed on demand.
		await section('chunked',  function () { return applyChunked(remote.chunked, cloudBase); });
		// The providers, their model lists and their sealed keys. A parcel without
		// the field is a device that predates it, so a v1 parcel still applies.
		await section('models',   function () {
			if (window.DaimondModels && DaimondModels.applySync) return DaimondModels.applySync(remote.models);
		});
		// What the other device spent. UNION, never replacement: an entry is a turn
		// that really happened and was really paid for, so a merge that dropped one
		// would take money out of the account's history — and each device is the
		// only witness to its own turns.
		await section('ledger',   function () {
			if (!Array.isArray(remote.ledger) || !remote.ledger.length) return;
			var merged = mergeLedgers(readJson('daimond-ledger', []), remote.ledger);
			localStorage.setItem('daimond-ledger', JSON.stringify(merged));
			// The meters are showing a total that just changed.
			try { updateSpend(); } catch (e) { /* nothing is drawn yet */ }
		});
		// The mailboxes. A second device that holds the account holds the
		// entitlement too, so an account that arrives here is an account that can
		// actually be read; and one that arrives at a device WITHOUT the
		// entitlement degrades exactly as an unentitled account already does —
		// the panel shows its pitch and the gateway refuses the sync.
		await section('mail',     function () {
			if (window.DaimondMail && DaimondMail.applySync) return DaimondMail.applySync(remote.mail);
		});
		// If the Workspace panel is open, show what just landed — including any
		// file that arrived as a cloud reference rather than as bytes. Drawing is
		// not merging: this one is not counted as a failed section, because a
		// panel that did not repaint has cost the parcel nothing.
		try {
			if (window.DaimondPanels && DaimondPanels.isOpen && DaimondPanels.isOpen('work')) {
				if (Files.refresh) Files.refresh();
				if (Files.refreshResidency) Files.refreshResidency();
			}
		} catch (e) {}
		return { failed: failed };
	}

	var seq = 1;

	// Auto-incrementing chat label (Chat-0001, Chat-0002, …), persisted so the
	// numbering survives a reload.
	var chatCounter = parseInt(localStorage.getItem('daimond-chat-counter') || '0', 10) || 0;

	/// The highest number already worn by a name of the form `<Stem>-NNNN`.
	///
	/// The counter is stored PER DEVICE and the things it names are shared across
	/// every device on the account. So a chat made on the other machine arrives
	/// here without ever advancing this counter, and the next one made here takes
	/// a name that is already in use -- two Chat-0002 in the same rail. The same
	/// gap opens on a backup import, which restores the chats and not the counter.
	///
	/// The counter therefore is not the answer, only a floor: whatever number is
	/// actually in use wins over it. That is self-healing rather than another
	/// thing to keep in step, and it costs one pass over a list already in memory.
	function highestNumbered(names, stem) {
		var re = new RegExp('^' + stem + '-(\\d+)$');
		var top = 0;
		(names || []).forEach(function (n) {
			var m = re.exec(String(n || '').trim());
			if (m) top = Math.max(top, parseInt(m[1], 10) || 0);
		});
		return top;
	}

	function nextChatLabel() {
		var used = 0;
		try {
			// The store's own list, not a read: naming a chat cannot wait on a disk
			// round trip, and the mirror is what the store last wrote or read anyway.
			used = highestNumbered(storedChats().map(function (c) { return c.name; }), 'Chat');
		} catch (e) { /* no store yet: the counter stands alone */ }
		chatCounter = Math.max(chatCounter, used) + 1;
		localStorage.setItem('daimond-chat-counter', '' + chatCounter);
		return 'Chat-' + ('000' + chatCounter).slice(-4);
	}

	// Two localStorage keys have been renamed twice, following the noun: focus ->
	// facet -> diamond. A user who has been running Daimond since before either
	// rename still holds an older name, and a straight read of the current one
	// would silently lose their Diamond numbering and every per-Diamond model
	// choice — so the old keys are moved across once, before anything reads them.
	// Both older generations are listed rather than chained, so a workspace that
	// skipped a rename entirely still arrives. Never clobbers: a key already
	// present at the new name wins, and the old one is simply dropped.
	(function migrateOldKeys() {
		var moved = [
			['daimond-facet-counter', 'daimond-diamond-counter'],
			['daimond-facet-models',  'daimond-diamond-models'],
			['daimond-focus-counter', 'daimond-diamond-counter'],
			['daimond-focus-models',  'daimond-diamond-models'],
		];
		for (var i = 0; i < moved.length; i++) {
			var was = moved[i][0], now = moved[i][1];
			try {
				var old = localStorage.getItem(was);
				if (old === null) continue;                       // nothing to move
				if (localStorage.getItem(now) === null) localStorage.setItem(now, old);
				localStorage.removeItem(was);
			} catch (e) { /* private mode or quota: the defaults still work */ }
		}
	})();

	// Diamonds get the same auto-incrementing default name as chats, so creating
	// one needs no typing at all — the name is pre-filled and editable.
	var diamondCounter = parseInt(localStorage.getItem('daimond-diamond-counter') || '0', 10) || 0;
	/// The name the next Diamond would take. Only a peek: cancelling the dialog
	/// must not burn a number, or a user who changes their mind twice finds
	/// their first Diamond is called Diamond-0003.
	function peekDiamondLabel() {
		return 'Diamond-' + ('000' + (nextDiamondNumber())).slice(-4);
	}
	/// Commit the number, once a Diamond really exists.
	function takeDiamondLabel() {
		diamondCounter = nextDiamondNumber();
		localStorage.setItem('daimond-diamond-counter', '' + diamondCounter);
	}
	/// The number the next Diamond would take. Diamonds sync and this counter does
	/// not, so the same collision the chats had (see `nextChatLabel`) applies here:
	/// a Diamond made on the other machine never advances this device's counter.
	/// The list is already in memory, so the check is a pass over `diamonds`.
	function nextDiamondNumber() {
		return Math.max(diamondCounter, highestNumbered(
			(diamonds || []).map(function (d) { return d.name; }), 'Diamond')) + 1;
	}

	// Short, readable model name for a tile chip (drops the provider path).
	function shortModel(m) { return m ? String(m).split('/').pop() : 'default'; }

	// ── Masked secret inputs ───────────────────────────────────
	// Secrets (the API key, the passphrase) are held in plain *text* inputs
	// masked by JS rather than `type="password"`, so no browser or password
	// manager offers to save them (the password-save popup, and the "username"
	// it scavenges from a nearby text field, both need a real password field).
	// The true value lives on `el._real`; the displayed value is bullets. The
	// input handler diffs the change so typing, pasting, backspace, mid-string
	// edits and select-all-replace all preserve the underlying value.
	var BULLET = '•';
	function installSecretMask(el, initial) {
		if (!el || el._secretMasked) return;
		el._secretMasked = true;
		el.setAttribute('autocomplete', 'off');
		el.setAttribute('data-1p-ignore', '');
		el.setAttribute('data-lpignore', 'true');
		el.setAttribute('spellcheck', 'false');
		el._real = initial || '';
		el._revealed = false;
		el.value = new Array(el._real.length + 1).join(BULLET);
		el.addEventListener('input', function () {
			// Revealed: the field shows the real text, so it IS the value.
			if (el._revealed) { el._real = el.value; return; }
			var old = el._real;
			var cur = el.value;
			// Common leading run of bullets (unchanged prefix).
			var p = 0;
			while (p < old.length && p < cur.length && cur.charAt(p) === BULLET) p++;
			// Common trailing run of bullets (unchanged suffix).
			var s = 0;
			while (s < (old.length - p) && s < (cur.length - p) && cur.charAt(cur.length - 1 - s) === BULLET) s++;
			var inserted = cur.slice(p, cur.length - s);      // the freshly typed/pasted text
			el._real = old.slice(0, p) + inserted + old.slice(old.length - s);
			el.value = new Array(el._real.length + 1).join(BULLET);
			var caret = p + inserted.length;
			try { el.setSelectionRange(caret, caret); } catch (e) { /* not focusable yet */ }
		});
	}
	function getSecret(el) { return el ? (el._real != null ? el._real : el.value) : ''; }
	function setSecret(el, v) {
		if (!el) return;
		v = v || '';
		if (el._real != null) {
			el._real = v;
			el.value = el._revealed ? v : new Array(v.length + 1).join(BULLET);
		} else {
			el.value = v;
		}
	}
	/// Show or hide a secret field's real text. Reading and typing keep working
	/// in both states; only the display changes.
	///
	/// Two kinds of field reach this. A real `type="password"` input reveals by
	/// swapping its type, which is the ordinary web pattern and keeps the browser
	/// treating it as a credential. The JS-masked text input (the API key) has no
	/// type to swap, so it exchanges bullets for the value it is holding.
	function setSecretRevealed(el, show) {
		if (!el) return;
		el._revealed = !!show;
		if (el._real == null) {
			el.type = show ? 'text' : 'password';
		} else {
			el.value = show ? el._real : new Array(el._real.length + 1).join(BULLET);
		}
		var caret = el.value.length;
		try { el.setSelectionRange(caret, caret); } catch (e) { /* not focusable yet */ }
	}

	// The reveal toggle's two faces: an open eye to show, a struck-through one to
	// hide. Module-level because the create screen reveals a generated passphrase
	// on its own initiative, and the icon has to agree with what the field is doing.
	var EYE_OPEN = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">'
		+ '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/>'
		+ '<circle cx="12" cy="12" r="2.6"/></svg>';
	var EYE_OFF = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">'
		+ '<path d="M2 12s3.5-6.5 10-6.5c1.8 0 3.4.5 4.8 1.2M22 12s-3.5 6.5-10 6.5c-1.8 0-3.4-.5-4.8-1.2"/>'
		+ '<path d="M9.5 9.7a2.6 2.6 0 003.6 3.6M4 4l16 16"/></svg>';

	/// Redraw a field's reveal toggle to match whether the field is revealed.
	function syncEyeIcon(fid) {
		var eye = document.getElementById(fid + '-eye');
		var inp = document.getElementById(fid);
		if (!eye || !inp) return;
		var show = !!inp._revealed;
		eye.innerHTML = show ? EYE_OFF : EYE_OPEN;
		eye.title = show ? t('identity.hide_passphrase') : t('identity.show_passphrase');
		eye.setAttribute('aria-label', eye.title);
	}

	// ── What the app says ──────────────────────────────────────
	// The table lives in i18n/en.js and the engine in i18n.js; these are the
	// two names the rest of this file uses.
	function t(k, vars)     { return DaimondI18n.t(k, vars); }
	function tn(k, n, vars) { return DaimondI18n.tn(k, n, vars); }
	/// Whether figures are being shown in the currency they are billed in.
	/// When they are not, a purchase point owes the user a sentence.
	function usdDisplay()   { return DaimondI18n.currency() === 'USD'; }

	// Format a USD cost calmly: precise but never dollar-signs-screaming. The
	// cascade now lives in i18n.js, which is also where a display currency is
	// applied -- one formatter, so a figure cannot be converted on one screen
	// and left in dollars on the next.
	function fmtUsd(u) {
		return DaimondI18n.money(u);
	}

	// ── Diamonds state ─────────────────────────────────────────────
	var diamonds = [];              // [{ id, name, crystal_version, updated, tags }]
	var currentDiamond = null;    // selected Diamond meta, or null
	var centreMode = 'chat';    // 'chat' | 'focus' — what the Centre shows
	var crystalBusy = false;      // a steer or fold turn is in flight
	// A pending fold proposal belongs to its Diamond, not to whatever is on
	// screen. It used to live in one global that `selectDiamond` cleared
	// unconditionally, so clicking the chat to re-read it before deciding
	// silently threw away a real (and paid-for) reducer round trip.
	var pendingFolds = {};      // diamondId -> { base, proposed, delta, chatId, chatName }

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
	function starterTags() {
		return t('tag.starters').split(',')
			.map(function (x) { return x.split(/\s+/).join(' ').trim().toLowerCase(); })
			.filter(function (x, i, a) { return x && a.indexOf(x) === i; });
	}
	var TAG_CHIPS_SHOWN = 3;    // chips on a Diamond box before the +N overflow
	// The rail filters on a small boolean rather than one tag: the tags a Diamond
	// must carry, the tags that hide it, and how two or more of the first combine.
	// A tag sits in one of those two lists or in neither, never both -- the cycle
	// that fills them moves it, and moving is not copying (see `cycleTagFilter`).
	// Both lists are a way of looking rather than a setting, so they last exactly
	// as long as the page does; the mode is a preference, and is kept.
	var tagInc  = [];           // tags a Diamond must carry to show
	var tagExc  = [];           // tags that hide a Diamond outright
	var TAG_MODE_KEY = 'daimond-tag-mode';
	var tagMode = readJson(TAG_MODE_KEY, 'all') === 'any' ? 'any' : 'all';
	// The pool of chips is worth a row of the rail, not four. Standing, a real
	// vocabulary of thirty tags sat three and a half rows deep under the search
	// box on every screen, filtering or not, and the two lists below live on what
	// the furniture leaves. Hidden outright it would be missed -- it was read as
	// absent twice. So it sits behind one row that NAMES it and COUNTS it, and
	// that row is always there. Which way it was left is a habit of working, like
	// the mode above it, and is kept; closed is where it starts.
	var TAG_POOL_KEY = 'daimond-tag-pool-open';
	var tagPoolOpen  = readJson(TAG_POOL_KEY, false) === true;

	// Diamond-to-Diamond links: the relations a Diamond has with the other
	// Diamonds, as against the files and pages the artefact strip holds. Three
	// words are offered as a nudge for an empty section; the store knows none of
	// them and holds no relation to be special, exactly as it is for tags.
	var DEFAULT_REL_SUGGESTIONS = ['part-of', 'relates-to', 'derives-from'];
	var REL_MAX = 32;           // what the store caps a relation at
	// The section's own state lives here rather than in the DOM: the controls are
	// rebuilt whole on every crystal repaint, and a half-typed link form must
	// survive one -- a resize, a steer, a fold -- rather than vanishing with
	// everything typed into it.
	var linkOpen  = false;      // the section is expanded
	var linkForm  = null;       // { target, query, rel, note } while adding, else null
	var linkNotes = {};         // link id -> its note is expanded
	var linkFor   = null;       // the Diamond id the three above belong to
	var linkPaint = 0;          // paint token, so a slow read cannot overwrite a fresh one

	// ── DOM refs ───────────────────────────────────────────────
	var appEl         = document.getElementById('app');
	var sessionList   = document.getElementById('session-list');
	var newSessionBtn = document.getElementById('new-session-btn');
	var chatOutput    = document.getElementById('chat-output');
	var chatInput     = document.getElementById('chat-input');
	var chatSend      = document.getElementById('chat-send');
	var sessionNameEl = document.getElementById('current-session-name');
	var settingsBtn   = document.getElementById('settings-btn');
	// The word logo on the identity gate. It was looked up by `.brand-logo`, a
	// class the markup no longer carries, so the lookup found nothing and the
	// dark-ink/light-ink swap below had been dead for as long as that class was.
	var brandLogo     = document.getElementById('id-logo');
	var topMeter      = document.getElementById('top-meter');
	var aiMeter       = document.getElementById('ai-meter');
	var agentsList    = document.getElementById('agents-list');
	var agentsCount   = document.getElementById('agents-count');
	var diamondList     = document.getElementById('diamond-list');
	var diamondFilter   = document.getElementById('diamond-filter');
	var agentSearch   = document.getElementById('agent-search');
	var agentFilter   = document.getElementById('agent-filter');
	var agentQuery       = '';   // the agents panel search text, lower-cased
	var agentDiamondFilter = null; // filter agents to one Diamond id, or null
	var agentTagFilter   = null; // filter agents to one tag, or null
	var newDiamondBtn   = document.getElementById('new-diamond-btn');
	var crystalView     = document.getElementById('crystal-view');
	var crystalBody     = document.getElementById('crystal-body');
	var crystalControls = document.getElementById('crystal-controls');
	var chatOutputEl  = document.getElementById('chat-output');
	var chatInputBar  = document.querySelector('.chat-input-bar');

	// ── Theme ──────────────────────────────────────────────────
	//
	// A palette carries two facts beyond its colours, and they are NOT the same
	// question. `tone` is the band it is offered under -- light, intermediate,
	// dark -- which is how a reader looks for one. `ink` is whether its surfaces
	// take dark lettering or light, which is what every rule outside this file
	// actually needs to know: which wordmark to draw, which chip fill to use,
	// which prose colours the reader and the guide take.
	//
	// They were one question while there were three palettes, and the code asked
	// it as `theme !== 'dark'`. That is exactly the assumption a list of ten
	// breaks: an intermediate palette may be a bright sage that wants dark ink or
	// a slate dusk that wants light, and its band says nothing about which. Both
	// are published as attributes, so a stylesheet can ask either without
	// knowing a single palette's name.
	var THEMES = {
		// Light: paper-bright grounds, dark lettering.
		light:    { tone: 'light', ink: 'dark'  },
		mist:     { tone: 'light', ink: 'dark'  },
		linen:    { tone: 'light', ink: 'dark'  },
		// Intermediate: colour or midtone, either way of ink.
		lollypop: { tone: 'mid',   ink: 'dark'  },
		sage:     { tone: 'mid',   ink: 'dark'  },
		dusk:     { tone: 'mid',   ink: 'light' },
		// Dark: deep grounds, light lettering.
		dark:     { tone: 'dark',  ink: 'light' },
		amber:    { tone: 'dark',  ink: 'light' },
		midnight: { tone: 'dark',  ink: 'light' },
		forest:   { tone: 'dark',  ink: 'light' },
		plum:     { tone: 'dark',  ink: 'light' },
	};
	/// The bands, in the order they are offered. Named here rather than derived
	/// from THEMES so the order is a decision and not a side effect of insertion.
	var TONES = ['light', 'mid', 'dark'];

	function initTheme() {
		var saved = localStorage.getItem('daimond-theme');
		setTheme(THEMES[saved] ? saved : 'dark');
	}
	function setTheme(theme) {
		if (!THEMES[theme]) theme = 'dark';
		var spec = THEMES[theme];
		var root = document.documentElement;
		root.setAttribute('data-theme', theme);
		root.setAttribute('data-tone', spec.tone);
		root.setAttribute('data-ink', spec.ink);
		localStorage.setItem('daimond-theme', theme);
		// A word logo drawn for a dark background needs its dark-ink twin on any
		// surface that takes dark lettering.
		var lightBg = spec.ink === 'dark';
		if (brandLogo && brandLogo.dataset.dark) {
			brandLogo.src = lightBg ? brandLogo.dataset.light : brandLogo.dataset.dark;
		}
		var el = chatOutput && chatOutput.querySelector('.empty-logo.full');
		if (el) el.src = lightBg ? 'assets/daimond_word_dark.svg' : 'assets/daimond_word.svg';
	}
	// The theme used to be a pulldown of its own in the header. It is now one
	// setting among several in the appearance menu, so it is published as a
	// service rather than bound to a control.
	window.DaimondTheme = {
		list:  function () { return Object.keys(THEMES); },
		tones: function () { return TONES.slice(); },
		/// The palettes in one band, in declaration order.
		inTone: function (tone) {
			return Object.keys(THEMES).filter(function (k) { return THEMES[k].tone === tone; });
		},
		spec: function (name) { return THEMES[name] || null; },
		get:  function () { return document.documentElement.getAttribute('data-theme') || 'dark'; },
		set:  setTheme,
	};

	// ── Skin ───────────────────────────────────────────────────
	// Orthogonal to the theme: the theme picks the palette, the skin picks the
	// shape -- corners, typeface, spacing, how loud the furniture is. "sharp" is
	// the original precise, dense look; "warm" is the approachable one, all of it
	// in skin-warm.css and dormant until chosen (see that file's header).
	var SKINS = { sharp: 1, warm: 1 };
	function initSkin() {
		var saved = localStorage.getItem('daimond-skin');
		if (saved === 'soft') saved = 'warm';   // the warm skin was briefly called "soft".
		setSkin(SKINS[saved] ? saved : 'sharp');
	}
	function setSkin(skin) {
		if (!SKINS[skin]) skin = 'sharp';
		document.documentElement.setAttribute('data-skin', skin);
		localStorage.setItem('daimond-skin', skin);
	}
	window.DaimondSkin = {
		list: function () { return Object.keys(SKINS); },
		get:  function () { return document.documentElement.getAttribute('data-skin') || 'sharp'; },
		set:  setSkin,
	};

	// ── Repainting after a language or currency change ─────────
	// The surfaces that are ALWAYS on screen are redrawn at once: the admin
	// status header, the spend readout at the foot of the rail, and the Credits
	// drawer if it is the one open. Everything built on open (a dialog, a form,
	// the tools panel) is next-open, which is when it is next built anyway.
	if (window.DaimondI18n) {
		DaimondI18n.onChange(function () {
			try { DaimondAdmin.status(); } catch (e) { /* the panel is not up yet */ }
			try { updateSpend(); } catch (e) { /* no ledger yet */ }
			try {
				var cv = document.getElementById('admin-credits');
				if (cv && cv.style.display !== 'none') renderCredits();
			} catch (e) { /* the drawer is not open */ }
			try { updateUserRow(); } catch (e) { /* not signed in */ }
			// The chat header when nothing is open. It is not a dialog waiting to be
			// built again -- it is on screen the whole time an empty app is, so a
			// language change has to reach it where it stands.
			try {
				if (!current && !currentDiamond && sessionNameEl) {
					sessionNameEl.textContent = t('chat.no_chat');
				}
			} catch (e) { /* the header is not up yet */ }
			// Likewise the version row in the rail's status block, which release.js
			// draws from its own strings.
			try { if (window.DaimondRelease) DaimondRelease.paintRow(); } catch (e) { /* no log */ }
			// And the two lists in the rail, which say "No Diamonds yet." and "No
			// chats yet." to an empty account -- as permanently on screen as
			// anything in the app, and for a new user the FIRST words they read.
			try { renderDiamondList(); } catch (e) { /* the rail is not up yet */ }
			try { renderSessionList(); } catch (e) { /* the rail is not up yet */ }
			// The Workspace panel's scope row, which names the two trees and stays on
			// screen for as long as the panel does.
			try { Files.relabel(); } catch (e) { /* the panel is not up yet */ }
			// And the Terminal's two buttons, whose names change with the session
			// rather than with the markup, so nothing else would ever repaint them.
			try { if (window.DaimondTerm) DaimondTerm.relabel(); } catch (e) { /* not built yet */ }
		});
	}

	// ── Durability: lifecycle hooks ────────────────────────────
	// These are INSURANCE, not the mechanism. The journal is kept current as work happens, so
	// nothing here is load-bearing — but a tab about to be hidden or frozen is a tab that might be
	// discarded next, so we land any buffered events, and we warn before a shutdown throws away a
	// turn in flight. We never rely on saving AT unload: async writes do not finish there, and by
	// then the journal is already safe.
	document.addEventListener('visibilitychange', function () {
		if (document.visibilityState === 'hidden' && window.DaimondJournal) DaimondJournal.flush();
	});
	// The Page Lifecycle 'freeze' fires when the browser is about to freeze/discard a background
	// tab — the last moment to flush.
	document.addEventListener('freeze', function () { if (window.DaimondJournal) DaimondJournal.flush(); });
	// Once the page is on its way out, a request that dies is an INTERRUPTION, not a failure: the
	// turn's own catch checks this so it does not write a spurious "network error" over what
	// recovery will show, correctly, as an interrupted turn.
	window.addEventListener('pagehide', function () { _unloading = true; if (window.DaimondJournal) DaimondJournal.flush(); });
	window.addEventListener('beforeunload', function (e) {
		_unloading = true;
		if (window.DaimondJournal) DaimondJournal.flush();
		if (!anyGen()) return;
		// A task is still running. Closing now cannot finish it (there is no background executor),
		// but the prompt and everything streamed so far are journalled, so this is a courtesy, not
		// a save: warn, and let the browser show its native "leave site?" prompt.
		e.preventDefault();
		e.returnValue = '';
		return '';
	});

	// ── Nothing fails in silence ───────────────────────────────
	// Most of this app is started rather than awaited: a click hands a promise to
	// nobody. A rejection in one of those used to reach the console and no further,
	// so a user watched a button do nothing and had no reason to think it had even
	// tried. The last resort, then: whatever escapes, the user is told.
	//
	// Not a substitute for handling a failure where it happens -- a caller that
	// knows what failed can say something better, and should -- but a floor under
	// the whole class.
	window.addEventListener('unhandledrejection', function (e) {
		if (_unloading) return;                 // the page is going; its dead requests are not news
		var why = e && (e.reason !== undefined ? e.reason : e);
		try { toast(friendlyError(why), true); } catch (e2) { /* nothing left to tell them with */ }
	});

	// ── The balance, when it moves ──────────────────────────────
	// Nearly every credit-spending gateway reply states the resulting balance, and `gateway.js`
	// announces each one it reads. Before anything listened, the figure in the rail sat at
	// whatever the last explicit /api/balance call had said: a session that fetched twenty pages
	// showed the balance it started with until something unrelated happened to repaint.
	//
	// `DaimondAdmin` is this file's own closure, so it is called by name here rather than off
	// `window` -- it IS published there (see the assignment below the closure), but a listener
	// in this file has no reason to go round the houses for it.
	window.addEventListener('daimond:credits', function () {
		try { DaimondAdmin.status(); } catch (e) { /* the panel is not up yet */ }
		// The strip is not the only place the figure is written. The line INSIDE the open
		// Credits drawer was painted on open and on a language change and at no other time, so
		// somebody watching the drawer while the balance moved saw the staleness the strip had
		// just been cured of.
		try {
			var cv = document.getElementById('admin-credits');
			if (cv && cv.style.display !== 'none') renderCredits();
		} catch (e) { /* the drawer is not open */ }
		try {
			if (window.DaimondPanels && DaimondPanels.isOpen && DaimondPanels.isOpen('spend')
				&& window.DaimondSpend) DaimondSpend.refresh();
		} catch (e) { /* the Spending panel is not up */ }
	});

	// And when it does NOT move on its own. A balance can change outside this tab -- an
	// auto-reload top-up, a purchase on the phone, an operator adjustment -- and nothing here
	// would hear it. So the app asks, but only when it is idle and at most once a minute: a
	// balance is worth a request between turns and never worth one during them.
	var _balAt = 0;
	window.addEventListener('daimond:idle', function () {
		var now = Date.now();
		if (now - _balAt < 60000) return;
		_balAt = now;
		var g = window.DaimondGateway;
		if (g && g.state && g.state().authed) g.refreshBalance().catch(function () {});
	});

	// ── Mobile: one panel at a time ────────────────────────────
	var mobileMq = window.matchMedia('(max-width: 760px)');
	function isMobile() { return mobileMq.matches; }
	// The stage's guests do not take a slot on the bottom bar: they RISE as a
	// sheet over the chat floor, so the daimon stays beside the thing. That is
	// what a stage panel does on a phone, and the Terminal is one of them.
	// Spending is a DOCK panel and rises the same way: the phone bar has four
	// seats and they are spoken for, and a panel with no seat and no sheet is a
	// panel a phone cannot reach at all.
	var MOBILE_GUESTS = { web: 1, doc: 1, msg: 1, compose: 1, tools: 1, spend: 1, term: 1 };
	function mshow(name) {
		// A guest rises as a sheet; the floor beneath it stays the conversation.
		if (MOBILE_GUESTS[name] && window.DaimondSheet) {
			document.body.dataset.mpanel = 'ai';
			document.querySelectorAll('#mnav button').forEach(function (b) {
				b.classList.toggle('on', b.dataset.mp === 'ai');
			});
			DaimondSheet.open(name);
			return;
		}
		// The rail is reached through the hamburger drawer, not the bar.
		if (name === 'rail') {
			if (window.DaimondShell) DaimondShell.openDrawer();
			DaimondPanels.reflow();
			return;
		}
		document.body.dataset.mpanel = name;
		document.querySelectorAll('#mnav button').forEach(function (b) {
			b.classList.toggle('on', b.dataset.mp === name);
		});
		// The bar's own destinations. Spending and the Terminal reach here only on
		// a page whose sheet script did not load, and are woken anyway: a panel
		// shown without its onOpen is a panel that draws nothing.
		if (name === 'work') Files.onOpen();
		if (name === 'mail' && window.DaimondMail) DaimondMail.onOpen();
		if (name === 'spend' && window.DaimondSpend) DaimondSpend.onOpen();
		if (name === 'term' && window.DaimondTerm) DaimondTerm.onOpen();
	}
	document.querySelectorAll('#mnav button').forEach(function (b) {
		b.addEventListener('click', function () { mshow(b.dataset.mp); });
	});

	// ── Layout: three zones ────────────────────────────────────
	//
	// The registry is the DOM. A panel declares itself, and its zone:
	//
	//   <aside class="panel" data-panel="web" data-zone="stage" data-label="Web">
	//
	// so a new panel is markup plus its own code — the layout engine needs no
	// edit, and a panel that does not exist cannot be advertised as a tag.
	//
	//   rail   the left column. Permanent. Two panes (Diamonds/Chats above, Admin
	//          below) split by a handle that moves but does not go away.
	//
	//   stage  the middle. Its occupants are EXCLUSIVE to it: they take the
	//          stage, solo or two side by side, and never dock at the right.
	//          `ai` is the default occupant and is restored whenever the stage
	//          would otherwise be empty.
	//
	//          Two seats, because you should never have to leave the
	//          conversation to do a thing. Read the message, watch the page,
	//          read the document — with the daimon still beside it, to be asked
	//          about it. This is the same rule the Admin panel follows: a form
	//          opens next to a live chat, not over it.
	//
	//   dock   the right. The sources you pull from. A closed panel is a tag in
	//          the header; clicking the tag docks it, and its own closer sends
	//          it back. A second column opens only when there is room for one.
	var DaimondPanels = (function () {
		var PANELS = [];
		function scan() {
			PANELS = [].slice.call(document.querySelectorAll('.panel[data-panel]')).map(function (el) {
				return {
					id:    el.dataset.panel,
					el:    el.id,
					label: el.dataset.label || el.dataset.panel,
					zone:  el.dataset.zone || 'dock',
				};
			});
			// A true first run has no saved layout. On it, the Web panel opens too,
			// so a newcomer meets it — and its help — rather than having to discover
			// a tag. A returning user's saved choices (below, in load) win, so it
			// does not force itself back open once they have closed it.
			var firstRun = false;
			try { firstRun = (localStorage.getItem(KEY) === null); } catch (e) { /* private mode */ }
			PANELS.forEach(function (p) {
				// A panel not explicitly closed starts open, so a newly built one is
				// visible the first time rather than hidden with no clue. The stage's
				// guests are the exception: Web, Doc and Message appear when there is
				// something to show, not before — except Web on that first run.
				if (!(p.id in open)) open[p.id] = (p.id === 'rail' || p.id === 'ai' || p.id === 'work'
					|| (firstRun && p.id === 'web'));
			});
		}

		var KEY      = 'daimond-layout';
		var STAGE_MAX = 2;      // two seats. A third would make each unreadable.

		/// How the dock tiles, and therefore how many panels it can hold.
		///
		/// The cap used to be the constant 4, which was the number of dock panels
		/// that happened to exist. Deriving it from the grid is what lets a wide
		/// screen hold more than a tall one, and what makes 2 x 3 mean anything.
		/// `auto` keeps the behaviour the app shipped with: a second column once
		/// the window is wide enough to mean it.
		var GRIDS = {
			auto:  null,
			'1':   { cols: 1, rows: 4, label: 'One column' },
			'2x2': { cols: 2, rows: 2, label: '2 by 2' },
			'2x3': { cols: 2, rows: 3, label: '2 by 3' },
			'3x2': { cols: 3, rows: 2, label: '3 by 2' },
		};
		// The rail holds the settings forms, so it needs a width a form can be
		// filled in at, not the width of a list of names.
		var MIN_W    = { rail: 260, stage: 380, dock: 260 };
		// Neither pane of the rail may be crushed, and neither of the two LISTS in
		// its upper pane: a Diamonds list dragged to nothing is a list you cannot
		// get back, because the handle would be all there is left of it.
		// `stack` is the floor for a panel sharing a dock column: a header and a
		// couple of rows, which is the least that is worth drawing.
		var MIN_H    = { top: 130, pane: 160, list: 72, stack: 120 };
		var NARROW   = 1280;    // below this the rail folds away on its own
		var TWO_COLS = 1900;    // and above this the dock may take a second column

		var open   = {};
		var stage  = ['ai'];    // stage occupants, left to right
		var dock   = [];        // dock panels, in the order they were opened
		var widths = { rail: 320, dock: 300 };
		var split  = 0.5;       // the Admin panel's share of the rail's height
		var railSplit = 0.5;    // the Diamonds list's share of what the two rail lists share
		var seat   = 0.5;       // the first stage occupant's share of the stage
		var railForced = false; // a folded rail the user re-opened via its tag
		var grid   = 'auto';    // which of GRIDS the dock is tiled on
		var pinned = null;      // panel ids kept on the chip row; null means all of them
		var arrangements = {};  // diamond id -> a saved arrangement, restored on switch
		// What panels sharing a dock column have made of its height. Keyed by the
		// column's OCCUPANCY -- 'work|mail' -- not by the column, so the tuning
		// belongs to the panels rather than to the slot they happened to be in.
		var stacks    = {};     // occupancy -> each panel's share of the column
		var dockSeats = [];     // { el, ids } per drawn column, as apply() seated them
		var stackEls  = {};     // the divider elements, kept rather than rebuilt
		var tagsEl, stageEl, dockEl, mainEl;

		/// The dock's shape right now, with `auto` resolved against the window.
		function gridOf() {
			var g = GRIDS[grid];
			if (g) return g;
			return { cols: (window.innerWidth >= TWO_COLS) ? 2 : 1, rows: 4, label: 'Automatic' };
		}
		/// How many panels the dock can seat on the current grid.
		function dockMax() { var g = gridOf(); return g.cols * g.rows; }
		/// How many columns the dock actually draws. Never more than there are
		/// panels to put in them, or a lone panel would sit in a half-width column
		/// with dead space beside it. The dock's width is one column's width times
		/// this, so anything that sizes the dock has to ask the same question.
		function dockCols() { return Math.min(gridOf().cols, Math.max(1, dock.length)); }
		function isPinned(id) { return pinned === null || pinned.indexOf(id) !== -1; }

		/// Panels that wait for something to hold before they join the chip row.
		///
		/// Some panels are SUMMONED -- you decide you want the Workspace and open
		/// it. Others only mean anything once something has put something in them:
		/// a Message needs mail, a Compose window needs an account to send from, a
		/// Doc needs a document. Standing in the row from the first run, they read
		/// as features that are broken rather than as features not yet reached.
		///
		/// This generalises what the Agents panel already did on its own. They are
		/// held back from the ROW only: the gallery and the palette list the whole
		/// fleet, because a panel you cannot enumerate is one you end up guessing
		/// at, and reaching for one there is itself the event it was waiting for.
		var USED_KEY = 'daimond-used-panels';
		function usedPanels() {
			try { return JSON.parse(localStorage.getItem(USED_KEY) || '{}') || {}; }
			catch (e) { return {}; }
		}
		function markUsed(id) {
			try {
				var u = usedPanels();
				if (u[id]) return;
				u[id] = 1;
				localStorage.setItem(USED_KEY, JSON.stringify(u));
			} catch (e) { /* private mode: the panel simply shows every session */ }
		}
		/// Whether a mail account exists, which is what makes Message and Compose
		/// mean anything at all.
		function hasMail() {
			try {
				if (window.DaimondMail && DaimondMail.hasAccounts) return DaimondMail.hasAccounts();
				var j = JSON.parse(localStorage.getItem('daimond-mail') || '{}');
				return !!(j && Array.isArray(j.accounts) && j.accounts.length);
			} catch (e) { return false; }
		}
		// Agents is NOT in this table, and its absence is the point. It waited for
		// a Diamond to dispatch a worker, which meant a user who had never run one
		// had no chip, no nav item and no panel -- and read the panel as deleted
		// rather than as empty. It still OPENS itself on the first dispatch; it is
		// only the chip that no longer waits, and an empty panel says so in a line.
		var WAITS_FOR = {
			msg:     hasMail,
			compose: hasMail,
			doc:     function () { return !!usedPanels().doc; },
		};
		/// Whether a panel has earned its place in the row yet.
		function revealed(id) {
			var f = WAITS_FOR[id];
			if (!f) return true;                       // an ordinary, summonable panel
			return !!(usedPanels()[id] || f());
		}

		function def(id)    { return PANELS.find(function (p) { return p.id === id; }); }
		function elOf(id)   { var d = def(id); return d ? document.getElementById(d.el) : null; }
		function zoneOf(id) { var d = def(id); return d ? d.zone : 'dock'; }
		function isOpen(id) { return !!open[id]; }

		/// Whether a panel actually holds a place in its zone.
		///
		/// `open` is the intention; this is the fact, and the two come apart whenever a saved
		/// layout names more stage guests than the stage has seats.
		function seated(id) {
			var z = zoneOf(id);
			if (z === 'stage') return stage.indexOf(id) !== -1;
			if (z === 'dock')  return dock.indexOf(id)  !== -1;
			return true;					// the rail has no seating
		}

		function save() {
			try {
				localStorage.setItem(KEY, JSON.stringify({
					open: open, stage: stage, dock: dock,
					widths: widths, split: split, railSplit: railSplit, seat: seat,
					grid: grid, pinned: pinned, arrangements: arrangements, stacks: stacks,
				}));
			} catch (e) { /* layout is a nicety; never break on quota */ }
		}
		function load() {
			var st = readJson(KEY, null);
			if (!st) return;
			if (st.open)   Object.keys(st.open).forEach(function (k) { if (def(k)) open[k] = !!st.open[k]; });
			if (st.widths) Object.keys(st.widths).forEach(function (k) { widths[k] = st.widths[k]; });
			// The whole range is legal: the appliers clamp to what fits, so a handle
			// dragged hard to one end comes back where it was left.
			if (typeof st.split === 'number' && st.split >= 0 && st.split <= 1) split = st.split;
			if (typeof st.railSplit === 'number' && st.railSplit >= 0 && st.railSplit <= 1) railSplit = st.railSplit;
			if (typeof st.seat  === 'number' && st.seat  >= 0 && st.seat  <= 1) seat  = st.seat;
			if (Array.isArray(st.stage)) {
				stage = st.stage.filter(function (id) { return def(id) && zoneOf(id) === 'stage' && open[id]; })
					.slice(0, STAGE_MAX);
			}
			if (typeof st.grid === 'string' && (st.grid === 'auto' || GRIDS[st.grid])) grid = st.grid;
			// A pin list is filtered against the panels that actually exist, so a
			// panel that has since been removed does not hold a place on the row,
			// and one that did not exist when the list was saved is simply absent
			// from it rather than lost -- the gallery still has it.
			if (Array.isArray(st.pinned)) pinned = st.pinned.filter(def);
			if (st.arrangements && typeof st.arrangements === 'object') arrangements = st.arrangements;
			// A stored share is read only if it still names panels that exist and
			// still has one number per panel: a stack whose occupancy has changed
			// underneath it is not a stack the numbers describe, and an even split
			// is the honest answer rather than a share applied to the wrong panel.
			if (st.stacks && typeof st.stacks === 'object') {
				Object.keys(st.stacks).forEach(function (k) {
					var ids = k.split('|'), v = st.stacks[k];
					if (!Array.isArray(v) || v.length !== ids.length || ids.length < 2) return;
					if (!ids.every(def)) return;
					if (!v.every(function (x) { return typeof x === 'number' && x > 0 && x <= 1; })) return;
					stacks[k] = v.slice();
				});
			}
			if (Array.isArray(st.dock)) {
				dock = st.dock.filter(function (id) { return def(id) && zoneOf(id) === 'dock' && open[id]; })
					.slice(0, dockMax());
			}
		}

		/// Every open panel must have a place in its zone. This runs on EVERY start,
		/// not only when a layout was stored — otherwise a panel opened by default
		/// (Web, on a first run) is open but seated nowhere, and only shows by the
		/// accident of its markup position, unmanaged by the resize logic.
		function seatOpenPanels() {
			PANELS.forEach(function (p) {
				if (!open[p.id]) return;
				if (p.zone === 'stage' && stage.indexOf(p.id) === -1 && stage.length < STAGE_MAX) stage.push(p.id);
				if (p.zone === 'dock'  && dock.indexOf(p.id)  === -1 && dock.length  < dockMax()) dock.push(p.id);
			});
			normaliseStage();
		}

		/// The stage is never empty, and AI is what fills it. An app whose middle
		/// holds no conversation is not Daimond. AI also keeps the first seat, so
		/// the conversation stays on the left and a guest opens to its right.
		function normaliseStage() {
			stage = stage.filter(function (id) { return open[id]; });
			if (!stage.length) { open.ai = true; stage = ['ai']; }
			var ai = stage.indexOf('ai');
			if (ai > 0) { stage.splice(ai, 1); stage.unshift('ai'); }
		}

		// ── Applying ──────────────────────────────────────────

		/// Give the Admin panel its share of the rail's height. The share is a
		/// fraction, not a pixel count, so the split survives a resize — but
		/// neither pane may fall below the height it needs to be usable.
		function applySplit() {
			// The rail no longer splits: the Status strip is fixed and the Admin panel
			// overlays it, so there is no pane to size. Clear any height a split left.
			var bot = document.getElementById('admin');
			if (bot) bot.style.height = '';
		}

		// ── The rail's two lists ──────────────────────────────
		// Diamonds above, Chats below. Diamonds accumulate and the list grew with
		// them, pushing the chat tiles off the bottom of the rail with no way to
		// get them back -- so the boundary between the two moves.

		/// How much height the two lists have to share, and what the Diamonds list
		/// is holding of it now. Everything else in the pane (the two heads, the
		/// tag filter, the handle, and the gaps between them all) is fixed
		/// furniture, so it comes off the top before the proportion is spent.
		function railRoom() {
			var top  = document.getElementById('rail-top');
			var list = document.getElementById('diamond-list');
			var sess = document.getElementById('session-list');
			if (!top || !list || !sess) return null;
			var h = top.clientHeight;
			if (!h) return null;
			var fixed = 0, kids = top.children, shown = 0;
			for (var i = 0; i < kids.length; i++) {
				if (getComputedStyle(kids[i]).display === 'none') continue;
				shown += 1;
				if (kids[i] === list || kids[i] === sess) continue;
				fixed += kids[i].getBoundingClientRect().height;
			}
			var gap = parseFloat(getComputedStyle(top).rowGap) || 0;
			var room = h - fixed - gap * Math.max(0, shown - 1);
			return { room: room, list: list, held: list.getBoundingClientRect().height };
		}

		/// Give the Diamonds list its share; the Chats list flexes into the rest.
		/// A proportion rather than a height, so the divider survives a resize.
		function applyRailSplit() {
			var r = railRoom();
			var handle = document.getElementById('handle-rail-split');
			if (!r) return;
			// The phone shows this rail as a drawer that scrolls as one column; a
			// fixed height on one of its lists is not what a thumb wants there.
			if (isMobile() || r.room <= MIN_H.list * 2) {
				r.list.style.flex = '';
				r.list.style.height = '';
				if (handle) handle.style.display = isMobile() ? 'none' : '';
				return;
			}
			if (handle) handle.style.display = '';
			var want = Math.round(railSplit * r.room);
			want = Math.max(MIN_H.list, Math.min(want, r.room - MIN_H.list));
			r.list.style.flex   = '0 0 auto';
			r.list.style.height = want + 'px';
		}

		// ── Panels stacked in a dock column ───────────────────
		// A column's height used to be split evenly and that was that, so a
		// Workspace with one file and an Email with forty got the same half. A
		// divider now sits between each adjacent pair and moves the boundary.
		//
		// The share is kept against WHAT IS IN THE COLUMN rather than against the
		// column itself. A key tied to the slot ('dock-a, second boundary') would
		// hand a tuning meant for Email to whatever the next tiling seated there;
		// keyed by occupancy, `work|mail` finds its own boundary wherever those
		// two re-stack, which is what makes Auto -> 2 by 2 -> Auto come back to
		// what the user left. A panel JOINING the column makes a different
		// occupancy, so that stack starts even -- and the old share is untouched,
		// waiting for the newcomer to leave again.

		function stackKey(ids) { return ids.join('|'); }
		function seatOf(colId) {
			return dockSeats.filter(function (s) { return s.el.id === colId; })[0] || null;
		}

		/// The stored shares for an occupancy, normalised to sum to one, or null
		/// when there are none to honour and the column should share evenly.
		function sharesOf(ids) {
			var s = stacks[stackKey(ids)];
			if (!Array.isArray(s) || s.length !== ids.length) return null;
			var sum = 0;
			for (var i = 0; i < s.length; i++) {
				if (typeof s[i] !== 'number' || !(s[i] > 0)) return null;
				sum += s[i];
			}
			if (!(sum > 0)) return null;
			return s.map(function (v) { return v / sum; });
		}

		/// Spend `room` on `shares`, with nothing below `min`.
		///
		/// What the short panels need is taken from the tall ones in proportion to
		/// what they hold ABOVE the minimum, so a crush is paid for by whoever can
		/// afford it. One pass is enough: `room >= min * n` is checked first, and
		/// that is exactly the condition under which the slack covers the need.
		function fitStack(shares, room, min) {
			var n = shares.length;
			var px = shares.map(function (s) { return s * room; });
			var need = 0, slack = 0;
			px.forEach(function (v) { if (v < min) need += min - v; else slack += v - min; });
			if (need > 0 && slack > 0) {
				var rate = Math.min(need, slack) / slack;
				px = px.map(function (v) { return v < min ? min : v - (v - min) * rate; });
			}
			return px.map(function (v) { return Math.max(min, Math.round(v)); });
		}

		/// Put a divider between each adjacent pair in every drawn column.
		///
		/// Every divider is taken out of the dock first, wherever it has ended up.
		/// The surplus-column sweep empties a retired column by moving its children
		/// into the dock itself, so a divider left in one would be dumped loose
		/// beside the panels: a handle for a boundary that no longer exists.
		function placeStacks() {
			if (!dockEl) return;
			[].slice.call(dockEl.querySelectorAll('.hstack')).forEach(function (h) {
				if (h.parentNode) h.parentNode.removeChild(h);
			});
			// The phone shows one destination at a time, chosen from the bottom
			// bar. Nothing is stacked, so there is no boundary to hold.
			if (isMobile()) return;
			dockSeats.forEach(function (s) {
				s.el.classList.toggle('stacked', s.ids.length > 1);
				for (var i = 1; i < s.ids.length; i++) {
					var el = elOf(s.ids[i]);
					if (el && el.parentNode === s.el) {
						s.el.insertBefore(stackHandle(s.el.id, i - 1), el);
					}
				}
			});
		}

		/// The divider for a boundary, built once and kept: a handle rebuilt under
		/// the pointer would drop the drag holding it.
		function stackHandle(colId, i) {
			var key = colId + '-' + i;
			var h = stackEls[key];
			if (!h) {
				h = document.createElement('div');
				h.className = 'hstack';
				h.id = 'hstack-' + key;
				h.dataset.i18nTitle = 'layout.handle';
				bindStack(h, colId, i);
				stackEls[key] = h;
			}
			h.title = t('layout.handle');       // re-read, so a language change lands
			return h;
		}

		/// Give each stacked panel its share of its column's height. Pixels cut
		/// from a proportion, as the rail's own divider does, so a tuned column
		/// survives a resize; the last panel flexes into whatever is left, so no
		/// rounding shows as a gap at the bottom of the column.
		function applyStacks() {
			dockSeats.forEach(function (s) {
				var ids = s.ids, n = ids.length;
				var els = ids.map(elOf);
				var hs  = [].slice.call(s.el.children).filter(function (k) {
					return k.classList.contains('hstack');
				});
				var even = function () {
					els.forEach(function (el) { if (el) { el.style.flex = ''; el.style.height = ''; } });
					hs.forEach(function (h) { h.style.display = 'none'; });
				};
				if (isMobile() || n < 2 || els.indexOf(null) !== -1) { even(); return; }
				// `.pcol.stacked` drops the column's gap, because the divider stands
				// in for it -- so the room is the column less the dividers alone.
				//
				// Measured with the dividers STANDING, always. A hidden one is 0px
				// tall, so a column that had just put its dividers away measured
				// itself 16px roomier, decided it could divide after all, and put
				// them back -- a short column flickering between the two answers.
				hs.forEach(function (h) { h.style.display = ''; });
				var room = s.el.clientHeight;
				hs.forEach(function (h) { room -= h.offsetHeight; });
				// Too short to give everyone a usable panel: share it evenly and put
				// the handles away, rather than offer a divider that cannot move.
				if (room < MIN_H.stack * n) { even(); return; }
				var shares = sharesOf(ids) || ids.map(function () { return 1 / n; });
				var px = fitStack(shares, room, MIN_H.stack);
				els.forEach(function (el, i) {
					if (i === n - 1) { el.style.flex = '1 1 auto'; el.style.height = ''; return; }
					el.style.flex   = '0 0 auto';
					el.style.height = px[i] + 'px';
				});
			});
		}

		/// Share the stage between its two occupants. Solo takes it all.
		function applySeat() {
			if (isMobile()) return;			// the phone shell owns the layout below 760
			var handle = document.getElementById('handle-stage');
			var two = stage.length === 2;
			if (handle) handle.style.display = two ? '' : 'none';
			var w = stageEl ? stageEl.clientWidth : 0;
			stage.forEach(function (id, i) {
				var el = elOf(id);
				if (!el) return;
				if (!two) { el.style.flex = '1 1 auto'; el.style.width = ''; return; }
				// Clamp so neither seat is crushed, then express as a basis.
				var room  = w - (handle ? handle.offsetWidth : 0);
				var first = Math.round(seat * w);
				if (room > MIN_W.stage * 2) {
					first = Math.max(MIN_W.stage, Math.min(first, room - MIN_W.stage));
				} else {
					first = Math.round(room / 2);       // no room to honour the ratio
				}
				el.style.flex  = '0 0 auto';
				el.style.width = (i === 0 ? first : Math.max(0, room - first)) + 'px';
			});
		}

		/// The dock's columns, grown to `n`. Columns are never destroyed while they
		/// hold a panel -- emptying a container by innerHTML would destroy the very
		/// panels living in it -- so a surplus column is left in place and hidden by
		/// `.pcol:empty` once its occupants have been moved out.
		function dockColumns(n) {
			var out = [];
			for (var i = 0; i < n; i++) {
				var id = 'dock-' + String.fromCharCode(97 + i);      // dock-a, dock-b, ...
				var el = document.getElementById(id);
				if (!el) {
					el = document.createElement('div');
					el.className = 'pcol';
					el.id = id;
					dockEl.appendChild(el);
				}
				out.push(el);
			}
			return out;
		}

		/// Move the dock onto a different grid, shedding whatever no longer fits.
		///
		/// A smaller grid can leave panels with nowhere to sit. They are CLOSED
		/// rather than dropped silently, so each goes back to being a chip the user
		/// can see and click, and the newest go first: the ones opened most recently
		/// are the ones the user is least likely to have arranged deliberately.
		function setGrid(next) {
			if (next !== 'auto' && !GRIDS[next]) return;
			grid = next;
			var max = dockMax();
			while (dock.length > max) {
				var id = dock.pop();
				open[id] = false;
			}
			apply();
		}

		function apply() {
			normaliseStage();

			// Below the phone breakpoint the phone shell owns the layout: the chat
			// is the floor, guests rise as a sheet, the rail is a drawer. The
			// desktop's zone seating (which MOVES panel elements around) would fight
			// that — it would yank a guest back out of the sheet — so on a phone we
			// keep the bookkeeping and skip the reordering. CSS shows the right
			// destination; mobile.js places the sheet and the drawer.
			if (!isMobile()) {
				// Rail: leftmost, and it folds away on its own below NARROW to give the
				// content room. A folded rail is not a LOST rail, though — the band
				// between the fold and the mobile breakpoint has no bottom nav, so a
				// folded-but-open rail is offered as a header tag (see renderTags), and
				// clicking it forces it back for this width. Without that, Diamonds and
				// Chats were unreachable on a small laptop.
				var railEl = elOf('rail');
				var railOn = open.rail && (window.innerWidth >= NARROW || railForced);
				if (railEl) railEl.style.display = railOn ? '' : 'none';
				document.getElementById('handle-rail').style.display = railOn ? '' : 'none';
				if (railEl && railOn) railEl.style.width = Math.max(MIN_W.rail, widths.rail) + 'px';

				// Stage: the occupants in order, with the handle between them. Do NOT
				// clear the container — appendChild MOVES an element, and emptying it
				// would destroy the very panels living there.
				var handleStage = document.getElementById('handle-stage');
				stage.forEach(function (id, i) {
					var el = elOf(id);
					if (!el) return;
					el.style.display = '';
					stageEl.appendChild(el);                       // re-appending reorders in place
					if (i === 0 && handleStage) stageEl.appendChild(handleStage);
				});

				// Dock: tiled on the chosen grid. Never more columns than there are
				// panels to put in them, or a lone panel would sit in a half-width
				// column with dead space beside it.
				//
				// And never a column for a panel that cannot be drawn. A seat is only
				// worth reserving if something appears in it, so the engine's own
				// inline hiding is cleared FIRST and then the STYLESHEET is asked --
				// only the computed style knows whether a rule elsewhere has put the
				// panel away. One that has is dropped from the dock and closed, which
				// both collapses the gutter and heals a layout that arrived carrying
				// this state, since an open panel nobody can see is not open.
				dock.forEach(function (id) { var el = elOf(id); if (el) el.style.display = ''; });
				var unseen = dock.filter(function (id) {
					var el = elOf(id);
					return !el || getComputedStyle(el).display === 'none';
				});
				if (unseen.length) {
					unseen.forEach(function (id) { open[id] = false; });
					dock = dock.filter(function (id) { return unseen.indexOf(id) === -1; });
				}
				var cols = dockColumns(dockCols());
				// Who ends up in which column, taken from the seating itself rather
				// than read back off the DOM: a panel just closed still has its
				// element in a column at this point, and asking the browser what is
				// drawn there would count it.
				dockSeats = cols.map(function (c) { return { el: c, ids: [] }; });
				dock.forEach(function (id, i) {
					var el = elOf(id);
					if (!el) return;
					el.style.width = '';                           // a stacked panel fills its column
					// Round robin rather than filling each column in turn, so four
					// panels across two columns come out two and two.
					cols[i % cols.length].appendChild(el);
					dockSeats[i % cols.length].ids.push(id);
				});
				// A column the grid has finished with gives up what it is holding and
				// is retired outright, rather than left to `.pcol:empty` to notice.
				//
				// Closing a panel HIDES its element; it does not move it. So a spare
				// column could still hold the node of a panel nobody can see, which
				// made it not `:empty` -- and since the columns SHARE the dock's
				// width, one column's width was then divided between the column that
				// draws and a column that cannot. Auto to 2 by 2 and back came out a
				// half-width dock with the panels crushed into the left of it.
				[].slice.call(dockEl.querySelectorAll('.pcol')).forEach(function (c) {
					if (cols.indexOf(c) !== -1) { c.style.display = ''; return; }
					while (c.firstChild) dockEl.appendChild(c.firstChild);
					c.style.display = 'none';
				});
				dockEl.style.display = dock.length ? '' : 'none';
				document.getElementById('handle-dock').style.display = dock.length ? '' : 'none';
				if (dock.length) dockEl.style.width = Math.max(MIN_W.dock, widths.dock) * cols.length + 'px';
			}

			// Anything closed is hidden, and shows up as a tag instead. A guest
			// currently up in the sheet is `open`, so it is never hit here.
			PANELS.forEach(function (p) {
				if (p.id === 'rail') return;
				if (!open[p.id]) { var el = elOf(p.id); if (el) el.style.display = 'none'; }
			});

			renderTags();
			applySplit();
			applyRailSplit();
			// Outside the desktop block above, both of them: on a phone the dock's
			// seating is not touched, and a divider left over from the desktop
			// would be drawn as a strip across the column the phone lays out.
			placeStacks();
			applyStacks();
			applySeat();
			save();
		}

		/// Everything the chip row needs to draw itself, without the renderer
		/// having to know how the engine seats anything.
		///
		/// The row shows EVERY panel, open or shut, rather than only the closed
		/// ones as it first did. Showing only the absent made the row longest when
		/// the app was emptiest, and shifted every chip sideways each time one was
		/// used, so a chip was never twice in the same place.
		function tagModel() {
			// The rail is a special case: it may be OPEN yet folded away by NARROW,
			// in which case it still needs a chip so it can be reached.
			var railFolded = open.rail && window.innerWidth < NARROW && !railForced;
			var g = gridOf();
			return {
				grid: grid, cols: g.cols, rows: g.rows, gridLabel: g.label, dockMax: dockMax(),
				panels: PANELS.map(function (p) {
					var isOpenNow = !!open[p.id];
					var folded = (p.id === 'rail' && railFolded);
					return {
						id: p.id, label: p.label, zone: p.zone,
						open: isOpenNow && !folded,
						folded: folded,
						pinned: isPinned(p.id),
						// Off the row until it has something to hold; still listed in
						// the gallery and the palette, which are the complete surfaces.
						unrevealed: !revealed(p.id),
						// An OPEN panel always gets a chip, revealed or not: a chipless
						// open panel would be unclosable by construction (its own × sits
						// inside the element a rule may be hiding).
						hidden: !revealed(p.id) && !isOpenNow,
						// A dock chip that cannot be honoured says so before it is
						// clicked; a stage chip that would displace the current guest
						// warns rather than refuses, since that is a real choice.
						full: (p.zone === 'dock' && !isOpenNow && dock.length >= dockMax()),
						evicts: (p.zone === 'stage' && !isOpenNow && p.id !== 'ai'
							&& stage.length >= STAGE_MAX),
					};
				}),
			};
		}

		/// What a chip's click means. A folded rail is forced back rather than
		/// toggled, since it is open already and merely out of sight.
		/// Let a panel that has been waiting out of the way take its place.
		///
		/// Reaching for a panel IS the event its reveal was waiting for. Answers
		/// true when it had to do something, so a caller can re-seat.
		///
		/// This used to live inside `activate` -- the chip row's path alone -- so
		/// every OTHER way of asking for a panel (the API, the mobile nav, the
		/// guide button, a saved layout) could seat one a stylesheet still
		/// suppressed, and the dock reserved a 300px column for a panel that could
		/// render nothing: a dead gutter beside the chat, with no chip to close it,
		/// because an unrevealed panel draws none.
		function reveal(id) {
			if (revealed(id)) return false;
			markUsed(id);
			return true;
		}

		/// Go to a panel: open it if it is shut, and leave it where it is if it is not.
		///
		/// This is NOT [`activate`], and the difference is the difference between a chip and a
		/// search result. A chip is a toggle and says so by being filled in -- you can see the
		/// panel is open, so clicking it can only mean "put it away". You reach the palette by
		/// typing a panel's NAME, which can only mean "take me there"; a search that closes the
		/// thing you searched for punishes you for using it. The bug this fixes: Ctrl-K, "Email",
		/// Enter closed the Email panel you were looking at.
		function goTo(id) {
			if (reveal(id)) {
				open[id] = false;                              // so show() seats it afresh
				stage = stage.filter(function (x) { return x !== id; });
				dock  = dock.filter(function (x) { return x !== id; });
				show(id);
				return;
			}
			if (open[id] && seated(id)) {
				// Already on screen -- and seated, or the palette would keep landing on the same
				// dead state `show` was taught to repair. A folded rail is the one case where
				// "take me there" still has
				// something to do; otherwise the layout is left exactly as it was.
				if (id === 'rail' && !railForced && window.innerWidth < NARROW) {
					railForced = true;
					apply();
				}
				markUsed(id);
				return;
			}
			show(id);
		}

		function activate(id) {
			var railFolded = (id === 'rail') && open.rail
				&& window.innerWidth < NARROW && !railForced;
			if (railFolded) { railForced = true; apply(); return; }
			// It SHOWS rather than toggles: the panel was off screen whatever the
			// engine believed about it, so the only thing the request can mean is
			// "let me see it".
			if (reveal(id)) {
				open[id] = false;                              // so show() seats it afresh
				stage = stage.filter(function (x) { return x !== id; });
				dock  = dock.filter(function (x) { return x !== id; });
				show(id);
				return;
			}
			toggle(id);
		}

		/// Draw the row. The renderer lives in workspace.js, which owns the chip
		/// row, the gallery and the palette together; the engine keeps only the
		/// fallback, so a failure to load that file costs the chips their grouping
		/// rather than the ability to reach a panel at all.
		function renderTags() {
			if (!tagsEl) return;
			if (window.DaimondWorkspace && DaimondWorkspace.renderTags) {
				DaimondWorkspace.renderTags(tagModel());
				return;
			}
			tagsEl.innerHTML = '';
			tagModel().panels.forEach(function (p) {
				if (p.hidden || (p.open && !p.folded)) return;
				var b = document.createElement('button');
				b.className = 'ptag ptag-' + p.zone;
				b.textContent = p.label;
				b.dataset.panel = p.id;
				b.disabled = p.full;
				b.addEventListener('click', function () { activate(p.id); });
				tagsEl.appendChild(b);
			});
		}

		/// Open a panel in its own zone. A stage panel takes the free seat, or
		/// evicts the other guest — never the AI, which is what one is talking to.
		function show(id) {
			if (!def(id)) return;
			// Before anything else, and before the already-open shortcut below: an
			// asked-for panel that is still suppressed must be let out first, or it
			// is seated where nothing can be seen. Ahead of the shortcut so that a
			// layout ALREADY carrying this state -- saved by a version that had the
			// bug -- heals the first time anything asks for the panel again.
			reveal(id);
			// Already open in the engine, but on a phone that does not mean it is on
			// screen: a guest is only visible while it is the one in the sheet. So
			// re-present it — this is why the guide "?" (which shows the Web panel,
			// open by default) did nothing on a phone.
			// And "open" is not "seated". A layout or a per-Diamond arrangement can carry
			// `open.web` with the stage's seats already spoken for, and `seatOpenPanels` then has
			// nowhere to put it: nothing draws the panel, nothing chips it -- a chip is for a
			// CLOSED panel -- and this shortcut returned. So `web_open` revealed nothing and a
			// real browser window was the whole of what the user saw. A panel with no seat is not
			// open, whatever the flag says.
			if (open[id] && seated(id)) { if (isMobile()) mshow(id); return; }
			var zone = zoneOf(id);
			if (zone === 'stage') {
				if (stage.length >= STAGE_MAX) {
					var evict = stage.filter(function (x) { return x !== 'ai'; })[0];
					if (evict) { open[evict] = false; stage = stage.filter(function (x) { return x !== evict; }); }
					else stage = stage.slice(0, STAGE_MAX - 1);
				}
				stage.push(id);
			} else if (zone === 'dock') {
				if (dock.length >= dockMax()) return;          // no room; the chip says so
				dock.push(id);
			}
			open[id] = true;
			markUsed(id);
			apply();
			if (id === 'work') Files.onOpen();
			if (id === 'mail' && window.DaimondMail) DaimondMail.onOpen();
			if (id === 'spend' && window.DaimondSpend) DaimondSpend.onOpen();
			// The terminal is built on the first open and started there: a pty is a
			// real program on the user's machine, so it begins when a person asks
			// for one and not when the app loads.
			if (id === 'term' && window.DaimondTerm) DaimondTerm.onOpen();
			if (isMobile()) mshow(id);
		}

		function hide(id) {
			if (!def(id) || !open[id]) return;
			// Before the panel goes: the program is asked to stop and the screen is
			// destroyed. A canvas repainting into a hidden panel costs a frame every
			// time the program prints, and a session nobody can see is one nobody
			// can stop.
			if (id === 'term' && window.DaimondTerm) DaimondTerm.onClose();
			open[id] = false;
			if (id === 'rail') railForced = false;   // a closed rail is not a forced one
			stage = stage.filter(function (x) { return x !== id; });
			dock  = dock.filter(function (x) { return x !== id; });
			apply();
			// Closing the page you were watching should put you back with the daimon,
			// not on an empty screen.
			if (isMobile() && document.body.dataset.mpanel === id) mshow('ai');
			// If the thing was up as a sheet, take the sheet down with it.
			if (isMobile() && window.DaimondSheet) DaimondSheet.onEngineHide(id);
		}

		function toggle(id) { isOpen(id) ? hide(id) : show(id); }

		// ── Resizing ──────────────────────────────────────────
		function bindHandle(handle, key) {
			if (!handle) return;
			var startX = 0, startW = 0, dragging = false;
			handle.addEventListener('pointerdown', function (e) {
				dragging = true; startX = e.clientX; startW = widths[key];
				handle.setPointerCapture(e.pointerId);
				document.body.classList.add('resizing');
			});
			handle.addEventListener('pointermove', function (e) {
				if (!dragging) return;
				// The rail grows rightwards; the dock grows leftwards.
				var dx = (key === 'rail') ? (e.clientX - startX) : (startX - e.clientX);
				// `widths.dock` is ONE column's width, and the dock is that times the
				// columns it draws -- so the drag is spread over them. Three columns
				// each given the whole of it would move the edge three times as far as
				// the hand holding it.
				var per = (key === 'dock') ? dockCols() : 1;
				widths[key] = Math.max(MIN_W[key], startW + dx / per);
				apply();
			});
			handle.addEventListener('pointerup', function (e) {
				dragging = false;
				handle.releasePointerCapture(e.pointerId);
				document.body.classList.remove('resizing');
				save();
			});
			handle.addEventListener('dblclick', function () {
				widths[key] = key === 'rail' ? 320 : 300;
				apply();
			});
		}

		/// The stage's own divider: it moves a boundary between two panels rather
		/// than the width of one.
		function bindSeat(handle) {
			if (!handle) return;
			var startX = 0, startW = 0, dragging = false;
			handle.addEventListener('pointerdown', function (e) {
				var first = elOf(stage[0]);
				if (!first) return;
				dragging = true;
				startX = e.clientX;
				startW = first.getBoundingClientRect().width;
				handle.setPointerCapture(e.pointerId);
				handle.classList.add('dragging');
				document.body.classList.add('resizing');
			});
			handle.addEventListener('pointermove', function (e) {
				if (!dragging || !stageEl) return;
				var w = stageEl.clientWidth;
				if (!w) return;
				seat = Math.max(0, Math.min(1, (startW + (e.clientX - startX)) / w));
				applySeat();
			});
			handle.addEventListener('pointerup', function (e) {
				dragging = false;
				handle.releasePointerCapture(e.pointerId);
				handle.classList.remove('dragging');
				document.body.classList.remove('resizing');
				save();
			});
			handle.addEventListener('dblclick', function () { seat = 0.5; applySeat(); save(); });
		}

		// ── The rail's split ──────────────────────────────────
		// The handle that moves a boundary rather than a width. The Admin panel
		// grows upwards, so a downward drag shrinks it.
		function bindSplit(handle) {
			if (!handle) return;
			var startY = 0, startH = 0, dragging = false;
			handle.addEventListener('pointerdown', function (e) {
				var bot = document.getElementById('admin');
				if (!bot) return;
				dragging = true;
				startY = e.clientY;
				startH = bot.getBoundingClientRect().height;
				handle.setPointerCapture(e.pointerId);
				handle.classList.add('dragging');
				document.body.classList.add('resizing-v');
			});
			handle.addEventListener('pointermove', function (e) {
				if (!dragging) return;
				var railEl = elOf('rail');
				var h = railEl ? railEl.clientHeight : 0;
				if (!h) return;
				split = Math.max(0, Math.min(1, (startH - (e.clientY - startY)) / h));
				applySplit();
			});
			handle.addEventListener('pointerup', function (e) {
				dragging = false;
				handle.releasePointerCapture(e.pointerId);
				handle.classList.remove('dragging');
				document.body.classList.remove('resizing-v');
				save();
			});
			handle.addEventListener('dblclick', function () { split = 0.5; applySplit(); save(); });
		}

		// ── The divider between Diamonds and Chats ────────────
		// The same idiom as the pane handles: pointer capture so the drag survives
		// leaving the 10px strip, a proportion rather than a pixel height, and a
		// double-click back to even.
		function bindRailSplit(handle) {
			if (!handle) return;
			var startY = 0, startH = 0, dragging = false;
			handle.addEventListener('pointerdown', function (e) {
				var r = railRoom();
				if (!r) return;
				dragging = true;
				startY = e.clientY;
				startH = r.held;
				handle.setPointerCapture(e.pointerId);
				handle.classList.add('dragging');
				document.body.classList.add('resizing-v');
			});
			handle.addEventListener('pointermove', function (e) {
				if (!dragging) return;
				var r = railRoom();
				if (!r || r.room <= 0) return;
				railSplit = Math.max(0, Math.min(1, (startH + (e.clientY - startY)) / r.room));
				applyRailSplit();
			});
			handle.addEventListener('pointerup', function (e) {
				dragging = false;
				handle.releasePointerCapture(e.pointerId);
				handle.classList.remove('dragging');
				document.body.classList.remove('resizing-v');
				save();
			});
			handle.addEventListener('dblclick', function () { railSplit = 0.5; applyRailSplit(); save(); });
		}

		// ── The dividers between stacked dock panels ──────────
		/// The boundary between the i-th and (i+1)-th panel of a column.
		///
		/// It moves that boundary and no other: what the panel above gains, the
		/// one below gives up, and the rest of the column is left exactly where it
		/// is. The heights are read at pointerdown and the drag is arithmetic on
		/// them, so a column of three does not shuffle under the hand.
		function bindStack(handle, colId, i) {
			var ids = null, base = null, room = 0, startY = 0, dragging = false;
			handle.addEventListener('pointerdown', function (e) {
				var s = seatOf(colId);
				if (!s || i + 1 >= s.ids.length) return;
				var px = s.ids.map(function (id) {
					var el = elOf(id);
					return el ? el.getBoundingClientRect().height : 0;
				});
				room = px.reduce(function (a, b) { return a + b; }, 0);
				if (room <= 0) return;
				ids = s.ids.slice(); base = px; startY = e.clientY; dragging = true;
				handle.setPointerCapture(e.pointerId);
				handle.classList.add('dragging');
				document.body.classList.add('resizing-v');
			});
			handle.addEventListener('pointermove', function (e) {
				if (!dragging) return;
				// Clamped on the way in rather than after the fact, so holding the
				// pointer far past the end of the column and coming back does not
				// have to unwind a share that was never legal.
				var dy = Math.max(MIN_H.stack - base[i],
					Math.min(e.clientY - startY, base[i + 1] - MIN_H.stack));
				var px = base.slice();
				px[i] += dy; px[i + 1] -= dy;
				stacks[stackKey(ids)] = px.map(function (v) { return v / room; });
				applyStacks();
			});
			handle.addEventListener('pointerup', function (e) {
				if (!dragging) return;
				dragging = false;
				handle.releasePointerCapture(e.pointerId);
				handle.classList.remove('dragging');
				document.body.classList.remove('resizing-v');
				save();
			});
			// The whole column back to even, not just this pair: with three panels
			// the pair alone leaves the column in a state nobody asked for, and
			// "reset" that resets some of it is worse than none.
			handle.addEventListener('dblclick', function () {
				var s = seatOf(colId);
				if (!s) return;
				delete stacks[stackKey(s.ids)];
				applyStacks();
				save();
			});
		}

		// ── Arrangements ──────────────────────────────────────
		// A Diamond can carry the arrangement it is worked in, so that returning to a
		// piece of work restores the panels it needs rather than making them be
		// reassembled by hand. It is saved DELIBERATELY and never inferred: a
		// switch that silently closed panels would read as work being lost.

		/// Capture the current arrangement under a Diamond's id.
		function saveArrangement(diamondId) {
			if (!diamondId) return false;
			arrangements[diamondId] = {
				open: JSON.parse(JSON.stringify(open)),
				stage: stage.slice(), dock: dock.slice(),
				widths: { rail: widths.rail, dock: widths.dock },
				seat: seat, grid: grid,
			};
			save();
			return true;
		}

		function hasArrangement(diamondId) { return !!(diamondId && arrangements[diamondId]); }

		function forgetArrangement(diamondId) {
			if (!diamondId || !arrangements[diamondId]) return false;
			delete arrangements[diamondId];
			save();
			return true;
		}

		/// Put a saved arrangement back. Anything it names that no longer exists is
		/// skipped, so an arrangement saved before a panel was removed still opens.
		function restoreArrangement(diamondId) {
			var a = diamondId && arrangements[diamondId];
			if (!a) return false;
			if (a.open) { open = {}; Object.keys(a.open).forEach(function (k) { if (def(k)) open[k] = !!a.open[k]; }); }
			if (typeof a.grid === 'string' && (a.grid === 'auto' || GRIDS[a.grid])) grid = a.grid;
			stage = (a.stage || []).filter(function (id) { return def(id) && zoneOf(id) === 'stage' && open[id]; })
				.slice(0, STAGE_MAX);
			dock  = (a.dock  || []).filter(function (id) { return def(id) && zoneOf(id) === 'dock'  && open[id]; })
				.slice(0, dockMax());
			if (a.widths) { if (a.widths.rail) widths.rail = a.widths.rail; if (a.widths.dock) widths.dock = a.widths.dock; }
			if (typeof a.seat === 'number' && a.seat >= 0 && a.seat <= 1) seat = a.seat;
			seatOpenPanels();
			apply();
			return true;
		}

		function init() {
			mainEl  = document.getElementById('main');
			tagsEl  = document.getElementById('panel-tags');
			stageEl = document.getElementById('stage');
			dockEl  = document.getElementById('dock');
			// The stage's divider is built here rather than in the markup, because
			// it belongs between two occupants and only exists when there are two.
			var hs = document.createElement('div');
			hs.className = 'phandle';
			hs.id = 'handle-stage';
			hs.title = t('layout.handle');
			stageEl.appendChild(hs);

			scan();
			load();
			seatOpenPanels();
			bindHandle(document.getElementById('handle-rail'), 'rail');
			bindHandle(document.getElementById('handle-dock'), 'dock');
			bindSplit(document.getElementById('handle-split'));
			bindRailSplit(document.getElementById('handle-rail-split'));
			bindSeat(hs);
			// The split and the seat are pixel sizes cut from a proportion, so they
			// have to be recut whenever their container changes size. A window
			// resize is only one of the ways that happens, and the only one the
			// window tells us about.
			if (window.ResizeObserver) {
				var railEl = elOf('rail');
				if (railEl)  new ResizeObserver(applySplit).observe(railEl);
				if (stageEl) new ResizeObserver(applySeat).observe(stageEl);
				var railTop = document.getElementById('rail-top');
				if (railTop) new ResizeObserver(applyRailSplit).observe(railTop);
				// So is a stacked column's share of its column.
				if (dockEl) new ResizeObserver(applyStacks).observe(dockEl);
			}
			// Every panel's closer returns it to the header.
			document.querySelectorAll('[data-close]').forEach(function (b) {
				b.addEventListener('click', function () { hide(b.dataset.close); });
			});
			window.addEventListener('resize', function () {
				// Once the window is wide enough to hold the rail unforced, drop the
				// force so the auto-fold behaviour resumes cleanly at the next narrowing.
				if (window.innerWidth >= NARROW) railForced = false;
				apply();
			});
			apply();
		}

		return {
			init: init, show: show, hide: hide, toggle: toggle, isOpen: isOpen,
			reflow: apply, panels: function () { return PANELS.slice(); },
			/// Re-read every panel's name from the DOM and redraw what shows it.
			/// The names are markup, so a language change rewrites the attribute
			/// and this picks the new one up -- one registry, still the DOM.
			relabel: function () {
				PANELS.forEach(function (p) {
					var el = document.getElementById(p.el);
					if (el) p.label = el.dataset.label || el.dataset.panel;
				});
				apply();
			},
			zone: zoneOf,
			// The chip row, the gallery and the palette are all views of this.
			model: tagModel, activate: activate, goTo: goTo,
			markUsed: markUsed,
			grids: function () { return GRIDS; },
			grid: function () { return grid; },
			setGrid: setGrid,
			pins: function () { return pinned === null ? null : pinned.slice(); },
			isPinned: isPinned,
			/// Pin or unpin a panel. The first change turns the implicit "all of
			/// them" into a real list, so that unpinning one panel does not read as
			/// unpinning every panel at once.
			setPinned: function (id, on) {
				if (!def(id)) return;
				if (pinned === null) pinned = PANELS.map(function (p) { return p.id; });
				var i = pinned.indexOf(id);
				if (on && i === -1) pinned.push(id);
				if (!on && i !== -1) pinned.splice(i, 1);
				apply();
			},
			saveArrangement: saveArrangement,
			restoreArrangement: restoreArrangement,
			forgetArrangement: forgetArrangement,
			hasArrangement: hasArrangement,
		};
	})();
	// The Web driver is a separate script and has to be able to take the stage,
	// so the layout engine is the one piece of this module that is shared.
	window.DaimondPanels = DaimondPanels;

	// Which Diamond is being worked, for the surfaces that offer to act on it.
	window.DaimondDiamond = {
		current: function () { return currentDiamond ? { id: currentDiamond.id, name: currentDiamond.name } : null; },
		/// Which face of this Diamond is up: `'crystal'` or `'chat'`.
		view: function (id) { return diamondView(id || (currentDiamond && currentDiamond.id) || ''); },
		/// Offer the two default Diamonds. See `seedDefaultDiamonds`: the boot
		/// deliberately does not call this yet, because creating a Diamond blocks a
		/// legacy root from ever migrating. Published so the behaviour stays exercised
		/// and proven until the migration can merge, rather than rotting unused.
		seedDefaults: function () { return seedDefaultDiamonds(); },
		/// The daimon's own conversation record, made on first ask.
		///
		/// Published because it is the one part of a Diamond that is NOT reachable
		/// through the Diamonds list: it is a chat record with no tile, so anything
		/// outside this module that wants to know what a daimon has been told has no
		/// other way to find it.
		conversation: function (id) {
			var f = diamonds.find(function (x) { return x.id === id; })
				|| (currentDiamond && currentDiamond.id === id ? currentDiamond : null);
			return f ? daimonChat(f) : null;
		},
	};

	// The panel is reachable from the dock whether or not anything is running, but
	// the first Diamond-dispatched agent still OPENS it: that is the one moment
	// there is something to watch and nobody has asked to watch it yet. Once, and
	// remembered, so it never barges back over a panel the user chose instead.
	function revealAgents() {
		if (localStorage.getItem('daimond-agents-revealed') === '1') return;
		localStorage.setItem('daimond-agents-revealed', '1');
		if (!DaimondPanels.isOpen('agents')) DaimondPanels.show('agents'); else DaimondPanels.reflow();
		if (isMobile()) mshow('agents');
	}

	// ── Chat rendering ─────────────────────────────────────────
	var curAsstDiv = null;
	var curAsstText = '';

	// A hover-revealed copy button on a message, copying its raw text (never
	// the rendered HTML) to the clipboard.
	var COPY_SVG = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/></svg>';
	var TICK_SVG = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10"/></svg>';
	function addMsgCopy(div, text) {
		var btn = document.createElement('button');
		btn.className = 'msg-copy';
		btn.title = t('common.copy'); btn.setAttribute('aria-label', t('chat.copy_message'));
		btn.innerHTML = COPY_SVG;
		btn.addEventListener('click', function (e) {
			e.stopPropagation();
			var t = typeof text === 'function' ? text() : text;
			function flash() { btn.innerHTML = TICK_SVG; btn.classList.add('done'); setTimeout(function () { btn.innerHTML = COPY_SVG; btn.classList.remove('done'); }, 1200); }
			if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(flash, function () {});
		});
		div.appendChild(btn);
	}

	// ── Turns ──────────────────────────────────────────────────
	//
	// A turn is one thing you asked and everything that came back from it: the answer, and any
	// tool steps along the way. The thread is a flat list of messages, so the grouping is carried
	// as a number on each node -- every output written after a question belongs to that question,
	// until the next one. That number is what lets an answer be folded away behind the thing that
	// prompted it, and what lets a selected few turns be folded into a Diamond.
	var _turn = 0;

	// Where the walk back through the questions has got to. -1 means "at the bottom, not walking",
	// so the next jump lands on the most recent question.
	var _jumpAt = -1;

	// Select mode: the thread is collapsed to its questions and each carries a tick, so several
	// turns can be chosen and folded together.
	var _selectMode = false;

	// Bound once the DOM is up (see the chat header wiring).
	var collapseBtn = null;     // the − that collapses the thread and latches select mode
	var selectTools = null;     // Select all / Deselect all / Fold selected, shown only in select mode

	/// Tag a node with the turn it belongs to. Answers and tool steps carry the number of the
	/// question above them; the question carries its own.
	function tagTurn(node) {
		node.dataset.turn = String(_turn);
		return node;
	}

	/// Show or hide everything a question produced.
	///
	/// The question itself never hides -- hiding it would leave nothing to click to bring it back.
	function setTurnOpen(userDiv, open) {
		var n = userDiv.dataset.turn;
		userDiv.classList.toggle('collapsed', !open);
		var kids = chatOutput.querySelectorAll('[data-turn="' + n + '"]');
		for (var i = 0; i < kids.length; i++) {
			if (kids[i] === userDiv) continue;
			kids[i].style.display = open ? '' : 'none';
		}
	}
	function isTurnOpen(userDiv) {
		return !userDiv.classList.contains('collapsed');
	}
	function userDivs() {
		return chatOutput.querySelectorAll('.chat-msg-user');
	}

	/// Open or close every turn at once.
	function setAllTurnsOpen(open) {
		var us = userDivs();
		for (var i = 0; i < us.length; i++) setTurnOpen(us[i], open);
	}

	/// Enter or leave select mode.
	///
	/// Entering collapses the thread to its questions, which is the view you want in order to
	/// choose between them: a page of answers is not a list you can pick from. Leaving opens
	/// them again and clears the ticks, so the mode has no residue.
	function setSelectMode(on) {
		_selectMode = on;
		chatOutput.classList.toggle('selecting', on);
		// The header lends select mode its room (see .chead.selecting): with the model picker and
		// the running cost still in place, three new chips crush the chat's own name to "Ch…".
		var head = document.querySelector('.panel.ai .chead');
		if (head) head.classList.toggle('selecting', on);
		if (collapseBtn) collapseBtn.classList.toggle('on', on);
		if (selectTools) selectTools.style.display = on ? '' : 'none';
		setAllTurnsOpen(!on);
		if (!on) pickAll(false);
	}

	/// Tick or untick every question.
	function pickAll(on) {
		var us = userDivs();
		for (var i = 0; i < us.length; i++) {
			var box = us[i].querySelector('.turn-pick input');
			if (box) box.checked = on;
			us[i].classList.toggle('picked', on);
		}
	}

	/// The turns the user has ticked, as turn numbers.
	function pickedTurns() {
		var out = [], us = userDivs();
		for (var i = 0; i < us.length; i++) {
			var box = us[i].querySelector('.turn-pick input');
			if (box && box.checked) out.push(Number(us[i].dataset.turn));
		}
		return out;
	}

	/// Scroll so the question being walked to sits at the top of the thread.
	///
	/// Pressing again steps back to the one before it, which is the point: a very long answer is
	/// walked past by its heading, not scrolled through. A new question resets the walk, so the
	/// button always starts from the bottom of the conversation as it now stands.
	function jumpBack() {
		var us = userDivs();
		if (!us.length) return;
		_jumpAt = (_jumpAt < 0) ? us.length - 1 : Math.max(0, _jumpAt - 1);
		var el = us[_jumpAt];
		// Measured, not computed from offsetTop: the thread is not necessarily the offset parent.
		chatOutput.scrollTop += el.getBoundingClientRect().top - chatOutput.getBoundingClientRect().top;
	}

	/// Back to the bottom of the thread, where the conversation is.
	///
	/// The walk is reset as well as the scroll: having come back down, the next ↑
	/// starts again from the last question rather than from wherever the walk had
	/// got to, which is what a user who has just returned to the bottom means by it.
	function jumpEnd() {
		chatOutput.scrollTop = chatOutput.scrollHeight;
		_jumpAt = -1;
	}

	function appendUserMessage(text) {
		var div = document.createElement('div');
		div.className = 'chat-msg chat-msg-user';
		div.innerHTML = '<div class="chat-msg-content"></div>';
		div.querySelector('.chat-msg-content').textContent = text; // escaped
		_turn += 1;
		tagTurn(div);

		// The box is the switch for the answers below it. Its TEXT is still ordinary text you can
		// select -- so a click that ends a selection is a click that was selecting, not one that
		// meant to fold the answer away, and it is left alone.
		div.addEventListener('click', function (e) {
			if (e.target.closest('.msg-copy') || e.target.closest('.turn-pick')) return;
			var sel = window.getSelection();
			if (sel && String(sel).length) return;
			setTurnOpen(div, !isTurnOpen(div));
		});

		// The tick that says "fold this one". It only means anything in select mode, so it is only
		// there in select mode.
		var pick = document.createElement('label');
		pick.className = 'turn-pick';
		pick.innerHTML = '<input type="checkbox">';
		pick.title = t('chat.include_turn');
		pick.querySelector('input').addEventListener('click', function (e) {
			e.stopPropagation();                  // ticking a box is not a click on the box below it
			div.classList.toggle('picked', e.target.checked);
		});
		div.appendChild(pick);

		addMsgCopy(div, text);
		postToChat(div);
		chatOutput.scrollTop = chatOutput.scrollHeight;
		// A new question is a new place to jump back to, so the walk starts again from the bottom.
		_jumpAt = -1;
	}

	/// Draw a message that was said INTO a running turn, at the point it landed.
	///
	/// Where it is drawn is the whole point of it. A correction shown at the end,
	/// under the work it was meant to redirect, reads as one that was ignored;
	/// drawn here -- between the step that had just finished and the one that
	/// followed it -- it reads as what it was. So the assistant's text so far is
	/// closed off first, the same way a tool step closes it, and whatever the model
	/// says next begins a fresh bubble below this one.
	///
	/// It carries the CURRENT turn's number and is deliberately not
	/// `.chat-msg-user`: it belongs to the turn it cut into rather than starting one
	/// of its own, so folding that turn away takes it too, and the numbering a fold
	/// maps through is untouched.
	///
	/// The bubble is styled here rather than in the stylesheet only because this
	/// change did not own `app.css`; the rule belongs beside `.chat-msg-user`.
	function appendInterjected(text) {
		finalizeAssistant();
		var div = document.createElement('div');
		div.className = 'chat-msg chat-msg-interjected';
		div.style.textAlign = 'right';
		// The same small right-aligned caption the waiting bubbles wear, saying the
		// opposite thing: this one has arrived.
		var note = document.createElement('div');
		note.className = 'chat-queued-head';
		note.textContent = '↳ ' + t('chat.interjected');
		note.title = t('chat.interjected_help');
		var body = document.createElement('div');
		body.className = 'chat-msg-content';
		body.textContent = text;                     // escaped (H5)
		body.title = t('chat.interjected_help');
		body.style.display = 'inline-block';
		body.style.background = 'var(--accent-soft)';
		body.style.color = 'var(--accent-text)';
		body.style.borderRadius = 'var(--radius-lg)';
		body.style.borderLeft = '3px solid var(--accent)';
		body.style.padding = '8px 14px';
		body.style.maxWidth = '82%';
		body.style.textAlign = 'left';
		div.appendChild(note);
		div.appendChild(body);
		tagTurn(div);
		postToChat(div);
		if (nearBottom()) chatOutput.scrollTop = chatOutput.scrollHeight;
	}

	/// Draw the app's own edit of the conversation, where it happened.
	///
	/// Not a tool row: a fold is something Daimond did, not something the model
	/// called, and it is lossy. A user who is not shown one has no way to tell a
	/// model that forgot from a model that never knew.
	function appendCompacted(note) {
		finalizeAssistant();
		var div = document.createElement('div');
		div.className = 'chat-msg chat-msg-compacted';
		var head = document.createElement('div');
		head.className = 'chat-queued-head';
		head.textContent = '⊟ ' + t('chat.compacted');
		head.title = t('chat.compacted_help');
		var body = document.createElement('div');
		body.className = 'chat-msg-content';
		body.textContent = note;                     // escaped (H5)
		div.appendChild(head); div.appendChild(body);
		tagTurn(div); postToChat(div);
		if (nearBottom()) chatOutput.scrollTop = chatOutput.scrollHeight;
	}

	/// Put something into the thread, taking the placeholder away first.
	///
	/// `.empty-state` is `height:100%`, so anything appended while one is still
	/// on screen lands BELOW a full-height box: the thread opens scrolled past
	/// its own first message, with a screen of nothing above it. Every render
	/// path goes through here, so a path added later cannot forget.
	function postToChat(node) {
		var ph = chatOutput.querySelector('.empty-state');
		if (ph) ph.remove();
		// What is waiting to be sent stays at the bottom, under what has happened.
		var q = document.getElementById('chat-queued');
		if (q) chatOutput.insertBefore(node, q);
		else chatOutput.appendChild(node);
	}

	// True when the thread is scrolled to (near) the bottom, so streaming
	// auto-scroll can be suppressed while the user reads earlier output.
	function nearBottom() {
		return chatOutput.scrollHeight - chatOutput.scrollTop - chatOutput.clientHeight < 48;
	}

	var _asstRenderPending = false;
	function renderAsst() {
		_asstRenderPending = false;
		if (!curAsstDiv) return;
		var pinned = nearBottom();
		curAsstDiv.querySelector('.chat-msg-content').innerHTML = DaimondRender.md(curAsstText);	// sanitised (H5)
		if (pinned) chatOutput.scrollTop = chatOutput.scrollHeight;
	}
	function appendAssistantText(text) {
		if (!curAsstDiv) {
			curAsstDiv = document.createElement('div');
			curAsstDiv.className = 'chat-msg chat-msg-assistant';
			curAsstDiv.innerHTML = '<div class="chat-msg-content"></div>';
			tagTurn(curAsstDiv);
			postToChat(curAsstDiv);
			curAsstText = '';
		}
		curAsstText += text;
		// Throttle to one markdown re-render per frame: re-parsing the whole
		// message per token is O(n^2) and rebuilds code blocks/copy buttons.
		if (!_asstRenderPending) {
			_asstRenderPending = true;
			(window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(renderAsst);
		}
	}

	function finalizeAssistant() {
		if (curAsstDiv && curAsstText) {
			var pinned = nearBottom();
			curAsstDiv.querySelector('.chat-msg-content').innerHTML = DaimondRender.md(curAsstText);
			addMsgCopy(curAsstDiv, curAsstText);
			if (pinned) chatOutput.scrollTop = chatOutput.scrollHeight;
		}
		curAsstDiv = null; curAsstText = ''; _asstRenderPending = false;
	}

	var lastToolBlock = null;

	function renderToolCall(name, args) {
		finalizeAssistant();
		var block = document.createElement('div');
		block.className = 'tool-block running collapsed';
		var head = document.createElement('div');
		head.className = 'tool-head';
		head.textContent = '\u{1F527} ' + name;      // escaped via textContent
		head.addEventListener('click', function () { block.classList.toggle('collapsed'); });
		var argsPre = document.createElement('pre');
		argsPre.className = 'tool-args';
		argsPre.textContent = typeof args === 'string' ? args : JSON.stringify(args);
		var resPre = document.createElement('pre');
		resPre.className = 'tool-result';
		resPre.style.display = 'none';
		block.appendChild(head); block.appendChild(argsPre); block.appendChild(resPre);
		tagTurn(block);
		postToChat(block);
		lastToolBlock = block;
		chatOutput.scrollTop = chatOutput.scrollHeight;
	}

	// A tool returns its failure as `Error: …` text rather than rejecting, so
	// the result has to be read to know whether it worked. Rendering every
	// result as a success is how `Error: unknown tool 'spawn_agent'` came to
	// display as a green tick, and how raw fe2o3 frames reached the chat.
	function toolFailed(result) {
		return /^\s*Error\b/i.test(String(result || ''));
	}

	function renderToolResult(name, result) {
		var failed = toolFailed(result);
		if (lastToolBlock) {
			lastToolBlock.classList.remove('running');
			lastToolBlock.classList.toggle('failed', failed);
			var resPre = lastToolBlock.querySelector('.tool-result');
			// A tool that SUCCEEDS can be colourful too, so the plain path is
			// stripped as well; only the failing path went through friendlyError.
			resPre.textContent = failed ? friendlyError(result) : stripAnsi(result);   // escaped via textContent
			resPre.style.display = '';
		}
		chatOutput.scrollTop = chatOutput.scrollHeight;
	}

	/// The most a live command's output may occupy in the chat.
	///
	/// The whole of it is kept by the relay and bounded there; this is the
	/// smaller bound on what one DOM node holds, because a build that prints for
	/// ten minutes would otherwise grow a text node until the tab suffers for it.
	var RUN_LIVE_MAX = 16000;

	/// Show what a running command is printing, while it runs.
	///
	/// A tool result arrives in one blob, which is right for the model and wrong
	/// for a person: a `cargo test` says nothing for a minute and then says
	/// everything, and a still panel is indistinguishable from a hang. So the
	/// machine hand's output is written into the running tool block as it
	/// arrives, and `renderToolResult` replaces it with the finished result.
	function runLive(text) {
		if (!lastToolBlock || !lastToolBlock.classList.contains('running')) return;
		var pre = lastToolBlock.querySelector('.tool-result');
		if (!pre) return;
		lastToolBlock.classList.remove('collapsed');
		pre.style.display = '';
		var s = pre.textContent + String(text == null ? '' : text);
		if (s.length > RUN_LIVE_MAX) s = '… ' + s.slice(s.length - RUN_LIVE_MAX);
		pre.textContent = s;                 // escaped via textContent
		if (nearBottom()) chatOutput.scrollTop = chatOutput.scrollHeight;
	}

	function appendError(msg) {
		var div = document.createElement('div');
		div.className = 'chat-msg chat-msg-error';
		div.innerHTML = '<div class="chat-msg-content" style="color: var(--danger);"></div>';
		div.querySelector('.chat-msg-content').textContent = friendlyError(msg);
		tagTurn(div);
		postToChat(div);
		chatOutput.scrollTop = chatOutput.scrollHeight;
	}

	// Turn a raw error — which may be an ANSI-coloured fe2o3 `Outcome` chain
	// carrying `src/*.rs:line` frames — into one plain, user-facing sentence.
	// Terminal codes and internal source locations must never reach the DOM.
	// ── In-app dialogs ─────────────────────────────────────────
	// Daimond never uses window.prompt/confirm/alert. A native dialog is an OS
	// box with the origin in its title, styled nothing like the app, and it
	// blocks the whole page; it reads like a phishing prompt over a dark UI.
	// These are the in-app replacements: promise-based, escapable, focus-
	// trapped, and dismissed by Escape or the backdrop.

	/// Build a form's fields into `host`, and hand back the way to read them.
	/// The modal dialog and the settings pane both use this, so a form behaves
	/// the same wherever it is shown — there is one form, not two that drift.
	function buildForm(host, opts) {
		var inputs = {};
		var first  = null;
		var note   = document.createElement('div');
		note.className = 'dlg-note';
		(opts.fields || []).forEach(function (f) {
			var lab = document.createElement('label');
			lab.className = 'cfg-fieldlabel';
			lab.textContent = f.label || f.name;
			// A field whose label cannot say what happens if it is left alone carries the
			// sentence on hover instead, on both halves of the row.
			if (f.title) lab.title = f.title;
			host.appendChild(lab);

			// A `models` field is a pulldown of every model, grouped by provider, drawn by the
			// one function that draws every such pulldown. A form that asks which model to use
			// must offer the same list the tile does, or the two will come to disagree.
			if (f.kind === 'models') {
				var sel = document.createElement('select');
				sel.className = 'dlg-input dlg-select';
				if (f.title) { sel.title = f.title; sel.setAttribute('aria-label', f.title); }
				if (window.DaimondModels) DaimondModels.fillSelect(sel, f.provider || '', f.value || '');
				host.appendChild(sel);
				inputs[f.name] = sel;
				if (!first) first = sel;
				return;
			}

			var el = document.createElement('input');
			el.className = 'dlg-input';
			el.type = 'text';
			el.placeholder = f.placeholder || '';
			el.autocomplete = 'off';
			el.spellcheck = false;
			el.setAttribute('data-1p-ignore', '');
			el.setAttribute('data-lpignore', 'true');
			if (f.secret) installSecretMask(el, f.value || '');
			else el.value = f.value || '';
			if (f.hint) {
				el.addEventListener('input', function () { f.hint(el.value, inputs, note); });
			}
			host.appendChild(el);
			inputs[f.name] = el;
			if (!first) first = el;
		});
		host.appendChild(note);
		if (opts.onInit) opts.onInit(inputs, note);
		return {
			inputs: inputs,
			first:  first,
			note:   note,
			read:   function () {
				var vals = {};
				(opts.fields || []).forEach(function (f) {
					var el = inputs[f.name];
					// A models field answers with BOTH halves -- { provider, model } -- because a
					// model id alone does not say which key runs it.
					if (f.kind === 'models') {
						vals[f.name] = window.DaimondModels
							? DaimondModels.pick(el) : { provider: '', model: '' };
						return;
					}
					vals[f.name] = (f.secret ? getSecret(el) : el.value).trim();
				});
				return vals;
			},
		};
	}

	/// Keep Tab inside `card`, and pull it back if it is already outside.
	///
	/// Only controls that can ACTUALLY take focus count as stops on the way
	/// round: a disabled button, or one in the half of the card the current mode
	/// hides, is not one. Treating those as the last stop is what let Tab walk out
	/// of the change-passphrase dialog and into the app behind it.
	function keepFocusIn(card, e) {
		var f = [].filter.call(
			card.querySelectorAll('input,button,select,textarea,a[href],[tabindex]:not([tabindex="-1"])'),
			function (n) { return !n.disabled && n.getClientRects().length; });
		if (!f.length) return;
		var first = f[0], last = f[f.length - 1];
		// Outside already -- because whatever was focused on opening could not take
		// it. The next Tab belongs in the dialog, not behind it.
		if (!card.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
		if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
	}

	function dialog(opts) {
		return new Promise(function (resolve) {
			var back = document.createElement('div');
			back.className = 'modal dlg';
			var card = document.createElement('div');
			card.className = 'modal-card dlg-card';

			var h = document.createElement('h2');
			h.textContent = opts.title || '';
			card.appendChild(h);

			if (opts.message) {
				var p = document.createElement(opts.pre ? 'pre' : 'p');
				p.className = opts.pre ? 'dlg-pre' : 'dlg-msg';
				p.textContent = opts.message;            // escaped
				card.appendChild(p);
			}

			var input = null;
			var form = null;
			if (opts.kind === 'prompt') {
				input = document.createElement('input');
				input.className = 'dlg-input';
				input.type = 'text';
				input.placeholder = opts.placeholder || '';
				// A passphrase must not sit on screen in the clear. Daimond masks
				// secrets itself (a text field with bullets) rather than using
				// type=password, so no password manager offers to save it.
				if (opts.secret) installSecretMask(input, opts.value || '');
				else input.value = opts.value || '';
				card.appendChild(input);
			}
			if (opts.kind === 'form') {
				form = buildForm(card, opts);
				input = form.first;
			}

			var err = document.createElement('div');
			err.className = 'dlg-err';
			card.appendChild(err);

			var row = document.createElement('div');
			row.className = 'dlg-actions';
			var cancel = null;
			if (opts.cancelLabel !== null) {
				cancel = document.createElement('button');
				cancel.type = 'button';          // never submit an enclosing form
				cancel.className = 'modal-close dlg-cancel';
				cancel.textContent = opts.cancelLabel || 'Cancel';
				row.appendChild(cancel);
			}
			var ok = document.createElement('button');
			ok.type = 'button';
			ok.className = 'dlg-ok' + (opts.danger ? ' danger' : '');
			ok.textContent = opts.okLabel || 'OK';
			row.appendChild(ok);
			card.appendChild(row);

			back.appendChild(card);
			document.body.appendChild(back);

			var prev = document.activeElement;
			function close(value) {
				document.removeEventListener('keydown', onKey, true);
				back.remove();
				if (prev && prev.focus) { try { prev.focus(); } catch (e) { /* gone */ } }
				resolve(value);
			}
			async function submit() {
				if (opts.kind === 'form') {
					var vals = form.read();
					var bad2 = opts.validate ? await opts.validate(vals) : '';
					if (bad2) { err.textContent = bad2; return; }
					return close(vals);
				}
				if (opts.kind !== 'prompt') return close(true);
				var v = (opts.secret ? getSecret(input) : input.value).trim();
				// A validator returns an error string, or nothing when happy. It
				// may be async (checking a passphrase means deriving a key).
				var bad = opts.validate ? await opts.validate(v) : (v ? '' : 'Enter a name.');
				if (bad) { err.textContent = bad; input.focus(); return; }
				close(v);
			}
			function onKey(e) {
				var nullish = (opts.kind === 'prompt' || opts.kind === 'form') ? null : false;
				if (e.key === 'Escape') { e.preventDefault(); close(nullish); }
				else if (e.key === 'Enter' && (opts.kind === 'prompt' || opts.kind === 'form')) {
					e.preventDefault(); submit();
				}
				else if (e.key === 'Tab') keepFocusIn(card, e);
			}
			document.addEventListener('keydown', onKey, true);
			back.addEventListener('mousedown', function (e) {
				if (e.target === back) close((opts.kind === 'prompt' || opts.kind === 'form') ? null : false);
			});
			if (cancel) cancel.addEventListener('click', function () {
				close((opts.kind === 'prompt' || opts.kind === 'form') ? null : false);
			});
			ok.addEventListener('click', submit);

			(input || ok).focus();
			if (input) input.select();
		});
	}

	/// Ask the user to confirm. Resolves true when they do.
	function confirmDialog(message, okLabel, opts) {
		opts = opts || {};
		return dialog({
			kind: 'confirm',
			title: opts.title || t('dlg.are_you_sure'),
			message: message,
			okLabel: okLabel || t('dlg.ok'),
			cancelLabel: opts.cancelLabel,        // a caller may rename the second button.
			danger: opts.danger !== false,
		});
	}

	/// Ask the user for a line of text. Resolves the string, or null if cancelled.
	function promptDialog(title, opts) {
		opts = opts || {};
		return dialog({
			kind: 'prompt',
			title: title,
			message: opts.message || '',
			value: opts.value || '',
			placeholder: opts.placeholder || '',
			okLabel: opts.okLabel || 'OK',
			validate: opts.validate,
			secret: !!opts.secret,
			danger: false,
		});
	}

	/// Tell the user something. Resolves when they dismiss it.
	function noticeDialog(title, message, opts) {
		opts = opts || {};
		return dialog({ kind: 'notice', title: title, message: message, okLabel: 'OK',
			danger: false, cancelLabel: null, pre: !!opts.pre })
			.then(function () { return true; });
	}

	// ── Reaching out, after reading a stranger's words ─────────
	// The agent reads web pages and email, and a page can carry instructions
	// aimed at the agent rather than at the reader. Marking that content as
	// untrusted tells the model what it is; it does not stop a model that goes
	// along with it anyway. What actually stops it is this: once a turn has taken
	// in content from outside, reaching a NEW destination needs the user.
	//
	// The channel being closed is a URL. Anything the agent knows can be written
	// into a path or a query string, so a fetch of
	// `https://somewhere/?notes=<your file>` is an exfiltration whatever the page
	// at the other end does with it.
	//
	// The gate is deliberately narrow. An untainted turn is never asked — the
	// wasm side does not even call this. A destination already approved is not
	// asked again. So ordinary browsing is untouched, and the prompt appears at
	// the one moment it means something.
	var _egressOk = Object.create(null);		// hosts approved for READING, this session.
	var _egressAct = Object.create(null);	// hosts approved for ACTING on, this session.

	function egressHost(url) {
		try { return new URL(String(url), location.href).host || ''; }
		catch (e) { return ''; }
	}

	// Approving a host cannot be the end of it. The channel being closed is the
	// URL itself, so "yes, you may read example.com" would otherwise license
	// every later `example.com/?everything-I-know=…` — the same exfiltration,
	// waved through on the strength of an answer about something else.
	//
	// But asking per exact URL would prompt on every page of a documentation
	// site, and a question asked that often stops being read. So the host is
	// approved for ORDINARY addresses, and an address carrying a payload is
	// asked about on its own terms, however familiar the host.
	var EGRESS_PAYLOAD_MAX = 120;			// characters of path, query and fragment.
	var EGRESS_BLOB = /[A-Za-z0-9+/=_-]{60,}/;	// one long unbroken run: encoded, not typed.

	/// The part of a URL that could be carrying data out, and whether it is more
	/// than an address plausibly needs.
	function egressPayload(url) {
		var u;
		try { u = new URL(String(url), location.href); }
		catch (e) { return { text: '', heavy: false }; }
		var tail = (u.pathname || '') + (u.search || '') + (u.hash || '');
		return {
			text:  tail,
			heavy: tail.length > EGRESS_PAYLOAD_MAX || EGRESS_BLOB.test(tail),
		};
	}

	/// Whether the agent may reach `url` now that this turn has read untrusted
	/// content. Resolves the string the wasm side expects.
	/// Put a permission mode into the engine, and prove it went in.
	///
	/// The engine's copy is the only one that decides anything, so this does not
	/// report success from the absence of a throw: it reads the mode back and
	/// refuses when the two disagree. Everything that can go wrong here — an older
	/// wasm with no such edge, a name this build does not know, a setter that took
	/// and did not stick — ends the same way, with the caller told nothing changed
	/// and the chip redrawn from what is actually in force.
	///
	/// # Arguments
	/// * `name` - The mode's name, as the Rust `Mode::name` spells it.
	function applyPermissionMode(name) {
		if (!Wasm || typeof Wasm.set_permission_mode !== 'function') {
			throw new Error('This build of the engine has no permission ladder.');
		}
		Wasm.set_permission_mode(name);
		var now = (typeof Wasm.permission_mode === 'function') ? Wasm.permission_mode() : name;
		if (now !== name) {
			throw new Error('The engine is in ' + now + ', not ' + name + '.');
		}
		return now;
	}

	/// Confine a dispatched agent to one Diamond's workspace, and prove it went in.
	///
	/// **This is a security boundary and it is set from JavaScript, so it is read back.** A
	/// scope that throws and is ignored, or one that silently fails to take, leaves the agent
	/// with the reach of an ordinary workspace turn: its file tools may open anything in the
	/// workspace, and — because both doors read the one bound list — its commands are fenced to
	/// the whole folder the user granted the machine hand rather than to this Diamond's part of
	/// it. That is failing open, so it throws rather than returning false, and the caller does
	/// not start a turn on a scope it could not establish.
	///
	/// The same discipline as `applyPermissionMode`: set it, ask the engine what it now holds,
	/// and refuse on disagreement.
	///
	/// # Arguments
	/// * `app` - The freshly built DaimondApp.
	/// * `diamondId` - The Diamond this agent works for.
	async function scopeAgentTo(app, diamondId) {
		if (!app || typeof app.set_diamond_scope !== 'function'
			|| typeof app.diamond_scope !== 'function') {
			throw new Error('This build of the engine cannot confine an agent to a Diamond.');
		}
		if (!diamondId) {
			throw new Error('An agent was dispatched without a Diamond to work in.');
		}
		var b = await Files.bounds(diamondId);
		if (!b.own_dir) {
			throw new Error('That Diamond has no directory, so there is nothing to confine it to.');
		}
		app.set_diamond_scope(
			b.own_dir,
			JSON.stringify(b.attached  || []),
			JSON.stringify(b.read_only || []),
			JSON.stringify(b.toolkits  || []));

		// What the engine actually holds now. Compared rather than trusted: everything that can
		// go wrong here is silent, and every silent failure is in the direction of more reach.
		var got = {};
		try { got = JSON.parse(app.diamond_scope() || '{}') || {}; }
		catch (e) { throw new Error('The engine could not say what this agent is confined to.'); }
		if (got.nowhere) {
			throw new Error('That Diamond\'s workspace named no usable folder, so an agent in it '
				+ 'could not touch anything.');
		}
		var allow = Array.isArray(got.allow) ? got.allow : [];
		if (!allow.length) {
			throw new Error('The scope did not take: this agent is not confined to anything.');
		}
		if (allow.indexOf(b.own_dir) < 0) {
			throw new Error('The scope took, but not for this Diamond: the engine holds '
				+ allow.join(', ') + ' and not ' + b.own_dir + '.');
		}
		// A toolkit the user granted and the engine dropped is a grant that will not work, and
		// the daimon is about to be TOLD it has that toolchain. Better to say so than to let it
		// meet a refusal it can do nothing about.
		var want = (b.toolkits || []).slice().sort().join(',');
		var have = (Array.isArray(got.toolkits) ? got.toolkits : []).slice().sort().join(',');
		if (want !== have) {
			throw new Error('This Diamond is granted ' + (want || 'no toolchain')
				+ ', but the engine took ' + (have || 'none') + '.');
		}
		return got;
	}

	async function egressAllowed(payloadJson) {
		var req = {};
		try { req = JSON.parse(String(payloadJson || '{}')) || {}; } catch (e) { req = {}; }
		// A command is not a destination. It arrives through this door because it
		// is the same question — may this act happen — and the door already owns
		// the dialog, the translations and the focus handling. It is answered
		// FIRST, above the URL work below, which would read a command line as an
		// address it cannot parse and deny every command in the ask mode.
		if (req.tool === 'run') {
			var cmd = String(req.url || '');
			if (!cmd.trim()) return 'deny';
			// Cut to the same 300 characters every other body in this function is cut to.
			// A command line is `argv.join(" ")` and the model chose every word of it, so an
			// uncapped one is a dialog whose buttons can be pushed off the screen and whose
			// operative argument can be buried under a screenful of padding — in the ONE dialog
			// that authorises a program to run on the user's machine. Shown with an ellipsis
			// rather than silently trimmed: a reader has to be able to tell that there is more,
			// and "the rest of it is not on screen" is itself a reason to say no.
			var shownCmd = cmd.length > 300 ? (cmd.slice(0, 300) + '…') : cmd;
			var okRun = await confirmDialog(
				t('permmode.run_body', { cmd: shownCmd, cwd: String(req.detail || '').slice(0, 300) }),
				t('permmode.run_ok'),
				{ title: t('permmode.run_title'), danger: false });
			return okRun ? 'allow' : 'deny';    // never remembered: every time means every time.
		}
		var url  = String(req.url || '');
		// An empty address must not be read as "here". `new URL('', href)` resolves
		// to the current page, whose host matches ours, so a missing url would have
		// been waved through as same-origin.
		if (!url.trim()) return 'deny';
		var host = egressHost(url);
		if (!host) return 'deny';						// unparseable: nothing to show the user.
		if (host === location.host) return 'allow';		// Daimond's own pages.

		// Typing into a page is not reading it. The text is the thing being sent, so
		// it is shown, and consent is for this one act — a form post is exactly the
		// exfiltration the gate exists to catch, and it must not become routine.
		if (req.tool === 'web_type') {
			var typed = String(req.detail || '');
			var shownText = typed.length > 300 ? (typed.slice(0, 300) + '…') : typed;
			var okType = await confirmDialog(
				t('egress.type_body', { host: host, text: shownText || t('egress.nothing') }),
				t('egress.type_ok'),
				{ title: t('egress.type_title', { host: host }), danger: true });
			return okType ? 'allow' : 'deny';		// never remembered.
		}
		// Clicking navigates, and a link's address is written by whoever wrote the
		// page. Acting on a page is approved separately from reading it: a yes about
		// reading a site is not a yes about operating it.
		if (req.tool === 'web_click') {
			if (_egressAct[host]) return 'allow';
			var okAct = await confirmDialog(
				t('egress.act_body', { host: host }),
				t('egress.act_ok', { host: host }),
				{ title: t('egress.act_title', { host: host }), danger: true });
			if (!okAct) return 'deny';
			_egressAct[host] = 1;
			return 'allow';
		}

		var load = egressPayload(url);
		if (_egressOk[host] && !load.heavy) return 'allow';	// approved, and nothing riding along.

		var ok;
		if (load.heavy) {
			// The address itself is the thing to look at, so show it — trimmed, but
			// enough of it to recognise a file's worth of text where a page name
			// should be.
			var shown = load.text.length > 300 ? (load.text.slice(0, 300) + '…') : load.text;
			ok = await confirmDialog(
				t('egress.heavy_body', { host: host, text: shown }),
				t('egress.heavy_ok'),
				{ title: t('egress.heavy_title', { host: host }), danger: true });
			return ok ? 'allow' : 'deny';		// deliberately NOT remembered.
		}
		ok = await confirmDialog(
			t('egress.reach_body', { host: host }),
			t('egress.reach_ok', { host: host }),
			{ title: t('egress.reach_title', { host: host }), danger: true });
		if (!ok) return 'deny';
		_egressOk[host] = 1;
		return 'allow';
	}

	// The wasm tools call this by name, exactly as the cloud bridge is called: an
	// agent's own tool calls are dispatched inside Rust, not through JS.
	window.__daimondEgressAllowed = function (payloadJson) { return egressAllowed(payloadJson); };

	// ── The Admin panel ────────────────────────────────────────
	// The lower pane of the rail: who you are, how Daimond is set up, and what it is
	// costing. Configuring Daimond is not a popup — the forms that ask the user for
	// something (a provider key, a mailbox) open HERE, with the chat still
	// running beside them, so the user can ask Daimond what an app password is and
	// read the answer while the box asking for one is on screen.
	//
	// It has a status header, which is always on, and a body showing one of
	// three views:
	//
	//   home      what it rests on: the account's own controls
	//   settings  the provider key and credits, reached by the cog
	//   form      built on demand, and gone again when it is answered
	//
	// A view that is finished with returns to home. Nothing stays on screen
	// after it has done its job — which is what a modal got right and what a
	// panel has to be told.
	//
	// Where there is no rail there is no panel, and no room for a chat beside a
	// form either: a phone, or the band where the rail folds away. There the
	// settings view is MOVED into a modal card and a form falls back to a
	// dialog. One settings form exists in the document; it changes host.
	var DaimondAdmin = (function () {
		var body, homeView, settingsView, creditsView, releaseView, pushView, formView, modal, slot, closeBtn;
		var adminWrap, titleEl;   // #admin (toggles .admin-open) and the drawer title
		var drawerOpen = false;
		// Which of the two forms is on screen. The panel used to hold one view (Settings, which
		// carried both the model and the credits); it now holds two, each reached from the status
		// row that names it, so the mover has to be told which one it is moving.
		var curView = null;
		var escaper = null;      // the current form's key handler

		/// Is the rail actually on screen? Not "is it open" — the rail folds
		/// itself away below 1280px, and on a phone it is one tab of four.
		function available() {
			var el = document.getElementById('panel-rail');
			return !!el && el.offsetParent !== null;
		}

		/// Put the open view back in the panel, and take the modal down.
		///
		/// Every view the modal can host, not just the two it started with: Version
		/// and a built form can be in there too, and one left behind in the slot is
		/// a view the panel can no longer show. The form goes back FIRST, because
		/// the others are inserted relative to it and `insertBefore` needs it to be
		/// a child of `body` already.
		function toPanel() {
			if (formView && formView.parentNode !== body) body.appendChild(formView);
			[settingsView, creditsView, releaseView, pushView].forEach(function (v) {
				if (v && v.parentNode !== body) body.insertBefore(v, formView);
			});
			modal.style.display = 'none';
		}
		/// The head the hosted view wears in the modal: what it is, and a × to close it.
		///
		/// The phone hides the modal's own heading and Close (mobile.css) because the
		/// view inside used to carry a header; the rail split moved that head outside
		/// the slot, leaving an untitled modal with no visible way out. This puts one
		/// back where the phone CSS already styles it.
		var modalHeadEl = null, modalHeadTitle = null;
		/// What the modal head's × does. Closing the drawer is right for a view; for
		/// a FORM it would abandon a promise the caller is still waiting on, so the
		/// form's own cancel is used instead and the answer is delivered.
		var headClose = null;
		function modalHead(title, onClose) {
			if (!modalHeadEl) {
				modalHeadEl = document.createElement('div');
				modalHeadEl.className = 'admin-view-head';
				modalHeadTitle = document.createElement('div');
				modalHeadTitle.className = 'admin-title';
				var x = document.createElement('button');
				x.type = 'button';
				x.className = 'admin-back';
				x.title = t('common.close');
				x.setAttribute('aria-label', t('common.close'));
				x.textContent = '×';
				x.addEventListener('click', function () { (headClose || closeAdmin)(); });
				modalHeadEl.appendChild(modalHeadTitle);
				modalHeadEl.appendChild(x);
			}
			headClose = onClose || null;
			modalHeadTitle.textContent = title || 'Admin';
			// Always first: the view is appended after it, and a re-open must not
			// leave the head stranded below the view it names.
			if (slot.firstChild !== modalHeadEl) slot.insertBefore(modalHeadEl, slot.firstChild);
		}

		/// Host the open view in the modal card, for a window with no rail in it.
		///
		/// A form brings a head of its own, but `#settings-slot .admin-view-head` is
		/// hidden by the desktop stylesheet, so in the modal the form would be
		/// nameless. The modal's head carries the name instead, with its × pointed
		/// at the form's cancel so backing out still answers the caller.
		function toModal(title, formMode) {
			var v = formMode ? formView : (curView || settingsView);
			modalHead(title, formMode ? cancelForm : null);
			slot.appendChild(v);
			v.style.display = '';
			modal.style.display = 'flex';
		}

		/// Back out of the built form the way its own × does, so the promise the
		/// caller is waiting on resolves to "cancelled" rather than never resolving.
		function cancelForm() {
			var back = formView && formView.querySelector('.admin-back');
			if (back) back.click();
			else closeAdmin();
		}
		function endForm() {
			if (escaper) { document.removeEventListener('keydown', escaper, true); escaper = null; }
			formView.innerHTML = '';
			formView.style.display = 'none';
		}

		/// Bring the Admin drawer into view on `title`. In form mode the drawer's
		/// own header is hidden, because the form supplies its own. Opening arms the
		/// click-away close.
		function showDrawer(title, formMode) {
			if (adminWrap) {
				adminWrap.classList.add('admin-open');
				adminWrap.classList.toggle('admin-form-mode', !!formMode);
			}
			if (titleEl) titleEl.textContent = title || 'Admin';
			if (!drawerOpen) {
				drawerOpen = true;
				// Defer, so the very click that opened the drawer does not close it.
				setTimeout(function () {
					if (drawerOpen) document.addEventListener('mousedown', outsideClose, true);
				}, 0);
			}
		}

		/// A click outside #admin dismisses the drawer. The Status rows and the cog
		/// are INSIDE #admin, so acting on them never trips this.
		///
		/// A dialog is not "outside". Dialogs are appended to `document.body`, so
		/// the drawer counted every click in one as a click away from itself: the
		/// user opened Admin, chose "Change name…", pressed Cancel, and the Admin
		/// drawer they had come from was gone behind it — along with the focus,
		/// since the button that opened the dialog was now inside a hidden view and
		/// could no longer take it back.
		function outsideClose(e) {
			if (!adminWrap || adminWrap.contains(e.target)) return;
			if (e.target && e.target.closest && e.target.closest('.modal, .pair-scrim, .pal-scrim')) return;
			closeAdmin();
		}

		/// Take the Admin drawer away — "finished". The rail is just the list and
		/// the Status strip again.
		function closeAdmin() {
			endForm();
			toPanel();                       // if it was in the modal, bring it back + drop it
			settingsView.style.display = 'none';
			if (creditsView) creditsView.style.display = 'none';
			// Version too. It was the one view nothing put away: the drawer closed
			// on it and re-opened with the whole release history still hanging below
			// whatever was asked for next.
			if (releaseView) releaseView.style.display = 'none';
			if (pushView) pushView.style.display = 'none';
			if (homeView) homeView.style.display = 'none';
			curView = null;
			if (adminWrap) adminWrap.classList.remove('admin-open', 'admin-form-mode');
			drawerOpen = false;
			document.removeEventListener('mousedown', outsideClose, true);
		}

		/// The resting menu, shown IN the open drawer: the account's controls and
		/// the way to connect a model. Reached by the cog, the identity row, or Back.
		function home() {
			endForm();
			toPanel();
			settingsView.style.display = 'none';
			if (creditsView) creditsView.style.display = 'none';
			if (releaseView) releaseView.style.display = 'none';
			if (pushView) pushView.style.display = 'none';
			curView = null;
			homeView.style.display = '';
			renderHome();
			showDrawer(t('drawer.admin'), false);
		}
		var closeModal = closeAdmin;

		/// Show the models. `note` is the reason the user was sent here — the message that used to
		/// be the modal's subtitle ("Connect a provider to start this chat").
		function settings(note) {
			endForm();
			homeView.style.display = 'none';
			if (creditsView) creditsView.style.display = 'none';
			if (releaseView) releaseView.style.display = 'none';
			if (pushView) pushView.style.display = 'none';
			curView = settingsView;
			settingsView.style.display = '';
			document.getElementById('byok-note').textContent = note || '';
			if (window.DaimondModels) DaimondModels.render();
			if (available()) { toPanel(); showDrawer(t('drawer.models')); }
			else toModal(t('drawer.models'));
		}

		/// Show what you are running, and what came before it. Reached from the
		/// status row that names the release, in the panel rather than over the
		/// top of the work, like everything else the Admin panel holds.
		function release() {
			endForm();
			homeView.style.display = 'none';
			settingsView.style.display = 'none';
			if (creditsView) creditsView.style.display = 'none';
			if (pushView) pushView.style.display = 'none';
			curView = releaseView;
			releaseView.style.display = '';
			if (window.DaimondRelease) DaimondRelease.render(document.getElementById('rel-list'));
			if (available()) { toPanel(); showDrawer(t('drawer.version')); }
			else toModal(t('drawer.version'));
		}

		/// Show the credits. They used to sit under the model settings, in one form that answered
		/// two unrelated questions; each is now reached from the status row that names it.
		function credits(note) {
			endForm();
			homeView.style.display = 'none';
			settingsView.style.display = 'none';
			if (releaseView) releaseView.style.display = 'none';
			if (pushView) pushView.style.display = 'none';
			curView = creditsView;
			creditsView.style.display = '';
			var n = document.getElementById('credits-note');
			if (n) n.textContent = note || '';
			renderCredits();
			if (window.DaimondCredits) DaimondCredits.render();
			// Again, AFTER renderCredits -- which blanks this line for an authed account, and
			// so wiped the caller's reason for sending the user here on the way in. Whoever
			// opened Credits said why; the drawer should still be saying it when it arrives.
			if (n && note) n.textContent = note;
			// The standing instruction to buy more credits belongs with the credits, not in a
			// settings page of its own: the question "what happens when these run out" is asked
			// while looking at how many are left.
			if (window.DaimondAutoReload) DaimondAutoReload.render();
			if (available()) { toPanel(); showDrawer(t('drawer.credits')); }
			else toModal(t('drawer.credits'));
		}

		/// Show the push credential: which host a push reaches, and the box to set it.
		///
		/// Its own view rather than a row in Models for the reason given in
		/// `index.html`: a token that writes to the user's repositories is not the
		/// same kind of secret as a key that buys tokens from a provider.
		function push() {
			endForm();
			homeView.style.display = 'none';
			settingsView.style.display = 'none';
			if (creditsView) creditsView.style.display = 'none';
			if (releaseView) releaseView.style.display = 'none';
			if (!pushView) return;
			curView = pushView;
			pushView.style.display = '';
			fillPushSettings();
			if (available()) { toPanel(); showDrawer(t('drawer.push')); }
			else toModal(t('drawer.push'));
		}

		/// The cog: open the Admin drawer on its menu, or close it if it is open.
		function toggleSettings() {
			if (drawerOpen) closeAdmin();
			else home();
		}

		/// Ask the user to fill something in. Resolves the values, or null if
		/// they backed out. The options are a dialog's options, so the fallback
		/// is the dialog itself.
		function form(opts) {
			if (!available()) return dialog(opts);
			var opener = document.activeElement;   // captured before anything moves it
			toPanel();
			showDrawer(opts.title || t('drawer.admin'), true);
			return new Promise(function (resolve) {
				homeView.style.display = 'none';
				settingsView.style.display = 'none';
				formView.innerHTML = '';
				formView.style.display = '';

				var head = document.createElement('div');
				head.className = 'admin-view-head';
				var title = document.createElement('div');
				title.className = 'admin-title';
				title.textContent = opts.title || '';
				var back = document.createElement('button');
				back.className = 'admin-back';
				back.title = t('common.cancel');
				back.textContent = '×';
				head.appendChild(title);
				head.appendChild(back);
				formView.appendChild(head);

				if (opts.message) {
					var p = document.createElement('p');
					p.className = 'dlg-msg';
					p.textContent = opts.message;              // escaped
					formView.appendChild(p);
				}

				var f = buildForm(formView, opts);

				var err = document.createElement('div');
				err.className = 'dlg-err';
				formView.appendChild(err);

				var row = document.createElement('div');
				row.className = 'dlg-actions';
				var cancel = document.createElement('button');
				cancel.type = 'button';
				cancel.className = 'modal-close dlg-cancel';
				cancel.textContent = opts.cancelLabel || 'Cancel';
				var ok = document.createElement('button');
				ok.type = 'button';
				ok.className = 'dlg-ok';
				ok.textContent = opts.okLabel || 'OK';
				row.appendChild(cancel);
				row.appendChild(ok);
				formView.appendChild(row);

				// Whatever opened this form is where the keyboard belongs when the
				// form is finished with. Left alone, focus fell to the document body
				// and the next Tab started again from the top of the app.
				function done(v) {
					closeAdmin();
					if (opener && opener.focus && opener.getClientRects().length) {
						try { opener.focus(); } catch (e) { /* gone with the drawer */ }
					}
					resolve(v);
				}
				async function submit() {
					var vals = f.read();
					var bad = opts.validate ? await opts.validate(vals) : '';
					if (bad) { err.textContent = bad; return; }
					done(vals);
				}
				escaper = function (e) {
					if (!formView.contains(document.activeElement)) return;
					if (e.key === 'Escape') { e.preventDefault(); done(null); }
					else if (e.key === 'Enter') { e.preventDefault(); submit(); }
				};
				document.addEventListener('keydown', escaper, true);
				back.addEventListener('click', function () { done(null); });
				cancel.addEventListener('click', function () { done(null); });
				ok.addEventListener('click', submit);

				if (f.first) { f.first.focus(); f.first.select(); }
			});
		}

		// ── Home ──────────────────────────────────────────────
		// The account's own controls. They used to be a floating menu anchored to
		// the user row; a panel that exists to hold them is a better home than a
		// popup that has to be dismissed.
		function renderHome() {
			if (!homeView) return;
			homeView.innerHTML = '';
			var idOn = window.DaimondIdentity && DaimondIdentity.exists() && DaimondIdentity.isUnlocked();

			// Daimond cannot run without a model, so say so where it can be fixed.
			if (!cfgReady(cfg)) {
				var cta = document.createElement('button');
				cta.className = 'admin-cta';
				cta.textContent = t('home.connect_model');
				cta.addEventListener('click', function () { openSettings(''); });
				homeView.appendChild(cta);
				homeView.appendChild(el('div', 'admin-note', t('home.connect_note')));
			}

			if (!idOn) {
				// An account that exists but is locked is not an account that
				// needs creating — the unlock card is already over the app.
				if (window.DaimondIdentity && DaimondIdentity.exists()) {
					homeView.appendChild(el('div', 'admin-note', t('home.locked')));
				} else if (identityAvailable()) {
					homeView.appendChild(el('div', 'admin-sec', t('home.sec_account')));
					item(t('home.create_account'), function () { showIdentity('create'); });
					homeView.appendChild(el('div', 'admin-note', t('home.account_note')));
				}
				// Offered here too, and not only to an account holder: the machine hand
				// and its git toolkit work with no identity at all, and a person who has
				// skipped the account screen still has repositories. What DIFFERS without
				// an account is only how long the token lasts, and the panel says so.
				pushSection();
				return;
			}

			homeView.appendChild(el('div', 'admin-sec', t('home.sec_account')));
			var fp = DaimondIdentity.fingerprint();
			if (fp) {
				var f = el('div', 'account-fp', fp);
				f.title = t('home.fingerprint');
				homeView.appendChild(f);
			}
			item(t('home.change_name'),       doRename);
			item(t('home.change_passphrase'), doChangePassphrase);
			// A passkey unlocks this device without the passphrase. Offer to add one
			// only where the platform supports it; offer to remove one once enrolled.
			if (window.DaimondPasskey) {
				if (DaimondPasskey.isEnrolled()) {
					item(t('home.remove_passkey'), doRemovePasskey);
				} else {
					var pk = item(t('home.add_passkey'), doAddPasskey);
					pk.style.display = 'none';
					DaimondPasskey.available().then(function (ok) { if (ok) pk.style.display = ''; }).catch(function () {});
				}
			}
			item(t('home.export_backup'), doExport);
			item(t('home.import_backup'), doImport);

			// The operator console, for the few accounts that hold a role on the
			// gateway. Added hidden and revealed by the answer, never drawn and
			// then removed: an item that appears and vanishes reads as a bug, and
			// an item everyone can see that most people cannot open is worse.
			// It opens in its own tab because it is a different job -- the app is
			// where you work, the console is where you run the service.
			if (window.DaimondGateway && DaimondGateway.operatorRole) {
				var op = item(t('home.dashboard'), function () {
					window.open('/console/', '_blank', 'noopener');
				});
				op.style.display = 'none';
				DaimondGateway.operatorRole().then(function (role) {
					if (!role) return;
					op.style.display = '';
					op.title = t('home.signed_in_as', { role: role });
				}).catch(function () {});
			}

			// How many devices this account is on. A question a local-first app
			// owes an answer to, and one nothing else on screen can answer: a
			// linked device holds the same keypair, so the gateway sees one user
			// and the pairing itself left no record anywhere.
			renderDevices();

			// The operator console, for the handful of accounts that hold a role.
			renderConsoleLink();

			// What each kind of agent is told, which is the user's to change.
			//
			// Only buttons here: this drawer is narrow, and a system prompt is a
			// page of prose. Each opens its file in the Doc panel, which is where
			// the app already edits text, with the room to do it in.
			homeView.appendChild(el('div', 'admin-sec', t('home.sec_prompts')));
			Prompts.roles.forEach(function (r) {
				// The role label is substituted as-is: lower-casing it mangled the
				// product noun ("diamond conductor") in every language at once,
				// and a locale table cannot defend itself against a transform.
				var b = item(t('home.edit_prompt', { role: t(r.label) }), function () {
					closeAdmin();                     // the Doc panel is behind this drawer
					Prompts.edit(r.id);
				});
				b.title = t(r.blurb) + ' ' + t('home.prompt_opens', { path: Prompts.path(r.id) });
			});
			homeView.appendChild(el('div', 'admin-note', t('home.prompts_note')));

			// Where a push goes, and the token it goes with.
			pushSection();

			// Several people can share this browser, each with their own account. Switching locks
			// this one first (its keys are forgotten), then reloads into the other.
			if (window.DaimondAccounts) {
				homeView.appendChild(el('div', 'admin-sec', t('home.sec_accounts')));
				var accts = DaimondAccounts.list();
				var cur = DaimondAccounts.current();
				accts.forEach(function (a) {
					if (a.id === cur) return;
					item(t('home.switch_to', { name: a.name || t('home.unnamed_account') }),
						function () { switchAccount(a.id); });
				});
				item(t('home.add_account'), addAccount);
				homeView.appendChild(el('div', 'admin-note', t('home.accounts_note')));
				homeView.appendChild(el('div', 'admin-sec', ''));
			}

			item(t('home.log_out'),         lockApp);
			item(t('identity.forget'),      forgetIdentity, true);

			function item(label, fn, danger) {
				var b = document.createElement('button');
				b.className = 'admin-item' + (danger ? ' danger' : '');
				b.textContent = label;
				b.addEventListener('click', fn);
				homeView.appendChild(b);
				return b;
			}

			/// The way through to the push credential, with the host it currently
			/// reaches written on the line.
			///
			/// Read from the ENGINE and not from what the page last saved, because those
			/// two differ in exactly the case this whole arrangement exists for: a reload
			/// empties the engine's copy, and a drawer drawn from storage would say a
			/// push was configured while every push was being refused.
			function pushSection() {
				homeView.appendChild(el('div', 'admin-sec', t('home.sec_push')));
				var held = pushHostHeld();
				var b = item(held ? t('home.push_to', { host: held }) : t('home.push_setup'),
					function () { push(); });
				b.title = t('home.push_help');
			}
		}

		/// The devices that sync this account: this one first, then the rest by
		/// how recently they were seen.
		///
		/// The one thing a row can DO is take a name. Pairing hands the second
		/// device the SAME keypair, so there is nothing here that a "remove" could
		/// enforce — the honest surface is a list, a sentence, and the one control
		/// that changes something real. The short id suffix stays even for a named
		/// device: it is what tells two lines apart while they are both still
		/// called "Chrome on macOS".
		function renderDevices() {
			var reg = collectDevices();		// reading it is also how this device joins it
			var self = deviceId();
			var ids = Object.keys(reg).sort(function (a, b) {
				var sa = a === self ? 1 : 0, sb = b === self ? 1 : 0;
				if (sa !== sb) return sb - sa;
				return reg[b].seen - reg[a].seen;
			});
			if (!ids.length) return;
			homeView.appendChild(el('div', 'admin-sec', t('home.sec_devices')));
			ids.forEach(function (id) {
				var d = reg[id], r = el('div', 'device-row');
				var shown = deviceShownName(d);
				r.appendChild(el('span', 'device-name', shown));
				r.appendChild(el('span', 'device-id', id.slice(-4)));
				r.appendChild(el('span', 'device-when',
					id === self ? t('devices.this_device') : relTime(d.seen)));
				// Every row, not only this device's: the name carries a stamp of
				// its own, so one typed here reaches the device it names.
				var b = document.createElement('button');
				b.className = 'device-rename';
				b.type = 'button';
				b.textContent = '✎';		// a pencil, matching the drawer's line icons
				b.title = t('devices.rename_aria', { name: shown });
				b.setAttribute('aria-label', b.title);
				b.addEventListener('click', function () { askDeviceName(id); });
				r.appendChild(b);
				homeView.appendChild(r);
			});
			homeView.appendChild(el('div', 'admin-note',
				ids.length > 1 ? t('devices.note') : t('devices.only_this')));
		}

		/// A way through to the operator console, for accounts that hold a role.
		///
		/// Shown to role-holders ONLY, and the reason is not that the console is
		/// secret. It is served at a guessable path, its script is public, and the
		/// gate is decided server-side by the gateway; a link changes who bothers
		/// to look, not who gets in. What a link for everybody WOULD do is teach
		/// every user the shape of a phishing script -- "Daimond has an admin
		/// console, and the way in is to copy your account id out of a card and
		/// send it to someone" -- and put a door in front of the overwhelming
		/// majority that they cannot open, which this app's own history says gets
		/// read as a fault rather than as a boundary.
		///
		/// The role is asked for lazily, when the drawer opens, so an account that
		/// will never hold one pays nothing at launch. The answer decides a link
		/// and nothing else: every action inside the console is authorised by the
		/// gateway on its own, and a client that lied to itself here would gain
		/// exactly one useless hyperlink.
		// What the gateway last said about this account, and whether that answer
		// is worth keeping:
		//   null    nobody has asked yet
		//   'none'  asked, answered: this account holds no role
		//   'error' asked, and the ASK failed — not an answer, and must not be
		//           remembered as one
		//   <role>  asked, answered: the role held
		//
		// The distinction is the whole of it. An earlier version latched any
		// non-answer as "no role" for the life of the page, and the very first
		// ask happens while the drawer is drawn at boot — before the session
		// exists, so it 401s. The gateway was answering correctly the whole
		// time and the drawer had already decided never to ask again.
		var consoleRole = null;
		var consoleAsking = false;
		function renderConsoleLink() {
			// An account with no role gets no link and no repeat questions.
			if (consoleRole === 'none') return;
			if (consoleRole === null || consoleRole === 'error') {
				// Only worth asking once the session it rides actually exists.
				if (!(window.DaimondIdentity && DaimondIdentity.isUnlocked())) return;
				if (consoleAsking) return;
				consoleAsking = true;
				// Through `gwFetch`, which is the one copy of the 401 rule: a session
				// lives an hour, this drawer is opened long after that, and a bare fetch
				// answered its own 401 by remembering 'error' and asking again on the
				// next draw -- against a session that nothing here was renewing. It
				// self-heals, but only when something ELSE takes a session again, so a
				// role-holder could open the drawer all afternoon and never see the link.
				// `/api/admin` is neither an auth path nor one a bootstrap makes itself
				// (see isBootstrapOwn), so the renewal is allowed; and `whoami` takes the
				// session before it does anything, so the retry cannot repeat a side
				// effect the first attempt never had.
				DaimondGateway.gwFetch('/api/admin?view=whoami', {
					credentials: 'same-origin',
					headers: { 'x-daimond-api': '1' },
				}).then(function (r) {
					// A 401 or 403 is the gateway declining to say, not a No.
					if (!r.ok) throw new Error('HTTP ' + r.status);
					return r.json();
				}).then(function (j) {
					consoleAsking = false;
					consoleRole = (j && j.role) ? j.role : 'none';
					if (consoleRole !== 'none') renderHome();
				}).catch(function () {
					// Offline, no gateway, or not signed in yet: ask again next
					// time the drawer is drawn, rather than never.
					consoleAsking = false;
					consoleRole = 'error';
				});
				return;
			}
			homeView.appendChild(el('div', 'admin-sec', t('home.sec_console')));
			var a = document.createElement('a');
			a.className = 'admin-console-link';
			a.href = '/console/';
			a.target = '_blank';
			a.rel = 'noopener';
			a.textContent = t('home.console_open');
			homeView.appendChild(a);
			homeView.appendChild(el('div', 'admin-note', t('home.console_note', { role: consoleRole })));
		}

		/// Ask what to call a device, and put the answer on its line.
		///
		/// An empty box is not a cancelled edit: it clears the name, which is a
		/// rename like any other and carries a stamp, so the clearing travels to
		/// the other devices too. Cancelling is what leaves everything alone.
		async function askDeviceName(id) {
			var d = loadDevices()[id];
			if (!d) return;
			var derived = d.name || t('devices.unknown');
			var chosen = await promptDialog(t('devices.rename_title'), {
				message:     t('devices.rename_body', { derived: derived }),
				value:       d.label || '',
				placeholder: derived,
				okLabel:     t('common.save'),
				validate:    function () { return ''; },	// empty is how a name is cleared
			});
			if (chosen == null) return;					// cancelled, Escape, or the scrim
			renameDevice(id, chosen);
			// The name is the user's own words, so it travels only inside the sealed
			// parcel — this asks for that parcel to go now rather than at the next
			// change, and does nothing at all when sync is off.
			if (window.DaimondSync && DaimondSync.nudge) {
				try { DaimondSync.nudge(); } catch (e) { /* not syncing */ }
			}
			renderHome();
		}

		function el(tag, cls, text) {
			var n = document.createElement(tag);
			n.className = cls;
			if (text != null) n.textContent = text;
			return n;
		}

		// ── The status header ─────────────────────────────────
		// Each row answers a question the user would otherwise have to open
		// something to answer, and each row that can be acted on goes there.

		/// A row: a state dot, a label, a value, and an optional right-hand figure.
		function row(id, dot, label, val, aside, lock) {
			var r = document.getElementById(id);
			if (!r) return;
			r.innerHTML = '';
			var d = el('span', 'astat-dot' + (dot ? ' ' + dot : ''));
			r.appendChild(d);
			if (label) r.appendChild(el('span', 'astat-label', label));
			r.appendChild(el('span', 'astat-val', val));
			if (lock) {
				var l = el('span', 'astat-lock', '\u{1F512}');    // a padlock
				l.title = lock;
				r.appendChild(l);
			}
			if (aside) r.appendChild(el('span', 'astat-aside', aside));
		}

		/// Redraw the status. Cheap, and safe to call from anywhere that changes
		/// something the header reports.
		function status() {
			if (!document.getElementById('astat-model')) return;

			// The models. This row used to name the ONE provider and model the app held; it now
			// counts what every provider between them can run, because that is the number that
			// changes when a key is added and the number a user wants to see go up.
			var mrow = document.getElementById('astat-model');
			var M = window.DaimondModels;
			var ready = M && M.ready();
			if (locked) {
				row('astat-model', 'off', '', 'Locked');
			} else if (ready) {
				var n = M.count();
				row('astat-model', 'ok', '', t('drawer.models'), String(n));
			} else if (M && M.providers().length) {
				// A key is held but nothing is starred, or the key cannot be read.
				row('astat-model', 'warn', '', t('drawer.models'), String(M.count()));
			} else {
				row('astat-model', 'warn', '', t('astat.no_model'));
			}
			mrow.title = t('astat.model_help');
			// Until there is a model to think with, Daimond cannot answer anything, so this row is
			// the one thing to do — and it pulses to say so, rather than a form springing open over
			// the whole panel the moment the app loads.
			mrow.classList.toggle('astat-pulse', !locked && !ready);

			// The account service: credits, and whether it can be reached at all.
			//
			// A session and a figure read under it decide this row. `navigator.onLine` does
			// NOT: it is the browser's guess, false whenever its own connectivity probe
			// fails -- network or no network -- and it used to be asked first, so one machine
			// guessing wrongly replaced a signed-in account's balance with "Offline" while
			// that same tab went on fetching, syncing and spending. The guess may still NAME a
			// connection that has actually failed; it may not overrule one that has not.
			var arow = document.getElementById('astat-account');
			var st = (window.DaimondGateway && DaimondGateway.state()) || {};
			if (locked || !st.authed) {
				row('astat-account', 'off', '',
					!navigator.onLine ? t('astat.offline')
						: st.offline ? t('astat.service_unreachable')
						: t('astat.no_account'));
			} else {
				row('astat-account', 'ok', '', t('astat.credits'),
					st.credits === null ? '—' : DaimondGateway.fmtMoney(st.credits, st.currency));
			}
			arow.title = t('astat.credits_help');

			// Pro: whether this identity owns the one-time unlock, and a way in if
			// not. It sits on its own row, next to credits but distinct from them --
			// Pro is a capability you own, credits are money you spend.
			proRow();

			// What Daimond can do. A user who does not know it can read a page or answer an
			// email will never ask it to, so the count sits in the rail and the panel is one
			// click from it.
			tools();

			// The workspace: OPFS is evictable, and a user who cannot see it
			// filling up cannot know to get anything out of it.
			storage();
		}

		/// The Pro row: owned, or an invitation to own it. Shown only when the
		/// gateway has answered for an account, since Pro is a fact about that
		/// account -- a locked or unconnected app cannot say, so it says nothing.
		function proRow() {
			var r = document.getElementById('astat-pro');
			if (!r) return;
			var st = (window.DaimondGateway && DaimondGateway.state()) || {};
			if (locked || !st.authed || st.pro === null) { r.style.display = 'none'; return; }
			r.style.display = '';
			if (st.pro) {
				row('astat-pro', 'ok', 'Pro', t('astat.pro_owned'));
				r.title = t('astat.pro_owned_help');
			} else {
				row('astat-pro', 'off', 'Pro', t('astat.pro_upgrade'));
				r.title = t('astat.pro_upgrade_help');
			}
			// The value reads as a link when there is an upgrade to take.
			r.classList.toggle('astat-pro-upgrade', !st.pro);
		}

		/// The Pro popup: own it, or the confirmation that it is owned. Its own
		/// surface rather than the Credits drawer, because Pro is a single
		/// decision -- one payment -- not a balance to watch.
		async function showPro() {
			var st = (window.DaimondGateway && DaimondGateway.state()) || {};
			if (st.pro) {
				noticeDialog('Daimond Pro', t('pro.owned_plain'));
				return;
			}
			var price = st.proPriceMinor ? DaimondGateway.fmtMoney(st.proPriceMinor, st.currency) : '';
			var ok = await confirmDialog(
				t('pro.offer_plain'),
				price ? t('pro.buy_priced', { price: price }) : t('pro.buy'),
				{ title: t('astat.pro_upgrade'), danger: false, cancelLabel: t('dlg.not_now') });
			if (!ok) return;
			try {
				var r = await DaimondGateway.buyPro();       // navigates to Stripe, or returns {held}
				if (r && r.held) { await DaimondGateway.refreshLicence(); status(); }
			} catch (e) {
				noticeDialog(t('pro.checkout_failed'), friendlyError(e));
			}
		}

		/// The Tools row: how many tools this Daimond holds, of how many exist.
		function tools() {
			var r = document.getElementById('astat-tools');
			if (!r) return;
			if (locked || !window.DaimondTools) { r.style.display = 'none'; return; }
			r.style.display = '';
			var c = DaimondTools.counts();
			// Before the gateway has answered, the total is only what is built in, and a row
			// reading "16 of 16" would quietly claim there is nothing else to have.
			var val = c.all > c.have
				? t('astat.tools_of', { have: c.have, all: c.all })
				: t('astat.tools', { have: c.have });
			row('astat-tools', 'ok', '', val);
			r.title = t('astat.tools_help');
			r.onclick = function () { DaimondTools.show(); };
		}

		var _storeSeq = 0;

		/// The sandbox. Its size is the browser's to know, and it will say: `estimate()` gives what
		/// this origin uses and the quota it is allowed, which is what turns "2.0 MB" -- a figure
		/// with nothing to compare it to -- into a fraction of something.
		///
		/// "Evictable" is not a warning about the workspace, it is a fact about the browser:
		/// storage that has not been marked persistent may be thrown away under pressure. The row
		/// says so, and offers the one thing that fixes it.
		function storage() {
			var r = document.getElementById('astat-store');
			if (!r) return;
			if (locked || !navigator.storage || !navigator.storage.estimate) { r.style.display = 'none'; return; }
			var seq = ++_storeSeq;
			navigator.storage.estimate().then(async function (e) {
				if (seq !== _storeSeq) return;                 // superseded
				var kept = false;
				try { kept = await navigator.storage.persisted(); } catch (x) { /* unsupported */ }
				var used  = e.usage || 0;
				var quota = e.quota || 0;
				var pct   = quota ? (100 * used / quota) : 0;
				// A percentage that rounds to zero is a lie of precision, not a reassurance: say
				// "under 0.1%" rather than "0.0%", which reads as "nothing" when it is not nothing.
				var pctTxt = !quota ? '' : (pct < 0.1 ? '<0.1%' : pct.toFixed(1) + '%');

				r.style.display = '';
				row('astat-store', kept ? 'ok' : 'off', '',
					kept ? t('astat.workspace_browser')
						: t('astat.workspace_browser') + ' · ' + t('astat.evictable'),
					fmtBytes(used) + (pctTxt ? ' · ' + pctTxt : ''));
				r.title = (quota
						? t('astat.store_of', { used: fmtBytes(used), quota: fmtBytes(quota) }) + ' '
						: '')
					+ t(kept ? 'astat.store_persistent' : 'astat.store_evictable');
				// The fix for evictable is one call, and it is the user's to make.
				r.onclick = kept ? null : async function () {
					try { await navigator.storage.persist(); } catch (x) { /* refused */ }
					storage();
				};
				r.style.cursor = kept ? '' : 'pointer';
			}).catch(function () { r.style.display = 'none'; });

			native();
		}

		// The size walk of a real folder: what it has counted, and whether it was told to stop.
		var _walk = null;             // { stop: bool, files, bytes } while running
		var _walked = null;           // the last completed result

		/// The real folder, when there is one.
		///
		/// The browser tells us NOTHING about it: a FileSystemDirectoryHandle has no size, no
		/// quota, no usage, and there is no web API for free disk space. So unlike the sandbox
		/// row above, this one cannot show a percentage -- and rather than invent one, it offers
		/// to go and count, which on a large tree is a real walk over every file and is therefore
		/// asked for, warned about, and abandonable.
		function native() {
			var r = document.getElementById('astat-store-native');
			if (!r) return;
			var handle = (typeof Files !== 'undefined' && Files.folder) ? Files.folder() : null;
			var can = typeof window.showDirectoryPicker === 'function';
			if (locked || !can) { r.style.display = 'none'; return; }
			r.style.display = '';

			if (!handle) {
				row('astat-store-native', 'off', '', t('astat.workspace_native'), t('astat.not_connected'));
				r.title = t('astat.native_help');
				r.style.cursor = 'pointer';
				r.onclick = function () { DaimondPanels.show('work'); };
				return;
			}

			if (_walk) {
				row('astat-store-native', 'warn', '', t('astat.workspace_native'),
					t('astat.n_files', { n: fmtCount(_walk.files) }) + ' · ' + fmtBytes(_walk.bytes));
				r.title = t('astat.counting');
				r.style.cursor = 'pointer';
				r.onclick = function () { _walk.stop = true; };
				return;
			}

			var done = _walked && _walked.name === handle.name;
			row('astat-store-native', 'ok', '', t('astat.workspace_native'),
				done ? fmtBytes(_walked.bytes) + (_walked.partial ? ' ' + t('astat.part') : '') : handle.name);
			r.title = done
				? t(_walked.partial ? 'astat.counted_partial' : 'astat.counted',
						{ n: fmtCount(_walked.files), folder: handle.name })
					+ ' ' + t('astat.count_again')
				: t('astat.count_offer');
			r.style.cursor = 'pointer';
			r.onclick = function () { estimate(handle); };
		}

		/// Walk the folder, adding up what is in it, and stop the moment it is told to.
		///
		/// The walk yields to the event loop every so often. That is what makes it abandonable:
		/// a loop that never yields would hold the main thread and the Stop it is checking for
		/// could never be clicked.
		async function estimate(handle) {
			if (_walk) return;
			_walk = { stop: false, files: 0, bytes: 0 };
			native();
			var stack = [handle];
			try {
				while (stack.length && !_walk.stop) {
					var dir = stack.pop();
					for await (var ent of dir.values()) {
						if (_walk.stop) break;
						if (ent.kind === 'directory') { stack.push(ent); continue; }
						try {
							var f = await ent.getFile();
							_walk.files += 1;
							_walk.bytes += f.size;
						} catch (e) { /* a file that will not open is still a file we cannot size */ }
						// Breathe: let the click that stops this actually be heard, and let the
						// count on screen keep up with the walk.
						if (_walk.files % 40 === 0) {
							native();
							await new Promise(function (res) { setTimeout(res, 0); });
						}
					}
				}
			} catch (e) { /* the folder went away mid-walk; the numbers so far still stand */ }
			_walked = {
				name:    handle.name,
				files:   _walk.files,
				bytes:   _walk.bytes,
				partial: _walk.stop,
			};
			_walk = null;
			native();
		}

		function fmtCount(n) {
			return String(n || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
		}
		function fmtBytes(n) {
			if (n < 1024) return n + ' B';
			if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
			if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
			return (n / 1073741824).toFixed(2) + ' GB';
		}

		/// Logging out clears the user's content from the DOM. Their API key is
		/// theirs, and it is now sitting in a panel rather than a hidden modal.
		function clear() {
			endForm();
			setSecret(document.getElementById('cfg-api-key'), '');
			// The push token goes with it. It is masked, so what a half-filled box
			// leaves behind is not on screen -- but it is on `el._real`, which is
			// exactly the copy a locked app must not still be holding.
			setSecret(document.getElementById('cfg-push-token'), '');
			var pn = document.getElementById('push-note');
			if (pn) pn.textContent = '';
			document.getElementById('byok-note').textContent = '';
			document.getElementById('credits-balance').textContent = '';
			document.getElementById('credits-packs').innerHTML = '';
			closeAdmin();
			status();
		}

		function init() {
			body         = document.getElementById('admin-scroll');   // the views' container
			homeView     = document.getElementById('admin-home');
			settingsView = document.getElementById('admin-models');
			creditsView  = document.getElementById('admin-credits');
			releaseView  = document.getElementById('admin-release');
			pushView     = document.getElementById('admin-push');
			formView     = document.getElementById('admin-form');
			modal        = document.getElementById('settings-modal');
			slot         = document.getElementById('settings-slot');
			closeBtn     = document.getElementById('settings-close');
			closeBtn.addEventListener('click', closeModal);
			adminWrap = document.getElementById('admin');
			titleEl   = document.getElementById('admin-drawer-title');
			var acl = document.getElementById('admin-close');
			if (acl) acl.addEventListener('click', closeAdmin);
			// Each status row opens the thing it names, and nothing else.
			document.getElementById('astat-model').addEventListener('click', function () { openSettings(''); });
			document.getElementById('astat-account').addEventListener('click', function () { openCredits(''); });
			var proRowEl = document.getElementById('astat-pro');
			if (proRowEl) proRowEl.addEventListener('click', showPro);
			var relRow = document.getElementById('astat-release');
			if (relRow) relRow.addEventListener('click', release);
			if (window.DaimondRelease) DaimondRelease.paintRow();
			var pushBtn = document.getElementById('push-save');
			if (pushBtn) pushBtn.addEventListener('click', function () { savePushCred(); });
			var addBtn = document.getElementById('models-add');
			if (addBtn) addBtn.addEventListener('click', function () {
				var f = document.getElementById('byok-form');
				if (f) f.style.display = f.style.display === 'none' ? '' : 'none';
			});
			modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
			document.addEventListener('keydown', function (e) {
				if (e.key === 'Escape' && (drawerOpen || modal.style.display !== 'none')) closeAdmin();
			});
			// The rail comes and goes with the window width, and whatever is open has
			// to follow it. BOTH ways: only modal-to-panel was handled, so a window
			// shrinking past the fold took the rail away and left the open view with
			// nowhere to be. A half-filled form was the bad case — it vanished with
			// everything typed into it, re-opening the rail did not bring it back,
			// and nothing had said a word.
			window.addEventListener('resize', function () {
				var inModal  = modal.style.display !== 'none';
				if (!drawerOpen && !inModal) return;
				var formOpen = !!(formView && formView.style.display !== 'none');
				var title    = (titleEl && titleEl.textContent) || 'Admin';
				if (available()) {
					if (inModal) { toPanel(); showDrawer(title, formOpen); }
				} else if (!inModal) {
					toModal(title, formOpen);
				}
			});
			// The dots are only true while they are true.
			window.addEventListener('online',  status);
			window.addEventListener('offline', status);
			closeAdmin();   // the drawer starts hidden; only the Status strip shows
			status();
		}

		return {
			init: init, available: available, settings: settings, credits: credits,
			release: release, push: push,
			toggle: toggleSettings,
			home: home, form: form, closeModal: closeModal, clear: clear, status: status,
			close: closeAdmin,
		};
	})();

	// Published on purpose. Two other modules already ask for `window.DaimondAdmin`
	// before sending the user to the Pro offer in Credits -- mail.js when its pitch
	// button is pressed, sync.js when the "Sync off" chip is clicked -- and until
	// now it was undefined, so the Mail panel's own Buy button did nothing at all.
	// One handle on the surface that already exists, rather than a second way in.
	window.DaimondAdmin = DaimondAdmin;

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
	function stripAnsi(raw) {
		var s = String(raw == null ? '' : raw);
		s = s.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '');	// OSC ... BEL | ST
		s = s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');		// CSI ... final
		s = s.replace(/\x9b[0-9;?]*[ -\/]*[@-~]/g, '');		// the 8-bit introducer takes no '['
		return s.replace(/[\x1b\x9b]/g, '');			// a lone introducer
	}

	function friendlyError(raw) {
		var s = String(raw == null ? '' : (raw && raw.message ? raw.message : raw));
		s = stripAnsi(s);
		// Strip the fe2o3 source frames BEFORE reading any status code out of
		// the text. They carry line numbers, and a frame like `src/llm.rs:507`
		// otherwise matches the 5xx test — so an unreachable endpoint was being
		// reported to the user as the provider having a server error.
		s = s.replace(/src\/[^\s":]+\.rs:\d+:?/g, ' ');
		// A transport failure is not a provider response, so test it first.
		if (/Failed to fetch|NetworkError|ERR_CONNECTION|ENOTFOUND|ECONNREFUSED|refused|dns/i.test(s)) {
			return t('err.unreachable');
		}
		// Map the common upstream-provider HTTP statuses to actionable copy.
		if (/\bHTTP (error )?401\b|\b401\b/.test(s)) return t('err.rejected_401');
		if (/\b403\b/.test(s)) return t('err.denied_403');
		if (/\b404\b/.test(s)) return t('err.notfound_404');
		if (/\b429\b/.test(s)) return t('err.ratelimit_429');
		if (/\b5\d\d\b/.test(s)) return t('err.server_5xx');
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
		return s ? s.charAt(0).toUpperCase() + s.slice(1) + '.' : t('err.generic');
	}

	function clearChat() {
		chatOutput.innerHTML = ''; curAsstDiv = null; curAsstText = '';
		// The turns belonged to the thread that has just been thrown away. Numbering them from
		// scratch is what keeps a turn number meaning "the nth question in THIS chat", which is
		// the assumption the fold relies on when it maps a ticked turn back to a message.
		_turn = 0; _jumpAt = -1;
		setSelectMode(false);
	}

	function renderEmptyState() {
		clearChat();
		chatInputBar.style.display = 'none';       // no input until a chat is started
		var wrap = document.createElement('div');
		// The welcome copy that used to live here is gone: the panel opens straight on the one
		// action there is to take. A newcomer who wants the tour has the Guide (the ? in the
		// header, and the Web panel), so the empty chat need not repeat it.
		wrap.className = 'empty-state bare';
		var btn = document.createElement('button');
		btn.className = 'empty-new-session';
		btn.textContent = t('chat.new');
		btn.addEventListener('click', function () { newChat(); });
		wrap.appendChild(btn);
		chatOutput.appendChild(wrap);
	}

	function renderHistory(messages) {
		clearChat();
		if (!Array.isArray(messages)) return;
		messages.forEach(function (m) {
			// A message said into a running turn is a user message to the model and
			// not a turn of its own here, so it is drawn where it landed rather than
			// as the question that started something.
			if (m.role === 'user' && m.interject) appendInterjected(m.content);
			else if (m.role === 'user') appendUserMessage(m.content);
			else if (m.role === 'assistant') {
				appendAssistantText(m.content || '');
				var div = curAsstDiv;
				finalizeAssistant();
				// A turn the tab died in the middle of: show what arrived, badge it, and offer to
				// run it again. The mark rides on the message so it survives further reloads.
				if (m.interrupted && div) markInterrupted(div, m);
			}
			else if (m.role === 'error_log') { appendError(m.content); }
			else if (m.role === 'fold_log') { appendCompacted(m.content || ''); }
			else if (m.role === 'tool_log') {
				// A record of a tool the agent ran. Display only: it is not sent
				// back to the model, which cannot replay a tool call it has no
				// call-id for.
				renderToolCall(m.name || '', m.args || '');
				renderToolResult(m.name || '', m.content || '');
			}
		});
		renderQueue();      // clearChat emptied the thread, queue and all
	}

	/// Badge a recovered assistant message as interrupted, with a Continue button that runs the
	/// turn again. `m.iturn` groups every message of the interrupted turn; `m.itext` is the prompt
	/// to re-run.
	function markInterrupted(div, m) {
		div.classList.add('interrupted');
		var foot = document.createElement('div');
		foot.className = 'turn-interrupted';
		var label = document.createElement('span');
		label.className = 'ti-label';
		label.textContent = '⚠ ' + t(m.content ? 'turn.interrupted' : 'turn.interrupted_early');
		var btn = document.createElement('button');
		btn.className = 'ti-continue';
		btn.textContent = t('turn.continue');
		btn.title = t('turn.continue_help');
		btn.addEventListener('click', function () { continueTurn(current, m.iturn, m.itext); });
		foot.appendChild(label); foot.appendChild(btn);
		div.appendChild(foot);
	}

	/// Re-run an interrupted turn: drop every message that belonged to it, then send the prompt
	/// again. A Web Lock (in runTurn) stops two tabs continuing the same turn at once.
	function continueTurn(chat, iturn, text) {
		if (!chat || !text || chat._generating) return;
		// Idempotent across tabs: if this interrupted turn is already gone (another tab continued or
		// dismissed it, tombstoning its messages), do nothing rather than run and bill it twice.
		var mine = (chat.messages || []).filter(function (x) { return x.iturn === iturn; });
		if (!mine.length) return;
		var tombs = loadMsgTombs();
		if (mine.every(function (m) { return tombs[m.mid]; })) return;
		// Tombstone the interrupted turn's messages so the append-only merge cannot resurrect them,
		// then drop them from this tab's view.
		msgTombstone(mine.map(function (m) { return m.mid; }));
		chat.messages = (chat.messages || []).filter(function (x) { return x.iturn !== iturn; });
		// Drop any agent built before the crash: its session still holds the interrupted turn, and
		// runTurn must rebuild history cleanly from the messages that remain, not append onto it.
		chat.app = null;
		touchChat(chat); persistChats();
		renderHistory(chat.messages);
		runTurn(chat, text);
	}

	/// Fold whatever was in flight when the tab died back into the chats and the Agents panel, from
	/// the write-ahead journal. A turn that never closed becomes an interrupted turn (its prompt is
	/// already in the snapshot from persist-first; its partial reply and the tools that ran come
	/// from the journal), shown with a Continue button. An agent cut off keeps its partial output.
	/// Idempotent: a turn already recovered (its `iturn` present) is skipped, so this is safe to
	/// call on every render.
	var _recovering = false;
	async function recoverInterrupted() {
		if (!window.DaimondJournal || _recovering) return;
		_recovering = true;
		var rec;
		try { rec = await DaimondJournal.recover(); }
		catch (e) { _recovering = false; return; }

		var touchedCurrent = false, touchedAny = false;
		var tombs = loadMsgTombs();
		(rec.turns || []).forEach(function (t) {
			var cid = t.chatId, iturn = t.turnId;
			var chat = null;
			for (var i = 0; i < chats.length; i++) if (chats[i].id === cid) { chat = chats[i]; break; }
			if (!chat) { DaimondJournal.clearTurn(iturn); return; }   // the chat itself is gone
			chat.messages = chat.messages || [];
			if (chat.messages.some(function (m) { return m.iturn === iturn; })) { DaimondJournal.clearTurn(iturn); return; }   // already recovered
			if (tombs[iturn]) { DaimondJournal.clearTurn(iturn); return; }   // this turn was already continued/dismissed

			// If the tab's dying breath still managed to write the aborted request as an error (the
			// catch ran before the page went), drop that trailing error: the interrupted turn about
			// to be folded in is the true, kinder account of what happened.
			var lastReal = chat.messages[chat.messages.length - 1];
			if (lastReal && lastReal.role === 'error_log') chat.messages.pop();

			// The prompt: persist-first almost always saved it under the turn id; tag it, or add it.
			var um = null;
			for (var j = 0; j < chat.messages.length; j++) {
				if (chat.messages[j].role === 'user' && chat.messages[j].mid === iturn) { um = chat.messages[j]; break; }
			}
			if (um) um.iturn = iturn;
			else chat.messages.push({ role: 'user', content: t.userText || '', mid: iturn, iturn: iturn, ts: nowTs() });

			// The tools that ran, in order; one still open when the tab died is shown as such.
			(t.tools || []).forEach(function (tl) {
				chat.messages.push({ role: 'tool_log', name: tl.name || '', args: tl.args || '',
					content: tl.done ? (tl.result || '') : '(interrupted)', mid: newMid(), iturn: iturn, ts: nowTs() });
			});

			// The partial reply, badged interrupted, carrying the prompt so Continue can re-run it.
			chat.messages.push({ role: 'assistant', content: t.text || '', mid: newMid(),
				interrupted: true, iturn: iturn, itext: t.userText || '', ts: nowTs() });

			stampMessages(chat.messages);
			DaimondJournal.clearTurn(iturn);      // now durable in the snapshot
			touchedAny = true;
			if (current && current.id === cid) touchedCurrent = true;
		});

		(rec.agents || []).forEach(function (a) {
			var run = null;
			for (var i = 0; i < (Workers.runs || []).length; i++) if (Workers.runs[i].id === a.runId) { run = Workers.runs[i]; break; }
			if (run) {
				if (a.text && !run.text) run.text = a.text;
				if (run.status === 'running' || run.status === 'queued') run.status = 'interrupted';
			}
			DaimondJournal.clearAgent(a.runId);
		});

		if (touchedAny) { persistChats(); renderSessionList(); }
		if (touchedCurrent && current) renderHistory(current.messages);
		if (rec.agents && rec.agents.length) { try { Workers.persist(); Workers.render(); } catch (e) { /* panel not up */ } }
		_recovering = false;
	}
	function nowTs() { try { return Date.now(); } catch (e) { return 0; } }

	// ── Spinner ────────────────────────────────────────────────
	var spinnerEl = null;
	function showSpinner() {
		if (spinnerEl) return;
		spinnerEl = document.createElement('div');
		spinnerEl.className = 'chat-spinner';
		spinnerEl.innerHTML = '<span class="chat-spinner-dot"></span>'
			+ '<span class="chat-spinner-dot"></span><span class="chat-spinner-dot"></span>';
		postToChat(spinnerEl);
		chatOutput.scrollTop = chatOutput.scrollHeight;
	}
	function hideSpinner() { if (spinnerEl) { spinnerEl.remove(); spinnerEl = null; } }

	/// Tell a screen reader that the turn is over, once.
	///
	/// The obvious thing -- `aria-live` on the thread -- is the wrong thing here.
	/// An answer arrives a few characters at a time, and a live region reads every
	/// change, so a reader would hear the answer re-read at them in fragments for
	/// as long as the model kept typing. That is a noise nobody leaves switched on,
	/// and a live region people switch off is worse than none: the app looks
	/// answerable and is not. So the thread stays silent and this says one short
	/// sentence when the answer is complete, which is the moment a person who
	/// cannot see it needs to know about.
	///
	/// The word count is the only thing said about the answer itself. It is what
	/// tells a listener whether to settle in or glance, and it is available without
	/// reading a word of the content aloud.
	///
	/// @param chat    The chat whose turn just ended.
	/// @param failed  Whether it ended in an error rather than an answer.
	function sayAnswered(chat, failed) {
		var el = document.getElementById('chat-say');
		if (!el) return;
		if (failed) { el.textContent = t('chat.answer_failed'); return; }
		var last = null;
		for (var i = chat.messages.length - 1; i >= 0; i--) {
			if (chat.messages[i] && chat.messages[i].role === 'assistant') { last = chat.messages[i]; break; }
		}
		if (!last) return;                       // nothing was said; say nothing
		var words = String(last.content || '').trim().split(/\s+/).filter(Boolean).length;
		// Written even when the sentence is identical to the one already there --
		// two answers of the same length in a row would otherwise be announced
		// once. Clearing first makes the second write a change.
		el.textContent = '';
		el.textContent = t('chat.answered', { n: words });
	}

	/// What the one button under the composer means right now.
	///
	/// Three modes, not two. `stop` is what a turn used to put on the button for its
	/// whole length; it still does, but only while the box is empty. With something
	/// typed in it during a turn the button is `interject` — an ordinary Send arrow
	/// that puts what was written into the turn already running. The two cannot
	/// share a button honestly: a user who has just typed a correction and presses ■
	/// has killed the turn they were trying to steer.
	function setSendMode(mode) {
		chatSend.disabled = false;
		if (mode === 'stop') { chatSend.innerHTML = '■'; chatSend.classList.add('stop'); chatSend.title = t('chat.stop'); }
		else {
			chatSend.innerHTML = '➤';
			chatSend.classList.remove('stop');
			chatSend.title = t(mode === 'interject' ? 'chat.send_into' : 'chat.send');
		}
	}

	/// Which of the three the button should be showing.
	function sendMode() {
		if (!curGen()) return 'send';
		return (chatInput && chatInput.value && chatInput.value.trim()) ? 'interject' : 'stop';
	}

	/// Put the button into the mode the composer's contents imply. Called on every
	/// keystroke as well as at the ends of a turn, because mid-turn the button's
	/// meaning changes as the box fills and empties.
	function syncSendMode() { if (chatSend) setSendMode(sendMode()); }

	// ── Meters ─────────────────────────────────────────────────
	function fmtCtx(n) {
		if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
		if (n >= 1000) return Math.round(n / 1000) + 'k';
		return '' + n;
	}
	// The centre header no longer carries chat token/cost readouts — those live
	// in the chat's tile (per-chat) and the spend row (global). Kept clear for
	// chats; the Diamond crystal view sets its own centre meter directly.
	function updateMeters() {
		topMeter.textContent = '';
		if (!current) { aiMeter.textContent = ''; return; }
		aiMeter.textContent = '';
	}

	// The per-chat model now lives in the chat tile (pending: a pulldown;
	// active: a locked chip — §7.1), never the centre header. This keeps the
	// obsolete header selector hidden whatever calls it.
	function refreshChatModel() {
		var sel = document.getElementById('chat-model-select');
		if (sel) sel.style.display = 'none';
	}

	// ── Chats ──────────────────────────────────────────────────
	// A manually-started chat begins as a *pending* tile: the user confirms
	// its label and model, then presses Start. Nothing runs until Start — the
	// "pick model → Start" pattern shared by every manually-started agent.
	function newChat() {
		// A new chat opens on the starred default -- both halves of it. Seeding the model without
		// its provider would leave the pulldown pointing at a model and the app reaching for
		// whichever key happened to be default, which are not always the same provider.
		var d = window.DaimondModels ? DaimondModels.getDefault() : { provider: '', model: '' };
		var chat = {
			id: 'c' + (seq++),
			name: nextChatLabel(),
			app: null,
			messages: [],
			model: d.model || cfg.model || '',
			provider: d.provider || '',
			// The workers start on the same model as the chat, and the tile's second pulldown is
			// where that is changed. Seeded rather than left empty so the pulldown has something to
			// point at; an empty pair still means the chat's own model wherever one is read.
			workerModel: d.model || cfg.model || '',
			workerProvider: d.provider || '',
			status: 'pending',
			promptTokens: 0,
			completionTokens: 0,
			cachedTokens: 0,
			costUsd: 0,
			prevPrompt: 0,
			prevCompletion: 0,
			prevCached: 0,
			prevCost: 0,
			lastPrompt: 0,
			updatedAt: 0,
		};
		touchChat(chat);
		chats.unshift(chat);
		persistChats();
		selectChat(chat);
		renderSessionList();
		if (isMobile()) mshow('ai');
	}

	/// Confirm a pending chat's model -- and its workers' model -- and activate it so it can take
	/// input.
	///
	/// `worker` is `{ provider, model }` from the tile's second pulldown. Absent, or naming a model
	/// no provider can run, it becomes the chat's own model: the one thing already known to work,
	/// and never the starred default, which is a different provider's key as often as not.
	function startChat(chat, model, provider, worker) {
		model    = (model    || chat.model    || cfg.model || '').trim();
		provider = (provider || chat.provider || '').trim();
		if (!model) { openSettings(t('chat.choose_model')); return; }
		// Ask whether THIS model can actually run, not whether the default provider can. A chat
		// on a provider whose key is sealed must say so, rather than quietly starting on someone
		// else's key -- which is what checking `cfg` alone did.
		var r = window.DaimondModels && DaimondModels.resolve(provider, model);
		if (!r) {
			openSettings(t(provider ? 'chat.no_key_start' : 'chat.connect_start'));
			return;
		}
		chat.model    = r.model;
		chat.provider = r.provider;
		var wm = (worker && worker.model) || chat.workerModel || '';
		var wp = (worker && worker.provider) || chat.workerProvider || '';
		var wr = wm && window.DaimondModels && DaimondModels.resolve(wp, wm);
		chat.workerModel    = wr ? wr.model    : r.model;
		chat.workerProvider = wr ? wr.provider : r.provider;
		chat.status = 'active';
		chat.app = null;                       // built lazily on the first turn
		touchChat(chat);
		persistChats();
		renderSessionList();
		selectChat(chat);
		chatInput.focus();
	}

	// Rename a chat from its tile label. The centre header mirrors the label
	// read-only, so it is updated here too (single source of truth: the tile).
	function renameChat(chat, name) {
		name = (name || '').trim();
		if (!name || name === chat.name) return;
		chat.name = name;
		touchChat(chat);
		persistChats();
		if (current === chat) sessionNameEl.textContent = name;
	}

	function removeChat(chat) {
		// A chat deleted mid-turn must take its turn with it. Otherwise the
		// fetch runs on and the reply lands minutes later on whatever is on
		// screen — billed to a chat that no longer exists. This holds for any
		// chat, not only the current one, now that each generates on its own.
		if (chat._generating) {
			try { if (chat.app) chat.app.abort(); } catch (e) { /* already gone */ }
			chat._generating = false;
			if (current === chat) { hideSpinner(); setSendMode('send'); chatInput.disabled = false; }
		}
		// A deleted chat's queue goes with it, and so does anything said into the turn
		// that has just been killed: there is nothing left to send either to.
		chat._queue = [];
		chat._interject = [];
		if (current === chat) renderQueue();
		chats = chats.filter(function (c) { return c.id !== chat.id; });
		// A paused chat that is deleted must not leave its flag behind: the id is
		// unreachable, so the Chats section would stay amber with nothing on the
		// rail to resume.
		try { DaimondPause.forget(DaimondPause.id('root', 'chats', chat.id)); }
		catch (e) { /* module not up */ }
		// Same reasoning for how the tile drew itself: an id nobody can reach.
		forgetTilePrefs(chat.id);
		tombstone(chat.id);      // so a stale tab cannot resurrect it
		persistChats();
		if (current === chat) {
			// The next CHAT, never the next daimon: a daimon's record has no tile and
			// is reached through its Diamond, so opening one as a chat would put a
			// conversation on screen that the rail says does not exist.
			current = chats.find(function (c) { return !c.diamondId; }) || null;
			if (current) selectChat(current);
			else { sessionNameEl.textContent = t('chat.no_chat'); renderEmptyState(); chatInputBar.style.display = 'none'; updateMeters(); }
		}
		renderSessionList();
	}

	/// Delete a chat, asking first. THE way a chat is removed by hand.
	///
	/// One function rather than a handler on a button, because Delete moved from
	/// the tile's corner into the foot of its dialog and a second copy of the
	/// confirm would be a second place for it to be forgotten. `removeChat` above
	/// does the work and asks nothing -- it is also what a sync deletion uses,
	/// where there is nobody to ask.
	async function deleteChat(chat) {
		var n = (chat.messages || []).length;
		var msg = n
			? tn('tile.delete_chat_body', n, { name: chat.name })
			: t('tile.delete_chat_empty', { name: chat.name });
		if (!await confirmDialog(msg, t('tile.delete_chat'), { title: t('tile.delete_chat') })) return false;
		removeChat(chat);
		return true;
	}

	// ── Fold a chat into a Diamond (§7.2) ────────────────────────
	// A finished chat is itself a delta: folding it proposes an advisory update
	// to a chosen Diamond crystal, which the user then accepts or vetoes. The Fold
	// control opens a small picker of the user's Diamonds (plus "New Diamond…").
	/// The chat as text for the reducer, optionally narrowed to a few turns.
	///
	/// `turns` is a list of turn numbers, counted the way the thread counts them: the nth question
	/// and everything that came back from it, up to the next question. That is the same rule the
	/// DOM uses to group a turn, so what the user ticked on screen and what the reducer is handed
	/// are the same messages -- which is the only reason the tick can be trusted.
	function chatDelta(chat, turns) {
		var t = 0, want = turns ? turns.slice() : null;
		return (chat.messages || []).filter(function (m) {
			// A message said into a running turn is not a turn of its own -- it
			// belongs to the one it cut into. Counting it would shift every turn
			// number after it, and a ticked turn is mapped back to its messages
			// through exactly this count.
			if (m.role === 'user' && !m.interject) t += 1;
			return !want || want.indexOf(t) !== -1;
		}).map(function (m) {
			return (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.content;
		}).join('\n\n');
	}

	var _foldMenu = null;
	function closeFoldMenu() {
		if (_foldMenu) { _foldMenu.remove(); _foldMenu = null; document.removeEventListener('click', onFoldOutside, true); }
	}
	function onFoldOutside(e) { if (_foldMenu && !_foldMenu.contains(e.target)) closeFoldMenu(); }

	/// Offer the Diamonds to fold into. `turns`, when given, narrows the fold to those turns.
	function openFoldPicker(chat, anchor, turns) {
		closeFoldMenu();
		if (!(chat.messages && chat.messages.length)) {
			noticeDialog(t('fold.nothing'), t('fold.chat_empty'));
			return;
		}
		var menu = document.createElement('div');
		menu.className = 'fold-menu';
		var head = document.createElement('div');
		head.className = 'fold-menu-head';
		// Say how much is going in. Folding three turns and folding the whole chat are different
		// acts with the same button, and the menu is the last place to tell them apart.
		head.textContent = turns ? tn('fold.n_turns_into', turns.length) : t('fold.into');
		menu.appendChild(head);
		if (diamonds.length === 0) {
			var none = document.createElement('div');
			none.className = 'fold-menu-empty'; none.textContent = t('fold.no_diamonds');
			menu.appendChild(none);
		}
		diamonds.forEach(function (f) {
			var item = document.createElement('button');
			item.className = 'fold-menu-item';
			item.textContent = f.name;                 // escaped via textContent (H5)
			item.addEventListener('click', function () {
				closeFoldMenu();
				foldChatInto(chat, f.id, turns).catch(foldFailed);
			});
			menu.appendChild(item);
		});
		var neww = document.createElement('button');
		neww.className = 'fold-menu-item new'; neww.textContent = t('fold.new_diamond');
		neww.addEventListener('click', function () {
			closeFoldMenu();
			foldChatIntoNew(chat, turns).catch(foldFailed);
		});
		menu.appendChild(neww);

		document.body.appendChild(menu);
		var r = anchor.getBoundingClientRect();
		var left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8);
		menu.style.left = Math.max(8, left) + 'px';
		menu.style.top = (r.bottom + 4) + 'px';
		_foldMenu = menu;
		setTimeout(function () { document.addEventListener('click', onFoldOutside, true); }, 0);
	}

	async function foldChatIntoNew(chat, turns) {
		if (!cfgReady(cfg)) { openSettings(t('fold.connect_first')); return; }
		var name = await promptDialog(t('rail.new_diamond'),
			{ value: peekDiamondLabel(), okLabel: t('fold.create_and_fold') });
		if (name === null) return; name = name.trim(); if (!name) return;
		var id;
		try { id = await diamondApp().create_diamond(name); takeDiamondLabel(); bumpDiamonds(); }
		catch (e) { noticeDialog(t('rail.create_failed'), friendlyError(e)); return; }
		// A Diamond made out of a chat inherits that chat's model, and its workers' model with it.
		// Neither is asked for here because the user has already answered both, when they started
		// the chat this Diamond is made of.
		setDiamondModel(id, {
			provider:       chat.provider || '',
			model:          chat.model || '',
			workerProvider: chat.workerProvider || '',
			workerModel:    chat.workerModel || '',
		});
		await loadDiamonds();
		foldChatInto(chat, id, turns).catch(foldFailed);
	}

	/// A fold that threw on its way out.
	///
	/// Every entry point to the fold is a fire-and-forget promise, so a rejection
	/// past the one try block inside used to leave `crystalBusy` true for the rest
	/// of the session -- Steer and Propose both dead -- with nothing said anywhere.
	function foldFailed(e) {
		hideCrystalSpinner();
		setCrystalStatus('');
		setCrystalBusy(false);
		toast(friendlyError(e), true);
	}

	/// Fold a chat into a Diamond. `turns`, when given, folds only those turns.
	async function foldChatInto(chat, diamondId, turns) {
		var f = diamonds.find(function (x) { return x.id === diamondId; });
		// The list is emptied on a read failure and re-read whenever another tab
		// touches a Diamond, so the id picked a moment ago can be absent by now.
		// Returning silently was a Fold that did nothing and said nothing.
		if (!f) {
			noticeDialog(t('fold.diamond_gone'), t('fold.diamond_gone_chat_body'));
			return;
		}
		// The reducer runs on the TARGET Diamond's model, so that is the key that must be readable.
		if (!diamondCanRun(diamondId)) {
			openSettings(t('fold.no_key'));
			return;
		}
		// The reducer is a real, paid round trip. Folding a chat that has not
		// said anything new since it was last folded can only propose no change,
		// so do not pay to be told that.
		//
		// A fold of chosen turns is exempt: the user has just said which turns they mean, and
		// "nothing has changed since you folded the whole chat" is no answer to that.
		if (!turns && chat.foldedInto && chat.foldedInto.id === diamondId
			&& chat.foldedInto.at_len === (chat.messages || []).length) {
			noticeDialog(t('fold.nothing_new'),
				t('fold.nothing_new_body', { chat: chat.name, diamond: f.name }));
			return;
		}
		await selectDiamond(f);                          // switch the centre to the Diamond crystal
		setCrystalBusy(true); setCrystalStatus(t('fold.proposing'));
		showCrystalSpinner();
		var delta = chatDelta(chat, turns), cur, proposed;
		if (!delta) {                                  // ticked turns that carried no text
			hideCrystalSpinner();
			setCrystalStatus(''); setCrystalBusy(false);
			noticeDialog(t('fold.nothing'), t('fold.turns_empty'));
			return;
		}
		// The reducer runs on the Diamond's OWN model -- the one it was created with -- not on
		// whatever happens to be starred now.
		var fa = diamondApp(diamondId);
		try {
			cur = await fa.read_crystal(diamondId);
			proposed = await fa.fold_propose(diamondId, delta);
		} catch (e) {
			meterDiamondTurn(fa);
			hideCrystalSpinner();
			// The status line alone was invisible: it is 12px of muted grey under
			// controls the user is not looking at, on a panel they may have left.
			setCrystalStatus(friendlyError(e)); setCrystalBusy(false);
			toast(friendlyError(e), true);
			return;
		}
		meterDiamondTurn(fa);
		hideCrystalSpinner();
		setCrystalStatus(''); setCrystalBusy(false);
		// A reducer that returned nothing has failed, whatever the crystal held. Shown
		// as a diff it would be a deletion of every line with Accept enabled, so the
		// one click the user is being invited to make would wipe the crystal.
		if (!proposed || !String(proposed).trim()) {
			toast(t('fold.empty_reply'), true);
			return;
		}
		pendingFolds[diamondId] = {
			base: cur, proposed: proposed, delta: delta,
			chatId: chat.id, chatName: chat.name,
			// Some of a chat is not the chat. Marking the tile "Folded" on a partial fold would
			// claim the rest went in too, and would then refuse to fold the rest as unchanged.
			partial: !!turns,
		};
		// Only if that Diamond is still the one on screen: drawing this diff into
		// whatever the user moved on to would put one Diamond's proposal over
		// another's crystal. Coming back to it renders it (see selectDiamond).
		if (currentDiamond && currentDiamond.id === diamondId) renderFoldDiff(diamondId);
		// The proposal is waiting somewhere; say where. A user who clicked away
		// during the reducer's minute is looking at something else entirely, and
		// the rail row is the only other place the pending fold shows.
		renderDiamondList();
		toast(centreMode === 'focus'
			? t('fold.proposed_toast')
			: t('fold.proposed_elsewhere', { diamond: f.name }));
	}

	function timeLabel() {
		var d = new Date();
		return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
	}

	function selectChat(chat) {
		current = chat;
		currentDiamond = null;                       // a chat is not a Diamond
		signalDiamondChanged();
		// The streaming refs point into the outgoing chat's DOM, which is about
		// to be rebuilt. Left dangling, a turn still in flight would resume
		// appending into a detached node and its text would vanish.
		curAsstDiv = null;
		curAsstText = '';
		lastToolBlock = null;
		if (typeof showCentre === 'function') showCentre('chat');
		if (typeof updateActiveDiamond === 'function') updateActiveDiamond();
		sessionNameEl.textContent = chat.name;     // read-only mirror of the tile label
		if ((chat.status || 'active') === 'pending') {
			renderPendingCentre(chat);
			chatInputBar.style.display = 'none';   // no input until the chat is started
		} else {
			chatInputBar.style.display = '';
			renderHistory(chat.messages);
		}
		syncComposer();   // reflect THIS chat's own generating state
		updateActiveSession();
		updateMeters();
		// Anything queued on this chat is drawn again — renderHistory has just
		// rebuilt the thread it lives in — and then acted on. The send is deferred
		// by a tick so this function finishes drawing the chat before a turn starts
		// writing into it, and resumeQueue re-checks that the chat is still the one
		// on screen, since a fast second click can move it again in that tick.
		renderQueue();
		setTimeout(function () { resumeQueue(chat); }, 0);
	}

	// Centre placeholder for a not-yet-started chat: point the user at the
	// tile's model pulldown and Start button (controls live in one place).
	function renderPendingCentre(chat) {
		clearChat();
		var wrap = document.createElement('div');
		wrap.className = 'empty-state pending-centre';
		var h = document.createElement('h2'); h.textContent = chat.name;
		var p = document.createElement('p');
		p.textContent = t('chat.pending_hint');
		wrap.appendChild(h); wrap.appendChild(p);
		var btn = document.createElement('button');
		btn.className = 'empty-new-session';
		btn.textContent = '▶ ' + t('tile.start');
		btn.title = t('chat.start_selected');
		btn.addEventListener('click', function () { startChat(chat, chat.model); });
		wrap.appendChild(btn);
		chatOutput.appendChild(wrap);
	}

	// ── The PPTW: one control, three states ────────────────────
	//
	// `www/js/pause.js` holds the state and answers the questions; this owns the
	// DOM, exactly as the governor is split. Three placements ship here — the
	// global control at the head of the rail, one on each Diamond tile, one on
	// each chat tile — and all three are the same button, so phase G's mailboxes
	// and phase H's triggers are a call each rather than a fourth drawing.
	//
	// Colour is the state and so is the glyph: green plays, red is paused, amber
	// is mixed. Amber is DERIVED — clicking a branch pauses every leaf under it
	// or resumes them all — so the widget has no third action and never offers
	// one. The accessible name carries both halves: which node, and what the
	// click will do.

	var PAUSE_WORKERS = 'root/workers';
	// Fetching a page through the gateway. Not one of notes2's six placements
	// and it has no control of its own yet — the Web panel is phase C's surface,
	// and a light on it before that would be the only traffic light in the app
	// with nowhere to sit. It is in the TREE from today regardless: a spend with
	// no node is a spend with no pause, and enforcement was otherwise falling
	// back to the root, which on a new account has no leaves and reads green.
	var PAUSE_WEB = 'root/web';

	// ── Play, pause, traffic light — in that order ─────────────
	//
	// The specification is notes2.txt line 3, and it is the widget's own name:
	// "Pause/Play/Traffic light widgets (PPTWs) for all spendable functions.
	// Green = all spendable functions active, Amber = some are active, Red = all
	// paused."
	//
	//   PLAY BUTTON    a triangle
	//   PAUSE BUTTON   two bars
	//   TRAFFIC LIGHT  a coloured disc, LAST, on the right
	//
	// THE LIGHT CARRIES NOTHING BUT A COLOUR. No glyph, no symbol, no shape
	// inside it — it is a lamp. A glyph in the light is a verb worn as a noun,
	// which is the fault the compact single button had: a running node drew a
	// green PLAY triangle, so the shape said "play" while the only thing pressing
	// it could do was pause. Putting the glyph back inside the lamp reintroduces
	// exactly that confusion one place to the right.
	//
	// The light is never clickable, which is what makes "amber can never be set"
	// (pause.js §1.1) true by construction rather than by convention: there is no
	// press that could set it.
	//
	// Both buttons are always present and the inapplicable one is DISABLED, not
	// hidden, so a row never reflows and each control keeps a fixed position
	// under the thumb. On a leaf exactly one is ever live. On an amber branch
	// BOTH are — which is the thing one button could not do: with a single
	// control a mixed branch has to guess, and `clickWould` guessed resume-all
	// silently, where now the user is simply offered both.
	//
	// The two verb glyphs, centroid-centred on 8,8 of a 0 0 16 16 box: a triangle
	// averaged over its three points sits where the eye puts it, where one
	// centred on its bounding box leans visibly left.
	var PPTW_ACT = {
		play:  'M5.2 3.2 13.5 8 5.2 12.8z',
		pause: 'M4.5 3.2h2.6v9.6H4.5zM8.9 3.2h2.6v9.6H8.9z',
	};

	/// The mailboxes and their folders, read from the store `mail.js` keeps.
	///
	/// Read rather than asked for: `DaimondMail` publishes no list of accounts,
	/// and phase G owns that file. The nodes exist NOW so the root counts
	/// everything that can spend from the day the root ships — a section that
	/// appears later would quietly change the answer the global light gives.
	function pauseMailNodes() {
		var j;
		try { j = JSON.parse(localStorage.getItem('daimond-mail') || '{}'); }
		catch (e) { return []; }
		var accts = Array.isArray(j.accounts) ? j.accounts : [];
		return accts.filter(function (a) { return a && a.address; }).map(function (a) {
			// The mailbox's own polling is a `self` leaf beside the folders, so a
			// node that both spends and has children never needs the "only leaves
			// hold state" rule to make an exception for it.
			var kids = [{
				id:    DaimondPause.id('root', 'mail', a.address, 'self'),
				kind:  'mailself',
				label: t('pause.mail_polling'),
			}];
			var names = Object.keys(a.folders || {});
			var sel = a.folder || 'INBOX';
			if (names.indexOf(sel) === -1) names.push(sel);
			names.sort().forEach(function (n) {
				kids.push({ id: DaimondPause.id('root', 'mail', a.address, n), kind: 'folder', label: n });
			});
			return { id: DaimondPause.id('root', 'mail', a.address), kind: 'mailbox', label: a.address, children: kids };
		});
	}

	/// The live tree, as it stands at the moment it is asked.
	///
	/// Every branch carries a `children` array even when it is empty. A node with
	/// no array at all is a LEAF, so an empty Diamonds section emitted bare would
	/// take a pause flag of its own: the root would write a phantom id nothing
	/// could ever resume, and a new account's rail would open red.
	function pauseTree() {
		var dnodes = (diamonds || []).map(function (f) {
			var base = DaimondPause.id('root', 'diamonds', f.id);
			var kids = [
				{ id: base + '/self', kind: 'daimon', label: f.name || t('rail.unnamed_diamond') },
			];
			// One leaf per triggered action, which is what makes a Diamond with a
			// trigger held and a daimon running read amber without anyone having set
			// amber anywhere. `pause.js` documented this shape before there were any.
			//
			// `prompted` is deliberately NOT among them: it is the daimon answering
			// you, and `/self` is already its leaf. Two controls for one act would
			// let a user pause the daimon and still be able to prompt it.
			try {
				(Triggers.of(f.id) || []).forEach(function (ta) {
					if (ta.id === 'prompted') return;
					kids.push({
						id:    DaimondTriggers.node(f.id, ta.id),
						kind:  'trigger',
						label: triggerLabel(ta),
					});
				});
			} catch (e) { /* the module is not up: a Diamond with its daimon alone */ }
			return { id: base, kind: 'diamond', label: f.name || t('rail.unnamed_diamond'), children: kids };
		});
		var cnodes = (chats || []).map(function (c) {
			return { id: DaimondPause.id('root', 'chats', c.id), kind: 'chat', label: c.name || t('pause.unnamed_chat') };
		});
		return {
			id: 'root', kind: 'root', label: t('pause.everything'),
			children: [
				{ id: 'root/diamonds', kind: 'section', label: t('rail.diamonds'), children: dnodes },
				{ id: 'root/chats',    kind: 'section', label: t('rail.chats'),    children: cnodes },
				{ id: 'root/mail',     kind: 'section', label: t('pause.mail'),    children: pauseMailNodes() },
				{ id: PAUSE_WORKERS,   kind: 'workers', label: t('pause.workers') },
				{ id: PAUSE_WEB,       kind: 'web',     label: t('pause.web') },
			],
		};
	}

	/// Draw one control to the state of the node it governs.
	///
	/// `g` is the GROUP — the two buttons and the light together. The buttons say
	/// what can be done, the light says what is, and this is the only place
	/// either is decided.
	function paintPause(g) {
		var node = g.dataset.pauseNode;
		var st = 'play';
		try { st = DaimondPause.state(node) || 'play'; } catch (e) { /* module not up */ }
		g.dataset.state = st;
		// The colour is the whole of the light, and `data-state` on the group is
		// what carries it — see `.pptw-lamp` in app.css. Nothing is drawn INSIDE
		// the lamp; the only thing set here is what it is called, because a colour
		// alone announces as nothing at all to a screen reader.
		var name = g.dataset.pauseName || t('pause.this');
		var lamp = g.querySelector('.pptw-lamp');
		if (lamp) {
			var say = name + ' — ' + t('pause.state_' + st);
			lamp.setAttribute('aria-label', say);
			lamp.title = say;
		}
		// Which button is live is the whole answer to "what can I do from here".
		// Running: only pause. Paused: only play. Mixed: BOTH, which is the case
		// a single button had to guess at.
		var acts = g.querySelectorAll('.pptw-act');
		for (var i = 0; i < acts.length; i++) {
			var b = acts[i], act = b.dataset.act;		// 'pause' or 'play'
			b.disabled = (st === 'play' && act === 'play') || (st === 'pause' && act === 'pause');
			var label = t(act === 'pause' ? 'pause.act_pause' : 'pause.act_play', { name: name });
			b.setAttribute('aria-label', label);
			b.title = label;
		}
	}

	/// Repaint every control on the page. A node's state is a walk of the leaves
	/// under it and the page carries a handful of both, so this is cheap enough
	/// to run on every announcement rather than working out who moved.
	function repaintPause(root) {
		var list = (root || document).querySelectorAll('.pptw');
		for (var i = 0; i < list.length; i++) paintPause(list[i]);
	}

	/// One pause control — light, pause, play — ready to place. `name` is what
	/// the node is called in words; it goes into the accessible names and
	/// nowhere else.
	/// Is there anything under this node for a control to act on?
	///
	/// True for a leaf, and for a branch with at least one leaf beneath it. False
	/// for a branch that is currently empty — a mail section with no mailbox, a
	/// Diamonds section on a new account.
	function pauseGoverns(nodeId) {
		try {
			var t = DaimondPause._core, tree = pauseTree();
			var n = t.findNode(tree, nodeId);
			if (!n) return true;			// not in the tree: a leaf by its own id
			return t.leavesUnder(n).length > 0;
		} catch (e) { return true; }		// never let this stop a control being drawn
	}

	function pauseWidget(nodeId, name) {
		// A branch with nothing under it gets no control, and this is the one place
		// that can know it. The rule of §1.1 says an empty branch reads GREEN —
		// nothing is being withheld — and that clicking a branch writes its leaves,
		// of which it has none. Both are right, and together they make a light that
		// says "running" and does nothing when pressed.
		//
		// It went unnoticed until the Email panel's mount points switched on: with
		// no mailbox configured, `root/mail` is an empty branch, so the panel drew a
		// green light that could not be turned off. A control for something that
		// does not exist yet is worse than no control, so there is none until there
		// is something to govern.
		if (!pauseGoverns(nodeId)) return null;
		var g = document.createElement('span');
		g.className = 'pptw';
		g.dataset.pauseNode = nodeId;
		g.dataset.pauseName = name || '';
		// The whole strip swallows the press, not just the two buttons. It sits on
		// a tile that opens on click, and a finger that lands on the light — or in
		// the 1px between two verbs — must not open the Diamond it was aiming to
		// pause. What the light does is nothing, everywhere, which is the claim the
		// design rests on.
		g.addEventListener('click', function (e) { e.stopPropagation(); });

		// The two verbs, FIRST, in the order the widget is named for. `set(node,
		// playing)` and never `toggle` — the point of two buttons is that neither
		// has to work out what was meant.
		['play', 'pause'].forEach(function (act) {
			var b = document.createElement('button');
			b.type = 'button';
			b.className = 'pptw-act pptw-' + act;
			b.dataset.act = act;
			b.innerHTML = '<svg class="pptw-ic" viewBox="0 0 16 16" aria-hidden="true">'
				+ '<path d="' + PPTW_ACT[act] + '"/></svg>';
			b.addEventListener('click', function (e) {
				// The control sits inside a tile that opens on click. Pressing it
				// must pause the Diamond, never open it — and Enter and Space
				// arrive here too, because a <button> makes them clicks.
				e.stopPropagation();
				e.preventDefault();
				try { DaimondPause.set(nodeId, act === 'play'); } catch (err) { /* module not up */ }
			});
			g.appendChild(b);
		});

		// The traffic light, LAST. A <span role="img">, not a button and not
		// focusable: there is no press that could set amber, so amber cannot be
		// set. It is EMPTY — the colour is the whole signal, and its label is
		// filled in by `paintPause`.
		var lamp = document.createElement('span');
		lamp.className = 'pptw-lamp';
		lamp.setAttribute('role', 'img');
		g.appendChild(lamp);

		paintPause(g);
		return g;
	}

	/// Place a control, if there is one to place. `pauseWidget` returns null for a
	/// branch with nothing under it, and `appendChild(null)` throws.
	function mountPause(parent, nodeId, name) {
		var w = pauseWidget(nodeId, name);
		if (w) parent.appendChild(w);
		return w;
	}

	/// The shared bits of chrome another module may place, but must not redraw.
	///
	/// `pauseWidget` is the one control of §1.1 — three parts, one drawing — and
	/// its DOM belongs here, exactly as the governor's does. The Email panel
	/// needs four of them — the section,
	/// the mailbox, its `self` leaf and each folder — and a second drawing over
	/// there would be a second thing to keep in step with the state names, which
	/// would drift the first time either changed.
	/// One drawing of the cog, so the app cannot grow two.
	///
	/// The Email panel had its own copy of the same 500-character path, which is
	/// how an icon set drifts: a change to one is a change to one. Returns a fresh
	/// element each call, because an SVG node cannot be in two places at once.
	function cogIcon() {
		var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'ic');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('aria-hidden', 'true');
		var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '3');
		var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		// `COG_D` is declared with the tile dialog further down; `var` hoists it
		// through this function scope and nothing calls this before load.
		p.setAttribute('d', COG_D);
		svg.appendChild(c); svg.appendChild(p);
		return svg;
	}

	window.DaimondUI = { pauseWidget: pauseWidget, cogIcon: cogIcon };

	// ── The worker pump's hold, folded into the tree ───────────
	//
	// There used to be two pauses: `daimond-workers-paused` and, once the tree
	// existed, `root/workers`. Two flags for one hold is two answers to "are the
	// workers running", so the pump now reads the leaf and the old key is
	// migrated away on the first load that finds it.

	/// Is the pump held? The whole answer is one leaf's flag, cheap enough to sit
	/// in front of every launch.
	function workersHeld() {
		try { return !!(window.DaimondPause && DaimondPause.isPaused(PAUSE_WORKERS)); }
		catch (e) { return false; }
	}

	// What the pump was last reconciled to, so an announcement that did not move
	// the hold does not restart every paused worker.
	var lastHold = null;

	/// Hold or release the pump, writing the leaf rather than a flag beside it.
	function setWorkersHeld(v) {
		lastHold = !!v;
		try { if (window.DaimondPause) DaimondPause.set(PAUSE_WORKERS, !v); }
		catch (e) { /* module not up: the pump falls back to running */ }
	}

	/// Bring the pump into line with the tree, for a hold set from somewhere
	/// else — the global control, another device's parcel, the root going red.
	function reconcileWorkers() {
		var want = workersHeld();
		if (want === lastHold) return;
		if (want) Workers.pauseAll(); else Workers.resumeAll();
	}

	/// Carry an old worker hold onto the leaf, once.
	///
	/// A user who paused their workers yesterday must not find them running
	/// today: dropping the flag rather than migrating it is a silent resume, and
	/// a wrong resume costs money where a wrong pause costs a click.
	function migrateWorkerHold() {
		var old;
		try { old = localStorage.getItem(WORKERS_PAUSED_KEY); } catch (e) { return; }
		if (old === null) return;
		if (old === '1') {
			try { if (window.DaimondPause) DaimondPause.seedPaused(PAUSE_WORKERS); } catch (e) { /* ignore */ }
		}
		// And nothing writes it again, so this runs at most once per account.
		try { localStorage.removeItem(WORKERS_PAUSED_KEY); } catch (e) { /* already gone */ }
	}

	if (window.DaimondPause) {
		DaimondPause.setTree(pauseTree);
		window.addEventListener('daimond:pause', function () {
			repaintPause();
			reconcileWorkers();
		});
	}

	/// Put the global control in the slot the rail leaves for it.
	///
	/// Built here rather than written into index.html so there is ONE drawing of
	/// the widget: a second copy in markup is a second thing to keep in step with
	/// the state names, and it would drift the first time one of them changed.
	function initPauseUi() {
		var slot = document.getElementById('pptw-global');
		if (!slot || !window.DaimondPause) return;
		slot.innerHTML = '';
		mountPause(slot, DaimondPause.ROOT, t('pause.everything'));
	}

	// ── The tile's own dialog, and what the cog replaced ───────
	//
	// Notes2 replaced the global Compact/Breathe spacing with something aimed
	// at the real complaint: a power user wants the numbers on screen and a
	// new user wants a quiet rail. That is a choice per OBJECT, not per app, so
	// it is made where the object is -- a cog in the top right of every tile,
	// opening a dialog that carries the tile's pause control, its level of
	// detail, and, at the foot, Delete.
	//
	// The closer cross is gone. It was `opacity: 0` until hover, which is no
	// control at all on a phone, and it put the one irreversible act on the
	// tile's most reachable pixel while opening the tile had no keyboard route
	// at all. Delete now sits at the foot of a dialog you had to open, behind a
	// confirm; the cog is what the corner offers instead.

	/// How each tile is drawn, and how it talks: browser-side, per tile id.
	///
	/// `{ <tileId>: { detail: 'simple' | 'max', concise: true } }`.
	///
	/// Here rather than in the chat record because a chat record is content --
	/// it goes through `slimChat`'s whitelist, into IndexedDB and out in the
	/// sync parcel -- and how big a tile draws itself is not a fact about the
	/// conversation. Here rather than in `cfg` because the choice is per tile
	/// and `cfg` is one global object rebuilt from scratch on every `saveCfg`.
	/// `daimond-diamond-models` is the precedent: a browser-side choice about
	/// an object, keyed by its id, beside the app rather than inside the store.
	///
	/// Deliberately NOT synced. Two devices are two screens, and a phone that
	/// adopted a desktop's Max view would be the busiest possible rail on the
	/// smallest possible screen.
	var TILE_PREFS_KEY = 'daimond-tile-prefs';

	function tilePrefs() { return readJson(TILE_PREFS_KEY, {}) || {}; }

	/// One tile's preferences, always an object so a caller never guards.
	function tilePref(id) {
		var p = tilePrefs()[id];
		return (p && typeof p === 'object') ? p : {};
	}

	/// Write one field, leaving the rest of that tile's record alone.
	function setTilePref(id, field, value) {
		if (!id) return;
		var all = tilePrefs();
		var rec = (all[id] && typeof all[id] === 'object') ? all[id] : {};
		rec[field] = value;
		all[id] = rec;
		try { localStorage.setItem(TILE_PREFS_KEY, JSON.stringify(all)); } catch (e) { /* quota */ }
	}

	/// Forget a tile's preferences, for an object being deleted. A record for an
	/// id nobody can reach would sit in storage for the life of the account.
	function forgetTilePrefs(id) {
		if (!id) return;
		var all = tilePrefs();
		if (!(id in all)) return;
		delete all[id];
		try { localStorage.setItem(TILE_PREFS_KEY, JSON.stringify(all)); } catch (e) { /* quota */ }
	}

	/// 'simple' or 'max'. Absent means SIMPLE: the quiet rail is the default the
	/// user asked for, and Max is the thing a power user goes and turns on.
	function tileDetail(id) { return tilePref(id).detail === 'max' ? 'max' : 'simple'; }

	/// Is this chat's concise chip lit?
	function tileConcise(id) { return tilePref(id).concise === true; }

	// A cog, drawn rather than typed. `⚙` is a font's idea of a cog and comes
	// out as a smudge at 16px in the faces this app ships; the chevrons beside
	// the composer were redrawn for the same reason.
	//
	// A toothed body, not a hub with spokes around it. The first drawing here was
	// eight radial ticks that did not touch the centre disc, and magnified it was
	// plainly a SUN -- the brightness control, on a settings button. Teeth join
	// the body; rays do not. Same path as the mailbox gear, so the app has one
	// cog rather than two.
	var COG_D = 'M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2v.2'
		+ 'a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1'
		+ 'a1.7 1.7 0 00-1.2-2.9H2.9a2 2 0 110-4H3a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.9l-.1-.1'
		+ 'a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V2.9a2 2 0 114 0V3'
		+ 'a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9'
		+ 'a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z';

	/// The cog in a tile's top right. `name` is what the tile is called, so five
	/// tiles do not announce as five identical "Settings".
	function tileCog(name, onOpen) {
		var b = document.createElement('button');
		b.type = 'button';
		b.className = 'tile-cog';
		b.title = t('tile.settings');
		b.setAttribute('aria-label', t('tile.settings_named', { name: name || '' }));
		b.setAttribute('aria-haspopup', 'dialog');
		// A constant string: nothing here comes from the user or a model.
		b.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">'
			+ '<circle cx="12" cy="12" r="3"/><path d="' + COG_D + '"/></svg>';
		b.addEventListener('click', function (e) {
			// The tile opens on click; the cog must not open it as well.
			e.stopPropagation();
			e.preventDefault();
			onOpen();
		});
		return b;
	}

	/// The tile's dialog: pause, detail, and Delete at the foot.
	///
	/// `opts` is `{ id, name, node, onDelete }` -- `node` being the pause node
	/// this tile's control binds to. Built here rather than through `dialog()`
	/// because that helper's body is a message and an input, and this one is a
	/// column of controls with a destructive act underneath them; it wears the
	/// same `.modal` furniture so Escape, the backdrop and the focus trap behave
	/// exactly as they do everywhere else.
	var _tileDlgSeq = 0;		// so each dialog's heading id is its own

	function openTileDialog(opts) {
		var back = document.createElement('div');
		back.className = 'modal dlg tile-dlg';
		var card = document.createElement('div');
		card.className = 'modal-card dlg-card tile-dlg-card';
		card.setAttribute('role', 'dialog');
		card.setAttribute('aria-modal', 'true');

		var h = document.createElement('h2');
		h.textContent = opts.name || t('tile.settings');
		// Named by its own heading. `a11y_report.md` §5 counts every dialog in the
		// app as an unlabelled div, so a new one does not join them: the words are
		// already on screen and this is what points the tree at them.
		h.id = 'tile-dlg-h-' + (++_tileDlgSeq);
		card.setAttribute('aria-labelledby', h.id);
		card.appendChild(h);

		// ── Pause. The same widget as the rail and the tile, never a second
		// drawing of it: two pictures of one state drift the first time either
		// changes.
		var sayPause = null;		// set only where a pause control was placed
		if (window.DaimondPause && opts.node) {
			card.appendChild(secHead(t('tile.dlg_running')));
			var prow = document.createElement('div');
			prow.className = 'tile-dlg-pause';
			mountPause(prow, opts.node, opts.name || '');
			var pwords = document.createElement('span');
			pwords.className = 'tile-dlg-pause-words';
			sayPause = function () {
				var st = 'play';
				try { st = DaimondPause.state(opts.node) || 'play'; } catch (e) { /* module not up */ }
				pwords.textContent = t('pause.state_' + st);
			};
			sayPause();
			window.addEventListener('daimond:pause', sayPause);
			prow.appendChild(pwords);
			card.appendChild(prow);
		}

		// ── Detail. Two words, and the tile behind the dialog changes as they
		// are pressed, so the choice is seen rather than described.
		card.appendChild(secHead(t('tile.dlg_detail')));
		var seg = document.createElement('div');
		seg.className = 'tile-dlg-seg';
		var btns = {};
		['simple', 'max'].forEach(function (level) {
			var b = document.createElement('button');
			b.type = 'button';
			b.className = 'tile-dlg-level';
			b.dataset.level = level;
			b.textContent = t('tile.detail_' + level);
			b.title = t('tile.detail_' + level + '_help');
			b.addEventListener('click', function () {
				setTilePref(opts.id, 'detail', level);
				paintLevel();
				applyTileDetail(opts.id);
			});
			btns[level] = b;
			seg.appendChild(b);
		});
		function paintLevel() {
			var now = tileDetail(opts.id);
			Object.keys(btns).forEach(function (k) {
				btns[k].setAttribute('aria-pressed', k === now ? 'true' : 'false');
			});
		}
		paintLevel();
		card.appendChild(seg);
		var note = document.createElement('div');
		note.className = 'tile-dlg-note';
		note.textContent = t('tile.detail_note');
		card.appendChild(note);

		// ── Models. Only where the object HAS changeable models, which today is a
		// Diamond: notes2 fixes a chat's models at creation and this dialog is not
		// the place to quietly overturn that.
		if (opts.models === 'diamond') mountDiamondModels(card, opts);

		// ── Context. Only for a chat, which is the only thing here that HAS a durable
		// conversation to fold; a Diamond's daimon has one from phase E.
		if (opts.chat) mountContextSection(card, opts.chat);

		// ── Triggered actions, for a Diamond.
		if (opts.models === 'diamond') mountTriggers(card, opts);

		// ── The foot. Delete on the left, away from Done, because a foot whose
		// two buttons sit side by side puts the irreversible one under the thumb
		// that meant to dismiss.
		var row = document.createElement('div');
		row.className = 'dlg-actions tile-dlg-foot';
		var del = document.createElement('button');
		del.type = 'button';
		del.className = 'dlg-ok danger tile-dlg-delete';
		del.textContent = t('tile.dlg_delete');
		var done = document.createElement('button');
		done.type = 'button';
		done.className = 'modal-close dlg-cancel tile-dlg-done';
		done.textContent = t('dlg.done');
		row.appendChild(del);
		row.appendChild(done);
		card.appendChild(row);

		back.appendChild(card);
		document.body.appendChild(back);

		var prev = document.activeElement;
		function close() {
			document.removeEventListener('keydown', onKey, true);
			if (sayPause) window.removeEventListener('daimond:pause', sayPause);
			back.remove();
			if (prev && prev.focus) { try { prev.focus(); } catch (e) { /* gone */ } }
		}
		function onKey(e) {
			if (e.key === 'Escape') { e.preventDefault(); close(); }
			else if (e.key === 'Tab') keepFocusIn(card, e);
		}
		document.addEventListener('keydown', onKey, true);
		back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
		done.addEventListener('click', close);
		del.addEventListener('click', async function () {
			// The dialog goes first: a confirm drawn over its own opener reads as
			// two modals, and the answer is about the tile, not about the dialog.
			close();
			await opts.onDelete();
		});
		done.focus();
		return { card: card, close: close };
	}

	/// How full this conversation is, where it will fold, and a way to fold it now.
	///
	/// The figures existed and were unreachable: `FOLD_AT` is a constant in `compact.rs`,
	/// and the window an agent is really folding against — which a provider's refusal can
	/// have shrunk — had no getter at all. A user watching a meter climb could not tell
	/// "nearly there" from "plenty of room", and had no way to act on it either way.
	///
	/// **Folding costs money.** The summary is written by a model, so the button says what
	/// it is about to do rather than doing it and reporting afterwards.
	function mountContextSection(card, chat) {
		if (chat.status === 'pending') return;   // nothing has been said yet
		card.appendChild(secHead(t('tile.dlg_context')));

		var line = document.createElement('div');
		line.className = 'tile-dlg-note';
		function say() {
			var win = chatWindow(chat);
			var last = chat.lastPrompt || 0;
			if (!win.window) { line.textContent = t('tile.context_unknown'); return; }
			line.textContent = t('tile.context_line', {
				used: fmtCtx(last),
				all:  fmtCtx(win.window),
				at:   Math.round(win.foldAt * 100),
			});
		}
		say();
		card.appendChild(line);

		var row = document.createElement('div');
		row.className = 'tile-dlg-seg';
		var fold = document.createElement('button');
		fold.type = 'button';
		fold.className = 'tile-dlg-level';
		fold.textContent = t('tile.fold_context');
		fold.title = t('tile.fold_context_help');
		fold.addEventListener('click', async function () {
			if (chat._generating) { toast(t('tile.fold_mid_turn'), true); return; }
			var app = chat.app;
			if (!app || typeof app.fold_now !== 'function') {
				toast(t('tile.fold_unavailable'), true); return;
			}
			var ok = await confirmDialog(t('tile.fold_context_body'), t('tile.fold_context_ok'),
				{ title: t('tile.fold_context_title'), danger: false });
			if (!ok) return;
			fold.disabled = true;
			var moved = false;
			try {
				// The same sink a turn uses, and the same handling: a fold the user asked
				// for is written into the thread and persisted exactly as an automatic one
				// is. Anything less would leave the transcript quietly shorter than it was,
				// which is the one thing `appendCompacted` exists to prevent.
				moved = await app.fold_now(function (ev) {
					if (!ev || ev.type !== 'compacted') return;
					chat.messages.push({ role: 'fold_log', content: ev.content || '',
						folded: ev.folded || 0, kept: ev.kept || 0, mid: newMid(), ts: Date.now() });
					if (current && current.id === chat.id) appendCompacted(ev.content || '');
				});
			} catch (e) {
				fold.disabled = false;
				noticeDialog(t('tile.fold_failed'), friendlyError(e));
				return;
			}
			fold.disabled = false;
			// A fold that moved nothing is said plainly rather than left as a button press
			// with no consequence: below `MIN_KEEP_MESSAGES` there is no tail to cut.
			if (!moved) { toast(t('tile.fold_nothing')); return; }
			// The session on record is now the folded one, so the stored copy has to
			// follow — otherwise a reload springs the conversation back to its full size
			// and the fold the user paid for is undone.
			try { chat.lastPrompt = app.last_prompt_tokens || chat.lastPrompt || 0; }
			catch (e) { /* mid-turn read is impossible here; the turn is not running */ }
			captureSession(chat, app);
			persistChats();
			say();
			renderSessionList();
		});
		row.appendChild(fold);
		card.appendChild(row);
	}

	/// A Diamond's triggered actions, in its own settings dialog.
	///
	/// Notes2 asks for exactly this shape: "new triggered actions (TAs) can be added
	/// with a + icon, and selected for editing from a pulldown", and "To avoid
	/// clutter, Instruction and Context should just show an edit button and a copy
	/// button to facilitate copying between TAs and diamonds."
	///
	/// The clutter warning is the design. One row per action, each carrying its
	/// pause light, what it is in words, and a way in — and the two long texts
	/// behind Edit and Copy rather than two textareas apiece. Eight actions with
	/// their instructions inline would be a dialog nobody could read.
	function mountTriggers(card, opts) {
		if (!window.DaimondTriggers) return;
		card.appendChild(secHead(t('trig.head')));

		var host = document.createElement('div');
		host.className = 'trig-list';
		card.appendChild(host);

		function draw() {
			host.innerHTML = '';
			var list = Triggers.of(opts.id);
			if (!list.length) {
				host.appendChild(secNote(t('trig.none')));
			}
			list.forEach(function (ta) {
				var row = document.createElement('div');
				row.className = 'trig-row';
				// `prompted` has no light of its own: the daimon's `/self` leaf is
				// already the control for "may this Diamond answer me", and a second
				// one would let a user pause the daimon and still prompt it.
				if (ta.id !== 'prompted') {
					mountPause(row, DaimondTriggers.node(opts.id, ta.id), triggerLabel(ta));
				} else {
					var spacer = document.createElement('span');
					spacer.className = 'trig-spacer';
					row.appendChild(spacer);
				}
				var name = document.createElement('span');
				name.className = 'trig-name';
				name.textContent = triggerLabel(ta);
				row.appendChild(name);

				if (ta.id !== 'prompted') {
					row.appendChild(trigBtn('✎', t('trig.edit'), function () {
						editTrigger(opts.id, ta, draw);
					}));
					row.appendChild(trigBtn('⧉', t('trig.copy'), async function () {
						// The copy notes2 asks for: the two long texts, so an
						// instruction written once can be pasted into another TA or
						// another Diamond without being retyped.
						try {
							await navigator.clipboard.writeText(
								(ta.instruction || '') + (ta.context ? '\n\n---\n\n' + ta.context : ''));
							toast(t('trig.copied'));
						} catch (e) { toast(t('trig.copy_failed'), true); }
					}));
					row.appendChild(trigBtn('✕', t('trig.remove'), async function () {
						// An action with nothing written in it and nothing armed is the
						// one the user just added by pressing `+`, and asking them to
						// confirm the deletion of an empty thing is the friction that
						// made `+` feel one-way. There is nothing to lose, so there is
						// nothing to ask. Anything with an instruction still asks.
						var blank = !ta.on && !(ta.instruction || '').trim() && !(ta.context || '').trim();
						if (!blank) {
							var ok = await confirmDialog(t('trig.remove_body', { what: triggerLabel(ta) }),
								t('trig.remove'), { title: t('trig.remove'), danger: true });
							if (!ok) return;
						}
						await Triggers.remove(opts.id, ta.id);
						draw();
					}));
				}
				host.appendChild(row);
			});

			var add = document.createElement('div');
			add.className = 'trig-add';
			var sel = document.createElement('select');
			sel.className = 'tile-model';
			sel.setAttribute('aria-label', t('trig.add_kind'));
			[['activity', 'trig.kind_activity'], ['mail', 'trig.kind_mail']].forEach(function (pair) {
				var o = document.createElement('option');
				o.value = pair[0]; o.textContent = t(pair[1]);
				sel.appendChild(o);
			});
			var plus = trigBtn('+', t('trig.add'), async function () {
				var ta = DaimondTriggers.blank(sel.value);
				ta.id = sel.value + '-' + Date.now().toString(36);
				// A NEW action starts off. It has no instruction yet, so arming it
				// would arm something with nothing to say — and the one thing worse
				// than a trigger that does not fire is one that fires empty.
				ta.on = false;
				await Triggers.set(opts.id, ta);
				// Add, and stop. Opening the editor over the new row put its own ✕
				// behind a modal, so at the moment of the press nothing on screen
				// undid it: press `+` by mistake and a Diamond is armed with no
				// visible way back until the editor is dismissed. Notes2 asks for
				// add-then-choose in any case — actions are *"added with a + icon,
				// and selected for editing from a pulldown"* — so the row's own ✎
				// is the way in and its ✕ is the way back.
				draw();
			});
			add.appendChild(sel); add.appendChild(plus);
			host.appendChild(add);
		}
		draw();

		var note = document.createElement('div');
		note.className = 'tile-dlg-note';
		note.textContent = t('trig.note', { path: 'diamonds/' + opts.id + '/triggers.json' });
		card.appendChild(note);
	}

	function trigBtn(glyph, label, onClick) {
		var b = document.createElement('button');
		b.type = 'button';
		b.className = 'trig-btn';
		b.textContent = glyph;
		b.title = label;
		b.setAttribute('aria-label', label);
		b.addEventListener('click', onClick);
		return b;
	}

	function secNote(words) {
		var d = document.createElement('div');
		d.className = 'tile-dlg-note';
		d.textContent = words;
		return d;
	}

	/// The editor for one triggered action.
	async function editTrigger(diamondId, ta, done) {
		var body = document.createElement('div');
		body.className = 'trig-edit';

		function field(labelKey, el) {
			var wrap = document.createElement('label');
			wrap.className = 'trig-field';
			var lab = document.createElement('span');
			lab.className = 'trig-label';
			lab.textContent = t(labelKey);
			wrap.appendChild(lab); wrap.appendChild(el);
			body.appendChild(wrap);
			return el;
		}

		if (ta.kind === 'activity') {
			var mins = document.createElement('input');
			mins.type = 'number'; mins.min = '1'; mins.max = '1440';
			mins.value = String(ta.minutes || 30);
			mins.className = 'trig-input';
			field('trig.minutes', mins);
			var mnote = document.createElement('div');
			mnote.className = 'tile-dlg-note';
			mnote.textContent = t('trig.minutes_note');
			body.appendChild(mnote);
			var mref = mins;
		}
		if (ta.kind === 'mail') {
			var box = document.createElement('select');
			box.className = 'trig-input';
			var boxes = [];
			try { boxes = (window.DaimondMail && DaimondMail.accounts && DaimondMail.accounts()) || []; }
			catch (e) { boxes = []; }
			if (!boxes.length) {
				var o0 = document.createElement('option');
				o0.value = ''; o0.textContent = t('trig.no_mailbox');
				box.appendChild(o0);
			}
			boxes.forEach(function (addr) {
				var o = document.createElement('option');
				o.value = addr; o.textContent = addr;
				box.appendChild(o);
			});
			if (ta.mailbox) box.value = ta.mailbox;
			field('trig.mailbox', box);
			var fol = document.createElement('input');
			fol.type = 'text'; fol.className = 'trig-input';
			fol.value = ta.folder || 'INBOX';
			fol.placeholder = 'INBOX';
			field('trig.folder', fol);
			var bref = box, fref = fol;
		}

		var instr = document.createElement('textarea');
		instr.className = 'trig-area'; instr.rows = 4;
		instr.value = ta.instruction || '';
		instr.placeholder = t('trig.instruction_ph');
		field('trig.instruction', instr);

		var ctx = document.createElement('textarea');
		ctx.className = 'trig-area'; ctx.rows = 4;
		ctx.value = ta.context || '';
		ctx.placeholder = t('trig.context_ph');
		field('trig.context', ctx);
		var cnote = document.createElement('div');
		cnote.className = 'tile-dlg-note';
		cnote.textContent = t('trig.context_note');
		body.appendChild(cnote);

		await openBodyDialog(t('trig.edit_title', { what: triggerLabel(ta) }), body,
			{ okLabel: t('common.save') });

		var next = Object.assign({}, ta);
		if (ta.kind === 'activity') next.minutes = Math.max(1, Math.round(Number(mref.value) || 30));
		if (ta.kind === 'mail') { next.mailbox = bref.value || ''; next.folder = fref.value.trim() || 'INBOX'; }
		next.instruction = instr.value;
		// A changed context has NOT been sent, whatever was sent before. That is
		// what a person means by changing it, and the alternative -- keeping the
		// old stamp -- is a context the daimon never hears.
		if ((ctx.value || '').trim() !== (ta.context || '').trim()) next.contextSent = '';
		next.context = ctx.value;
		await Triggers.set(diamondId, next);
		if (done) done();
	}

	/// The three models a Diamond runs on, in its own settings dialog.
	///
	/// Which model a Diamond thinks with has been stored since Diamonds had models and
	/// shown nowhere, so the only way to see it was to read `localStorage` — and the only
	/// way to change it was to delete the Diamond and make another.
	///
	/// The three are not the same KIND of setting, and the dialog does not pretend they
	/// are:
	///
	///   * **The daimon** is persistent, so changing it ends one daimon and starts
	///     another. It is confirmed, and the change is written into the crystal's version
	///     history, where the Diamond's other discontinuities are.
	///   * **The workers** may be changed at any time and apply to NEW agents only. A
	///     worker already running keeps the model it was dispatched with, because moving
	///     it would bill one conversation to two models.
	///   * **The vision worker** is the second half of the same setting, keyed by
	///     modality. Empty means "use the text model", which is a real answer rather than
	///     a missing one.
	function mountDiamondModels(card, opts) {
		if (!window.DaimondModels) return;
		card.appendChild(secHead(t('tile.dlg_models')));

		var rec = diamondModels()[opts.id] || {};
		var own = diamondModel(opts.id);

		/// One labelled pulldown. `onPick` gets `{provider, model}`.
		function row(labelKey, helpKey, provider, model, allowNone, onPick) {
			var r = document.createElement('div');
			r.className = 'tile-dlg-model';
			var lab = document.createElement('span');
			lab.className = 'tile-model-chip';
			lab.textContent = t(labelKey);
			var sel = document.createElement('select');
			sel.className = 'tile-model';
			sel.title = t(helpKey);
			sel.setAttribute('aria-label', t(helpKey));
			populateModelSelect(sel, model || '', provider || '');
			if (allowNone) {
				// First, and selected when nothing is stored: "the same as the text one" is
				// this setting's default and has to be reachable again once it is left.
				var none = document.createElement('option');
				none.value = ''; none.dataset.provider = '';
				none.textContent = t('tile.model_same_as_text');
				sel.insertBefore(none, sel.firstChild);
				if (!model) sel.value = '';
			}
			sel.addEventListener('change', function () {
				var p = DaimondModels.pick(sel);
				// `pick` reads the selected option, so the "same as text" row comes back as
				// an empty model — which is exactly what the store wants for absent.
				onPick({ provider: p.provider || '', model: p.model || '' }, sel);
			});
			r.appendChild(lab); r.appendChild(sel);
			card.appendChild(r);
			return sel;
		}

		// ── The daimon.
		var daimonSel = row('tile.model_daimon', 'tile.model_daimon_help',
			own.provider, own.model, false, async function (p, sel) {
				var before = diamondModel(opts.id);
				if (p.model === before.model && p.provider === before.provider) return;
				var ok = await confirmDialog(
					t('tile.model_change_body', {
						from: shortModel(before.model) || t('tile.model_none'),
						to:   shortModel(p.model),
					}),
					t('tile.model_change_ok'),
					{ title: t('tile.model_change_title'), danger: false });
				if (!ok) {
					// Put the pulldown back. A refused confirm that left the control showing
					// the new model would be the app claiming a change it did not make.
					populateModelSelect(sel, before.model || '', before.provider || '');
					return;
				}
				setDiamondModel(opts.id, { provider: p.provider, model: p.model });
				// A DaimondApp has no setter for its model, so the cached client for this
				// Diamond has to go; `diamondApp` builds the new one on next use.
				resetDiamondApps();
				try {
					await diamondApp(opts.id).record_model_change(opts.id,
						t('tile.model_change_note', {
							from: before.model || '?', to: p.model,
						}));
				} catch (e) {
					// The setting is already written and in force. Say the history entry
					// failed rather than implying the change did.
					toast(t('tile.model_change_unlogged'), true);
				}
				if (currentDiamond && currentDiamond.id === opts.id) {
					await refreshDiamondAfterChange();
				} else {
					bumpDiamonds(); await loadDiamonds();
				}
			});

		// ── The workers, text.
		row('tile.model_workers', 'tile.worker_model_help',
			rec.workerProvider || own.provider, rec.workerModel || '', true, function (p) {
				setDiamondModel(opts.id, { workerProvider: p.provider, workerModel: p.model });
			});

		// ── The workers, vision.
		row('tile.model_vision', 'tile.model_vision_help',
			rec.visionProvider || '', rec.visionModel || '', true, function (p) {
				setDiamondModel(opts.id, { visionProvider: p.provider, visionModel: p.model });
			});

		var note = document.createElement('div');
		note.className = 'tile-dlg-note';
		note.textContent = t('tile.model_note');
		card.appendChild(note);
		return daimonSel;
	}

	/// A settings dialog for something that is not a tile: a title, a body somebody
	/// else built, and Delete at the foot.
	///
	/// The mail module asked for this by name (`deps.bodyDialog`) and shipped a
	/// stand-in of its own furniture because the alternative was a gear that opened
	/// nothing. This is the real one, and it is deliberately the SAME dialog phase C
	/// built: the same focus trap, the same Escape, the same Delete-on-the-left foot.
	/// Notes2 asks for the mailbox's closer cross to become a Delete at the foot of
	/// its settings dialog, which is the same sentence it uses about a tile — so it
	/// had better be the same dialog, or the two will drift the first time either is
	/// touched.
	///
	/// # Arguments
	/// * `title` - The heading, which also names the dialog to the accessibility tree.
	/// * `body` - An element to put under it.
	/// * `opts.onDelete` - Async; called after the dialog closes. Omit for no Delete.
	/// * `opts.deleteLabel` - What the destructive button says.
	function openBodyDialog(title, body, opts) {
		opts = opts || {};
		var back = document.createElement('div');
		back.className = 'modal dlg tile-dlg';
		var card = document.createElement('div');
		card.className = 'modal-card dlg-card tile-dlg-card';
		card.setAttribute('role', 'dialog');
		card.setAttribute('aria-modal', 'true');
		var h = document.createElement('h2');
		h.textContent = title || '';
		h.id = 'body-dlg-h-' + (++_tileDlgSeq);
		card.setAttribute('aria-labelledby', h.id);
		card.appendChild(h);
		if (body) card.appendChild(body);

		var row = document.createElement('div');
		row.className = 'dlg-actions tile-dlg-foot';
		var del = null;
		if (typeof opts.onDelete === 'function') {
			del = document.createElement('button');
			del.type = 'button';
			del.className = 'dlg-ok danger tile-dlg-delete';
			del.textContent = opts.deleteLabel || t('tile.dlg_delete');
			row.appendChild(del);
		}
		var done = document.createElement('button');
		done.type = 'button';
		done.className = 'modal-close dlg-cancel tile-dlg-done';
		done.textContent = opts.okLabel || t('dlg.done');
		row.appendChild(done);
		card.appendChild(row);
		back.appendChild(card);
		document.body.appendChild(back);

		var prev = document.activeElement;
		return new Promise(function (resolve) {
			function close(v) {
				document.removeEventListener('keydown', onKey, true);
				back.remove();
				if (prev && prev.focus) { try { prev.focus(); } catch (e) { /* gone */ } }
				resolve(v);
			}
			function onKey(e) {
				if (e.key === 'Escape') { e.preventDefault(); close(true); }
				else if (e.key === 'Tab') keepFocusIn(card, e);
			}
			document.addEventListener('keydown', onKey, true);
			back.addEventListener('mousedown', function (e) { if (e.target === back) close(true); });
			done.addEventListener('click', function () { close(true); });
			if (del) del.addEventListener('click', async function () {
				// The dialog goes first: a confirm drawn over its own opener reads as
				// two modals, and the answer is about the mailbox, not about the dialog.
				close(false);
				await opts.onDelete();
			});
			done.focus();
		});
	}

	/// One section heading inside a tile dialog.
	function secHead(words) {
		var d = document.createElement('div');
		d.className = 'tile-dlg-head';
		d.textContent = words;
		return d;
	}

	/// Put a tile's chosen level of detail onto its box, so the CSS can act on
	/// it. Cheap enough to call on any tile at any time, and it is what lets the
	/// dialog change the rail behind itself without a re-render.
	function applyTileDetail(id) {
		var boxes = document.querySelectorAll('.session-box[data-id="' + cssId(id) + '"]');
		for (var i = 0; i < boxes.length; i++) boxes[i].dataset.detail = tileDetail(id);
	}

	/// Escape an id for use inside an attribute selector. Chat and Diamond ids
	/// are generated, but a quote in one would otherwise break the selector.
	function cssId(id) { return String(id == null ? '' : id).replace(/["\\]/g, '\\$&'); }

	function updateActiveSession() {
		sessionList.querySelectorAll('.session-box').forEach(function (box) {
			box.classList.toggle('active', current && box.dataset.id === current.id);
		});
	}

	function renderSessionList() {
		// A turn aborted by the lock still runs its finally block, which asked for
		// a re-render — and repainted the chat list, names and spend, behind the
		// lock screen. Nothing draws while locked, no matter who asks.
		if (locked) return;
		sessionList.innerHTML = '';
		// A daimon's conversation is a chat record and NOT a chat: it belongs to its
		// Diamond, is reached through that Diamond's chat view, and has no tile of its
		// own. This is the only place the difference shows — everything else that walks
		// `chats` (spend, the fold-model sweep, "is anything generating", the sync
		// parcel) wants it counted exactly like the rest.
		var loose = chats.filter(function (c) { return !c.diamondId; });
		if (loose.length === 0) {
			var note = document.createElement('div');
			note.className = 'rail-note';
			note.textContent = t('rail.no_chats');
			sessionList.appendChild(note);
			repaintPause();
			return;
		}
		loose.forEach(function (s) { sessionList.appendChild(sessionBox(s)); });
		updateActiveSession();
		// A chat appearing or going changes what is under the root, and the root's
		// own light is not rebuilt here. `DaimondPause` announces when the STATE
		// moves; nothing announces when the tree does.
		repaintPause();
	}

	// Populate a <select> with the cached model list, keeping `selected` (and
	// the default) present even if the list has not loaded yet.
	/// Fill a model pulldown: every provider's models, grouped under the provider that runs them.
	///
	/// This used to list the models of the ONE provider the app held. With a key per provider, a
	/// bare model id no longer says which key to send it with, so the picker is grouped and the
	/// provider rides on the option. `DaimondModels` owns both, because the tile and the New Diamond
	/// dialog must not each grow their own idea of what a model is.
	function populateModelSelect(sel, selected, provider) {
		if (!window.DaimondModels) { sel.innerHTML = ''; sel.disabled = true; return; }
		DaimondModels.fillSelect(sel, provider || '', selected || '');
	}

	/// Where a conversation folds, as a fraction of its window: `compact::FOLD_AT`.
	///
	/// Named here only so a tile whose agent has not been built yet can still draw the
	/// mark. Where there IS an agent its own figure is preferred, because that is the one
	/// actually in force.
	var DEFAULT_FOLD_AT = 0.8;

	/// The window this chat is really folding against, and where in it the fold happens.
	///
	/// Not simply what the provider publishes. A provider that refuses an oversized prompt
	/// teaches the agent a SMALLER window (`Limits::learn_from_refusal`), and from then on
	/// a meter drawn from the published figure is measuring against a window this chat has
	/// already been told it does not have — reading comfortable while the next turn folds.
	function chatWindow(s) {
		var app = s && s.app;
		if (app) {
			try {
				var learnt = app.context_window || 0;
				if (learnt > 0) {
					return { window: learnt, foldAt: app.fold_at || DEFAULT_FOLD_AT };
				}
			} catch (e) { /* an older wasm build has no getter */ }
		}
		var cw = window.DaimondPricing
			? DaimondPricing.contextWindow(s.model, s.provider || '') : null;
		var at = DEFAULT_FOLD_AT;
		if (app) { try { at = app.fold_at || DEFAULT_FOLD_AT; } catch (e) { /* ditto */ } }
		return { window: cw || 0, foldAt: at };
	}

	// The live per-chat meter: context-window fraction · tokens · cost.
	function tileMeter(s) {
		var wrap = document.createElement('div');
		wrap.className = 'tile-meter';
		var total = (s.promptTokens || 0) + (s.completionTokens || 0);
		var win = chatWindow(s);
		var cw = win.window;
		var last = s.lastPrompt || 0;
		if (cw && last > 0) {
			var pct = Math.min(100, Math.round(last / cw * 100));
			var foldPct = Math.round(win.foldAt * 100);
			var ctx = document.createElement('span');
			ctx.className = 'tile-ctx';
			ctx.title = t('tile.context_used_folds', {
				used: fmtCtx(last), all: fmtCtx(cw), at: foldPct,
			});
			var bar = document.createElement('span'); bar.className = 'tile-ctx-bar';
			var fill = document.createElement('span');
			fill.className = 'tile-ctx-fill' + (pct >= foldPct ? ' high' : '');
			fill.style.width = pct + '%';
			bar.appendChild(fill);
			// Where the fold happens, drawn ON the bar. The number has existed in
			// `compact.rs` since folding was written and has never been anywhere a user
			// could see it, so a meter at 78% said nothing about whether that was nearly
			// there or plenty of room.
			var mark = document.createElement('span');
			mark.className = 'tile-ctx-fold';
			mark.style.left = foldPct + '%';
			bar.appendChild(mark);
			var lab = document.createElement('span'); lab.className = 'tile-ctx-pct'; lab.textContent = pct + '%';
			ctx.appendChild(bar); ctx.appendChild(lab);
			wrap.appendChild(ctx);
		}
		var toks = document.createElement('span'); toks.className = 'tile-tok';
		toks.textContent = fmtCtx(total) + ' tok';
		wrap.appendChild(toks);
		if (window.DaimondPricing && total > 0) {
			var cost = document.createElement('span'); cost.className = 'tile-cost';
			// What the provider charged, where it said. Only when it did not is the table asked,
			// and then with the cached share and the provider id -- both of which this used to
			// throw away, so a cache-heavy chat was billed on the tile as though every prompt
			// token were fresh.
			if ((s.costUsd || 0) > 0) {
				cost.textContent = fmtUsd(s.costUsd);
				cost.title = t('tile.cost_so_far');
			} else {
				var pr = DaimondPricing.priceFor(s.model, s.promptTokens || 0, s.completionTokens || 0,
					s.cachedTokens || 0, s.provider || '');
				cost.textContent = (pr.estimated && !DaimondI18n.converted() ? '≈' : '') + fmtUsd(pr.usd);
				cost.title = t(pr.estimated ? 'tile.cost_estimated' : 'tile.cost_so_far');
			}
			wrap.appendChild(cost);
		}
		return wrap;
	}

	function sessionBox(s) {
		var status = s.status || 'active';
		var box = document.createElement('div');
		box.className = 'session-box chat-box ' + status + (current && s.id === current.id ? ' active' : '');
		box.dataset.id = s.id;
		// How much of itself this tile draws. Simple by default; the cog's dialog
		// is where it changes, and the CSS is what acts on it.
		box.dataset.detail = tileDetail(s.id);

		// Editable label — the single place a chat is named (D-UI: one source).
		var header = document.createElement('div');
		header.className = 'session-box-header';
		// A chat is a leaf: binary, and the same control as everywhere else.
		mountPause(header, DaimondPause.id('root', 'chats', s.id),
			s.name || t('pause.unnamed_chat'));
		var label = document.createElement('input');
		label.className = 'tile-label';
		label.value = s.name; label.spellcheck = false;
		// Keep browsers from scavenging this label as a login "username".
		label.setAttribute('autocomplete', 'off');
		label.setAttribute('data-1p-ignore', '');
		label.setAttribute('data-lpignore', 'true');
		label.title = t('tile.click_to_open');
		label.readOnly = true;                    // a click opens the chat...
		label.addEventListener('click', function (e) {
			if (label.readOnly) { e.stopPropagation(); selectChat(s); }
		});
		label.addEventListener('dblclick', function (e) {
			// ...and a deliberate second click renames it.
			e.stopPropagation();
			label.readOnly = false;
			label.focus();
			label.select();
		});
		label.addEventListener('blur', function () { label.readOnly = true; });
		label.addEventListener('keydown', function (e) {
			// Enter OPENS the chat while the field is resting, and only commits a
			// rename once a double-click has made it editable. Tab reached this
			// tile before but nothing the keyboard could do would open the chat:
			// Enter blurred it, which is the one thing that looks like it worked.
			if (e.key === 'Enter' && label.readOnly) {
				e.preventDefault();
				selectChat(s);
				return;
			}
			if (e.key === ' ' && label.readOnly) {
				e.preventDefault();
				selectChat(s);
				return;
			}
			if (e.key === 'Enter') { e.preventDefault(); label.blur(); }
			else if (e.key === 'Escape') { label.value = s.name; label.blur(); }
		});
		label.addEventListener('change', function () { renameChat(s, label.value); });
		header.appendChild(label);
		header.appendChild(tileCog(s.name, function () {
			openTileDialog({
				id:       s.id,
				name:     s.name,
				node:     DaimondPause.id('root', 'chats', s.id),
				// A chat's MODELS are fixed at creation, but its conversation is the only
				// one in the app with a durable session — so this is where the context
				// section goes, and the models section does not.
				chat:     s,
				onDelete: function () { return deleteChat(s); },
			});
		}));
		box.appendChild(header);

		if (status === 'pending') {
			// Pending: pick a model, then Start. Nothing runs until Start.
			var ctrls = document.createElement('div');
			ctrls.className = 'tile-pending';
			var sel = document.createElement('select');
			sel.className = 'tile-model';
			populateModelSelect(sel, s.model || cfg.model || '', s.provider || '');
			sel.addEventListener('click', function (e) { e.stopPropagation(); });
			// The provider comes off the option, not out of the value: the same model name can
			// sit behind two different keys, and only the option knows which one this is.
			sel.addEventListener('change', function () {
				var p = DaimondModels.pick(sel);
				s.model = p.model; s.provider = p.provider;
				// The workers follow the chat's model until the user moves them off it
				// themselves. "Defaults to the main model" has to keep meaning that while the
				// main model is still being chosen, or a user who picks the chat's model second
				// gets workers on whatever they happened to look at first.
				if (!wsel._chosen) {
					s.workerModel = p.model; s.workerProvider = p.provider;
					populateModelSelect(wsel, p.model, p.provider);
				}
			});
			var start = document.createElement('button');
			start.className = 'tile-start';
			start.textContent = '▶ ' + t('tile.start');
			start.title = t('tile.start_help');
			start.addEventListener('click', function (e) {
				e.stopPropagation();
				var p = DaimondModels.pick(sel);
				startChat(s, p.model, p.provider, DaimondModels.pick(wsel));
			});
			ctrls.appendChild(sel); ctrls.appendChild(start);
			box.appendChild(ctrls);

			// Below it: the model this chat's WORKERS run on. Its own row, because it is a second
			// decision about money -- a fan-out is several turns at once, and it used to be taken
			// silently on whatever model happened to be starred. A worker is dispatched by a
			// Diamond's daimon, so this is what a Diamond cut from this chat inherits.
			var wrow = document.createElement('div');
			// Its own class, so Simple can take the whole row away: the "Workers"
			// chip on its own would be a label naming a control that is not there.
			wrow.className = 'tile-pending tile-worker-row';
			var wlab = document.createElement('span');
			wlab.className = 'tile-model-chip';
			wlab.textContent = t('tile.workers');
			var wsel = document.createElement('select');
			wsel.className = 'tile-model tile-worker-model';
			wsel.title = t('tile.worker_model_help');
			wsel.setAttribute('aria-label', t('tile.worker_model_help'));
			populateModelSelect(wsel, s.workerModel || s.model || cfg.model || '',
				s.workerProvider || s.provider || '');
			wsel.addEventListener('click', function (e) { e.stopPropagation(); });
			wsel.addEventListener('change', function () {
				var p = DaimondModels.pick(wsel);
				s.workerModel = p.model; s.workerProvider = p.provider;
				wsel._chosen = true;		// from here it no longer follows the chat's own model
			});
			wrow.appendChild(wlab); wrow.appendChild(wsel);
			box.appendChild(wrow);
		} else {
			// Active: model chip + Fold on one row, the live meter below.
			var meta = document.createElement('div');
			meta.className = 'tile-active';
			var top = document.createElement('div');
			top.className = 'tile-active-top';
			var chip = document.createElement('span');
			chip.className = 'tile-model-chip';
			chip.textContent = shortModel(s.model); chip.title = s.model || '';
			top.appendChild(chip);
			var fold = document.createElement('button');
			fold.className = 'tile-fold' + (s.foldedInto ? ' folded' : '');
			// A chat that has been folded says so, rather than looking untouched
			// and inviting the same fold again and again.
			// "Fold all", because the chat panel now also folds a chosen few turns, and a button
			// that says only "Fold" no longer says which of the two it does.
			fold.textContent = t(s.foldedInto ? 'tile.folded' : 'tile.fold_all');
			fold.title = s.foldedInto
				? t('tile.folded_help', { name: s.foldedInto.name })
				: t('tile.fold_all_help');
			fold.addEventListener('click', function (e) { e.stopPropagation(); openFoldPicker(s, fold); });
			top.appendChild(fold);
			// What is waiting on this chat. A queue is only drawn in the thread of
			// the chat on screen, so one left behind while the user works elsewhere
			// was invisible until they happened to go back — and it is money about
			// to be spent, which is not a thing to leave people to remember.
			var qb = queueBadge(s);
			if (qb) top.appendChild(qb);
			meta.appendChild(top);
			meta.appendChild(tileMeter(s));
			box.appendChild(meta);
		}

		box.addEventListener('click', function () {
			if (current && s.id === current.id) { if (isMobile()) mshow('ai'); return; }
			selectChat(s);
			if (isMobile()) mshow('ai');
		});
		return box;
	}

	// ── Send a turn ────────────────────────────────────────────
	function ensureApp(chat) {
		if (chat.app) return chat.app;
		// A chat runs on the provider and model it was started with, and falls back to the
		// default. Both travel with the chat, so a later change of default leaves it alone.
		var a = appCfgFor(chat);
		// A DaimondApp's key is fixed at construction, so record WHICH minted key it froze. A
		// chat built before somebody else re-minted holds a revoked key and will 401 on its next
		// turn; the generation is how the retry tells that apart from a key that is genuinely
		// spent, and takes the live key instead of buying another. Not persisted: `slimChat`
		// keeps a whitelist, and this belongs to the app object, which does not survive a reload.
		chat._gen = creditsGen();
		// `_capTry` is set only while a turn is mid-backoff, after a provider
		// refused the length first asked for; it lasts exactly as long as that
		// retry and is not persisted.
		chat.app = new DaimondApp(a.baseUrl, a.apiKey, a.model,
			chat._capTry || maxOutFor(a.model, a.provider),
			Instructions.compose(SYSTEM_PROMPT(), ''), cfg.tools !== false);
		chat.model    = a.model;
		chat.provider = a.provider || chat.provider || '';
		// A chat freezing its model is a use of it. Recorded here rather than in the
		// pulldown, because a model picked and never run is not one anybody uses.
		try { DaimondModels.noteUse(chat.provider, chat.model); } catch (e) { /* never block a turn */ }
		// How big this model's window is, so a long chat is folded before the provider
		// refuses it rather than after. `contextWindow` returns null for a model nobody
		// publishes a figure for, and a null is left alone: the agent's own default
		// assumption is a better guess than a number invented here, and the reactive
		// fold still catches a refusal either way.
		try {
			var cw = window.DaimondPricing
				? DaimondPricing.contextWindow(a.model || chat.model, chat.provider || '')
				: null;
			if (cw && chat.app.set_context_window) chat.app.set_context_window(cw);
		} catch (e) { /* an older wasm build has no setter */ }
		applyRoundLimit(chat.app);
		applyFoldSettings(chat.app, chat.provider || '');
		applyCrystalCap(chat.app);
		// A rebuilt DaimondApp starts with an empty Session, so a chat reopened
		// after a reload would send only its newest message and the model
		// would answer with no memory of the conversation on screen. Seed
		// the persisted history back in, with the token counters, so the
		// first turn after a reload is also metered against the real total.
		var hist = (chat.messages || []).filter(function (msg) {
			return msg && msg.content && (msg.role === 'user' || msg.role === 'assistant');
		});
		// The model's OWN conversation first, when one was stored. It is a different
		// thing from the transcript on screen: it carries the provider's tool-call ids,
		// so what the agent read, wrote and ran comes back with it — and it is the
		// FOLDED list when compaction has run, so a reloaded chat does not spring back
		// to the full size the screen still shows.
		var sess = chat.session, seeded = 0;
		if (sess && sess.msgs && sess.msgs.length && chat.app.restore_session) {
			try {
				seeded = chat.app.restore_session(sess.msgs,
					chat.promptTokens || 0, chat.completionTokens || 0, chat.lastPrompt || 0,
					chat.cachedTokens || 0, chat.costUsd || 0);
			} catch (e) { seeded = 0; }
		}
		if (seeded) {
			// Turns another tab took after this session was stored. Prose only — that is
			// all a screen transcript holds — appended behind the part that carries ids.
			if (chat.app.append_message) {
				tailAfter(chat, sess).forEach(function (m) {
					try { chat.app.append_message(m.role, m.content || ''); } catch (e) { /* skip one */ }
				});
			}
		} else if (hist.length) {
			// No usable session: the old path, which is also the path a chat written by
			// an earlier build takes, and the one a backup from before this store took.
			chat.app.restore(hist, chat.promptTokens || 0, chat.completionTokens || 0, chat.lastPrompt || 0,
				chat.cachedTokens || 0, chat.costUsd || 0);
		}
		if (seeded || hist.length) {
			// The wasm counters now hold the restored totals, so meter the
			// next turn against those rather than against zero. All four, not
			// two: a cost counter restored to the session total while its `prev`
			// stayed at zero would bill the whole reloaded conversation again as
			// the first turn after the reload.
			chat.prevPrompt     = chat.promptTokens || 0;
			chat.prevCompletion = chat.completionTokens || 0;
			chat.prevCached     = chat.cachedTokens || 0;
			chat.prevCost       = chat.costUsd || 0;
		}
		return chat.app;
	}

	/// Store the conversation the MODEL holds for `chat`, as its agent now has it.
	///
	/// Called at the end of every turn, win or lose. What it saves is not the transcript
	/// on screen: it is the agent's own message list, which carries the provider's
	/// tool-call ids — the thing the browser cannot mint, because it never sees them —
	/// and which compaction has already folded if the conversation outgrew the window.
	///
	/// `upto` marks the last screen message the stored list accounts for, so a turn
	/// another tab took meanwhile can be appended on the next restore rather than lost
	/// or, worse, added twice.
	function captureSession(chat, app) {
		if (!chat || !app || !app.export_session) return;
		try {
			var msgs = app.export_session();
			if (!msgs || !msgs.length) return;
			var all  = chat.messages || [];
			var last = all.length ? all[all.length - 1] : null;
			chat.session = {
				v:      1,
				msgs:   Array.prototype.slice.call(msgs),
				upto:   last ? (last.mid || '') : '',
				uptoTs: last ? (last.ts  || 0)  : 0,
			};
		} catch (e) { /* the chat is fine without it; the next turn writes another */ }
	}

	/// The screen messages a stored session does not already account for.
	///
	/// By position while the marker is still in the transcript, and by timestamp when it
	/// is not — a message can be tombstoned out from under the marker (continuing an
	/// interrupted turn does exactly that), and falling back to the clock is what stops
	/// the tail from replaying the whole conversation a second time.
	function tailAfter(chat, sess) {
		var msgs = chat.messages || [];
		var from = -1;
		if (sess && sess.upto) {
			for (var i = 0; i < msgs.length; i++) {
				if (msgs[i] && msgs[i].mid === sess.upto) { from = i; break; }
			}
		}
		var tail = (from >= 0)
			? msgs.slice(from + 1)
			: msgs.filter(function (m) { return m && (m.ts || 0) > ((sess && sess.uptoTs) || 0); });
		return tail.filter(function (m) {
			return m && m.content && (m.role === 'user' || m.role === 'assistant');
		});
	}

	/// Is this failure a provider refusing the key it was sent?
	function keyRefused(raw) {
		var s = String(raw == null ? '' : (raw && raw.message ? raw.message : raw));
		return /\b401\b|\b403\b/.test(s);
	}

	/// Which minted key is live, so a thing built around one can say which it froze.
	function creditsGen() {
		return window.DaimondModels ? DaimondModels.creditsGen() : 0;
	}

	/// Can this chat's key simply be replaced by asking for another one?
	///
	/// Only the credits row's can. It is the only key Daimond mints, and the only one whose
	/// refusal is ordinary rather than a mistake: a minted key is capped at the balance it was
	/// minted against, so exhausting that cap looks, from the provider's side of the wire,
	/// exactly like a bad key. A key the user typed and had refused is a key the user has to
	/// look at, so that one is reported and not quietly retried.
	function canRemint(chat) {
		return !!(window.DaimondModels && chat && chat.provider === DaimondModels.CREDITS);
	}

	/// Rebuild a chat's agent on a fresh key, WITHOUT the message this turn is sending.
	///
	/// `ensureApp` restores the whole persisted history, and by now that history already holds
	/// the message the turn is about: `runTurn` persists first, before a single token comes
	/// back, so that a crash in the next moment cannot eat what the user typed. Seeding it into
	/// the new session AND handing it to `run_turn` again would ask the model the same question
	/// twice, so it is held out of the restore and left to `run_turn`, which is where it was
	/// always going.
	function rebuildAppWithout(chat, mid) {
		var keep = chat.messages;
		chat.messages = keep.filter(function (m) { return m.mid !== mid; });
		chat.app = null;
		try { return ensureApp(chat); }
		finally { chat.messages = keep; }
	}

	/// Is the CURRENT chat mid-turn? Generation is per-chat now, so a turn
	/// running in one chat no longer freezes the others.
	function curGen() { return !!(current && current._generating); }
	/// Is any chat mid-turn? Used where leaving would kill in-flight work.
	function anyGen() { return chats.some(function (c) { return c._generating; }); }

	// A minimal, read-only view of whether work is in flight, so the updater can pick a safe moment
	// to reload for a new version without reaching into the turn machinery. "Busy" is any chat turn
	// or any spawned agent still running; the composer check keeps a half-typed prompt from being
	// reloaded away.
	/// Is anything waiting to be sent, in any chat? A queued message is work in
	/// flight as far as the updater is concerned: reloading for a new version would
	/// throw it away as surely as reloading over a half-typed prompt.
	function anyQueued() {
		return chats.some(function (c) { return waitingOn(c) > 0; });
	}

	window.DaimondCore = {
		busy:            function () { return anyGen() || anyQueued() || (typeof Workers !== 'undefined' && Workers && Workers.active > 0); },
		/// Which permission mode the ENGINE is in — its own answer, not the page's
		/// copy of it.
		///
		/// The two can differ, and the difference is the only one that matters: the
		/// engine's copy decides what runs, and a surface drawing the other one would
		/// be reporting an intention rather than a fact. Published because it is the
		/// only honest source for anything that wants to say what is in force.
		permissionMode:  function () {
			try { return (Wasm && Wasm.permission_mode) ? Wasm.permission_mode() : ''; }
			catch (e) { return ''; }
		},
		/// Hold Tab inside `card` for one keydown. Published because the two
		/// popovers in workspace.js are `role="dialog"` and have to keep the
		/// promise that makes -- and a second copy of a focus trap is a second
		/// thing to keep right, which is how the two would drift apart.
		keepFocusIn:     keepFocusIn,
		/// Draw the lock card. Published for `verify_reloadloop`, which has to
		/// open it on demand to prove the trail appears on a looping app and NOT
		/// on a working one -- and the only honest way to check that is through
		/// the function the app itself calls.
		showIdentity:    showIdentity,
		composerHasText: function () { return !!(chatInput && chatInput.value && chatInput.value.trim()); },
		// Post a message to the one conversation from somewhere other than the
		// composer — the phone sheet's "Ask about this" pill. Goes through the
		// same send path, so there is still only one way a turn begins.
		ask: function (text) {
			if (!chatInput || curGen()) return;
			chatInput.value = text;
			sendUserMessage();
		},
		// Cross-device sync (driven by sync.js): read the state to push, and
		// apply what was pulled. Read-only views onto the chat store, so the
		// sync engine never reaches into turn machinery.
		collectSync:     collectSync,
		applySync:       applySync,
		/// The one chat store, reached in one place.
		///
		/// Transcripts live in IndexedDB, which the app can be wrong about: the
		/// in-memory mirror is what every caller reads, and a mirror that has
		/// drifted from the database is exactly the failure that loses work. So
		/// the store itself is published, and anything that needs to know what is
		/// actually held -- rather than what this tab believes is held -- asks it
		/// rather than keeping a second opinion.
		chatStore:       function () { return ChatStore; },
		// This device's coarse self-description ("Chromium on Linux"). sync.js
		// sends it as the mailbox's display label -- the one field the gateway
		// keeps in the clear -- because the account's chosen name is the user's
		// own words and must never leave the browser readable.
		deviceSelfName:  deviceName,
		// After a successful push, the pushed state is the new common fork point
		// for the file 3-way merge; sync.js calls this then.
		syncCommitBaseline: commitFileBaseline,
		/// Whether this device may DECLARE the account's live chunk set.
		///
		/// Committing tells the gateway to sweep every chunk the declared index
		/// does not name, so only a device whose index is merged with everyone
		/// else's may do it -- and this is exactly the condition under which
		/// applyChunked merges. A device that refused the other device's index and
		/// then committed its own swept the account's cloud files away.
		syncMayCommitChunks: function () { return !!window.DaimondCloud && filesSyncable(); },
		// The tombstone machinery, shared. A store that syncs by UNION needs a
		// record of what was deleted, or absence reads as "that device never had
		// it" and the row comes straight back on the next pull. Chats, Diamonds,
		// providers and mailboxes all need one, and they all need the SAME one:
		// one TTL, one union rule, one place to change either. models.js and
		// mail.js keep their maps under their own keys and call these.
		tombs:           loadTombMap,
		tombstone:       tombstoneIn,
		mergeTombs:      mergeTombMap,
	};
	/// Point the one composer at whichever chat is on screen: showing Stop while
	/// that chat generates and nothing is typed, ready to type either way.
	///
	/// The box is no longer disabled mid-turn, and what is typed into it no longer
	/// merely waits: a turn is many requests, and between two of them the message
	/// list is rebuilt, so a correction can go to the model in the turn it was meant
	/// to redirect. Stop is still on the button whenever the box is empty, which is
	/// the state anything asking "is a turn running?" looks at.
	function syncComposer() {
		if (!chatInput) return;
		var g = curGen();
		chatInput.disabled = false;
		syncSendMode();
		// Where a user finds out they may keep typing: the placeholder is on screen
		// exactly when the box is empty and they are wondering whether to wait. What
		// then happens to what they type is said by the line above the bubbles, at
		// the moment it matters -- there is not room for it here.
		// A paused Diamond says so in the box you would otherwise type into, exactly
		// as its crystal's own box does. Both faces of a Diamond share one composer
		// now, so both had to learn the same sentence.
		chatInput.placeholder = g ? t('chat.queue_ph')
			: (current && current.diamondId && diamondHeld(current.diamondId))
				? t('crystal.steer_paused')
				: t('chat.input_ph');
		if (!g) hideSpinner();
		syncConciseChip();           // the chip belongs to THIS chat, not the last one
		renderQueue();               // this chat's own queue, not the last one's
	}

	// ── The concise chip ───────────────────────────────────────
	//
	// Notes2 asks for "a 'concise' chip in the chat header" that injects a
	// `/concise` call into user input. The skill machinery is already there and
	// is machinery rather than convention: `parse_command` in the wasm resolves
	// a leading `/name` to the file's own text BEFORE the turn starts, and a
	// name that resolves to nothing REFUSES the turn rather than falling
	// through to ordinary chat.
	//
	// Two things follow, and both are why this is not a hidden prompt tweak:
	//
	//   * The instruction is a file — `.daimond/skills/concise.md` — that the
	//     user can read, edit and take with the folder. What "concise" means is
	//     theirs to decide, and the seeded text is only a first draft.
	//   * The prefix goes on the message ITSELF, so the transcript shows what
	//     was actually asked. A chip that quietly changed the request and left
	//     the thread looking untouched would be the same silent failure the
	//     slash machinery exists to end.
	//
	// A message the user has already begun with a `/` is left alone: two
	// commands in one message means only the first resolves, so prefixing would
	// silently swallow the one they typed.

	var CONCISE_SKILL = '.daimond/skills/concise.md';
	var CONCISE_DIR   = '.daimond/skills';

	// ── `/` says what it can do ──────────────────────────────────────
	//
	// Notes2: "We should have proper skills using '/'." They have worked since
	// seq 65 — `src/skills.rs` resolves a `/name` before the turn starts — and
	// nothing anywhere told the user they existed. A feature nobody can discover
	// is a feature nobody has.
	//
	// So a `/` alone in an empty box lists what is there. Not a fuzzy palette and
	// not a second command language: the names are file stems, the list is the
	// directory, and picking one types the command you would have typed.
	var _skillMenu = null;

	function closeSkillMenu() {
		if (!_skillMenu) return;
		_skillMenu.remove();
		_skillMenu = null;
		document.removeEventListener('click', onSkillOutside, true);
	}
	function onSkillOutside(e) {
		if (_skillMenu && !_skillMenu.contains(e.target) && e.target !== chatInput) closeSkillMenu();
	}

	/// Every skill this account can invoke, by name.
	///
	/// Read from the STORE, which is where `.daimond/skills` lives and where the
	/// concise chip writes its own. A folder open in the workspace may carry more
	/// — `skills.rs` searches both — and those are listed too, so the menu says
	/// what a turn would actually find rather than half of it.
	async function listSkills() {
		var names = {};
		function take(n) {
			n = String(n || '').trim().replace(/\/$/, '');
			if (/\.md$/i.test(n)) names[n.replace(/\.md$/i, '')] = 1;
		}
		// TWO FORMATS, and they are not the same. `store_list` is this app's own
		// door and returns `name<TAB>kind<TAB>bytes`; `file_list` is the MODEL's
		// tool and returns `name (n bytes)`. Parsing one with the other's reader
		// silently found nothing -- which is exactly how a menu comes up empty
		// beside a directory with two files in it.
		try {
			String(await Wasm.store_list(CONCISE_DIR) || '').split('\n')
				.forEach(function (line) { if (line) take(line.split('\t')[0]); });
		} catch (e) { /* nothing written yet */ }
		if (folderOpen()) {
			try {
				var raw = await tools().run_tool('file_list', JSON.stringify({ path: CONCISE_DIR }));
				if (typeof raw === 'string' && !/^\s*Error\b/i.test(raw)) {
					raw.split('\n').forEach(function (line) {
						var m = line.match(/^\s*(?:[-*]\s*)?(\S.*?)(?:\s+\(\d+.*\))?\s*$/);
						if (m) take(m[1]);
					});
				}
			} catch (e) { /* the folder carries none */ }
		}
		return Object.keys(names).sort();
	}

	/// Show the list under the composer, or say there is nothing to show.
	async function openSkillMenu() {
		closeSkillMenu();
		var names = await listSkills();
		var menu = document.createElement('div');
		menu.className = 'skill-menu';
		menu.setAttribute('role', 'listbox');
		menu.setAttribute('aria-label', t('skills.menu'));
		if (!names.length) {
			var none = document.createElement('div');
			none.className = 'skill-none';
			none.textContent = t('skills.none', { dir: CONCISE_DIR });
			menu.appendChild(none);
		}
		names.forEach(function (n) {
			var b = document.createElement('button');
			b.type = 'button';
			b.className = 'skill-item';
			b.setAttribute('role', 'option');
			b.textContent = '/' + n;
			b.addEventListener('click', function () {
				closeSkillMenu();
				// The command you would have typed, with the space after it, so the
				// next thing you type is its argument.
				chatInput.value = '/' + n + ' ';
				chatInput.focus();
			});
			menu.appendChild(b);
		});
		document.body.appendChild(menu);
		var r = chatInput.getBoundingClientRect();
		menu.style.left = Math.max(8, r.left) + 'px';
		menu.style.width = Math.min(r.width, 420) + 'px';
		// Above the box, not below: the composer sits at the foot of the panel and
		// a menu under it would be off the bottom of the window.
		menu.style.top = Math.max(8, r.top - menu.offsetHeight - 6) + 'px';
		_skillMenu = menu;
		setTimeout(function () { document.addEventListener('click', onSkillOutside, true); }, 0);
	}

	/// The first draft of what "concise" asks for. Deliberately short and
	/// deliberately about SHAPE rather than length in words: a token budget in a
	/// prompt is a number a model will cheerfully ignore.
	function conciseSeed() {
		return '---\n'
			+ 'name: concise\n'
			+ 'description: Answer briefly.\n'
			+ '---\n\n'
			+ '# Concise\n\n'
			+ 'Answer in as few words as carry the answer.\n\n'
			+ '- Lead with the answer. No preamble, no restatement of the question.\n'
			+ '- No summary at the end, and no offer of further help.\n'
			+ '- Prose over lists unless the answer really is a list.\n'
			+ '- Say the reason only where not saying it would leave the answer unusable.\n'
			+ '- Where the honest answer is "it depends", say what it depends on and stop.\n\n'
			+ 'This is your own file: edit it to say what brevity means to you.\n';
	}

	/// Make sure the skill the chip invokes actually exists. Resolves true when
	/// it does.
	///
	/// A `run_tool` RESOLVES with its error text rather than rejecting, so a
	/// refusal and a success look identical to `try`/`catch`; the reply is read
	/// as well as awaited. Seeded on the way in rather than at boot: a user who
	/// never presses the chip gets no file they did not ask for.
	async function ensureConciseSkill() {
		try {
			var cur = await tools().run_tool('file_read', JSON.stringify({ path: CONCISE_SKILL }));
			if (typeof cur === 'string' && !/^\s*Error\b/i.test(cur) && cur.trim()) return true;
		} catch (e) { /* not there, or no workspace yet */ }
		try {
			await tools().run_tool('dir_create', JSON.stringify({ path: CONCISE_DIR }));
		} catch (e) { /* it may already be there, which is the state wanted */ }
		try {
			var res = await tools().run_tool('file_write',
				JSON.stringify({ path: CONCISE_SKILL, content: conciseSeed() }));
			if (typeof res === 'string' && /^\s*Error\b/i.test(res)) return false;
		} catch (e) { return false; }
		try { Files.refresh(); } catch (e) { /* the tree redraws on its own next time */ }
		return true;
	}

	/// Draw the chip to the chat on screen. Hidden where there is no chat: a
	/// toggle bound to nothing is a control that remembers the wrong thing.
	function syncConciseChip() {
		var chip = document.getElementById('concise-chip');
		if (!chip) return;
		var on = !!(current && tileConcise(current.id));
		chip.style.display = current ? '' : 'none';
		chip.setAttribute('aria-pressed', on ? 'true' : 'false');
		chip.classList.toggle('accent', on);
	}

	/// Turn the chip on or off for the chat on screen.
	async function toggleConcise() {
		if (!current) return;
		var want = !tileConcise(current.id);
		if (want && !await ensureConciseSkill()) {
			// A lit chip whose skill is not on disk would refuse every turn with
			// "no such skill", which reads as the chip being broken rather than as
			// the workspace being unreachable. So it stays off, and says why.
			await noticeDialog(t('chat.concise_failed_title'), t('chat.concise_failed'));
			return;
		}
		setTilePref(current.id, 'concise', want);
		syncConciseChip();
	}

	/// What the turn actually carries. `/concise` goes on the front of the
	/// message so the request the model receives, and the transcript the user
	/// reads, are the same string.
	function conciseText(chat, text) {
		if (!chat || !tileConcise(chat.id)) return text;
		if (/^\s*\//.test(text)) return text;		// their own command wins
		return '/concise ' + text;
	}

	async function sendUserMessage() {
		var text = chatInput.value.trim();
		if (!text) return;
		// A Diamond's chat view uses this composer and this thread, but not this turn:
		// a daimon's tools are pinned to its own directory, its fence is the Diamond's
		// scope, and its turn records a crystal version when it writes one. The two
		// part here, and only here.
		if (current && current.diamondId) {
			if (crystalBusy) return;
			chatInput.value = ''; chatInput.style.height = 'auto';
			doSteer(text);
			return;
		}
		// A chat on a provider that is not the starred one must be judged on ITS provider's key.
		// A chat with no provider yet (no chat open at all) falls back to the default, which is
		// what it will be started on.
		//
		// Checked BEFORE anything is queued: a message held behind a turn on a
		// provider that cannot run would be queued now and refused later, when the
		// user has moved on and the refusal is a mystery.
		var can = current
			? !!(window.DaimondModels && DaimondModels.resolve(current.provider, current.model))
			: cfgReady(cfg);
		if (!can) { openSettings(t('chat.connect_to_chat')); return; }
		if (!current) { newChat(); }
		var chat = current;
		// The chip's state at the moment of TYPING is what travels, including into
		// the queue: a message held behind a running turn was asked for under the
		// chip as it stood then, not as it stands when the queue drains.
		text = conciseText(chat, text);
		// Mid-turn. A turn is a round of requests, not one, and the message list is
		// rebuilt between them -- so what is typed now can reach the model IN this
		// turn, at the seam after the tool replies go back (see `run_tool_loop`).
		// That is only true of the chat on screen, whose agent is the one running;
		// anything else still waits in the queue, badged on its tile, exactly as it
		// did. The composer clears either way, so typing then sending feels the same
		// whether or not an answer happens to be arriving.
		if (chat._generating) {
			if (current === chat && interjectMessage(chat, text)) return;
			enqueueMessage(chat, text);
			return;
		}
		chatInput.value = ''; chatInput.style.height = 'auto';
		runTurn(chat, text);
	}

	// ── What you typed while the answer was still coming ───────
	//
	// Two lists, because there are two fates. A turn is a round of requests, and
	// between any two of them the agent rebuilds the message list -- so a correction
	// typed into the chat on screen goes to the RUNNING agent (`_interject`) and is
	// said at that seam, in the turn it was meant to redirect. Nothing can be added
	// to a request already in flight, and a turn spending its whole length writing
	// prose has no seam in it at all; whatever is still waiting when the turn ends
	// comes back and joins the QUEUE (`_queue`), which sends it as its own turn.
	//
	// The queue is also where a message typed at a chat in the background goes:
	// runTurn draws into the live thread, so a turn started for a conversation the
	// user has left would write itself into the one they are looking at.
	//
	// One turn per queued message, never coalesced: a turn is the unit a fold picks
	// and the unit the numbering counts, so two questions merged into one turn would
	// be two things that could never be folded apart again.
	//
	// Both lists live on the chat and are deliberately NOT persisted: they are a
	// half-second of intent, not content, and either restored after a crash would
	// spend money on a turn the user cannot remember asking for.

	/// Hold a message until the turn in flight has finished.
	function enqueueMessage(chat, text) {
		chat._queue = chat._queue || [];
		chat._queue.push(text);
		chatInput.value = ''; chatInput.style.height = 'auto';
		syncSendMode();
		renderQueue();
	}

	/// Say a message into the turn already running, to be delivered at its next seam.
	///
	/// Hands it to the agent, which is the only thing that knows when a seam comes
	/// round; the copy kept here is a mirror to draw from, and the agent's queue is
	/// the truth. Returns false when this build's agent cannot take one — an older
	/// wasm bundle, or a chat whose agent has been thrown away — so the caller falls
	/// back to the queue rather than dropping what was typed.
	function interjectMessage(chat, text) {
		if (!chat.app || typeof chat.app.interject !== 'function') return false;
		try { chat.app.interject(text); }
		catch (e) { return false; }
		chat._interject = chat._interject || [];
		chat._interject.push(text);
		chatInput.value = ''; chatInput.style.height = 'auto';
		syncSendMode();
		renderQueue();
		return true;
	}

	/// Take back whatever was said into a turn and never got in, and queue it instead.
	///
	/// Called as the turn ends. The agent's queue is drained rather than read: what
	/// is still in it is exactly what found no seam, and it must not be delivered
	/// into some later turn by an agent that outlives this one. A turn with no tool
	/// call in it has no seam, so this is not an edge case — it is the ordinary fate
	/// of a correction typed into a plain prose answer.
	///
	/// What comes back goes in FRONT of anything already queued: it was typed first.
	function reclaimInterjections(chat) {
		var left = [];
		if (chat.app && typeof chat.app.take_interjections === 'function') {
			try { left = Array.prototype.slice.call(chat.app.take_interjections() || []); }
			catch (e) { left = []; }
		}
		chat._interject = [];
		// Drained whatever happens, but only put back where there is something to put
		// it back into: a locked app has just taken the user's content off the screen,
		// and a deleted chat has nowhere to send it.
		if (left.length && !locked && chats.indexOf(chat) !== -1) {
			chat._queue = (chat._queue || []).length ? left.concat(chat._queue) : left;
		}
		if (current === chat) renderQueue();
	}

	/// How much is waiting on a chat, of either kind.
	///
	/// Both are money about to be spent and neither has been sent, so the tile badge
	/// and the updater's idea of "busy" count them together.
	function waitingOn(chat) {
		if (!chat) return 0;
		return ((chat._queue || []).length) + ((chat._interject || []).length);
	}

	/// The container the queued bubbles live in, always the last thing in the
	/// thread: what is waiting sits below what has happened.
	function queueBox() {
		var box = document.getElementById('chat-queued');
		if (!box) {
			box = document.createElement('div');
			box.id = 'chat-queued';
			box.className = 'chat-queued';
			chatOutput.appendChild(box);
		} else if (box !== chatOutput.lastElementChild) {
			chatOutput.appendChild(box);
		}
		return box;
	}

	/// Draw everything of the current chat's that has been typed and not yet sent:
	/// what is waiting on the running turn, then what is queued behind it.
	///
	/// Two lists in one box, because to the person who typed them they are one thing
	/// -- said, not yet delivered -- and the only difference is how soon. The
	/// heading over each says which, at the moment it matters; the bubbles are the
	/// same dashed bubbles either way, and both can be withdrawn the same two ways.
	///
	/// A waiting bubble is NOT `.chat-msg-user`: that class is what the turn
	/// machinery counts questions by, so a bubble wearing it would be a turn that
	/// does not exist -- shifting every turn number a fold maps through.
	function renderQueue() {
		if (!chatOutput) return;
		var waiting = (current && current._interject) || [];
		var q       = (current && current._queue) || [];
		var existing = document.getElementById('chat-queued');
		if (!waiting.length && !q.length) {
			if (existing) existing.remove();
			updateQueueBadges();
			return;
		}
		var box = queueBox();
		box.innerHTML = '';
		if (waiting.length) waitingRows(box, t('chat.interject_help'), waiting, t('chat.interject_pending'), unwait);
		if (q.length)       waitingRows(box, t('chat.queue_help'),     q,       t('chat.queued_pending'),   unqueue);
		if (nearBottom()) chatOutput.scrollTop = chatOutput.scrollHeight;
		updateQueueBadges();
	}

	/// One list of not-yet-sent bubbles, under its own heading.
	///
	/// `take(i, toComposer)` is how a bubble is withdrawn, and it differs between
	/// the two lists: one is held by the running agent, the other by the chat.
	function waitingRows(box, headText, list, pendingHelp, take) {
		var head = document.createElement('div');
		head.className = 'chat-queued-head';
		head.textContent = headText;
		box.appendChild(head);
		list.forEach(function (text, i) {
			var div = document.createElement('div');
			div.className = 'chat-msg chat-msg-queued';
			div.innerHTML = '<div class="chat-msg-content"></div>';
			var body = div.querySelector('.chat-msg-content');
			body.textContent = text;                     // escaped (H5)
			body.title = pendingHelp;
			// Clicking it takes it back: the commonest thing to want from a message
			// not yet sent is to change it.
			body.addEventListener('click', function () { take(i, true); });
			var x = document.createElement('button');
			x.className = 'queue-x';
			x.textContent = '×';
			x.title = t('chat.queue_cancel');
			x.setAttribute('aria-label', t('chat.queue_cancel'));
			x.addEventListener('click', function (e) { e.stopPropagation(); take(i, false); });
			div.appendChild(x);
			box.appendChild(div);
		});
	}

	/// The badge a chat's tile wears while something is waiting on it, or null
	/// when nothing is. `diamond-pending` is the app's existing pending-badge
	/// style — the same small accented word the rail already uses for a fold
	/// waiting on a Diamond, which is the same thing being said about a chat.
	function queueBadge(chat) {
		var n = waitingOn(chat);
		if (!n) return null;
		var b = document.createElement('span');
		b.className = 'diamond-pending queue-badge';
		b.textContent = tn('chat.queue_badge', n);
		b.title = tn('chat.queue_badge_help', n);
		return b;
	}

	/// Bring every tile's queue badge up to date in place.
	///
	/// In place, rather than by redrawing the rail: renderSessionList rebuilds the
	/// label inputs, so a queue changing under a half-typed rename would take the
	/// caret out of it.
	function updateQueueBadges() {
		if (!sessionList) return;
		var byId = {};
		chats.forEach(function (c) { byId[c.id] = c; });
		sessionList.querySelectorAll('.session-box').forEach(function (box) {
			var top = box.querySelector('.tile-active-top');
			if (!top) return;                        // a pending chat cannot hold a queue
			var was = top.querySelector('.queue-badge');
			var now = queueBadge(byId[box.dataset.id]);
			if (was) was.remove();
			if (now) top.appendChild(now);
		});
	}

	/// Put text back in the composer, after whatever is already typed there.
	function putInComposer(text) {
		if (!text) return;
		chatInput.value = chatInput.value.trim() ? chatInput.value + '\n\n' + text : text;
		chatInput.style.height = 'auto';
		chatInput.style.height = Math.min(chatInput.scrollHeight, 263) + 'px';
		chatInput.focus();
		syncSendMode();
	}

	/// Take a queued message out again: back to the composer to be edited, or
	/// simply dropped.
	function unqueue(i, toComposer) {
		if (!current || !current._queue) return;
		var text = current._queue.splice(i, 1)[0];
		if (toComposer) putInComposer(text);
		renderQueue();
	}

	/// Take a message back out of the turn it was said into.
	///
	/// It has to leave the AGENT's queue, not merely the mirror drawn here: a row
	/// removed from the picture and still delivered is worse than one never removed
	/// at all. The agent may hand back nothing, which means the seam came round
	/// between the click and this line — it is in the conversation now, so it is not
	/// withdrawn and it is certainly not put back in the box to be sent a second time.
	function unwait(i, toComposer) {
		if (!current || !current._interject || !current._interject.length) return;
		var canDrop = !!(current.app && typeof current.app.drop_interjection === 'function');
		var got = null;
		if (canDrop) {
			try { got = current.app.drop_interjection(i); }
			catch (e) { got = null; }
		}
		var mirrored = current._interject.splice(i, 1)[0];
		if (canDrop && (got === null || got === undefined)) { renderQueue(); return; }
		if (toComposer) putInComposer(canDrop ? got : mirrored);
		renderQueue();
	}

	/// Send the next queued message, now the turn's lock is free.
	///
	/// Only after a turn that ended cleanly. A queue drained on the back of an
	/// error or a Stop would spend money answering a question the user asked before
	/// they knew the last one had failed -- so instead the text comes back to the
	/// composer, where they can see it and decide.
	function drainQueue(chat, failed) {
		var aborted = !!chat._aborted;
		chat._aborted = false;
		var q = chat._queue || [];
		if (!q.length) return;
		// Only for the chat on screen. runTurn writes the question straight into the
		// thread, so a turn started for a chat the user has since left would render
		// into the conversation they are now looking at. A queue left on another chat
		// waits there, badged on its tile, and is picked up by resumeQueue the moment
		// the user goes back to it — which is why HOW the turn ended is recorded
		// rather than thrown away: the queue must still be handed back, not sent, if
		// the turn it was waiting behind failed or was stopped.
		if (current !== chat) {
			chat._queueFailed = !!(failed || aborted);
			updateQueueBadges();
			return;
		}
		if (failed || aborted || _unloading || chats.indexOf(chat) === -1) { returnQueue(chat); return; }
		chat._queueFailed = false;
		var next = q.shift();
		renderQueue();
		runTurn(chat, next);
	}

	/// Pick up a queue left on a chat, now the user has come back to it.
	///
	/// The queue could not run while the chat was in the background — runTurn draws
	/// into the live thread, so it would have written someone else's conversation —
	/// and it is not run headlessly here either: this is the same drain, at the
	/// first moment it is honest to do it. The turn it was waiting behind decides:
	/// one that ended cleanly sends what was queued, and one that errored or was
	/// stopped hands it back to the composer instead, exactly as it would have done
	/// had the user been watching.
	function resumeQueue(chat) {
		if (!chat || current !== chat) return;                 // they have moved on again
		if (!chat._queue || !chat._queue.length) return;
		if (chat._generating) return;                          // its own turn will drain it
		if ((chat.status || 'active') === 'pending') return;   // nothing has started here yet
		if (chat._queueFailed) {
			chat._queueFailed = false;
			returnQueue(chat);
			return;
		}
		drainQueue(chat, false);
	}

	/// Give a queue back rather than send it.
	function returnQueue(chat) {
		var q = chat._queue || [];
		if (!q.length) return;
		var text = q.join('\n\n');
		// Only into the composer of the chat that is actually on screen. A background
		// chat's queue stays where it is, still visible when the user returns to it,
		// rather than being pasted into a conversation it was not meant for.
		if (current !== chat) return;
		chat._queue = [];
		chatInput.value = chatInput.value.trim() ? text + '\n\n' + chatInput.value : text;
		chatInput.style.height = 'auto';
		chatInput.style.height = Math.min(chatInput.scrollHeight, 263) + 'px';
		renderQueue();
		toast(t('chat.queue_returned'), true);
	}

	/// Hold an exclusive lock for a chat's turn while `fn` runs, so two tabs cannot run — or later
	/// resume — the same turn at once and bill it twice. Degrades to just running `fn` where the
	/// Web Locks API is absent.
	function withTurnLock(chatId, fn) {
		if (navigator.locks && navigator.locks.request) {
			return navigator.locks.request('daimond-turn-' + chatId, { mode: 'exclusive' }, fn);
		}
		return fn();
	}

	/// Run one turn of a chat, journalling every step so a tab that dies mid-turn loses nothing but
	/// the split-second in flight. This is the shared core of both the composer and the Continue
	/// button: `text` is the user's message; the rest is durability.
	async function runTurn(chat, text) {
		var app;
		try { app = ensureApp(chat); }
		catch (e) { appendError('Could not start agent: ' + String(e)); return; }

		var umid = newMid();
		appendUserMessage(text);
		chat.messages.push({ role: 'user', content: text, mid: umid, ts: Date.now() });
		// The composer stays live: what is typed while this runs is queued, not lost.
		chat._aborted = false;

		// PERSIST-FIRST. The prompt is durable the instant it is sent — before a single token comes
		// back — so a crash in the next moment can never eat what the user just typed.
		touchChat(chat);
		persistChats();

		// Open the turn in the write-ahead log. From here every delta, tool call and tool result
		// is journalled; if the tab dies, recovery reads this back as an interrupted turn.
		var amid = newMid();                     // the assistant message this turn is producing
		var J = window.DaimondJournal;
		if (J) J.turnOpen(umid, chat.id, text, { model: chat.model, provider: chat.provider });

		chat._generating = true;
		showSpinner();
		syncComposer();               // Stop on the button, and the queue hint in the box
		chat.app = app;

		var sawText = false, sawError = false, threw = false;
		var turnText = '';
		// A minted credits key is capped at the balance behind it, so it can be refused
		// part-way through a session for a reason the user did not cause and cannot check.
		// That refusal is held back rather than written into the conversation, and answered
		// with a fresh key below; only a SECOND refusal is real, and only that one is shown.
		var authFail = false, reminted = false;
		// The provider refusing the reply LENGTH asked for is held back the same
		// way and answered below by halving it, because a raw "max_tokens must be
		// at most N" sends the user looking at a setting they never chose.
		var capFail = false, backedOff = false;
		// A tool call whose arguments will not parse: the fingerprint of a reply
		// cut off at the length limit. Recorded here and reported once at the end
		// of the turn, where the whole turn is known.
		var capCut = false;
		var pendingTool = null, toolSeq = 0, pendingCallId = null;
		var owns = function () { return current === chat && chats.indexOf(chat) !== -1; };
		var onEvent = function (ev) {
			if (!ev || !ev.type) return;
			if (ev.type === 'text') {
				turnText += (ev.content || '');
				if (J) J.delta(umid, chat.id, ev.content || '');
				if (!owns()) return;
				if (!sawText) { hideSpinner(); sawText = true; }
				appendAssistantText(ev.content || '');
			} else if (ev.type === 'tool_call') {
				pendingCallId = 't' + (++toolSeq);
				// A tool call's arguments ARE a JSON string, so a reply that stops at
				// the length limit part-way through one arrives as a MALFORMED CALL,
				// not as a short file. The model is told only that its JSON was bad,
				// and the user sees a tool that did nothing for no stated reason —
				// which is the single most confusing failure in a coding session.
				// Nothing on the wire that reaches this half says "cut for length"
				// (the client does not surface a finish reason), so it is inferred
				// from the evidence that is here.
				if (truncatedArgs(ev.args)) capCut = true;
				pendingTool = { role: 'tool_log', name: ev.name || '', args: ev.args || '', content: '', mid: newMid(), ts: Date.now() };
				chat.messages.push(pendingTool);
				// Write-ahead: the intent to run this tool is on disk before the tool returns, so
				// recovery can tell a tool that finished from one caught in the act.
				if (J) J.toolOpen(umid, chat.id, pendingCallId, ev.name || '', ev.args || '');
				if (!owns()) return;
				hideSpinner();
				renderToolCall(ev.name || '', ev.args || '');
			} else if (ev.type === 'tool_result') {
				if (pendingTool) { pendingTool.content = ev.content || ''; pendingTool = null; }
				if (J) J.toolDone(umid, chat.id, pendingCallId, ev.content || '', toolFailed(ev.content || ''));
				pendingCallId = null;
				if (!owns()) return;
				renderToolResult(ev.name || '', ev.content || '');
			} else if (ev.type === 'interjected') {
				// It has landed: the agent put it into the conversation at the seam,
				// and the model has it from the next request on. So it stops being
				// something waiting and becomes part of the thread, here, where it
				// took effect.
				var said = ev.content || '';
				if (chat._interject && chat._interject.length) {
					var at = chat._interject.indexOf(said);
					chat._interject.splice(at === -1 ? 0 : at, 1);
				}
				chat.messages.push({ role: 'user', interject: true, content: said, mid: newMid(), ts: Date.now() });
				if (!owns()) return;
				appendInterjected(said);
				renderQueue();
			} else if (ev.type === 'compacted') {
				// Persisted, so a reload still shows that the history was folded --
				// otherwise the thread silently loses messages between two visits.
				chat.messages.push({ role: 'fold_log', content: ev.content || '',
					folded: ev.folded || 0, kept: ev.kept || 0, mid: newMid(), ts: Date.now() });
				if (!owns()) return;
				appendCompacted(ev.content || '');
			} else if (ev.type === 'truncated') {
				// Said by the provider rather than inferred from a tool call whose
				// arguments would not parse. Not an error: the request succeeded and a
				// setting was reached, so the turn is not retried, only reported.
				capCut = true;
			} else if (ev.type === 'error') {
				// The refusal of a spent minted key is not news to the user: it is a key to
				// replace, and the retry below does that. Nothing is written down until that
				// retry has had its go, or a turn that goes on to succeed leaves a failure
				// standing in the transcript underneath its own answer.
				if (!reminted && canRemint(chat) && keyRefused(ev.content)) { authFail = true; return; }
				// Likewise for a provider that will not generate a reply this long.
				// The ceilings this app knows are incomplete by construction — most
				// providers publish none — so the correction is made by asking, not
				// by guessing again, and it is only shown if the second ask fails too.
				// Only worth trying while there is room below to try: at the floor
				// the reply length is no longer a plausible cause.
				if (!backedOff && maxOutFor(chat.model, chat.provider) > MIN_MAX
					&& (capRefused(ev.content) || opaqueRefusal(ev.content))) {
					capFail = true; return;
				}
				chat.messages.push({ role: 'error_log', content: friendlyError(ev.content || 'Error'), mid: newMid(), ts: Date.now() });
				if (J) J.turnError(umid, chat.id, friendlyError(ev.content || 'Error'));
				if (!owns()) return;
				hideSpinner();
				appendError(ev.content || 'Error');
				sawError = true;
			}
		};

		await withTurnLock(chat.id, async function () {
			try {
				try {
					await app.run_turn(text, onEvent);
				} catch (e) {
					if (capFail) {
						// The provider would not do the reply length asked for — or said
						// something the transport did not carry, which today is the same
						// thing. Ask for half as much and run the same turn again;
						// `max_tokens` is frozen when a DaimondApp is built, so the agent
						// is rebuilt rather than told. One correction only: a second
						// refusal is real and is reported.
						backedOff = true; capFail = false;
						var asked = maxOutFor(chat.model, chat.provider);
						var half  = Math.max(MIN_MAX, Math.floor(asked / 2));
						chat._capTry = half;
						app = rebuildAppWithout(chat, umid);
						await app.run_turn(text, onEvent);
						// Only NOW is the smaller ask believed. Recording the cap before
						// the retry would teach the app a ceiling from any unrelated 400 —
						// a bad key, a malformed request — and every later turn on that
						// model would be quietly shortened for it.
						chat._capTry = 0;
						noteCapRefused(chat.model, chat.provider, asked);
					} else if (authFail) {
						// One shot at a fresh key, then the same turn again. The key is fixed at a
						// DaimondApp's construction, so the agent is rebuilt rather than told.
						reminted = true; authFail = false;
						// The generation this app froze, so a key already replaced by another agent's
						// mint is simply taken rather than bought again.
						// The node this chat spends against travels with the mint: a paused
					// chat must not buy a fresh key to carry on with.
					try { await DaimondModels.remint(chat._gen, DaimondPause.id('root', 'chats', chat.id)); }
						catch (e2) {
							// The key could not be replaced, so the balance is gone rather than merely
							// capped. Say the thing the user can act on: a raw 401 would send them
							// hunting for a key they never had.
							throw new Error('Your Daimond credits have run out. Top up in Credits, or '
								+ 'switch this chat to a provider key of your own.');
						}
						app = rebuildAppWithout(chat, umid);
						await app.run_turn(text, onEvent);
					} else {
						throw e;
					}
				}
				if (chats.indexOf(chat) === -1) { if (J) J.clearTurn(umid); return; }
				if (turnText) chat.messages.push({ role: 'assistant', content: turnText, mid: amid, ts: Date.now() });
				stampMessages(chat.messages);
				if (owns()) finalizeAssistant();
				else { curAsstDiv = null; curAsstText = ''; }
				// Four cumulative counters now, not two. The two new ones are the reason a
				// turn can be billed at what it ACTUALLY cost: `cached_tokens` is the part
				// of the prompt the provider served from its cache and charged little or
				// nothing for, and `cost_usd` is the provider's own figure for the whole
				// call. Read only HERE, after the turn: both getters borrow the session
				// that `run_turn` holds mutably, so a mid-turn read panics the RefCell (the
				// live_* getters exist for that case).
				var pCum = app.prompt_tokens || 0, cCum = app.completion_tokens || 0;
				var caCum = app.cached_tokens || 0, costCum = app.cost_usd || 0;
				var turnP  = Math.max(0, pCum - (chat.prevPrompt || 0));
				var turnC  = Math.max(0, cCum - (chat.prevCompletion || 0));
				var turnCa = Math.max(0, caCum - (chat.prevCached || 0));
				var turnCost = Math.max(0, costCum - (chat.prevCost || 0));
				chat.prevPrompt = pCum; chat.prevCompletion = cCum;
				chat.prevCached = caCum; chat.prevCost = costCum;
				chat.promptTokens = pCum; chat.completionTokens = cCum;
				chat.cachedTokens = caCum; chat.costUsd = costCum;
				// What the LAST request actually sent, not what the turn sent in total.
				// The two are the same only for a one-round turn: an agentic turn sends
				// the whole conversation once per round, so `turnP` — the growth of the
				// cumulative counter — is the sum of a dozen overlapping prompts, and
				// the meter drawn from it read about a dozen times high. The per-round
				// figure was always tracked in Rust (`session.last_prompt_tokens`);
				// there was simply no getter for it, so `restore` could set it and
				// nothing could read it back.
				chat.lastPrompt = app.last_prompt_tokens || 0;
				recordSpend(chat.model, turnP, turnC, turnCa, turnCost, chat.provider);
				// A tool call arrived unparseable, which means the reply ran out of room
				// mid-argument. Said once, at the end, naming the limit and the setting —
				// the alternative is a tool that silently did nothing.
				if (capCut) {
					var cutMsg = t('err.reply_cut') === 'err.reply_cut'
						? ('The reply ran out of room at ' + fmtTok(maxOutFor(chat.model, chat.provider))
							+ ' tokens, so a tool call arrived incomplete and could not run. '
							+ 'Raise the reply length in Settings, or ask for a smaller change')
						: t('err.reply_cut', { max: fmtTok(maxOutFor(chat.model, chat.provider)) });
					chat.messages.push({ role: 'error_log', content: cutMsg, mid: newMid(), ts: Date.now() });
					if (owns()) appendError(cutMsg);
				}
				// The turn is complete and now lives in the snapshot; fold it out of the journal.
				if (J) J.turnClose(umid, chat.id, pCum, cCum);
			} catch (e) {
				threw = true;
				finalizeAssistant();
				if (_unloading) {
					// The page is going away and took the request with it. That is not a failure to
					// record — leave the turn OPEN in the journal so the next boot recovers it as
					// interrupted, and write no error over it.
					if (J) J.flush();
				} else {
					if (!sawError) {
						chat.messages.push({ role: 'error_log', content: friendlyError(e), mid: newMid(), ts: Date.now() });
						if (J) J.turnError(umid, chat.id, friendlyError(e));
						appendError(e);
					}
					// An errored turn has reached a terminal state — it is not interrupted work to be
					// recovered, so its journal is pruned too.
					if (J) J.clearTurn(umid);
				}
			} finally {
				chat._generating = false;
				chat._capTry = 0;            // the backoff belonged to this turn only
				// Anything said into this turn that never found a seam comes back now
				// and joins the queue, whose own rules then decide: sent as its own
				// turn if the turn ended cleanly, handed back to the composer if it
				// errored or was stopped. Before `syncComposer` below, so the box and
				// the bubbles are redrawn once, in their final state.
				reclaimInterjections(chat);
				if (owns()) {
					sayAnswered(chat, sawError || threw);
					hideSpinner();
					syncComposer();       // back to Send, and the ordinary placeholder
					// Not while there is something in the box: the caret would jump
					// out of a half-typed sentence at whatever moment the answer
					// happened to finish.
					if (!chatInput.value.trim()) chatInput.focus();
				}
				updateMeters(); renderSessionList(); updateSpend();
				// The model's own conversation, taken before the chat is stored and
				// whatever the turn did: a turn that errored half way through still
				// leaves the agent holding the tool calls it made, and losing those is
				// exactly what a reload used to do. Safe here and only here — the getter
				// borrows the session `run_turn` held mutably, and this is after it.
				captureSession(chat, app);
				touchChat(chat);
				persistChats();
				Files.refresh();
				Instructions.refresh();
				Prompts.refresh();
				// The app is idle again; a deferred version update can now be applied.
				try { window.dispatchEvent(new Event('daimond:idle')); } catch (e) {}
			}
		});
		// Whatever was typed while that turn ran, sent now. OUTSIDE the lock: the
		// drain starts another turn, which takes the same lock again, and asking for
		// it from inside would deadlock the tab.
		drainQueue(chat, sawError || threw);
	}

	// Record a completed turn's cost and feed the spend governor in one
	// step, so the ledger (the total) and the governor (the rate) can
	// never fall out of step. The governor learns the user's normal from
	// exactly these entries, so every metered turn — chat, worker or
	// conductor — must come through here.
	//
	// `cachedTokens` and `costUsd` are what the provider itself said, and they change the answer
	// rather than decorate it: a cache hit is charged at a fraction of a fresh token, and a
	// reported cost is not an estimate at all. Passing zero for either -- which this function used
	// to hardcode -- is what made a 90%-cached turn bill as though every token were new.
	function recordSpend(model, promptTokens, completionTokens, cachedTokens, costUsd, provider) {
		if (!window.DaimondLedger || (promptTokens + completionTokens) <= 0) return;
		var entry = null;
		try {
			entry = DaimondLedger.record({ ts: Date.now(), model: model,
				promptTokens: promptTokens, completionTokens: completionTokens,
				cachedTokens: cachedTokens || 0, costUsd: costUsd || 0,
				provider: provider || '' });
		} catch (e) { /* ledger is best-effort */ }
		if (entry && window.DaimondGovernor) {
			try { DaimondGovernor.observe(entry); } catch (e) { /* governor is best-effort */ }
		}
	}

	// The global spend readout at the foot of the Diamonds/Chats panel: session
	// (usage since a ≥15-min idle gap) · this week · this month. Precise but
	// calm — a quiet reassurance, not a running total shouting in dollars.
	function updateSpend() {
		var el = document.getElementById('spend-row');
		if (!el || !window.DaimondLedger) return;
		if (locked) { el.innerHTML = ''; el.style.display = 'none'; return; }
		el.dataset.hasCredits = (window.DaimondGateway && DaimondGateway.state().authed) ? '1' : '';
		// NOT `t`: that is this file's translation function, and a `var t` here
		// shadows it for the whole function -- including the `cell` below, which
		// calls it. `var` hoists, so the shadow is in force before the assignment
		// and the call throws "t is not a function".
		var tot;
		try { tot = DaimondLedger.totals(); } catch (e) { el.style.display = 'none'; return; }
		if ((tot.session.usd || 0) <= 0 && (tot.month.usd || 0) <= 0) { el.style.display = 'none'; return; }
		el.style.display = '';
		el.innerHTML = '';
		function cell(label, part) {
			var c = document.createElement('div'); c.className = 'spend-cell';
			var l = document.createElement('span'); l.className = 'spend-label'; l.textContent = label;
			var a = document.createElement('span'); a.className = 'spend-amt';
			// An "≈" where a model outside the price table was used, so a total
			// resting partly on an estimate is not presented as an exact figure.
			a.textContent = (part.estimated && !DaimondI18n.converted() ? '≈' : '') + fmtUsd(part.usd);
			if (part.estimated) a.title = t('spend.includes_estimate');
			c.appendChild(l); c.appendChild(a); return c;
		}
		el.appendChild(cell(t('spend.session_short'), tot.session));
		el.appendChild(cell(t('spend.period_week'),   tot.week));
		el.appendChild(cell(t('spend.period_month'),  tot.month));
		// A quiet "faster than usual" note when the live rate runs well
		// above the user's own normal. It informs; it never blocks — the
		// only thing that blocks is a big fan-out, at the dispatch gate.
		try {
			var g = window.DaimondGovernor && DaimondGovernor.status();
			if (g && (g.level === 'amber' || g.level === 'tripped')) {
				var note = document.createElement('div');
				note.className = 'spend-governor ' + g.level;
				note.textContent = t(g.level === 'tripped' ? 'gov.past_budget' : 'gov.faster')
					+ ' · ' + t('gov.per_min', { rate: fmtUsd(g.rateUsdMin) });
				note.title = t('gov.run_spent',
					{ spent: fmtUsd(g.burstSpent), budget: fmtUsd(g.budget) });
				el.appendChild(note);
			}
		} catch (e) { /* the note is best-effort */ }
		// The credit balance is NOT a fourth cell here. Session / Week / Month are three windows
		// on the same thing -- what has been spent -- and a balance is not a window on it; it sat
		// among them saying "Credits" beside three times, and read as a fourth period. It has its
		// own status row above, which is where a balance belongs.
		// A turn spends credits and writes to the workspace, so the status rows
		// above these figures are stale the moment they are drawn.
		DaimondAdmin.status();
	}

	// Stop the in-flight turn: fire the wasm abort so the streaming fetch
	// cancels.  run_turn then resolves with the partial answer kept, and
	// its finally block resets the input, spinner and send-mode — so no
	// error dump appears, just an early, clean end.
	function stopGeneration() {
		// Stop the CURRENT chat's turn — the one whose Stop button was pressed —
		// never whichever happened to start last.
		if (!current || !current._generating || !current.app) return;
		// Stop means stop: anything queued behind this turn is handed back to the
		// composer rather than sent the moment the turn the user just killed ends.
		current._aborted = true;
		try { current.app.abort(); } catch (e) { /* idempotent; ignore */ }
	}

	// ── Agents: real, dispatched workers ───────────────────────
	//
	// The panel used to be fed by exactly one thing — the conductor's own steer
	// turn — which it displayed as a single card while its empty state claimed
	// that chat turns appeared there. Nothing was ever dispatched, because no
	// dispatch tool existed. It does now: the conductor calls `spawn_agent`,
	// once per agent, and every call in a turn becomes a worker here.
	//
	// Workers run concurrently. They are network-bound, so several in flight is
	// genuinely faster, but an unbounded fan-out would hammer the provider's
	// rate limit — hence a small pool, with the rest queued.
	var WORKERS_KEY = 'daimond-workers';
	// The pump's own hold used to live here, in a key of its own. It is a LEAF of
	// the pause tree now — `root/workers`, held by `www/js/pause.js` — so this key
	// is read once, migrated onto the leaf, and deleted. See migrateWorkerHold.
	var WORKERS_PAUSED_KEY = 'daimond-workers-paused';
	// The user-authored "carry on" line for a resumed worker: a paused worker
	// was hung up mid-task, and resuming seeds a fresh session with its
	// transcript so far plus this nudge, so the model continues rather than
	// starts over. See Workers.resume.
	var RESUME_NUDGE = 'Continue the task from where you left off. Do not repeat work already done above.';

	// The predictive spend gate on a fan-out. The cost of dispatching N
	// workers is known BEFORE any of them runs — N times what a worker
	// typically costs — so a batch that would run this burst past its
	// pace budget is paused here and shown, once, with the number on it. A
	// few agents of ordinary cost never reach the modal; a big fan-out
	// does. This is the one thing in the governor that blocks rather than
	// merely notes, and it exists for exactly the "fifty agents in a
	// blink" case. It fails open: if the governor is somehow absent, the
	// dispatch proceeds as it always did.
	async function governorClearsDispatch(n, diamondId) {
		if (!window.DaimondGovernor) return true;
		var a;
		try {
			// The node the fan-out would spend against, so the gate can refuse a
			// paused daimon before it prices anything.
			a = DaimondGovernor.assessDispatch(n, DaimondPause.id('root', 'diamonds', diamondId, 'self'));
		} catch (e) { return true; }
		if (!a) return true;
		// A REFUSAL comes first and is not a spend question. Shown through the
		// fan-out confirm it would read as "this will cost you, carry on?" — the
		// opposite of what happened, since nothing was dispatched and nothing was
		// spent. It is a notice, and there is no "run anyway".
		if (a.refused) {
			noticeDialog(t('pause.refused_title'), a.refusal || t('pause.refused.dispatch',
				{ node: DaimondPause.label(a.node || '') }));
			return false;
		}
		if (!a.needsConfirm) return true;
		var msg = tn('gov.fanout_body', n,
				{ total: fmtUsd(a.predicted), each: fmtUsd(a.perWorker) })
			+ (a.runSpent > 0 ? ' ' + t('gov.burst_spent', { spent: fmtUsd(a.runSpent) }) : '')
			+ ' ' + t('gov.would_pass', { budget: fmtUsd(a.budget) });
		return await confirmDialog(msg, tn('gov.run_n', n),
			{ title: t('gov.faster'), danger: false });
	}

	var Workers = {
		runs: [],
		queue: [],
		active: 0,
		// The global hold is NOT a field here any more: it is `root/workers` in
		// the pause tree, read through workersHeld(). Two flags for one hold was
		// two answers to "are the workers running".
		// Each concurrent worker runs on its OWN minted key — its "slot" — so
		// parallel workers never share a key and their requests cannot race a
		// shared cap into an overspend. The pool is still bounded so a fan-out does
		// not hammer the provider's rate limit; with a key per slot the balance
		// also self-limits it, since each slot's cap is a share of the balance.
		MAX: 8,
		seq: 0,

		// ── Gather ──────────────────────────────────────────────
		// One dispatch is one BATCH, and when its last worker reaches a terminal
		// state the reports go back to the daimon that sent them as a new round.
		// Before this, fan-out existed and gather did not: a worker's text landed
		// on a tile and only a person pressing "Fold in" moved it, which is the
		// CRYSTAL's path and not the conductor's read. So the daimon could not
		// compare two workers, notice that one contradicted another, or iterate.
		//
		// Not persisted. A batch is only meaningful while its workers are in
		// flight, and a tab that died mid-fan-out comes back with its agents
		// marked `interrupted` -- there is no round to resume, and inventing one
		// on reload would re-spend on a turn the user never saw.
		batches: {},
		batchSeq: 0,
		// How many gather rounds may follow one another. A daimon that answers
		// every report by dispatching again is iterating, which is the point; one
		// that does it for ever is a bill. Three is enough for read-compare-act.
		MAX_GATHER_DEPTH: 3,

		// Slots 1..MAX, handed to a worker when it starts and returned when it
		// ends. Slot 0 is the chat's own key, and never a worker's.
		slotFree: null,
		takeSlot: function () {
			if (!this.slotFree) {
				this.slotFree = [];
				for (var i = 1; i <= this.MAX; i++) this.slotFree.push(i);
			}
			return this.slotFree.length ? this.slotFree.shift() : 0;
		},
		giveSlot: function (n) {
			if (n > 0 && this.slotFree && this.slotFree.indexOf(n) === -1) this.slotFree.push(n);
		},

		/// Keep a record of every run. The live DaimondApp cannot survive a reload —
		/// its fetch dies with the page — but the RECORD must, so an agent that
		/// was cut off says so instead of vanishing.
		persist: function () {
			try {
				localStorage.setItem(WORKERS_KEY, JSON.stringify(this.runs.slice(0, 12).map(function (r) {
					return {
						id: r.id, name: r.name, task: r.task, diamondId: r.diamondId, diamondName: r.diamondName,
						model: r.model, provider: r.provider || '', status: r.status, text: r.text, tools: r.tools,
						// Which modality put this worker on this model. Without it a tile drawn
						// after a reload cannot say why an image task is on the text model.
						sees: !!r.sees,
						promptTokens: r.promptTokens, completionTokens: r.completionTokens,
						// The cached share and the reported cost, so a tile drawn after a reload
						// still says what the run actually cost rather than re-guessing it.
						cachedTokens: r.cachedTokens || 0, costUsd: r.costUsd || 0,
					};
				})));
			} catch (e) { /* quota — runs stay in memory */ }
		},

		load: function () {
			// Carry an old hold onto the leaf before anything reads it, then take
			// the leaf as the pump's starting point.
			migrateWorkerHold();
			lastHold = workersHeld();
			var stored = readJson(WORKERS_KEY, []);
			if (!stored.length) return;
			var self = this;
			this.runs = stored.map(function (r) {
				// Anything still running or queued when the page went away was
				// cut off. Say so, rather than quietly dropping it.
				if (r.status === 'running' || r.status === 'queued') r.status = 'interrupted';
				r.app = null;
				var n = parseInt((r.id || '').replace(/^w/, ''), 10);
				if (n >= self.seq) self.seq = n + 1;
				return r;
			});
			if (this.runs.length) revealAgents();
			this.persist();
			this.render();
		},

		/// Dispatch every agent the conductor asked for in one turn.
		///
		/// `pick` is `{ provider, model }` -- the pair the USER chose for this Diamond's workers.
		/// It is resolved once for the whole turn, so every worker in one fan-out runs on the same
		/// model and spends the same key, and it is a parameter rather than something read here
		/// because the model must never be the thing that decides what to spend money on: that is
		/// why `spawn_agent`'s schema is still `{name, task}`.
		dispatch: function (diamondId, diamondName, specs, tainted, pick, depth) {
			if (!specs || !specs.length) return;
			revealAgents();
			var self = this;
			var wm = (pick && pick.model) ? pick : diamondWorkerModel(diamondId);
			// The secondary is a map keyed by modality, so it is resolved per SPEC rather
			// than once for the batch: one fan-out can quite reasonably be two agents reading
			// code and one reading a screenshot. The text half is still resolved once, above,
			// so a batch with no image in it behaves exactly as it did.
			var vm = diamondVisionModel(diamondId);
			// One batch per dispatch, so the reports can be gathered together when the
			// LAST of them finishes rather than one at a time. A conductor that reads
			// three reports in one round can say which two agree; one that reads them
			// singly cannot compare anything.
			var batch = 'b' + (++self.batchSeq);
			this.batches[batch] = {
				diamondId: diamondId, diamondName: diamondName,
				depth: (depth | 0), expected: specs.length, ids: [],
			};
			specs.forEach(function (spec) {
				var route = self.routeFor(spec.task, wm, vm, !!(pick && pick.model));
				var sees = route.sees, mm = route;
				var run = {
					id: 'w' + (++self.seq),
					batch: batch,
					name: spec.name || ('agent-' + self.seq),
					task: spec.task || '',
					diamondId: diamondId,
					diamondName: diamondName,
					// Why this worker is on this model, so a run that fell back to the text
					// model because no vision model is set says so instead of looking chosen.
					sees: sees,
					model: mm.model || '',
					// The provider is the other half of the choice, and it has to travel with the
					// model rather than be read off the starred default: the same model name sits
					// behind two providers as often as not, and a worker sent with the wrong key
					// is billed to the wrong balance or refused outright. `appCfgFor(run)` and the
					// credits check in `start` both read this pair, so setting them together here
					// is what puts the worker on the right endpoint with the right key.
					provider: wm.provider || '',
					status: 'queued',
					// A worker starts with a clean context, which is exactly how an
					// instruction absorbed from a stranger could be laundered through
					// one: the conductor reads the poisoned page, dispatches a worker
					// carrying its wishes, and the worker reaches out believing the
					// task came from the user. Taint crosses the boundary with it.
					tainted: !!tainted,
					tools: [],
					text: '',
					promptTokens: 0,
					completionTokens: 0,
					cachedTokens: 0,
					costUsd: 0,
					app: null,
				};
				self.batches[batch].ids.push(run.id);
				self.runs.unshift(run);
				self.queue.push(run);
				// Open the agent in the write-ahead log, so a tab that dies while it works recovers
				// it — with its partial output — instead of only its name.
				if (window.DaimondJournal) DaimondJournal.agentOpen(run.id, {
					name: run.name, task: run.task, diamondId: run.diamondId,
					diamondName: run.diamondName, model: run.model,
				});
			});
			this.persist();
			this.render();
			this.pump();
		},

		/// Which of the secondary models one task runs on, and why.
		///
		/// Its own method, and the one `dispatch` calls, so the routing RULE can be
		/// asked about without dispatching anything — a rule about how money is spent
		/// that could only be observed by spending it would be checked by nobody.
		///
		/// Returns `{ provider, model, sees }`. `sees` is why, not what: a run that
		/// fell back to the text model because no vision model is set still carries
		/// `sees: true`, which is what lets its tile say so.
		///
		/// # Arguments
		/// * `task` - What the daimon asked for; the only signal available here.
		/// * `text` - The text worker model for this Diamond.
		/// * `vision` - The image worker model, already fallen back to `text` if unset.
		/// * `supplied` - The caller named a model for the whole fan-out, which is the
		///   user's own choice for this dispatch and is not second-guessed.
		routeFor: function (task, text, vision, supplied) {
			var sees = !supplied && taskWantsVision(task);
			var m = sees ? vision : text;
			return { provider: m.provider || '', model: m.model || '', sees: sees };
		},

		/// The same question asked from outside, for a Diamond, with its own models
		/// resolved. What a verifier drives, and what a future settings preview would.
		routeForDiamond: function (diamondId, task) {
			return this.routeFor(task, diamondWorkerModel(diamondId),
				diamondVisionModel(diamondId), false);
		},

		pump: function () {
			if (workersHeld()) return;	// the pause tree's leaf launches nothing new
			while (this.active < this.MAX && this.queue.length) {
				this.start(this.queue.shift());
			}
		},

		/// Has every worker of `batch` finished, and if so, hand its reports back
		/// to the daimon that dispatched them.
		///
		/// Terminal means done, error OR stopped: a batch one of whose workers the
		/// user stopped is finished, and waiting for it would strand the round for
		/// ever. `paused` is NOT terminal -- a paused worker is going to be resumed,
		/// and its report belongs in the round with the others.
		///
		/// The report carries each worker's name, how it ended and its text. A
		/// worker that errored says so rather than being left out: "one of the
		/// three could not do it" is exactly the kind of thing a conductor has to
		/// know, and silently dropping it would make two agreeing reports look
		/// unanimous.
		gather: function (batch) {
			var b = batch && this.batches[batch];
			if (!b) return;
			var self = this;
			var mine = this.runs.filter(function (r) { return r.batch === batch; });
			if (mine.length < b.expected) return;		// not all enqueued yet
			var terminal = function (s) { return s === 'done' || s === 'error' || s === 'stopped'; };
			if (!mine.every(function (r) { return terminal(r.status); })) return;
			delete this.batches[batch];			// once only, whatever follows

			if (workersHeld()) return;			// the pump is held: no new spending
			if (b.depth >= this.MAX_GATHER_DEPTH) {
				setCrystalStatus('Agents finished. Not reporting back: '
					+ this.MAX_GATHER_DEPTH + ' rounds of dispatch is the limit.');
				return;
			}
			// The Diamond must still exist and still be the one on screen. A gather
			// round steers a Diamond, and steering one the user has navigated away
			// from would spend on a surface they are not looking at.
			if (!currentDiamond || currentDiamond.id !== b.diamondId) return;
			if (!diamondCanRun(b.diamondId)) return;

			var parts = mine.slice().reverse().map(function (r) {
				var head = '### ' + (r.name || r.id)
					+ (r.status === 'done' ? '' : ' — ' + r.status);
				var body = (r.text || '').trim();
				return head + '\n' + (body || '(no report)');
			});
			var instruction = 'The ' + (mine.length === 1 ? 'worker you dispatched has'
					: mine.length + ' workers you dispatched have')
				+ ' finished. Their reports follow. Read them, say what they add up to, and'
				+ ' write anything worth keeping into the crystal. Do not dispatch again'
				+ ' unless something is genuinely unresolved.\n\n' + parts.join('\n\n');

			setCrystalStatus(mine.length === 1
				? 'Agent finished; reporting back.'
				: mine.length + ' agents finished; reporting back.');
			// Deferred, so this does not run inside the finishing worker's `finally`:
			// doSteer sets crystalBusy, and re-entering the pump from under it is how
			// a turn ends up racing its own bookkeeping.
			setTimeout(function () { doSteer(instruction, b.depth + 1); }, 0);
		},

		start: async function (run) {
			this.active++;
			run.status = 'running';
			this.render();
			var self = this;
			// The worker cannot see the conversation that dispatched it, so hand
			// it what it would otherwise be missing: the house rules, and the
			// crystal of the Diamond it is working for.
			var crystal = '';
			try { crystal = await diamondApp().read_crystal(run.diamondId); } catch (e) { crystal = ''; }

			// A worker's key, like a chat's, is frozen when its agent is built. A worker spends
			// the same minted key a chat does, and must survive it being spent the same way --
			// Daimond's claim is a team, not a chat, and a team whose chat heals while its agents
			// die on the same exhausted key is the worst of both.
			var onCredits = !!(window.DaimondModels && run.provider === DaimondModels.CREDITS);
			var authFail = false, reminted = false;
			// A worker folds by its own model's window, like a chat does; a null means
			// nobody publishes one and the agent's own assumption stands.
			var window_ = function (model, provider) {
				try {
					var cw = window.DaimondPricing
						? DaimondPricing.contextWindow(model, provider || '') : null;
					if (cw && run.app && run.app.set_context_window) run.app.set_context_window(cw);
				} catch (e) { /* an older wasm build has no setter */ }
			};
			// A worker is confined to the Diamond it works for, and the scope is established
			// BEFORE its first turn rather than trusted afterwards. Async, so it cannot live
			// inside `build` — which is called again on a re-mint, and is called from a
			// synchronous try/catch — so `build` mints the app and this puts the fence on it.
			//
			// Why a worker and not the chat: a chat is the user's own conversation over their
			// whole workspace and is unscoped by design (see `Tool::run` in src/tools.rs, which
			// says so). A worker is dispatched BY a daimon that can itself see only one
			// Diamond, so an unscoped worker is the way round that confinement — the daimon
			// could not read a file and could ask something else to read it.
			var scope = async function () {
				applyRoundLimit(run.app);
				applyFoldSettings(run.app, run.provider || '');
				applyCrystalCap(run.app);
				await scopeAgentTo(run.app, run.diamondId);
			};
			var build = function () {
				if (onCredits) {
					var s = DaimondModels.slotConfig(run.slot);
					if (!s || !s.key) throw new Error('This worker has no key to run on.');
					run._gen = s.gen;
					run.app = new DaimondApp(s.url, s.key, run.model, maxOutFor(run.model, DaimondModels.CREDITS),
						Instructions.compose(Prompts.role('worker'), crystal), true);
					window_(run.model, DaimondModels.CREDITS);
					try { DaimondModels.noteUse(DaimondModels.CREDITS, run.model); } catch (e) { /* never block a run */ }
					if (run.tainted && run.app.set_tainted) run.app.set_tainted();
				} else {
					var a = appCfgFor(run);
					run._gen = creditsGen();
					run.app = new DaimondApp(a.baseUrl, a.apiKey, run.model, maxOutFor(run.model, a.provider || run.provider),
						Instructions.compose(Prompts.role('worker'), crystal), true);
					window_(run.model, a.provider || run.provider);
					try { DaimondModels.noteUse(a.provider || run.provider, run.model); } catch (e) { /* never block a run */ }
					if (run.tainted && run.app.set_tainted) run.app.set_tainted();
				}
			};
			// On credits, take a slot and mint its own key before building. A slot the
			// account cannot afford (its siblings have reserved the balance) fails here
			// as "no credits" rather than falling back to a shared key.
			// A worker spends against the daimon that dispatched it, so that is the
			// node the mint is told about.
			var runNode = DaimondPause.id('root', 'diamonds', run.diamondId, 'self');
			if (onCredits) {
				run.slot = self.takeSlot();
				try {
					await DaimondModels.mintSlot(run.slot, runNode);
				} catch (e) {
					// A refusal because the Diamond is PAUSED is a hold, not a failure.
					// The mint throws an error carrying `.paused` precisely so the two
					// can be told apart: an agent shown as failed when the user paused
					// it is a bug report from your future self.
					run.status = e && e.paused ? 'paused' : 'error';
					run.text = friendlyError(e);
					self.giveSlot(run.slot); DaimondModels.forgetSlot(run.slot);
					this.active--; this.render(); this.pump();
					return;
				}
			}
			try {
				build();
				await scope();
			} catch (e) {
				run.status = 'error';
				run.text = friendlyError(e);
				if (run.slot) { self.giveSlot(run.slot); if (window.DaimondModels) DaimondModels.forgetSlot(run.slot); }
				this.active--; this.render(); this.pump();
				return;
			}
			// A resumed worker runs a fresh session seeded with its transcript so
			// far, so the model continues rather than restarts. Its earlier spend
			// was billed when it paused, so this session's counters start at zero.
			if (run.resume) {
				var seed = [{ role: 'user', content: run.task }];
				if (run.text && run.text.trim()) seed.push({ role: 'assistant', content: run.text });
				// Zeros throughout, and the trailing pair written out rather than left off: the
				// paused session's spend was billed when it paused, so this session starts from
				// nothing on every counter -- including the cached share and the reported cost,
				// which `run.priorCached`/`run.priorCost` carry forward for the tile instead.
				try { run.app.restore(seed, 0, 0, 0, 0, 0); } catch (e) { /* restore is best-effort; worst case it restarts */ }
			}
			var sink = function (ev) {
				if (!ev || !ev.type) return;
				if (ev.type === 'text') { run.text += (ev.content || ''); if (window.DaimondJournal) DaimondJournal.agentDelta(run.id, ev.content || ''); }
				else if (ev.type === 'tool_call') { run.tools.push({ name: ev.name || '', status: 'running' }); }
				else if (ev.type === 'tool_result') {
					var failed = toolFailed(ev.content || '');
					for (var i = run.tools.length - 1; i >= 0; i--) {
						if (run.tools[i].status === 'running') { run.tools[i].status = failed ? 'failed' : 'done'; break; }
					}
				} else if (ev.type === 'truncated') {
					// The provider stopped at the output limit. Recorded on the run rather
					// than written into its output: it is a fact about the reply, not part
					// of what the worker said.
					run.truncated = true;
				} else if (ev.type === 'error') {
					// Held back while a fresh key is still worth trying, exactly as a chat holds
					// it back: an agent that goes on to succeed must not carry the wreckage of
					// the attempt that did not.
					if (!reminted && canRemint(run) && keyRefused(ev.content)) { authFail = true; return; }
					run.text += '\n' + friendlyError(ev.content || '');
				}
				self.render();
			};
			try {
				try {
					await run.app.run_turn(run.resume ? RESUME_NUDGE : run.task, sink);
				} catch (e) {
					if (!authFail || run.status === 'stopped' || run.status === 'paused') throw e;
					reminted = true; authFail = false;
					// This worker owns its slot, so it re-mints ITS OWN key — told which
					// generation it froze, so a key already replaced by its own retry is
					// taken rather than bought a second time.
					try { await DaimondModels.remintSlot(run.slot, run._gen, runNode); }
					catch (e2) {
						throw new Error('Your Daimond credits have run out. Top up in Credits, or '
							+ 'switch to a provider key of your own, then dispatch this agent again.');
					}
					// The task starts over, and that is the right trade rather than a regrettable
					// one. A worker keeps no restorable transcript -- `text` and `tools` are for
					// display, not for seeding a session -- so the alternative to re-running it is
					// failing it, and a failed agent is re-dispatched by hand and re-runs anyway.
					// The user is spared only the noticing. What was shown of the dead attempt is
					// cleared so the retry does not append to it, and its journal rows go with it,
					// since the recovery fold sums deltas and would otherwise show both attempts.
					run.text = ''; run.tools = [];
					if (window.DaimondJournal) {
						try {
							await DaimondJournal.clearAgent(run.id);
							DaimondJournal.agentOpen(run.id, { name: run.name, task: run.task,
								diamondId: run.diamondId, diamondName: run.diamondName, model: run.model });
						} catch (e3) { /* the journal is best-effort; the retry is not. */ }
					}
					self.render();
					build();
					// The rebuilt app is a NEW app and carries no scope: a re-mint that skipped
					// this would quietly hand the retry the whole workspace.
					await scope();
					await run.app.run_turn(run.task, sink);
				}
				// A stopped worker keeps whatever it managed to do; it did not fail.
				if (run.status !== 'stopped' && run.status !== 'paused') run.status = 'done';
			} catch (e) {
				if (run.status !== 'stopped' && run.status !== 'paused') { run.status = 'error'; run.text = friendlyError(e); }
			} finally {
				var _pt = (run.app && run.app.prompt_tokens) || 0;
				var _ct = (run.app && run.app.completion_tokens) || 0;
				// The cached share and the provider's own cost figure, read the same way and for
				// the same reason as the chat's. No `prev` pair is needed here: a worker gets a
				// FRESH DaimondApp per session (see start(), and `restore` to zeros on resume),
				// so the app's cumulative counters ARE this session's delta. The wasm's
				// `absorb_usage` has already rolled every round of the turn into them.
				var _ca   = (run.app && run.app.cached_tokens) || 0;
				var _cost = (run.app && run.app.cost_usd) || 0;
				// A worker spends the user's money like anything else, so it is
				// metered like anything else. A resumed worker bills only its own
				// session here -- the paused session was billed already -- and the
				// tile shows the running total across both.
				recordSpend(run.model, _pt, _ct, _ca, _cost, run.provider);
				run.promptTokens = (run.priorPrompt || 0) + _pt;
				run.completionTokens = (run.priorCompletion || 0) + _ct;
				run.cachedTokens = (run.priorCached || 0) + _ca;
				run.costUsd = (run.priorCost || 0) + _cost;
				this.active--;
				if (run.slot) { self.giveSlot(run.slot); if (window.DaimondModels) DaimondModels.forgetSlot(run.slot); }
				updateSpend();
				Files.refresh();          // a worker may have written files
				this.persist();
				// The agent has reached a terminal state; its record is in localStorage, so its
				// journal is pruned.
				if (window.DaimondJournal) DaimondJournal.agentClose(run.id, run.status, run.promptTokens, run.completionTokens);
				this.render();
				this.pump();
				// This worker's batch may now be complete, in which case its reports go
				// back to the daimon that sent them. After `pump()`, so a queued worker
				// of the same batch has been started and the batch is not called
				// finished while one of its own is still waiting for a slot.
				this.gather(run.batch);
				// A finished agent may leave the app idle; let a deferred update settle.
				if (this.active === 0) { try { window.dispatchEvent(new Event('daimond:idle')); } catch (e) {} }
			}
		},

		stop: function (run) {
			if (run.status === 'queued') {
				this.queue = this.queue.filter(function (r) { return r !== run; });
				run.status = 'stopped';
				this.persist();
				this.render();
				return;
			}
			if (run.status === 'paused') {	// already hung up; just finalise it
				run.status = 'stopped';
				this.persist();
				this.render();
				return;
			}
			if (run.status !== 'running') return;
			run.status = 'stopped';
			try { if (run.app) run.app.abort(); } catch (e) { /* already gone */ }
			this.persist();
			this.render();
		},

		/// Hang up a worker's live session but keep its transcript, so it can be
		/// resumed. A queued worker is simply held; a running one is aborted with
		/// its partial output kept. There is no provider pause primitive: the only
		/// lever over a live request is to close it, so pause aborts and marks the
		/// run resumable rather than done. Resume (Play) continues it -- see resume().
		pause: function (run) {
			if (run.status === 'queued') {
				this.queue = this.queue.filter(function (r) { return r !== run; });
				run.status = 'paused';
				this.persist(); this.render();
				return;
			}
			if (run.status !== 'running') return;
			run.status = 'paused';
			try { if (run.app) run.app.abort(); } catch (e) { /* already gone */ }
			this.persist(); this.render();
		},

		/// Resume a paused worker by starting a fresh session seeded with its task
		/// and whatever it had produced, plus a "carry on" nudge. The transcript
		/// rides on the run itself, not a live object, so this works even after a
		/// reload: the session is always rebuilt from scratch in start().
		resume: function (run) {
			if (run.status !== 'paused') return;
			// Carry the accumulated spend and text across into the new session.
			run.priorPrompt = run.promptTokens || 0;
			run.priorCompletion = run.completionTokens || 0;
			run.priorCached = run.cachedTokens || 0;
			run.priorCost = run.costUsd || 0;
			run.resume = true;
			run.app = null;			// a fresh session is built in start()
			run.status = 'queued';
			this.queue.push(run);
			this.persist();
			this.render();
			this.pump();
		},

		/// Pause every worker still in flight or waiting, and hold the pool so
		/// nothing new launches until resumed. The one action that stems a runaway
		/// fan-out at a stroke: latent work stops spending immediately.
		pauseAll: function () {
			setWorkersHeld(true);
			var self = this;
			this.runs.slice().forEach(function (r) {
				if (r.status === 'running' || r.status === 'queued') self.pause(r);
			});
			this.render();
		},

		/// Resume every paused worker and release the pool.
		resumeAll: function () {
			setWorkersHeld(false);
			var self = this;
			this.runs.slice().forEach(function (r) {
				if (r.status === 'paused') self.resume(r);
			});
			this.render();
			// And pump, which resuming the paused runs alone does not do. A run
			// resumed INDIVIDUALLY while the hold was on is queued and not
			// started; releasing the hold has to start it, or it waits for ever
			// on the next dispatch. Reachable before this phase and reachable
			// now from the global control, which releases the hold without
			// touching any run.
			this.pump();
		},

		/// Stop every worker in flight, waiting or paused -- the kill switch. Each
		/// keeps whatever it managed to do, as a stopped tile; Clear removes them.
		stopAll: function () {
			setWorkersHeld(false);
			var self = this;
			this.runs.slice().forEach(function (r) {
				if (r.status === 'running' || r.status === 'queued' || r.status === 'paused') self.stop(r);
			});
			this.persist();
			this.render();
		},

		/// Fold a finished worker's summary into the Diamond that dispatched it.
		foldIn: async function (run) {
			if (!run.text.trim()) {
				noticeDialog(t('fold.nothing'), t('fold.agent_empty'));
				return;
			}
			if (run.folded) {
				noticeDialog(t('agents.already_folded'), t('agents.already_folded_body'));
				return;
			}
			// The run is marked folded when the proposed fold is ACCEPTED, not
			// here -- the user may still reject the diff. Passing the run lets the
			// accept handler mark it, so the same summary is never offered twice.
			await foldDeltaInto(run.diamondId, run.text.trim(), run.name, run);
		},

		clearFinished: function () {
			this.runs = this.runs.filter(function (r) { return r.status === 'running' || r.status === 'queued'; });
			this.persist();
			this.render();
		},

		/// Is anything still in flight? Leaving now would kill it.
		busy: function () { return this.active > 0 || this.queue.length > 0; },

		render: function () {
			if (!agentsList) return;
			agentsList.innerHTML = '';
			renderAgentFilter();
			var live = 0, self = this;
			var finished = 0, shown = 0;
			var nRun = 0, nQueue = 0, nPause = 0;
			this.runs.forEach(function (run) {
				if (run.status === 'running') { live++; nRun++; }
				else if (run.status === 'queued') { live++; nQueue++; }
				else if (run.status === 'paused') { nPause++; }
				else finished++;
				if (!agentMatches(run)) return;
				shown++;
				agentsList.appendChild(self.tile(run));
			});
			if (agentsCount) agentsCount.textContent = live > 0 ? live + ' live' : '';
			updateAgentStat(nRun, nPause, nQueue);
			updateAgentControls(nRun, nPause, nQueue);
			// The clear control appears only when there is something finished to
			// clear, so the panel does not grow without bound with no way to prune.
			var clearBtn = document.getElementById('agents-clear');
			if (clearBtn) clearBtn.style.display = finished > 0 ? '' : 'none';
			if (this.runs.length === 0) {
				var empty = document.createElement('div');
				empty.className = 'agents-empty';
				empty.textContent = t('agents.none_yet');
				agentsList.appendChild(empty);
			} else if (shown === 0) {
				var none = document.createElement('div');
				none.className = 'agents-empty';
				none.textContent = t('agents.no_match');
				agentsList.appendChild(none);
			}
		},

		tile: function (run) {
			var self = this;
			var card = document.createElement('div');
			card.className = 'acard ' + run.status;

			var ah = document.createElement('div'); ah.className = 'ah';
			var an = document.createElement('span'); an.className = 'an';
			an.textContent = run.name;
			an.title = run.task;                     // the full instruction, on hover
			var pill = document.createElement('span');
			pill.className = 'pill ' + (run.status === 'running' ? 'run'
				: run.status === 'queued' ? 'queued'
				: run.status === 'paused' ? 'paused'
				: run.status === 'error' ? 'err'
				: (run.status === 'stopped' || run.status === 'interrupted') ? 'stopped' : 'ok');
			pill.textContent = run.status;
			ah.appendChild(an); ah.appendChild(pill);
			card.appendChild(ah);

			// What it was told to do — otherwise two agents are indistinguishable.
			var task = document.createElement('div');
			task.className = 'atask';
			task.textContent = run.task;
			card.appendChild(task);

			// Chips carry where the run came from without a tree: its Diamond, that
			// Diamond's inherited tags, and the model. The Diamond and tag chips filter.
			var chips = document.createElement('div'); chips.className = 'achips';
			chips.appendChild(agentDiamondChip(run));
			agentTagsOf(run).slice(0, TAG_CHIPS_SHOWN).forEach(function (tag) {
				var c = tagChip(tag, 'tag-sm' + (agentTagFilter === tag ? ' tag-active' : ''), setAgentTagFilter);
				c.title = t('tag.only_agents', { tag: tag });
				chips.appendChild(c);
			});
			if (run.model) {
				var mc = document.createElement('span'); mc.className = 'achip-model';
				mc.textContent = shortModel(run.model); mc.title = run.model;
				// A task that named an image was routed by modality, so the chip says which
				// half of the secondary it got. Where no vision model is set that is the
				// TEXT model — the fallback §1.4 asks for — and the title is where it says
				// so, rather than the run looking as though somebody chose it.
				if (run.sees) {
					mc.classList.add('achip-vision');
					var chose = diamondModels()[run.diamondId];
					mc.title = (chose && chose.visionModel)
						? t('agent.model_vision', { model: run.model })
						: t('agent.model_vision_fallback', { model: run.model });
				}
				chips.appendChild(mc);
			}
			card.appendChild(chips);

			var arow = document.createElement('div'); arow.className = 'arow';
			var left = document.createElement('span');
			// A worker's stored token counts are only written when its turn ends, so a
			// running tile would show nothing until it finished. Read the live counters
			// straight from its engine while it runs, so the cost climbs on the tile as
			// it works -- which is what tells you whether it is worth pausing. A resumed
			// worker adds what it had already spent before it paused.
			var pt = run.promptTokens, ct = run.completionTokens;
			var ca = run.cachedTokens || 0, usd = run.costUsd || 0;
			if (run.status === 'running' && run.app) {
				// The live counters, NOT prompt_tokens: that getter borrows the session
				// the running turn holds, so reading it here would panic the engine.
				// `cached_tokens` and `cost_usd` borrow it too, so the running tile reads
				// their live twins for exactly the same reason.
				pt = (run.priorPrompt || 0) + (run.app.live_prompt_tokens || 0);
				ct = (run.priorCompletion || 0) + (run.app.live_completion_tokens || 0);
				ca = (run.priorCached || 0) + (run.app.live_cached_tokens || 0);
				usd = (run.priorCost || 0) + (run.app.live_cost_usd || 0);
			}
			var toks = pt + ct;
			var bits = [];
			if (toks) bits.push(fmtCtx(toks) + ' tok');
			left.textContent = bits.join(' · ');
			var right = document.createElement('span');
			if (toks && window.DaimondPricing) {
				// The provider's own figure wherever it gave one, and the table only where it
				// did not. A run that was mostly cache hits costs a fraction of what the table
				// says, so the table's answer on the tile is simply a wrong number -- and there
				// is no "≈" on a figure the provider stated, because it is not an approximation.
				if (usd > 0) {
					right.textContent = fmtUsd(usd);
				} else {
					var pr = DaimondPricing.priceFor(run.model, pt, ct, ca, run.provider || '');
					if (pr) right.textContent = (pr.estimated && !DaimondI18n.converted() ? '≈' : '') + fmtUsd(pr.usd);
				}
			}
			arow.appendChild(left); arow.appendChild(right);
			card.appendChild(arow);

			if (run.tools.length) {
				var wrap = document.createElement('div'); wrap.className = 'atools';
				run.tools.slice(-8).forEach(function (t) {
					var row = document.createElement('div'); row.className = 'atool ' + t.status;
					var dot = document.createElement('span');
					dot.className = t.status === 'running' ? 'live' : t.status === 'failed' ? 'cross' : 'tick';
					dot.textContent = t.status === 'running' ? '●' : t.status === 'failed' ? '✗' : '✓';
					var nm = document.createElement('span'); nm.textContent = t.name;
					row.appendChild(dot); row.appendChild(nm);
					wrap.appendChild(row);
				});
				card.appendChild(wrap);
			}

			// A running agent can be stopped; a finished one can be folded in and
			// read. Previously the panel offered neither.
			var acts = document.createElement('div'); acts.className = 'aacts';
			if (run.status === 'running' || run.status === 'queued') {
				acts.appendChild(actBtn('pause', 'Pause', 'Hang up this agent, keeping its work so far; resume it later.', function () { self.pause(run); }));
				acts.appendChild(actBtn('cross', 'Stop', 'Stop this agent for good. It keeps whatever it managed to do.', function () { self.stop(run); }));
			} else if (run.status === 'paused') {
				acts.appendChild(actBtn('play', 'Resume', 'Continue this agent from where it left off.', function () { self.resume(run); }));
				acts.appendChild(actBtn('cross', 'Stop', 'Discard this paused agent.', function () { self.stop(run); }));
			} else {
				if (run.text.trim()) {
					// A failed agent's "summary" is an error message, not a result,
					// so folding it would write the error into the crystal. Offer the
					// fold only for an agent that actually finished its work, and
					// only once -- a folded summary is not offered again.
					var foldable = run.status !== 'error' && !run.folded;
					if (foldable) {
						var fold = document.createElement('button');
						fold.className = 'abtn';
						fold.textContent = t('agents.fold_in');
						fold.title = t('agents.fold_in_help', { name: run.diamondName });
						fold.addEventListener('click', function () { self.foldIn(run); });
						acts.appendChild(fold);
					} else if (run.folded) {
						var done = document.createElement('span');
						done.className = 'afolded';
						done.textContent = '✓ ' + t('agents.folded');
						acts.appendChild(done);
					}

					var read = document.createElement('button');
					read.className = 'abtn';
					read.textContent = t('agents.read');
					read.addEventListener('click', function () {
						noticeDialog(run.name, run.text.trim(), { pre: true });
					});
					acts.appendChild(read);
				}
			}
			if (acts.children.length) card.appendChild(acts);
			return card;
		},
	};

	// The worker pump, on the same footing as DaimondMail, DaimondModels and
	// DaimondPause: the Agents panel is a real surface and its state is worth
	// reading from outside. Here rather than beside `window.DaimondUI`, because
	// that runs long before this literal is assigned and would publish `undefined`.
	// `dev/verify_gather.mjs` sets MAX_GATHER_DEPTH to 0 through this to restore
	// the pre-gather behaviour and prove its checks against it.
	window.DaimondWorkers = Workers;

	// A DaimondApp used only to run file tools directly (no LLM turn), rooted at the
	// active workspace. Shared by the Workspace panel and the instructions loader.
	var toolsApp = null;
	function tools() {
		if (toolsApp) return toolsApp;
		var base = cfg.baseUrl || 'http://127.0.0.1/v1/chat/completions';
		try { toolsApp = new DaimondApp(base, cfg.apiKey || '', cfg.model || 'none', 256, SYSTEM_PROMPT(), true); }
		catch (e) { toolsApp = new DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, SYSTEM_PROMPT(), true); }
		return toolsApp;
	}

	// ── Standing instructions (DAIMOND.md) ─────────────────────
	//
	// A dispatched worker gets its task and nothing else: it cannot see the
	// conversation that dispatched it, it does not know the Diamond's crystal, and it
	// does not know the user's house rules. So it starts from zero every time.
	//
	// `DAIMOND.md` at the workspace root fixes that. A plain file, editable in the
	// Workspace panel like anything else, portable with the folder — the same
	// idea as a CLAUDE.md. It is prepended to the system prompt of every chat,
	// every dispatched worker, the conductor and the reducer.
	var INSTRUCTIONS_FILE = 'DAIMOND.md';
	// What the file was called before the app was named Daimond. Kept only so
	// that an existing workspace can be carried across; nothing else reads it.
	var INSTRUCTIONS_FILE_WAS = 'RED.md';
	// ── Two layers, because there are two authors ────────────────────
	//
	// `dev/ROOT_SEPARATION.md` §2.5(d) specifies this and seq 65 deferred it. The
	// deferral's reason was that doing it half-way would leave the user's own rules
	// surviving a root switch while the agent's prompt silently changed — so it is
	// done here, with the role prompts (which move to the same rule below).
	//
	// * **Yours** lives in Daimond's own store and is always in force. It is who you
	//   are and how you like to be worked with, and it does not stop being true
	//   because you opened a different folder.
	// * **The project's** lives at the root of the folder you have open, and is
	//   appended below yours. It is what THIS work needs, it travels with the folder,
	//   and it is the file a repository can carry for everyone who opens it.
	//
	// Yours first, because a project cannot be allowed to quietly overrule how you
	// work — and because the later text is the more specific one, which is the order
	// a model reads instructions in anyway.
	//
	// With no folder open the two resolve to the same file and the second read is
	// skipped: one workspace, one layer, exactly as before.
	/// Is a real folder open, as the ENGINE holds it?
	///
	/// Asked of the wasm rather than of the page's own `folderHandle`, which lives
	/// inside the Files module and is a copy: the question is which root the file
	/// tools will actually resolve against, and only one place knows that.
	function folderOpen() {
		try { return Wasm.workspace_mode() === 'folder'; }
		catch (e) { return false; }
	}

	var Instructions = {
		md: '',
		/// The user's own, from the store. Always in force.
		mine: '',
		/// The open folder's, or '' when there is no folder or it carries none.
		theirs: '',

		/// Carry a pre-rename `RED.md` over to `DAIMOND.md`, once, in whichever
		/// workspace is active.
		///
		/// The file is the user's house rules and it travels with their folder, so
		/// the rename must not cost them: a workspace written under the old name
		/// would otherwise come up silently rule-less. Checking for the file IS the
		/// check — two reads, no flag, no bookkeeping — so this stays correct for a
		/// folder the app has never seen before. If `DAIMOND.md` is already there it
		/// wins and the old file is left untouched; the user's current rules are
		/// never clobbered by their old ones.
		migrate: async function () {
			try {
				var cur = await tools().run_tool('file_read', JSON.stringify({ path: INSTRUCTIONS_FILE }));
				if (typeof cur === 'string' && !/^\s*Error\b/i.test(cur)) return;   // already renamed, or never named
				var old = await tools().run_tool('file_read', JSON.stringify({ path: INSTRUCTIONS_FILE_WAS }));
				if (typeof old !== 'string' || /^\s*Error\b/i.test(old)) return;    // nothing to carry
				await tools().run_tool('file_move', JSON.stringify({ path: INSTRUCTIONS_FILE_WAS, to: INSTRUCTIONS_FILE }));
			} catch (e) {
				// A workspace we cannot read is a workspace we cannot migrate. The
				// refresh below will find no rules and the app carries on as it does
				// for any folder without them.
			}
		},

		/// Re-read DAIMOND.md from the ACTIVE workspace root (a real folder when one
		/// is open, else the OPFS sandbox), so the rules travel with the project.
		refresh: async function () {
			var prev = this.md;
			await this.migrate();
			// Yours, from the store. `Wasm.store_read` and not `file_read`: with a
			// folder open, `file_read` resolves against the FOLDER, so this would read
			// the project's copy and call it the user's — and the user's own rules
			// would vanish the moment they opened a project.
			this.mine = '';
			try {
				var own = await Wasm.store_read(INSTRUCTIONS_FILE);
				if (typeof own === 'string') this.mine = own;
			} catch (e) { /* nothing written yet */ }
			// The project's, from the folder — and only when there IS one. With no
			// folder open both paths resolve to the same file, and reading it twice
			// would put the user's own rules into the prompt twice over.
			this.theirs = '';
			if (folderOpen()) {
				try {
					var proj = await tools().run_tool('file_read',
						JSON.stringify({ path: INSTRUCTIONS_FILE }));
					if (typeof proj === 'string' && !/^\s*Error\b/i.test(proj)) this.theirs = proj;
				} catch (e) { /* a folder without one is the ordinary case */ }
			}
			this.md = this.layered();
			// Existing agents hold a system prompt composed at construction, so a
			// changed DAIMOND.md only takes effect on their next turn — rebuild them.
			if (this.md !== prev) {
				chats.forEach(function (c) { c.app = null; });
				var md = this.md;
				Object.keys(_diamondApps).forEach(function (k) {
					try { _diamondApps[k].set_instructions(md); } catch (e) { /* ignore */ }
				});
			}
			this.render();
			return this.md;
		},

		/// The two layers as one text, each under a heading that says whose it is.
		///
		/// Headed rather than run together, because a model that cannot tell them
		/// apart cannot resolve a conflict between them — and where they conflict the
		/// project's is the more specific instruction and should win, which is only
		/// legible if it is visibly the project's.
		layered: function () {
			var mine = (this.mine || '').trim(), theirs = (this.theirs || '').trim();
			if (!theirs) return mine;
			if (!mine) return theirs;
			return mine + '\n\n## For this project\n\n' + theirs;
		},

		/// The role prompt, plus the house rules, plus (for a worker) the crystal of
		/// the Diamond that dispatched it.
		compose: function (role, crystal) {
			var out = role;
			if (this.md.trim()) {
				out += '\n\n## Standing instructions from the user\n\n' + this.md.trim();
			}
			if (crystal && crystal.trim()) {
				out += '\n\n## The crystal of the Diamond that dispatched you\n\n'
					+ 'This is what the work is for. Act consistently with it.\n\n' + crystal.trim();
			}
			return out;
		},

		/// A quiet chip in the Workspace head, so the user can see the rules are
		/// in force — and open them.
		render: function () {
			var el = document.getElementById('instructions-chip');
			if (!el) return;
			if (!this.md.trim()) { el.style.display = 'none'; return; }
			el.style.display = '';
			// Two layers get a chip that says two, because "your rules are in force" and
			// "your rules AND this project's are in force" are different facts and the
			// second is the one people are surprised by.
			var both = !!(this.mine.trim() && this.theirs.trim());
			el.textContent = '✦ ' + INSTRUCTIONS_FILE + (both ? ' ×2' : '');
			el.title = both ? t('instructions.chip_two') : t('instructions.chip_help');
		},
	};

	// ── The role prompts ───────────────────────────────────────────
	//
	// DAIMOND.md above is what the user ADDS to every agent. This is what each
	// agent is told in the first place -- the prompt itself -- and it is theirs
	// to change too: `prompts/chat.md`, `prompts/daimon.md`,
	// `prompts/worker.md`, `prompts/reducer.md` and `prompts/compactor.md`,
	// ordinary text files edited in the Doc panel like anything else.
	//
	// They live in DAIMOND'S OWN STORE, not in whatever folder happens to be open.
	// That is a change: they used to resolve against the active workspace, so
	// opening a project silently put every agent back on its shipped prompt while
	// the user's own DAIMOND.md carried on — the agent's instructions changing
	// under them with nothing on screen to say so. `dev/ROOT_SEPARATION.md` §2.5(d)
	// names this, and it is why the instructions and the prompts move together
	// rather than one phase apart: half of it is worse than neither half.
	//
	// An absent or empty file means the shipped default, so deleting one is how
	// a user puts the original back. The defaults themselves live in Rust
	// (src/prompts.rs) and are read through the wasm, so what an editor shows is
	// what a model is really sent.
	//
	// What an edit CANNOT remove is the safety clause: the rule that page text is
	// data rather than instruction, and the rule that nothing irreversible
	// happens unasked. `compose_prompt` appends it to every role that holds
	// tools, on the far side of the user's text.
	var PROMPTS_DIR = 'prompts';
	var Prompts = {
		/// Role name -> the user's text, '' where they have written none.
		md: { chat: '', daimon: '', worker: '', reducer: '', compactor: '' },

		/// Every role, with what to call it and what it is for -- the source for
		/// the buttons in the Admin panel.
		// `label` and `blurb` are KEYS, read when the menu is built, so a role
		// reads in whatever language is in force at that moment.
		roles: [
			{ id: 'chat',      label: 'role.chat',      blurb: 'role.chat_help' },
			{ id: 'daimon',    label: 'role.daimon',    blurb: 'role.daimon_help' },
			{ id: 'worker',    label: 'role.worker',    blurb: 'role.worker_help' },
			{ id: 'reducer',   label: 'role.reducer',   blurb: 'role.reducer_help' },
			// The fifth, and the one that has been unreachable since it was written.
			// `Role::Compactor` had a name, a label, a default prompt and a parser in
			// Rust, and this list is the only thing that decides whether a role's file
			// is ever read -- so `prompts/compactor.md` was a file a user could write
			// and nothing would open. It is the model that summarises a conversation
			// being folded: the one prompt whose output BECOMES the session's memory.
			{ id: 'compactor', label: 'role.compactor', blurb: 'role.compactor_help' },
		],

		path: function (id) { return PROMPTS_DIR + '/' + id + '.md'; },

		/// The whole system prompt for `id`: the user's text or the default,
		/// plus the rules their edit cannot remove.
		role: function (id) {
			try { return compose_prompt(id, this.md[id] || ''); }
			catch (e) { return default_prompt(id); }
		},

		/// What the shipped default says, for seeding a file and for the "restore"
		/// path. This is the real text, read out of the wasm.
		defaultFor: function (id) {
			try { return default_prompt(id); } catch (e) { return ''; }
		},

		/// The fixed rules, shown above the editor so what is immovable is plain.
		clause: function () {
			try { return safety_clause(); } catch (e) { return ''; }
		},

		/// Re-read every prompt file from the ACTIVE workspace root, so they
		/// travel with the project exactly as DAIMOND.md does.
		/// A role that has been renamed carries its old file across.
		///
		/// `prompts/conductor.md` was the daimon's, and it is a file the user may
		/// have spent an afternoon on. Renaming the role without this would leave
		/// it in the workspace being read by nothing -- the agent quietly back on
		/// the shipped default, with the edited file still on disk looking as
		/// though it were in force. That is the worst of the three possible
		/// outcomes, because nothing about it looks wrong.
		///
		/// Copies rather than moves, and only when the new name does not exist, so
		/// running twice is harmless and nothing the user wrote is destroyed.
		adoptOldNames: async function () {
			var renamed = [{ from: 'conductor', to: 'daimon' }];
			for (var i = 0; i < renamed.length; i++) {
				var from = this.path(renamed[i].from), to = this.path(renamed[i].to);
				try {
					var already = '';
					try { already = await Wasm.store_read(to); } catch (e2) { already = ''; }
					if (already) continue;
					// The CONTENT is carried into the new file, so it must be the bytes.
					var old = await Wasm.store_read(from);
					if (typeof old !== 'string' || !old.trim()) continue;
					await Wasm.store_write(to, old);
				} catch (e) { /* nothing written yet, or unreadable: nothing to carry */ }
			}
		},

		refresh: async function () {
			var changed = false;
			await this.adoptOldNames();
			for (var i = 0; i < this.roles.length; i++) {
				var id = this.roles[i].id;
				var was = this.md[id];
				try {
					var res = await Wasm.store_read(this.path(id));
					this.md[id] = (typeof res === 'string') ? res : '';
				} catch (e) {
					this.md[id] = '';       // nothing written: the shipped default stands
				}
				if (this.md[id] !== was) changed = true;
			}
			// A chat or a worker is built with its prompt already composed, so a
			// changed file only reaches it on the next construction -- drop them.
			// The daimon and the reducer are built inside the wasm, which is
			// told directly.
			if (changed) {
				chats.forEach(function (c) { c.app = null; });
				var self = this;
				Object.keys(_diamondApps).forEach(function (k) {
					try {
						_diamondApps[k].set_role_prompt('daimon',  self.md.daimon  || '');
						_diamondApps[k].set_role_prompt('reducer', self.md.reducer || '');
						// The compactor's is not this app's own prompt at all -- it is what
						// the tool-less model folding its conversation is told -- so it is
						// applied alongside the fold model rather than beside these two.
						applyFoldSettings(_diamondApps[k],
							_diamondAppProvider.get(_diamondApps[k]) || '');
					} catch (e) { /* an app mid-turn keeps what it has */ }
				});
			}
			return changed;
		},

		/// Open a role's prompt for editing, writing the shipped default into the
		/// file first if there is nothing there yet.
		///
		/// Seeding matters: an empty editor would leave the user guessing at what
		/// they are replacing, and the thing most worth reading is what the agent
		/// is told TODAY. Writing the default also makes the file the plain record
		/// of it -- greppable, diffable, and portable with the folder.
		edit: async function (id) {
			var path = this.path(id);
			var cur = '';
			try { cur = await Wasm.store_read(path); } catch (e) { cur = ''; }
			if (typeof cur !== 'string' || !cur.trim()) {
				// `store_write` creates parents, so there is no directory to make first.
				await Wasm.store_write(path, this.defaultFor(id));
				await this.refresh();
				try { Files.refresh(); } catch (e) { /* the tree redraws on its own next time */ }
			}
			// Opened through the STORE door, so the editor reads and writes the file
			// that is actually in force -- not a same-named one in an open folder.
			Files.open(path, { store: true });
		},
	};
	// A service like the others: what each agent is told, and the way to change
	// it. Exposed so the Admin panel, the verifiers and anything added later all
	// go through the one implementation rather than reading the files again.
	window.DaimondPrompts = Prompts;

	// ── Pending: what a daimon has proposed and is waiting on you for ──
	//
	// Notes2: "at this stage we have the user approving all outgoing email, so
	// this leads to the need for a new Dock panel, say 'Pending' with tiles for
	// each action that must be approved by the user."
	//
	// Three answers, and all three take the tile away, because a list you have to
	// tidy separately is a list that stops being read:
	//
	//   ✓  do it        the action runs
	//   ?  discuss it   you land in that Diamond's chat with the details already
	//                   sent -- which is what phase E built somewhere to land IN
	//   ✕  drop it      it never happens
	//
	// PRIORITY IS SET BY THE DAIMON THAT RAISED IT (§5.3, settled with the user),
	// and you may override it. Anything else means setting a priority by hand on
	// every item, which nobody does twice.
	var PENDING_KEY = 'daimond-pending';
	var PRIORITIES  = ['high', 'normal', 'low'];

	var Pending = {
		items: [],

		load: function () {
			this.items = readJson(PENDING_KEY, []) || [];
			if (!Array.isArray(this.items)) this.items = [];
		},
		save: function () {
			try { localStorage.setItem(PENDING_KEY, JSON.stringify(this.items)); }
			catch (e) { /* quota: it holds for this session */ }
			this.render();
			nudgeSync();
		},

		/// Raise one item. `kind` is what doing it would DO, and it is the only
		/// field this module interprets: everything else is the daimon's words.
		add: function (item) {
			if (!item || !item.headline) return null;
			var rec = {
				id:        'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
				diamondId: item.diamondId || '',
				diamondName: item.diamondName || '',
				headline:  String(item.headline),
				detail:    String(item.detail || ''),
				kind:      item.kind || 'note',
				// Resources the tile shows as a row of icons: files the action would
				// touch, so what it acts ON is visible without expanding it.
				files:     Array.isArray(item.files) ? item.files.slice(0, 8) : [],
				priority:  PRIORITIES.indexOf(item.priority) >= 0 ? item.priority : 'normal',
				at:        Date.now(),
			};
			this.items.push(rec);
			this.save();
			// Revealed the way a dispatch reveals Agents: the one moment there is
			// something to answer and nobody has asked to watch for it.
			try { if (!DaimondPanels.isOpen('pending')) DaimondPanels.show('pending'); }
			catch (e) { /* the layout engine is not up */ }
			return rec.id;
		},

		drop: function (id) {
			this.items = this.items.filter(function (x) { return x.id !== id; });
			this.save();
		},

		/// The sort the user chose. Priority first is the default, because the
		/// question a list of things to approve answers is "what next".
		sorted: function () {
			var how = 'priority';
			try { how = localStorage.getItem(PENDING_KEY + '-sort') || 'priority'; } catch (e) { /* default */ }
			var out = this.items.slice();
			if (how === 'newest') out.sort(function (a, b) { return b.at - a.at; });
			else if (how === 'oldest') out.sort(function (a, b) { return a.at - b.at; });
			else out.sort(function (a, b) {
				var d = PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority);
				// Oldest first WITHIN a priority: two things equally urgent are
				// answered in the order they were asked.
				return d !== 0 ? d : a.at - b.at;
			});
			return out;
		},

		render: function () {
			var list = document.getElementById('pending-list');
			var count = document.getElementById('pending-count');
			if (!list) return;
			if (count) count.textContent = this.items.length ? String(this.items.length) : '';
			list.innerHTML = '';
			if (!this.items.length) {
				var none = document.createElement('div');
				none.className = 'rail-note';
				none.textContent = t('pending.empty');
				list.appendChild(none);
				return;
			}
			this.sorted().forEach(function (it) {
				list.appendChild(Pending.tile(it));
			});
		},

		tile: function (it) {
			var box = document.createElement('div');
			box.className = 'pend-card prio-' + it.priority;
			box.dataset.id = it.id;

			var head = document.createElement('div');
			head.className = 'pend-head';
			var prio = document.createElement('select');
			prio.className = 'pend-prio';
			prio.title = t('pending.priority');
			prio.setAttribute('aria-label', t('pending.priority'));
			PRIORITIES.forEach(function (pv) {
				var o = document.createElement('option');
				o.value = pv; o.textContent = t('pending.prio_' + pv);
				prio.appendChild(o);
			});
			prio.value = it.priority;
			prio.addEventListener('change', function () {
				it.priority = prio.value;
				Pending.save();
			});
			head.appendChild(prio);
			if (it.diamondName) {
				var chip = document.createElement('span');
				chip.className = 'pend-diamond';
				chip.textContent = it.diamondName;
				head.appendChild(chip);
			}
			var when = document.createElement('span');
			when.className = 'pend-when';
			when.textContent = relTime(it.at);
			head.appendChild(when);
			box.appendChild(head);

			// The headline, which EXPANDS. A panel of paragraphs cannot be scanned,
			// and a panel of one-liners cannot be judged -- so it is both, and which
			// one is up is the reader's choice.
			var line = document.createElement('button');
			line.type = 'button';
			line.className = 'pend-line';
			line.textContent = it.headline;                 // escaped via textContent
			line.setAttribute('aria-expanded', 'false');
			var body = document.createElement('div');
			body.className = 'pend-detail';
			body.style.display = 'none';
			body.textContent = it.detail || t('pending.no_detail');
			line.addEventListener('click', function () {
				var on = body.style.display === 'none';
				body.style.display = on ? '' : 'none';
				line.setAttribute('aria-expanded', on ? 'true' : 'false');
			});
			box.appendChild(line);
			box.appendChild(body);

			if (it.files && it.files.length) {
				var files = document.createElement('div');
				files.className = 'pend-files';
				it.files.forEach(function (path) {
					var b = document.createElement('button');
					b.type = 'button';
					b.className = 'pend-file';
					b.textContent = '📄 ' + String(path).split('/').pop();
					b.title = path;
					b.addEventListener('click', function () { Files.open(path); });
					files.appendChild(b);
				});
				box.appendChild(files);
			}

			var acts = document.createElement('div');
			acts.className = 'pend-acts';
			var go = document.createElement('button');
			go.type = 'button'; go.className = 'pend-act pend-go';
			go.textContent = '✓'; go.title = t('pending.execute');
			go.setAttribute('aria-label', t('pending.execute_named', { what: it.headline }));
			go.addEventListener('click', function () { Pending.execute(it); });
			var ask = document.createElement('button');
			ask.type = 'button'; ask.className = 'pend-act pend-ask';
			ask.textContent = '?'; ask.title = t('pending.discuss');
			ask.setAttribute('aria-label', t('pending.discuss_named', { what: it.headline }));
			ask.addEventListener('click', function () { Pending.discuss(it); });
			var no = document.createElement('button');
			no.type = 'button'; no.className = 'pend-act pend-no';
			no.textContent = '✕'; no.title = t('pending.cancel');
			no.setAttribute('aria-label', t('pending.cancel_named', { what: it.headline }));
			no.addEventListener('click', function () { Pending.drop(it.id); });
			acts.appendChild(go); acts.appendChild(ask); acts.appendChild(no);
			box.appendChild(acts);
			return box;
		},

		/// Do it. What that means depends on the kind, and there is exactly one
		/// kind today: a draft the daimon wrote, which the mail panel sends.
		execute: async function (it) {
			if (it.kind === 'draft' && it.files && it.files[0] && window.DaimondMail) {
				try { await DaimondMail.openDraft(it.files[0]); }
				catch (e) { toast(friendlyError(e), true); return; }
			} else {
				// A note has nothing to run: approving it is acknowledging it, and
				// saying so is better than a tick that quietly means nothing.
				toast(t('pending.noted'));
			}
			Pending.drop(it.id);
		},

		/// Discuss it: back to the daimon that raised it, with the details already
		/// sent. Phase E is what gave this somewhere to land -- before it there was
		/// no conversation to return the user TO.
		discuss: async function (it) {
			var f = (diamonds || []).find(function (x) { return x.id === it.diamondId; });
			if (!f) { toast(t('pending.diamond_gone'), true); Pending.drop(it.id); return; }
			Pending.drop(it.id);
			await selectDiamond(f, 'chat');
			var text = t('pending.discuss_prompt', { headline: it.headline })
				+ (it.detail ? '\n\n' + it.detail : '');
			await doSteer(text);
		},
	};

	// What is waiting on the user, published so a daimon's proposal can be raised
	// from anywhere -- the mail panel, a tool, a trigger -- without a second copy
	// of the store growing beside this one.
	// One Diamond's triggered actions, read-only. Published so that anything
	// building a picture of the pause tree -- the widget verifier does exactly
	// this -- can ask what the leaves ARE rather than assuming a shape.
	window.DaimondTriggersOf = function (id) { return Triggers.of(id).slice(); };

	window.DaimondPendingView = {
		add:   function (item) { return Pending.add(item); },
		items: function () { return Pending.items.slice(); },
		drop:  function (id) { return Pending.drop(id); },
	};
	// The two layers of standing instructions, for the same reason: what reaches
	// every agent should be askable from outside the one function that composes it.
	window.DaimondInstructions = Instructions;

	// ── Credits (the Daimond gateway) ──────────────────────────────
	// Daimond is free and BYOK by default; credits are for the user who does not want
	// to hold a provider key at all. The gateway is optional — if it is down, the
	// app carries on exactly as before and simply offers nothing here.
	/// The Pro block at the top of the Credits drawer: an offer to own Daimond,
	/// or the confirmation that it is owned. Pro is the one-time unlock that
	/// turns on cross-device sync, cloud storage and Email; credits are separate
	/// and pay for metered use (inference, bandwidth), whether or not Pro is held.
	function renderPro() {
		var host = document.getElementById('credits-pro');
		if (!host || !window.DaimondGateway) return;
		var st = DaimondGateway.state();
		host.innerHTML = '';
		// No account, or the gateway is unreachable: the Pro offer needs one, so
		// say nothing here rather than a dead button. The packs area below
		// already carries the "create an account" path.
		if (st.offline || !st.authed || st.pro === null) return;

		if (st.pro) {
			var owned = document.createElement('div');
			owned.className = 'pro-owned';
			owned.innerHTML = t('pro.owned');
			host.appendChild(owned);
			return;
		}
		// Pro is a real charge, so the price says US dollars out loud and hangs
		// the converted figure off it. See `billing.usd_note` below.
		var price = st.proPriceMinor ? DaimondGateway.fmtBilled(st.proPriceMinor, st.currency) : '';
		var box = document.createElement('div');
		box.className = 'pro-offer';
		// Static copy plus the formatted price (a number); no user text, so
		// innerHTML is safe here and reads better than a pile of createElement.
		box.innerHTML =
			t('pro.offer')
			+ '<p class="pro-fine">' + t('pro.fine') + '</p>'
			+ '<button class="pro-buy" id="pro-buy">'
			+ (price ? t('pro.buy_priced', { price: price }) : t('pro.buy')) + '</button>'
			+ (usdDisplay() ? '' : '<p class="pro-fine">' + t('billing.usd_note') + '</p>')
			+ '<div class="pro-err" id="pro-err"></div>';
		host.appendChild(box);
		var btn = document.getElementById('pro-buy');
		if (btn) btn.addEventListener('click', async function () {
			btn.disabled = true;
			try {
				var r = await DaimondGateway.buyPro();      // navigates to Stripe, or returns {held}
				if (r && r.held) { await DaimondGateway.refreshLicence(); renderPro(); }
			} catch (e) {
				var err = document.getElementById('pro-err');
				if (err) err.textContent = friendlyError(e);
				btn.disabled = false;
			}
		});
	}

	function renderCredits() {
		var sec  = document.getElementById('credits-section');
		var bal  = document.getElementById('credits-balance');
		var wrap = document.getElementById('credits-packs');
		var note = document.getElementById('credits-note');
		if (!sec || !bal || !wrap || !window.DaimondGateway) return;
		// The Pro block is a self-contained offer at the top of the drawer. It
		// must never take the rest of Credits down with it, so a fault in it is
		// contained here rather than left to break the balance and the packs.
		try { renderPro(); } catch (e) { /* the offer is absent; Credits still works. */ }
		var st = DaimondGateway.state();

		if (st.offline || !st.authed) {
			bal.textContent = '';
			wrap.innerHTML = '';
			if (st.offline) {
				note.textContent = t('credits.offline');
			} else {
				// A stranger with no account was told to "create an account" with no
				// way to do so from here. The way forward is now a button, not a
				// sentence: buying credits needs an account, so offer to make one.
				note.textContent = t('credits.need_account');
				var make = document.createElement('button');
				make.className = 'credit-pack';
				make.textContent = t('credits.create_account');
				make.addEventListener('click', function () { showIdentity('create'); });
				wrap.appendChild(make);
			}
			return;
		}

		note.textContent = '';
		// The balance is a meter, not a charge: it converts like any other
		// figure, with the ≈ the conversion earns.
		bal.textContent = st.credits === null
			? t('credits.balance_unavailable')
			: t('credits.balance', { amount: DaimondGateway.fmtMoney(st.credits, st.currency) });

		// A door to the full breakdown of where credits (and inference) go. The
		// header spend meter is the other door, but it hides when there is no
		// inference spend, so a credits-only user needs this one. Added once.
		// Made once, but LABELLED every time: built inside the creation guard, the
		// text kept whatever language the drawer was first opened in and every
		// later language change went past it.
		var seeSpend = document.getElementById('credits-see-spend');
		if (!seeSpend) {
			seeSpend = document.createElement('button');
			seeSpend.id = 'credits-see-spend';
			seeSpend.className = 'admin-item';
			seeSpend.addEventListener('click', function () { if (window.DaimondSpend) DaimondSpend.show(); });
			bal.insertAdjacentElement('afterend', seeSpend);
		}
		seeSpend.textContent = t('credits.see_spend');

		wrap.innerHTML = '';
		// A shop offers €10, not €9.26. The tiers are snapped to round prices in
		// whatever currency is on show, and the dollar amount that will actually
		// reach the card is printed beside each one. With dollars selected these
		// are the gateway's own tiers, unchanged.
		var tiers = DaimondI18n.niceTiers(DaimondGateway.packs());
		tiers.forEach(function (tier) {
			var b = document.createElement('button');
			b.className = 'credit-pack';
			if (usdDisplay()) {
				b.textContent = tier.localText;
			} else {
				var loc = document.createElement('span');
				loc.className = 'pack-local';
				loc.textContent = tier.localText;
				var bil = document.createElement('span');
				bil.className = 'pack-billed';
				// The separator is in the text rather than the stylesheet, so the
				// two figures never run together whatever the skin does with them.
				bil.textContent = ' · ' + tier.billedText;
				b.appendChild(loc);
				b.appendChild(bil);
				b.title = t('billing.usd_note');
			}
			b.addEventListener('click', async function () {
				b.disabled = true;
				// The charge is the DOLLAR figure. The round local price is what
				// was chosen; what is billed is what is shown beside it.
				try { await DaimondGateway.buyCredits(tier.billedMinor); }   // navigates to Stripe
				catch (e) { note.textContent = friendlyError(e); b.disabled = false; }
			});
			wrap.appendChild(b);
		});
		if (!usdDisplay()) {
			var pn = document.createElement('p');
			pn.className = 'cfg-fieldnote pack-note';
			pn.textContent = t('billing.usd_note') + ' ' + t('billing.rates_as_of', { date: DaimondI18n.ratesAsOf() });
			wrap.appendChild(pn);
		}
	}

	/// Attach to the gateway once the identity is unlocked (its auth is a signed
	/// challenge, so it cannot run while locked), then show what came back.
	/// Turn a credit balance into models to run.
	///
	/// Credits bought everything the app does except the thing the app is for: a user with $10
	/// in their account could fetch pages, send mail and sync with it, and the model picker
	/// still said "no model connected". A balance is now a provider row like any other -- the
	/// key is minted by the gateway instead of pasted by the user, and the browser calls the
	/// provider directly with it exactly as it does with a key of the user's own. Daimond is
	/// not in the inference path here either, which is the entire point of the product and the
	/// reason this is a minted key rather than a proxy.
	///
	/// Fire-and-forget, like everything hanging off the gateway: a credits row that cannot be
	/// built must never disturb a user who only ever wanted their own key.
	async function syncCredits() {
		if (!window.DaimondModels || !window.DaimondGateway) return;
		var st = DaimondGateway.state();
		try {
			await DaimondModels.syncCredits({
				authed:   st.authed,
				credits:  st.credits,
				currency: st.currency,
				offline:  st.offline,
			});
		} catch (e) { /* the row says why; nothing else needs to know. */ }
		syncCfgFromModels();
		DaimondAdmin.status();
	}

	async function connectGateway() {
		if (!window.DaimondGateway) return;
		await DaimondGateway.bootstrap();
		renderCredits();
		updateSpend();
		DaimondAdmin.status();          // the credits and the account dot just changed
		// bootstrap() has just read the balance, so this is the first moment the models a
		// balance buys can be known. A first-time user with credits and no key of their own
		// goes from "no model connected" to several hundred models here, and nowhere else.
		syncCredits();
		// The Email panel's entitlement is a signed read, so it could not have
		// been fetched at boot -- the identity was still locked. Ask now that
		// there is a session, or a returning user is told the account service is
		// unreachable when it is fine.
		if (window.DaimondMail && DaimondPanels.isOpen('mail')) DaimondMail.onOpen();
		// And what this account has unlocked, for the same reason: at boot there was no
		// session to ask under, so the rail could count what Daimond is born with and
		// nothing the user has bought.
		if (window.DaimondTools) DaimondTools.reload();
		// There is a session now, so the sync engine can reach its mailbox: pull
		// the other devices' state and begin pushing this one's. Fire-and-forget,
		// like everything else that hangs off the gateway.
		try { window.dispatchEvent(new Event('daimond:authed')); } catch (e) { /* best effort */ }
	}

	// A Diamond DaimondApp's counters are cumulative across every steer and fold IT has run, so a
	// turn's cost is the growth since that app was last read.
	//
	// There is now one app per model, so the previous reading is kept per app, not in a pair of
	// module variables. With a single pair, a fold on a cheap model followed by a steer on an
	// expensive one would have billed the difference between two unrelated counters -- and priced
	// the turn at whatever the starred model happened to cost.
	// The cached share and the provider's own cost figure are metered the same way and kept in the
	// same per-app reading. `absorb_usage` rolls all four out of each throwaway Session into the
	// app, so all four grow together and one delta rule serves them all.
	var _diamondMeter = new Map();       // app -> { p, c, ca, cost } at the last reading
	function meterDiamondTurn(app) {
		if (!app || !window.DaimondLedger) return;
		var prev = _diamondMeter.get(app) || { p: 0, c: 0, ca: 0, cost: 0 };
		var p = app.prompt_tokens || 0, c = app.completion_tokens || 0;
		var ca = app.cached_tokens || 0, cost = app.cost_usd || 0;
		var dp = Math.max(0, p - prev.p), dc = Math.max(0, c - prev.c);
		var dca = Math.max(0, ca - prev.ca), dcost = Math.max(0, cost - prev.cost);
		_diamondMeter.set(app, { p: p, c: c, ca: ca, cost: cost });
		if (dp + dc === 0) return;
		recordSpend(_diamondAppModel.get(app) || cfg.model, dp, dc, dca, dcost,
			_diamondAppProvider.get(app) || '');
		updateSpend();
	}

	/// Fold an arbitrary delta (an agent's summary, say) into a Diamond, through
	/// the same advisory path a chat fold takes: propose, show the diff, and let
	/// the user accept or veto.
	async function foldDeltaInto(diamondId, delta, sourceName, sourceRun) {
		var f = diamonds.find(function (x) { return x.id === diamondId; });
		if (!f) { noticeDialog(t('fold.diamond_gone'), t('fold.diamond_gone_body')); return; }
		if (!diamondCanRun(diamondId)) {
			openSettings(t('fold.no_key'));
			return;
		}
		await selectDiamond(f);
		setCrystalBusy(true); setCrystalStatus('Proposing fold…');
		var cur, proposed;
		var fa = diamondApp(diamondId);            // the Diamond's own model, not the starred one
		try {
			cur = await fa.read_crystal(diamondId);
			proposed = await fa.fold_propose(diamondId, delta);
		} catch (e) {
			meterDiamondTurn(fa);
			setCrystalStatus(friendlyError(e)); setCrystalBusy(false); return;
		}
		meterDiamondTurn(fa);
		setCrystalStatus(''); setCrystalBusy(false);
		pendingFolds[diamondId] = {
			base: cur, proposed: proposed, delta: delta,
			chatId: null, chatName: sourceName, sourceRun: sourceRun || null,
		};
		renderFoldDiff(diamondId);
	}

	// ── Workspace (OPFS over run_tool) ─────────────────────────
	var Files = (function () {
		var pathEl, treeEl, viewEl, modeEl;
		var cloudChipEl = null;		// the Cloud chip, repainted as residency moves.
		var curDir = '';
		var curFile = null, curContent = '';
		var editing = false;   // a file is open in the editor with unsaved changes possible
		var listed = false;
		var showLineNos = localStorage.getItem('daimond-files-lineno') !== '0';
		// The active FSA real-folder handle, or null for the OPFS sandbox.
		// The wasm override is a single global (a thread-local, wasm being
		// single-threaded), so every DaimondApp instance follows this handle;
		// this variable only mirrors it for the UI.
		var folderHandle = null;
		// The last real folder this account used, remembered ACROSS a switch to the browser
		// sandbox. Switching to the sandbox used to delete the stored handle outright, so going
		// back meant picking the folder again from a native dialog -- every single time. A user
		// who moves between the two (the sandbox syncs; a folder does not) was doing that all
		// day. This is what makes the way back one click, and it is a separate variable from
		// `folderHandle` precisely because the agent is NOT working here.
		var rootHandle = null;

		// ── The Diamond's workspace: a view, not a container ───────
		//
		// A Diamond's workspace is the set of paths its daimon may open, and the
		// tool door enforces exactly that set (`diamond_bounds`, src/tools.rs).
		// It is a VIEW over the one workspace: the same folder attached to two
		// Diamonds is one folder, so an edit made in either shows in both. That
		// is why nothing here copies, moves or deletes anything -- attaching
		// writes a link and detaching removes it, and the file never moves.
		//
		// `scope` is which of the two trees the panel is showing. It is the
		// device's preference, kept like the line-number toggle beside it, so a
		// person who works inside one Diamond does not re-choose every session.
		var LS_SCOPE = 'daimond-files-scope';
		var scope = (function () {
			try { return localStorage.getItem(LS_SCOPE) === 'diamond' ? 'diamond' : 'all'; }
			catch (e) { return 'all'; }
		})();
		var scopeEl = null;			// the row of two chips, built in bind()
		var kitsEl  = null;			// the row of toolchain grants, built in bind()
		var attached = [];			// the open Diamond's attachments; see loadAttached
		var lastDiamondId = null;		// so a re-read of the SAME Diamond does not relist

		/// Whether the tree is showing one Diamond's workspace.
		///
		/// The stored preference alone is not enough: the Diamond mode exists
		/// only while a Diamond is open, and a preference left at `diamond`
		/// must fall back to the whole workspace rather than to nothing.
		function diamondScope() { return scope === 'diamond' && !!currentDiamond; }

		/// The open Diamond's own directory: always in its workspace, always
		/// writable, and the one place a daimon can work before the user has
		/// attached anything.
		function ownDir() { return currentDiamond ? ('diamonds/' + currentDiamond.id) : ''; }

		/// Whether `p` sits at or beneath `root`, by whole segments -- so
		/// `notes-old/x` is not "inside" `notes` merely by spelling it.
		function underPath(p, root) {
			if (!root) return false;
			return p === root || p.indexOf(root + '/') === 0;
		}

		function fmtBytes(n) {
			if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
			if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
			return n + ' B';
		}
		function joinPath(dir, name) { return dir ? (dir + '/' + name) : name; }

		var filterEl = null, filter = '', lastEntries = [], filterTimer = null;

		/// With no filter, show the current directory. With one, search the whole
		/// tree from here down — a filter that stops at the current directory
		/// tells the user a file does not exist when it is one folder away.
		async function applyFilter() {
			if (!filter) {
				if (diamondScope()) list(curDir); else renderTree(lastEntries);
				return;
			}
			// In a Diamond's workspace the search is bounded by the workspace: a
			// filter that reached the whole tree would answer with files the
			// daimon cannot open, from a panel whose whole claim is that it shows
			// what it can.
			if (diamondScope()) { await filterDiamond(); return; }
			var hits = [];
			var todo = [curDir || ''];
			while (todo.length && hits.length < 200) {
				var dir = todo.shift();
				var res = await tools().run_tool('file_list', JSON.stringify({ path: dir || '.' }));
				if (typeof res !== 'string' || /^\s*Error\b/i.test(res)) continue;
				parseListing(res).forEach(function (e) {
					if (e.name.charAt(0) === '.') return;
					var full = joinPath(dir, e.name);
					if (!dir && e.name === 'diamonds' && e.dir) return;      // Daimond's own store
					if (e.dir) { todo.push(full); return; }
					if (e.name.toLowerCase().indexOf(filter) !== -1) {
						hits.push({ name: full, dir: false, size: e.size, deep: true });
					}
				});
			}
			renderMatches(hits);
		}

		/// Filter results are paths, not names, so a hit in a subfolder is legible.
		function renderMatches(hits) {
			treeEl.innerHTML = '';
			if (!hits.length) {
				var none = document.createElement('div');
				none.className = 'files-empty';
				none.textContent = t('files.no_match', { filter: filter });
				treeEl.appendChild(none);
				return;
			}
			hits.sort(function (a, b) { return a.name.localeCompare(b.name); });
			hits.forEach(function (e) {
				var row = document.createElement('div');
				row.className = 'files-row';
				var ic = document.createElement('span'); ic.className = 'files-ic'; ic.textContent = '📄';
				var nm = document.createElement('span'); nm.className = 'files-name'; nm.textContent = e.name;
				row.appendChild(ic); row.appendChild(nm);
				row.addEventListener('click', function () { openFile(e.name); });
				treeEl.appendChild(row);
			});
		}

		// ── This Diamond's workspace ───────────────────────────────
		//
		// Two trees, one panel. "Everything" is the workspace as it has always
		// been. "This Diamond" is the set of paths the open Diamond's daimon may
		// open -- its own directory, plus whatever the user has attached -- and
		// nothing else, which is the same set the tool door enforces.
		//
		// An attachment is a LINK, so everything here adds or removes one. The
		// file stays where it is either way: detaching narrows what a daimon can
		// reach and touches nothing on disk.

		/// What is in the open Diamond's workspace, besides its own directory.
		///
		/// Read from the Diamond's links: `file:` and `dir:` ends are paths in
		/// the workspace, and everything else (another Diamond, a URL, a chat) is
		/// not a place. Anything already inside the Diamond's own directory is
		/// dropped, because that directory is listed in full anyway and a thing
		/// shown twice reads as two things.
		async function loadAttached() {
			attached = await attachmentsOf(currentDiamond ? currentDiamond.id : '');
			labelAttached(attached);
			return attached;
		}

		/// The same, for ANY Diamond rather than the one on screen.
		///
		/// Split out of `loadAttached` because a dispatched worker is scoped to the Diamond it
		/// works for, which is not always the Diamond the user is looking at — and a scope read
		/// from `currentDiamond` would confine a worker to whichever Diamond happened to be open
		/// when it started. It touches no module state, so asking about another Diamond cannot
		/// repaint this panel.
		///
		/// # Arguments
		/// * `id` - The Diamond, or '' for none.
		async function attachmentsOf(id) {
			var out = [];
			if (!id) return out;
			var links = [];
			try {
				links = JSON.parse(await diamondApp().links_touching('diamond:' + id) || '[]');
			} catch (e) { return out; }
			var own = 'diamonds/' + id, seen = {};
			links.forEach(function (l) {
				var ref = l.other || '';
				var i = ref.indexOf(':');
				if (i <= 0) return;
				var kind = ref.slice(0, i), path = ref.slice(i + 1).trim();
				if ((kind !== 'file' && kind !== 'dir') || !path) return;
				if (underPath(path, own)) return;
				if (seen[ref]) return;
				seen[ref] = 1;
				out.push({
					link: l,
					ref:  ref,
					path: path,
					dir:  kind === 'dir',
					// Attached to be consulted rather than worked on. The tool door
					// spells this as an allow plus a write fence; here it is a badge.
					ro:   l.rel === 'consulted',
				});
			});
			out.sort(function (a, b) { return a.path.localeCompare(b.path); });
			return out;
		}

		/// The last `n` segments of a path.
		function tailOf(p, n) {
			var parts = p.split('/').filter(Boolean);
			return parts.slice(Math.max(0, parts.length - n)).join('/');
		}

		/// Give each attachment the shortest name that tells it from the others.
		///
		/// Two folders called `notes` are the ordinary case, not the exotic one --
		/// `a/notes` and `b/notes` are exactly what a person attaches -- and a
		/// tree with two rows both reading "notes" is a tree that cannot be used.
		/// So a basename is kept while it is unique and grown by whole segments
		/// until it is not shared.
		function labelAttached(items) {
			var groups = {};
			items.forEach(function (a) {
				a.base = tailOf(a.path, 1) || a.path;
				(groups[a.base] = groups[a.base] || []).push(a);
			});
			Object.keys(groups).forEach(function (b) {
				var grp = groups[b];
				if (grp.length === 1) { grp[0].label = grp[0].base; return; }
				var n = 2;
				while (n < 24) {
					var seen = {}, clash = false;
					grp.forEach(function (a) {
						var s = tailOf(a.path, n);
						if (seen[s]) clash = true;
						seen[s] = 1;
					});
					if (!clash) break;
					n++;
				}
				grp.forEach(function (a) { a.label = tailOf(a.path, n); });
			});
		}

		/// The attachment record for a reference, or nothing.
		function attachedOf(ref) {
			for (var i = 0; i < attached.length; i++) if (attached[i].ref === ref) return attached[i];
			return null;
		}

		/// Put a folder into the open Diamond's workspace, or take it out again.
		///
		/// Taking it out removes the link and NOTHING else: the folder and every
		/// file in it stay exactly where they are, and any other Diamond holding
		/// the same folder goes on holding it.
		async function toggleDirHold(path) {
			if (!currentDiamond) return;
			var id = currentDiamond.id, ref = 'dir:' + path;
			var rec = attachedOf(ref);
			var link = rec ? rec.link : await linkTo(id, ref);
			try {
				if (link) await diamondApp().remove_link(link.owner, link.id);
				else await diamondApp().add_link(id, 'diamond:' + id, ref, 'holds', '', 'user');
			} catch (e) { /* already gone, or already there: the repaint tells the truth */ }
			// One signal, and everything that draws links redraws: this tree through
			// refreshAttached, the strip above the steer box, and the graph.
			signalLinksChanged();
		}

		/// Reload the attachment set and repaint whatever is on screen for it.
		async function refreshAttached() {
			await loadAttached();
			if (!listed || curFile) return;
			if (diamondScope()) { await list(curDir); return; }
			if (!filter) renderTree(lastEntries);
		}

		/// The two trees, offered as a row of chips above the path.
		///
		/// Hidden entirely when no Diamond is open: there is then only one tree,
		/// and a switch with one position is furniture.
		function renderScope() {
			if (!scopeEl) return;
			scopeEl.innerHTML = '';
			if (!currentDiamond) { scopeEl.style.display = 'none'; return; }
			scopeEl.style.display = '';
			scopeEl.appendChild(scopeChip('all', t('dws.mode_all'), t('dws.mode_all')));
			scopeEl.appendChild(scopeChip('diamond', t('dws.mode_diamond'), currentDiamond.name));
			renderKits();
		}

		/// The toolchains this build can grant, in the order they are offered.
		///
		/// The same five names `Toolkit::all` gives, and they are names rather than labels
		/// because the name is what is STORED and what reaches `Toolkit::parse`. The label is
		/// only ever how it is written on a button.
		var KITS = [
			{ name: 'rust',   label: 'Rust' },
			{ name: 'node',   label: 'Node' },
			{ name: 'python', label: 'Python' },
			{ name: 'go',     label: 'Go' },
			// Not cosmetic, and the odd one out: `git` itself is already reachable, so
			// what this grants is the user's own configuration -- their name, their
			// email, and `core.hooksPath`. Without it a fenced git runs with NO hooks,
			// and an unreadable hooks directory is indistinguishable from an empty one,
			// so the credential-scanning pre-commit hook silently does not run.
			{ name: 'git',    label: 'Git' },
		];

		/// Draw the toolchain grants for the open Diamond.
		///
		/// Only in the Diamond tree: a grant is per Diamond, and a row of toolchain buttons over
		/// the whole workspace would be asking about something that has no answer.
		function renderKits() {
			if (!kitsEl) return;
			if (!currentDiamond || !diamondScope()) { kitsEl.style.display = 'none'; return; }
			kitsEl.style.display = '';
			kitsEl.innerHTML = '';
			var d = diamonds.find(function (x) { return x.id === currentDiamond.id; });
			var on = (d && Array.isArray(d.toolkits)) ? d.toolkits : [];
			var lab = document.createElement('span');
			lab.className = 'files-kits-label';
			lab.textContent = t('dws.kits');
			lab.title = t('dws.kits_help');
			kitsEl.appendChild(lab);
			KITS.forEach(function (k) {
				var b = document.createElement('button');
				var has = on.indexOf(k.name) >= 0;
				b.type = 'button';
				b.className = 'files-kit-chip' + (has ? ' active' : '');
				b.textContent = k.label;
				b.setAttribute('aria-pressed', has ? 'true' : 'false');
				b.title = t(has ? 'dws.kit_off' : 'dws.kit_on',
					{ kit: k.label, name: currentDiamond.name });
				b.addEventListener('click', function () { toggleKit(k.name); });
				kitsEl.appendChild(b);
			});
			if (!on.length) {
				var none = document.createElement('span');
				none.className = 'files-kits-none';
				none.textContent = t('dws.kit_none');
				kitsEl.appendChild(none);
			}
		}

		/// Grant a toolchain to the open Diamond, or take it back.
		///
		/// Written to the store first and drawn from the store afterwards, never from what was
		/// clicked: the store normalises, and a button that painted itself from the click would
		/// claim a grant the store had dropped.
		///
		/// # Arguments
		/// * `name` - The toolkit's name, as the store spells it.
		async function toggleKit(name) {
			if (!currentDiamond) return;
			var d = diamonds.find(function (x) { return x.id === currentDiamond.id; });
			var on = (d && Array.isArray(d.toolkits)) ? d.toolkits.slice() : [];
			var i = on.indexOf(name);
			if (i >= 0) on.splice(i, 1); else on.push(name);
			try {
				await diamondApp().set_toolkits(currentDiamond.id, JSON.stringify(on));
			} catch (e) {
				toast(t('dws.kit_failed') + ': ' + friendlyError(e), true);
				return;
			}
			await loadDiamonds();
			renderKits();
		}

		/// One chip in the scope row: a real button, because it changes what the
		/// panel shows rather than reporting where something is.
		function scopeChip(which, label, title) {
			var b = document.createElement('button');
			var on = (which === 'diamond') ? diamondScope() : !diamondScope();
			b.className = 'files-scope-chip' + (on ? ' active' : '');
			b.type = 'button';
			b.dataset.scope = which;
			b.textContent = (which === 'diamond' ? '◈ ' : '') + label;
			b.title = title;
			b.setAttribute('aria-pressed', on ? 'true' : 'false');
			b.addEventListener('click', function () { setScope(which); });
			return b;
		}

		/// Switch trees, remember it, and say what happened.
		///
		/// Said out loud, because the panel's contents change under the user: the
		/// same folder can be present in one tree and absent from the other, and a
		/// tree that quietly became a different tree is how a person concludes
		/// their files have gone.
		async function setScope(next) {
			if (next === scope) return;
			scope = next;
			try { localStorage.setItem(LS_SCOPE, scope); } catch (e) { /* private mode */ }
			renderScope();
			announceScope();
			await list('');
		}

		/// Name the tree now showing, in the row that switched it.
		///
		/// Beside the chips rather than in the mode row above them: this is a
		/// sentence about the switch, and a message that explains one row while
		/// sitting in another is read as being about the other.
		function announceScope() {
			if (!scopeEl) return;
			var old = scopeEl.querySelector('.files-mode-msg');
			if (old) old.remove();
			var msg = document.createElement('div');
			msg.className = 'files-mode-msg';
			msg.setAttribute('role', 'status');
			// The words are the app's; the Diamond's name is the user's own and is
			// not translated, so it is appended rather than interpolated.
			msg.textContent = diamondScope()
				? (t('dws.mode_diamond') + ' · ' + currentDiamond.name)
				: t('dws.mode_all');
			scopeEl.appendChild(msg);
		}

		/// The Diamond in focus changed. The scope row is about it, and in Diamond
		/// scope so is every row of the tree.
		///
		/// A re-read of the SAME Diamond (a sync landing, a crystal written) must
		/// not relist: the user may be three folders deep, and pulling them back
		/// to the top for a background refresh is a bug, not a refresh.
		function onDiamondChanged() {
			var id = currentDiamond ? currentDiamond.id : null;
			var same = (id === lastDiamondId);
			lastDiamondId = id;
			renderScope();
			if (same || scope !== 'diamond') return;
			announceScope();
			// Back to the top of whichever tree now applies: the directory the user
			// was in belonged to the Diamond that just left.
			curDir = '';
			loadAttached().then(function () {
				if (!listed) return;
				curFile = null;
				list('');
			});
		}

		/// Search inside this Diamond's workspace, and only inside it.
		async function filterDiamond() {
			var hits = [], roots = [ownDir()];
			attached.forEach(function (a) {
				if (a.dir) roots.push(a.path);
				else if (a.base.toLowerCase().indexOf(filter) !== -1) {
					hits.push({ name: a.path, dir: false, size: 0, deep: true });
				}
			});
			var todo = roots.slice();
			while (todo.length && hits.length < 200) {
				var dir = todo.shift();
				var res = await tools().run_tool('file_list', JSON.stringify({ path: dir || '.' }));
				if (typeof res !== 'string' || /^\s*Error\b/i.test(res)) continue;
				parseListing(res).forEach(function (e) {
					if (e.name.charAt(0) === '.') return;
					var full = joinPath(dir, e.name);
					if (e.dir) { todo.push(full); return; }
					if (e.name.toLowerCase().indexOf(filter) !== -1) {
						hits.push({ name: full, dir: false, size: e.size, deep: true });
					}
				});
			}
			renderMatches(hits);
		}

		/// This Diamond's workspace, as a tree.
		///
		/// At the top it is a composed view -- the Diamond's own directory listed
		/// in full, then each attachment at its own name -- and below that it is an
		/// ordinary listing of whichever real directory was opened.
		async function listDiamond(dir) {
			curDir = dir || '';
			curFile = null; listed = true;
			viewEl.style.display = 'none'; docEmbed(false);
			await loadAttached();
			if (curDir) {
				pathEl.textContent = '/' + curDir;
				var res = await tools().run_tool('file_list', JSON.stringify({ path: curDir }));
				if (typeof res === 'string' && res.indexOf('Error') === 0) {
					treeEl.innerHTML = '';
					var err = document.createElement('div');
					err.className = 'files-empty';
					err.textContent = friendlyError(res);
					treeEl.appendChild(err);
					return;
				}
				renderTree(parseListing(res));
				refreshResidency();
				return;
			}
			// The composed root. The path line names it rather than showing "/",
			// which would be a lie: this is not a directory.
			pathEl.textContent = t('dws.title');
			treeEl.innerHTML = '';
			var own = ownDir();
			var entries = [];
			var lres = await tools().run_tool('file_list', JSON.stringify({ path: own }));
			if (typeof lres === 'string' && lres.indexOf('Error') !== 0) entries = parseListing(lres);
			lastEntries = entries;
			entries = entries.filter(function (e) { return e.name.charAt(0) !== '.'; });
			entries.sort(function (a, b) { return (b.dir - a.dir) || a.name.localeCompare(b.name); });
			entries.forEach(function (e) {
				treeEl.appendChild(diamondOwnRow(e, own));
			});
			attached.forEach(function (a) { treeEl.appendChild(attachedRow(a)); });
			if (!entries.length && !attached.length) {
				var none = document.createElement('div');
				none.className = 'files-empty';
				none.textContent = t('dws.empty');
				treeEl.appendChild(none);
			} else if (!attached.length) {
				var hint = document.createElement('div');
				hint.className = 'files-empty files-dws-hint';
				hint.textContent = t('dws.empty');
				treeEl.appendChild(hint);
			}
			refreshResidency();
		}

		/// A row for something in the Diamond's own directory: a real file in a
		/// real place, with the ordinary file controls.
		function diamondOwnRow(e, own) {
			var full = joinPath(own, e.name);
			var row = document.createElement('div');
			row.className = 'files-row' + (e.dir ? ' dir' : '') + (e.cloud ? ' cloud' : '');
			row.dataset.path = full;
			var name = document.createElement('span');
			name.className = 'files-name';
			name.textContent = (e.dir ? '📁 ' : (e.cloud ? '☁ ' : '📄 ')) + e.name;
			row.appendChild(name);
			if (!e.dir) {
				var size = document.createElement('span');
				size.className = 'files-size';
				size.textContent = fmtBytes(e.size || 0);
				row.appendChild(size);
			}
			addFileControls(row, e, full, mayManage(full));
			row.addEventListener('click', function () {
				if (e.dir) list(full);
				else if (e.cloud) fetchEntry(full, e.size || 0, true);
				else openFile(full);
			});
			return row;
		}

		/// A row for something attached from elsewhere in the workspace.
		///
		/// Named by as much of its path as it takes to tell it from the others,
		/// badged as living elsewhere, and carrying exactly one control: the one
		/// that takes it back out of this Diamond's workspace. There is no delete
		/// here on purpose -- this row is a pointer, and the thing it points at is
		/// not this Diamond's to destroy.
		function attachedRow(a) {
			var row = document.createElement('div');
			row.className = 'files-row attached' + (a.dir ? ' dir' : '') + (a.ro ? ' ro' : '');
			row.dataset.path = a.path;
			row.dataset.attached = a.dir ? 'dir' : 'file';
			row.title = a.path;
			var name = document.createElement('span');
			name.className = 'files-name';
			name.textContent = (a.dir ? '📁 ' : '📄 ') + a.label;
			row.appendChild(name);

			var away = document.createElement('span');
			away.className = 'files-badge files-elsewhere';
			away.textContent = '↗';			// it points out of this Diamond
			away.title = t('dws.elsewhere') + ' · ' + a.path;
			away.setAttribute('aria-label', t('dws.elsewhere'));
			row.appendChild(away);

			if (a.ro) {
				var ro = document.createElement('span');
				ro.className = 'files-badge files-ro';
				ro.textContent = t('dws.readonly');
				ro.title = t('dws.readonly');
				row.appendChild(ro);
			}

			var off = document.createElement('button');
			off.className = 'files-res files-hold on';
			off.textContent = '◈';
			off.dataset.act = a.dir ? 'hold-dir' : 'hold-file';
			off.title = a.dir
				? t('dws.detach_dir', { name: currentDiamond.name })
				: t('files.hold_drop', { name: currentDiamond.name });
			off.setAttribute('aria-pressed', 'true');
			off.setAttribute('aria-label', off.title);
			off.addEventListener('click', async function (ev) {
				ev.stopPropagation();
				try { await diamondApp().remove_link(a.link.owner, a.link.id); }
				catch (e) { /* already gone */ }
				signalLinksChanged();
			});
			row.appendChild(off);

			row.addEventListener('click', function () {
				if (a.dir) list(a.path); else openFile(a.path);
			});
			return row;
		}

		function bind() {
			var panel = document.getElementById('panel-work');
			if (!panel) return;
			pathEl = panel.querySelector('.files-path');
			treeEl = panel.querySelector('.files-tree');
			// The document view is NOT in this panel. Workspace is the filing
			// cabinet -- a tree you browse -- and a document you have opened is
			// something you are attending to, which belongs on the stage beside
			// the daimon. So the viewer renders into the Doc panel, and the tree
			// stays put behind it instead of being hidden to make room.
			viewEl = document.getElementById('doc-view');
			// The line-number toggle belongs to the document, so it is wired here
			// where the view's own state is, and not with the panel's furniture.
			var lnBtn = document.getElementById('doc-lineno');
			if (lnBtn) lnBtn.addEventListener('click', function () {
				showLineNos = !showLineNos;
				try { localStorage.setItem('daimond-files-lineno', showLineNos ? '1' : '0'); }
				catch (e) { /* private mode: it holds for this session only */ }
				renderFileBody();
			});
			modeEl = panel.querySelector('.files-mode');
			// The scope row is its own row, under the one that says where the
			// workspace is: those chips name a PLACE (the sandbox, a folder on this
			// disk, cloud storage) and these name WHOSE files are being shown, which
			// is a different question and was never asked before.
			scopeEl = panel.querySelector('.files-scope');
			if (!scopeEl) {
				scopeEl = document.createElement('div');
				scopeEl.className = 'files-scope';
				scopeEl.style.display = 'none';
				modeEl.parentNode.insertBefore(scopeEl, modeEl.nextSibling);
			}
			// The toolchain grants, under the scope row and above the tree. It belongs in
			// this panel and nowhere else: this is where a person says what a Diamond may
			// reach, and a toolchain is one more thing it may reach — the only one that is
			// not a folder in the workspace.
			kitsEl = panel.querySelector('.files-kits');
			if (!kitsEl) {
				kitsEl = document.createElement('div');
				kitsEl.className = 'files-kits';
				kitsEl.style.display = 'none';
				scopeEl.parentNode.insertBefore(kitsEl, scopeEl.nextSibling);
			}
			panel.querySelector('[data-act="refresh"]').addEventListener('click', function () { list(curDir); });
			var newBtn = panel.querySelector('[data-act="new-file"]');
			if (newBtn) newBtn.addEventListener('click', newFile);
			var dirBtn = panel.querySelector('[data-act="new-dir"]');
			if (dirBtn) dirBtn.addEventListener('click', newDir);
			var upBtn = panel.querySelector('[data-act="upload"]');
			if (upBtn) upBtn.addEventListener('click', uploadFiles);
			var chip = document.getElementById('instructions-chip');
			if (chip) chip.addEventListener('click', function () { openFile(INSTRUCTIONS_FILE); });
			filterEl = panel.querySelector('.files-filter-input');
			if (filterEl) filterEl.addEventListener('input', function () {
				filter = filterEl.value.trim().toLowerCase();
				clearTimeout(filterTimer);
				filterTimer = setTimeout(applyFilter, 180);
			});
			// "Open a folder" is not bound here: it lives in the mode row, beside the chip that
			// says which files the agent is touching (see renderMode).
			panel.querySelector('[data-act="up"]').addEventListener('click', function () {
				if (curFile) { closeView(); return; }
				if (!curDir) return;
				var parts = curDir.split('/').filter(Boolean); parts.pop();
				var up = parts.join('/');
				// Going up out of a Diamond's workspace lands back at the workspace
				// itself, not at whatever directory happens to be above: the tree
				// there shows a set of paths, and the parent of one of them is very
				// often somewhere the daimon may not go.
				if (diamondScope() && !withinDiamond(up)) { list(''); return; }
				list(up);
			});
			// The scope row is about the open Diamond, and in Diamond scope so is
			// every row of the tree; attaching or detaching changes what is in it.
			document.addEventListener('daimond-diamond-changed', onDiamondChanged);
			document.addEventListener('daimond-links-changed', refreshAttached);
			lastDiamondId = currentDiamond ? currentDiamond.id : null;
			renderScope();
			renderMode();
		}

		/// Whether a directory is one the open Diamond's workspace reaches: its own
		/// directory, or at or below something attached.
		function withinDiamond(p) {
			if (!p) return false;
			if (underPath(p, ownDir()) && p !== ownDir()) return true;
			for (var i = 0; i < attached.length; i++) {
				if (attached[i].dir && underPath(p, attached[i].path)) return true;
			}
			return false;
		}

		// ── FSA real-folder mode ───────────────────────────────────
		// The OPFS root and an FSA folder are both a FileSystemDirectory-
		// Handle with the same interface, so "open a real folder" simply
		// swaps the root handle the file tools resolve against (in wasm).
		// Diamond/crystal/`.daimond` storage pins OPFS and is never affected.

		// ── Transfers ──────────────────────────────────────────────
		// Moving files in or out never changes where the agent works. A directory
		// handle can be read or written without being promoted to the workspace
		// root, so importing and exporting are ordinary verbs rather than a mode
		// switch — which also makes the consequence explicit: what you import
		// starts syncing, and one day starts costing.

		/// The root the workspace ACTUALLY is: the open real folder, or this
		/// account's OPFS sandbox when there is none.
		///
		/// Both transfers below reach the workspace twice — the export lists it and
		/// then reads its bytes, the import writes into it — and the two reaches
		/// have to arrive at the same directory. They did not: the listing went
		/// through `file_list`, which resolves the real-folder override inside the
		/// wasm, while the bytes went through `DaimondCloud`, which is OPFS and
		/// nothing else. With a folder open that is two different places, so a
		/// "Save a copy" listed the user's real files, looked for them in a sandbox
		/// that had never held them, and wrote an EMPTY copy without failing;
		/// an import put the files where the agent could not see them.
		///
		/// Streamed rather than routed through the wasm `write_bytes`, which would
		/// also be correct: a folder import is whole files of any size, and this
		/// way none of them is ever held in memory at once.
		async function wsRoot() {
			return folderHandle || await DaimondCloud.opfsRoot();
		}

		function pathParts(path) {
			return String(path).split('/').filter(function (x) { return x && x !== '.' && x !== '..'; });
		}

		/// The `File` at a workspace-relative path, or null when it is not there.
		async function wsFileAt(path) {
			var p = pathParts(path);
			if (!p.length) return null;
			var dir = await wsRoot();
			try {
				for (var i = 0; i < p.length - 1; i++) dir = await dir.getDirectoryHandle(p[i]);
				return await (await dir.getFileHandle(p[p.length - 1])).getFile();
			} catch (e) { return null; }
		}

		/// Write a Blob to a workspace-relative path, creating folders as needed.
		async function wsWriteBlob(path, blob) {
			var p = pathParts(path);
			if (!p.length) throw new Error('Empty path.');
			var dir = await wsRoot();
			for (var i = 0; i < p.length - 1; i++) {
				dir = await dir.getDirectoryHandle(p[i], { create: true });
			}
			var fh = await dir.getFileHandle(p[p.length - 1], { create: true });
			var w = await fh.createWritable();
			await w.write(blob);
			await w.close();
		}

		/// Copy a folder from this machine into the workspace.
		async function importFolder() {
			if (typeof window.showDirectoryPicker !== 'function') {
				showModeMsg('Importing a folder needs a Chromium-based browser.', true); return;
			}
			var handle;
			try { handle = await window.showDirectoryPicker({ mode: 'read' }); }
			catch (e) { if (!(e && e.name === 'AbortError')) showModeMsg(t('files.folder_open_failed'), true); return; }
			if (!await confirmDialog(
				t('files.import_body', { name: handle.name }), t('files.import'))) return;

			var app; try { app = tools(); } catch (e) { return; }
			var copied = 0, skipped = 0;
			async function walk(dir, prefix) {
				for await (var ent of dir.entries()) {
					var nm = ent[0], h = ent[1];
					if (nm.charAt(0) === '.') continue;
					var rel = prefix ? prefix + '/' + nm : nm;
					if (h.kind === 'directory') { await walk(h, rel); continue; }
					var src;
					try { src = await h.getFile(); }
					catch (e2) { skipped++; continue; }
					showModeMsg('Importing ' + rel + '\u2026');
					// The bytes, whatever they are, into the root the agent is on. A
					// picture imports as a picture; only the sync layer decides later
					// whether it rides inline or as chunks.
					try { await wsWriteBlob(joinPath(handle.name, rel), src); copied++; }
					catch (e3) { skipped++; }
				}
			}
			try { await walk(handle, ''); }
			catch (e) { showModeMsg('Import stopped: ' + (e && e.message ? e.message : e), true); }
			showModeMsg('Imported ' + copied + ' files into "' + handle.name + '"' +
				(skipped ? ('; skipped ' + skipped + ' (binary or unreadable).') : '.'));
			list(curDir);
			try { DaimondSync.nudge(); } catch (e) { /* sync is not up */ }
		}

		/// Write the workspace out to a folder on this machine.
		async function exportFolder() {
			if (typeof window.showDirectoryPicker !== 'function') {
				showModeMsg('Saving a copy needs a Chromium-based browser.', true); return;
			}
			var dest;
			try { dest = await window.showDirectoryPicker({ mode: 'readwrite' }); }
			catch (e) { if (!(e && e.name === 'AbortError')) showModeMsg('Could not open that folder.', true); return; }
			var app; try { app = tools(); } catch (e) { return; }
			var wrote = 0, away = 0;
			async function out(dir, rel) {
				var res;
				try { res = await app.run_tool('file_list', JSON.stringify({ path: rel || '.' })); }
				catch (e) { return; }
				if (typeof res !== 'string' || /^\s*Error\b/i.test(res)) return;
				var entries = parseListing(res);
				for (var i = 0; i < entries.length; i++) {
					var e = entries[i];
					if (e.name.charAt(0) === '.') continue;
					if (!rel && e.name === 'diamonds' && e.dir) continue;
					var full = rel ? rel + '/' + e.name : e.name;
					if (e.dir) {
						var sub = await dir.getDirectoryHandle(e.name, { create: true });
						await out(sub, full);
						continue;
					}
					// A file in cloud storage is not here to copy. Fetching every one
					// could be gigabytes and would be charged, so say so instead.
					if (e.cloud) { away++; continue; }
					// Copy the file itself, NOT its text through file_read: that tool
					// truncates at its context budget, so anything over ~60 KB would
					// land silently shortened — the one thing a "save a copy" must
					// never do — and a binary file would not survive at all. From the
					// root the listing above came from, which is not always OPFS.
					var src;
					try { src = await wsFileAt(full); }
					catch (e2) { src = null; }
					if (!src) continue;
					showModeMsg('Saving ' + full + '…');
					try {
						var fh = await dir.getFileHandle(e.name, { create: true });
						var w = await fh.createWritable();
						await w.write(src);			// the Blob itself: bytes, streamed.
						await w.close();
						wrote++;
					} catch (e3) { /* skip this one */ }
				}
			}
			try { await out(dest, ''); }
			catch (e) { showModeMsg('Save stopped: ' + (e && e.message ? e.message : e), true); }
			showModeMsg('Saved ' + wrote + ' files to "' + dest.name + '"' +
				(away ? ('; ' + away + ' are in cloud storage and were not fetched.') : '.'));
		}

		// Render the mode row: which files the agent is touching, and the ways to change that.
		//
		// The row states the root, so the controls that CHANGE the root belong in it. "Open a
		// folder" used to be an icon in the header, among New file, New folder and Upload — the
		// one control there that does not act on a file at all, which made it read as a file
		// operation and made the mode chip look like a label with no switch. State and the switch
		// that moves it now sit together, and there is one place to look.
		//
		// `reconnect` is a stored handle whose permission needs a gesture; it is offered as a
		// button and never prompted for on load.
		function renderMode(reconnect) {
			if (!modeEl) return;
			modeEl.innerHTML = '';
			var onMachine = !!folderHandle;
			var canPick   = (typeof window.showDirectoryPicker === 'function');

			// Browser — the in-app sandbox. What syncs, and what cloud storage backs.
			modeEl.appendChild(modeChip('browser', t('files.mode_browser'), !onMachine,
				onMachine
					? t('files.browser_switch')
					: t('files.browser_help'),
				onMachine ? switchToOpfs : showBrowserInfo));

			// Machine — a real folder on this disk. A genuine alternative root, and
			// mutually exclusive with the sandbox: the agent has exactly one.
			//
			// Three things this chip can be, and it used to be only the third:
			//
			//   * a RECONNECT offer, when a stored grant needs a gesture (a boot, or a grant the
			//     browser withdrew mid-session);
			//   * the way BACK to a folder this session has already used, which needs no picker
			//     at all -- query the grant, request it if it has lapsed, done;
			//   * the FIRST-EVER use, which is the only case that needs a folder chosen.
			//
			// Calling the picker unconditionally collapsed the middle case into the last one, so
			// every return trip cost a native dialog.
			var machineChip = modeChip('machine',
				onMachine ? folderHandle.name : (rootHandle ? rootHandle.name : t('files.mode_machine')),
				onMachine,
				canPick
					? (onMachine
						? t('files.machine_here')
						: (rootHandle
							? t('files.machine_return', { name: rootHandle.name })
							: t('files.machine_pick')))
					: t('files.machine_needs_chromium'),
				!canPick ? null
					: (reconnect ? function () { reconnectFolder(reconnect); }
						: onMachine ? showMachineInfo
						: rootHandle ? function () { reconnectFolder(rootHandle); }
						: openFolder));
			if (!canPick) machineChip.classList.add('ghost');
			if (reconnect) setChip(machineChip, 'machine', t('files.machine_reconnect', { name: reconnect.name }));
			modeEl.appendChild(machineChip);

			// Cloud — not a place but a residency: where the browser workspace's
			// bytes live. A real folder is the user's own disk and has none.
			var cloudChip = modeChip('cloud', t('files.mode_cloud'), false,
				onMachine
					? t('files.cloud_on_machine')
					: t('files.cloud_help'),
				onMachine ? null : showCloudView);
			cloudChip.classList.add('ghost');
			modeEl.appendChild(cloudChip);
			// Held so the chip can be repainted when residency changes, without
			// rebuilding the row and losing a pending reconnect offer.
			cloudChipEl = onMachine ? null : cloudChip;
			if (!onMachine) paintCloudChip(cloudChip);

			// The two transfers, which never change where the agent works: a
			// handle can be read or written without becoming the root.
			if (canPick && !onMachine) {
				modeEl.appendChild(modeBtn(t('files.import_folder'),
					t('files.import_folder_help'), importFolder));
				modeEl.appendChild(modeBtn(t('files.save_copy'),
					t('files.save_copy_help'), exportFolder));
			}
			// Choosing a DIFFERENT folder is now the only thing that opens a picker, so it needs
			// somewhere to live. It belongs here, next to the chip that names the folder it would
			// replace, and only while there is one to replace.
			if (canPick && onMachine) {
				modeEl.appendChild(modeBtn(t('files.change_root'), t('files.change_root_help'), openFolder));
			}
			modeChanged();
		}

		/// Repaint the Cloud chip's numbers in place. Residency changes under the
		/// user's feet — a sync lands, a fetch completes, space is reclaimed — and
		/// a chip that still reads the old total is simply wrong.
		function refreshResidency() {
			if (cloudChipEl) paintCloudChip(cloudChipEl);
		}

		/// Fill in the Cloud chip's real numbers, and lift it out of ghosting when
		/// cloud storage actually holds something.
		async function paintCloudChip(chip) {
			if (!window.DaimondCloud) return;
			chip.classList.add('ghost');
			chip.classList.remove('cloud');
			setChip(chip, 'cloud', t('files.cloud'));
			var s;
			try { s = await DaimondCloud.summary(); } catch (e) { return; }
			if (!s.files) {
				chip.title = t(DaimondCloud.available() ? 'files.cloud_empty' : 'files.cloud_locked');
				return;
			}
			chip.classList.remove('ghost');
			chip.classList.add('cloud');
			setChip(chip, 'cloud', fmtBytes(s.bytes));
			chip.title = s.awayFiles
				? t('files.cloud_some_away', { n: s.files, away: s.awayFiles })
				: t('files.cloud_all_here', { n: s.files });
		}

		/// The mode row's glyphs, in the toolbar's idiom: 24-unit outlines stroked
		/// in `currentColor`, not emoji. Emoji are a second typeface with its own
		/// colours, weight and vertical rhythm, and three of them sat in a row of
		/// controls drawn entirely in thin outline.
		var MODE_ICONS = {
			browser: '<rect x="3" y="4.5" width="18" height="6" rx="1.5"/>'
				+ '<rect x="3" y="13.5" width="18" height="6" rx="1.5"/>'
				+ '<path d="M6.75 7.5h.01M6.75 16.5h.01"/>',
			machine: '<rect x="3.5" y="5" width="17" height="11" rx="1.5"/><path d="M2 19h20"/>',
			cloud:   '<path d="M7.2 18.5h9.3a4.2 4.2 0 00.5-8.37 6.2 6.2 0 00-11.75-1.4A3.7 3.7 0 007.2 18.5z"/>',
		};

		/// Give a chip its glyph and its words together.
		///
		/// One call, because they are one thing: setting `textContent` on a chip
		/// that carries an icon silently deletes the icon, which is how the row
		/// came to lose its glyphs whenever a folder was reconnected or the cloud
		/// total was repainted. The label goes in as a text node, never as markup —
		/// it can be a folder name off the user's disk.
		function setChip(chip, icon, label) {
			chip.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">'
				+ (MODE_ICONS[icon] || '') + '</svg>';
			chip.appendChild(document.createTextNode(label));
		}

		/// One chip in the mode row. A chip states where things are; clicking it
		/// opens that location's controls rather than toggling a mode.
		function modeChip(icon, label, active, title, onClick) {
			var c = document.createElement('span');
			c.className = 'files-mode-chip' + (active ? ' active' : '');
			setChip(c, icon, label);
			c.title = title;
			if (onClick) {
				c.classList.add('act');
				c.setAttribute('role', 'button');
				c.setAttribute('tabindex', '0');
				c.addEventListener('click', onClick);
				c.addEventListener('keydown', function (ev) {
					if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onClick(); }
				});
			}
			return c;
		}

		/// Cloud storage, in full: what is held, what it is costing, what is not on
		/// this device, and the way to pay for more. Rendered on the stage rather
		/// than in a popup, because it is something to read, not to dismiss.
		///
		/// This doubles as the billing disclosure. Accounts here are keys with no
		/// address, so there is no way to send someone a statement — the only
		/// honest place to say what is stored and what it costs is where they can
		/// see it, in the app.
		async function showCloudView() {
			if (!window.DaimondCloud) return;
			curFile = null;
			docEmbed(false);
			viewEl.style.display = '';
			var s  = await DaimondCloud.summary();
			var ix = DaimondCloud.index();
			var away = DaimondCloud.awayPaths();
			var paths = Object.keys(ix).sort(function (a, b) { return (ix[b].size | 0) - (ix[a].size | 0); });

			viewEl.innerHTML =
				'<div class="files-view-head">' +
				'  <span class="files-view-name">☁ ' + esc(t('files.cloud_storage')) + '</span>' +
				'  <span>' +
				'    <button class="files-btn" data-act="cloud-reclaim" title="' + esc(t('files.reclaim_help')) + '">'
					+ esc(t('files.reclaim')) + '</button>' +
				'    <button class="files-btn" data-act="cloud-credits">' + esc(t('drawer.credits')) + '</button>' +
				'    <button class="files-btn" data-act="back">← ' + esc(t('files.back')) + '</button>' +
				'  </span>' +
				'</div>' +
				'<div class="files-view-body cloud-view"></div>';

			var body = viewEl.querySelector('.cloud-view');
			var intro = document.createElement('p');
			intro.className = 'cloud-intro';
			intro.textContent = s.files
				? (t('files.cloud_intro', { n: s.files, total: fmtBytes(s.bytes) }) + ' '
					+ (s.awayFiles
						? t('files.cloud_away', { n: s.awayFiles, bytes: fmtBytes(s.awayBytes) })
						: t('files.cloud_here')))
				: (s.quota
					? t('files.cloud_none_quota', { quota: fmtBytes(s.quota) })
					: t('files.cloud_none'));
			body.appendChild(intro);

			if (s.quota) {
				var bar = document.createElement('div');
				bar.className = 'cloud-bar';
				var fill = document.createElement('span');
				fill.style.width = Math.min(100, Math.round(s.ratio * 100)) + '%';
				if (s.ratio >= 0.85) fill.className = 'hot';
				bar.appendChild(fill);
				body.appendChild(bar);
				var cap = document.createElement('p');
				cap.className = 'cloud-cap';
				cap.textContent = t('files.cloud_cap',
					{ quota: fmtBytes(s.quota), used: fmtBytes(s.usage) });
				body.appendChild(cap);
			}

			paths.forEach(function (p) {
				var isAway = Object.prototype.hasOwnProperty.call(away, p);
				var r = document.createElement('div');
				r.className = 'cloud-row' + (isAway ? ' away' : '');
				var n = document.createElement('span');
				n.className = 'cloud-path';
				n.textContent = (isAway ? '☁ ' : '📄 ') + p;
				var z = document.createElement('span');
				z.className = 'cloud-size';
				z.textContent = fmtBytes(ix[p].size | 0);
				r.appendChild(n); r.appendChild(z);
				if (DaimondCloud.isPinned(p)) {
					var pin = document.createElement('span');
					pin.className = 'cloud-pin'; pin.textContent = '📌'; pin.title = t('files.pinned_short');
					r.appendChild(pin);
				}
				body.appendChild(r);
			});

			// Awaited: closing may now ask before discarding an unsaved edit, and
			// re-listing the folder behind a question the user has not answered
			// would pull the view out from under it.
			viewEl.querySelector('[data-act="back"]').addEventListener('click', async function () {
				await closeView();
				list(curDir);
			});
			viewEl.querySelector('[data-act="cloud-credits"]').addEventListener('click', function () {
				try {
					DaimondAdmin.credits('Cloud storage is paid for with credits, like everything else ' +
						'that leaves your browser.');
				} catch (e) { /* the panel is not up */ }
			});
			viewEl.querySelector('[data-act="cloud-reclaim"]').addEventListener('click', async function () {
				var r = await DaimondCloud.reclaim(true);
				showModeMsg(r.evicted.length
					? ('Freed ' + fmtBytes(r.freed) + ' from ' + r.evicted.length + ' files; they stay in cloud storage.')
					: 'Nothing to free — everything here is either pinned or not in cloud storage.');
				showCloudView();
			});
		}

		/// What the browser has granted this workspace, which is the ceiling when
		/// there is no cloud storage.
		async function showBrowserInfo() {
			if (!window.DaimondCloud) return;
			var p = await DaimondCloud.pressure();
			showModeMsg(p.quota
				? ('This browser has granted ' + fmtBytes(p.quota) + ', of which ' +
					fmtBytes(p.usage) + ' is used.')
				: 'This browser does not report how much storage it has granted.');
		}

		/// What the agent can reach on this disk, and how to stop it reaching there.
		///
		/// The Machine chip, while it is the active one, used to re-open the folder picker. That
		/// is the least useful thing it could do from a folder that is already open, and it left
		/// the root's SCOPE unstated -- which is the one fact a person needs before pointing an
		/// agent at a directory on their own machine. Mirrors showBrowserInfo: the active chip
		/// says what this location is, and the row beside it carries the acts.
		function showMachineInfo() {
			if (!folderHandle) return;
			// A second click on the chip must not stack a second Forget button.
			var old = modeEl.querySelector('.files-mode-forget');
			if (old) old.remove();
			showModeMsg(t('files.machine_scope', { name: folderHandle.name }));
			// Forgetting the folder was a side effect of switching to the sandbox until that stopped
			// deleting the record. Without a deliberate control there would now be NO way to make
			// Daimond forget a folder, which is worse than the dialog the change removed.
			var forget = modeBtn(t('files.forget_root'), t('files.forget_root_help'), async function () {
				try { await FsaDB.clear(); } catch (e) { /* nothing stored */ }
				rootHandle = null;
				renderMode();
				showModeMsg(t('files.root_forgotten'));
			});
			forget.classList.add('files-mode-forget');
			modeEl.appendChild(forget);
		}

		/// The status rows report which files the agent is touching, so they are stale the moment
		/// this row is redrawn — opening a folder, closing it, or losing it all pass through here.
		function modeChanged() {
			try { DaimondAdmin.status(); } catch (e) { /* the panel is not up yet */ }
		}

		/// One control in the mode row.
		function modeBtn(text, title, onClick, accent) {
			var b = document.createElement('button');
			b.className = 'files-mode-btn' + (accent ? ' accent' : '');
			b.textContent = text;
			b.title = title;
			b.addEventListener('click', onClick);
			return b;
		}

		// A transient note in the mode bar (errors, guidance).
		function showModeMsg(text, isErr) {
			if (!modeEl) return;
			var old = modeEl.querySelector('.files-mode-msg');
			if (old) old.remove();
			var msg = document.createElement('div');
			msg.className = 'files-mode-msg' + (isErr ? ' err' : '');
			msg.textContent = stripAnsi(text);      // escaped, and free of terminal codes
			modeEl.appendChild(msg);
		}

		// Query, then (if needed) request read/write permission on a
		// handle, returning the final permission state.
		async function ensurePermission(handle) {
			try {
				var opts = { mode: 'readwrite' };
				if ((await handle.queryPermission(opts)) === 'granted') return 'granted';
				return await handle.requestPermission(opts);
			} catch (e) { return 'denied'; }
		}

		// "Open folder": pick a real directory, grant read/write, and make
		// it the workspace root.  Degrades cleanly off Chromium.
		/// Changing the root swaps the workspace out from under whatever is
		/// running: the agent resolves every path against one root, so a switch
		/// mid-turn leaves it reading and writing somewhere else entirely. It
		/// used to happen silently.
		function rootSwitchBlocked() {
			var busy = false;
			try { busy = !!(window.DaimondCore && DaimondCore.busy()); } catch (e) { busy = false; }
			if (busy) {
				showModeMsg('The agent is working. Wait for it to finish before changing where it works.', true);
			}
			return busy;
		}

		async function openFolder() {
			if (rootSwitchBlocked()) return;
			if (typeof window.showDirectoryPicker !== 'function') {
				showModeMsg('Real-folder mode needs a Chromium-based browser. Staying on OPFS.', true);
				return;
			}
			var handle;
			try {
				// `id` gives this picker its own remembered location, so choosing a workspace does
				// not move where an unrelated save dialog opens. `startIn` puts it where the user
				// already is: a "Change folder…" that opened in Documents, three levels from the
				// project they are in, is a dialog they have to navigate every time.
				handle = await window.showDirectoryPicker({
					mode:    'readwrite',
					id:      'daimond-workspace',
					startIn: rootHandle || 'documents',
				});
			} catch (e) {
				if (e && e.name === 'AbortError') return;   // user cancelled
				showModeMsg('Could not open folder: ' + (e && e.message ? e.message : e), true);
				return;
			}
			if ((await ensurePermission(handle)) !== 'granted') {
				showModeMsg('Read/write permission was not granted. Staying on OPFS.', true);
				return;
			}
			await activateFolder(handle, true);
		}

		// Point the wasm file tools at `handle`, mirror the UI, re-read the rules from
		// the root that is now active, optionally persist the handle for reconnect, and
		// refresh the tree.
		async function activateFolder(handle, persist) {
			try {
				set_workspace_dir(handle);
			} catch (e) {
				showModeMsg('Failed to switch to the folder: ' + (e && e.message ? e.message : e), true);
				return;
			}
			folderHandle = handle;
			rootHandle = handle;            // the folder to offer after a trip to the sandbox
			if (persist) { try { await FsaDB.save(handle); } catch (e) { /* non-fatal */ } }
			renderMode();
			await rereadRootRules();
			await adoptFolderDiamonds();
			list('');
		}

		/// Re-read `DAIMOND.md` and the role prompts, because the root they are read from
		/// has just moved.
		///
		/// Both are loaded from the ACTIVE workspace root, and nothing on the switch path
		/// re-read them: the first turn after a switch ran on the other root's rules while
		/// the chip in the Workspace head named a file it was no longer reading. Every
		/// other trigger is downstream of that turn -- the pair is refreshed when a turn
		/// ENDS, on a save of one of those paths, and on a full redraw -- so the one turn
		/// that was wrong was the one nobody could see was wrong.
		///
		/// AWAITED, and before anything else the switch does. `Instructions.refresh` drops
		/// each chat's built agent so the next turn composes a fresh system prompt, and a
		/// turn started while this was still in flight would compose the old one. It runs
		/// ahead of `adoptFolderDiamonds` for the same reason: adoption can put a dialog
		/// on screen and wait for the user to read it.
		///
		/// Both are idempotent -- each re-reads, compares, and does nothing when nothing
		/// changed -- so running on every activation, boot reconnect included, costs two
		/// file reads and no redraw. They are run together because neither touches what
		/// the other reads, and `run_tool` takes `&self`, so two calls into the one wasm
		/// app are not a borrow conflict.
		///
		/// NOT called from `handlePermissionLoss`, which is the third way the root moves.
		/// That one fires from inside a running turn -- the wasm raises it when a tool call
		/// meets a withdrawn grant -- and `Instructions.refresh` nulls `chat.app`, which is
		/// what Stop and interject read. Trading a working Stop for rules that the end of
		/// that same turn refreshes anyway is the wrong way round.
		async function rereadRootRules() {
			try { await Promise.all([Instructions.refresh(), Prompts.refresh()]); }
			catch (e) { /* an unreadable root has no rules, which is what refresh records */ }
		}

		/// Bring home any Diamond files this folder is holding, and say so.
		///
		/// A build before this one let Daimond's own store follow the workspace root, so a
		/// Diamond worked on with a folder open wrote `diamonds/<id>/…` into the user's project:
		/// outside the sync parcel, and gone from view the moment they switched back. The engine
		/// copies those files into the store — never deleting, never overwriting — and this
		/// reports what it did. It runs on every activation, boot reconnect included, so it is
		/// silent when there was nothing to bring home.
		///
		/// The folder's copies are LEFT WHERE THEY ARE, and the user is told that too. Deleting
		/// from someone's own project folder to tidy up after our bug is the more dangerous of
		/// the two mistakes available here.
		///
		/// AND WHAT DID NOT COME. The engine copies under a budget -- 8 MiB for one file,
		/// 64 MiB for one run -- and puts everything past it, along with anything it could
		/// not read, into `skipped`. This read only `adopted` and `kept`, so a Diamond whose
		/// big file was left behind was adopted WITHOUT IT and announced as though whole,
		/// and a run that took nothing and skipped everything returned before saying a word.
		/// This is a migration that runs once over data the user has held since seq 63, and
		/// the one thing it must not do is leave them believing it brought everything.
		async function adoptFolderDiamonds() {
			if (!Wasm || typeof Wasm.adopt_folder_diamonds !== 'function') return;
			var rep;
			try { rep = JSON.parse(await Wasm.adopt_folder_diamonds() || '{}'); }
			catch (e) { return; }                  // an older engine, or nothing to look at
			var took   = Array.isArray(rep.adopted) ? rep.adopted : [];
			var missed = Array.isArray(rep.skipped) ? rep.skipped : [];
			if (!took.length && !missed.length) return;
			if (took.length) {
				// The rail reads the store, and the store just gained Diamonds.
				try { await loadDiamonds(); } catch (e) { /* the next refresh will find them */ }
				refresh();
			}
			var kept = [];
			took.forEach(function (d) { (d.kept || []).forEach(function (k) { kept.push(k); }); });
			var body = '';
			if (took.length) {
				var names = took.map(function (d) { return d.name || d.id; });
				body = t('files.adopted_body', { names: names.join(', ') });
				if (kept.length) body += '\n\n' + t('files.adopted_kept', { paths: kept.join('\n') });
			}
			if (missed.length) {
				body += (body ? '\n\n' : '') + t('files.adopted_skipped', { paths: missed.join('\n') });
			}
			// A run that skipped everything adopted nothing, so the adopted title would be a
			// lie: the dialog is titled by what actually happened.
			var title = took.length ? tn('files.adopted_title', took.length) : t('files.adopt_left_title');
			noticeDialog(title, body, { pre: kept.length > 0 || missed.length > 0 });
		}

		// Switch the agent back to the OPFS sandbox, KEEPING the folder to come back to.
		//
		// This used to call `FsaDB.clear()`, which is what made the round trip expensive: the
		// stored handle was gone, so the Machine chip had nothing to reconnect and fell back to
		// the picker. Going to the sandbox says where the agent works, not which folder this
		// browser is allowed to reach -- and the grant survives either way, so deleting the
		// record only cost the user the dialog. Forgetting the folder is now its own deliberate
		// control (see showMachineInfo).
		async function switchToOpfs() {
			if (rootSwitchBlocked()) return;
			try { use_opfs_workspace(); } catch (e) { /* ignore */ }
			rootHandle = folderHandle || rootHandle;
			folderHandle = null;
			renderMode();
			await rereadRootRules();		// the sandbox has its own DAIMOND.md and its own prompts
			list('');
		}

		// Re-grant a stored handle (a user gesture drives requestPermission)
		// and reactivate it.
		async function reconnectFolder(handle) {
			// Reconnecting is a ROOT SWAP like any other, and it never had this guard: it was
			// only ever reached from boot and from a withdrawn grant, neither of which can happen
			// mid-turn. The Machine chip now routes the way BACK through here, which is an
			// ordinary click at an arbitrary moment -- so the gap became reachable and the agent
			// could have had the ground moved under it mid-turn.
			if (rootSwitchBlocked()) return;
			if ((await ensurePermission(handle)) !== 'granted') {
				showModeMsg('Reconnect was declined. Staying on OPFS.', true);
				return;
			}
			await activateFolder(handle, false);
		}

		// On boot (after wasm init): if a handle was stored, reuse it
		// silently when still granted; otherwise offer a one-click
		// reconnect.  Never auto-prompts — a gesture is required to
		// re-grant.
		async function tryReconnect() {
			var handle = null;
			try { handle = await FsaDB.load(); } catch (e) { return; }
			if (!handle) return;
			var perm;
			try { perm = await handle.queryPermission({ mode: 'readwrite' }); }
			catch (e) { return; }
			if (perm === 'granted') {
				await activateFolder(handle, false);
			} else {
				// Not granted, but still the folder this account works in: remembered, so a later
				// switch to the sandbox and back does not lose it.
				rootHandle = handle;
				renderMode(handle);         // 'prompt' / 'denied' → offer reconnect
			}
		}

		// The browser took the folder away: drop to OPFS and offer a reconnect rather than
		// failing silently.
		//
		// This is raised by the wasm file edge (`daimond:folder-lost`), at the single door every
		// tool result passes through, so it fires for the AGENT's file calls as much as for this
		// panel's own. It used to be noticed only here, when the tree was listed — which meant a
		// revoked grant left the agent writing into nothing while the panel went on naming a
		// folder it could no longer reach.
		//
		// Idempotent: several tool calls can fail on the same withdrawn grant, and the first one
		// to say so is the one that matters.
		function handlePermissionLoss() {
			if (!folderHandle) return;
			var lost = folderHandle;
			try { use_opfs_workspace(); } catch (e) { /* ignore */ }
			folderHandle = null;
			renderMode(lost);
			showModeMsg('Lost access to the folder. Reconnect to continue.', true);
			refresh();
		}
		window.addEventListener('daimond:folder-lost', handlePermissionLoss);

		function isOpen() {
			if (isMobile()) return document.body.dataset.mpanel === 'work';
			return DaimondPanels.isOpen('work');
		}

		/// Empty the panel. Used by the lock, so a locked app shows no file names.
		function clear() {
			if (treeEl) treeEl.innerHTML = '';
			if (viewEl) { viewEl.style.display = 'none'; docEmbed(false); }
		}

		// Parse the plain-text file_list output into entries. Lines are
		// "name/" for a directory, "name  (N bytes)" for a file, and
		// "name  (N bytes, in cloud storage)" for one this device is not
		// holding; an empty directory yields "<path> is empty.".
		function parseListing(text) {
			var out = [];
			if (/ is empty\.$/.test(text.trim())) return out;
			text.split('\n').forEach(function (line) {
				if (!line) return;
				if (line.charAt(line.length - 1) === '/') {
					out.push({ name: line.slice(0, -1), dir: true, size: 0 });
				} else {
					var c = /^(.*?)\s{2}\((\d+) bytes, in cloud storage\)$/.exec(line);
					if (c) { out.push({ name: c[1], dir: false, size: parseInt(c[2], 10), cloud: true }); return; }
					var m = /^(.*?)\s{2}\((\d+) bytes\)$/.exec(line);
					if (m) out.push({ name: m[1], dir: false, size: parseInt(m[2], 10) });
					else out.push({ name: line, dir: false, size: 0 });
				}
			});
			return out;
		}

		async function list(dir) {
			// One panel, two trees. In Diamond scope the tree is the open
			// Diamond's workspace, which is composed rather than listed.
			if (diamondScope()) { await listDiamond(dir); return; }
			curDir = dir || '';
			curFile = null; listed = true;
			viewEl.style.display = 'none'; docEmbed(false);
			pathEl.textContent = '/' + curDir;
			treeEl.innerHTML = '<div class="files-empty">…</div>';
			await loadAttached();		// so a row can say whether it is attached
			var res = await tools().run_tool('file_list', JSON.stringify({ path: curDir || '.' }));
			// A revoked grant is detected at the file edge, which raises `daimond:folder-lost`
			// for every tool call rather than only this one — so there is nothing to check here.
			if (typeof res === 'string' && res.indexOf('Error') === 0) {
				treeEl.innerHTML = '';
				var err = document.createElement('div');
				err.className = 'files-empty';
				// friendlyError, not the raw string. This is where a failed listing
				// is reported, and it was printing the tool's answer verbatim: on a
				// browser with no OPFS the whole panel filled with terminal colour
				// codes and `src/wasm/opfs.rs:210` around one readable sentence.
				err.textContent = friendlyError(res);         // escaped
				treeEl.appendChild(err);
				return;
			}
			renderTree(parseListing(res));
			refreshResidency();
		}

		function renderTree(entries) {
			lastEntries = entries;
			// Daimond's own store must not be browsable or deletable from the
			// workspace (D4). It lives at the OPFS root, so only hide it there.
			var atRoot = !curDir || curDir === '.' || curDir === '/';
			entries = entries.filter(function (e) {
				if (e.name.charAt(0) === '.') return false;          // `.daimond` and any other dotfile
				if (atRoot && e.name === 'diamonds' && e.dir) return false;
				return true;
			});
			entries.sort(function (a, b) { return (b.dir - a.dir) || a.name.localeCompare(b.name); });
			treeEl.innerHTML = '';
			if (entries.length === 0) { treeEl.innerHTML = '<div class="files-empty">empty</div>'; return; }
			entries.forEach(function (e) {
				var row = document.createElement('div');
				var full = joinPath(curDir, e.name);
				row.className = 'files-row' + (e.dir ? ' dir' : '') + (e.cloud ? ' cloud' : '');
				row.dataset.path = full;
				var name = document.createElement('span');
				name.className = 'files-name';
				name.textContent = (e.dir ? '📁 ' : (e.cloud ? '☁ ' : '📄 ')) + e.name;   // escaped
				row.appendChild(name);
				if (!e.dir) {
					var size = document.createElement('span');
					size.className = 'files-size';
					size.textContent = fmtBytes(e.size || 0);
					row.appendChild(size);
				}
				addFileControls(row, e, full, mayManage(full));
				row.addEventListener('click', function () {
					var p = joinPath(curDir, e.name);
					if (e.dir) list(p);
					else if (e.cloud) fetchEntry(p, e.size || 0, true);
					else openFile(p);
				});
				treeEl.appendChild(row);
			});
		}

		/// Whether this row may be renamed or deleted from where it is being shown.
		///
		/// In a Diamond's workspace almost nothing may: the tree there is a view
		/// over files that live elsewhere and belong to the workspace at large, and
		/// a × on such a row would destroy a file the user was merely pointing at.
		/// The Diamond's OWN directory is the exception -- that is its own, and
		/// managing it there is ordinary file management.
		function mayManage(full) {
			if (!diamondScope()) return true;
			return underPath(full, ownDir());
		}

		/// The controls that hang off a file row: residency, attaching a folder to
		/// the open Diamond, and (where it is allowed) rename and delete.
		///
		/// Shared by both trees, so a row means the same thing in each.
		function addFileControls(row, e, full, manage) {
			// Residency, not location: a cloud row is the user's file, safe,
			// simply not on this device at the moment.
			var backed = !e.dir && !e.cloud && !!(window.DaimondCloud && DaimondCloud.manifest(full));
			if (e.cloud) {
				var get = document.createElement('button');
				get.className = 'files-res files-get'; get.textContent = '⤓';
				get.title = t('files.get_help', { size: fmtBytes(e.size || 0) });
				get.addEventListener('click', function (ev) { ev.stopPropagation(); fetchEntry(full, e.size || 0); });
				row.appendChild(get);
			} else if (backed) {
				var pinned = DaimondCloud.isPinned(full);
				var pinB = document.createElement('button');
				pinB.className = 'files-res files-pin' + (pinned ? ' on' : ''); pinB.textContent = '📌';
				pinB.title = t(pinned ? 'files.pinned_help' : 'files.pin_help');
				pinB.addEventListener('click', function (ev) {
					ev.stopPropagation();
					DaimondCloud.pin(full, !DaimondCloud.isPinned(full));
					list(curDir);
				});
				row.appendChild(pinB);
				if (!pinned) {
					var freeB = document.createElement('button');
					freeB.className = 'files-res files-free'; freeB.textContent = '⤒';
					freeB.title = t('files.free_help');
					freeB.addEventListener('click', function (ev) { ev.stopPropagation(); freeEntry(full); });
					row.appendChild(freeB);
				}
			}
			// A folder can be put into the open Diamond's workspace from here, the
			// way a file can from the ◈ on the open file. Only a folder needs this:
			// a file is attached where it is read.
			if (e.dir && currentDiamond) {
				var on = !!attachedOf('dir:' + full);
				var hold = document.createElement('button');
				hold.className = 'files-res files-hold' + (on ? ' on' : '');
				hold.textContent = '◈';
				hold.dataset.act = 'hold-dir';
				hold.dataset.path = full;
				hold.title = t(on ? 'dws.detach_dir' : 'dws.attach_dir', { name: currentDiamond.name });
				hold.setAttribute('aria-pressed', on ? 'true' : 'false');
				hold.setAttribute('aria-label', hold.title);
				hold.addEventListener('click', function (ev) { ev.stopPropagation(); toggleDirHold(full); });
				row.appendChild(hold);
			}
			if (!manage) return;
			var ren = document.createElement('button');
			ren.className = 'files-del files-ren'; ren.textContent = '✎'; ren.title = t('files.rename_move');
			ren.addEventListener('click', function (ev) { ev.stopPropagation(); renameEntry(e, full); });
			row.appendChild(ren);
			var del = document.createElement('button');
			del.className = 'files-del'; del.textContent = '×'; del.title = t('files.delete');
			del.addEventListener('click', async function (ev) {
				ev.stopPropagation();
				var msg = t(e.dir ? 'files.delete_folder_body' : 'files.delete_file_body',
					{ name: e.name });
				if (!await confirmDialog(msg, t('files.delete'))) return;
				// The result used to be discarded, so a failed directory
				// delete looked exactly like a successful one: the user
				// confirmed a destructive action and was told nothing.
				var res = await tools().run_tool('file_delete', JSON.stringify({
					path: full,
					recursive: e.dir ? 'true' : 'false',
				}));
				if (typeof res === 'string' && /^\s*Error\b/i.test(res)) {
					fileMsg(t('files.delete_failed', { name: e.name, reason: friendlyError(res) }), true);
				} else nudgeSync();	// a quiet delete must travel like any edit
				list(curDir);
			});
			row.appendChild(del);
		}

		/// Bring a cloud-only file down. A fetch moves real bytes and, once
		/// storage is priced, spends the user's credits, so a large one is
		/// confirmed rather than assumed — the same reason the agent must ask
		/// for it by name instead of having it appear under a read.
		var FETCH_CONFIRM_OVER = 8 * 1024 * 1024;
		async function fetchEntry(path, size, thenOpen) {
			if (!window.DaimondCloud) return;
			if (size > FETCH_CONFIRM_OVER) {
				var ok = await confirmDialog(
					t('files.fetch_body', { path: path, size: fmtBytes(size) }),
					t('files.fetch'));
				if (!ok) return;
			}
			fileMsg(t('files.fetching', { path: path }));
			var res = await DaimondCloud.fetch(path);
			// The tool's own answer, which on a failure is an fe2o3 chain. Through
			// friendlyError so it arrives as a sentence rather than as frames.
			if (res.indexOf('OK') !== 0) { fileMsg(friendlyError(res), true); return; }
			await list(curDir);
			if (thenOpen) openFile(path);
		}

		/// Drop this device's copy, keeping the file in cloud storage.
		async function freeEntry(path) {
			if (!window.DaimondCloud) return;
			var res = await DaimondCloud.evict(path);
			var bad = res.indexOf('OK') !== 0;
			fileMsg(bad ? friendlyError(res) : res, bad);
			list(curDir);
		}

		/// Show a binary file as what it is: something to save, not something to
		/// read. The workspace carries these now, so the panel has to meet one
		/// without spilling a screen of replacement characters.
		async function openBinaryFile(path, file) {
			curFile = path; curContent = null; editing = false;
			docEmbed(false);
			viewEl.style.display = '';
			viewEl.innerHTML =
				'<div class="files-view-head">' +
				'  <span class="files-view-name"></span>' +
				'  <span>' +
				'    <button class="files-btn" data-act="download" title="' + esc(t('files.download_help')) + '">⤓ '
					+ esc(t('files.download')) + '</button>' +
				'    <button class="files-btn" data-act="back">← ' + esc(t('files.back')) + '</button>' +
				'  </span>' +
				'</div>' +
				'<div class="files-view-body"><p class="cloud-intro"></p></div>';
			viewEl.querySelector('.files-view-name').textContent = path;
			viewEl.querySelector('.cloud-intro').textContent =
				t('files.binary_note', { size: fmtBytes(file.size) });
			var nameEl = document.getElementById('doc-name');
			if (nameEl) nameEl.textContent = path;
			DaimondPanels.markUsed('doc');
			DaimondPanels.show('doc');
			DaimondPanels.reflow();
			viewEl.querySelector('[data-act="back"]').addEventListener('click', closeView);
			viewEl.querySelector('[data-act="download"]').addEventListener('click', async function () {
				var a = document.createElement('a');
				a.href = URL.createObjectURL(file);
				a.download = path.split('/').pop() || 'file';
				a.click(); URL.revokeObjectURL(a.href);
			});
		}

		/// Open `path` in the Doc panel.
		///
		/// `opts.store` opens it from Daimond's OWN store rather than from the active
		/// workspace. The distinction is not cosmetic: with a folder open, the two
		/// roots hold DIFFERENT FILES under the same name, and `DAIMOND.md` is exactly
		/// such a name. A store file read through the workspace door would show the
		/// project's copy, and saving it would write the user's standing instructions
		/// into the project.
		async function openFile(path, opts) {
			storeFile = !!(opts && opts.store);
			// Ask the file itself before asking the tool: file_read is for text and
			// refuses anything else, which is right for the agent and useless as a
			// way to find out.
			var f = null;
			try { f = await DaimondCloud.fileAt(path); } catch (e) { f = null; }
			if (f) {
				var head = new Uint8Array(await f.slice(0, Math.min(f.size, 4096)).arrayBuffer());
				var binary = false;
				for (var bi = 0; bi < head.length; bi++) { if (head[bi] === 0) { binary = true; break; } }
				if (!binary) {
					try { new TextDecoder('utf-8', { fatal: true }).decode(head); }
					catch (e) { binary = (f.size <= 4096); }	// a cut multi-byte char is not proof.
				}
				if (binary) { await openBinaryFile(path, f); return; }
			}
			var content = await readRaw(path);
			curFile = path; curContent = content; editing = false;
			docEmbed(false);
			viewEl.style.display = '';
			var isTypst = /\.typ$/i.test(path);
			var compileBtn = isTypst
				? '    <button class="files-btn" data-act="compile" title="Compile to PDF">⚙ Compile</button>'
				: '';
			viewEl.innerHTML =
				'<div class="files-view-head">' +
				'  <span>' +
				compileBtn +
				'    <button class="files-btn" data-act="edit" title="' + esc(t('files.edit')) + '">✎ '
					+ esc(t('files.edit')) + '</button>' +
				// Edit used to have no way out but Save. Backing out meant closing the
				// whole document and opening it again, which threw the edit away
				// without a word -- a one-way door into a mode that writes.
				'    <button class="files-btn" data-act="cancel-edit" title="' + esc(t('files.stop_editing'))
					+ '" style="display:none">✕ ' + esc(t('common.cancel')) + '</button>' +
				// Line numbers used to be a `#` in this row. They are now a toggle in
				// the panel's own header, where the rest of "how this is shown" lives
				// and where it can be reached without the toolbar in view.
				'    <button class="files-btn" data-act="download" title="' + esc(t('files.download')) + '">⤓</button>' +
				'    <button class="files-btn" data-act="hold" title="">◈</button>' +
				'    <button class="files-btn" data-act="back">← ' + esc(t('files.back')) + '</button>' +
				'  </span>' +
				'</div>' +
				'<div class="files-view-msg" style="display:none"></div>' +
				'<pre class="files-view-body"></pre>';
			var nameEl = document.getElementById('doc-name');
			if (nameEl) nameEl.textContent = path;                 // escaped
			renderFileBody();
			DaimondPanels.markUsed('doc');       // it now has something to hold
			DaimondPanels.show('doc');
			DaimondPanels.reflow();
			viewEl.querySelector('[data-act="back"]').addEventListener('click', closeView);
			// ── Attaching a file to the open Diamond ──────────────────────
			//
			// Artefacts are otherwise harvested at a fold, from what a turn WROTE.
			// That is right for everything an agent produces and no use at all for
			// the work a person brought with them, which is most of what a Diamond
			// is for. This writes the link there and then: a fold is the moment the
			// user blesses what an AGENT did, and there is nothing to bless when
			// the user is the one doing it.
			//
			// It says `holds`, not `produced`. The Diamond did not make this file.
			var holdBtn = viewEl.querySelector('[data-act="hold"]');
			async function paintHold() {
				if (!holdBtn) return;
				if (!currentDiamond) {
					holdBtn.style.display = 'none';
					return;
				}
				holdBtn.style.display = '';
				var on = await fileIsHeld(currentDiamond.id, path);
				holdBtn.classList.toggle('on', on);
				holdBtn.title = on
					? t('files.hold_drop', { name: currentDiamond.name })
					: t('files.hold_add',  { name: currentDiamond.name });
				holdBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
				holdBtn.setAttribute('aria-label', holdBtn.title);
			}
			if (holdBtn) holdBtn.addEventListener('click', async function () {
				if (!currentDiamond) return;
				var id = currentDiamond.id, self = 'diamond:' + id, ref = 'file:' + path;
				var link = await heldLink(id, path);
				try {
					if (link) await diamondApp().remove_link(link.owner, link.id);
					else await diamondApp().add_link(id, self, ref, 'holds', '', 'user');
				} catch (e) { /* already gone, or already there: repaint tells the truth */ }
				signalLinksChanged();
				renderArtefacts();
				paintHold();
			});
			paintHold();
			// The Diamond can change under an open file, and the button names it.
			document.addEventListener('daimond-links-changed', paintHold);

			viewEl.querySelector('[data-act="download"]').addEventListener('click', function () {
				var blob = new Blob([curContent], { type: 'text/plain' });
				var a = document.createElement('a');
				a.href = URL.createObjectURL(blob);
				a.download = path.split('/').pop() || 'file.txt';
				a.click(); URL.revokeObjectURL(a.href);
			});
			// Edit ⇄ Save: swap the <pre> for a textarea; Save writes via the
			// file_write tool (honouring the active workspace root — OPFS or FSA).
			var editBtn   = viewEl.querySelector('[data-act="edit"]');
			var cancelBtn = viewEl.querySelector('[data-act="cancel-edit"]');

			/// Leave edit mode without writing, putting the read view back.
			function stopEditing() {
				var ta = viewEl.querySelector('.files-edit');
				if (ta) {
					var pre = document.createElement('pre');
					pre.className = 'files-view-body';
					ta.replaceWith(pre);
				}
				editing = false;
				editBtn.textContent = '✎ ' + t('files.edit');
				editBtn.disabled = false;
				cancelBtn.style.display = 'none';
				renderFileBody();
			}
			cancelBtn.addEventListener('click', async function () {
				var ta = viewEl.querySelector('.files-edit');
				// Typed work is only thrown away on purpose. An untouched editor
				// closes without a question, because there is nothing to lose.
				if (ta && ta.value !== curContent) {
					var go = await confirmDialog(
						t('files.unsaved_body', { path: path }),
						t('files.discard'),
						{ title: t('files.discard_title'), danger: true, cancelLabel: t('files.keep_editing') });
					if (!go) return;
				}
				stopEditing();
				fileMsg(t('files.editing_stopped'));
			});
			editBtn.addEventListener('click', async function () {
				if (!editing) {
					editing = true;
					var ta = document.createElement('textarea');
					ta.className = 'files-edit'; ta.value = curContent; ta.spellcheck = false;
					viewEl.querySelector('.files-view-body').replaceWith(ta);
					ta.focus();
					// At the TOP, not the end. Focusing a textarea leaves the caret past
					// the last character, and the box does not wrap -- so pressing Edit
					// scrolled five thousand pixels right, to the end of the longest line
					// in the file, and the document looked empty.
					ta.setSelectionRange(0, 0);
					ta.scrollTop = 0;
					ta.scrollLeft = 0;
					editBtn.textContent = '✔ ' + t('common.save');
					cancelBtn.style.display = '';
					syncLineNo();            // a textarea has no gutter to number
				} else {
					var ta2 = viewEl.querySelector('.files-edit'), content = ta2.value;
					editBtn.disabled = true; editBtn.textContent = t('files.saving');
					// The agent may have rewritten this file since it was opened.
					// Saving the editor's stale copy would silently erase that work,
					// so a disk that no longer matches the edit's base is confirmed
					// before it is overwritten.
					var disk = null;
					try { disk = await readRaw(path); }
					catch (e) { /* new file, or unreadable; treat as no conflict */ }
					if (disk !== null && disk !== curContent && disk !== content) {
						// In-app, not window.confirm: a native box is an OS dialog with
						// the origin in its title, styled nothing like the app, and it
						// blocks the page. This file says so at the top of its dialog
						// section, and this was the one place still doing it.
						var over = await confirmDialog(
							t('files.conflict_body'), t('files.overwrite'),
							{ title: t('files.conflict_title'), danger: true });
						if (!over) {
							editBtn.disabled = false; editBtn.textContent = '✔ ' + t('common.save');
							fileMsg(t('files.save_cancelled'), true);
							return;
						}
					}
					writeOpenFile(path, content).then(function () {
						curContent = content; editing = false;
						var pre = document.createElement('pre'); pre.className = 'files-view-body';
						ta2.replaceWith(pre);
						renderFileBody();
						editBtn.textContent = '✎ ' + t('files.edit'); editBtn.disabled = false;
						cancelBtn.style.display = 'none';
						fileMsg(t('files.saved')); refresh();
						nudgeSync();	// a saved edit outside a turn pushes on its own
						if (path === INSTRUCTIONS_FILE) Instructions.refresh();
						else if (path.indexOf(PROMPTS_DIR + '/') === 0) Prompts.refresh();
						if (storeFile) sysList(sysDir);	// sizes move when a store file is saved
					}).catch(function (e) {
						editBtn.disabled = false; editBtn.textContent = '✔ ' + t('common.save');
						fileMsg(t('files.save_failed', { reason: friendlyError(e) }));
					});
				}
			});
			if (isTypst) {
				viewEl.querySelector('[data-act="compile"]').addEventListener('click', function () {
					compileTypst(path, this);
				});
			}
		}

		// Compile the currently open `.typ` file to a PDF in the
		// browser, write it next to the source in OPFS, and render it
		// inline.  The heavy compiler wasm is imported lazily on first
		// use so opening non-Typst files stays light.
		var _pdfUrl = null;   // live blob URL for the shown PDF
		async function compileTypst(path, btn) {
			var msgEl = viewEl.querySelector('.files-view-msg');
			if (!msgEl) return;
			var label = btn ? btn.textContent : '';
			if (btn) { btn.disabled = true; btn.textContent = '… ' + t('files.compiling'); }
			msgEl.style.display = ''; msgEl.classList.remove('err');
			msgEl.textContent = t('files.compiling_path', { path: path });   // escaped
			try {
				// One driver, one memo. `typst.js` installs `window.DaimondTypst` and holds the
				// compiler promise itself, so the button and the agent's `typst_compile` tool
				// build the 30 MB wasm once between them; a private memo here would have been a
				// second one the tool could not reach.
				if (!window.DaimondTypst) await import('./typst.js');
				// Always compile the freshest source from OPFS.
				var src = await readBytes(path);
				var out = await window.DaimondTypst.compile(src);
				if (!out) { out = { error: t('files.compile_failed', { reason: 'no compiler' }) }; }
				if (out.error) {
					msgEl.classList.add('err');
					msgEl.textContent = out.error;               // escaped
					return;
				}
				var pdfPath = path.replace(/\.typ$/i, '.pdf');
				await writeWorkspaceBytes(pdfPath, out.pdf);
				// Render from a blob URL (same-origin) in the CENTRE panel, where
				// there is room to actually read the page.
				if (_pdfUrl) { URL.revokeObjectURL(_pdfUrl); _pdfUrl = null; }
				var blob = new Blob([out.pdf], { type: 'application/pdf' });
				_pdfUrl = URL.createObjectURL(blob);
				showDoc(pdfPath, _pdfUrl);
				msgEl.textContent = t('files.compiled',
					{ path: pdfPath, size: fmtBytes(out.pdf.length) });
			} catch (e) {
				msgEl.classList.add('err');
				msgEl.textContent = t('files.compile_failed', { reason: (e && e.message ? e.message : e) });
			} finally {
				if (btn) { btn.disabled = false; btn.textContent = label || ('⚙ ' + t('files.compile')); }
			}
		}

		// Write binary bytes into the ACTIVE workspace root: a compiled PDF, a saved message, an
		// upload from the machine. Everything else in this panel goes through `run_tool`, which
		// carries text; this is the one door for bytes.
		//
		// Rust owns the write. It applies the path jail, the real-folder override AND the
		// per-account namespace, and it is the last of those that matters here: this function used
		// to walk the origin OPFS root itself, so a secondary account's compiled PDFs and saved
		// mail landed in the PRIMARY account's workspace, readable by whoever else uses this
		// browser. A hand-rolled walk cannot know about an account; the wasm edge already does.
		async function writeWorkspaceBytes(path, bytes) {
			await tools().write_bytes(String(path),
				bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
		}

		// Briefly flash a status line in the open file's header (Saved / error).
		function fileMsg(text, isErr) {
			var el = viewEl && viewEl.querySelector('.files-view-msg');
			if (!el) {
				// No file is open (e.g. a delete from the tree), so there is no
				// header to flash. Say it where the user is actually looking.
				showModeMsg(text, !!isErr);
				return;
			}
			el.textContent = stripAnsi(text); el.style.display = '';
			el.classList.toggle('err', !!isErr);
			// An error stays until the next action; a success fades.
			clearTimeout(el._t);
			if (!isErr) el._t = setTimeout(function () { el.style.display = 'none'; }, 2500);
		}

		/// Where a new file, folder or upload lands.
		///
		/// The directory being shown, except at the top of a Diamond's workspace,
		/// which is a composed view rather than a directory: there, new work goes
		/// into the Diamond's own directory, which is the one place its daimon can
		/// always write. Without this it landed at the workspace ROOT -- outside
		/// the very Diamond the panel was showing.
		function writeDir() {
			if (diamondScope() && !curDir) return ownDir();
			return curDir;
		}

		// Create a new empty file in the current directory and open it to edit.
		async function newFile() {
			var into = writeDir();
			var atRoot = !into || into === '.' || into === '/';
			var hint = (atRoot && !Instructions.md.trim()) ? t('files.new_file_hint') : '';
			var name = await promptDialog(t('work.new_file'),
				{ message: hint, placeholder: 'notes.md', okLabel: t('rail.create') });
			if (name === null) return;
			name = name.trim(); if (!name) return;
			var p = joinPath(into, name);
			var seed = '';
			if (p === INSTRUCTIONS_FILE) {
				seed = '# Standing instructions\n\n'
					+ 'Everything written here is given to every agent Daimond runs — chats, the\n'
					+ 'daimon of each Diamond, and every worker it dispatches.\n\n'
					+ '## House rules\n\n'
					+ '- \n';
			}
			try {
				await tools().run_tool('file_write', JSON.stringify({ path: p, content: seed }));
				await list(curDir);
				await Instructions.refresh();
				await Prompts.refresh();
				nudgeSync();	// a new file outside a turn pushes on its own
				openFile(p);
			} catch (e) { fileMsg(t('files.create_failed', { reason: friendlyError(e) }), true); }
		}

		/// Create a folder. Only an agent could make one before — and only as a
		/// side effect of writing a file into it. The user had no way at all.
		async function newDir() {
			var name = await promptDialog(t('work.new_folder'),
				{ placeholder: 'notes', okLabel: t('rail.create') });
			if (name === null) return;
			name = name.trim(); if (!name) return;
			var res = await tools().run_tool('dir_create', JSON.stringify({ path: joinPath(writeDir(), name) }));
			if (typeof res === 'string' && /^\s*Error\b/i.test(res)) {
				fileMsg(t('files.create_folder_failed', { reason: friendlyError(res) }), true);
			}
			await list(curDir);
		}

		/// Rename or move an entry. `to` may carry a path, so this is also how a
		/// file is moved into another folder.
		///
		/// `from` is the entry's own path, which is not always under `curDir`: a
		/// Diamond's workspace shows its own directory at the top of a composed
		/// tree, where `curDir` is not a directory at all.
		async function renameEntry(e, from) {
			from = from || joinPath(curDir, e.name);
			var parent = from.slice(0, Math.max(0, from.lastIndexOf('/')));
			var name = await promptDialog(t('rail.rename'), {
				message: t('files.rename_hint'),
				value: e.name, okLabel: t('rail.rename'),
				validate: function (v) { return v ? '' : t('files.err_name'); },
			});
			if (name === null) return;
			name = name.trim();
			if (!name || name === e.name) return;
			var to = name.indexOf('/') === -1 ? joinPath(parent, name) : name;
			var res = await tools().run_tool('file_move', JSON.stringify({ path: from, to: to }));
			if (typeof res === 'string' && /^\s*Error\b/i.test(res)) {
				fileMsg(t('files.rename_failed', { reason: friendlyError(res) }), true);
			} else nudgeSync();	// a rename or move outside a turn pushes on its own
			await list(curDir);
		}

		/// Bring files in from the machine. The workspace could only ever be
		/// filled by an agent writing into it.
		function uploadFiles() {
			var inp = document.createElement('input');
			inp.type = 'file';
			inp.multiple = true;
			inp.addEventListener('change', async function () {
				var files = Array.prototype.slice.call(inp.files || []);
				if (!files.length) return;
				for (var i = 0; i < files.length; i++) {
					var f = files[i];
					try {
						var buf = new Uint8Array(await f.arrayBuffer());
						await writeWorkspaceBytes(joinPath(writeDir(), f.name), buf);
					} catch (err) {
						fileMsg(t('files.upload_failed', { name: f.name, reason: friendlyError(err) }), true);
					}
				}
				await list(curDir);
				fileMsg(tn('files.uploaded', files.length));
			});
			inp.click();
		}

		/// Show or hide the panel's PDF embed, and the text view with it.
		///
		/// One panel, two renderings: whichever is showing, the other is not.
		/// Releasing the blob URL when the embed goes away keeps a long session
		/// from holding every PDF it has ever compiled.
		function docEmbed(on) {
			var e = document.getElementById('doc-embed');
			if (!e) return;
			e.style.display = on ? '' : 'none';
			if (!on) {
				e.removeAttribute('src');
				if (_pdfUrl) { URL.revokeObjectURL(_pdfUrl); _pdfUrl = null; }
			}
			syncLineNo();
		}

		/// Put the header's line-number toggle where the panel is: on and pressed
		/// only over a text file being READ, since a PDF, a binary, the cloud view
		/// and the editor's textarea have no lines to number, and a control that
		/// cannot do anything is one the reader has to rule out.
		function syncLineNo() {
			var btn = document.getElementById('doc-lineno');
			if (!btn) return;
			var text = !!curFile && typeof curContent === 'string' && !editing
				&& !!viewEl && viewEl.style.display !== 'none';
			btn.style.display = text ? '' : 'none';
			btn.classList.toggle('on', showLineNos);
			btn.setAttribute('aria-pressed', showLineNos ? 'true' : 'false');
		}

		/// The file as it is ON DISK, for the viewer and the editor.
		///
		/// NOT `file_read`. That tool renders a file FOR A MODEL: it numbers every line
		/// (`1\t`), it says so when it truncates, and it explains itself when the bytes are in
		/// cloud storage. All three are right for an agent and none of them is the file. The
		/// viewer showed that rendering as though it were the document -- two columns of numbers
		/// once the line-number toggle was on -- and, far worse, the editor was seeded with it, so
		/// OPENING A FILE AND PRESSING SAVE WITHOUT TYPING ANYTHING WROTE THE LINE NUMBERS INTO
		/// IT, compounding on every repeat. A truncated read would have written the truncation in
		/// the same way.
		///
		/// `Wasm.read_file` resolves against the same active root the tools use, so a folder on
		/// the machine and the sandbox both work, and the store still pins itself.
		///
		/// # Arguments
		/// * `path` - Workspace-relative path.
		/// Which door is currently open in the Doc panel: the store's, or the
		/// workspace's. Set by `openFile` and read by every path that goes back to
		/// disk for the same file — the read, the conflict check and the save.
		var storeFile = false;

		async function readRaw(path) {
			return storeFile ? await Wasm.store_read(path) : await Wasm.read_file(path);
		}

		/// Write the file the Doc panel has open, through whichever door it came from.
		function writeOpenFile(path, content) {
			if (storeFile) return Wasm.store_write(path, content);
			return tools().run_tool('file_write', JSON.stringify({ path: path, content: content }));
		}

		function renderFileBody() {
			syncLineNo();
			var body = viewEl.querySelector('.files-view-body');
			if (!body) return;
			if (showLineNos) {
				var lines = curContent.split('\n');
				var html = '';
				for (var i = 0; i < lines.length; i++) {
					// Each numbered line is its own block, so that a long line
					// wrapping continues past the gutter instead of returning to
					// the margin. A hanging indent needs a block to hang from,
					// and `text-indent` on the <pre> indents only the first line
					// of the whole file -- which is what it was doing.
					html += '<span class="lnrow"><span class="ln">' + (i + 1) + '</span>'
						+ esc(lines[i]) + '</span>';
				}
				body.innerHTML = html;        // only line numbers + escaped text
				body.classList.add('with-lineno');
			} else {
				body.textContent = curContent;
				body.classList.remove('with-lineno');
			}
		}

		/// Close the document. Typed work is never thrown away in silence: leaving
		/// the view mid-edit used to discard it without a word, which made Back the
		/// only exit from edit mode AND a destructive one.
		async function closeView() {
			var ta = viewEl.querySelector('.files-edit');
			if (editing && ta && ta.value !== curContent) {
				var go = await confirmDialog(
					t('files.unsaved_close', { path: curFile || t('files.this_file') }),
					t('files.discard'),
					{ title: t('files.discard_title'), danger: true, cancelLabel: t('files.keep_editing') });
				if (!go) return;
			}
			if (_pdfUrl) { URL.revokeObjectURL(_pdfUrl); _pdfUrl = null; }
			viewEl.style.display = 'none'; docEmbed(false);
			curFile = null; editing = false;
			syncLineNo();                        // after the file is let go, not before
			DaimondPanels.hide('doc');
		}
		// ── The System section: Daimond's own store ──────────────────
		//
		// Notes2: *"When I choose the Browser workspace, I see only a mail folder
		// and a test.md, where are all the system files like DAIMOND.md??"*
		//
		// They are where they always were — at the OPFS root — and `renderTree`
		// filters them out on purpose, because a `×` beside `diamonds/` would
		// delete every Diamond the user has. That answered the wrong question: the
		// ask is to SEE the store, not to be able to destroy it from a file row.
		//
		// So it gets its own section, and the section is read-and-edit but never
		// delete or rename. It also resolves against a DIFFERENT ROOT — always
		// OPFS, whatever folder is open — which is the reason it is not simply
		// unhidden in the tree above. `dev/ROOT_SEPARATION.md` §2.1: a single tree
		// quietly spanning two roots is exactly the confusion that document exists
		// to prevent.
		var sysDir = '';

		/// One directory of the store, listed through the OPFS-pinned door.
		async function sysList(dir) {
			var tree = document.getElementById('sys-tree');
			var path = document.getElementById('sys-path');
			if (!tree) return;
			sysDir = dir || '';
			if (path) path.textContent = '/' + sysDir;
			var raw = '';
			try { raw = await Wasm.store_list(sysDir); }
			catch (e) { tree.innerHTML = ''; tree.appendChild(sysNote(friendlyError(e))); return; }
			var rows = String(raw || '').split('\n').filter(Boolean).map(function (line) {
				var bits = line.split('\t');
				return { name: bits[0], dir: bits[1] === 'dir', size: parseInt(bits[2], 10) || 0 };
			}).filter(function (e) {
				// `.daimond` and friends stay hidden here too: they are the store's own
				// bookkeeping, not files anybody edits, and a user who opens one and
				// saves it has broken a Diamond rather than configured one.
				return e.name && e.name.charAt(0) !== '.';
			});
			rows.sort(function (a, b) { return (b.dir - a.dir) || a.name.localeCompare(b.name); });
			tree.innerHTML = '';
			if (sysDir) {
				var up = document.createElement('div');
				up.className = 'files-row dir sys-row';
				up.textContent = '📁 ..';
				sysRowAsButton(up, t('sys.up'), function () {
					var cut = sysDir.lastIndexOf('/');
					sysList(cut < 0 ? '' : sysDir.slice(0, cut));
				});
				tree.appendChild(up);
			}
			if (!rows.length) { tree.appendChild(sysNote(t('sys.empty'))); return; }
			rows.forEach(function (e) {
				var full = sysDir ? (sysDir + '/' + e.name) : e.name;
				var row = document.createElement('div');
				row.className = 'files-row sys-row' + (e.dir ? ' dir' : '');
				row.dataset.path = full;
				var nm = document.createElement('span');
				nm.className = 'files-name';
				nm.textContent = (e.dir ? '📁 ' : '📄 ') + e.name;   // escaped
				row.appendChild(nm);
				if (!e.dir) {
					var sz = document.createElement('span');
					sz.className = 'files-size';
					sz.textContent = fmtBytes(e.size);
					row.appendChild(sz);
				}
				sysRowAsButton(row, e.name, function () {
					if (e.dir) sysList(full); else openFile(full, { store: true });
				});
				tree.appendChild(row);
			});
		}

		/// Make a store row behave as the button it already is.
		///
		/// A `<div>` with a click handler is reachable by pointer and by nothing else.
		/// `verify_a11y_keyboard` keeps a census of the ones this app already has and
		/// fails on a NEW one, which is how these two were caught the hour they were
		/// written — the tree above them has the same fault and is grandfathered, and
		/// a new section had no business joining it.
		function sysRowAsButton(row, name, onGo) {
			row.setAttribute('role', 'button');
			row.setAttribute('tabindex', '0');
			row.setAttribute('aria-label', name);
			row.addEventListener('click', onGo);
			row.addEventListener('keydown', function (ev) {
				if (ev.key !== 'Enter' && ev.key !== ' ') return;
				ev.preventDefault();
				onGo();
			});
		}

		function sysNote(words) {
			var d = document.createElement('div');
			d.className = 'files-empty';
			d.textContent = words;
			return d;
		}

		/// Wire the System section's disclosure, once.
		function bindSystem() {
			var head = document.getElementById('sys-head');
			var body = document.getElementById('sys-body');
			if (!head || !body || head.dataset.bound) return;
			head.dataset.bound = '1';
			head.addEventListener('click', function () {
				var open = head.getAttribute('aria-expanded') === 'true';
				head.setAttribute('aria-expanded', open ? 'false' : 'true');
				body.hidden = open;
				if (!open) sysList(sysDir);
			});
		}

		function onOpen() {
			bindSystem();
			if (!curFile) list(curDir);
			// Listed whether or not the section is expanded: it is cheap, it is local,
			// and a `<details>` that shows a spinner the first time it is opened is a
			// section people learn not to open.
			sysList(sysDir);
		}
		/// Re-sync the panel with the workspace after a turn or a worker may have
		/// changed it. With the tree showing, re-list. With a file open, reload it
		/// to the agent's latest so the viewer is never stale -- unless the user is
		/// editing, in which case their text is left untouched and they are only
		/// warned that the base has moved, so a later save cannot silently erase
		/// the agent's work.
		async function refresh() {
			if (!isOpen() || !listed) return;
			// The store moves for reasons the workspace tree never sees — a Diamond
			// made, a role prompt seeded, a sync landing — so it is relisted on every
			// refresh rather than only when the panel opens. `onOpen` fires once, and
			// a section listed at boot showed an empty store for the rest of the
			// session.
			sysList(sysDir);
			if (!curFile) { list(curDir); return; }
			var disk = null;
			try { disk = await readRaw(curFile); }
			catch (e) { return; }   // gone or unreadable; leave the view as it is
			if (disk === curContent) return;
			if (editing) {
				fileMsg(t('files.changed_while_editing'), true);
			} else {
				curContent = disk;
				renderFileBody();
				fileMsg(t('files.reloaded'));
			}
		}

		return {
			init:          bind,
			onOpen:        onOpen,
			refresh:       refresh,
			// Repaint what the Cloud chip claims, after a sync has moved residency.
			refreshResidency: refreshResidency,
			tryReconnect:  tryReconnect,
			clear:         clear,
			// The open folder, for the status row that reports on it. Null on the sandbox.
			folder:        function () { return folderHandle; },
			// A PDF is put on the panel from outside this module, so the header's
			// line-number toggle has to be told to stand down from there too.
			syncLineNo:    syncLineNo,
			// Mail arrives as bytes, not text: a message with a JPEG attached is
			// not a string, and writing it as one silently corrupts it.
			writeBytes:    writeWorkspaceBytes,
			open:          openFile,
			// Show the store section, and put it back at a given directory.
			systemList:    sysList,
			// Show a directory in the tree, whichever tree is showing.
			browse:        function (p) { return list(p || ''); },
			// Say the panel's own words again in a new language. The scope chips and
			// the badges on an attached row are on screen the whole time the panel
			// is, so they cannot wait for the next time something rebuilds them.
			relabel:       function () {
				renderScope();
				if (listed && !curFile) list(curDir);
			},
			// Which tree the panel is showing: 'all' or 'diamond'.
			scope:         function () { return diamondScope() ? 'diamond' : 'all'; },
			/// What the open Diamond's workspace is made of, as the three lists
			/// `diamond_bounds` in src/tools.rs takes: its own directory, what the
			/// user attached, and which of those were attached to be consulted
			/// rather than worked on.
			///
			/// This is the INPUT to a fence and not a fence. The bounds, and the
			/// compartment built from them, are computed in Rust; a page that
			/// composed either would be a second opinion about what a command may
			/// touch, free to drift from the one the hand enforces.
			///
			/// Read here because this module already keeps the attachments — the
			/// panel lists them on every open — and a second reader of the same
			/// links would be a second answer to the same question.
			/// # Arguments
			/// * `id` - Which Diamond, or nothing for the one on screen. A worker is
			///   scoped to the Diamond it works FOR, which is not always the one the
			///   user is looking at.
			bounds:        async function (id) {
				var did = id || (currentDiamond ? currentDiamond.id : '');
				if (!did) return { own_dir: '', attached: [], read_only: [], toolkits: [] };
				var list = [];
				try { list = await attachmentsOf(did); } catch (e) { list = []; }
				var d = diamonds.find(function (x) { return x.id === did; });
				return {
					own_dir:   'diamonds/' + did,
					attached:  list.map(function (a) { return a.path; }),
					read_only: list.filter(function (a) { return a.ro; })
						.map(function (a) { return a.path; }),
					// The toolchains the USER granted this Diamond, from the store. Never
					// inferred from anything a model asked to run — see `Toolkit` in
					// src/tools.rs, which says the same thing at the other end.
					toolkits:  (d && Array.isArray(d.toolkits)) ? d.toolkits.slice() : [],
				};
			},
		};
	})();

	// ── The Terminal panel ─────────────────────────────────────
	//
	// The last joint in a road that is otherwise finished. `js/terminal.js` draws
	// a terminal and produces keystrokes; `js/handpty.js` carries bytes to and
	// from a real pty on the user's machine; neither knows the other exists. This
	// is the piece that puts one inside a Diamond and joins them.
	//
	// Three rules, and none of them is this module's to relax:
	//
	//   The fence is composed in Rust and nowhere else. `fence_spec` in
	//   src/tools.rs computes what a session may touch, from the Diamond's own
	//   bounds and the folder the user granted the hand — exactly as it does for
	//   `Tool::Run`. This page asks for that request and passes it through. It
	//   does not compose one, does not widen one, and does not patch a missing
	//   one: `DaimondPty.open` refuses a fenceless request by design, and the
	//   right response to that refusal is to show it.
	//
	//   Bytes are bytes. `onOutput` hands over the bytes the program wrote, and
	//   `write` takes them; a keystroke goes back the same way. Nothing in
	//   between converts either to text — a base64 STRING handed to
	//   `DaimondPty.input` would be UTF-8 encoded and typed at the program
	//   literally, which is the exact failure a byte path exists to prevent.
	//
	//   A hole is shown, not stitched. A gap in the output is surfaced BESIDE the
	//   stream, in the notices column, and the bytes still go through. A terminal
	//   that quietly closed over a missing chunk would draw a screen that never
	//   existed.
	//
	// The refusals a user reads here are, wherever there is one, the sentence the
	// layer below already wrote — the relay's, the extension's or the hand's,
	// verbatim. They are written to be acted on, and a paraphrase loses the only
	// instruction the reader gets.
	var DaimondTerm = (function () {

		var els   = null;	// the panel's own furniture, bound on the first open
		var term  = null;	// the DaimondTerminal handle, or null before one exists
		var sid   = null;	// the live session's id, or null
		var owner = null;	// the Diamond that session belongs to
		var size  = { cols: 80, rows: 24 };
		var starting = false;	// an open is in flight
		var tearing  = false;	// a teardown is in progress; endings are ours, not news
		var again    = false;	// a restart is waiting for the old program to go
		var composer = null;	// test-only; see _setRequestForTest

		/// The Diamond a session belongs to, or '' when none is open.
		function diamondId() { return currentDiamond ? currentDiamond.id : ''; }

		/// The sentence out of a rejection, which is what these rejections carry.
		function msgOf(e) { return (e && e.message) || String(e || ''); }

		function bind() {
			if (els) return els;
			var panel = document.getElementById('panel-term');
			if (!panel) return null;
			els = {
				panel: panel,
				head:  panel.querySelector('.chead [role="heading"]'),
				title: document.getElementById('termp-title'),
				bell:  document.getElementById('termp-bell'),
				state: document.getElementById('termp-state'),
				gaps:  document.getElementById('termp-gaps'),
				host:  document.getElementById('termp-host'),
				start: panel.querySelector('[data-act="term-start"]'),
				stop:  panel.querySelector('[data-act="term-stop"]'),
			};
			// Where F6 lands. -1 rather than 0: it is a destination, not a stop on
			// the way round, and a heading in the tab order would be one more press
			// between everybody else and the panel's buttons.
			if (els.head) els.head.setAttribute('tabindex', '-1');
			if (els.start) els.start.addEventListener('click', function () { restart(); });
			if (els.stop)  els.stop.addEventListener('click', function () { stop(); });
			// The way out, and it has to be taken BEFORE the terminal sees the key.
			// A terminal owns nearly every keystroke — Escape is a byte, Tab is a
			// byte, F6 itself is `\x1b[17~` — so the panel takes this one in the
			// capture phase and stops it there. Without that there is no keyboard
			// route out of the terminal at all, which is a trap and not a panel.
			panel.addEventListener('keydown', function (ev) {
				if (ev.key !== 'F6' || ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return;
				ev.preventDefault();
				ev.stopPropagation();
				leave();
			}, true);
			return els;
		}

		/// Move the keyboard out of the terminal, to the panel's own heading.
		///
		/// The heading and not the next control: a reader who has just left a
		/// terminal is told where they now are, and Tab from here reaches the
		/// panel's buttons in the ordinary way.
		function leave() {
			if (els && els.head) els.head.focus();
		}

		/// Where the session is, in a sentence. `refused` gives it the app's
		/// warning frame rather than a colour, which a reader who cannot see
		/// colour would not get at all.
		///
		/// The count of holes is carried here rather than only on the notices,
		/// because a notice can be dismissed and the fact cannot: a transcript
		/// with a hole in it is not a transcript, for as long as it is on screen.
		var state = { line: '', refused: false, gaps: 0 };
		function say(text, refused) {
			state.line = text || '';
			state.refused = !!refused;
			render();
		}
		function render() {
			if (!els) return;
			var line = state.line;
			if (state.gaps) {
				line = (line ? line + ' ' : '') + tn('term.gaps_count', state.gaps);
			}
			els.state.textContent = line;
			els.state.classList.toggle('refused', state.refused || state.gaps > 0);
		}

		/// Whether the empty screen is worth showing at all.
		///
		/// A terminal refused before it ever drew a byte is a black box under a
		/// paragraph saying why the box is empty; the paragraph is the whole of
		/// what there is to read, so it gets the room. Anything that has drawn
		/// keeps its screen, ending or no ending.
		function showScreen(on) {
			if (els) els.panel.classList.toggle('no-term', !on);
		}

		/// One notice beside the stream: a hole in the output, or a problem the
		/// session survived. Never written INTO the terminal — see the header.
		///
		/// It lies OVER the screen (see terminal.css) and can therefore be in the
		/// way of the very output it is about, so it carries a dismiss. What the
		/// dismiss does not do is take the fact away: the count stays in the state
		/// line for as long as the session lasts.
		function notice(line) {
			if (!els || !line) return;
			state.gaps++;
			render();
			var d = document.createElement('div');
			d.className = 'termp-gap';
			var msg = document.createElement('span');
			msg.textContent = line;
			var x = document.createElement('button');
			x.type = 'button';
			x.className = 'termp-gap-x';
			x.title = t('term.dismiss_notice');
			x.setAttribute('aria-label', t('term.dismiss_notice'));
			x.textContent = '✕';
			x.addEventListener('click', function () {
				if (d.parentNode) d.parentNode.removeChild(d);
			});
			d.appendChild(msg);
			d.appendChild(x);
			els.gaps.appendChild(d);
			// A session that keeps losing chunks would otherwise bury the screen.
			// The oldest go; the count in the state line is what survives, and it
			// counts every hole rather than the ones still on screen.
			while (els.gaps.childNodes.length > 4) els.gaps.removeChild(els.gaps.firstChild);
		}

		/// A bell, where the panel can be seen. The terminal flashes its own edge
		/// at the same moment; this is the same event at panel scale.
		function ring() {
			if (!els) return;
			els.panel.classList.add('bell');
			setTimeout(function () { els.panel.classList.remove('bell'); }, 1200);
		}

		/// The Start button says which of the two things it would do.
		function paintButtons() {
			if (!els) return;
			var k = sid ? 'term.restart' : 'term.start';
			if (els.start) {
				els.start.title = t(k);
				els.start.setAttribute('aria-label', t(k));
			}
			if (els.stop) {
				els.stop.title = t('term.stop');
				els.stop.setAttribute('aria-label', t('term.stop'));
			}
		}

		/// Build the terminal into the panel, once, on the first open.
		///
		/// Not at page load: a canvas, a screen model and a screen-reader mirror
		/// are not worth building for a panel nobody has asked for, and the grid
		/// is computed from a box that does not have a size until the panel is on
		/// screen.
		function make() {
			if (term) return term;
			var e = bind();
			if (!e || !window.DaimondTerminal) return null;
			term = DaimondTerminal.create(e.host, {
				label: t('term.label'),
				onData: function (u8) {
					// Bytes, exactly as typed. `DaimondPty.input` encodes them for
					// the wire itself; handing it base64 would send the base64.
					if (!sid) return;
					DaimondPty.input(sid, u8).catch(function (err) { say(msgOf(err), true); });
				},
				onResize: function (cols, rows) {
					size = { cols: cols, rows: rows };
					// A program asks the KERNEL how big its terminal is, so the pty
					// has to be told and told again. Before a session exists this
					// only records the size, which is then what the open asks for.
					if (!sid) return;
					DaimondPty.resize(sid, cols, rows).catch(function () { /* it has closed */ });
				},
				onTitle: function (s) {
					// A title is bytes a program chose. Control sequences are taken
					// out of it before it reaches the DOM, and its length is bounded:
					// the head is a line, not a paragraph.
					e.title.textContent = stripAnsi(String(s == null ? '' : s)).slice(0, 120);
				},
				onBell: ring,
			});
			return term;
		}

		/// The `open` request, composed on the Rust side.
		///
		/// **This is the whole of the fence question.** The page hands over what it
		/// knows — which Diamond, what the user attached, how big the screen is —
		/// and Rust answers with the request the wire carries, fence included, by
		/// the same `fence_spec` a `Tool::Run` goes through. Where that edge is
		/// missing the answer is a refusal, never a request this page filled in.
		async function request() {
			var b = { own_dir: '', attached: [], read_only: [], toolkits: [] };
			try { b = await Files.bounds(); } catch (e) { /* no Diamond open */ }
			var ask = {
				own_dir:   b.own_dir,
				attached:  b.attached,
				read_only: b.read_only,
				// The toolchains the user granted this Diamond. Without them a session
				// in a Diamond granted Rust met `cargo` as a refusal, because the fence
				// never named the toolchain and the hand clamps to what it was told.
				toolkits:  b.toolkits || [],
				cwd:       b.own_dir,
				cols:      size.cols,
				rows:      size.rows,
			};
			var fn = composer || (Wasm && Wasm.pty_request);
			if (typeof fn !== 'function') return { refused: t('term.no_composer') };
			var raw;
			try { raw = await fn(JSON.stringify(ask)); }
			catch (e) { return { refused: msgOf(e) }; }
			try { return JSON.parse(raw); }
			catch (e) { return { refused: t('term.unreadable_request') }; }
		}

		/// What a live session tells the panel.
		function subs() {
			return {
				onOutput: function (u8) { if (term) term.write(u8); },
				// The bytes still went through; what is said here is what is MISSING
				// from between them.
				onGap:    function (info) { notice((info && info.reason) || ''); },
				onError:  function (line) { notice(line); },
				onClosed: ended,
			};
		}

		/// Open a terminal for the Diamond on screen.
		async function start() {
			var e = bind();
			if (!e || starting || sid) return;
			starting = true;
			say(t('term.starting'));
			/// A refusal, shown as one: the sentence, and no empty screen under it.
			///
			/// The screen is hidden only HERE and never at the top of the attempt,
			/// because a hidden box measures nothing — the request would then ask
			/// the kernel for the minimum grid instead of the panel's.
			function refuse(line) {
				say(line, true);
				showScreen(false);
			}
			try {
				if (!window.DaimondPty) { refuse(t('term.no_relay_script')); return; }
				if (!make()) { refuse(t('term.no_renderer')); return; }
				// Ask before knocking. `status` is the one call that says "no hand
				// here" without putting an approval window in front of somebody who
				// has not installed anything, and its `reason` is the sentence the
				// relay or the hand already wrote for exactly this moment.
				var st = {};
				try { st = JSON.parse(await DaimondPty.status()); } catch (x) { st = {}; }
				if (!st.paired) { refuse(st.reason || t('term.not_paired')); return; }
				var req = await request();
				if (!req || req.refused) { refuse((req && req.refused) || t('term.no_composer')); return; }
				var live = await DaimondPty.open(req, subs())
					.then(function (v) { return { ok: v }; }, function (err) { return { err: msgOf(err) }; });
				if (live.err) { refuse(live.err); return; }
				sid   = live.ok.id;
				owner = diamondId();
				say(t('term.running'));
				showScreen(true);
				// The box may have come back from `display: none`, where it had no
				// size to measure. Re-fit before the program's first byte, or the
				// screen it draws is the minimum grid and not the panel's.
				if (term) term.fit();
				// The size the panel actually has, once more, now that there is a
				// kernel to tell: the grid may have been re-fitted while the approval
				// window was on screen, and a program that is never told draws to
				// whatever it was opened with.
				DaimondPty.resize(sid, size.cols, size.rows).catch(function () {});
			} finally {
				starting = false;
				paintButtons();
			}
		}

		/// Ask the program to stop. Asking, not insisting: a shell given SIGTERM
		/// writes out its history and one given SIGKILL does not.
		function stop() {
			if (!sid) { say(t('term.nothing_running')); return; }
			DaimondPty.close(sid, 'term').catch(function (err) { say(msgOf(err), true); });
		}

		/// Start one, or replace the one that is there.
		function restart() {
			if (!sid) { start(); return; }
			again = true;
			stop();
		}

		/// The session is over, one way or another.
		function ended(how) {
			sid = null;
			if (tearing) return;		// we ended it ourselves; there is nothing to report
			var line;
			if (how && how.refusal) line = how.refusal;
			else if (how && how.reason && (how.stopped || how.absent)) line = how.reason;
			else line = t('term.exited', { code: (how && typeof how.exit === 'number') ? how.exit : -1 });
			say(line, !!(how && (how.refusal || how.stopped || how.absent)));
			// And into the screen as well, where the output it belongs to is. This
			// is the terminal's own voice, not the program's — see `say` in
			// terminal.js — so it is the one thing written in that never came off
			// the wire.
			if (term) { try { term.say(line); } catch (e) { /* already destroyed */ } }
			paintButtons();
			if (again) { again = false; setTimeout(function () { start(); }, 0); }
		}

		/// Let go of everything: the program, the session and the screen.
		///
		/// Called when the panel closes, when the Diamond changes and when the app
		/// locks. The program is asked to stop and the session is then forgotten
		/// locally, which is what `forget` is for — the hand owns the process until
		/// the link itself goes.
		function teardown() {
			var id = sid;
			tearing = true;
			sid = null;
			owner = null;
			again = false;
			if (id && window.DaimondPty) {
				try { DaimondPty.close(id, 'term').catch(function () {}); } catch (e) { /* no link */ }
				try { DaimondPty.forget(id); } catch (e) { /* already gone */ }
			}
			if (term) { try { term.destroy(); } catch (e) { /* already gone */ } term = null; }
			if (els) {
				els.gaps.innerHTML = '';
				els.title.textContent = '';
				state.gaps = 0;
				say('');
				// Back to a panel that will measure itself: the next terminal built
				// into a hidden box would compute the minimum grid and keep it.
				showScreen(true);
			}
			tearing = false;
			paintButtons();
		}

		/// The panel has been shown.
		function onOpen() {
			var e = bind();
			if (!e) return;
			// A locked app holds none of the user's content on screen, and a
			// terminal is content twice over: what is on it, and a program still
			// running behind it.
			if (locked) { teardown(); return; }
			// A session belongs to the Diamond it was opened for. One that has
			// outlived its Diamond is torn down rather than re-labelled: its fence
			// was computed for the other one.
			if (sid && owner !== diamondId()) teardown();
			var first = !term;
			if (!make()) { say(t('term.no_renderer'), true); showScreen(false); return; }
			// The panel has just been given its size, and the grid is computed from
			// it. `fit` is what turns that into columns, rows and a SIGWINCH.
			term.fit();
			paintButtons();
			if (first) start();
		}

		/// The panel has been closed.
		function onClose() { teardown(); }

		/// The Diamond in focus changed.
		function onDiamondChanged() {
			if (!els) return;
			if (!sid && !term) return;
			var open = window.DaimondPanels && DaimondPanels.isOpen('term');
			teardown();
			// Locking clears the Diamond too, and that arrives here as a change. A
			// terminal started in answer to it would be a program launched by the act
			// of logging out.
			if (open && !locked) onOpen();
		}

		return {
			onOpen:  onOpen,
			onClose: onClose,
			onDiamondChanged: onDiamondChanged,
			/// Say the panel's own words again in a new language. The two buttons
			/// change their names as the session comes and goes, so they cannot wait
			/// for the next thing that rebuilds them — nothing does.
			relabel: paintButtons,
			/// Whether a session is live, for anything that reports on the app.
			session: function () { return sid; },
			/// Test only, and same-origin callers only.
			///
			/// It replaces the ONE call that reaches Rust for an `open` request, so
			/// that the panel's own wiring — bytes in, keystrokes out, a resize, a
			/// hole in the stream, an ending — can be driven without a machine hand
			/// on the far side. It is not a way to compose a fence in the page: what
			/// it stands in for is the Rust side's answer, and a caller that puts a
			/// fence of its own invention through here has tested its own fiction
			/// and nothing about this app.
			_setRequestForTest: function (fn) { composer = (typeof fn === 'function') ? fn : null; },
		};
	})();
	window.DaimondTerm = DaimondTerm;

	// Persist an FSA FileSystemDirectoryHandle across reloads.  Handles are
	// structured-cloneable, so IndexedDB can store them where localStorage
	// cannot.  A single "workspace" slot is kept (MVP: one active root).
	var FsaDB = (function () {
		// The stored real-folder handle is per account: a second person at this browser must not
		// reconnect to the first person's folder. The primary account keeps the plain name.
		var DB = 'daimond-fsa' + (window.DaimondAccounts ? (DaimondAccounts.opfsNs() ? '-' + DaimondAccounts.opfsNs() : '') : '');
		var STORE = 'handles', KEY = 'workspace';
		function open() {
			return new Promise(function (resolve, reject) {
				var req = indexedDB.open(DB, 1);
				req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
				req.onsuccess = function () { resolve(req.result); };
				req.onerror = function () { reject(req.error); };
			});
		}
		function tx(mode, fn) {
			return open().then(function (db) {
				return new Promise(function (resolve, reject) {
					var t = db.transaction(STORE, mode);
					var store = t.objectStore(STORE);
					var out = fn(store);
					t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : undefined); };
					t.onerror = function () { reject(t.error); };
				});
			});
		}
		return {
			save:  function (h) { return tx('readwrite', function (s) { s.put(h, KEY); }); },
			load:  function ()  { return tx('readonly',  function (s) { return s.get(KEY); }); },
			clear: function ()  { return tx('readwrite', function (s) { s.delete(KEY); }); },
		};
	})();

	// ── Diamonds / crystal / fold ────────────────────────────────────
	// A Diamond is a durable crystal the user steers and folds deltas into.
	// ── A Diamond runs on the model it was created with ──────────────
	//
	// Which model a Diamond thinks with is a browser-side choice about how to RUN it, not part of
	// the crystal it holds, so it lives in localStorage beside the app rather than in the Diamond's
	// own OPFS record -- and no Rust has to learn about it.
	var DIAMOND_MODELS_KEY = 'daimond-diamond-models';

	function diamondModels() { return readJson(DIAMOND_MODELS_KEY, {}) || {}; }

	/// Record what a Diamond thinks with, and what its workers think with.
	///
	/// `pick` carries every pair -- `{ provider, model, workerProvider, workerModel,
	/// visionProvider, visionModel }` -- so the one record travels in the parcel's Diamonds
	/// section as it always did, and a device on an older build simply arrives with the later
	/// halves empty.
	///
	/// The secondary is a MAP keyed by modality, not one pair: notes2 asks for a worker model
	/// per modality, and text and vision are the two the app can tell apart today. It is
	/// stored flat rather than nested because the record is already in the sync parcel and a
	/// nested object would have to be merged rather than adopted.
	///
	/// Fields absent from `pick` are left as they were, so a caller changing one model does
	/// not have to carry the other two -- the first version of this took the whole record and
	/// a dialog that set the worker model alone would have silently cleared the vision one.
	function setDiamondModel(id, pick) {
		if (!id || !pick) return;
		var all = diamondModels();
		var was = (all[id] && typeof all[id] === 'object') ? all[id] : {};
		var keep = function (field, given) {
			return (given === undefined || given === null) ? (was[field] || '') : (given || '');
		};
		var model = keep('model', pick.model);
		if (!model) return;                       // a Diamond with no primary is not a record
		all[id] = {
			provider:       keep('provider', pick.provider),
			model:          model,
			workerProvider: keep('workerProvider', pick.workerProvider),
			workerModel:    keep('workerModel', pick.workerModel),
			visionProvider: keep('visionProvider', pick.visionProvider),
			visionModel:    keep('visionModel', pick.visionModel),
		};
		try { localStorage.setItem(DIAMOND_MODELS_KEY, JSON.stringify(all)); } catch (e) { /* quota */ }
	}

	/// The model a Diamond runs on. A Diamond made before Diamonds had models falls back to the default,
	/// which is exactly what it was silently doing already.
	function diamondModel(id) {
		var m = diamondModels()[id];
		return m && m.model ? m : (window.DaimondModels ? DaimondModels.getDefault() : { provider: '', model: '' });
	}

	/// The model this Diamond's WORKERS run on: what the user chose for them, and otherwise the
	/// Diamond's own model.
	///
	/// Never the starred default. A worker used to be built straight out of `cfg` -- a view of
	/// whatever is starred -- so a Diamond deliberately pinned to a strong model fanned its workers
	/// out onto whatever the user happened to have starred, and the whole fan-out was billed to that
	/// provider's key. A Diamond made before this setting existed carries no worker model, and
	/// "absent" therefore has to mean the Diamond's own model: reading it as the default would
	/// preserve the defect for every Diamond that already exists.
	function diamondWorkerModel(id) {
		var m = diamondModels()[id];
		if (m && m.workerModel) {
			var r = window.DaimondModels
				&& DaimondModels.resolve(m.workerProvider || '', m.workerModel);
			// A worker model whose provider has since lost its key falls back to the Diamond's own
			// model, which is the one thing here already known to be able to run.
			if (r) return { provider: r.provider, model: r.model };
		}
		return diamondModel(id);
	}

	/// Which file extensions this app can actually hand a model as an image.
	///
	/// Not a general list of picture formats: it is exactly what `ImageMedia` in
	/// `src/protocol.rs` sniffs and will attach as a content part. A `.tiff` in a task is
	/// not an image as far as anything here is concerned, so routing that task to the
	/// vision model would spend the more expensive model on a file it will be handed as
	/// bytes anyway.
	var IMAGE_EXT = /\.(png|jpe?g|gif|webp)\b/i;

	/// Does this task look as though it will put an image in front of a model?
	///
	/// The signal available at dispatch, and the only one: `spawn_agent`'s schema is
	/// `{name, task}` and stays that way, because the model must never be the thing that
	/// decides what to spend money on. So the task TEXT is read for a path the daimon has
	/// named, which is how a daimon asks a worker to look at a screenshot.
	///
	/// It is a guess, and a guess in one direction only: a task that names no image runs on
	/// the text model, which is what every task did before there was a second one. What it
	/// can get wrong is a worker that discovers an image for itself, and that one is not
	/// knowable here at all.
	function taskWantsVision(task) {
		return IMAGE_EXT.test(String(task || ''));
	}

	/// The model this Diamond's workers run on for a task that carries an image.
	///
	/// Falls back to the text worker model, and says nothing clever about capability: there
	/// is no `vision` flag anywhere in `models.js`, so the app cannot check that the model
	/// the user chose can see, and pretending to would be worse than leaving the choice
	/// theirs. A Diamond with no vision model set falls back to the text one — the run says
	/// which model it got, so a fallback is visible rather than silent.
	function diamondVisionModel(id) {
		var m = diamondModels()[id];
		if (m && m.visionModel) {
			var r = window.DaimondModels
				&& DaimondModels.resolve(m.visionProvider || '', m.visionModel);
			if (r) return { provider: r.provider, model: r.model };
		}
		return diamondWorkerModel(id);
	}

	// ── A Diamond has two faces ──────────────────────────────────────
	//
	// Notes2, in the user's own words: *"The idea of just having a prompt box and
	// hiding the chat sequence doesn't work. We need to reconceptualise Daimond as
	// consisting of two types of chats, diamonds and chats, the first carrying context
	// and scope. So a diamond should offer the crystal view and a chat view."*
	//
	// The crystal is the daimon's OUTPUT. The chat is its conversation, and until now
	// there was not one: every steer built a fresh session, so the daimon could not be
	// asked a follow-up question, and an answer that changed no file went into a
	// dismissable box and was gone by the next steer. It is persistent now — the
	// conversation goes to the engine and comes back on every turn — and this is where
	// it is read.

	/// Which face this Diamond is showing. Per Diamond, beside the app: it is a fact
	/// about how you are working, not about the Diamond, and it should not travel to
	/// another device any more than a scroll position should.
	var DIAMOND_VIEW_KEY = 'daimond-diamond-view';

	function diamondViews() { return readJson(DIAMOND_VIEW_KEY, {}) || {}; }

	/// `'crystal'` or `'chat'`. Absent means crystal: the crystal is what a Diamond IS,
	/// and the chat is what you open when you want to see how it got there.
	function diamondView(id) {
		return diamondViews()[id] === 'chat' ? 'chat' : 'crystal';
	}

	function setDiamondView(id, view) {
		if (!id) return;
		var all = diamondViews();
		all[id] = (view === 'chat') ? 'chat' : 'crystal';
		try { localStorage.setItem(DIAMOND_VIEW_KEY, JSON.stringify(all)); } catch (e) { /* quota */ }
	}

	function forgetDiamondView(id) {
		var all = diamondViews();
		if (!(id in all)) return;
		delete all[id];
		try { localStorage.setItem(DIAMOND_VIEW_KEY, JSON.stringify(all)); } catch (e) { /* quota */ }
	}

	/// This Diamond's daimon conversation, made on first use.
	///
	/// An ordinary chat record with a `diamondId`, which buys the existing renderer,
	/// the existing store, the existing merge and the existing sync for nothing. What
	/// it deliberately does NOT get is a tile in the Chats rail: it is reached through
	/// its Diamond, because it is not a chat you started, it is a daimon you have been
	/// talking to.
	///
	/// Its model is not frozen at creation the way a chat's is. A Diamond's primary may
	/// be changed at any time (§1.3), so the record's model is refreshed from
	/// `diamondModel` whenever it is asked for — a stale pair here would meter the turn
	/// against a model the Diamond stopped using.
	function daimonChat(f) {
		if (!f || !f.id) return null;
		var rec = chats.find(function (c) { return c.diamondId === f.id; });
		var m = diamondModel(f.id);
		if (!rec) {
			rec = {
				id: 'c' + (seq++),
				diamondId: f.id,
				name: f.name || t('rail.unnamed_diamond'),
				app: null,                 // a daimon runs on `diamondApp`, never its own
				messages: [],
				model: m.model || '',
				provider: m.provider || '',
				status: 'active',
				promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0,
				prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0,
				lastPrompt: 0,
				updatedAt: 0,
			};
			chats.push(rec);
			persistChats();
		}
		rec.model = m.model || rec.model;
		rec.provider = m.provider || rec.provider;
		// The Diamond's name is the conversation's name. Renaming the Diamond has to
		// carry, or a merged store ends up with two records claiming one Diamond under
		// two names and no way to tell which is current.
		if (f.name && rec.name !== f.name) rec.name = f.name;
		return rec;
	}

	// ── Triggered actions, and what they leave for you to answer ─────
	//
	// `www/js/triggers.js` holds the decisions -- what a TA is, when one is due,
	// what text it sends, and whether the context goes with it. This is the half
	// that touches the world: the files, the clock, the daimon and the panel.
	//
	// The files are at `diamonds/<id>/triggers.json`, in the open where the
	// System section shows them, and they are the setting rather than a copy of
	// it: edit the file and the next tick reads what you wrote.

	function triggersPath(id) { return 'diamonds/' + id + '/triggers.json'; }

	/// Every Diamond's TAs, read once and kept, because a tick that opened a file
	/// per Diamond per minute would be a tick nobody could afford to leave on.
	/// Reloaded when the file changes under us -- a save, a sync, an agent edit --
	/// which is what `Triggers.reload` is for.
	var _triggers = {};       // diamondId -> { v, actions: [...] }

	var Triggers = {
		/// This Diamond's actions, from the cache.
		of: function (id) {
			return (_triggers[id] && _triggers[id].actions) || [];
		},

		/// Read one Diamond's file. An absent file means the defaults -- every
		/// Diamond has "Daimon Prompted" whether or not anyone has written it down.
		load: async function (id) {
			var raw = null;
			try {
				var text = await Wasm.store_read(triggersPath(id));
				if (text && text.trim()) raw = JSON.parse(text);
			} catch (e) { raw = null; }
			_triggers[id] = raw
				? DaimondTriggers.normalise(raw)
				: DaimondTriggers.defaults();
			return _triggers[id];
		},

		/// Read every Diamond's, for the tick and the pause tree.
		reload: async function () {
			var ids = (diamonds || []).map(function (f) { return f.id; });
			for (var i = 0; i < ids.length; i++) await Triggers.load(ids[i]);
			// A Diamond that has gone takes its cache with it, or the tree keeps a
			// branch for something nobody can reach.
			Object.keys(_triggers).forEach(function (id) {
				if (ids.indexOf(id) === -1) delete _triggers[id];
			});
			repaintPause();
		},

		/// Write one Diamond's file, through the store door so a folder open in the
		/// workspace cannot capture it.
		save: async function (id) {
			var rec = _triggers[id] || DaimondTriggers.defaults();
			await Wasm.store_write(triggersPath(id), JSON.stringify(rec, null, '\t') + '\n');
			bumpDiamonds();
			repaintPause();
		},

		/// Add, change or drop one action, and write the file.
		set: async function (id, action) {
			var rec = _triggers[id] || (_triggers[id] = DaimondTriggers.defaults());
			var i = rec.actions.findIndex(function (t) { return t.id === action.id; });
			if (i >= 0) rec.actions[i] = action; else rec.actions.push(action);
			await Triggers.save(id);
		},
		remove: async function (id, actionId) {
			var rec = _triggers[id];
			if (!rec) return;
			rec.actions = rec.actions.filter(function (t) { return t.id !== actionId; });
			try { DaimondPause.forget(DaimondTriggers.node(id, actionId)); }
			catch (e) { /* module not up */ }
			await Triggers.save(id);
		},

		/// Fire every action of every Diamond that this occasion is due on.
		///
		/// One turn per Diamond at most, however many of its actions matched: two
		/// instructions arriving as two turns is two bills and a daimon answering
		/// itself, and the second is what a conductor does when it is confused.
		fire: async function (occasion) {
			var ids = Object.keys(_triggers);
			for (var i = 0; i < ids.length; i++) {
				var id = ids[i];
				var f = (diamonds || []).find(function (x) { return x.id === id; });
				if (!f) continue;
				var owed = DaimondTriggers.due(id, Triggers.of(id), occasion);
				if (!owed.length) continue;
				// The Diamond's own model has to be able to run, exactly as a hand
				// steer checks. A trigger that opened the settings dialog on a timer
				// would be the worst possible moment to ask.
				if (!diamondCanRun(id)) continue;
				var t = owed[0];
				var msg = DaimondTriggers.compose(t, occasion.said);
				var went = await steerFromTrigger(f, msg.text);
				if (!went) continue;
				// Only now. A refused or failed dispatch must not consume the one
				// chance the context had to be delivered.
				if (msg.sentContext !== t.contextSent) {
					t.contextSent = msg.sentContext;
					await Triggers.save(id);
				}
			}
		},
	};

	// ── The two Diamonds that are there when you arrive ──────────────
	//
	// Notes2: "Lets create two default diamonds, 'Daimond Help' and 'Daimond
	// Optimiser'. They have no special functionality different to a user-created
	// diamond, and can be deleted by the user. Default diamonds start paused."
	//
	// Three things follow, and all three are the point:
	//
	//   * ORDINARY. They are made through `create_diamond` like any other, with
	//     an ordinary crystal and an ordinary daimon. Nothing reads a flag on
	//     them, and deleting one deletes it.
	//   * PAUSED. Seeded paused at the leaf (`seedPaused`), not by setting a
	//     branch — pause.js is explicit that a branch has no state and that
	//     something which must start paused is seeded when it is created.
	//   * ONCE. A user who deletes one has said something, and an app that put it
	//     back on the next boot would be arguing. The flag records that they were
	//     OFFERED, not that they exist.
	var DEFAULTS_KEY = 'daimond-defaults-seeded';

	var DEFAULT_DIAMONDS = [
		{
			name: 'Daimond Help',
			crystal: '# Daimond Help\n\n'
				+ 'Ask me how Daimond works and I will answer from what is actually here — '
				+ 'the panels, the tools, the settings — rather than from a manual.\n\n'
				+ '## What I know\n\n'
				+ '- Nothing yet. Press play, ask a question, and this fills in.\n',
			triggers: [],
		},
		{
			name: 'Daimond Optimiser',
			crystal: '# Daimond Optimiser\n\n'
				+ 'I watch how you are working and suggest changes: a Diamond that '
				+ 'wants splitting, a prompt that keeps being retyped, a model that is '
				+ 'costing more than it is earning.\n\n'
				+ '## What I have noticed\n\n'
				+ '- Nothing yet.\n',
			// Notes2 asks for this one specifically: "the Daimond Optimiser starts
			// with an inactive 'Minutes of User Activity' TA, set for every 30 min."
			// Inactive: `on: false`, and its pause leaf is seeded held as well, so
			// both the record and the tree say the same thing.
			triggers: [{
				kind: 'activity', minutes: 30, on: false,
				instruction: 'Look at what I have been working on and say, briefly, '
					+ 'one thing that would make it go better. If nothing stands out, say so '
					+ 'in one line and stop.',
			}],
		},
	];

	/// Offer the two default Diamonds, once per account.
	///
	/// This was withheld for a release. `migrate_root` (`src/wasm/diamond.rs`) used
	/// to REFUSE to move an older root -- `foci/`, `facets/` -- once `diamonds/`
	/// existed, and creating a Diamond is what makes `diamonds/` exist. So seeding
	/// two on the first boot of a fresh account made every LATER arrival of an old
	/// store -- a restored backup, a sync from an older device, a folder adopted
	/// afterwards -- unmigratable for ever, with the user's Diamonds in a directory
	/// nothing reads.
	///
	/// `migrate_root` now MERGES the entries that do not collide, so the act of
	/// creating a Diamond no longer strands anything. The two guards below stay:
	/// they were right on their own terms, and one of them still is.
	async function seedDefaultDiamonds() {
		try { if (localStorage.getItem(DEFAULTS_KEY) === '1') return; }
		catch (e) { return; }                       // private mode: never seed twice
		// Not on an empty app that has not finished booting: a create against a
		// store that is not up would leave a half-made Diamond.
		if (!window.DaimondPause || !window.DaimondTriggers) return;
		// ONLY INTO AN EMPTY RAIL, and this is not a nicety.
		//
		// `verify_diamondroot` caught the reason: a boot that is also MIGRATING an
		// older store -- adopting Diamonds from a folder, carrying pre-rename keys
		// across -- was left holding the two new Diamonds and not the one it was
		// migrating. Creating into a store that is mid-move is a way to lose a
		// user's work, and there is no version of this feature worth that.
		//
		// It is also the better rule on its own terms. Notes2 wants the two defaults
		// so that somebody arriving does not face an empty rail; a person who
		// already has thirteen Diamonds is not that person and does not want two
		// more. The flag is set either way, so this decision is taken once.
		if ((diamonds || []).length) {
			try { localStorage.setItem(DEFAULTS_KEY, '1'); } catch (e) { /* next boot asks again */ }
			return;
		}
		// AND NOT WHILE AN OLDER STORE IS STILL PART-MIGRATED.
		//
		// `migrate_root` now merges what does not collide, so creating a Diamond no
		// longer strands an old root, and this guard is no longer what stands between
		// this feature and data loss. What it still answers is narrower and true: an
		// id present in BOTH roots is one the merge deliberately left behind, and a
		// boot that is still resolving a user's own Diamonds is not a boot to put two
		// unasked ones into.
		//
		// The flag below is NOT set on this branch: the question has to be asked
		// again once the collision is gone. A Diamond the user creates themselves is
		// not affected -- they asked.
		try {
			if (await diamondApp().legacy_diamond_root_waiting()) return;
		} catch (e) { return; }     // an older wasm cannot answer; do not risk it
		try { localStorage.setItem(DEFAULTS_KEY, '1'); } catch (e) { return; }
		for (var i = 0; i < DEFAULT_DIAMONDS.length; i++) {
			var d = DEFAULT_DIAMONDS[i];
			if ((diamonds || []).some(function (f) { return f.name === d.name; })) continue;
			var id;
			try { id = await diamondApp().create_diamond(d.name); }
			catch (e) { continue; }                 // no store yet; the flag stops a retry loop
			try { await diamondApp().write_crystal(id, d.crystal); } catch (e) { /* empty is fine */ }
			// Held before it can ever run. Seeded at the leaf, so the Diamond's own
			// light reads red rather than a branch pretending to hold state.
			try { DaimondPause.seedPaused(DaimondPause.id('root', 'diamonds', id) + '/self'); }
			catch (e) { /* module not up */ }
			if (d.triggers.length) {
				var rec = DaimondTriggers.defaults();
				d.triggers.forEach(function (spec, n) {
					var ta = DaimondTriggers.blank(spec.kind);
					Object.keys(spec).forEach(function (k) { ta[k] = spec[k]; });
					ta.id = spec.kind + '-' + (n + 1);
					rec.actions.push(ta);
					try { DaimondPause.seedPaused(DaimondTriggers.node(id, ta.id)); }
					catch (e) { /* module not up */ }
				});
				_triggers[id] = rec;
				try { await Triggers.save(id); } catch (e) { /* it holds in memory */ }
			}
		}
		await loadDiamonds();
	}

	/// Is this Diamond's daimon held? The leaf, not the branch: a Diamond with a
	/// trigger paused and a daimon running is amber, and amber must not read as
	/// "you cannot type here".
	function diamondHeld(id) {
		if (!id) return false;
		try {
			return !!(window.DaimondPause
				&& DaimondPause.isPaused(DaimondPause.id('root', 'diamonds', id) + '/self'));
		} catch (e) { return false; }
	}

	/// One triggered action, in words. Used on its pause light and in its row, so
	/// the two say the same thing.
	function triggerLabel(ta) {
		if (ta.kind === 'prompted') return t('trig.prompted');
		if (ta.kind === 'activity') return t('trig.activity', { n: ta.minutes || 30 });
		if (ta.kind === 'mail') {
			return t('trig.mail', { folder: ta.folder || 'INBOX', mailbox: ta.mailbox || '?' });
		}
		return ta.kind;
	}

	// ── The clock a timer trigger counts on ──────────────────────────
	//
	// "N minutes of USER ACTIVITY". A timer on the wall clock would greet
	// somebody returning to an overnight tab with eight turns they did not ask
	// for and a bill to match, which is what this whole section of notes2 exists
	// to prevent. So the page reports signs of life and the clock counts only the
	// minutes something happened in.
	var TRIGGER_TICK_MS = 60000;

	function startTriggerClock() {
		if (!window.DaimondTriggers) return;
		// Mail arriving is the other occasion a TA fires on, and `mail.js`
		// announces it rather than calling here: mail must not have to know what a
		// triggered action is.
		window.addEventListener('daimond:mail-arrived', function (ev) {
			var d = (ev && ev.detail) || {};
			Triggers.fire({ kind: 'mail', mailbox: d.mailbox, folder: d.folder })
				.catch(function () { /* a failed trigger is not a failed sync */ });
		});
		['keydown', 'pointerdown', 'wheel'].forEach(function (ev) {
			window.addEventListener(ev, DaimondTriggers.noteActivity, { passive: true });
		});
		setInterval(async function () {
			DaimondTriggers.tickActivity(TRIGGER_TICK_MS);
			var mins = DaimondTriggers.activityMinutes();
			if (mins < 1) return;                    // nothing to be due yet
			var before = mins;
			await Triggers.fire({ kind: 'activity', minutes: mins });
			// Reset only when something was owed at this size, or the clock would
			// carry the same hour into every tick for the rest of the session and
			// fire the moment anything is added.
			var owed = Object.keys(_triggers).some(function (id) {
				return DaimondTriggers.due(id, Triggers.of(id),
					{ kind: 'activity', minutes: before }).length > 0;
			});
			if (owed) DaimondTriggers.resetActivity();
		}, TRIGGER_TICK_MS);
	}

	/// Run one daimon turn on behalf of a trigger, wherever the user happens to be.
	///
	/// Returns whether the turn was actually started. A trigger fires into a
	/// Diamond that may not be the one on screen, and `doSteer` works on
	/// `currentDiamond` -- so this is where the two meet, and it refuses rather
	/// than steering the wrong Diamond.
	async function steerFromTrigger(f, text) {
		if (crystalBusy) return false;              // a turn is already running
		if (currentDiamond && currentDiamond.id !== f.id) {
			// Deliberately not switching the user's screen. A timer that moved the
			// centre out from under somebody mid-sentence is worse than a turn that
			// waits for the next tick.
			return false;
		}
		if (!currentDiamond) await selectDiamond(f);
		await doSteer(text);
		return true;
	}

	/// Can this Diamond actually think? That is a question about ITS provider's key, not the starred
	/// provider's -- and they are not always the same one.
	function diamondCanRun(id) {
		var m = diamondModel(id);
		return !!(window.DaimondModels && DaimondModels.resolve(m.provider, m.model));
	}

	// The crystal agent and reducer run through a DaimondApp per model configuration. The pure OPFS
	// operations (create/list/read/write/log/fold_apply) work on any instance, so a placeholder
	// provider is fine when none is configured.
	//
	// Cached by the configuration rather than by the Diamond: two Diamonds on the same model are the
	// same client, and DaimondApp has no setter for its model -- changing one means building one.
	var _diamondApps     = {};           // "provider model" -> DaimondApp
	var _diamondAppModel = new Map();    // DaimondApp -> the model id it runs, for the ledger
	// And whose key it runs on. A ledger entry without it cannot be attributed to a provider, and
	// a live rate captured from that provider cannot be preferred over the baked-in table.
	var _diamondAppProvider = new Map(); // DaimondApp -> the provider id
	function diamondApp(diamondId, pick) {
		var m = pick && pick.model ? pick : diamondModel(diamondId);
		var a = appCfgFor(m);
		var k = (a.provider || '') + ' ' + (a.model || '');
		if (_diamondApps[k]) return _diamondApps[k];

		var app;
		var base = a.baseUrl || 'http://127.0.0.1/v1/chat/completions';
		try {
			app = new DaimondApp(base, a.apiKey || '', a.model || 'none',
				maxOutFor(a.model, a.provider), SYSTEM_PROMPT(), true);
			// A Diamond's daimon, likewise.
			try { DaimondModels.noteUse(a.provider, a.model); } catch (e) { /* never block a turn */ }
		} catch (e) {
			app = new DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none',
				AUTO_MAX, SYSTEM_PROMPT(), true);
		}
		// The conductor's and the reducer's system prompts are composed in Rust,
		// so the house rules are handed across rather than baked into the ctor.
		try { app.set_instructions(Instructions.md); } catch (e) { /* ignore */ }
		// How big this model's window is, exactly as a chat and a worker are told (see
		// `ensureApp`). Without it a Diamond's daimon folded against the agent's ASSUMED
		// default rather than the model's published one — and `adopt_limits` hands whatever
		// this app holds to every worker the daimon dispatches, so one wrong figure here
		// became the wrong figure for the whole team. A null means nobody publishes a window
		// and the agent's own assumption is the better guess.
		try {
			var cw = window.DaimondPricing
				? DaimondPricing.contextWindow(a.model || '', a.provider || '')
				: null;
			if (cw && app.set_context_window) app.set_context_window(cw);
		} catch (e) { /* an older wasm build has no setter */ }
		applyRoundLimit(app);
		applyFoldSettings(app, a.provider || '');
		applyCrystalCap(app);
		_diamondApps[k] = app;
		_diamondAppModel.set(app, a.model || '');
		_diamondAppProvider.set(app, a.provider || '');
		return app;
	}

	/// Forget the built clients. A key that has just changed -- or been locked away -- must not go
	/// on being used by a client that closed over the old one.
	function resetDiamondApps() {
		_diamondApps = {};
		_diamondAppModel = new Map();
		_diamondAppProvider = new Map();
		_diamondMeter = new Map();
	}

	/// A short relative-time label from an epoch-ms value. Spoken through the
	/// sync.when_* keys, which every locale already carries -- the hard-coded
	/// English here was the one line of the app a translated drawer still
	/// showed raw.
	function relTime(ms) {
		if (!ms) return '';
		var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
		if (s < 60) return t('sync.when_just_now');
		var m = Math.round(s / 60);
		if (m < 60) return t('sync.when_mins', { n: m });
		var h = Math.round(m / 60);
		if (h < 24) return t('sync.when_hours', { n: h });
		return t('sync.when_days', { n: Math.round(h / 24) });
	}

	/// Reload the Diamonds list from the store and re-render the rail.
	async function loadDiamonds() {
		try {
			var json = await diamondApp().list_diamonds();
			diamonds = JSON.parse(json);
		} catch (e) { diamonds = []; }
		renderDiamondList();
		// The triggers travel with the Diamonds: the pause tree needs a leaf per
		// action, and the tick needs to know what is armed. Read here rather than
		// on a timer, because this is every occasion on which the set can change.
		try { await Triggers.reload(); } catch (e) { /* the module is not up */ }
	}

	/// A Diamond's tags, tolerating the Diamonds written before tags existed.
	function tagsOf(f) {
		return Array.isArray(f && f.tags) ? f.tags : [];
	}

	// The hues a tag chip can take: a fixed spread rather than the raw hash,
	// so two tags rarely land on near-indistinguishable colours.
	var TAG_HUES = [10, 40, 75, 145, 190, 220, 265, 315];

	/// A tag's hue, hashed from its name, so one tag is one colour everywhere
	/// and stays that colour across reloads. Only the hue is chosen here; the
	/// theme supplies saturation and lightness (see `.tag-chip` in app.css),
	/// so each theme keeps its own contrast.
	function tagHue(tag) {
		var h = 0;
		for (var i = 0; i < tag.length; i++) {
			h = ((h << 5) - h + tag.charCodeAt(i)) | 0;   // 31*h + c, 32-bit
		}
		// The low bits of that hash barely move between short similar strings,
		// and a remainder takes exactly those bits -- unmixed, 'project' and
		// 'topic' come out the same colour. Stir the high bits down first.
		h ^= h >>> 15;
		h = Math.imul(h, 0x85ebca6b) | 0;
		h ^= h >>> 13;
		return TAG_HUES[Math.abs(h) % TAG_HUES.length];
	}

	/// One tag chip. With an `onclick` it is a button, otherwise inert text.
	/// The caller sets the title, because what a chip does depends on where
	/// it sits: the rail filters, the editor adds.
	function tagChip(tag, cls, onclick) {
		var el = document.createElement(onclick ? 'button' : 'span');
		el.className = 'tag-chip' + (cls ? ' ' + cls : '');
		el.style.setProperty('--tag-h', tagHue(tag));
		el.textContent = tag;                      // escaped via textContent (H5)
		if (onclick) {
			el.addEventListener('click', function (e) { e.stopPropagation(); onclick(tag); });
		}
		return el;
	}

	/// Is any tag filter on at all?
	function tagFiltering() {
		return tagInc.length > 0 || tagExc.length > 0;
	}

	/// Does a Diamond's tag set survive the boolean the rail is holding?
	///
	/// An exclusion is absolute: a tag you have said you do not want to see hides
	/// its Diamond however well the rest of it matches, so "not this one" cannot
	/// be talked round by an inclusion. Past that, an empty include list includes
	/// everything, and two or more included tags combine as the mode says.
	function tagsPass(tags) {
		for (var i = 0; i < tagExc.length; i++) {
			if (tags.indexOf(tagExc[i]) !== -1) return false;
		}
		if (tagInc.length === 0) return true;
		if (tagMode === 'any') {
			return tagInc.some(function (t) { return tags.indexOf(t) !== -1; });
		}
		return tagInc.every(function (t) { return tags.indexOf(t) !== -1; });
	}

	/// Does a Diamond survive the tag filter? A search over names stood beside
	/// this and has gone: the rail is one screen of Diamonds you named yourself,
	/// and what it is filed under is the question worth asking of it.
	function diamondMatches(f) {
		return tagsPass(tagsOf(f));
	}

	/// Which list a tag is in: 'inc', 'exc', or '' for neither.
	function tagState(tag) {
		if (tagInc.indexOf(tag) !== -1) return 'inc';
		if (tagExc.indexOf(tag) !== -1) return 'exc';
		return '';
	}

	/// One click on a tag chip in the rail, cycling that tag through the three
	/// things it can be -- off, wanted, unwanted -- and round to off again.
	///
	/// The three branches are exclusive and each MOVES the tag rather than
	/// copying it, so a tag can never be in both lists -- which is why nothing
	/// downstream has to decide what "include and exclude the same tag" would
	/// mean. Clicked from a Diamond box the last leg is out of reach, since
	/// refusing a tag takes every Diamond carrying it off the rail and the chip
	/// goes with them; the standing pool under the rail's head holds all three,
	/// because it is drawn from the store rather than from the rail.
	function cycleTagFilter(tag) {
		var i = tagInc.indexOf(tag), j = tagExc.indexOf(tag);
		if (i !== -1) { tagInc.splice(i, 1); tagExc.push(tag); }   // wanted -> unwanted
		else if (j !== -1) { tagExc.splice(j, 1); }                // unwanted -> off
		else { tagInc.push(tag); }                                 // off -> wanted
		renderDiamondList();
	}

	/// Take a tag out of the filter altogether, whichever list it was in. Not a
	/// leg of the cycle: it is what a tag being DELETED does on its way out, so
	/// a filter is never left holding a tag that no longer exists.
	function dropTagFilter(tag) {
		tagInc = tagInc.filter(function (t) { return t !== tag; });
		tagExc = tagExc.filter(function (t) { return t !== tag; });
		renderDiamondList();
	}

	/// How two or more included tags combine. Kept, because it is a habit of
	/// reading rather than a thing being looked at.
	function setTagMode(mode) {
		tagMode = mode === 'any' ? 'any' : 'all';
		try { localStorage.setItem(TAG_MODE_KEY, JSON.stringify(tagMode)); } catch (e) { /* best effort */ }
		renderDiamondList();
	}

	// ── Agents panel: find and filter, mirroring the Diamonds rail ──────────
	// A flat list with chips, deliberately not a Diamond→children tree: the
	// tree's height is more than the dock can spare, and the parent a run
	// belongs to already rides on the run, as a chip.

	/// The Diamond a run belongs to, looked up live, or null.
	function agentDiamondOf(run) {
		if (!run || !run.diamondId) return null;
		for (var i = 0; i < diamonds.length; i++) if (diamonds[i].id === run.diamondId) return diamonds[i];
		return null;
	}

	/// A run's tags: the tags of the Diamond that started it. A worker has none
	/// of its own, so it borrows its Diamond's -- which is what lets one tag
	/// vocabulary filter both rails.
	function agentTagsOf(run) {
		return tagsOf(agentDiamondOf(run));
	}

	/// One Diamond chip on a run's tile: names the parent, and filters to it.
	function agentDiamondChip(run) {
		var el = document.createElement('button');
		el.className = 'tag-chip diamond-chip' + (agentDiamondFilter === run.diamondId ? ' tag-active' : '');
		el.style.setProperty('--tag-h', tagHue(run.diamondName || ''));
		el.textContent = '↳ ' + (run.diamondName || t('agents.no_diamond'));
		el.title = run.diamondId
			? t('agents.only_from', { name: run.diamondName })
			: t('agents.no_diamond_help');
		if (run.diamondId) el.addEventListener('click', function (e) { e.stopPropagation(); setAgentDiamondFilter(run.diamondId); });
		return el;
	}

	/// Does a run survive the agents search box and its filter chip? Name,
	/// task, Diamond name, model and inherited tags are searched.
	function agentMatches(run) {
		if (agentDiamondFilter && run.diamondId !== agentDiamondFilter) return false;
		if (agentTagFilter && agentTagsOf(run).indexOf(agentTagFilter) === -1) return false;
		if (!agentQuery) return true;
		var hay = [run.name, run.task, run.diamondName, shortModel(run.model)]
			.concat(agentTagsOf(run)).join(' ').toLowerCase();
		return hay.indexOf(agentQuery) !== -1;
	}

	/// Filter the panel to one Diamond (toggles off if it is already the filter).
	function setAgentDiamondFilter(diamondId) {
		agentDiamondFilter = (agentDiamondFilter === diamondId) ? null : diamondId;
		agentTagFilter = null;   // one filter at a time, as the rail has one
		Workers.render();
	}

	/// Filter the panel to one tag (toggles off if it is already the filter).
	function setAgentTagFilter(tag) {
		agentTagFilter = (agentTagFilter === tag) ? null : tag;
		agentDiamondFilter = null;
		Workers.render();
	}

	/// The active agents filter, as one removable chip beside the search box,
	/// so the list never quietly hides a run without saying why.
	/// A small pause / resume / stop button for an agent tile, echoing the
	/// header controls: a glyph and a label, wired to the given action.
	function actBtn(kind, label, title, fn) {
		var b = document.createElement('button');
		b.className = 'abtn a-' + kind;
		var glyph = kind === 'pause' ? '⏸' : kind === 'play' ? '▶' : '✕';
		b.textContent = glyph + ' ' + label;
		b.title = title;
		b.addEventListener('click', fn);
		return b;
	}

	/// Show a plain-language tally of what the agents are doing, so a fan-out's
	/// cost is legible at a glance: how many are running, paused and queued.
	function updateAgentStat(nRun, nPause, nQueue) {
		var el = document.getElementById('agents-stat');
		if (!el) return;
		var parts = [];
		if (nRun)   parts.push(nRun + ' running');
		if (nPause) parts.push(nPause + ' paused');
		if (nQueue) parts.push(nQueue + ' queued');
		el.textContent = parts.join(' · ');
		el.style.display = parts.length ? '' : 'none';
	}

	/// Enable each header control only when it has something to act on, and hide
	/// the group when there are no live or paused agents at all.
	function updateAgentControls(nRun, nPause, nQueue) {
		var grp = document.getElementById('agents-ctl');
		if (!grp) return;
		var active = nRun + nQueue;
		setAgc('agents-pause', active > 0);
		setAgc('agents-play',  nPause > 0);
		setAgc('agents-stop',  active + nPause > 0);
		grp.classList.toggle('holding', workersHeld() && nPause > 0);
		grp.style.display = (active + nPause) > 0 ? '' : 'none';
	}
	function setAgc(id, on) {
		var b = document.getElementById(id);
		if (b) b.disabled = !on;
	}

	function renderAgentFilter() {
		if (!agentFilter) return;
		agentFilter.innerHTML = '';
		if (!agentDiamondFilter && !agentTagFilter) { agentFilter.style.display = 'none'; return; }
		agentFilter.style.display = '';
		var chip;
		if (agentDiamondFilter) {
			var f = null, id = agentDiamondFilter;
			for (var i = 0; i < diamonds.length; i++) if (diamonds[i].id === id) { f = diamonds[i]; break; }
			var label = f ? f.name : t('agents.a_diamond');
			chip = document.createElement('button');
			chip.className = 'tag-chip tag-active diamond-chip';
			chip.style.setProperty('--tag-h', tagHue(label));
			chip.textContent = '↳ ' + label;
			chip.title = t('agents.clear_diamond_filter');
			chip.addEventListener('click', function () { setAgentDiamondFilter(id); });
		} else {
			var tag = agentTagFilter;
			chip = tagChip(tag, 'tag-active', function () { setAgentTagFilter(tag); });
			chip.title = t('tag.clear_filter', { tag: tag });
		}
		var x = document.createElement('span'); x.className = 'tag-x'; x.textContent = '×';
		x.setAttribute('aria-hidden', 'true');
		chip.setAttribute('aria-label', chip.title);
		chip.appendChild(x);
		agentFilter.appendChild(chip);
	}

	/// Every tag the pool has to offer: the ones in use across the store, plus
	/// any the filter is holding.
	///
	/// The second half is what keeps a REFUSED tag reachable. Refusing one takes
	/// every Diamond carrying it off the rail, so a pool drawn from the rail
	/// would lose the chip along with them and leave the refusal on with nothing
	/// to click. Read from the store instead, and the chip stays where it was.
	///
	/// Alphabetical, not by how often a tag is used. This row is standing
	/// furniture in a fixed place, and a frequency order reshuffles it exactly
	/// when it is being looked at -- file one Diamond and the chip you reached
	/// for last time has moved. The tag editor's pool sorts the same way, so one
	/// tag sits in one place in both.
	function tagPool() {
		var seen = {};
		diamonds.forEach(function (f) { tagsOf(f).forEach(function (x) { seen[x] = 1; }); });
		tagInc.forEach(function (x) { seen[x] = 1; });
		tagExc.forEach(function (x) { seen[x] = 1; });
		return Object.keys(seen).sort(function (a, b) { return a.localeCompare(b); });
	}

	/// One chip in the standing pool: the tag, and the state the rail holds it
	/// in, drawn by the theme.
	function poolChip(tag) {
		var st  = tagState(tag);
		var cls = 'tag-pool' + (st === 'inc' ? ' tag-inc' : st === 'exc' ? ' tag-no' : '');
		var chip = tagChip(tag, cls, cycleTagFilter);
		// The title says what the NEXT click does rather than what the chip is: a
		// chip already filtering looks like it has nothing left to give.
		chip.title = st === 'inc' ? t('tag.exclude_next', { tag: tag })
			: st === 'exc' ? t('tag.clear_exclude', { tag: tag })
			: t('tag.only_diamonds', { tag: tag });
		// Both marks are drawn in CSS (see `.tag-inc` and `.tag-no`) rather than
		// set as text: a chip's textContent is the tag, and the rail, the filter
		// and the search all read it. Someone who cannot see the mark is told
		// which state it is in, in words.
		if (st === 'inc') chip.setAttribute('aria-label', t('tag.exclude_next', { tag: tag }));
		if (st === 'exc') chip.setAttribute('aria-label', t('tag.not_tagged', { tag: tag }));
		return chip;
	}

	/// How two or more included tags combine, as two words with one of them on.
	/// Both are shown rather than one label that toggles: a lone word cannot say
	/// whether it is the state or the action, and the alternative stays visible.
	function tagModeControl() {
		var grp = document.createElement('span');
		grp.className = 'tag-mode';
		grp.setAttribute('role', 'group');
		grp.setAttribute('aria-label', t('tag.mode_aria'));
		[['all', 'tag.mode_all', 'tag.mode_all_help'],
		 ['any', 'tag.mode_any', 'tag.mode_any_help']].forEach(function (m) {
			var b = document.createElement('button');
			b.className = 'tag-mode-btn' + (tagMode === m[0] ? ' on' : '');
			b.dataset.mode = m[0];
			b.textContent = t(m[1]);
			b.title = t(m[2]);
			b.setAttribute('aria-pressed', tagMode === m[0] ? 'true' : 'false');
			b.addEventListener('click', function (e) { e.stopPropagation(); setTagMode(m[0]); });
			grp.appendChild(b);
		});
		return grp;
	}

	/// Put the whole filter down at once.
	function tagClearAll() {
		var b = document.createElement('button');
		b.className = 'tag-clear-all';
		b.textContent = t('tag.clear_all');
		b.title = t('tag.clear_all_help');
		b.addEventListener('click', function () {
			tagInc = [];
			tagExc = [];
			renderDiamondList();
		});
		return b;
	}

	function tagfRow(cls) {
		var d = document.createElement('div');
		d.className = 'tagf-row ' + cls;
		return d;
	}

	/// The one row the pool sits behind: what the feature is called, how many
	/// tags are in it, and which way the next click goes.
	///
	/// The whole row is the target rather than the words. A rail is 250px of
	/// mostly empty space to the right of a short label, and a hit area that
	/// stops at the last letter is a control that gets missed.
	///
	/// The chevron is two borders on an empty box (see `.tagf-chev`), not a
	/// character. An arrow typed into the label would be one absent glyph away
	/// from saying nothing at all, and it would ride in the row's textContent,
	/// where the count is read.
	function tagPoolToggle(n) {
		var b = document.createElement('button');
		b.className = 'tagf-toggle';
		b.setAttribute('aria-expanded', tagPoolOpen ? 'true' : 'false');
		b.title = tagPoolOpen ? t('tag.pool_hide_help') : t('tag.pool_show_help');
		var chev = document.createElement('span');
		chev.className = 'tagf-chev';
		chev.setAttribute('aria-hidden', 'true');
		var lab = document.createElement('span');
		lab.className = 'tagf-label';
		lab.textContent = t('tag.pool_toggle', { n: n });
		b.appendChild(chev);
		b.appendChild(lab);
		b.addEventListener('click', function () { setTagPoolOpen(!tagPoolOpen); });
		return b;
	}

	/// Open or close the pool, and keep the choice. Only the filter is repainted:
	/// which Diamonds show has not changed, and repainting the rail under a
	/// disclosure would flicker the list for nothing.
	function setTagPoolOpen(open) {
		tagPoolOpen = !!open;
		try { localStorage.setItem(TAG_POOL_KEY, JSON.stringify(tagPoolOpen)); } catch (e) { /* best effort */ }
		renderTagFilter();
		// That paint replaced the row the click landed on, so focus would be left
		// on nothing and a keyboard could not close what it had just opened.
		var b = diamondFilter && diamondFilter.querySelector('.tagf-toggle');
		if (b) b.focus();
	}

	/// The tag filter, under the rail's head: one row naming it, the pool of every
	/// tag in use behind that, and each chip cycling off -> wanted -> refused ->
	/// off where it sits. It is now the only way the rail narrows, the search box
	/// that stood above it having gone.
	///
	/// A POOL rather than a summary of what is on. A summary is only drawn once
	/// something has been clicked, so the only way IN was a chip on a Diamond
	/// box -- and a reader who went looking at the top of the rail for the filter
	/// found nothing there at all. The pool says what the vocabulary is before
	/// anything is touched, each chip carries its own state in place, and a
	/// refused tag stays put even though its Diamonds have left the rail. That
	/// makes the separate wanted and refused rows redundant -- they said in a
	/// second place what a chip now says where it is -- so what is left below the
	/// pool is only what is NOT a tag: how the wanted ones combine, and the one
	/// click that puts the whole thing down.
	///
	/// What the pool could not be is PERMANENT. Thirty tags is three and a half
	/// rows of chips paid for out of the rail's two lists on every screen, whether
	/// anything is being filtered or not, so it collapses -- and what stands in
	/// its place is a row that names it and counts it, because the fault it was
	/// built to fix was a feature being read as absent.
	///
	/// Collapsed, a filter that is ON still speaks: the chips holding it come out
	/// and stand on their own. A rail hiding Diamonds for a reason it will not
	/// give is the same fault one size worse, and the alternative -- forcing the
	/// pool open whenever anything filters -- hands the reader's own choice back
	/// to them on the click that needed it least.
	function renderTagFilter() {
		if (!diamondFilter) return;
		// A pool taller than its cap scrolls, and a repaint that lost the scroll
		// would throw the reader back to the top on every click.
		var was  = diamondFilter.querySelector('.tagf-pool');
		var top  = was ? was.scrollTop : 0;
		diamondFilter.innerHTML = '';
		var pool = tagPool();
		if (!pool.length) {
			diamondFilter.style.display = 'none';
			fitTagFilter();
			return;
		}
		diamondFilter.style.display = '';
		diamondFilter.appendChild(tagPoolToggle(pool.length));
		if (tagPoolOpen) {
			var row = document.createElement('div');
			row.className = 'tagf-pool';
			row.setAttribute('role', 'group');
			row.setAttribute('aria-label', t('tag.all'));
			pool.forEach(function (tag) { row.appendChild(poolChip(tag)); });
			diamondFilter.appendChild(row);
			row.scrollTop = top;
		} else if (tagFiltering()) {
			// The same chips, from the same call, in the same order -- only fewer
			// of them. Nothing here is a second surface to keep in step with the
			// pool: a chip in this row IS a pool chip, standing somewhere else.
			var act = tagfRow('tagf-active');
			act.setAttribute('role', 'group');
			act.setAttribute('aria-label', t('tag.active_aria'));
			pool.forEach(function (tag) { if (tagState(tag)) act.appendChild(poolChip(tag)); });
			diamondFilter.appendChild(act);
		}
		if (tagFiltering()) {
			var ctl = tagfRow('tagf-ctl');
			// Offered only where it can change the answer: with one wanted tag
			// ALL and ANY name the same list, and a control that does nothing is
			// one more thing the reader has to rule out.
			if (tagInc.length > 1) ctl.appendChild(tagModeControl());
			// Offered for a filter of any size. A pool chip has no closer -- its
			// text is the tag and nothing else -- so putting one tag down takes
			// two clicks round the cycle, and this is the one that does it in one.
			ctl.appendChild(tagClearAll());
			diamondFilter.appendChild(ctl);
		}
		fitTagFilter();
	}

	/// The filter is rail furniture, and the two lists below share what the
	/// furniture leaves. It wraps when the chips outrun the rail's width, takes a
	/// row when something is filtering, and takes or gives back the whole pool
	/// when the disclosure is worked; every one of those changes the height, which
	/// otherwise comes off the Chats list alone and quietly moves the divider. So
	/// say what a window resize says -- but only when the height really moved,
	/// since a filter is changed far more often than the furniture around it.
	var tagFilterH = 0;         // the filter's height at its last paint
	function fitTagFilter() {
		if (!diamondFilter) return;
		var h = diamondFilter.offsetHeight;
		if (h === tagFilterH) return;
		tagFilterH = h;
		railFurnitureChanged();
	}

	/// Does any Diamond carry any tag at all?
	function anyTagged() {
		return diamonds.some(function (f) { return tagsOf(f).length > 0; });
	}

	/// The rail's honest empty state for tags.
	///
	/// Every tag chip in the rail is drawn from a Diamond, so a store with no tag
	/// on anything draws no chip anywhere and the rail head has nothing under it --
	/// which reads as a filing system that was removed rather than one that is
	/// empty. Say which, in one quiet line, and take it away the moment a tag
	/// exists -- which is the moment the standing pool takes its place. It sits
	/// beside the pool rather than inside it: a pool chip's text is read as a
	/// tag name, and a sentence in there would be read as one.
	function renderTagHint() {
		if (!diamondFilter || !diamondFilter.parentNode) return;
		var hint = document.getElementById('diamond-tag-hint');
		var was  = !!hint && hint.style.display !== 'none';   // on screen a moment ago
		var want = diamonds.length > 0 && !anyTagged();
		if (!want) {
			if (hint) hint.style.display = 'none';
			if (was) railFurnitureChanged();
			return;
		}
		if (!hint) {
			hint = document.createElement('div');
			hint.id = 'diamond-tag-hint';
			hint.className = 'rail-tag-hint';
			diamondFilter.parentNode.insertBefore(hint, diamondFilter.nextSibling);
		}
		hint.textContent = t('rail.tag_hint');
		// Where to go and what is waiting there, for the reader who wants it.
		// The starter tags are named from the list itself, so a translated hint
		// cannot promise chips in words the pool does not offer.
		hint.title = t('rail.tag_hint_help', { tags: starterTags().join(', ') });
		hint.style.display = '';
		if (!was) railFurnitureChanged();
	}

	/// The rail's two lists share what the furniture above them leaves, and the
	/// share is cut into pixels once. A line appearing or going takes that
	/// height off the Chats list alone and quietly moves the divider, so say
	/// what a window resize says: cut it again.
	function railFurnitureChanged() {
		try { if (window.DaimondPanels) DaimondPanels.reflow(); } catch (e) { /* the layout is not up yet */ }
	}

	function renderDiamondList() {
		diamondList.innerHTML = '';
		renderTagFilter();
		renderTagHint();
		if (diamonds.length === 0) {
			var note = document.createElement('div');
			note.className = 'rail-note';
			note.textContent = t('rail.no_diamonds');
			diamondList.appendChild(note);
			repaintPause();
			return;
		}
		// Already most-recently-updated first: `list_diamonds` sorts on `updated`.
		var shown = diamonds.filter(diamondMatches);
		if (shown.length === 0) {
			var none = document.createElement('div');
			none.className = 'rail-note';
			none.textContent = t('rail.no_match');
			diamondList.appendChild(none);
			repaintPause();
			return;
		}
		shown.forEach(function (f) { diamondList.appendChild(diamondBox(f)); });
		updateActiveDiamond();
		// A Diamond appearing or going moves the root and the section above it,
		// and neither of those lights is rebuilt here.
		repaintPause();
	}

	/// Delete a Diamond, asking first. THE way a Diamond is removed by hand.
	///
	/// Lifted out of the closer cross it used to hang on, because Delete now sits
	/// at the foot of the tile's dialog and there must be exactly one path that
	/// asks, forgets the arrangement, forgets the pause flags and lays the
	/// tombstone. Resolves true when the Diamond went.
	async function deleteDiamond(f) {
		if (!await confirmDialog(t('rail.delete_diamond_body', { name: f.name }),
			t('rail.delete_diamond'), { title: t('rail.delete_diamond') })) return false;
		// A deleted Diamond's arrangement has nothing left to restore, and the
		// layout blob is rewritten whole on every change, so leaving it would
		// grow the write for ever.
		DaimondPanels.forgetArrangement(f.id);
		// And its pause flags, for the same reason: a leaf id nobody can reach
		// keeps the Diamonds section — and the root above it — amber for ever,
		// and travels in every sync parcel for the life of the account.
		try { DaimondPause.forget(DaimondPause.id('root', 'diamonds', f.id)); }
		catch (e) { /* module not up */ }
		forgetTilePrefs(f.id);
		forgetDiamondView(f.id);
		// The daimon's conversation goes with its daimon. Left behind it would be a
		// chat record with no tile, no Diamond and no way to reach it, sitting in
		// IndexedDB and travelling in every sync parcel for the life of the account —
		// and `daimonChat` would hand it back if the id were ever reused.
		var dchat = chats.find(function (c) { return c.diamondId === f.id; });
		if (dchat) removeChat(dchat);
		try {
			await diamondApp().delete_diamond(f.id);
		} catch (e2) {
			noticeDialog(t('rail.delete_failed'), friendlyError(e2));
			return false;
		}
		// Before the rail is redrawn, so the next push carries the deletion:
		// without a tombstone the other device still holds this Diamond and
		// simply hands it back on the following pull.
		diamondTombstone(f.id);
		if (currentDiamond && currentDiamond.id === f.id) {
			currentDiamond = null;
			signalDiamondChanged();
			sessionNameEl.textContent = t('chat.no_chat');
			showCentre('chat');
			renderEmptyState();
		}
		bumpDiamonds();
		loadDiamonds();
		return true;
	}

	function diamondBox(f) {
		var active = currentDiamond && f.id === currentDiamond.id;
		var box = document.createElement('div');
		box.className = 'session-box diamond-box' + (active ? ' active' : '');
		box.dataset.id = f.id;
		// How much of itself this tile draws — the cog's dialog sets it.
		box.dataset.detail = tileDetail(f.id);
		// The row IS the control, so it has to be one to the keyboard and to a
		// screen reader as well as to the pointer. It was a div with a click
		// handler whose only focusable child was the x that deletes it, so
		// tabbing the rail reached "delete this Diamond" twice and "open this
		// Diamond" never: the destructive act had a keyboard route and the
		// central one did not.
		box.setAttribute('role', 'button');
		box.setAttribute('tabindex', '0');
		box.setAttribute('aria-label', f.name || t('rail.unnamed_diamond'));
		if (active) box.setAttribute('aria-current', 'true');
		box.addEventListener('keydown', function (e) {
			if (e.key !== 'Enter' && e.key !== ' ') return;
			// Not when the press belongs to something inside the row -- the cog,
			// the light, or a tag chip -- which answer for themselves.
			if (e.target !== box) return;
			e.preventDefault();
			box.click();
		});
		var header = document.createElement('div');
		header.className = 'session-box-header';
		// The Diamond's own traffic light, bound to the branch that carries its
		// daimon and (from phase H) its triggered actions — so a Diamond with a
		// trigger paused and a daimon running reads amber here without anyone
		// having to set amber anywhere.
		mountPause(header, DaimondPause.id('root', 'diamonds', f.id),
			f.name || t('rail.unnamed_diamond'));
		var name = document.createElement('span');
		name.className = 'session-box-name';
		name.textContent = f.name;                 // escaped via textContent (H5)
		name.title = t('rail.dblclick_rename');
		name.addEventListener('dblclick', async function (e) {
			e.stopPropagation();
			var nn = await promptDialog(t('rail.rename_diamond'), { value: f.name, okLabel: t('rail.rename') });
			if (nn === null) return; nn = nn.trim();
			if (!nn || nn === f.name) return;
			diamondApp().rename_diamond(f.id, nn).then(function () { f.name = nn; bumpDiamonds(); loadDiamonds(); })
				.catch(function (e2) { noticeDialog(t('rail.rename_failed'), friendlyError(e2)); });
		});
		header.appendChild(name);
		header.appendChild(tileCog(f.name, function () {
			openTileDialog({
				id:   f.id,
				name: f.name,
				// The BRANCH, not the `self` leaf: a Diamond's control stands for
				// its daimon and (from phase H) its triggered actions together, so
				// one with a trigger held and a daimon running reads amber here
				// without anyone having set amber anywhere.
				node: DaimondPause.id('root', 'diamonds', f.id),
				// A Diamond's models may be changed after it is made; a chat's may not.
				models:   'diamond',
				onDelete: function () { return deleteDiamond(f); },
			});
		}));
		var meta = document.createElement('div');
		meta.className = 'session-box-meta';
		var ver = document.createElement('span');
		ver.className = 'session-box-ctx';
		ver.textContent = 'v' + (f.crystal_version || 0);
		meta.appendChild(ver);
		// What this Diamond thinks with. Stored since Diamonds had models and drawn
		// nowhere, so two Diamonds deliberately put on different models looked identical
		// on the rail — and a fan-out is billed to this pair. Detail, so Simple hides it
		// with the other model controls; the cog's dialog is where it is changed.
		var dm = diamondModel(f.id);
		if (dm && dm.model) {
			var mchip = document.createElement('span');
			mchip.className = 'tile-model-chip diamond-model';
			mchip.textContent = shortModel(dm.model);
			mchip.title = t('tile.diamond_model_help', { model: dm.model });
			meta.appendChild(mchip);
		}
		if (f.updated) {
			var upd = document.createElement('span');
			upd.className = 'session-box-time';
			upd.textContent = relTime(f.updated);
			meta.appendChild(upd);
		}
		// Tags sit with the other plain facts of the Diamond. Only the first few
		// show, so one heavily-filed Diamond cannot push the rest off the rail;
		// a Diamond with no tags adds nothing here and looks exactly as it did
		// before tags existed.
		// A fold proposed but not yet answered. The diff lives in the centre, which
		// may be showing something else entirely by the time the reducer returns, so
		// the row says there is something here to come back to.
		if (pendingFolds[f.id]) {
			var pend = document.createElement('span');
			pend.className = 'diamond-pending';
			pend.textContent = t('fold.pending_badge');
			pend.title = t('fold.pending_badge_help');
			meta.appendChild(pend);
		}
		var tags = tagsOf(f);
		tags.slice(0, TAG_CHIPS_SHOWN).forEach(function (tag) {
			// A Diamond only reaches the rail if it passed the filter, so a chip
			// here is either off or included -- never excluded. The title says
			// what the next click does rather than what the chip is, because a
			// chip that already filters looks like it has nothing left to give.
			var on   = tagState(tag) === 'inc';
			var chip = tagChip(tag, 'tag-sm' + (on ? ' tag-inc' : ''), cycleTagFilter);
			chip.title = on ? t('tag.exclude_next', { tag: tag }) : t('tag.only_diamonds', { tag: tag });
			meta.appendChild(chip);
		});
		if (tags.length > TAG_CHIPS_SHOWN) {
			var more = document.createElement('span');
			more.className = 'tag-more';
			more.textContent = '+' + (tags.length - TAG_CHIPS_SHOWN);
			more.title = tags.slice(TAG_CHIPS_SHOWN).join(', ');
			meta.appendChild(more);
		}
		box.appendChild(header); box.appendChild(meta);
		box.addEventListener('click', function () {
			selectDiamond(f);
			if (isMobile()) mshow('ai');
		});
		return box;
	}

	function updateActiveDiamond() {
		diamondList.querySelectorAll('.diamond-box').forEach(function (box) {
			box.classList.toggle('active', currentDiamond && box.dataset.id === currentDiamond.id);
		});
	}

	/// The AI panel's own two faces: the chat thread, and a Diamond's crystal.
	///
	/// A document and a message used to be shown HERE, in place of the chat —
	/// so reading your mail meant leaving the conversation. They are stage
	/// panels now, and open beside it.
	/// `'chat'` — an ordinary chat. `'focus'` — a Diamond's crystal. `'daimon'` — a
	/// Diamond's conversation, which uses the chat's own thread and composer.
	function showCentre(mode) {
		centreMode = mode;
		var crystalOn = (mode === 'focus');
		var onDiamond = crystalOn || mode === 'daimon';
		crystalView.style.display  = crystalOn ? 'flex' : 'none';
		chatOutputEl.style.display = crystalOn ? 'none' : '';
		chatInputBar.style.display = crystalOn ? 'none' : '';
		// Which face is up, said in the panel's own shape: the crystal wears the
		// mark and squares its corners against the rounded chrome everywhere else.
		// A daimon's chat is a conversation, so it wears neither.
		var ai = document.getElementById('panel-ai');
		if (ai) ai.classList.toggle('crystal-face', crystalOn);
		var mark = document.getElementById('chead-mark');
		if (mark) mark.style.display = crystalOn ? '' : 'none';
		// The face switch belongs to a Diamond and nothing else: a chat has one face,
		// and a switch offering it a second would be a control that does nothing.
		var sw = document.getElementById('diamond-view');
		if (sw) {
			sw.style.display = onDiamond ? '' : 'none';
			var cb = document.getElementById('dview-crystal');
			var hb = document.getElementById('dview-chat');
			if (cb) cb.setAttribute('aria-pressed', crystalOn ? 'true' : 'false');
			if (hb) hb.setAttribute('aria-pressed', crystalOn ? 'false' : 'true');
		}
	}

	/// Show one mail message on the stage, beside the chat — so it can be read
	/// and asked about at the same time.
	///
	/// The body is set as text, never as markup. A mail body is the least
	/// trustworthy string in the application, and this is the only place one
	/// meets the DOM.
	/// Render one message the way a mail client does: a header block you can actually read the
	/// sender out of, the body, and the files that came with it.
	///
	/// HTML mail is a stranger's markup. It is never inserted into this document — it is written
	/// into a sandboxed iframe with no scripts, no access to our origin, and a content policy that
	/// refuses every remote load. That last part is not only about safety: a remote image in a mail
	/// is a tracking pixel, and fetching it tells the sender you opened their message. So pictures
	/// stay off until the reader asks for them, exactly as every other mail client does.
	function showMessage(v) {
		var head = document.getElementById('msg-head');
		var body = document.getElementById('msg-body');
		if (!head || !body) return;

		var title = document.getElementById('msg-title');
		if (title) title.textContent = v.subject || t('panel.msg');

		// ── The header block ───────────────────────────────────
		head.innerHTML = '';
		var subj = document.createElement('div');
		subj.className = 'msg-subject';
		subj.textContent = v.subject || t('mail.no_subject');
		head.appendChild(subj);

		var who = document.createElement('div');
		who.className = 'msg-who';
		var from = v.from || { name: '', addr: '' };
		var nm = document.createElement('span');
		nm.className = 'msg-name';
		nm.textContent = from.name || from.addr || t('msg.unknown_sender');
		who.appendChild(nm);
		if (from.name && from.addr) {
			var ad = document.createElement('span');
			ad.className = 'msg-addr';
			ad.textContent = '<' + from.addr + '>';
			who.appendChild(ad);
		}
		if (v.date) {
			var dt = document.createElement('span');
			dt.className = 'msg-date';
			dt.textContent = fmtMailDate(v.date);
			who.appendChild(dt);
		}
		head.appendChild(who);

		[[t('compose.to'), v.to], [t('compose.cc'), v.cc], [t('msg.reply_to'), v.replyTo]].forEach(function (row) {
			if (!row[1]) return;
			var d = document.createElement('div');
			d.className = 'msg-line';
			d.innerHTML = '<span class="msg-lbl"></span><span class="msg-val"></span>';
			d.querySelector('.msg-lbl').textContent = row[0];
			d.querySelector('.msg-val').textContent = row[1];
			head.appendChild(d);
		});

		// The verbs sit on the message, where the reader is when they decide to answer it.
		if (v.reply) {
			var acts = document.createElement('div');
			acts.className = 'msg-acts';
			var verbs = [[t('msg.reply'), v.reply]];
			if (v.canReplyAll) verbs.push([t('msg.reply_all'), v.replyAll]);
			verbs.push([t('msg.forward'), v.forward]);
			verbs.forEach(function (verb) {
				var b = document.createElement('button');
				b.className = 'msg-act';
				b.textContent = verb[0];
				b.addEventListener('click', verb[1]);
				acts.appendChild(b);
			});
			head.appendChild(acts);
		}

		if (v.attachments && v.attachments.length) {
			var box = document.createElement('div');
			box.className = 'msg-atts';
			v.attachments.forEach(function (att) {
				var chip = document.createElement('button');
				chip.className = 'msg-att';
				chip.title = t('msg.save_help');
				chip.textContent = att.name + ' · ' + fmtBytes(att.size);
				chip.addEventListener('click', async function () {
					chip.disabled = true;
					try {
						var path = await v.save(att);
						chip.textContent = t('msg.saved_to', { path: path });
						chip.classList.add('done');
					} catch (e) {
						chip.textContent = t('msg.save_failed', { name: att.name });
						chip.disabled = false;
					}
				});
				box.appendChild(chip);
			});
			head.appendChild(box);
		}

		// ── The body ───────────────────────────────────────────
		body.innerHTML = '';
		if (v.html) {
			var bar = document.createElement('div');
			bar.className = 'msg-blocked';
			bar.innerHTML = '<span>' + esc(t('msg.pictures_blocked')) + '</span>';
			var btn = document.createElement('button');
			btn.textContent = t('msg.load_pictures');
			bar.appendChild(btn);

			var frame = document.createElement('iframe');
			frame.className = 'msg-frame';
			// No scripts, and no access to our origin: the message cannot reach the API key in
			// localStorage, the workspace, or this document. Links open in a new tab.
			frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
			frame.setAttribute('referrerpolicy', 'no-referrer');

			function paint(withPictures) {
				var csp = withPictures
					? "default-src 'none'; img-src https: data: cid:; style-src 'unsafe-inline'; font-src data:"
					: "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
				frame.srcdoc =
					'<!doctype html><html><head><meta charset="utf-8">'
					+ '<meta http-equiv="Content-Security-Policy" content="' + csp + '">'
					+ '<base target="_blank">'
					+ '<style>html,body{margin:0;padding:14px 16px;background:#fff;color:#111;'
					+ 'font:14px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;'
					+ 'word-break:break-word;overflow-wrap:anywhere}'
					+ 'img{max-width:100%;height:auto}table{max-width:100%}'
					+ 'a{color:#0b57d0}</style></head><body>' + v.html + '</body></html>';
			}
			btn.addEventListener('click', function () { paint(true); bar.remove(); });
			paint(false);

			body.appendChild(bar);
			body.appendChild(frame);
		} else {
			var pre = document.createElement('div');
			pre.className = 'msg-text';
			pre.textContent = v.text || t('msg.no_text');
			body.appendChild(pre);
		}

		DaimondPanels.show('msg');
		DaimondPanels.reflow();
	}

	/// Write a message, on the stage, beside the daimon.
	///
	/// The panel owns the fields and the attachments; the mail module owns the draft — its
	/// `Message-ID`, and the message it answers — and gets both back when the user acts.
	/// Nothing here composes a message and nothing here speaks SMTP: it collects what the
	/// person typed and hands it over.
	///
	/// Send is deliberately the one button in Daimond that no agent can reach. A message
	/// once sent cannot be recalled, and an agent that has just read the user's mail has
	/// read a stranger's words: a `mail_send` tool would be a straight path from a
	/// sentence in an inbox to a message in the user's name. So the agent may write a
	/// draft into the workspace, and a person presses this.
	function showCompose(v) {
		var d      = v.draft || {};
		var from   = document.getElementById('compose-from');
		var to     = document.getElementById('compose-to');
		var cc     = document.getElementById('compose-cc');
		var subj   = document.getElementById('compose-subject');
		var text   = document.getElementById('compose-text');
		var attBox = document.getElementById('compose-atts');
		var note   = document.getElementById('compose-note');
		var title  = document.getElementById('compose-title');
		if (!from || !to || !text) return;

		var atts = (d.attachments || []).slice();

		from.innerHTML = '';
		(v.from || []).forEach(function (addr) {
			var o = document.createElement('option');
			o.value = addr;
			o.textContent = addr;
			if (addr === d.from) o.selected = true;
			from.appendChild(o);
		});
		to.value   = d.to || '';
		cc.value   = d.cc || '';
		subj.value = d.subject || '';
		text.value = d.body || '';
		note.textContent = '';
		note.className = 'compose-note';
		title.textContent = d.subject
			? t(d.inReplyTo ? 'msg.reply' : 'compose.draft') + ' · ' + d.subject
			: t('compose.new_message');

		function fields() {
			return {
				from:        from.value,
				to:          to.value,
				cc:          cc.value,
				subject:     subj.value,
				body:        text.value,
				attachments: atts,
			};
		}
		function say(msg, bad) {
			note.textContent = msg;
			note.className = 'compose-note' + (bad ? ' err' : '');
		}
		function paintAtts() {
			attBox.innerHTML = '';
			atts.forEach(function (att, i) {
				var chip = document.createElement('button');
				chip.className = 'compose-att';
				chip.title = t('compose.remove_attachment');
				chip.textContent = att.name + ' · ' + fmtBytes(att.size) + ' ×';
				chip.addEventListener('click', function () {
					atts.splice(i, 1);
					paintAtts();
				});
				attBox.appendChild(chip);
			});
		}
		paintAtts();

		var send    = document.getElementById('compose-send');
		var save    = document.getElementById('compose-save');
		var attach  = document.getElementById('compose-attach');
		var file    = document.getElementById('compose-file');
		var discard = document.getElementById('compose-discard');

		// Each showing rebinds, so the buttons are replaced rather than added to: a listener
		// left over from the last draft would send this one to the wrong person.
		[send, save, attach, discard].forEach(function (b) {
			var n = b.cloneNode(true);
			b.parentNode.replaceChild(n, b);
		});
		send    = document.getElementById('compose-send');
		save    = document.getElementById('compose-save');
		attach  = document.getElementById('compose-attach');
		discard = document.getElementById('compose-discard');

		function busy(on) {
			[send, save, attach, discard].forEach(function (b) { b.disabled = on; });
		}

		send.addEventListener('click', async function () {
			var f = fields();
			if (!f.to.trim()) { say(t('compose.err_no_to'), true); return; }
			var ok = await confirmDialog(
				t('compose.send_body', { from: f.from }),
				t('compose.send'), { title: t('compose.send_title'), danger: false });
			if (!ok) return;
			busy(true);
			say('Sending…');
			try {
				var j = await v.send(f);
				var cost = j && j.charged_minor ? ' · ' + DaimondGateway.fmtMoney(j.charged_minor, 'usd') : '';
				say('Sent.' + cost);
				if (v.sent) v.sent('Sent to ' + f.to + '.' + cost);
				DaimondPanels.hide('compose');
				DaimondPanels.reflow();
			} catch (e) {
				say(friendlyError(e), true);
			} finally {
				busy(false);
			}
		});

		save.addEventListener('click', async function () {
			busy(true);
			try {
				var path = await v.save(fields());
				say('Saved to ' + path);
			} catch (e) {
				say(friendlyError(e), true);
			} finally {
				busy(false);
			}
		});

		attach.addEventListener('click', function () { file.click(); });
		file.addEventListener('change', async function () {
			var picked = [].slice.call(file.files || []);
			for (var i = 0; i < picked.length; i++) {
				var f = picked[i];
				var buf = await f.arrayBuffer();
				atts.push({
					name:  f.name,
					type:  f.type || 'application/octet-stream',
					size:  buf.byteLength,
					bytes: new Uint8Array(buf),
				});
			}
			file.value = '';
			paintAtts();
		});

		discard.addEventListener('click', async function () {
			var ok = await confirmDialog(t('compose.discard_body'),
				t('compose.discard'), { title: t('compose.discard_title'), danger: true });
			if (!ok) return;
			await v.discard();
			DaimondPanels.hide('compose');
			DaimondPanels.reflow();
		});

		DaimondPanels.show('compose');
		DaimondPanels.reflow();
		(d.to ? text : to).focus();
	}

	/// A mail date as a person writes one, falling back to the header verbatim when it will not
	/// parse — a date we cannot read is still a date the reader may recognise.
	function fmtMailDate(s) {
		var d = new Date(s);
		if (isNaN(d.getTime())) return s;
		return d.toLocaleString(undefined, {
			weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
			hour: '2-digit', minute: '2-digit',
		});
	}

	function fmtBytes(n) {
		if (!n) return '0 B';
		var u = ['B', 'KB', 'MB', 'GB'], i = 0;
		while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
		return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
	}

	/// Ask for a mailbox. The IMAP host and port are guessed from the address,
	/// and both stay editable — a guess is not a fact, and plenty of people
	/// read mail at a domain their provider does not own.
	function mailDialog(presets, unreachable) {
		var noteEl = null;
		function apply(address, inputs, note) {
			noteEl = note;
			var at = String(address || '').lastIndexOf('@');
			var dom = at < 0 ? '' : address.slice(at + 1).toLowerCase().trim();
			if (!dom) return;
			if (unreachable[dom]) {
				note.className = 'dlg-note err';
				note.textContent = t(unreachable[dom]);
				return;
			}
			var p = presets[dom];
			note.className = 'dlg-note';
			var set = function (k, val) {
				if (inputs[k] && !inputs[k].dataset.touched) inputs[k].value = String(val);
			};
			if (p) {
				set('host', p.host);
				set('port', p.port);
				// Reading and sending are different servers, so the dialog asks for both and
				// guesses both. A mailbox that could be read but not answered would be half a
				// mail client.
				set('smtpHost', p.smtpHost);
				set('smtpPort', p.smtpPort);
				// The note is provider guidance, from a table in this file — not
				// anything the user or a server said.
				note.innerHTML = p.note ? t(p.note) : '';
			} else {
				note.textContent = t('mail.add.guess', { domain: dom });
				set('host', 'imap.' + dom);
				set('smtpHost', 'smtp.' + dom);
			}
		}
		// In the pane, so the user can ask Daimond what an app password is \u2014 and read
		// the answer \u2014 while the box asking for one is still on screen.
		return DaimondAdmin.form({
			kind:  'form',
			title: t('mail.add.title'),
			message: t('mail.add.lead'),
			okLabel: t('mail.add.ok'),
			fields: [
				{ name: 'address',  label: t('mail.add.address'), placeholder: 'you@example.com',
				  hint: function (v, inputs, note) { apply(v, inputs, note); } },
				{ name: 'password', label: t('mail.add.password'), placeholder: t('mail.add.password_ph'), secret: true },
				{ name: 'host',     label: t('mail.add.imap'),    placeholder: 'imap.example.com' },
				{ name: 'port',     label: t('mail.add.port'),    placeholder: '993', value: '993' },
				{ name: 'smtpHost', label: t('mail.add.smtp'),    placeholder: 'smtp.example.com' },
				{ name: 'smtpPort', label: t('mail.add.port'),    placeholder: '587', value: '587' },
			],
			onInit: function (inputs, note) {
				noteEl = note;
				['host', 'port', 'smtpHost', 'smtpPort'].forEach(function (k) {
					if (inputs[k]) inputs[k].addEventListener('input', function () {
						inputs[k].dataset.touched = '1';
					});
				});
			},
			validate: function (v) {
				if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.address)) return t('mail.add.err_address');
				var dom = v.address.slice(v.address.lastIndexOf('@') + 1).toLowerCase();
				if (unreachable[dom]) return t(unreachable[dom]);
				if (!v.password) return t('mail.add.err_password');
				if (!v.host) return t('mail.add.err_imap');
				var p = parseInt(v.port, 10);
				if (p !== 993 && p !== 143) return t('mail.add.err_port');
				v.port = p;
				if (!v.smtpHost) return t('mail.add.err_smtp');
				var s = parseInt(v.smtpPort, 10);
				if (s !== 587 && s !== 465) return t('mail.add.err_smtp_port');
				v.smtpPort = s;
				return '';
			},
		});
	}

	/// Show a compiled PDF on the stage, beside the chat.
	///
	/// It used to render inside the ~260px Workspace panel, where a page's body
	/// text is about three pixels tall, while the widest panel in the app sat
	/// empty. Compiling a chapter and then reading it is the whole point of the
	/// Typst loop, so the document goes where there is room to read it — and now
	/// with the daimon still beside it, to be asked about what it says.
	function showDoc(name, url) {
		var e = document.getElementById('doc-embed');
		var n = document.getElementById('doc-name');
		var v = document.getElementById('doc-view');
		if (!e || !n) return;
		// A PDF and a text file are two renderings of one panel, not two panels.
		// The text view steps aside rather than being torn down, so closing the
		// PDF does not lose the file it was compiled from.
		if (v) v.style.display = 'none';
		e.style.display = '';
		e.src = url;
		n.textContent = name;
		Files.syncLineNo();                  // the text view has stepped aside
		DaimondPanels.markUsed('doc');       // it now has something to hold
		DaimondPanels.show('doc');
		DaimondPanels.reflow();
	}

	/// Create a Diamond, on a model the user chose.
	///
	/// A Diamond runs the conductor and the reducer -- it thinks, and it is billed for thinking --
	/// so which model it runs is as much a decision as it is for a chat. It used to be no decision
	/// at all: a Diamond silently took whichever model happened to be starred, and starring a
	/// different one later moved every Diamond onto it.
	async function createDiamond() {
		var d = window.DaimondModels ? DaimondModels.getDefault() : { provider: '', model: '' };
		var vals = await dialog({
			kind: 'form',
			title: t('rail.new_diamond'),
			okLabel: t('rail.create'),
			fields: [
				{ name: 'name',  label: t('rail.name'),  value: peekDiamondLabel() },
				{ name: 'model', label: t('rail.model'), kind: 'models', provider: d.provider, value: d.model },
				// Below the model, because it is a second decision about money: this Diamond's
				// daimon dispatches workers, and a fan-out is several turns at once.
				{ name: 'workerModel', label: t('rail.worker_model'), kind: 'models',
					title: t('rail.worker_model_help'), provider: d.provider, value: d.model },
			],
			// The worker pulldown follows the Diamond's own model until the user moves it
			// themselves, so "defaults to the Diamond's model" holds while the dialog is still
			// being filled in rather than only at the instant it opened.
			onInit: function (inputs) {
				var m = inputs.model, w = inputs.workerModel;
				if (!m || !w) return;
				w.addEventListener('change', function () { w._chosen = true; });
				m.addEventListener('change', function () {
					if (w._chosen) return;
					var p = DaimondModels.pick(m);
					DaimondModels.fillSelect(w, p.provider || '', p.model || '');
				});
			},
			validate: function (v) {
				if (!v.name) return t('rail.err_name');
				if (!v.model || !v.model.model) return t('rail.err_model');
				if (!DaimondModels.resolve(v.model.provider, v.model.model)) {
					return t('rail.err_no_key');
				}
				// A worker model on a provider with no readable key would fall back to the
				// Diamond's own model at dispatch and silently ignore what was chosen here.
				if (v.workerModel && v.workerModel.model
					&& !DaimondModels.resolve(v.workerModel.provider, v.workerModel.model)) {
					return t('rail.err_no_key_worker');
				}
				return '';
			},
		});
		if (!vals) return;
		var name = vals.name.trim();

		var id;
		try {
			// create_diamond is a pure OPFS write -- no model is consulted -- so any instance will
			// do. The model matters from the Diamond's first *thought*, which is why it is recorded
			// against the Diamond rather than handed to this call.
			id = await diamondApp().create_diamond(name);
			takeDiamondLabel();
		} catch (e) {
			noticeDialog(t('rail.create_failed'), friendlyError(e));
			return;
		}
		var w = vals.workerModel || {};
		setDiamondModel(id, {
			provider:       vals.model.provider,
			model:          vals.model.model,
			workerProvider: w.provider || '',
			workerModel:    w.model || '',
		});
		bumpDiamonds();
		// Creating something is the user saying "show me this now". A search
		// string or a tag filter left over from a moment ago can hide the new
		// Diamond behind "No Diamonds match", which reads exactly like the
		// create having done nothing -- so the rail is cleared to show it.
		clearDiamondFilters();
		await loadDiamonds();
		var f = diamonds.find(function (x) { return x.id === id; });
		if (f) { selectDiamond(f); }
		else {
			// The store took the write and then would not read it back. That is
			// storage trouble, not a no-op, and saying nothing is how a user comes
			// to believe their Diamond vanished and makes it again.
			noticeDialog(t('rail.created_unreadable'),
				t('rail.created_unreadable_body', { name: name }));
		}
		if (isMobile()) mshow('ai');
	}

	/// Put the rail's tag filter down. Nothing is remembered: a filter is a way of
	/// looking, not a setting.
	function clearDiamondFilters() {
		tagInc = [];
		tagExc = [];
	}

	async function selectDiamond(f, view) {
		currentDiamond = f;
		signalDiamondChanged();
		updateActiveDiamond();
		sessionNameEl.textContent = f.name;
		aiMeter.textContent = 'crystal v' + (f.crystal_version || 0)
			+ (f.updated ? ' · ' + relTime(f.updated) : '');
		var want = (view === 'chat' || view === 'crystal') ? view : diamondView(f.id);
		if (view) setDiamondView(f.id, want);
		// A Diamond that carries an arrangement is worked in it. Only an arrangement
		// the user deliberately saved exists, so this never closes a panel behind
		// their back on a Diamond they never arranged.
		DaimondPanels.restoreArrangement(f.id);

		if (want === 'chat') {
			// `current` IS the daimon's record here, and that is the point: every
			// machinery the thread has — the renderer, the queue, the interject box,
			// the copy control, `_generating` — reads `current`, and pointing it at the
			// daimon's conversation is what makes all of it work without a second copy.
			// The turn itself still goes through `steer_crystal`, because a daimon's
			// tools and fence are not a chat's; `sendUserMessage` is where the two part.
			var rec = daimonChat(f);
			current = rec;
			curAsstDiv = null; curAsstText = ''; lastToolBlock = null;
			updateActiveSession();
			showCentre('daimon');
			renderHistory(rec.messages);
			// A thread with nothing in it reads as a thing that is broken rather than
			// a thing that has not started. Say which -- and say what the two faces
			// are FOR, since this is the moment somebody has just found the second one.
			if (!rec.messages.length) {
				var blank = document.createElement('div');
				blank.className = 'chat-msg chat-msg-empty';
				blank.textContent = t('crystal.chat_empty');
				chatOutput.appendChild(blank);
			}
			syncComposer();
			return;
		}
		current = null;                            // a Diamond's crystal is not a chat
		updateActiveSession();                     // clear chat highlight
		showCentre('focus');
		// A proposal left pending on this Diamond is restored rather than lost.
		if (pendingFolds[f.id]) renderFoldDiff(f.id);
		else await renderCrystal();
	}

	/// Read the current crystal and render it (markdown) plus the steer and
	/// fold controls.  H5: crystal markdown passes through DaimondRender.md's
	/// sanitiser; no untrusted string reaches innerHTML unescaped.
	async function renderCrystal() {
		if (!currentDiamond) return;
		var md = '';
		try { md = await diamondApp().read_crystal(currentDiamond.id); }
		catch (e) { md = ''; }
		crystalBody.innerHTML = '';

		// The crystal is the user's own document, so it carries the two things a
		// document needs: a way to edit it by hand, and a way back. An accepted
		// fold overwrites the crystal wholesale, and until now that was final —
		// no undo, no history, no hand-edit, though every version was being
		// snapshotted to disk all along.
		var bar = document.createElement('div');
		bar.className = 'crystal-bar';
		var edit = document.createElement('button');
		edit.className = 'crystal-act';
		edit.textContent = '✎ ' + t('files.edit');
		edit.addEventListener('click', function () { editCrystal(md); });
		var hist = document.createElement('button');
		hist.className = 'crystal-act';
		hist.textContent = '↺ ' + t('crystal.history');
		hist.addEventListener('click', showCrystalHistory);
		var tagsBtn = document.createElement('button');
		tagsBtn.className = 'crystal-act';
		tagsBtn.textContent = '# ' + t('crystal.tags');
		tagsBtn.title = t('crystal.tags_help');
		tagsBtn.addEventListener('click', showTagEditor);
		bar.appendChild(edit); bar.appendChild(hist); bar.appendChild(tagsBtn);
		crystalBody.appendChild(bar);

		var content = document.createElement('div');
		content.className = 'chat-msg-content';
		if (md && md.trim()) {
			content.innerHTML = DaimondRender.md(md);  // sanitised (H5)
		} else {
			var empty = document.createElement('div');
			empty.className = 'crystal-empty';
			empty.textContent = t('crystal.empty');
			content.appendChild(empty);
		}
		crystalBody.appendChild(content);
		renderCrystalControls();
		renderArtefacts();          // fills the strip, or leaves it hidden at zero
	}

	/// Hand-edit the crystal. `write_crystal` snapshots a version and logs the edit,
	/// so a hand-edit is as recoverable as a fold.
	function editCrystal(md) {
		crystalBody.innerHTML = '';
		var ta = document.createElement('textarea');
		ta.className = 'crystal-edit';
		ta.value = md || '';
		ta.spellcheck = false;

		var bar = document.createElement('div');
		bar.className = 'crystal-bar';
		var save = document.createElement('button');
		save.className = 'crystal-act primary';
		save.textContent = '✔ ' + t('common.save');
		var cancel = document.createElement('button');
		cancel.className = 'crystal-act';
		cancel.textContent = t('common.cancel');
		save.addEventListener('click', async function () {
			save.disabled = true; save.textContent = t('files.saving');
			try { await diamondApp().write_crystal(currentDiamond.id, ta.value); }
			catch (e) {
				noticeDialog(t('crystal.save_failed'), friendlyError(e));
				save.disabled = false; save.textContent = '✔ ' + t('common.save');
				return;
			}
			await refreshDiamondAfterChange();
		});
		cancel.addEventListener('click', function () { renderCrystal(); });
		bar.appendChild(save); bar.appendChild(cancel);

		crystalBody.appendChild(bar);
		crystalBody.appendChild(ta);
		ta.focus();
	}

	/// The Diamond's history: every version, with what produced it, and a way back.
	async function showCrystalHistory() {
		if (!currentDiamond) return;
		var recs = [];
		try { recs = JSON.parse(await diamondApp().log_read(currentDiamond.id) || '[]'); }
		catch (e) { recs = []; }

		crystalBody.innerHTML = '';
		var bar = document.createElement('div');
		bar.className = 'crystal-bar';
		var back = document.createElement('button');
		back.className = 'crystal-act';
		back.textContent = '← ' + t('crystal.back');
		back.addEventListener('click', function () { renderCrystal(); });
		bar.appendChild(back);
		crystalBody.appendChild(bar);

		var list = document.createElement('div');
		list.className = 'hist-list';
		if (!recs.length) {
			var none = document.createElement('div');
			none.className = 'crystal-empty';
			none.textContent = t('crystal.no_history');
			list.appendChild(none);
		}
		// Newest first: the version you most likely want back is the last good one.
		recs.slice().reverse().forEach(function (r) {
			// A record written before the rename says `brief_version`. Reading only
			// the new name would drop every historical fold out of this list -- the
			// history would look as though it began today.
			var v = (r.crystal_version !== undefined && r.crystal_version !== null)
				? r.crystal_version : r.brief_version;
			if (v === undefined || v === null) return;
			var row = document.createElement('div');
			row.className = 'hist-row';

			var head = document.createElement('div');
			head.className = 'hist-head';
			var ver = document.createElement('span');
			ver.className = 'hist-ver';
			ver.textContent = 'v' + v;
			var kind = document.createElement('span');
			kind.className = 'hist-kind';
			kind.textContent = r.kind || 'change';
			var when = document.createElement('span');
			when.className = 'hist-when';
			when.textContent = r.ts ? relTime(r.ts) : '';
			head.appendChild(ver); head.appendChild(kind); head.appendChild(when);
			row.appendChild(head);
			// What the version WAS. Every record has carried a note since folds were
			// written and the list showed none of them, so a history of a busy Diamond
			// read as a column of "fold, fold, fold, edit" — the versions were all
			// there and none of them said anything about itself.
			if (r.note) {
				var note = document.createElement('div');
				note.className = 'hist-note';
				note.textContent = r.note;             // escaped via textContent (H5)
				row.appendChild(note);
			}

			var acts = document.createElement('div');
			acts.className = 'hist-acts';
			var view = document.createElement('button');
			view.className = 'crystal-act';
			view.textContent = t('crystal.view');
			view.addEventListener('click', async function () {
				var md = '';
				try { md = await diamondApp().read_version(currentDiamond.id, v); }
				catch (e) { noticeDialog(t('crystal.read_version_failed'), friendlyError(e)); return; }
				noticeDialog(t('crystal.at_version', { v: v }), md || t('crystal.empty_paren'), { pre: true });
			});
			var revert = document.createElement('button');
			revert.className = 'crystal-act';
			revert.textContent = t('crystal.restore');
			revert.addEventListener('click', async function () {
				var md = '';
				try { md = await diamondApp().read_version(currentDiamond.id, v); }
				catch (e) { noticeDialog(t('crystal.read_version_failed'), friendlyError(e)); return; }
				var ok = await confirmDialog(
					t('crystal.restore_body', { v: v }),
					t('crystal.restore_v', { v: v }),
					{ title: t('crystal.restore_title'), danger: false });
				if (!ok) return;
				try { await diamondApp().write_crystal(currentDiamond.id, md); }
				catch (e) { noticeDialog(t('crystal.restore_failed'), friendlyError(e)); return; }
				await refreshDiamondAfterChange();
			});
			acts.appendChild(view); acts.appendChild(revert);
			// A fold retains the raw delta it consumed, in a file the log record
			// points at by `delta_ref`. It was kept but never shown, so the audit
			// trail was write-only; a Delta button now reads that file back.
			if (r.delta_ref) {
				var dref = r.delta_ref;
				var seeDelta = document.createElement('button');
				seeDelta.className = 'crystal-act';
				seeDelta.textContent = t('crystal.delta');
				seeDelta.title = t('crystal.delta_help');
				seeDelta.addEventListener('click', async function () {
					var d = '';
					try { d = await readBytes(dref); }
					catch (e) { noticeDialog(t('crystal.read_delta_failed'), friendlyError(e)); return; }
					noticeDialog(t('crystal.delta_at', { v: v }), d || t('crystal.empty_paren'), { pre: true });
				});
				acts.appendChild(seeDelta);
			}
			row.appendChild(acts);
			list.appendChild(row);
		});
		crystalBody.appendChild(list);
		renderCrystalControls();
	}

	/// The Diamond's tags: the user's own filing system, edited here.
	///
	/// Tags only sort the rail. Nothing here is read by an agent, and no tag
	/// reaches a crystal or a prompt -- which is why this sits beside the crystal
	/// rather than in it.
	async function showTagEditor() {
		if (!currentDiamond) return;
		var f = diamonds.find(function (x) { return x.id === currentDiamond.id; }) || currentDiamond;
		var tags = tagsOf(f).slice();

		crystalBody.innerHTML = '';
		var bar = document.createElement('div');
		bar.className = 'crystal-bar';
		var back = document.createElement('button');
		back.className = 'crystal-act';
		back.textContent = '← ' + t('crystal.back');
		back.addEventListener('click', function () { renderCrystal(); });
		bar.appendChild(back);
		crystalBody.appendChild(bar);

		var wrap = document.createElement('div');
		wrap.className = 'tag-editor';
		var note = document.createElement('div');
		note.className = 'tag-note';
		note.textContent = t('tag.editor_note');
		wrap.appendChild(note);

		// Two boxes. The upper holds what is ON the Diamond, each chip with a
		// closer; the lower holds every tag the user has anywhere -- close a
		// chip above and it lands back below, click one below and it moves up.
		// The add input belongs to the lower box: typing mints a new tag into
		// the same pool the box shows.
		var curBox = document.createElement('div');
		curBox.className = 'tag-box tag-box-current';
		var curLbl = document.createElement('div');
		curLbl.className = 'tag-box-label';
		curLbl.textContent = t('tag.on_diamond');
		curBox.appendChild(curLbl);
		var current = document.createElement('div');
		current.className = 'tag-row';
		curBox.appendChild(current);
		wrap.appendChild(curBox);

		var allBox = document.createElement('div');
		allBox.className = 'tag-box tag-box-all';
		var allLbl = document.createElement('div');
		allLbl.className = 'tag-box-label';
		allLbl.textContent = t('tag.all');
		allBox.appendChild(allLbl);
		var sug = document.createElement('div');
		sug.className = 'tag-row tag-sug';
		allBox.appendChild(sug);

		var addRow = document.createElement('div');
		addRow.className = 'tag-add';
		var input = document.createElement('input');
		input.className = 'tag-input';
		input.type = 'text';
		input.placeholder = t('tag.add_ph');
		input.maxLength = 24;
		var add = document.createElement('button');
		add.className = 'crystal-act';
		add.textContent = '+ ' + t('tag.add_btn');
		addRow.appendChild(input); addRow.appendChild(add);
		allBox.appendChild(addRow);
		wrap.appendChild(allBox);
		crystalBody.appendChild(wrap);

		// The pool: every tag on any Diamond, the starter set, and anything
		// seen here this session -- so a tag just closed above still has a
		// chip below to bring it back, even if no other Diamond carries it.
		var seen = {};
		starterTags().forEach(function (x) { seen[x] = 1; });
		diamonds.forEach(function (d) { tagsOf(d).forEach(function (x) { seen[x] = 1; }); });
		tags.forEach(function (x) { seen[x] = 1; });

		/// Persist, then repaint from what came back. The store owns
		/// normalisation -- it lowercases, trims, dedupes and caps -- so its
		/// answer is the truth, not what was typed here.
		async function commit(next) {
			try { await diamondApp().set_tags(f.id, JSON.stringify(next)); }
			catch (e) { noticeDialog(t('tag.save_failed'), friendlyError(e)); return; }
			bumpDiamonds();
			await loadDiamonds();
			var g = diamonds.find(function (x) { return x.id === f.id; });
			if (g) { tags = tagsOf(g).slice(); currentDiamond = g; }
			else tags = next;
			paint();
		}

		function paint() {
			current.innerHTML = '';
			if (!tags.length) {
				var none = document.createElement('span');
				none.className = 'tag-none';
				none.textContent = t('tag.none_yet');
				current.appendChild(none);
			}
			tags.forEach(function (tag) {
				var chip = tagChip(tag, 'tag-edit', null);
				var x = document.createElement('button');
				x.className = 'tag-x';
				x.textContent = '×';
				x.title = t('tag.remove', { tag: tag });
				x.setAttribute('aria-label', t('tag.remove', { tag: tag }));
				x.addEventListener('click', function () {
					commit(tags.filter(function (u) { return u !== tag; }));
				});
				chip.appendChild(x);
				current.appendChild(chip);
			});

			tags.forEach(function (x) { seen[x] = 1; });
			sug.innerHTML = '';
			// The starter set leads in its own order; everything else follows
			// alphabetically. Only what is not already on the Diamond is offered.
			var starters = starterTags();
			var rest = Object.keys(seen).filter(function (x) {
				return starters.indexOf(x) === -1;
			}).sort();
			var offer = starters.concat(rest).filter(function (x) {
				return tags.indexOf(x) === -1;
			});
			if (!offer.length) {
				var empty = document.createElement('span');
				empty.className = 'tag-none';
				empty.textContent = t('tag.all_used');
				sug.appendChild(empty);
				return;
			}
			offer.forEach(function (tag) {
				var chip = tagChip(tag, 'tag-offer', function () { commit(tags.concat([tag])); });
				chip.title = t('tag.add', { tag: tag });
				// The pool is the only place that shows every tag the user has, so it is
				// the only place one can be got rid of. The starter suggestions are
				// furniture rather than the user's own data -- they are offered whatever
				// the pool holds -- so they carry no closer: it could not remove them.
				if (starters.indexOf(tag) === -1) chip.appendChild(poolCloser(tag));
				sug.appendChild(chip);
			});
		}

		/// The × on a pool chip: delete the tag itself, everywhere it is filed.
		///
		/// The glyph is drawn in CSS rather than set as text (see `.tag-kill`). A
		/// chip's `textContent` is the tag -- the rail, the filter and the search all
		/// read it -- and a button with an × in it would make every one of them read
		/// "person×".
		function poolCloser(tag) {
			var x = document.createElement('button');
			x.className = 'tag-x tag-kill';
			x.title = t('tag.delete_help', { tag: tag });
			x.setAttribute('aria-label', t('tag.delete_help', { tag: tag }));
			x.addEventListener('click', async function (e) {
				e.stopPropagation();          // closing a chip is not clicking the chip
				// Who else is filed under it. This is the whole reason the removal asks
				// first: it is not this Diamond's tag, it is the user's tag.
				var users = diamonds.filter(function (d) { return tagsOf(d).indexOf(tag) !== -1; });
				var body = users.length
					? tn('tag.delete_body_used', users.length, { tag: tag })
					: t('tag.delete_body_unused', { tag: tag });
				if (!await confirmDialog(body, t('tag.delete_ok'), { title: t('tag.delete_title') })) return;
				for (var i = 0; i < users.length; i++) {
					var d = users[i];
					var next = tagsOf(d).filter(function (u) { return u !== tag; });
					try { await diamondApp().set_tags(d.id, JSON.stringify(next)); }
					catch (e2) { noticeDialog(t('tag.save_failed'), friendlyError(e2)); return; }
				}
				delete seen[tag];             // gone from the pool for this session too
				// A filter on a tag that no longer exists would hide every Diamond
				// there is, with a chip under the rail head as the only clue why
				// -- and an EXCLUSION on one would go on hiding them with no chip
				// at all to click. The tag leaves both lists.
				dropTagFilter(tag);
				bumpDiamonds();
				await loadDiamonds();
				var g = diamonds.find(function (y) { return y.id === f.id; });
				if (g) { tags = tagsOf(g).slice(); currentDiamond = g; }
				paint();
				toast(users.length
					? tn('tag.deleted_from', users.length, { tag: tag })
					: t('tag.deleted', { tag: tag }));
			});
			return x;
		}

		function addTyped() {
			var typed = input.value.trim().toLowerCase();
			input.value = '';
			if (!typed || tags.indexOf(typed) !== -1) return;
			commit(tags.concat([typed]));
		}
		add.addEventListener('click', addTyped);
		input.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') { e.preventDefault(); addTyped(); }
		});

		paint();
		renderCrystalControls();
	}

	/// Fill the artefact strip and, when it is open, the list under it.
	///
	/// Reads the Diamond's links and keeps the ones pointing at something that is not another
	/// Diamond: those are the things this pursuit produced or consulted, as against the Diamonds
	/// it relates to.
	async function renderArtefacts() {
		var strip = document.getElementById('arte-strip');
		var list  = document.getElementById('arte-list');
		if (!strip || !list || !currentDiamond) return;
		var diamondId = currentDiamond.id;

		var links = [];
		try {
			links = JSON.parse(await diamondApp().links_touching('diamond:' + diamondId) || '[]')
				.filter(function (l) { return l.other && l.other.indexOf('diamond:') !== 0; });
		} catch (e) { links = []; }

		if (!links.length) { strip.style.display = 'none'; list.style.display = 'none'; return; }
		strip.style.display = '';
		// This strip is the Diamond's workspace in one line: the files, folders and
		// pages that are part of this pursuit -- which is the same set the Workspace
		// panel draws as a tree, and the same set its daimon may open. It used to
		// call them artefacts, which named only how most of them got here.
		strip.textContent = '\u25c8 ' + tn('dws.count', links.length);
		strip.title = t('dws.title');
		if (!strip.dataset.open) { list.style.display = 'none'; return; }

		// Most recent first: what was last touched is what is being worked on.
		links.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });

		list.innerHTML = '';
		links.forEach(function (l) {
			var kind = l.other.slice(0, l.other.indexOf(':'));
			var rest = l.other.slice(l.other.indexOf(':') + 1);

			var row = document.createElement('div');
			row.className = 'arte-row';

			// Opening it is the obvious click, and every kind already has a panel that knows
			// how to show it — so this routes rather than rendering anything itself.
			var openBtn = document.createElement('button');
			openBtn.className = 'arte-open';
			openBtn.textContent = rest;
			openBtn.title = l.rel ? (l.rel + ' \u00b7 ' + l.other) : l.other;
			openBtn.addEventListener('click', function () { openArtefact(kind, rest); });

			// The quieter, more useful one: put a reference in the steer box. The hard part of
			// steering is naming which thing you mean, and this is the picker for it.
			var useBtn = document.createElement('button');
			useBtn.className = 'arte-use';
			useBtn.textContent = '\u21b3';
			useBtn.title = t('arte.refer_help');
			useBtn.addEventListener('click', function () {
				var box = document.getElementById('steer-input');
				if (!box) return;
				box.value = (box.value ? box.value.replace(/\s*$/, ' ') : '') + rest + ' ';
				box.focus();
				box.style.height = 'auto';
				box.style.height = Math.min(box.scrollHeight, 120) + 'px';
			});

			var drop = document.createElement('button');
			drop.className = 'arte-drop';
			drop.textContent = '\u00d7';
			drop.title = t('arte.drop_help');
			drop.setAttribute('aria-label', t('arte.drop_named', { name: rest }));
			drop.addEventListener('click', async function () {
				try { await diamondApp().remove_link(l.owner, l.id); } catch (e) { /* already gone */ }
				// Dropping an artefact removes a link, so it is a link change too.
				signalLinksChanged();
				renderArtefacts();
			});

			var tag = document.createElement('span');
			tag.className = 'arte-kind';
			tag.textContent = kind;

			row.appendChild(tag);
			row.appendChild(openBtn);
			row.appendChild(useBtn);
			row.appendChild(drop);
			list.appendChild(row);
		});
	}

	/// The link by which a Diamond holds this reference, or nothing.
	///
	/// A reference is `file:<path>` for a file and `dir:<path>` for a folder, and
	/// both say the same thing: this is in that Diamond's workspace, and its
	/// daimon may open it.
	async function linkTo(diamondId, ref) {
		try {
			var links = JSON.parse(await diamondApp().links_touching('diamond:' + diamondId) || '[]');
			for (var i = 0; i < links.length; i++) {
				if (links[i].other === ref) return links[i];
			}
		} catch (e) { /* unreadable: treat as not held */ }
		return null;
	}

	/// The link by which a Diamond holds this file, or nothing.
	async function heldLink(diamondId, path) {
		return await linkTo(diamondId, 'file:' + path);
	}

	/// Does this Diamond hold this file?
	async function fileIsHeld(diamondId, path) {
		return !!(await heldLink(diamondId, path));
	}

	/// Show an artefact in whichever panel already owns that kind of thing.
	///
	/// A file that has since been renamed or deleted is said to be missing rather than
	/// quietly doing nothing: a list of dead links that pretends otherwise is worse than no
	/// list at all.
	async function openArtefact(kind, rest) {
		if (kind === 'url') {
			if (window.DaimondWeb && DaimondWeb.open) DaimondWeb.open(rest);
			else window.open(rest, '_blank', 'noopener');
			return;
		}
		if (kind === 'file') {
			try {
				await diamondApp().run_tool('file_read', JSON.stringify({ path: rest }));
			} catch (e) {
				noticeDialog(t('arte.file_gone'), t('arte.file_gone_body', { path: rest }));
				return;
			}
			Files.open(rest);
			return;
		}
		// A folder in this Diamond's workspace: browsed in the panel that browses
		// folders, like a file is read in the panel that reads files.
		if (kind === 'dir') {
			var res = null;
			try { res = await diamondApp().run_tool('file_list', JSON.stringify({ path: rest })); }
			catch (e) { res = 'Error'; }
			if (typeof res === 'string' && /^\s*Error\b/i.test(res)) {
				noticeDialog(t('arte.file_gone'), t('arte.file_gone_body', { path: rest }));
				return;
			}
			try { DaimondPanels.markUsed('work'); DaimondPanels.show('work'); } catch (e) { /* no panels */ }
			Files.browse(rest);
			return;
		}
		if (kind === 'chat') {
			var chat = chats.find(function (c) { return c.id === rest; });
			if (chat) { selectChat(chat); return; }
		}
		noticeDialog(t('arte.nothing_to_open'), t('arte.no_viewer', { kind: kind }));
	}

	// The strip is a reading of the Diamond's links, so it is stale the moment
	// they change -- and they change from three places now: a fold's harvest, the
	// ◈ on an open file, and the Workspace panel's tree. Redrawing on the signal
	// costs one read and removes the class of bug where a count is right
	// everywhere except the line the user is looking at.
	document.addEventListener('daimond-links-changed', function () { renderArtefacts(); });

	// A small surface for tests, and for anything that later wants to record an
	// artefact from outside a fold.
	window.DaimondArtefacts = {
		harvest: harvestArtefacts,
		render:  renderArtefacts,
		of:      artefactsIn,        // pure: messages -> [{ref, rel}]
	};

	// ── Links: Diamond to Diamond ──────────────────────────────────
	// A link says, in one word, how two pursuits stand to each other. The record
	// is stored once -- on the Diamond it was asserted from -- and found from both
	// of its ends, so the same link shows on both Diamonds and which way round it
	// was asserted is part of what it says rather than an accident of where it
	// happens to live.

	/// Say that the Diamond in focus changed, to anything that draws per-Diamond.
	///
	/// The Workspace panel is the first: one of its two trees is the open
	/// Diamond's workspace, so which Diamond is open decides what it shows.
	function signalDiamondChanged() {
		document.dispatchEvent(new CustomEvent('daimond-diamond-changed'));
	}

	// The Terminal panel is the second: a session's fence was computed for ONE
	// Diamond's bounds, so a Diamond change ends it rather than carrying it over
	// into a workspace it was never granted.
	document.addEventListener('daimond-diamond-changed', function () {
		if (window.DaimondTerm) DaimondTerm.onDiamondChanged();
	});

	/// Say that the links changed, to the graph and to anything else watching.
	function signalLinksChanged() {
		document.dispatchEvent(new CustomEvent('daimond-links-changed'));
		if (window.DaimondGraph && DaimondGraph.refresh) DaimondGraph.refresh();
	}

	/// The Diamond a `diamond:<id>` reference names, or nothing if it has gone.
	function diamondOfRef(ref) {
		if (!ref) return null;
		var i = ref.indexOf(':');
		var id = i === -1 ? ref : ref.slice(i + 1);
		return diamonds.find(function (x) { return x.id === id; }) || null;
	}

	/// What to call the far end of a link: its name, or that it is no longer there.
	function linkOtherName(ref) {
		var f = diamondOfRef(ref);
		return f ? f.name : t('link.gone_name');
	}

	/// One arrow between the parts of a link phrase.
	function linkArrow() {
		var a = document.createElement('span');
		a.className = 'link-arrow';
		a.setAttribute('aria-hidden', 'true');
		a.textContent = '→';
		return a;
	}

	/// Fill the Links section for the Diamond on screen.
	///
	/// The artefact strip above takes the links pointing at a file, a page or a
	/// chat. These are the ones pointing at another Diamond, which answers a
	/// different question -- not what this pursuit used, but where it sits among
	/// the rest of them.
	async function renderLinks() {
		var sec = document.getElementById('link-sec');
		if (!sec || !currentDiamond) return;
		var diamondId = currentDiamond.id;
		// The open state and any half-typed form belong to the Diamond they were
		// started on, not to whatever the Centre shows next.
		if (linkFor !== diamondId) {
			linkFor = diamondId; linkOpen = false; linkForm = null; linkNotes = {};
		}
		var token = ++linkPaint;
		var selfRef = 'diamond:' + diamondId;

		var links = [];
		try {
			links = JSON.parse(await diamondApp().links_touching(selfRef) || '[]')
				.filter(function (l) { return l.other && l.other.indexOf('diamond:') === 0; });
		} catch (e) { links = []; }
		// A slow read that started first must not paint over a fresher one, and a
		// Diamond swapped under the await must not be painted at all.
		if (token !== linkPaint) return;
		if (!currentDiamond || currentDiamond.id !== diamondId) return;

		var strip = document.getElementById('link-strip');
		var body  = document.getElementById('link-body');
		if (!strip || !body) return;
		strip.textContent = (linkOpen ? '▾ ' : '▸ ') + tn('link.count', links.length);
		strip.title = t('link.strip_help');
		strip.setAttribute('aria-expanded', linkOpen ? 'true' : 'false');
		body.style.display = linkOpen ? '' : 'none';
		body.innerHTML = '';
		if (!linkOpen) return;

		var list = document.createElement('div');
		list.className = 'link-list';
		list.id = 'link-list';
		// Most recent first, as everything else about a Diamond is ordered.
		links.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
		if (!links.length) {
			var none = document.createElement('div');
			none.className = 'link-none';
			none.textContent = t('link.none');
			list.appendChild(none);
		}
		links.forEach(function (l) { list.appendChild(linkRow(l, selfRef)); });
		body.appendChild(list);

		// The way in to making one, which becomes the form in place of itself.
		if (linkForm) {
			body.appendChild(linkAddForm(diamondId, selfRef));
			return;
		}
		var add = document.createElement('button');
		add.className = 'link-add';
		add.id = 'link-add';
		add.type = 'button';
		add.textContent = '+ ' + t('link.add_btn');
		add.title = t('link.add_title');
		add.addEventListener('click', function () {
			linkForm = { target: null, query: '', rel: '', note: '' };
			renderLinks();
		});
		body.appendChild(add);
	}

	/// One link, laid out left to right in the direction it was asserted.
	///
	/// The two ends sit in their stored order -- this Diamond first when it is the
	/// `from`, the other first when it is not -- so which way a relation runs is
	/// read straight off the row rather than inferred from an arrowhead.
	function linkRow(l, selfRef) {
		var out  = (l.from === selfRef);
		var name = linkOtherName(l.other);
		var rel  = l.rel || t('link.rel_blank');

		var row = document.createElement('div');
		row.className = 'link-row ' + (out ? 'link-row-out' : 'link-row-in');
		row.dataset.linkId = l.id;
		row.dataset.dir    = out ? 'out' : 'in';
		row.dataset.other  = l.other;

		var noteEl = document.createElement('div');
		noteEl.className = 'link-note';
		noteEl.textContent = l.note || '';
		noteEl.style.display = (l.note && linkNotes[l.id]) ? '' : 'none';

		var self = document.createElement('span');
		self.className = 'link-self';
		self.textContent = t('link.this');
		var relEl = document.createElement('span');
		relEl.className = 'link-rel';
		relEl.textContent = rel;
		var other = document.createElement('button');
		other.className = 'link-other';
		other.type = 'button';
		other.textContent = name;                  // escaped via textContent (H5)
		other.title = t('link.open_other', { name: name });
		other.addEventListener('click', function () {
			var f = diamondOfRef(l.other);
			if (!f) { noticeDialog(t('link.gone'), t('link.gone_body', { ref: l.other })); return; }
			selectDiamond(f);
			if (isMobile()) mshow('ai');
		});

		var phrase = document.createElement('div');
		phrase.className = 'link-phrase';
		if (out) {
			phrase.appendChild(self);  phrase.appendChild(linkArrow());
			phrase.appendChild(relEl); phrase.appendChild(linkArrow());
			phrase.appendChild(other);
		} else {
			phrase.appendChild(other); phrase.appendChild(linkArrow());
			phrase.appendChild(relEl); phrase.appendChild(linkArrow());
			phrase.appendChild(self);
		}
		var said = out ? t('link.out_help', { rel: rel, name: name })
		               : t('link.in_help',  { rel: rel, name: name });
		phrase.title = l.note ? (said + ' — ' + l.note) : said;
		phrase.setAttribute('aria-label', said);

		var acts = document.createElement('div');
		acts.className = 'link-acts';
		if (l.note) {
			var noteBtn = document.createElement('button');
			noteBtn.className = 'link-note-btn';
			noteBtn.type = 'button';
			noteBtn.textContent = '≡';
			noteBtn.title = l.note;                // the note on hover, as well as on click
			noteBtn.setAttribute('aria-label', t('link.note_help'));
			noteBtn.addEventListener('click', function () {
				linkNotes[l.id] = !linkNotes[l.id];
				noteEl.style.display = linkNotes[l.id] ? '' : 'none';
				noteBtn.classList.toggle('on', !!linkNotes[l.id]);
			});
			if (linkNotes[l.id]) noteBtn.classList.add('on');
			acts.appendChild(noteBtn);
		}
		var drop = document.createElement('button');
		drop.className = 'link-drop';
		drop.type = 'button';
		drop.textContent = '×';
		drop.title = t('link.drop_help');
		drop.setAttribute('aria-label', t('link.drop_help'));
		drop.addEventListener('click', async function () {
			var ok = await confirmDialog(t('link.drop_confirm', { rel: rel, name: name }),
				t('link.drop'), { title: t('link.drop') });
			if (!ok) return;
			try { await diamondApp().remove_link(l.owner, l.id); }
			catch (e) { noticeDialog(t('link.drop_failed'), friendlyError(e)); return; }
			signalLinksChanged();
			bumpDiamonds();
			renderLinks();
		});
		acts.appendChild(drop);

		var line = document.createElement('div');
		line.className = 'link-line';
		line.appendChild(phrase);
		line.appendChild(acts);
		row.appendChild(line);
		row.appendChild(noteEl);
		return row;
	}

	/// The add-a-link form: which Diamond, in what relation, and optionally why.
	///
	/// Everything typed is held in `linkForm` rather than read back out of the
	/// DOM, so a repaint under a half-filled form restores it instead of emptying
	/// it. Escape closes the form; a blur does not, because moving between the
	/// fields of a form is not leaving it.
	function linkAddForm(diamondId, selfRef) {
		var wrap = document.createElement('div');
		wrap.className = 'link-form';
		wrap.id = 'link-form';
		wrap.addEventListener('keydown', function (e) {
			if (e.key !== 'Escape') return;
			e.preventDefault();
			e.stopPropagation();
			linkForm = null;
			renderLinks();
		});

		var err = document.createElement('div');
		err.className = 'link-err';
		err.id = 'link-err';

		// 1. Which Diamond, found the way the rail is found: by typing part of
		//    its name. Every Diamond but this one is offered, because the store
		//    rejects a link from a thing to itself.
		var pickField = document.createElement('div');
		pickField.className = 'link-field';
		var pickLbl = document.createElement('div');
		pickLbl.className = 'link-label';
		pickLbl.textContent = t('link.pick_label');
		var pick = document.createElement('input');
		pick.className = 'link-pick';
		pick.id = 'link-pick';
		pick.type = 'text';
		pick.autocomplete = 'off';
		pick.spellcheck = false;
		pick.placeholder = t('link.pick_ph');
		pick.value = linkForm.query || '';
		pick.setAttribute('aria-label', t('link.pick_label'));
		var picks = document.createElement('div');
		picks.className = 'link-picks';
		picks.id = 'link-picks';
		var chosen = document.createElement('div');
		chosen.className = 'link-chosen';
		chosen.id = 'link-chosen';
		pickField.appendChild(pickLbl);
		pickField.appendChild(pick);
		pickField.appendChild(picks);
		pickField.appendChild(chosen);

		/// Redraw the picker alone, so typing never rebuilds the form under the
		/// cursor.
		function paintPicks() {
			chosen.innerHTML = '';
			picks.innerHTML = '';
			if (linkForm.target) {
				pick.style.display = 'none';
				picks.style.display = 'none';
				chosen.style.display = '';
				var lbl = document.createElement('span');
				lbl.className = 'link-chosen-name';
				lbl.textContent = linkForm.target.name;
				var change = document.createElement('button');
				change.className = 'link-change';
				change.id = 'link-change';
				change.type = 'button';
				change.textContent = t('link.change_pick');
				change.addEventListener('click', function () {
					linkForm.target = null;
					paintPicks();
					pick.focus();
				});
				chosen.appendChild(lbl);
				chosen.appendChild(change);
				return;
			}
			pick.style.display = '';
			picks.style.display = '';
			chosen.style.display = 'none';
			var q = (linkForm.query || '').trim().toLowerCase();
			var pool = diamonds.filter(function (x) { return x.id !== diamondId; });
			if (!pool.length) {
				var bare = document.createElement('div');
				bare.className = 'link-none';
				bare.textContent = t('link.pick_empty');
				picks.appendChild(bare);
				return;
			}
			var hits = pool.filter(function (x) {
				return !q || (x.name || '').toLowerCase().indexOf(q) !== -1;
			}).slice(0, 8);
			if (!hits.length) {
				var no = document.createElement('div');
				no.className = 'link-none';
				no.textContent = t('link.pick_none');
				picks.appendChild(no);
				return;
			}
			hits.forEach(function (f) {
				var b = document.createElement('button');
				b.className = 'link-pick-hit';
				b.type = 'button';
				b.dataset.id = f.id;
				b.textContent = f.name;            // escaped via textContent (H5)
				b.addEventListener('click', function () {
					linkForm.target = { id: f.id, name: f.name };
					err.textContent = '';
					paintPicks();
					var relBox = document.getElementById('link-rel');
					if (relBox) relBox.focus();
				});
				picks.appendChild(b);
			});
		}
		pick.addEventListener('input', function () {
			linkForm.query = pick.value;
			paintPicks();
		});

		// 2. The relation. Three words are offered and none is enforced: what a
		//    relation may say is the user's business, exactly as a tag is.
		var relField = document.createElement('div');
		relField.className = 'link-field';
		var relLbl = document.createElement('div');
		relLbl.className = 'link-label';
		relLbl.textContent = t('link.rel_label');
		var relIn = document.createElement('input');
		relIn.className = 'link-rel-input';
		relIn.id = 'link-rel';
		relIn.type = 'text';
		relIn.autocomplete = 'off';
		relIn.spellcheck = false;
		relIn.maxLength = REL_MAX;
		relIn.placeholder = t('link.rel_ph');
		relIn.value = linkForm.rel || '';
		relIn.setAttribute('aria-label', t('link.rel_label'));
		relIn.addEventListener('input', function () { linkForm.rel = relIn.value; });
		var sug = document.createElement('div');
		sug.className = 'link-rel-sug';
		sug.id = 'link-rel-sug';
		sug.title = t('link.rel_sug_help');
		DEFAULT_REL_SUGGESTIONS.forEach(function (word) {
			var b = document.createElement('button');
			b.className = 'link-sug';
			b.type = 'button';
			b.dataset.rel = word;
			b.textContent = word;
			b.title = t('link.rel_use', { rel: word });
			b.addEventListener('click', function () {
				linkForm.rel = word;
				relIn.value = word;
				relIn.focus();
			});
			sug.appendChild(b);
		});
		relField.appendChild(relLbl);
		relField.appendChild(relIn);
		relField.appendChild(sug);

		// 3. The note: whatever the one word does not say.
		var noteField = document.createElement('div');
		noteField.className = 'link-field';
		var noteLbl = document.createElement('div');
		noteLbl.className = 'link-label';
		noteLbl.textContent = t('link.note_label');
		var noteIn = document.createElement('input');
		noteIn.className = 'link-note-input';
		noteIn.id = 'link-note';
		noteIn.type = 'text';
		noteIn.autocomplete = 'off';
		noteIn.maxLength = 2000;
		noteIn.placeholder = t('link.note_ph');
		noteIn.value = linkForm.note || '';
		noteIn.setAttribute('aria-label', t('link.note_label'));
		noteIn.addEventListener('input', function () { linkForm.note = noteIn.value; });
		noteField.appendChild(noteLbl);
		noteField.appendChild(noteIn);

		// The direction is not a choice: a link is asserted FROM the Diamond you
		// are looking at, which is the only reading of "link this to that" that
		// does not need explaining.
		var says = document.createElement('div');
		says.className = 'link-says';
		says.id = 'link-says';
		says.textContent = t('link.direction_note');

		var acts = document.createElement('div');
		acts.className = 'link-form-acts';
		var save = document.createElement('button');
		save.className = 'link-save';
		save.id = 'link-save';
		save.type = 'button';
		save.textContent = t('link.save');
		save.addEventListener('click', async function () {
			if (!linkForm || !linkForm.target) {
				err.textContent = t('link.need_target');
				pick.focus();
				return;
			}
			save.disabled = true;
			try {
				await diamondApp().add_link(diamondId, selfRef, 'diamond:' + linkForm.target.id,
					linkForm.rel || '', linkForm.note || '', 'user');
			} catch (e) {
				save.disabled = false;
				err.textContent = friendlyError(e);
				return;
			}
			linkForm = null;
			signalLinksChanged();
			bumpDiamonds();
			renderLinks();
		});
		var cancel = document.createElement('button');
		cancel.className = 'link-cancel';
		cancel.id = 'link-cancel';
		cancel.type = 'button';
		cancel.textContent = t('common.cancel');
		cancel.addEventListener('click', function () { linkForm = null; renderLinks(); });
		acts.appendChild(save);
		acts.appendChild(cancel);

		wrap.appendChild(pickField);
		wrap.appendChild(relField);
		wrap.appendChild(noteField);
		wrap.appendChild(says);
		wrap.appendChild(err);
		wrap.appendChild(acts);
		paintPicks();
		return wrap;
	}

	// A small surface for tests, and for the graph, which wants to know when a
	// link changed without reaching into this file for it.
	window.DaimondLinks = {
		render: renderLinks,
		/// Open or close the section, then repaint it.
		toggle: function (open) {
			linkOpen = (open === undefined) ? !linkOpen : !!open;
			if (!linkOpen) linkForm = null;
			return renderLinks();
		},
		changed: signalLinksChanged,
	};

	/// Render the steer command line and the fold-a-delta control.
	function renderCrystalControls() {
		crystalControls.innerHTML = '';

		var status = document.createElement('div');
		status.className = 'crystal-status';
		status.id = 'crystal-status';

		// A one-shot answer from the crystal agent — a question it asked, or what it
		// did when it did not touch the crystal. Shown here rather than lost, and
		// dismissible, because a steer that only produced words used to leave the
		// user staring at an unchanged crystal with no idea it had run (yet billed).
		var reply = document.createElement('div');
		reply.className = 'crystal-reply';
		reply.id = 'crystal-reply';
		reply.style.display = 'none';

		// The Links section: which other Diamonds this one is related to, and how.
		//
		// A header that carries the count and opens the list, so a Diamond with no
		// links costs one line rather than a permanently empty shelf -- but unlike
		// the artefact strip it never hides, because this is also the only way in
		// to making a link, and a control that appears once there is already one of
		// the thing it makes is a control nobody finds.
		var linkSec = document.createElement('div');
		linkSec.className = 'link-sec';
		linkSec.id = 'link-sec';
		var linkStrip = document.createElement('button');
		linkStrip.className = 'link-strip';
		linkStrip.id = 'link-strip';
		linkStrip.type = 'button';
		linkStrip.setAttribute('aria-expanded', 'false');
		linkStrip.addEventListener('click', function () {
			linkOpen = !linkOpen;
			if (!linkOpen) linkForm = null;   // closing the section closes the form with it
			renderLinks();
		});
		var linkBody = document.createElement('div');
		linkBody.className = 'link-body';
		linkBody.id = 'link-body';
		linkBody.style.display = 'none';
		linkSec.appendChild(linkStrip);
		linkSec.appendChild(linkBody);

		// The artefact strip: a count, above the steer box, that hides at zero.
		//
		// A count rather than a list, because the crystal already scrolls and a scrollable
		// region inside a scrollable one makes the wheel ambiguous. Hidden while empty, so a
		// new Diamond is not given a permanently empty shelf to explain.
		var arte = document.createElement('button');
		arte.className = 'arte-strip';
		arte.id = 'arte-strip';
		arte.style.display = 'none';
		var arteList = document.createElement('div');
		arteList.className = 'arte-list';
		arteList.id = 'arte-list';
		arteList.style.display = 'none';
		arte.addEventListener('click', function () {
			var shown = arteList.style.display !== 'none';
			arteList.style.display = shown ? 'none' : '';
			arte.dataset.open = shown ? '' : '1';
			renderArtefacts();
		});

		// Steer row — an instruction command surface, not a chat thread.
		var steerRow = document.createElement('div');
		steerRow.className = 'steer-row';
		var steer = document.createElement('textarea');
		steer.className = 'steer-input';
		steer.id = 'steer-input';
		steer.rows = 1;
		// A paused Diamond says where its play control is, in the box you would
		// otherwise type into and wonder. Notes2 asks for exactly this on the two
		// default Diamonds, and it is right for every paused one: the alternative
		// is typing a paragraph and being told no.
		steer.placeholder = diamondHeld(currentDiamond && currentDiamond.id)
			? t('crystal.steer_paused')
			: t('crystal.steer_ph');
		steer.addEventListener('input', function () {
			steer.style.height = 'auto';
			steer.style.height = Math.min(steer.scrollHeight, 120) + 'px';
		});
		steer.addEventListener('keydown', function (e) {
			if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSteer(); }
		});
		var steerSend = document.createElement('button');
		steerSend.className = 'steer-send';
		steerSend.id = 'steer-send';
		steerSend.title = t('crystal.steer');
		steerSend.setAttribute('aria-label', t('crystal.steer'));
		steerSend.textContent = '➤';
		steerSend.addEventListener('click', doSteer);
		steerRow.appendChild(steer); steerRow.appendChild(steerSend);

		// Fold row — enter a delta, propose a fold (writes nothing).
		var foldRow = document.createElement('div');
		foldRow.className = 'fold-row';
		var delta = document.createElement('textarea');
		delta.className = 'fold-delta';
		delta.id = 'fold-delta';
		delta.rows = 1;
		delta.placeholder = t('crystal.fold_ph');
		delta.addEventListener('input', function () {
			delta.style.height = 'auto';
			delta.style.height = Math.min(delta.scrollHeight, 100) + 'px';
		});
		var foldBtn = document.createElement('button');
		foldBtn.className = 'fold-btn';
		foldBtn.id = 'fold-propose';
		foldBtn.textContent = t('agents.fold_in');
		foldBtn.addEventListener('click', doFoldPropose);
		foldRow.appendChild(delta); foldRow.appendChild(foldBtn);

		crystalControls.appendChild(status);
		crystalControls.appendChild(reply);
		crystalControls.appendChild(linkSec);
		crystalControls.appendChild(arte);
		crystalControls.appendChild(arteList);
		crystalControls.appendChild(steerRow);
		crystalControls.appendChild(foldRow);
		// The header the section was just given is empty until this fills it, and
		// the controls are rebuilt by the tag editor and the history view as well
		// as by the crystal -- so it is filled from here, where every one of them
		// passes, rather than from the crystal alone.
		renderLinks();
	}

	function setCrystalStatus(text) {
		var s = document.getElementById('crystal-status');
		if (s) s.textContent = text || '';
	}

	/// Show (or clear) the crystal agent's one-shot reply. Rendered as markdown,
	/// with a dismiss control, and never accumulated — each steer replaces it.
	function setCrystalReply(text) {
		var r = document.getElementById('crystal-reply');
		if (!r) return;
		if (!text || !text.trim()) { r.style.display = 'none'; r.innerHTML = ''; return; }
		r.innerHTML = '';
		var x = document.createElement('button');
		x.className = 'crystal-reply-x';
		x.textContent = '×';
		x.title = t('common.dismiss');
		x.addEventListener('click', function () { r.style.display = 'none'; r.innerHTML = ''; });
		var body = document.createElement('div');
		body.className = 'crystal-reply-body';
		body.innerHTML = DaimondRender.md(text);   // escaped + sanitised by the renderer
		r.appendChild(x);
		r.appendChild(body);
		r.style.display = '';
	}

	function setCrystalBusy(busy) {
		crystalBusy = busy;
		['steer-send', 'fold-propose'].forEach(function (id) {
			var el = document.getElementById(id);
			if (el) el.disabled = busy;
		});
	}

	/// Say, in the crystal itself, that a reducer is running.
	///
	/// The status line under the controls is 12px of muted grey, and folding a
	/// whole chat is the slowest call the app makes: the user pressed a button,
	/// the centre changed, and nothing moved for half a minute. The chat has had a
	/// spinner all along; this is the same one, in the other face of the panel.
	function showCrystalSpinner() {
		hideCrystalSpinner();
		var sp = document.createElement('div');
		sp.className = 'chat-spinner crystal-spinner';
		sp.id = 'crystal-spinner';
		sp.innerHTML = '<span class="chat-spinner-dot"></span>'
			+ '<span class="chat-spinner-dot"></span><span class="chat-spinner-dot"></span>';
		crystalBody.appendChild(sp);
	}
	function hideCrystalSpinner() {
		var sp = document.getElementById('crystal-spinner');
		if (sp) sp.remove();
	}

	/// After any crystal mutation: refresh the meta row in the rail and the
	/// Centre meter, then re-render the crystal.
	async function refreshDiamondAfterChange() {
		bumpDiamonds();
		await loadDiamonds();
		var f = diamonds.find(function (x) { return currentDiamond && x.id === currentDiamond.id; });
		if (f) {
			currentDiamond = f;
			aiMeter.textContent = 'crystal v' + (f.crystal_version || 0)
				+ (f.updated ? ' · ' + relTime(f.updated) : '');
		}
		await renderCrystal();
	}

	/// Steer the crystal: run one crystal-agent turn, streaming its tool
	/// activity to the Agents panel, then re-render the changed crystal.
	///
	/// `preset` supplies the instruction instead of the input box, which is how a
	/// batch of finished workers gets its reports back to the daimon that sent
	/// them (see `Workers.gather`). `depth` counts how many gather rounds deep
	/// this already is, so a daimon that answers every report by dispatching again
	/// stops rather than fanning out for ever.
	async function doSteer(presetArg, depthArg) {
		if (crystalBusy || !currentDiamond) return;
		// `doSteer` is wired straight to the Send button and to a key handler, so
		// the first argument is USUALLY a DOM event, not an instruction. Taking it
		// on trust made the MouseEvent the prompt: the box was never cleared, the
		// event went to the model as the instruction, and every worker in the
		// fan-out silently failed to start. `verify_slots` caught it -- 4/0 to 2/2 --
		// which is why a new optional parameter on an existing handler has to say
		// what it will accept rather than assume its callers.
		var preset = (typeof presetArg === 'string') ? presetArg : '';
		var depth  = (typeof depthArg === 'number') ? depthArg : 0;
		var input = document.getElementById('steer-input');
		// A gather round carries its own words and may run with the Diamond's
		// surface nowhere on screen, so it must not require the box.
		if (!input && !preset) return;
		var instruction = preset || (input ? input.value.trim() : '');
		if (!instruction) return;
		// Can THIS Diamond's model run? Asking whether the *default* provider is configured is the
		// wrong question: it would stop a perfectly good Diamond steering because some other
		// provider -- the starred one -- had lost its key.
		if (!diamondCanRun(currentDiamond.id)) {
			openSettings(t('crystal.no_key_steer'));
			return;
		}
		// Only what the user typed is cleared. A gather round never touched the box,
		// and clearing it would throw away something half-written while workers ran.
		if (input && !preset) { input.value = ''; input.style.height = 'auto'; }
		setCrystalBusy(true);
		setCrystalStatus(t('crystal.steering'));

		// Every `spawn_agent` call the conductor makes in this turn becomes a
		// worker. Several calls in one turn is how it starts several agents at
		// once — the whole point of a conductor.
		var diamondId = currentDiamond.id, diamondName = currentDiamond.name;
		var dispatched = [], rejected = 0, replyText = '';
		setCrystalReply('');   // clear any previous one-shot answer

		// ── The daimon's conversation ────────────────────────────────
		//
		// Every steer is now a turn IN a conversation rather than a fresh session, so
		// what happened is written down as it happens — the same message shapes a chat
		// uses, drawn by the same renderer. `onScreen` is whether this Diamond's chat
		// view is the thing the user is looking at: a steer can run from a gather round
		// with the Diamond nowhere on screen, and drawing into the thread then would
		// paint one Diamond's turn into another's.
		var rec = daimonChat(currentDiamond);
		var onScreen = !!(current && rec && current.id === rec.id && centreMode === 'daimon');
		rec.messages.push({ role: 'user', content: instruction, mid: newMid(), ts: Date.now() });
		if (onScreen) appendUserMessage(instruction);
		// The composer's Send becomes Stop while a daimon turn runs, and `anyGen()` --
		// which is what stops a reload, a sign-out or an update landing on top of work
		// in flight -- counts it. Both read `_generating`, so a daimon turn that did not
		// set it was a turn the rest of the app could not see was happening.
		rec._generating = true;
		// The Stop button aborts `current.app`, and a daimon's turn does not run on its
		// own app -- it runs on the Diamond's, which is shared by every Diamond on the
		// same model. Pointing the record at it is what makes Stop reach this turn;
		// aborting is idempotent, and a Diamond's app is rebuilt by `diamondApp` on the
		// next use, so a stopped daimon does not leave a poisoned client behind.
		rec.app = diamondApp(currentDiamond.id);
		if (onScreen) { syncComposer(); showSpinner(); }

		var sawError = false;
		var onEvent = function (ev) {
			if (!ev || !ev.type) return;
			if (ev.type === 'text') {
				// The conductor's own words — a question, a refusal, or an account
				// of what it did. Kept, so a text-only turn is not silently dropped.
				replyText += (ev.content || '');
				if (onScreen) appendAssistantText(ev.content || '');
			} else if (ev.type === 'tool_call') {
				if ((ev.name || '') === 'spawn_agent') {
					var spec = null;
					try { spec = JSON.parse(ev.args || '{}'); } catch (e) { spec = null; }
					if (spec && spec.task) dispatched.push({ name: spec.name, task: spec.task });
					// The tool rejects a task-less dispatch, and the user used to
					// see nothing at all: no agent, no error, no explanation.
					else rejected += 1;
				} else {
					setCrystalStatus('Steering… (' + ev.name + ')');
				}
				// Recorded whichever tool it was, including `spawn_agent`: the chat view
				// is the account of what the daimon did, and a fan-out is the largest
				// thing it does.
				rec.messages.push({ role: 'tool_log', name: ev.name || '', args: ev.args || '',
					content: '', mid: newMid(), ts: Date.now() });
				if (onScreen) renderToolCall(ev.name || '', ev.args || '');
			} else if (ev.type === 'tool_result') {
				var last = rec.messages[rec.messages.length - 1];
				if (last && last.role === 'tool_log' && !last.content) last.content = ev.content || '';
				if (onScreen) renderToolResult(ev.name || '', ev.content || '');
			} else if (ev.type === 'compacted') {
				// The fold notes2 asks for by name: *"automatically and visibly folded at
				// the context threshold"*. Visibly is this line.
				rec.messages.push({ role: 'fold_log', content: ev.content || '',
					folded: ev.folded || 0, kept: ev.kept || 0, mid: newMid(), ts: Date.now() });
				if (onScreen) appendCompacted(ev.content || '');
			} else if (ev.type === 'error') {
				sawError = true;
				setCrystalStatus('Error: ' + (ev.content || ''));
				rec.messages.push({ role: 'error_log', content: ev.content || '',
					mid: newMid(), ts: Date.now() });
				if (onScreen) appendError(ev.content || '');
			}
		};
		var fa = diamondApp(diamondId);            // the Diamond steers with its own model
		try {
			// The conversation goes out and comes back. It is what makes the daimon
			// persistent, which is the whole of notes2's "the daimon is meant to be
			// persistant": it used to build a fresh session per instruction, so it could
			// not be asked a follow-up question.
			var after = await fa.steer_crystal(diamondId, instruction,
				(rec.session && rec.session.msgs) || [], onEvent);
			if (onScreen) finalizeAssistant();
			if (replyText) {
				rec.messages.push({ role: 'assistant', content: replyText,
					mid: newMid(), ts: Date.now() });
			}
			rec.session = { v: 1, msgs: Array.prototype.slice.call(after || []),
				upto: '', uptoTs: 0 };
			try {
				rec.lastPrompt = fa.last_prompt_tokens || rec.lastPrompt || 0;
			} catch (e) { /* the app is mid-turn nowhere here */ }
			touchChat(rec);
			persistChats();
		// A daimon can now draw and drop links itself, and every other caller of
		// `signalLinksChanged` is a user action — so without this the Graph pane
		// and the Diamond's Links section stay stale until something unrelated
		// redraws them, and the world model looks like it did not take.
		signalLinksChanged();
			meterDiamondTurn(fa);
			setCrystalStatus('');
			await refreshDiamondAfterChange();
			Files.refresh();
		} catch (e) {
			// A failure BEFORE the turn — an unresolvable `/name`, an unreadable crystal.
			// A failure DURING one no longer arrives here: `steer_crystal` returns the
			// conversation whatever happened, and reports the failure through the event
			// sink, so the daimon does not forget a turn it was already billed for.
			if (onScreen) { finalizeAssistant(); appendError(friendlyError(e)); }
			rec.messages.push({ role: 'error_log', content: friendlyError(e),
				mid: newMid(), ts: Date.now() });
			persistChats();
			setCrystalStatus(friendlyError(e));
			rec._generating = false;
			if (onScreen) syncComposer();
			setCrystalBusy(false);
			return;
		}
		rec._generating = false;
		if (onScreen) syncComposer();
		setCrystalBusy(false);
		// A turn that died part-way may still have asked for agents before it died.
		// Starting them would be spending on the strength of a turn that failed, which
		// is precisely what the user cannot see from here.
		if (sawError && dispatched.length) {
			setCrystalStatus(t('crystal.dispatch_after_error'));
		} else if (dispatched.length) {
			// The spend gate: a large fan-out pauses here for a look before
			// a single worker is enqueued. A normal dispatch clears silently.
			var cleared = await governorClearsDispatch(dispatched.length, diamondId);
			if (!cleared) {
				setCrystalStatus(dispatched.length === 1
					? 'Agent not started.'
					: 'Agents not started.');
			} else {
				setCrystalStatus(dispatched.length === 1
					? 'Dispatched 1 agent.'
					: 'Dispatched ' + dispatched.length + ' agents.');
				// Whether the steering turn itself read anything from outside.
				var daimonTainted = false;
				try { daimonTainted = !!(fa.is_tainted && fa.is_tainted()); } catch (e) { daimonTainted = false; }
				// On the model the user chose for THIS Diamond's workers -- not the starred
				// default, which is what every worker used to be built on however the Diamond
				// itself was pinned.
				// The depth travels with the batch: when these workers finish, their
				// reports come back as a round one deeper, and a daimon that answers
				// every report by dispatching again runs out of room rather than
				// fanning out for ever.
				Workers.dispatch(diamondId, diamondName, dispatched, daimonTainted,
					diamondWorkerModel(diamondId), (depth | 0));
			}
		} else if (rejected) {
			setCrystalStatus(rejected === 1
				? 'An agent was requested with no task, so nothing was started.'
				: rejected + ' agents were requested with no task, so nothing was started.');
		} else if (replyText.trim() && !onScreen) {
			// The turn neither dispatched nor edited its way to a visible change; it
			// answered in words. On the CRYSTAL face there is nowhere else for those
			// words to go, so they go in the reply box. In the chat view they are
			// already in the thread, and putting them here as well would print the
			// same answer twice.
			setCrystalReply(replyText);
		}
	}

	/// Propose a fold: run the reducer over the current crystal plus the
	/// delta, then show the diff for the user to Accept or Reject.  Writes
	/// nothing — the advisory half of the fold.
	async function doFoldPropose() {
		if (crystalBusy || !currentDiamond) return;
		var deltaEl = document.getElementById('fold-delta');
		if (!deltaEl) return;
		var delta = deltaEl.value.trim();
		if (!delta) return;
		if (!diamondCanRun(currentDiamond.id)) {
			openSettings(t('crystal.no_key_fold'));
			return;
		}
		setCrystalBusy(true);
		setCrystalStatus(t('fold.proposing'));
		showCrystalSpinner();
		var current_md, proposed;
		var fa = diamondApp(currentDiamond.id);   // this Diamond's model, not the starred one
		try {
			current_md = await fa.read_crystal(currentDiamond.id);
			proposed = await fa.fold_propose(currentDiamond.id, delta);
		} catch (e) {
			meterDiamondTurn(fa);
			hideCrystalSpinner();
			setCrystalStatus(friendlyError(e));
			setCrystalBusy(false);
			toast(friendlyError(e), true);
			return;
		}
		meterDiamondTurn(fa);
		hideCrystalSpinner();
		setCrystalStatus('');
		setCrystalBusy(false);
		// As in foldChatInto: an empty proposal is a failure, not a deletion of
		// everything the crystal says.
		if (!proposed || !String(proposed).trim()) {
			toast(t('fold.empty_reply'), true);
			return;
		}
		pendingFolds[currentDiamond.id] = {
			base: current_md, proposed: proposed, delta: delta, chatId: null, chatName: null,
		};
		renderFoldDiff(currentDiamond.id);
		renderDiamondList();
	}

	/// Show the fold diff (current vs proposed) with Accept and Reject.
	/// Every line is escaped via textContent (H5); nothing is written
	/// until the user accepts.
	function renderFoldDiff(diamondId) {
		var st = pendingFolds[diamondId];
		if (!st) { renderCrystal(); return; }
		var f = diamonds.find(function (x) { return x.id === diamondId; });
		crystalBody.innerHTML = '';
		var diff = lineDiff(st.base || '', st.proposed || '');
		var changed = diff.some(function (d) { return d.kind === 'add' || d.kind === 'del'; });

		var head = document.createElement('div');
		head.className = 'diff-head';
		// Say what is being folded into what: by this point the centre has
		// already switched away from the chat, so its name is nowhere on screen.
		// Say what is going into what. The Diamond's name is an optional half of
		// the sentence, so each shape is its own string rather than a fragment
		// glued on: a language that puts the target first cannot reorder glue.
		var into = f ? f.name : '';
		head.textContent = !changed
			? (into ? t('diff.no_change_into', { diamond: into }) : t('diff.no_change'))
			: st.chatName
				? (into ? t('diff.folding_chat_into', { chat: st.chatName, diamond: into })
					: t('diff.folding_chat', { chat: st.chatName }))
				: (into ? t('diff.proposed_into', { diamond: into }) : t('diff.proposed'));
		crystalBody.appendChild(head);

		var lines = document.createElement('div');
		lines.className = 'diff-lines';
		diff.forEach(function (d) {
			var row = document.createElement('div');
			row.className = 'diff-line' + (d.kind === 'add' ? ' add' : d.kind === 'del' ? ' del' : '');
			var sign = document.createElement('span');
			sign.className = 'sign';
			sign.textContent = d.kind === 'add' ? '+' : d.kind === 'del' ? '-' : ' ';
			row.appendChild(sign);
			row.appendChild(document.createTextNode(d.text));  // escaped (H5)
			lines.appendChild(row);
		});
		crystalBody.appendChild(lines);

		// Controls become Accept / Reject for the duration of the diff.
		crystalControls.innerHTML = '';
		var status = document.createElement('div');
		status.className = 'crystal-status';
		status.id = 'crystal-status';
		var actions = document.createElement('div');
		actions.className = 'diff-actions';
		var accept = document.createElement('button');
		accept.className = 'diff-accept';
		accept.textContent = t('diff.accept');
		// Accepting a no-op fold used to bump the crystal version and write a
		// duplicate delta, so re-folding the same chat quietly grew the history
		// with nothing in it.
		accept.disabled = !changed;
		if (!changed) accept.title = t('diff.nothing_to_apply');
		accept.addEventListener('click', doFoldAccept);
		var reject = document.createElement('button');
		reject.className = 'diff-reject';
		reject.textContent = changed ? t('diff.reject') : t('common.close');
		reject.addEventListener('click', function () {
			delete pendingFolds[diamondId];
			renderCrystal();
			renderDiamondList();          // the rail row carries the pending mark
		});
		actions.appendChild(accept); actions.appendChild(reject);
		crystalControls.appendChild(status);
		crystalControls.appendChild(actions);
	}

	// ── Artefacts ───────────────────────────────────────────────────────
	//
	// The things a stretch of work produced or consulted: files written, pages opened. They
	// are not declared by anyone. Every tool call an agent makes is already recorded on the
	// turn as a `tool_log` with its name and arguments, so the list is derivable — and a
	// derived list cannot drift, because nobody has to remember to maintain it.
	//
	// Harvested at the FOLD, for two reasons. The fold is where the back-and-forth is
	// deliberately dropped, so it is the last moment the tool calls still exist to read. And
	// it is a moment the user has already blessed, so nothing is recorded behind their back.

	/// Which tools make an artefact, and what the link says.
	//
	// WRITES only. An agent that reads forty files to find one thing has produced nothing,
	// and forty links would drown the one that matters. `web_open` is the exception: putting
	// a page on the screen is deliberate in a way a background fetch is not.
	var ARTEFACT_TOOLS = {
		file_write: { arg: 'path', kind: 'file', rel: 'produced' },
		file_edit:  { arg: 'path', kind: 'file', rel: 'produced' },
		file_move:  { arg: 'to',   kind: 'file', rel: 'produced' },
		dir_create: { arg: 'path', kind: 'file', rel: 'produced' },
		web_open:   { arg: 'url',  kind: 'url',  rel: 'consulted' },
		// The declared one, and the only one that is not a side effect of doing
		// something else. It says `holds`, not `produced`: the Diamond did not
		// make this file, it claims it, and recording a file the user wrote as
		// something an agent produced would be a lie about where work came from
		// in the one list that exists to answer that.
		artefact_add: { arg: 'path', kind: 'file', rel: 'holds' },
	};

	/// The artefacts named by a run of messages, deduplicated, in first-seen order.
	///
	/// A malformed `args` is skipped rather than thrown on: this runs inside an accepted
	/// fold, and a fold that has already been applied must not fail afterwards over a tool
	/// call nobody will ever look at.
	function artefactsIn(messages) {
		var out = [], seen = {};
		(messages || []).forEach(function (m) {
			if (!m || m.role !== 'tool_log') return;
			var spec = ARTEFACT_TOOLS[m.name];
			if (!spec) return;
			var args;
			try { args = JSON.parse(m.args || '{}'); } catch (e) { return; }
			var val = args && args[spec.arg];
			if (typeof val !== 'string' || !val.trim()) return;
			var ref = spec.kind + ':' + val.trim();
			if (seen[ref]) return;
			seen[ref] = 1;
			out.push({ ref: ref, rel: spec.rel });
		});
		return out;
	}

	/// Record what a just-accepted fold produced, as links on the Diamond.
	///
	/// Never throws and never blocks the fold: the crystal is already written by the time this
	/// runs, so a failure here costs a list, not the user's work. Links that already exist
	/// are skipped, so re-folding the same chat does not stack duplicates.
	async function harvestArtefacts(diamondId, st) {
		try {
			var msgs = [];
			if (st.sourceRun && st.sourceRun.messages) msgs = st.sourceRun.messages;
			else if (st.chatId) {
				var chat = chats.find(function (c) { return c.id === st.chatId; });
				msgs = chat ? chat.messages : [];
			}
			var found = artefactsIn(msgs);
			if (!found.length) return;

			var self = 'diamond:' + diamondId;
			var have = {};
			try {
				JSON.parse(await diamondApp().links_touching(self) || '[]')
					.forEach(function (l) { have[l.to] = 1; });
			} catch (e) { /* no links yet, or unreadable: treat as none */ }

			var made = 0;
			for (var i = 0; i < found.length; i++) {
				if (have[found[i].ref]) continue;
				try {
					await diamondApp().add_link(diamondId, self, found[i].ref, found[i].rel, '', 'fold');
					made++;
				} catch (e) { /* one bad ref must not stop the rest */ }
			}
			// A fold makes links like any other writer, so whatever draws them is
			// told the same way.
			if (made) signalLinksChanged();
			if (currentDiamond && currentDiamond.id === diamondId) renderCrystal();
		} catch (e) { /* an artefact list is never worth failing a fold over */ }
	}

	/// Accept the proposed fold: write the new crystal, retain the raw
	/// delta, log the fold, then re-render.  A fold never auto-applies.
	async function doFoldAccept() {
		if (!currentDiamond) return;
		var diamondId = currentDiamond.id;
		var st = pendingFolds[diamondId];
		if (!st) return;
		// Belt and braces beside the disabled button: applying a fold that
		// changes nothing would still bump the version and write a duplicate
		// delta, quietly growing the history with nothing in it.
		if ((st.base || '') === (st.proposed || '')) {
			delete pendingFolds[diamondId];
			renderCrystal(); renderDiamondList();
			return;
		}
		delete pendingFolds[diamondId];
		renderDiamondList();              // the row's pending mark goes with it
		setCrystalStatus('Applying fold…');
		try {
			await diamondApp().fold_apply(diamondId, st.proposed, st.delta, 'fold via UI');
		} catch (e) {
			setCrystalStatus(friendlyError(e));
			return;
		}
		await harvestArtefacts(diamondId, st);

		// Record where the chat went, so the tile can say so and the user is
		// not left wondering whether the fold took. A fold of a few chosen turns is not the
		// chat going anywhere, so it leaves no such mark.
		if (st.chatId && !st.partial) {
			var chat = chats.find(function (c) { return c.id === st.chatId; });
			if (chat) {
				chat.foldedInto = { id: diamondId, name: currentDiamond.name, at: Date.now(),
					at_len: (chat.messages || []).length };
				touchChat(chat);
				persistChats();
				renderSessionList();
			}
		}
		// A worker's summary that has now been applied is marked so its tile no
		// longer offers to fold the same text in a second time.
		if (st.sourceRun) {
			st.sourceRun.folded = true;
			Workers.persist();
			Workers.render();
		}
		await refreshDiamondAfterChange();
	}

	/// A minimal LCS line diff, producing tagged lines (same / add / del).
	/// Used only for display, so a straightforward dynamic-programming
	/// table is more than adequate for crystal-sized inputs.
	function lineDiff(a, b) {
		var A = a.split('\n'), B = b.split('\n');
		var n = A.length, m = B.length;
		// LCS length table.
		var dp = [];
		for (var i = 0; i <= n; i++) { dp[i] = new Array(m + 1).fill(0); }
		for (var i = n - 1; i >= 0; i--) {
			for (var j = m - 1; j >= 0; j--) {
				dp[i][j] = (A[i] === B[j]) ? dp[i + 1][j + 1] + 1
					: Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
		var out = [];
		var i = 0, j = 0;
		while (i < n && j < m) {
			if (A[i] === B[j]) { out.push({ kind: 'same', text: A[i] }); i++; j++; }
			else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: 'del', text: A[i] }); i++; }
			else { out.push({ kind: 'add', text: B[j] }); j++; }
		}
		while (i < n) { out.push({ kind: 'del', text: A[i] }); i++; }
		while (j < m) { out.push({ kind: 'add', text: B[j] }); j++; }
		return out;
	}

	// ── Local identity (D1) + BYOK key encryption (D5) ─────────
	// A passphrase-derived key (WebCrypto, see identity.js) encrypts the stored
	// API key and is the on-device Daimond identity. The username is a local label
	// for that identity — there is no server and no password stack behind it,
	// so the passphrase is what actually unlocks anything. Later this maps 1:1
	// to an Oxegen identity.
	function identityAvailable() { return !!(window.DaimondIdentity && DaimondIdentity.available()); }

	var locked = false;

	/// Draw the app for a user who is entitled to see it.
	function renderAll() {
		trail('renderAll');
		step('Workers.load', function () { return Workers.load(); });
		// These two were called with no `await` and no `.catch`, so anything they
		// threw became an unhandled rejection -- which is exactly what the phone's
		// trail showed, twice per boot, from `opfs.rs` failing to open a path.
		step('Instructions.refresh', function () { return Instructions.refresh(); });
		step('Prompts.refresh', function () { return Prompts.refresh(); });
		renderSessionList();
		var firstChat = chats.find(function (c) { return !c.diamondId; });
		if (firstChat) { selectChat(firstChat); } else { renderEmptyState(); }
		// The two defaults are offered only after the rail's own Diamonds are read
		// and any older root has been merged -- `list_diamonds` is what runs
		// `migrate_root` -- so the "only into an empty rail" rule is answered from
		// the store as it finally stands, not as it stood mid-migration.
		step('loadDiamonds', function () {
			return loadDiamonds().then(function () { return seedDefaultDiamonds(); });
		});
		step('Pending.load', function () { Pending.load(); Pending.render(); });
		step('triggerClock', function () { startTriggerClock(); });
		step('updateSpend', function () { updateSpend(); });
		step('panels.reflow', function () { DaimondPanels.reflow(); });
		if (!isMobile() && DaimondPanels.isOpen('work')) Files.onOpen();
		// A panel that was already open when the app booted is never `show`n,
		// so it would otherwise never ask the gateway what this account holds
		// and would sit there reporting the account service unreachable.
		if (window.DaimondMail && DaimondPanels.isOpen('mail')) DaimondMail.onOpen();
		// And the Terminal, for the same reason: a panel left open in the saved
		// layout is never `show`n, so nothing would ever build the terminal into it.
		if (window.DaimondTerm && DaimondPanels.isOpen('term')) DaimondTerm.onOpen();
		// Fold back whatever was in flight when the tab last died. Runs after Workers.load, so an
		// interrupted agent's record exists to enrich; repaints the affected chat and the panel.
		recoverInterrupted();
	}

	/// Lock: take the user's content OFF the screen.
	///
	/// The old lock was a modal laid over a live app — every chat, every name,
	/// the spend row and any turn still streaming were all legible behind it,
	/// before a passphrase was typed. So it emptied the DOM of nothing and
	/// protected nothing. This clears the rendered content, stops the app
	/// spending money, and only then asks for the passphrase.
	/// One line in the durable trail. See www/js/breadcrumb.js.
	function trail(w, d) { try { window.DaimondTrail.note(w, d); } catch (e) {} }

	/// Run a step of the boot and RECORD it, so a tab that dies part-way names
	/// the step it died on.
	///
	/// The iPhone loop was invisible for three sessions because every diagnosis
	/// came from reading code. The first trail from the device settled that the
	/// tab is not reloading -- there is no `pagehide` anywhere in it -- but not
	/// what kills it. These markers are what turn the next trail into an answer.
	/// Deliberately fire-and-forget WITH a catch: a step that throws must be
	/// recorded and must not take the rest of the boot with it, which is exactly
	/// what `Instructions.refresh()` and `Prompts.refresh()` were doing.
	function step(name, fn) {
		try {
			var r = fn();
			if (r && typeof r.then === 'function') {
				return r.then(function (v) { trail('ok ' + name); return v; },
					function (e) { trail('FAILED ' + name, (e && (e.message || e)) || '?'); });
			}
			trail('ok ' + name);
			return r;
		} catch (e) {
			trail('FAILED ' + name, (e && (e.message || e)) || '?');
		}
	}

	function lockApp() {
		// In the trail, because "the app locked itself" and "the page reloaded"
		// look identical from the outside and need completely different fixes.
		try { DaimondTrail.note('lockApp', 'the user pressed log out'); } catch (e) {}
		// Every chat that is still spending is stopped, not just the visible one.
		chats.forEach(function (c) {
			if (c._generating) {
				try { if (c.app) c.app.abort(); } catch (e) { /* already gone */ }
				c._generating = false;
			}
			// Locking takes the user's content off the screen, so a queue is content
			// too — and it must not fire a turn into a locked app. What was said into
			// a running turn is the same content and goes the same way; the drain in
			// `reclaimInterjections` checks `locked` so a turn ending after this
			// cannot hand it back onto a locked screen.
			c._queue = [];
			c._interject = [];
			c._aborted = true;
		});
		hideSpinner();
		setSendMode('send');

		try { DaimondIdentity.lock(); } catch (e) { /* already locked */ }

		// And tell the gateway. Locking used to forget only the keys held here,
		// which left the session opened at unlock alive for up to an hour -- and
		// the operator console rides that session, so "Log out" shut the app and
		// left the console open to whoever sat down next. Pressing it is a person
		// saying they are done, and it has to mean it on both sides.
		if (window.DaimondGateway && DaimondGateway.logout) {
			DaimondGateway.logout().catch(function () {});
		}

		// A locked Daimond holds no readable key. Clearing `cfg.apiKey` used to be the whole of
		// that, because there was one key and it lived there. There are now a key per provider,
		// held in memory by DaimondModels, and a built agent for every chat and Diamond with its
		// key already inside the wasm -- so locking must forget all three, or it locks the door
		// and leaves the keys in it.
		cfg.apiKey = '';
		// And the push credential, which is a key in the door exactly as the others
		// are: it lives in the engine, nothing else clears it, and a locked Daimond
		// that can still push to the user's repositories is not locked.
		cfg.pushToken = '';
		applyPushCred();
		if (window.DaimondModels) DaimondModels.lock();
		chats.forEach(function (c) { c.app = null; });
		resetDiamondApps();

		locked = true;
		current = null;
		currentDiamond = null;
		signalDiamondChanged();

		document.body.classList.add('locked');
		sessionList.innerHTML = '';
		diamondList.innerHTML   = '';
		chatOutput.innerHTML  = '';
		crystalBody.innerHTML   = '';
		agentsList.innerHTML  = '';
		crystalControls.innerHTML = '';       // the steer line and the fold control
		aiMeter.textContent = '';
		Workers.runs = [];
		sessionNameEl.textContent = '';
		chatInputBar.style.display = 'none';
		var spend = document.getElementById('spend-row');
		// Hiding it left the figures sitting in the DOM; empty it.
		if (spend) { spend.innerHTML = ''; spend.style.display = 'none'; }
		Files.clear();
		// The terminal goes with the rest of it: the program is asked to stop and
		// the screen is destroyed, so a locked app is not one with a live shell
		// drawing behind the passphrase box.
		try { if (window.DaimondTerm) DaimondTerm.onClose(); } catch (e) { /* never built */ }
		DaimondAdmin.clear();
		if (window.DaimondMail) DaimondMail.clear();

		updateUserRow();
		showIdentity('unlock');
	}

	// ── Accounts: several people, one browser ──────────────────
	//
	// Each account is a passphrase identity with its own everything (accounts.js namespaces the
	// storage; the wasm namespaces the workspace). Switching is a reload, because every module
	// reads its account's data once, at load — so the clean way to hand them another account is to
	// start them again.

	/// Copy the unlocked identity's name and fingerprint into the account registry, so the picker
	/// can name an account without unlocking it.
	function syncAccountFromIdentity() {
		if (!window.DaimondAccounts || !window.DaimondIdentity) return;
		var id = DaimondAccounts.current();
		if (!id) return;
		DaimondAccounts.rename(id, DaimondIdentity.displayName() || '');
		DaimondAccounts.setFp(id, DaimondIdentity.fingerprint() || '');
	}

	/// Switch to another existing account: lock this one, point storage at that one, and reload so
	/// every module reads the new account from scratch.
	async function switchAccount(id) {
		if (!window.DaimondAccounts) return;
		if (id === DaimondAccounts.current()) return;
		try { if (window.DaimondIdentity) DaimondIdentity.lock(); } catch (e) { /* already */ }
		// Awaited, not fired and forgotten: the reload below would cancel it, and
		// the session being ended is this account's. Until the next identity is
		// unlocked the browser would otherwise still carry the previous
		// account's cookie -- and open the console as them.
		if (window.DaimondGateway && DaimondGateway.logout) {
			try { await DaimondGateway.logout(); } catch (e) { /* go anyway */ }
		}
		// The pause tree is per account and is held in memory as well as on disk.
		// The reload below empties it anyway — every account boundary here is a
		// reload — but that is an implementation detail, and one account's pauses
		// colouring another's rail would be a money bug, not a cosmetic one. Not
		// dead code: a guard against the day the reload goes.
		try { if (window.DaimondPause) DaimondPause.reset(); } catch (e) { /* ignore */ }
		DaimondAccounts.setCurrent(id);
		location.reload();
	}

	/// Add a fresh account and reload into its create screen. The new account is empty, so boot
	/// finds no identity for it and opens the create flow; the name given there names it.
	async function addAccount() {
		if (!window.DaimondAccounts) return;
		try { if (window.DaimondIdentity) DaimondIdentity.lock(); } catch (e) { /* already */ }
		if (window.DaimondGateway && DaimondGateway.logout) {
			try { await DaimondGateway.logout(); } catch (e) { /* go anyway */ }
		}
		DaimondAccounts.add('');
		location.reload();
	}

	/// Draw the account switcher inside the unlock screen: every account by name, the current one
	/// marked, plus "add another". Shown only when it has something to offer (more than one account,
	/// or the standing option to add one).
	function renderAccountPicker(unlock) {
		var box = document.getElementById('id-accounts');
		if (!box) return;
		var A = window.DaimondAccounts;
		if (!A || !unlock) { box.style.display = 'none'; box.innerHTML = ''; return; }
		var accts = A.list();
		var cur = A.current();
		box.innerHTML = '';
		box.style.display = '';
		// A local element helper — the DaimondAdmin one is private to its closure and out of scope
		// here, and reaching for it was a ReferenceError that broke the whole unlock screen.
		function mk(tag, cls, text) {
			var n = document.createElement(tag);
			if (cls) n.className = cls;
			if (text != null) n.textContent = text;
			return n;
		}
		if (accts.length > 1) {
			box.appendChild(mk('div', 'id-accounts-lead', 'Unlocking:'));
			accts.forEach(function (a) {
				var b = mk('button', 'id-account' + (a.id === cur ? ' on' : ''));
				b.type = 'button';
				b.appendChild(mk('span', 'id-account-name', a.name || 'Unnamed account'));
				b.appendChild(mk('span', 'id-account-fp', a.fp || ''));
				if (a.id !== cur) b.addEventListener('click', function () { switchAccount(a.id); });
				box.appendChild(b);
			});
		}
		var add = mk('button', 'id-account-add', '＋ Add another account');
		add.type = 'button';
		add.addEventListener('click', addAccount);
		box.appendChild(add);
	}

	// ── The generated passphrase ───────────────────────────────
	// The passphrase is the crypto root: PBKDF2(passphrase, salt) is the wrapping
	// key, and it must stay reproducible from the passphrase alone or sync breaks.
	// So one string decrypts the whole synced workspace. A string a person chooses
	// is guessable, and is usually one they have used somewhere else -- which puts
	// the root of the account into another site's breach corpus. Generating it
	// removes both, and is what makes it safe to let a keychain hold a copy.
	// Typing your own is still allowed; it is just no longer the default.

	/// How many words a generated passphrase carries. Eight, matching Oxegen's
	/// login design, which is ~103 bits from the 7776-word list.
	var GEN_WORDS = 8;
	/// Whether the create screen is offering a generated passphrase.
	var idGenMode = false;

	/// True when a passphrase can be generated at all -- the wordlist module is
	/// part of the sealed build, so this is only false if that build is broken.
	function canGenerate() {
		return !!(window.DaimondWords && DaimondWords.generate);
	}

	/// Mirror whatever the passphrase field holds into the readout above it.
	///
	/// The readout deliberately owns no copy of its own. A browser that offers
	/// its own strong password on a `new-password` field would otherwise leave
	/// the words on screen disagreeing with the words in the field, and the user
	/// would write down the wrong secret.
	function syncGenReadout() {
		var inp  = document.getElementById('id-pass');
		var out  = document.getElementById('id-genwords');
		if (!inp || !out) return;
		out.textContent = getSecret(inp);
	}

	/// Put a freshly generated passphrase in the field and show it.
	function regenerate() {
		if (!canGenerate()) return false;
		var inp = document.getElementById('id-pass');
		if (!inp) return false;
		setSecret(inp, DaimondWords.generate(GEN_WORDS));
		syncGenReadout();
		return true;
	}

	/// Switch the create screen between the generated passphrase and a typed one.
	///
	/// Generated hides the confirm field: there is nothing to confirm, because
	/// the words are on screen to be read. Typed restores it, since a passphrase
	/// entered blind into a masked box does need checking against a second one.
	function setGenMode(on) {
		idGenMode = !!on && canGenerate();
		var box    = document.getElementById('id-genbox');
		var pass2  = document.getElementById('id-pass2-row');
		var choose = document.getElementById('id-choose');
		var note   = document.getElementById('id-gennote');
		var wrote  = document.getElementById('id-wrote');
		var inp    = document.getElementById('id-pass');
		// The confirm field and the "choose my own" escape hatch belong to the
		// CREATE screen only. On the UNLOCK screen there is nothing to generate and
		// nothing to confirm -- and, crucially, leaving the confirm field (an
		// autocomplete="new-password" input) visible there makes the browser offer
		// to GENERATE a passphrase in the middle of an unlock, next to a box asking
		// the user to confirm a passphrase they are only trying to re-enter. So both
		// are gated on actually creating an account, not merely on gen mode.
		var creating = document.getElementById('identity-modal').dataset.mode === 'create';
		if (box)    box.style.display    = idGenMode ? '' : 'none';
		if (pass2)  pass2.style.display  = (creating && !idGenMode) ? '' : 'none';
		// The escape hatch swings BOTH ways. It used to be shown only in generated
		// mode, so choosing your own passphrase was a one-way door: the button that
		// got you there vanished behind you, and the only way back to the generated
		// words was to cancel out of making an account altogether. Anyone who
		// clicked it to see what it did was stuck. It is offered whenever a
		// passphrase could be generated, and its label says where it leads.
		if (choose) {
			choose.style.display = (creating && canGenerate()) ? '' : 'none';
			choose.textContent   = idGenMode
				? t('identity.choose_own')
				: t('identity.use_generated');
		}
		if (wrote)  wrote.checked = false;
		// Only when generating: the note names the entropy, and reading it off the
		// wordlist means the figure cannot drift from the list actually shipped.
		if (note && idGenMode) {
			note.textContent = t('identity.gen_note', { bits: Math.round(DaimondWords.bits(GEN_WORDS)) });
		}
		if (inp) {
			// The field stays a masked `type="password"` in BOTH modes, including
			// while a generated passphrase is on screen. The readout above is where
			// the words are read from -- it sits with the note and the written-it-down
			// tick, which is where a person is already looking. Revealing the field
			// as well would leave it as `type="text"` at the moment the form is
			// submitted, and Firefox and Safari decide whether to offer to save a
			// credential largely on there being a real password field at that moment.
			// The eye is still there for anyone who wants it.
			setSecretRevealed(inp, false);
			syncEyeIcon('id-pass');
		}
		syncPrimaryEnabled();
	}

	/// Enable the create button only once a generated passphrase is acknowledged
	/// as written down. The acknowledgement is the only guard between a user and
	/// an unrecoverable account, so it gates the button rather than warning after.
	function syncPrimaryEnabled() {
		var btn   = document.getElementById('id-primary');
		var wrote = document.getElementById('id-wrote');
		var m     = document.getElementById('identity-modal');
		if (!btn || !m) return;
		var creating = m.dataset.mode === 'create';
		btn.disabled = !!(creating && idGenMode && wrote && !wrote.checked);
	}

	/// Put the app's own trail on the lock screen WHEN, AND ONLY WHEN, it is
	/// looping.
	///
	/// This exists because of a bug that could not be seen. A phone reported
	/// "unlock, the app appears for a second, the lock screen is back", three
	/// times across three sessions, and it was diagnosed twice from reading code
	/// rather than from evidence -- both times wrongly. Seeing a browser console
	/// on iOS needs a Mac attached, so every report was a description.
	///
	/// The trigger is the loop itself: three boots inside ninety seconds is not
	/// something a person does, and there is no point offering diagnostics to
	/// somebody whose app is working. `breadcrumb.js` writes nothing but fixed
	/// event names and a clock -- no key, no token, no message text -- so what
	/// appears here is safe to read out and safe to paste.
	function showTrailIfLooping() {
		var card = document.querySelector('#identity-modal .modal-card');
		if (!card || !window.DaimondTrail) return;
		var old = document.getElementById('id-trail');
		if (old) old.remove();

		var rows = [];
		try { rows = DaimondTrail.rows() || []; } catch (e) { return; }
		var now = Date.now();
		var boots = rows.filter(function (r) {
			return r && r.w === 'boot' && now - r.t < 90000;
		}).length;
		if (boots < 3) return;

		var wrap = document.createElement('div');
		wrap.className = 'id-trail';
		wrap.id = 'id-trail';

		var lead = document.createElement('p');
		lead.className = 'id-trail-lead';
		lead.textContent = t('trail.looping', { n: boots });
		wrap.appendChild(lead);

		var pre = document.createElement('pre');
		pre.className = 'id-trail-text';
		pre.textContent = DaimondTrail.text();      // escaped via textContent
		wrap.appendChild(pre);

		var row = document.createElement('div');
		row.className = 'id-trail-acts';
		var copy = document.createElement('button');
		copy.type = 'button';
		copy.className = 'id-trail-btn';
		copy.textContent = t('trail.copy');
		copy.addEventListener('click', function () {
			var text = DaimondTrail.text();
			// `writeText` needs a permission a locked page may not have, and this
			// is exactly the screen where nothing else works either. The textarea
			// fallback is what makes the button honest on a phone.
			var done = function () { copy.textContent = t('trail.copied'); };
			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
			} else { fallback(text, done); }
		});
		var clear = document.createElement('button');
		clear.type = 'button';
		clear.className = 'id-trail-btn';
		clear.textContent = t('trail.clear');
		clear.addEventListener('click', function () {
			try { DaimondTrail.clear(); } catch (e) {}
			wrap.remove();
		});
		row.appendChild(copy); row.appendChild(clear);
		wrap.appendChild(row);
		card.appendChild(wrap);
	}

	/// Select-and-copy, for a browser that will not give the clipboard to this
	/// page. Removed straight after, so nothing is left on screen.
	function fallback(text, done) {
		try {
			var ta = document.createElement('textarea');
			ta.value = text;
			ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
			document.body.appendChild(ta);
			ta.select();
			document.execCommand('copy');
			ta.remove();
			done();
		} catch (e) { /* nothing else to try; the text is on screen to be read */ }
	}

	function showIdentity(mode) {           // 'create' | 'unlock'
		var m = document.getElementById('identity-modal');
		var unlock = mode === 'unlock';
		var name = (window.DaimondIdentity && DaimondIdentity.displayName()) || '';
		showTrailIfLooping();
		renderAccountPicker(unlock);
		renderPasskeyOption(unlock);
		// A device that just redeemed a pairing code reloads into unlock mode. The
		// passphrase box then reappears with the linked account's name, and it must
		// be unmistakable that the passphrase to type is the one from the OTHER
		// device, not a new one for this device -- the flag carries that across
		// the reload, and is consumed here so it shows once.
		var linked = '';
		try { linked = sessionStorage.getItem('daimond-just-linked') || ''; sessionStorage.removeItem('daimond-just-linked'); } catch (e) { /* private mode */ }
		document.getElementById('id-title').textContent = unlock
			? (linked ? t('identity.title_linked')
				: (name ? t('identity.title_welcome', { name: name }) : t('identity.title_unlock')))
			: t('identity.title_create');
		document.getElementById('id-lead').textContent = unlock
			? (linked
				? (linked !== '1' ? t('identity.lead_linked_named', { name: linked }) : t('identity.lead_linked'))
				: t('identity.lead_unlock'))
			// Deliberately short: the passphrase box below carries the part that
			// matters (what it is, that nothing can reset it, write it down), and
			// repeating it here pushed the button and the escape hatch off screen.
			: t('identity.lead_create');
		// The name doubles as the username a password manager files the entry
		// under, so it stays in the form when unlocking rather than being hidden.
		// It is read-only there: it names the account being opened, not a choice.
		var nameInp = document.getElementById('id-name');
		document.getElementById('id-name-row').style.display = '';
		nameInp.readOnly = unlock;
		nameInp.value = unlock ? name : '';
		// Hide the whole confirm-passphrase field, its reveal eye included, when
		// unlocking -- hiding only the input would leave the eye button orphaned.
		document.getElementById('id-pass2-row').style.display = unlock ? 'none' : '';
		// The autocomplete token is the strongest hint a manager takes: it says
		// which field holds the credential and whether this is a sign-in or a
		// sign-up, which decides between offering to fill and offering to save.
		document.getElementById('id-pass').setAttribute('autocomplete',
			unlock ? 'current-password' : 'new-password');
		document.getElementById('id-primary').textContent    = unlock ? t('identity.unlock') : t('identity.create_account');
		document.getElementById('id-skip').textContent       = unlock ? t('identity.forget') : t('identity.skip');
		document.getElementById('id-error').textContent = '';
		// The passphrase box is cleared on every draw EXCEPT the first one of a
		// page's life. A redraw -- logging out, switching account -- must not leave
		// the last passphrase sitting in the field for whoever is at the browser
		// next. The first draw is different: the only thing that can be in the box
		// by then is what a password manager filled, and the form is in the served
		// HTML, so that fill lands as soon as the document parses while the gate
		// waits on the wasm engine. Clearing there emptied the box on a cold load
		// (a hard refresh refetches the engine) while a warm one, drawing sooner,
		// kept it -- the same passphrase remembered or forgotten by how long the
		// page took to start.
		if (!(unlock && !m.dataset.mode)) setSecret(document.getElementById('id-pass'), '');
		setSecret(document.getElementById('id-pass2'), '');
		setSecretRevealed(document.getElementById('id-pass'), false);
		setSecretRevealed(document.getElementById('id-pass2'), false);
		syncEyeIcon('id-pass');
		syncEyeIcon('id-pass2');
		m.dataset.mode = mode;
		// Creating starts from a generated passphrase; unlocking never generates,
		// so the readout and its acknowledgement stay out of the way.
		if (unlock) {
			setGenMode(false);
			document.getElementById('id-choose').style.display = 'none';
		} else if (canGenerate() && regenerate()) {
			setGenMode(true);
		} else {
			// The wordlist is part of the sealed build, so this only happens if
			// that build is broken. Fall back to a typed passphrase rather than
			// leave the user unable to make an account at all.
			setGenMode(false);
		}
		m.style.display = 'flex';
		(unlock ? document.getElementById('id-pass') : document.getElementById('id-name')).focus();
	}
	/// Take the gate away, and hand the keyboard to the app behind it.
	///
	/// Without the hand-over the focus stayed on `<body>`, so the first Tab after
	/// signing in (or skipping) started again at the very top of the document
	/// rather than at the thing the user had just been let through to.
	function hideIdentity() {
		document.getElementById('identity-modal').style.display = 'none';
		// After the redraw, not before it. Getting past the gate is followed
		// immediately by renderAll(), which rebuilds the rail and the stage -- so a
		// control focused here is a control that no longer exists a moment later,
		// and the focus falls back to the body.
		setTimeout(function () {
			if (document.activeElement && document.activeElement !== document.body) return;
			// The first candidate that is actually ON SCREEN. `chat-input` is in the
			// document from the start but hidden until a chat exists, and focusing a
			// hidden element does nothing at all -- so naming it first meant the
			// keyboard was handed to something invisible, which is to say nowhere.
			var next = ['chat-input', 'new-session-btn', 'new-diamond-btn']
				.map(function (id) { return document.getElementById(id); })
				.filter(function (el) { return el && el.getClientRects().length; })[0];
			if (next) { try { next.focus(); } catch (e) { /* gone */ } }
		}, 60);
	}

	// After a successful create/unlock: decrypt the stored key into memory and
	// request durable storage (now that the login has explained on-device data).
	async function afterUnlock() {
		if (cfg.apiKeyEnc && DaimondIdentity.isUnlocked()) {
			try { cfg.apiKey = await DaimondIdentity.unwrap(cfg.apiKeyEnc); } catch (e) { cfg.apiKey = ''; }
		}
		// The push credential, on the same footing and for a harder reason: the
		// engine's copy did not survive the reload that brought us here, and nothing
		// else in the app will ever put it back. Every path that ends in a usable app
		// passes through this function -- see "The credential a push travels with".
		if (cfg.pushTokenEnc && DaimondIdentity.isUnlocked()) {
			try { cfg.pushToken = await DaimondIdentity.unwrap(cfg.pushTokenEnc); }
			catch (e) { cfg.pushToken = ''; }
		}
		// Called even with nothing to replay: an empty token clears, so a credential
		// left standing from before a lock cannot outlive it into the next unlock.
		applyPushCred();
		// Every provider's key is sealed under the same passphrase, and unusable until now.
		if (window.DaimondModels) {
			trail('unseal keys');
			await DaimondModels.unseal();
			syncCfgFromModels();
		}
		try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* best-effort */ }
		// The settings are on screen now, not behind a button, so they must show
		// the user's own provider and key rather than an empty form.
		step('fillSettings', function () { fillSettings(); });
		// The gateway's auth is a signature from the device key, so it can only
		// run now. It is fire-and-forget: a gateway that is down must not hold up
		// a user who only ever wanted their own key.
		step('connectGateway', function () { return connectGateway(); });
	}

	async function idPrimary() {
		var mode = document.getElementById('identity-modal').dataset.mode;
		var err = document.getElementById('id-error');
		var pass = getSecret(document.getElementById('id-pass'));
		if (!pass) { err.textContent = t('identity.err_enter_pass'); return; }
		if (mode === 'create') {
			var name = document.getElementById('id-name').value.trim();
			if (!name) { err.textContent = t('identity.err_choose_name'); return; }
			if (idGenMode) {
				// A generated passphrase is on screen to be read, so there is no
				// confirm field to match. The only thing standing between the user
				// and an account nobody can recover is having written it down, and
				// the button is disabled until they say they have -- so reaching
				// here without the tick means the DOM was tampered with.
				var wrote = document.getElementById('id-wrote');
				if (wrote && !wrote.checked) {
					err.textContent = t('identity.err_confirm_written');
					return;
				}
				// Canonical spelling, so a stray space cannot produce a different
				// key from the same words.
				pass = DaimondWords.normalise(pass);
				// The generated phrase is far longer than this, so the floor only
				// ever catches a field that was edited down to something weak while
				// the generated-passphrase copy was still on screen.
				if (pass.length < 8) {
					err.textContent = t('identity.err_too_short_gen');
					return;
				}
			} else {
				if (pass.length < 8) { err.textContent = t('identity.err_too_short'); return; }
				if (pass !== getSecret(document.getElementById('id-pass2'))) { err.textContent = t('identity.err_mismatch'); return; }
			}
			try { await DaimondIdentity.create(name, pass); } catch (e) { err.textContent = t('identity.err_create'); return; }
			// Encrypt any key already held in memory under the new passphrase.
			if (cfg.apiKey) { try { cfg.apiKeyEnc = await DaimondIdentity.wrap(cfg.apiKey); saveCfg(cfg); } catch (e) { /* keep plaintext */ } }
		} else {
			var r;
			try { r = await DaimondIdentity.unlock(pass); } catch (e) { r = { ok: false }; }
			// A generated passphrase is words separated by spaces, and a phone
			// keyboard readily appends one after the last. Retry the canonical
			// spelling before calling it wrong -- but only AFTER the raw attempt
			// failed, so an existing passphrase that genuinely carries padding
			// still opens, and the second (expensive) derivation only ever runs
			// on an unlock that was going to be refused anyway.
			if ((!r || !r.ok) && window.DaimondWords) {
				var canon = DaimondWords.normalise(pass);
				if (canon !== pass) {
					try { r = await DaimondIdentity.unlock(canon); } catch (e) { r = { ok: false }; }
					if (r && r.ok) pass = canon;
				}
			}
			if (!r || !r.ok) { err.textContent = t('identity.err_wrong_pass'); return; }
		}
		// Hand the credential to the browser explicitly where it supports the
		// Credential Management API. The real form and its password field are what
		// make Safari and Firefox offer to save; this makes Chromium deterministic
		// about it rather than leaving it to heuristics.
		offerToSaveCredential(document.getElementById('id-name').value.trim(), pass);
		await completeUnlock();
		// The Models form no longer springs open on unlock. With no model the "No model connected"
		// row pulses (see status()), which points at the same task without burying the whole panel
		// under a form the moment the app opens.
		//
		// The app is on screen before this asks, so the offer reads as an aside
		// rather than one more gate between the user and their workspace.
		await maybeOfferPasskey(pass);
	}

	/// Ask the browser to remember the passphrase, where it offers a way to ask.
	///
	/// This is safe to do because the passphrase is GENERATED (see wordlist.js):
	/// there is nothing guessable or reused to hand over, and a keychain entry is
	/// what stops it being retyped on a phone several times a day -- which is what
	/// drives people to short, reused passphrases in the first place. Best-effort
	/// throughout: `PasswordCredential` is Chromium-only, and a browser that
	/// declines is no worse off than before, since the form itself still prompts.
	function offerToSaveCredential(name, pass) {
		try {
			if (!window.PasswordCredential || !navigator.credentials || !navigator.credentials.store) return;
			var cred = new window.PasswordCredential({
				id:       name || 'Daimond',
				password: pass,
				name:     name || 'Daimond',
			});
			navigator.credentials.store(cred).catch(function () { /* the user declined. */ });
		} catch (e) { /* unsupported shape; the form-based offer still stands. */ }
	}

	/// The shared tail of every successful create or unlock, whether the passphrase
	/// was typed or recovered from a passkey. Records the account in the registry,
	/// decrypts the stored keys into memory, takes the lock card off the screen and
	/// draws the app the user is now entitled to see.
	async function completeUnlock() {
		// Record this account's name and fingerprint in the registry, so the account picker can
		// show WHO an account is without unlocking it. The identity's keys are namespaced to the
		// current account, so this names the right one.
		syncAccountFromIdentity();
		trail('afterUnlock start');
		await afterUnlock();
		trail('afterUnlock done');
		hideIdentity();
		try { DaimondTrail.note('unlocked'); } catch (e) { /* no trail is not an error */ }
		// Only now is the user entitled to see their content.
		locked = false;
		document.body.classList.remove('locked');
		renderAll();
		updateUserRow();
		DaimondAdmin.home();
		DaimondAdmin.status();
	}

	// ── Passkey unlock (WebAuthn PRF) ──────────────────────────
	// A passkey recovers the passphrase and hands it to the same unlock path a
	// typed passphrase takes (see passkey.js). The button lives on the unlock
	// screen and is offered only when a passkey is enrolled AND the platform still
	// supports it; the passphrase field below it is always the fallback.

	/// Create the "Use a passkey" button and its note once, inserting them just
	/// after the primary Unlock button. Idempotent — later calls reuse them.
	function ensurePasskeyEls() {
		if (document.getElementById('id-passkey')) return;
		var primary = document.getElementById('id-primary');
		if (!primary) return;
		var btn = document.createElement('button');
		btn.type = 'button';
		btn.id = 'id-passkey';
		btn.className = 'id-passkey';
		btn.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">'
			+ '<circle cx="8" cy="10" r="4"/><path d="M11 11l8 8M16 16l2-2M19 19l2-2"/></svg>'
			+ '<span>Use a passkey</span>';
		btn.addEventListener('click', passkeyUnlock);
		primary.parentNode.insertBefore(btn, primary.nextSibling);
		var note = document.createElement('div');
		note.id = 'id-passkey-note';
		note.className = 'id-passkey-note';
		btn.parentNode.insertBefore(note, btn.nextSibling);
	}

	/// Show or hide the passkey button for the current identity-modal mode.
	///
	/// Two quite different offers share one button. On the UNLOCK screen with a
	/// passkey enrolled here, it opens this device's own sealed copy. On the
	/// CREATE screen — a device holding no identity at all — it offers to bring an
	/// account across from the user's synced passkey, which is the case that used
	/// to need a pairing code typed from a device already open.
	function renderPasskeyOption(unlock) {
		ensurePasskeyEls();
		var btn = document.getElementById('id-passkey');
		var note = document.getElementById('id-passkey-note');
		if (!btn) return;
		btn.style.display = 'none';
		btn.disabled = false;
		if (note) { note.style.display = 'none'; note.textContent = ''; note.className = 'id-passkey-note'; }
		if (!window.DaimondPasskey) return;

		var enrolled = DaimondPasskey.isEnrolled();
		var adopting = !unlock && !enrolled;
		if (unlock && !enrolled) return;		// nothing sealed here to open.
		btn.querySelector('span').textContent = t(adopting ? 'passkey.have_one' : 'passkey.use_one');
		btn._adopt = adopting;

		DaimondPasskey.available().then(function (ok) {
			var m = document.getElementById('identity-modal');
			if (!m) return;
			// Only reveal if the user is still on the screen this was decided for.
			if ((m.dataset.mode === 'unlock') !== !!unlock) return;
			if (!ok) {
				// A silent absence reads as "this feature does not exist". Where a
				// passkey IS enrolled and the platform has stopped honouring it,
				// say so, rather than leaving the user wondering where it went.
				if (enrolled && note) {
					note.className = 'id-passkey-note';
					note.style.display = '';
					note.textContent = t('passkey.browser_cannot');
				}
				return;
			}
			btn.style.display = '';
			if (adopting && note) {
				note.className = 'id-passkey-note';
				note.style.display = '';
				note.textContent = t('passkey.adopt_note');
			}
			// An enrolled passkey on the unlock screen is what the user came to
			// use, so ask for it straight away rather than making them press a
			// button first. A cancelled prompt just leaves the passphrase field,
			// and the button stays there to try again.
			if (unlock && enrolled && !passkeyAutoTried) {
				passkeyAutoTried = true;
				passkeyUnlock();
			}
		}).catch(function () { /* leave it hidden. */ });
	}

	/// Whether the automatic passkey prompt has already fired this page load.
	/// Once only: re-prompting after a cancel would trap the user in a loop of
	/// biometric dialogs with no way to reach the passphrase field.
	var passkeyAutoTried = false;

	/// Unlock with the enrolled passkey. On success runs the same tail as a typed
	/// passphrase; on any failure it explains why and leaves the passphrase field
	/// ready, so the passkey is never a dead end.
	async function passkeyUnlock() {
		var btn = document.getElementById('id-passkey');
		var note = document.getElementById('id-passkey-note');
		var err = document.getElementById('id-error');
		var adopt = !!(btn && btn._adopt);
		if (err) err.textContent = '';
		if (btn) btn.disabled = true;
		if (note) {
			note.className = 'id-passkey-note';
			note.style.display = '';
			note.textContent = t(adopt ? 'passkey.looking' : 'passkey.waiting');
		}
		var r;
		try {
			r = adopt
				? await DaimondPasskey.adoptWithPasskey()
				: await DaimondPasskey.unlockWithPasskey();
		} catch (e) { r = { ok: false, error: t('passkey.err_unusable') }; }
		if (!r || !r.ok) {
			if (note) { note.className = 'id-passkey-note err'; note.textContent = (r && r.error) || t('passkey.err_did_not_work'); }
			if (btn) btn.disabled = false;
			var pass = document.getElementById('id-pass');
			if (pass && !adopt) pass.focus();
			return;
		}
		await completeUnlock();
	}

	/// Add a passkey from Settings: confirm the passphrase (identity.js keeps no
	/// copy), then enrol it against the WebAuthn PRF credential.
	async function doAddPasskey() {
		var pass = await promptDialog(t('passkey.add_title'), {
			message: t('passkey.add_body'),
			okLabel: t('passkey.continue'),
			secret: true,
			validate: async function (v) {
				if (!v) return t('passkey.err_enter_pass');
				var ok = await DaimondIdentity.verify(v);
				return ok ? '' : t('passkey.err_bad_passphrase');
			},
		});
		if (!pass) return;
		var r;
		try { r = await DaimondPasskey.enrol(pass); }
		catch (e) { r = { ok: false, error: friendlyError(e) }; }
		if (!r || !r.ok) { noticeDialog(t('passkey.not_added'), (r && r.error) || t('passkey.err_create_failed2')); return; }
		// Whether the sealed copy reached the gateway decides what this passkey can
		// do, so it is stated rather than glossed: with it, the passkey brings the
		// account to a new device; without it, the passkey only opens this one.
		noticeDialog(t('passkey.added'),
			t(r.synced ? 'passkey.added_synced' : 'passkey.added_local'));
		DaimondAdmin.home();	// re-render so the control flips to "Remove passkey".
	}

	/// Remove the enrolled passkey: this device's sealed copy and the one held for
	/// it by the account service. The credential stays in the authenticator, inert
	/// with nothing left to open, for the user to delete there.
	async function doRemovePasskey() {
		var ok = await confirmDialog(
			t('passkey.remove_body'),
			t('home.remove_passkey'),
			{ title: t('passkey.remove_title'), danger: false });
		if (!ok) return;
		try { await DaimondPasskey.remove(); } catch (e) { /* nothing to remove */ }
		noticeDialog(t('passkey.removed'), t('passkey.removed_body'));
		DaimondAdmin.home();
	}

	/// Offer a passkey once, just after an unlock, on a device that could hold one
	/// and does not.
	///
	/// This is the missing step that left the whole feature unused: enrolling was
	/// only ever reachable from a Settings item that nothing pointed at, so a phone
	/// arrived with no passkey and stayed that way, and the user retyped a
	/// passphrase every time the browser discarded the tab. The moment just after
	/// an unlock is the one moment the passphrase is in hand and enrolment is free.
	/// Asked once per device, and never again whatever the answer.
	var K_PASSKEY_ASKED = 'daimond-passkey-asked';
	async function maybeOfferPasskey(passphrase) {
		if (!passphrase || !window.DaimondPasskey) return;
		try {
			if (localStorage.getItem(K_PASSKEY_ASKED) === '1') return;
			if (DaimondPasskey.isEnrolled()) return;
			if (!(await DaimondPasskey.available())) return;
		} catch (e) { return; }
		// Mark it asked BEFORE asking: a user who dismisses the dialog by
		// reloading should not meet it again on the next unlock.
		try { localStorage.setItem(K_PASSKEY_ASKED, '1'); } catch (e) { /* private mode */ }
		var yes = await confirmDialog(
			t('passkey.offer_body'),
			t('passkey.add_title'),
			{ title: t('passkey.offer_title'), danger: false, cancelLabel: t('dlg.not_now') });
		if (!yes) return;
		var r;
		try { r = await DaimondPasskey.enrol(passphrase); }
		catch (e) { r = { ok: false, error: friendlyError(e) }; }
		if (!r || !r.ok) {
			noticeDialog(t('passkey.not_added'), (r && r.error) || t('passkey.err_create_retry'));
			return;
		}
		noticeDialog(t('passkey.added'), t('passkey.added_offer'));
	}

	/// The secondary button: "Skip for now" on create, "Forget this identity…"
	/// on unlock (the only route for someone who has lost their passphrase).
	async function idSkip() {
		var mode = document.getElementById('identity-modal').dataset.mode;
		if (mode === 'unlock') {
			await forgetIdentity();
		} else {
			hideIdentity();
			locked = false;
			document.body.classList.remove('locked');
			renderAll();
			updateUserRow();
			DaimondAdmin.status();          // the pulse on the model row is the prompt now
		}
	}

	/// Destroy the identity. This USED to be labelled "forget everything" while
	/// leaving every chat sitting in localStorage in the clear — so resetting on
	/// a shared machine left the next person the whole conversation history. It
	/// now says what it does, and does what it says.
	async function forgetIdentity() {
		var A = window.DaimondAccounts;
		var acct = A ? A.account() : null;
		var others = A ? A.list().length - 1 : 0;

		// What is bound to this identity on the SERVER, which the local-data
		// warning never covered: the credit balance and a Pro licence are held
		// gateway-side and unlocked only by this key. Erase the key with no
		// backup and they are stranded for good -- real money, gone. State is
		// from the last successful bootstrap, so a balance seen this session is
		// known even if the gateway is momentarily unreachable now.
		var gw    = window.DaimondGateway ? DaimondGateway.state() : null;
		var bal   = gw && typeof gw.credits === 'number' ? gw.credits : 0;
		var pro   = !!(gw && gw.pro);
		var money = '';
		if (bal > 0 && pro)  money = 'a balance of ' + DaimondGateway.fmtMoney(bal, gw.currency) + ' and Daimond Pro';
		else if (bal > 0)    money = 'a balance of ' + DaimondGateway.fmtMoney(bal, gw.currency);
		else if (pro)        money = 'Daimond Pro';

		// When money rides on this identity, offer to save it before anything is
		// destroyed. A backup file re-imports the identity elsewhere, so the
		// credits and Pro are reachable again from the restored key.
		if (money) {
			var save = await confirmDialog(
				t('forget.credits_body', { amount: money }),
				t('home.export_backup'),
				{ title: t('forget.credits_title'), danger: false, cancelLabel: t('forget.skip') });
			if (save) {
				try { await doExport(); }
				catch (e) { /* the user asked to; a failed export must not block the choice below. */ }
			}
		}

		var owned = money ? ' ' + t('forget.abandons', { amount: money }) : '';
		var lead = (acct && !acct.primary)
			? t('forget.body_secondary', { name: acct.name || t('home.unnamed_account') }) + owned
				+ ' ' + t('forget.tail_secondary')
			: t('forget.body') + owned + ' ' + t('forget.tail');
		var ok = await confirmDialog(lead, t('forget.ok'), { title: t('forget.title') });
		if (!ok) return;

		var ns = A ? A.opfsNs() : '';       // this account's OPFS subdir ('' for the primary)

		// The session first, while the page is still alive to make the request.
		// An erased identity whose session outlives it is the same door left
		// open, and there is no key left here to close it with afterwards.
		if (window.DaimondGateway && DaimondGateway.logout) {
			try { await DaimondGateway.logout(); } catch (e) { /* erase anyway */ }
		}
		try { DaimondIdentity.reset(); } catch (e) { /* ignore */ }
		// Drop the pause tree held in memory as well as the one on disk. Every
		// account boundary in this app happens to be a full page reload today, so
		// this has no live effect — but the reload is an implementation detail and
		// has changed before, and one account's pauses colouring another's rail is
		// a money bug rather than a cosmetic one. Not dead code: a guard.
		try { if (window.DaimondPause) DaimondPause.reset(); } catch (e) { /* ignore */ }
		// Sweep every store this account owns. removeItem is namespaced to the current account, so
		// these clear THIS account's keys and no other's. remove() below sweeps anything not named
		// here; the explicit list is what the old, single-account reset erased.
		try {
			['daimond-chats', 'daimond-chats-deleted', 'daimond-chat-counter', 'daimond-diamond-counter',
			 'daimond-ledger', 'daimond-models', 'daimond-models-v2', 'daimond-diamond-models',
			 'daimond-agents-revealed', 'daimond-byok', 'daimond-hide-tools', 'daimond-workers',
			 'daimond-mail', 'daimond-hands',
			 // The pause tree. The PRIMARY account's keys are un-namespaced, so a
			 // set left behind here is inherited whole by the next account made in
			 // this browser: a Diamond that starts paused for no reason the user
			 // can see, and no way to work out why.
			 'daimond-pause',
			 // The device roster and this device's own id. An account made here
			 // afterwards is a new account, and it must not inherit the erased
			 // one's identity as a device or the devices it used to sync with.
			 'daimond-devices', 'daimond-device-id'].forEach(function (k) { localStorage.removeItem(k); });
		} catch (e) { /* best effort */ }

		// OPFS. A namespaced account lives in one subdirectory, so remove just that. The primary
		// uses the root, so remove the root's entries — but NEVER another account's `d~…` subdir.
		try {
			var root = await navigator.storage.getDirectory();
			if (ns) {
				await root.removeEntry(ns, { recursive: true }).catch(function () {});
			} else {
				for await (var ent of root.entries()) {
					if (ent[0].indexOf('d~') === 0) continue;    // another account — leave it
					await root.removeEntry(ent[0], { recursive: true }).catch(function () {});
				}
			}
		} catch (e) { /* OPFS may be unavailable */ }

		// The FSA reconnect handle and the write-ahead journal for this account, and — for a
		// non-primary account — the registry entry and any keys not caught above.
		try { indexedDB.deleteDatabase('daimond-fsa' + (ns ? '-' + ns : '')); } catch (e) { /* ignore */ }
		try { indexedDB.deleteDatabase('daimond-journal' + (ns ? '-' + ns : '')); } catch (e) { /* ignore */ }
		// The transcripts, which are the whole point of forgetting an account. Closed
		// first: a live connection blocks the delete, and a blocked delete is silent.
		try { await ChatStore.wipe(); } catch (e) { /* ignore */ }
		try { indexedDB.deleteDatabase(CHATS_DB + (ns ? '-' + ns : '')); } catch (e) { /* ignore */ }
		try { localStorage.removeItem(CHATS_LEGACY); } catch (e) { /* ignore */ }
		if (A && acct && !acct.primary) { try { A.remove(acct.id); } catch (e) { /* ignore */ } }

		cfg = loadCfg();          // a blank config, not the erased user's
		chats = [];
		location.reload();
	}

	// The account's controls were a floating menu anchored to the user row. They
	// are the Admin panel's home view now — a panel that exists to hold them
	// beats a popup that has to be dismissed. DaimondAdmin.renderHome builds them.

	async function doRename() {
		var name = await promptDialog(t('rename.title'), {
			value: DaimondIdentity.displayName(), okLabel: t('common.save'),
			validate: function (v) { return v ? '' : t('identity.err_choose_name'); },
		});
		if (!name) return;
		try { DaimondIdentity.rename(name); } catch (e) { noticeDialog(t('rename.failed'), friendlyError(e)); return; }
		updateUserRow();
	}

	/// Change the passphrase, and re-encrypt the stored API key under it — the
	/// key is sealed with the passphrase-derived wrapping key, so forgetting to
	/// re-seal it would leave the user unable to decrypt their own key.
	/// Ask for a NEW passphrase, generated by default, for the change flow.
	///
	/// This mirrors the create screen deliberately: the passphrase is GENERATED
	/// (the same eight words, wordlist and entropy), shown to be written down, and
	/// the change is gated behind an acknowledgement -- because the passphrase an
	/// existing account already carries is exactly the user-chosen, probably-reused
	/// one that generation exists to retire. "Choose my own" falls back to a typed
	/// passphrase with the old confirm step. Resolves the chosen passphrase (in its
	/// canonical spelling for a generated one), or null if cancelled.
	function promptNewPassphrase(curPass) {
		return new Promise(function (resolve) {
			var canGen = canGenerate();
			var genPass = canGen ? DaimondWords.generate(GEN_WORDS) : '';

			var back = document.createElement('div');
			back.className = 'modal dlg';
			back.id = 'cp-modal';
			var card = document.createElement('div');
			card.className = 'modal-card dlg-card';

			var h = document.createElement('h2');
			h.textContent = t('changepass.title');
			card.appendChild(h);

			var msg = document.createElement('p');
			msg.className = 'dlg-msg';
			msg.textContent = t('changepass.lead');
			card.appendChild(msg);

			// ── Generated view ──
			var gen = document.createElement('div');
			gen.className = 'pass-gen';
			gen.style.display = canGen ? '' : 'none';
			var words = document.createElement('div');
			words.className = 'pass-gen-words';
			words.id = 'cp-words';
			words.textContent = genPass;
			gen.appendChild(words);
			var acts = document.createElement('div');
			acts.className = 'pass-gen-acts';
			var regen = document.createElement('button');
			regen.type = 'button';
			regen.className = 'pass-gen-btn';
			regen.textContent = t('identity.generate_another');
			var copy = document.createElement('button');
			copy.type = 'button';
			copy.className = 'pass-gen-btn';
			copy.textContent = t('common.copy');
			acts.appendChild(regen);
			acts.appendChild(copy);
			gen.appendChild(acts);
			var note = document.createElement('p');
			note.className = 'pass-gen-note';
			if (canGen) {
				note.textContent = t('changepass.gen_note',
					{ bits: Math.round(DaimondWords.bits(GEN_WORDS)) });
			}
			gen.appendChild(note);
			var ackLab = document.createElement('label');
			ackLab.className = 'pass-gen-ack';
			var ack = document.createElement('input');
			ack.type = 'checkbox';
			ack.id = 'cp-wrote';
			var ackTxt = document.createElement('span');
			ackTxt.textContent = t('identity.wrote_it_down');
			ackLab.appendChild(ack);
			ackLab.appendChild(ackTxt);
			gen.appendChild(ackLab);
			card.appendChild(gen);

			// ── Typed view (the escape hatch) ──
			var typed = document.createElement('div');
			typed.style.display = 'none';
			var newInp = document.createElement('input');
			newInp.className = 'dlg-input';
			newInp.id = 'cp-pass';
			newInp.type = 'password';
			newInp.autocomplete = 'new-password';
			newInp.placeholder = t('changepass.new_ph');
			var againInp = document.createElement('input');
			againInp.className = 'dlg-input';
			againInp.id = 'cp-pass2';
			againInp.type = 'password';
			againInp.autocomplete = 'new-password';
			againInp.placeholder = t('changepass.again_ph');
			againInp.style.marginTop = '8px';
			typed.appendChild(newInp);
			typed.appendChild(againInp);
			card.appendChild(typed);

			var choose = document.createElement('button');
			choose.type = 'button';
			choose.className = 'id-choose';
			choose.style.display = canGen ? '' : 'none';
			choose.textContent = t('identity.choose_own');
			card.appendChild(choose);

			var err = document.createElement('div');
			err.className = 'dlg-err';
			card.appendChild(err);

			var row = document.createElement('div');
			row.className = 'dlg-actions';
			var cancel = document.createElement('button');
			cancel.type = 'button';
			cancel.className = 'modal-close dlg-cancel';
			cancel.textContent = t('common.cancel');
			var ok = document.createElement('button');
			ok.type = 'button';
			ok.className = 'dlg-ok';
			ok.textContent = t('changepass.change_it');
			row.appendChild(cancel);
			row.appendChild(ok);
			card.appendChild(row);

			back.appendChild(card);
			document.body.appendChild(back);

			// Generated by default where the wordlist is present; otherwise the typed
			// view is all there is. `genMode` gates which validation runs on submit.
			var genMode = canGen;

			/// The change button stays disabled until a generated passphrase is
			/// acknowledged as written down -- the one guard against an unrecoverable
			/// account, so it gates the button rather than warning after the fact.
			function syncOk() {
				ok.disabled = !!(genMode && !ack.checked);
			}

			/// Swing between the generated passphrase and a typed one.
			///
			/// The escape hatch swings BOTH ways, and its label says where it leads.
			/// It used to hide itself on the way through, which made choosing your own
			/// a one-way door: the only route back to the generated words was to
			/// cancel the passphrase change altogether. That is the very defect the
			/// create screen carried, copied here with it.
			function setGen(on) {
				genMode = !!on && canGen;
				gen.style.display   = genMode ? '' : 'none';
				typed.style.display = genMode ? 'none' : '';
				choose.textContent  = t(genMode ? 'identity.choose_own' : 'identity.use_generated');
				err.textContent = '';
				syncOk();
			}
			setGen(canGen);

			var prev = document.activeElement;
			function close(value) {
				document.removeEventListener('keydown', onKey, true);
				back.remove();
				if (prev && prev.focus) { try { prev.focus(); } catch (e) { /* gone */ } }
				resolve(value);
			}
			function submit() {
				if (genMode) {
					if (!ack.checked) {
						err.textContent = t('identity.err_confirm_written');
						return;
					}
					// Canonical spelling, so a stray space cannot produce a different
					// key from the same words.
					var pass = DaimondWords.normalise(genPass);
					if (pass.length < 8) {                     // generated phrases clear this by far.
						err.textContent = t('identity.err_too_short_gen');
						return;
					}
					if (pass === curPass) {
						err.textContent = t('changepass.err_same_gen');
						return;
					}
					return close(pass);
				}
				var v = newInp.value;
				if (v.length < 8) { err.textContent = t('changepass.err_short'); return; }
				if (v === curPass) { err.textContent = t('changepass.err_same'); return; }
				if (v !== againInp.value) { err.textContent = t('identity.err_mismatch'); return; }
				close(v);
			}
			function onKey(e) {
				if (e.key === 'Escape') { e.preventDefault(); close(null); }
				else if (e.key === 'Enter') { e.preventDefault(); submit(); }
				else if (e.key === 'Tab') keepFocusIn(card, e);
			}
			document.addEventListener('keydown', onKey, true);
			back.addEventListener('mousedown', function (e) { if (e.target === back) close(null); });
			cancel.addEventListener('click', function () { close(null); });
			ok.addEventListener('click', submit);
			regen.addEventListener('click', function () {
				genPass = DaimondWords.generate(GEN_WORDS);
				words.textContent = genPass;
				ack.checked = false;
				syncOk();
				err.textContent = '';
			});
			copy.addEventListener('click', async function () {
				try {
					await navigator.clipboard.writeText(genPass);
					copy.textContent = t('toast.copied');
					setTimeout(function () { copy.textContent = t('common.copy'); }, 1500);
				} catch (e) {
					// No clipboard permission (or an insecure context): the words are
					// on screen anyway, which is the path that matters.
					copy.textContent = t('changepass.select_above');
					setTimeout(function () { copy.textContent = t('common.copy'); }, 2000);
				}
			});
			ack.addEventListener('change', syncOk);
			// Both ways, matching the create screen: a person who clicks this to see
			// what it does can click it again to come back.
			choose.addEventListener('click', function () {
				setGen(!genMode);
				try { (genMode ? choose : newInp).focus(); } catch (e) { /* not focusable yet */ }
			});

			// Not `ok` unconditionally: it starts DISABLED until the passphrase is
			// acknowledged as written down, and focusing a disabled button leaves the
			// focus on the document body -- outside the dialog, where Tab then walks
			// straight into the app behind it. The tick is what the user has to do
			// next anyway.
			(genMode ? (ok.disabled ? ack : ok) : newInp).focus();
		});
	}

	async function doChangePassphrase() {
		var cur = await promptDialog(t('changepass.title'), {
			message: t('changepass.enter_current'),
			okLabel: t('changepass.next'),
			secret: true,
			// Check it HERE. Accepting anything and only refusing at the end made
			// the user choose and confirm a new passphrase before being told the
			// old one was wrong.
			validate: async function (v) {
				if (!v) return t('changepass.enter_current');
				var ok = await DaimondIdentity.verify(v);
				return ok ? '' : t('passkey.err_bad_passphrase');
			},
		});
		if (!cur) return;
		// The new passphrase is generated by default now, for the same reason it is
		// on the create screen: a passphrase a person types and retypes selects for
		// short and reused, and the account this is changing very likely still holds
		// exactly such a one. "Choose my own" inside the dialog keeps the old path.
		var next = await promptNewPassphrase(cur);
		if (!next) return;

		var plain = cfg.apiKey;                      // held decrypted while unlocked
		var pushPlain = cfg.pushToken;               // likewise, and sealed under the old one
		var r;
		try { r = await DaimondIdentity.changePassphrase(cur, next); }
		catch (e) { r = { ok: false }; }
		if (!r || !r.ok) { noticeDialog(t('changepass.failed'), t('changepass.failed_body')); return; }

		if (plain) {
			try { cfg.apiKeyEnc = await DaimondIdentity.wrap(plain); saveCfg(cfg); }
			catch (e) { noticeDialog(t('changepass.careful'), t('changepass.key_not_resealed')); return; }
		}
		// The push token is sealed under the passphrase that has just changed, so
		// without this it would unwrap to nothing on the next load and every push
		// would be refused with no reason on screen. The engine's copy is untouched,
		// so pushing goes on working until the tab is reloaded.
		if (pushPlain) {
			try { cfg.pushTokenEnc = await DaimondIdentity.wrap(pushPlain); saveCfg(cfg); }
			catch (e) { noticeDialog(t('changepass.careful'), t('push.not_resealed')); return; }
		}
		// The passkey seals a copy of the passphrase and of the wrapped key, both
		// of which have just changed, so it opens onto something that no longer
		// works until it is re-sealed. One biometric gesture, right here, rather
		// than a passkey that fails silently the next time it is reached for.
		var resealed = true;
		if (window.DaimondPasskey && DaimondPasskey.isEnrolled()) {
			var pk;
			try { pk = await DaimondPasskey.reseal(next); } catch (e) { pk = { ok: false }; }
			resealed = !!(pk && pk.ok);
		}
		// A password manager that saved the old passphrase now holds a stale one.
		// Hand it the new value so its entry follows the change (Chromium honours
		// this directly; elsewhere the manager notices its saved value no longer
		// works and offers to update). Safe for the same reason the create screen's
		// offer is: the new passphrase is generated unless the user chose otherwise.
		try {
			var acct = (window.DaimondIdentity && DaimondIdentity.displayName()) || 'Daimond';
			offerToSaveCredential(acct, next);
		} catch (e) { /* best-effort; the passphrase changed regardless. */ }
		noticeDialog(t('changepass.changed'), t('changepass.changed_body')
			+ (resealed ? '' : ' ' + t('changepass.passkey_stale')));
	}

	/// A brief status line, floated centre-bottom, for actions that happen away
	/// from any one panel (a backup export or restore). It fades and removes
	/// itself; a top-level helper because the account menu that triggers these
	/// is not inside a panel with its own message area.
	function toast(text, isErr) {
		var box = document.createElement('div');
		box.className = 'daimond-toast' + (isErr ? ' err' : '');
		box.textContent = text;
		// Themed, not literal. The two backgrounds were picked against the dark
		// palette, so every toast — including "Backup restored" — arrived as a
		// near-black box with pale grey text on the light and lollypop themes.
		// There is no --danger-bg token, so the failure case takes --warn-bg and
		// leans on a --danger border and heading colour to read as a failure.
		var edge = isErr ? 'var(--danger)' : 'var(--ok)';
		// pointer-events:none — a toast floats over the composer and the send row,
		// and a status line that swallows the click underneath it is a trap.
		box.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);pointer-events:none;'
			+ 'z-index:9999;padding:10px 16px;border-radius:8px;font-size:var(--fs-sm);max-width:80vw;'
			+ 'background:' + (isErr ? 'var(--warn-bg)' : 'var(--ok-bg)') + ';'
			+ 'color:var(--text-primary);border:1px solid ' + edge + ';'
			+ 'box-shadow:0 4px 16px rgba(0,0,0,.28);';
		document.body.appendChild(box);
		setTimeout(function () { box.style.transition = 'opacity .4s'; box.style.opacity = '0'; }, 3600);
		setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 4200);
	}

	/// Write bytes to a path in THIS ACCOUNT's OPFS sandbox, creating folders as
	/// needed. Used to restore a backup; a top-level sibling of the Workspace
	/// panel's own writer, which is nested out of reach here.
	///
	/// The root is `DaimondCloud.opfsRoot()` and never `navigator.storage
	/// .getDirectory()`: the origin root is the PRIMARY account's workspace, so a
	/// restore into any other account used to land in the primary's files —
	/// invisible to the account that asked for it, and reported as a success.
	///
	/// It goes to OPFS even when a real folder is open, which the wasm
	/// `write_bytes` would not: a backup exists to carry the store the browser
	/// may evict, and unpacking one into the user's own project folder is not
	/// what "restore" was asked to mean.
	async function writeOpfsBytes(path, bytes) {
		var parts = String(path).split('/').filter(function (p) {
			return p && p !== '.' && p !== '..';
		});
		if (parts.length === 0) throw new Error('Empty path.');
		var dir = await DaimondCloud.opfsRoot();
		for (var i = 0; i < parts.length - 1; i++) {
			dir = await dir.getDirectoryHandle(parts[i], { create: true });
		}
		var fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
		var w = await fh.createWritable();
		await w.write(bytes);
		await w.close();
	}


	/// Base64 of a byte array, chunked so a large file does not overflow the
	/// argument stack of `String.fromCharCode`.
	function bytesToB64(bytes) {
		var s = '', CH = 0x8000;
		for (var i = 0; i < bytes.length; i += CH) {
			s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
		}
		return btoa(s);
	}
	function b64ToBytes(b64) {
		var bin = atob(b64), out = new Uint8Array(bin.length);
		for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}

	/// Every file in THIS ACCOUNT's OPFS sandbox, as `{ path, b64 }`. This is the
	/// store the browser may evict, and so the one a backup exists to preserve —
	/// a real folder opened over FSA is already on the user's disk and needs no
	/// copy.
	///
	/// The walk starts at the account's own root, and the paths are relative to
	/// it, which is what makes a backup a backup OF AN ACCOUNT. Walking the
	/// origin root instead put every account at this browser into every backup —
	/// one person's private workspace inside another person's file — and wrote
	/// the taker's own files under the internal `d~<id>/` prefix, which is not a
	/// path any account uses. The primary account IS the origin root, so its walk
	/// steps over the `d~…` subdirectories its neighbours live in.
	async function collectOpfsFiles() {
		var out = [];
		// True when the walk starts at the origin root, i.e. this is the primary
		// account and its neighbours' namespaces are directories inside it.
		var atOrigin = !(window.DaimondAccounts && DaimondAccounts.opfsNs());
		async function walk(dir, prefix) {
			for await (var ent of dir.entries()) {
				var name = ent[0], handle = ent[1];
				if (!prefix && atOrigin && name.indexOf('d~') === 0) continue;   // another account
				var path = prefix ? prefix + '/' + name : name;
				if (handle.kind === 'directory') {
					await walk(handle, path);
				} else {
					try {
						var file = await handle.getFile();
						var buf = new Uint8Array(await file.arrayBuffer());
						out.push({ path: path, b64: bytesToB64(buf) });
					} catch (e) { /* skip a file we cannot read */ }
				}
			}
		}
		try { await walk(await DaimondCloud.opfsRoot(), ''); }
		catch (e) { /* no OPFS; export the rest */ }
		return out;
	}

	/// One spend entry's identity: the turn it records, and nothing about what it
	/// was later decided to have cost.
	///
	/// The moment, the model, the token counts and whose key paid — two ledgers
	/// naming the same millisecond, model, tokens and provider are naming one
	/// turn. Deliberately NOT the price: an entry the provider never billed is
	/// re-priced in place when the rate table is corrected (`u` changes, `u0`
	/// keeps the old guess), so a key that included the price would see the same
	/// turn twice and double the user's spend on the strength of our own
	/// arithmetic.
	function ledgerKey(e) {
		return [e.t, e.m || '', e.p || 0, e.c || 0, e.ca || 0, e.pv || ''].join('|');
	}

	/// Merge two spend ledgers by UNION, keeping `mine` where both hold a turn.
	///
	/// A ledger is an append-only record of money that actually moved, and two
	/// ledgers of one account differ only by turns the other has not seen —
	/// never by disagreeing about a turn they both hold. So union is the only
	/// merge that cannot lose spend: last-writer-wins, which is what restoring a
	/// backup used to do, throws away every turn since the backup was taken, and
	/// the older the backup the more of the user's history it erases.
	///
	/// Where both hold the same turn, the LOCAL entry wins. It is the one this
	/// device has already re-priced and the one its meters have been showing;
	/// taking the incoming copy would silently walk a corrected figure back to
	/// the guess it replaced.
	///
	/// Sorted by time, so the result is a function of its inputs and not of the
	/// order they were read in — the sync parcel is compared byte-for-byte to
	/// decide whether there is anything to push, and a merge that reordered
	/// itself would push for ever.
	///
	/// # Arguments
	/// * `mine` - This device's ledger, which wins any tie.
	/// * `theirs` - The incoming ledger, from a backup file or another device.
	function mergeLedgers(mine, theirs) {
		var out = [], seen = {};
		function take(list) {
			(Array.isArray(list) ? list : []).forEach(function (e) {
				if (!e || typeof e.t !== 'number') return;
				var k = ledgerKey(e);
				if (seen[k]) return;
				seen[k] = 1;
				out.push(e);
			});
		}
		take(mine);
		take(theirs);
		out.sort(function (a, b) {
			if (a.t !== b.t) return a.t - b.t;
			var ka = ledgerKey(a), kb = ledgerKey(b);
			return ka < kb ? -1 : ka > kb ? 1 : 0;
		});
		return out;
	}

	/// Export everything portable as one JSON file. OPFS can be evicted by the
	/// browser, so a workspace you cannot get out of the tab is a workspace you
	/// can lose — which is the whole reason to keep a backup, and so the whole
	/// reason the workspace files must be in it.
	///
	/// It carries the IDENTITY too, because without it a backup restores a
	/// stranger: the credit balance and a Pro licence are held gateway-side and
	/// unlocked by this key alone, and the Forget flow offers this export as the
	/// way to keep them. What travels is exactly what is already at rest here --
	/// the salt, the public key and the WRAPPED private key -- so the file is no
	/// easier to open than this browser's storage is, and neither can be opened
	/// without the account's passphrase.
	async function doExport() {
		var out = {
			format: 'daimond-backup',
			version: 1,
			exported: new Date().toISOString(),
			name: DaimondIdentity.displayName(),
			// Null when there is no identity to carry; the restore then leaves this
			// device's own alone.
			identity: (function () {
				try { return DaimondIdentity.exportBundle(); } catch (e) { return null; }
			})(),
			chats: storedChats(),
			ledger: readJson('daimond-ledger', []),
			diamonds: [],
			workspace: await collectOpfsFiles(),
			// Says that `workspace` holds ONE account's files, at paths relative to
			// that account's own root. A backup written before the namespace fix has
			// no such promise to make: it is the raw origin root, several accounts
			// deep, with nothing marking which files belong to whom — so its absence
			// is what puts the restore into its legacy path. See `doImport`.
			workspaceScope: 'account',
		};
		try {
			var list = await diamondApp().list_diamonds();
			var arr = JSON.parse(list || '[]');
			for (var i = 0; i < arr.length; i++) {
				var crystal = '';
				try { crystal = await diamondApp().read_crystal(arr[i].id); } catch (e) { crystal = ''; }
				// Tags travel with the Diamond. Without them a restore silently
				// drops the user's whole filing system while looking like it worked.
				out.diamonds.push({ id: arr[i].id, name: arr[i].name, crystal: crystal, tags: tagsOf(arr[i]) });
			}
		} catch (e) { /* export what we have */ }
		var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
		var a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'daimond-backup-' + new Date().toISOString().slice(0, 10) + '.json';
		a.click();
		setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
	}

	/// Restore a backup written by `doExport`. Chats and the ledger are merged
	/// into local storage, diamonds are recreated with their crystals, and every
	/// workspace file is written back into OPFS. Existing files of the same path
	/// are overwritten; nothing already present is deleted, so a restore adds to
	/// the tab rather than replacing it.
	///
	/// Everything lands in the CURRENT account: its OPFS root, its namespaced
	/// localStorage. A backup is a backup of one account, and restoring one is
	/// not a way to reach into another account at this browser.
	async function doImport() {
		var inp = document.createElement('input');
		inp.type = 'file';
		inp.accept = 'application/json,.json';
		inp.addEventListener('change', async function () {
			var file = inp.files && inp.files[0];
			if (!file) return;
			var data;
			try { data = JSON.parse(await file.text()); }
			catch (e) { toast(t('backup.unreadable'), true); return; }
			if (data.format !== 'daimond-backup') {
				toast(t('backup.not_a_backup'), true); return;
			}
			// The identity, first and out loud.
			//
			// The credit balance and a Pro licence are unlocked by this key alone,
			// so a backup that leaves it behind restores a stranger -- which is what
			// the Forget flow was telling people to rely on. It is adopted only on a
			// browser that holds NO identity: that is the recovery case, and there
			// the account is unambiguous. Where one is already here, the backup's is
			// LEFT ALONE, because a restore must not sign the person at this browser
			// out of their own account. Either way they are told which it was.
			var idBundle = data.identity;
			var haveId   = !!(window.DaimondIdentity && DaimondIdentity.exists && DaimondIdentity.exists());
			if (idBundle && window.DaimondIdentity && DaimondIdentity.importBundle) {
				var idName = idBundle.name || data.name || t('home.unnamed_account');
				if (haveId) {
					// A different account is already at this browser; say what was skipped.
					toast(t('backup.identity_kept', { name: idName }));
				} else {
					var took = false;
					// The bundle is still wrapped, so this leaves the identity LOCKED
					// and the passphrase is asked for after the reload below.
					try { took = DaimondIdentity.importBundle(idBundle); }
					catch (e) { took = false; }
					if (took) await noticeDialog(t('backup.identity_title'), t('backup.identity_body', { name: idName }));
					else toast(t('backup.identity_failed'), true);
				}
			}
			// The workspace files, into THIS account's OPFS root.
			//
			// A backup that says `workspaceScope: 'account'` holds one account's
			// files at that account's own paths, and they are written as they are.
			// One that says nothing predates the fix: it is the raw origin root of
			// some browser, with the primary's files at the top and every other
			// account's under its internal `d~<id>/` prefix, and no record of which
			// account took it. Three rules, and each is the only defensible answer
			// to its case:
			//
			//   * un-prefixed files are restored here, as they always were. That is
			//     the ordinary single-account backup, and the recovery case the
			//     Forget flow points at.
			//   * a `d~<id>/` subtree whose id is THIS account's comes home with the
			//     prefix stripped: the destination is unambiguous, and those are the
			//     taker's own files if they took the backup from this account.
			//   * any other `d~<id>/` subtree is skipped. Writing it here would put a
			//     folder named after a stranger's account into this workspace, and
			//     writing it to the origin root would be a write INTO another
			//     account's private storage at this browser. Neither is a restore.
			var files = data.workspace || [];
			var scoped = data.workspaceScope === 'account';
			var mineNs = (window.DaimondAccounts && DaimondAccounts.opfsNs()) || '';
			var restored = 0, foreign = 0;
			var wrotePaths = [];        // what actually reached this account's OPFS
			for (var i = 0; i < files.length; i++) {
				var fp = String((files[i] && files[i].path) || '');
				if (!scoped) {
					var head = fp.split('/')[0];
					if (head.indexOf('d~') === 0) {
						if (mineNs && head === mineNs) fp = fp.slice(head.length + 1);
						else { foreign++; continue; }
					}
				}
				if (!fp) continue;
				try { await writeOpfsBytes(fp, b64ToBytes(files[i].b64)); restored++; wrotePaths.push(fp); }
				catch (e) { /* skip one bad file, keep going */ }
			}
			if (foreign) {
				// Not counted as restored, because they were not: the dialog below says
				// how many files came back, and that number stays true. It also says this,
				// now -- a restore that quietly drops a subtree and reports a clean success
				// is how a person concludes the backup was empty and deletes it.
				try {
					console.warn('[backup] ' + foreign + ' file(s) in that backup belong to another '
						+ 'account at the browser it was taken from, and were left out.');
				} catch (e) {}
			}
			if (Array.isArray(data.chats) && data.chats.length) {
				// Merged into the store, not written over it: a restore adds to this tab
				// rather than replacing it, which is the promise the rest of this function
				// keeps for workspace files and Diamonds.
				var byId = {};
				storedChats().forEach(function (c) { if (c && c.id) byId[c.id] = c; });
				data.chats.forEach(function (r) {
					if (!r || !r.id) return;
					var st = byId[r.id];
					if (!st) { byId[r.id] = r; return; }
					var merged = slimChat((r.updatedAt || 0) >= (st.updatedAt || 0) ? r : st);
					merged.messages = slimMessages(mergeMessages(st.messages, r.messages));
					if (!merged.session && st.session) merged.session = st.session;
					byId[r.id] = merged;
				});
				ChatStore.save(Object.keys(byId).map(function (id) { return byId[id]; }));
			}
			if (Array.isArray(data.ledger) && data.ledger.length) {
				// MERGED, not written over. The ledger is what the user was charged, and
				// a restore that replaced it erased every turn since the backup was
				// taken -- so restoring last week's backup billed the account for last
				// week and told the user the days between had cost nothing.
				try {
					localStorage.setItem('daimond-ledger',
						JSON.stringify(mergeLedgers(readJson('daimond-ledger', []), data.ledger)));
				} catch (e) { /* keep */ }
			}
			// A Diamond is stored in full under `diamonds/<id>/` -- the crystal, every
			// version, the append-only log, and `.daimond/meta.json` (its name and
			// tags) -- so restoring the workspace files above already brings each one
			// back with its whole history. Re-creating it from the `diamonds` summary
			// as well is what made a restore duplicate every Diamond (two ids for one).
			// So the summary is now only a FALLBACK, used for a Diamond whose raw store
			// is somehow absent from the workspace files (e.g. an older partial export).
			var restoredIds = {};
			// The paths actually WRITTEN, not the ones the file offered: a Diamond
			// whose store was left out as another account's is a Diamond that is not
			// here, and counting it as restored would silence the fallback in the one
			// case the fallback exists for.
			for (var w = 0; w < wrotePaths.length; w++) {
				var m = /(?:^|\/)diamonds\/([^/]+)\//.exec(wrotePaths[w]);
				if (m) restoredIds[m[1]] = true;
			}
			for (var j = 0; j < (data.diamonds || []).length; j++) {
				var f = data.diamonds[j];
				if (f.id && restoredIds[f.id]) continue;    // already restored, history and all.
				try {
					var id = await diamondApp().create_diamond(f.name || 'Restored Diamond');
					if (f.crystal) await diamondApp().write_crystal(id, f.crystal);
					// A backup written before tags existed simply has none.
					if (f.tags && f.tags.length) await diamondApp().set_tags(id, JSON.stringify(f.tags));
				} catch (e) { /* skip one diamond */ }
			}
			bumpDiamonds();
			try { loadDiamonds(); } catch (e) { /* best effort */ }
			var nDiamonds = (data.diamonds || []).length;
			// A restore rewrites four things at once -- workspace files (into OPFS,
			// out from under the running engine), chats and the ledger (localStorage),
			// and diamonds -- and the live session still holds the pre-restore chat and
			// its file view. Reloading is the one move that brings every one of them
			// back consistent, rather than half-refreshing some and leaving the agent
			// reading a workspace the page cannot see. The user acknowledges first, so
			// the reload is expected rather than a surprise.
			var nFiles = restored;
			var restoredBody = t('backup.restored_body', {
				files:    tn('backup.n_files', nFiles),
				diamonds: tn('backup.n_diamonds', nDiamonds),
			});
			// The subtrees that had nowhere to go. One sentence, because the count on its
			// own reads as a fault and the reason is what tells the user there is nothing
			// to fix: those files are another account's, and the backup file is still the
			// only place they exist.
			if (foreign) restoredBody += ' ' + tn('backup.n_foreign', foreign);
			await noticeDialog(t('backup.restored'), restoredBody);
			location.reload();
		});
		inp.click();
	}

	function updateUserRow() {
		var info = document.getElementById('user-info');
		var av = document.getElementById('user-avatar');
		if (!info) return;
		if (window.DaimondIdentity && DaimondIdentity.exists() && DaimondIdentity.isUnlocked()) {
			info.textContent = DaimondIdentity.displayName() || t('admin.local_identity');
			info.title = t('admin.account_help');
			if (av) av.textContent = '◈';
		} else if (window.DaimondIdentity && DaimondIdentity.exists()) {
			info.textContent = t('admin.locked');
			info.title = t('admin.locked_help');
			if (av) av.textContent = '◇';
		} else if (identityAvailable()) {
			info.textContent = t('admin.no_account');
			// The old label was "Browser-only", which reads as a feature rather
			// than as "your API key is sitting here unencrypted".
			info.title = t('admin.no_account_help');
			if (av) av.textContent = '○';
		} else {
			info.textContent = t('admin.no_account');
			info.title = t('admin.no_crypto_help');
			if (av) av.textContent = '○';
		}
	}

	// The form owns submission now (see its submit handler in boot), so the button
	// and Enter both reach idPrimary without a listener here -- adding one would
	// run the unlock twice. What is left only advances the caret, in the one mode
	// where a further field still has to be filled.
	document.getElementById('id-skip').addEventListener('click', idSkip);
	// The gate covers the whole app, so Tab must not walk behind it. Without this
	// the ninth Tab left the card and went on into the rail and the composer --
	// controls the user can neither see nor reach past the scrim, with the caret
	// landing in a chat box hidden under it.
	document.addEventListener('keydown', function (e) {
		if (e.key !== 'Tab') return;
		var m = document.getElementById('identity-modal');
		if (!m || m.style.display === 'none') return;
		var card = m.querySelector('.modal-card');
		if (card) keepFocusIn(card, e);
	}, true);
	document.getElementById('id-name').addEventListener('keydown', function (e) {
		if (e.key !== 'Enter') return;
		e.preventDefault();
		document.getElementById('id-pass').focus();
	});
	document.getElementById('id-pass').addEventListener('keydown', function (e) {
		if (e.key !== 'Enter') return;
		var m = document.getElementById('identity-modal');
		if (m.dataset.mode === 'create' && !idGenMode) {
			e.preventDefault();
			document.getElementById('id-pass2').focus();
		}
	});
	document.getElementById('user-row').addEventListener('click', function () {
		if (window.DaimondIdentity && DaimondIdentity.exists()) {
			if (DaimondIdentity.isUnlocked()) DaimondAdmin.home();    // the account's controls
			else showIdentity('unlock');
		} else if (identityAvailable()) {
			showIdentity('create');       // an account can be added later
		}
	});

	// ── Settings modal ─────────────────────────────────────────
	// Show the raw base-URL row only for the Custom provider; curated
	// providers fill the URL behind the scenes.
	function applyProviderChoice(id, keepUrl) {
		var urlRow = document.getElementById('cfg-url-row');
		var urlInput = document.getElementById('cfg-base-url');
		if (id === 'custom') {
			urlRow.style.display = '';
			if (!keepUrl && providerForUrl(urlInput.value) !== 'custom') urlInput.value = '';
		} else if (id && PROVIDERS[id]) {
			urlRow.style.display = 'none';
			urlInput.value = PROVIDERS[id].url;
		} else {
			urlRow.style.display = 'none';
			if (!keepUrl) urlInput.value = '';
		}
	}

	// Model <select> helpers. The dropdown is the naive path; an "Other…"
	// option reveals a text box for manual entry or providers that don't list.
	var MODEL_OTHER = '__other__';
	function setModelOptions(opts, selected) {
		var sel = document.getElementById('cfg-model');
		sel.innerHTML = '';
		opts.forEach(function (o) {
			var el = document.createElement('option');
			el.value = o.value;
			el.textContent = o.label;
			if (o.disabled) el.disabled = true;
			sel.appendChild(el);
		});
		if (selected != null) sel.value = selected;
		syncModelCustom();
	}
	function syncModelCustom() {
		var sel = document.getElementById('cfg-model');
		document.getElementById('cfg-model-custom').style.display = (sel.value === MODEL_OTHER) ? '' : 'none';
	}
	function currentModel() {
		var sel = document.getElementById('cfg-model');
		return sel.value === MODEL_OTHER ? document.getElementById('cfg-model-custom').value.trim() : sel.value;
	}
	// Auto-load the provider's live model list into the dropdown the moment a
	// provider and key are both present — no button, it just happens.
	var _modelFetchSeq = 0;
	var _modelFetchFor = '';        // the provider+url+key the dropdown already reflects
	var _keyRejectedFor = '';       // a provider+url+key the provider has answered 401/403 to
	function fetchModels() {
		var prov = document.getElementById('cfg-provider').value;
		var base = document.getElementById('cfg-base-url').value.trim();
		var key = getSecret(document.getElementById('cfg-api-key'));
		if (!prov) { setModelOptions([{ value: '', label: 'Choose a provider first…' }]); return; }
		if (!base || !key) { setModelOptions([{ value: '', label: 'Enter your API key to load models…' }]); return; }
		// Asking the same provider about the same key twice cannot tell us
		// anything new — and it is not free. `input` (debounced), `change` and
		// `blur` all land on this, so clicking Save & start fired one more fetch
		// on the way in: it reset the dropdown to "Loading…", hid the manual-model
		// box, and the form SHRANK between the mousedown and the mouseup. The
		// button moved out from under the pointer and the click was never
		// delivered — Save & start did nothing at all, and said nothing either.
		var want = prov + '\u0000' + base + '\u0000' + key;
		if (want === _modelFetchFor) return;
		_modelFetchFor = want;
		var prevSel = currentModel();	// preserve the user's current pick across a reload
		var seq = ++_modelFetchSeq;
		var _msel = document.getElementById('cfg-model');
		var _hasReal = Array.prototype.some.call(_msel.options, function (o) { return o.value && o.value !== MODEL_OTHER; });
		if (!_hasReal) setModelOptions([{ value: '', label: 'Loading models…' }]);
		fetch(modelsUrl(base), { headers: authHeadersFor(base, key) })
			.then(function (r) { return r.ok ? r.json() : r.text().then(function () { throw new Error('HTTP ' + r.status); }); })
			.then(function (j) {
				if (seq !== _modelFetchSeq) return;	// superseded by a newer fetch
				var listed = (j && j.data) ? j.data : (Array.isArray(j) ? j : []);
				var ids = listed.map(function (m) { return typeof m === 'string' ? m : m.id; }).filter(Boolean)
					// Drop non-chat models (image, embedding, audio, rerank) so a
					// naive user cannot pick one and hit a confusing error.
					.filter(function (id) { return !/flux|stable-?diffusion|sdxl|playground|embed|nomic|bge-|whisper|tts|rerank|moderation|vision-only|image|dall-?e|imagen|midjourney|upscal|inpaint|speech|audio|transcri|guard/i.test(id); })
					.sort();
				try { localStorage.setItem('daimond-models', JSON.stringify(ids)); } catch (e) {}
				refreshChatModel();
				var opts = ids.map(function (id) { return { value: id, label: id }; });
				opts.push({ value: MODEL_OTHER, label: t('models.other') });
				var want = (prevSel && ids.indexOf(prevSel) !== -1) ? prevSel
					: (cfg.model && ids.indexOf(cfg.model) !== -1) ? cfg.model
					: (ids.length ? ids[0] : MODEL_OTHER);
				setModelOptions(opts, want);
				if (want === MODEL_OTHER && cfg.model) document.getElementById('cfg-model-custom').value = cfg.model;
				document.getElementById('byok-note').textContent = '';
				_keyRejectedFor = '';   // the key just listed models, so it works
			})
			.catch(function (err) {
				if (seq !== _modelFetchSeq) return;
				setModelOptions([{ value: MODEL_OTHER, label: t('models.other') }], MODEL_OTHER);
				if (cfg.model) document.getElementById('cfg-model-custom').value = cfg.model;
				var es = String(err && err.message ? err.message : err), note = document.getElementById('byok-note');
				if (/\b401\b|\b403\b/.test(es)) {
					// The real cause is the key, not model listing — say so, and
					// remember it, so Save cannot then report this same key connected.
					note.textContent = t('models.key_rejected');
					document.getElementById('cfg-api-key').focus();
					_keyRejectedFor = prov + ' ' + base + ' ' + key;
				} else {
					note.textContent = t('models.list_failed');
				}
			});
	}

	function fillSettings() {
		var prov = providerForUrl(cfg.baseUrl || '');
		document.getElementById('cfg-provider').value = prov;
		document.getElementById('cfg-base-url').value = cfg.baseUrl || '';
		setSecret(document.getElementById('cfg-api-key'), cfg.apiKey || '');
		applyProviderChoice(prov, true);
		// Seed the model dropdown with the saved model, then refresh from the
		// provider if we have a key.
		if (cfg.model) {
			setModelOptions([{ value: cfg.model, label: cfg.model },
				{ value: MODEL_OTHER, label: t('models.other') }], cfg.model);
		} else {
			setModelOptions([{ value: '',
				label: t(prov ? 'models.enter_key_first' : 'models.choose_provider_first') }]);
		}
		if (prov && cfg.apiKey) fetchModels();
		// The reply-length row reads the starred model's ceiling, so it is redrawn
		// whenever the settings are, not only when it is first built.
		ReplyLength.render();
		RoundLimit.render();
		FoldModel.render();
		CrystalCap.render();
	}
	/// A string from the table, or the English written here when the table has no
	/// entry for it yet.
	///
	/// The reply-length row ships before its i18n keys do — `www/js/i18n/en.js` is
	/// not this file's to write — and a settings control reading
	/// "settings.max_tokens" is worse than one reading English. Once the keys land
	/// the table wins and these fallbacks go unused; nothing needs changing here.
	function tOr(key, fallback) {
		var s = t(key);
		return s === key ? fallback : s;
	}

	/// The round-limit setting: how many tool-call rounds one turn may take.
	///
	/// A sibling of the reply-length row and deliberately beside it, because the two are the
	/// same kind of thing to a person: how far one answer is allowed to go. Reply length caps
	/// how much a model may SAY in a round; this caps how many rounds it may take before the
	/// turn stops and says so.
	///
	/// It earns a control rather than a constant because the right value is not knowable from
	/// here. The default was 25, is now 150, and a turn asked to refactor forty files can want
	/// more; a turn that has started looping wants less. Both are ordinary, and the person who
	/// can tell them apart is the one watching it.
	///
	/// Unlike reply length there is no per-model ceiling to read: a round is Daimond's own unit,
	/// not the provider's, so the ladder is the same everywhere.
	/// What the engine falls back to when nobody has chosen: `compact::DEFAULT_MAX_ROUNDS`.
	/// Named here only so the "Default" row can say the figure rather than leave it a mystery;
	/// nothing is set from it, so the two cannot disagree about what is in force.
	var DEFAULT_ROUNDS = 150;

	var RoundLimit = {
		/// The ladder offered. The user's own figure is added when it is off the ladder, so
		/// opening the panel never silently changes their setting.
		STEPS: [25, 50, 150, 300, 600],

		/// Build the row once, under the reply-length row it belongs beside.
		mount: function () {
			if (document.getElementById('cfg-max-rounds')) return true;
			var form = document.getElementById('byok-form');
			var section = form && form.parentNode;
			if (!section) return false;
			var lab = document.createElement('label');
			lab.className = 'cfg-fieldlabel';
			lab.setAttribute('for', 'cfg-max-rounds');
			lab.textContent = tOr('settings.max_rounds', 'Steps per turn');
			var sel = document.createElement('select');
			sel.className = 'settings-select';
			sel.id = 'cfg-max-rounds';
			var note = document.createElement('p');
			note.className = 'cfg-fieldnote';
			note.id = 'cfg-max-rounds-note';
			note.textContent = tOr('settings.max_rounds_note',
				'How many times an agent may use a tool before one turn stops. It says so when it '
				+ 'stops, and you can tell it to carry on.');
			section.insertBefore(lab, form);
			section.insertBefore(sel, form);
			section.insertBefore(note, form);
			sel.addEventListener('change', function () { RoundLimit.save(sel.value); });
			return true;
		},

		/// Fill the pulldown from what is stored.
		render: function () {
			if (!this.mount()) return;
			var sel = document.getElementById('cfg-max-rounds');
			sel.innerHTML = '';
			var mine = cfg.maxRounds || 0;
			var steps = this.STEPS.slice();
			if (mine > 0 && steps.indexOf(mine) === -1) steps.push(mine);
			steps.sort(function (a, b) { return a - b; });
			var mk = function (value, label) {
				var o = document.createElement('option');
				o.value = String(value); o.textContent = label;
				sel.appendChild(o);
			};
			mk(0, tOr('settings.max_rounds_auto', 'Default') + ' \u2014 ' + DEFAULT_ROUNDS);
			steps.forEach(function (n) { mk(n, String(n) + ' ' + tOr('settings.steps', 'steps')); });
			sel.value = String(mine);
			if (sel.selectedIndex === -1) sel.value = '0';
		},

		/// Record a choice and rebuild every agent, since the limit is put on an app when it is
		/// built and a chat holding an old one would go on using it.
		save: function (raw) {
			var n = Math.max(0, Math.round(Number(raw) || 0));
			cfg.maxRounds = n;
			var stored = readJson(CFG_KEY, {}) || {};
			stored.maxRounds = n;
			try { localStorage.setItem(CFG_KEY, JSON.stringify(stored)); }
			catch (e) { /* quota or unavailable — the choice holds for this session */ }
			chats.forEach(function (c) { c.app = null; });
			resetDiamondApps();
			this.render();
		},
	};

	/// Put the user's round limit on a freshly built agent, where they have set one.
	///
	/// Zero means "leave the engine's own default alone", which is what `set_max_rounds`
	/// already does with a zero — passed through rather than special-cased here so there is one
	/// rule and it lives at the end that enforces it.
	///
	/// # Arguments
	/// * `app` - The DaimondApp to bound.
	function applyRoundLimit(app) {
		if (!app || !cfg.maxRounds || typeof app.set_max_rounds !== 'function') return;
		try { app.set_max_rounds(cfg.maxRounds); } catch (e) { /* an older wasm build has no setter */ }
	}

	/// What the engine falls back to when nobody has chosen: `tools::CRYSTAL_CAP_DEFAULT`.
	/// Named here only so the "Default" row can show the figure; nothing is set from it.
	var DEFAULT_CRYSTAL_KB = 16;

	/// The crystal ceiling: how large a Diamond's summary may grow before a write that grows it
	/// further is refused.
	///
	/// It earns a control rather than a constant for the same reason the round limit does — the
	/// right figure depends on how the person works. A Diamond holding one project's state wants
	/// far less than one standing in for a whole field of them, and only the user knows which
	/// they are building.
	var CrystalCap = {
		/// The ladder offered, in kilobytes. The user's own figure is added when it is off the
		/// ladder, so opening the panel never silently changes their setting.
		STEPS: [4, 8, 16, 32, 64, 128],

		/// Build the row once, beneath the round limit it sits beside.
		mount: function () {
			if (document.getElementById('cfg-crystal-cap')) return true;
			var form = document.getElementById('byok-form');
			var section = form && form.parentNode;
			if (!section) return false;
			var lab = document.createElement('label');
			lab.className = 'cfg-fieldlabel';
			lab.setAttribute('for', 'cfg-crystal-cap');
			lab.textContent = tOr('settings.crystal_cap', 'Crystal size limit');
			var sel = document.createElement('select');
			sel.className = 'settings-select';
			sel.id = 'cfg-crystal-cap';
			var note = document.createElement('p');
			note.className = 'cfg-fieldnote';
			note.id = 'cfg-crystal-cap-note';
			note.textContent = tOr('settings.crystal_cap_note',
				'A crystal is a Diamond’s summary, so it has a ceiling. Past it, a daimon is '
				+ 'told to put the detail in a file in the Diamond’s scope instead.');
			section.insertBefore(lab, form);
			section.insertBefore(sel, form);
			section.insertBefore(note, form);
			sel.addEventListener('change', function () { CrystalCap.save(sel.value); });
			return true;
		},

		/// Fill the pulldown from what is stored.
		render: function () {
			if (!this.mount()) return;
			var sel = document.getElementById('cfg-crystal-cap');
			sel.innerHTML = '';
			var mine = cfg.crystalKb || 0;
			var steps = this.STEPS.slice();
			if (mine > 0 && steps.indexOf(mine) === -1) steps.push(mine);
			steps.sort(function (a, b) { return a - b; });
			var mk = function (value, label) {
				var o = document.createElement('option');
				o.value = String(value); o.textContent = label;
				sel.appendChild(o);
			};
			mk(0, tOr('settings.crystal_cap_auto', 'Default') + ' — ' + DEFAULT_CRYSTAL_KB + ' KB');
			steps.forEach(function (n) { mk(n, String(n) + ' KB'); });
			sel.value = String(mine);
			if (sel.selectedIndex === -1) sel.value = '0';
		},

		/// Record a choice and put it in force at once. The ceiling is engine-wide rather than
		/// per-agent, so it does not need the agents rebuilt the way the round limit does.
		save: function (raw) {
			var n = Math.max(0, Math.round(Number(raw) || 0));
			cfg.crystalKb = n;
			var stored = readJson(CFG_KEY, {}) || {};
			stored.crystalKb = n;
			try { localStorage.setItem(CFG_KEY, JSON.stringify(stored)); }
			catch (e) { /* quota or unavailable — the choice holds for this session */ }
			applyCrystalCap(anyApp());
			this.render();
		},
	};

	/// Put the user's crystal ceiling on the engine.
	///
	/// The ceiling lives in the wasm instance, not on an agent, so ANY app sets it for all of
	/// them — it is applied wherever an agent is built only so that a page which has not opened
	/// the settings panel still has it in force. Zero means the engine's own default, which
	/// `set_crystal_cap` already understands, so it is passed through rather than special-cased.
	///
	/// # Arguments
	/// * `app` - Any DaimondApp; the setting is not that app's.
	function applyCrystalCap(app) {
		if (!app || typeof app.set_crystal_cap !== 'function') return;
		try { app.set_crystal_cap((cfg.crystalKb || 0) * 1024); }
		catch (e) { /* an older wasm build has no setter */ }
	}

	/// Which model folds a conversation, and what it is told.
	///
	/// A fold is a real, paid call that runs every time a conversation outgrows its
	/// window, and its output BECOMES the session's memory — so the model doing it is
	/// worth choosing, and the choice was not on offer anywhere.
	///
	/// **It applies only to conversations on its own provider.** `Agent::summarise`
	/// swaps the model id into a clone of the conversation's own client, so the fold
	/// travels on the key already in use; a model id from another provider would be
	/// refused by the wire, or — worse on an endpoint that shrugs — answered by
	/// something else entirely. So the pair is stored and `applyFoldSettings` sets it
	/// only where the provider matches. The note under the picker says this, because a
	/// setting that silently does nothing on half the user's chats is worse than one
	/// that is not offered at all.
	var FoldModel = {
		mount: function () {
			if (document.getElementById('cfg-fold-model')) return true;
			var anchor = document.getElementById('cfg-max-rounds');
			var section = anchor && anchor.parentNode;
			if (!section) return false;
			var lab = document.createElement('label');
			lab.className = 'cfg-fieldlabel';
			lab.setAttribute('for', 'cfg-fold-model');
			lab.textContent = tOr('settings.fold_model', 'Fold with');
			var sel = document.createElement('select');
			sel.className = 'settings-select';
			sel.id = 'cfg-fold-model';
			var note = document.createElement('p');
			note.className = 'cfg-fieldnote';
			note.textContent = tOr('settings.fold_model_note',
				'When a conversation outgrows its window it is summarised, and the summary '
				+ 'becomes what the model remembers. This chooses what writes it. Only chats on '
				+ 'the same provider use it — every other chat folds with its own model.');
			// Under the round limit, which is the other bound on how a turn behaves.
			var after = document.getElementById('cfg-max-rounds-note') || anchor;
			section.insertBefore(lab, after.nextSibling);
			section.insertBefore(sel, lab.nextSibling);
			section.insertBefore(note, sel.nextSibling);
			sel.addEventListener('change', function () { FoldModel.save(sel); });
			return true;
		},

		render: function () {
			if (!this.mount()) return;
			var sel = document.getElementById('cfg-fold-model');
			sel.innerHTML = '';
			var own = document.createElement('option');
			own.value = ''; own.dataset.provider = '';
			own.textContent = tOr('settings.fold_model_own', 'The conversation’s own model');
			sel.appendChild(own);
			if (window.DaimondModels) {
				// Every configured model, grouped by provider, exactly as the tile pickers
				// are — and then the stored choice re-selected, which `fillSelect` does by
				// provider and model together.
				var group = document.createElement('optgroup');
				group.label = tOr('settings.fold_model_group', 'Fold with instead');
				sel.appendChild(group);
				var scratch = document.createElement('select');
				DaimondModels.fillSelect(scratch, cfg.foldProvider || '', cfg.foldModel || '');
				while (scratch.firstChild) sel.appendChild(scratch.firstChild);
			}
			var want = (cfg.foldProvider || '') + ' ' + (cfg.foldModel || '');
			var hit = false;
			for (var i = 0; i < sel.options.length; i++) {
				var o = sel.options[i];
				if (((o.dataset.provider || '') + ' ' + o.value) === want) {
					sel.selectedIndex = i; hit = true; break;
				}
			}
			if (!hit) sel.selectedIndex = 0;
		},

		save: function (sel) {
			var o = sel.options[sel.selectedIndex];
			cfg.foldModel    = (o && o.value) || '';
			cfg.foldProvider = (o && o.dataset.provider) || '';
			var stored = readJson(CFG_KEY, {}) || {};
			stored.foldModel = cfg.foldModel; stored.foldProvider = cfg.foldProvider;
			try { localStorage.setItem(CFG_KEY, JSON.stringify(stored)); }
			catch (e) { /* quota — the choice holds for this session */ }
			// Live, not on next construction: the setting is one call on an existing app,
			// so dropping every chat's agent to deliver it would throw away restored
			// sessions for nothing.
			chats.forEach(function (c) { applyFoldSettings(c.app, c.provider); });
			Object.keys(_diamondApps).forEach(function (k) {
				applyFoldSettings(_diamondApps[k], _diamondAppProvider.get(_diamondApps[k]) || '');
			});
			this.render();
		},
	};

	/// Both halves of how this app folds: which model writes the summary, and what
	/// that model is told.
	///
	/// One function because they are one setting seen twice. `set_fold_model` had been
	/// exposed on the wasm since folding was written and called by nothing, and
	/// `prompts/compactor.md` was a file the app never opened -- so a conversation was
	/// folded by the chat's own model under a prompt nobody could read. Applied wherever
	/// `applyRoundLimit` is, so an app built at any of the four construction sites gets
	/// both.
	///
	/// The MODEL id alone goes across: `Agent::summarise` swaps it into a clone of this
	/// app's own client, so the fold travels on the key the conversation is already
	/// using. A fold model from a different provider is therefore refused by the wire
	/// rather than silently billed to the wrong balance -- which is why the picker below
	/// offers only models of the provider the app is on.
	function applyFoldSettings(app, provider) {
		if (!app) return;
		// Same provider or nothing. See `FoldModel`: the fold rides on the conversation's
		// own key, so a model id belonging to somebody else's endpoint is not a fold with
		// a different model — it is a request that fails, or one answered by whatever that
		// endpoint does with an unknown name.
		var same = (cfg.foldProvider || '') === (provider || '');
		try {
			if (typeof app.set_fold_model === 'function') {
				app.set_fold_model(same ? (cfg.foldModel || '') : '');
			}
		} catch (e) { /* an older wasm build has no setter */ }
		try {
			if (typeof app.set_role_prompt === 'function') {
				app.set_role_prompt('compactor', (Prompts && Prompts.md.compactor) || '');
			}
		} catch (e) { /* an older wasm build does not know the role */ }
	}

	/// Any built agent, for a setting that is the engine's rather than an agent's.
	function anyApp() {
		for (var i = 0; i < chats.length; i++) { if (chats[i] && chats[i].app) return chats[i].app; }
		return null;
	}

	/// The reply-length setting: how many tokens a single answer may run to.
	///
	/// Lives with the models, because it is a property OF the model — the ceiling
	/// differs per model and the row says which one it is reading. Built here
	/// rather than in the page, so it can name the resolved figure for whichever
	/// model is starred and offer only the lengths that model will accept.
	var ReplyLength = {
		/// The ladder offered, filtered by the starred model's ceiling. A value
		/// the user already holds is added even when it is off the ladder, so
		/// opening the panel never silently changes their setting.
		STEPS: [4096, 8192, 16384, 32768, 65536, 131072],

		/// Build the row once, into the Models panel's existing section.
		mount: function () {
			if (document.getElementById('cfg-max-tokens')) return true;
			var form = document.getElementById('byok-form');
			var section = form && form.parentNode;
			if (!section) return false;
			var lab = document.createElement('label');
			lab.className = 'cfg-fieldlabel';
			lab.setAttribute('for', 'cfg-max-tokens');
			lab.textContent = tOr('settings.max_tokens', 'Longest reply');
			var sel = document.createElement('select');
			sel.className = 'settings-select';
			sel.id = 'cfg-max-tokens';
			var note = document.createElement('p');
			note.className = 'cfg-fieldnote';
			note.id = 'cfg-max-tokens-note';
			section.insertBefore(lab, form);
			section.insertBefore(sel, form);
			section.insertBefore(note, form);
			sel.addEventListener('change', function () { ReplyLength.save(sel.value); });
			return true;
		},

		/// Fill the pulldown for whichever model is starred.
		render: function () {
			if (!this.mount()) return;
			var sel = document.getElementById('cfg-max-tokens');
			var note = document.getElementById('cfg-max-tokens-note');
			var d = window.DaimondModels ? DaimondModels.getDefault() : { provider: '', model: '' };
			var model = d.model || cfg.model || '';
			var ceil = maxOutCeiling(model, d.provider || '');
			var auto = autoMaxOut(model, d.provider || '');
			sel.innerHTML = '';
			var mk = function (value, label) {
				var o = document.createElement('option');
				o.value = String(value); o.textContent = label;
				sel.appendChild(o);
			};
			mk(0, tOr('settings.max_tokens_auto', 'Automatic') + ' — ' + fmtTok(auto));
			var steps = this.STEPS.filter(function (n) { return !ceil || n <= ceil; });
			// The user's own figure, when it is not one of the offered steps: an
			// unlisted value would otherwise be silently rewritten by the first
			// `change` the pulldown fires.
			var mine = cfg.maxOut || 0;
			if (mine > 0 && steps.indexOf(mine) === -1) steps.push(mine);
			steps.sort(function (a, b) { return a - b; });
			steps.forEach(function (n) { mk(n, fmtTok(n) + ' ' + tOr('settings.tokens', 'tokens')); });
			sel.value = String(mine);
			if (sel.selectedIndex === -1) sel.value = '0';
			// The ceiling clause only when there IS one: naming the model and then
			// saying nothing about it reads as a sentence that lost its end.
			note.textContent = tOr('settings.max_tokens_note',
				'How long a single reply may be. Too low and a large file arrives cut in half.')
				+ (ceil ? ' ' + model + ' ' + tOr('settings.max_tokens_ceiling', 'accepts up to')
					+ ' ' + fmtTok(ceil) + '.' : '');
		},

		/// Record a choice and rebuild every agent, since `max_tokens` is frozen
		/// when a `DaimondApp` is constructed and nothing can change it after.
		///
		/// Only this field is written back. The in-memory `cfg` is a VIEW of
		/// whichever model is starred and carries the resolved key IN THE CLEAR,
		/// so persisting it wholesale would put a plaintext key into storage that
		/// `DaimondModels` had sealed.
		save: function (raw) {
			var n = Math.max(0, Math.round(Number(raw) || 0));
			cfg.maxOut = n;
			var stored = readJson(CFG_KEY, {}) || {};
			stored.maxOut = n;
			try { localStorage.setItem(CFG_KEY, JSON.stringify(stored)); }
			catch (e) { /* quota or unavailable — the choice holds for this session */ }
			chats.forEach(function (c) { c.app = null; });
			resetDiamondApps();
			this.render();
		},
	};

	/// Take the user to the settings, wherever the settings currently are: the
	/// lower pane of the rail, or — where there is no rail — a modal card.
	function openSettings(note) {
		// On a phone the rail is a fixed drawer, so `available()` is false and the
		// form opens in the modal; opening the drawer too would just flap behind it.
		if (!isMobile()) DaimondPanels.show('rail');   // a no-op if it is already open
		fillSettings();
		DaimondAdmin.settings(note);
		// The add-a-provider form is folded away unless there is nothing to show yet, or the
		// user was sent here BECAUSE there is no model: in either case the thing to do is add one.
		var form = document.getElementById('byok-form');
		var none = !window.DaimondModels || !DaimondModels.providers().length;
		if (form) form.style.display = (none || note) ? '' : 'none';
		if (form && form.style.display !== 'none') {
			var provEl = document.getElementById('cfg-provider');
			(provEl.value ? document.getElementById('cfg-api-key') : provEl).focus();
		}
	}

	/// The credits, which are not the models, and no longer share a form with them.
	function openCredits(note) {
		if (!isMobile()) DaimondPanels.show('rail');
		DaimondAdmin.credits(note);
	}
	// The cog goes into the settings, and back out of them.
	settingsBtn.addEventListener('click', function () { DaimondAdmin.toggle(); });

	// The guide: a real site at /guide, shown in the Web panel. Reachable from the header ? at all
	// times, so a newcomer is never more than one click from the tour — which is why the chat
	// panel no longer needs to carry its own welcome copy.
	var guideBtn = document.getElementById('guide-btn');
	if (guideBtn) guideBtn.addEventListener('click', function () {
		if (window.DaimondWeb && DaimondWeb.guide) DaimondWeb.guide();
		else window.open('guide/', '_blank');       // no web module: the guide still stands alone
	});
	document.getElementById('byok-save').addEventListener('click', async function () {
		var next = {
			baseUrl: document.getElementById('cfg-base-url').value.trim(),
			apiKey: getSecret(document.getElementById('cfg-api-key')).trim(),
			apiKeyEnc: '',
			model: currentModel(),
			maxOut: cfg.maxOut || 0,	// 0 = Auto; the knob is in the Models panel
			tools: true,	// tools are on by default; no user-facing toggle
		};
		// Validate before saving — never report success on an unusable config.
		var note = document.getElementById('byok-note');
		if (!document.getElementById('cfg-provider').value) { note.textContent = t('byok.err_provider'); return; }
		if (!next.baseUrl) { note.textContent = t('byok.err_base_url'); return; }
		// PRESENT is not the same as USABLE. The shape was never checked, so a typed
		// address like "htp://api.x/v1" got as far as trying to list models from it,
		// failed, and the refusal that reached the user read "Choose a model, or wait
		// a moment for the list to load" — naming the one box they had got right.
		if (!/^https?:\/\/[^\s/?#]+\.?(:\d+)?(\/|$)/i.test(next.baseUrl)) {
			note.textContent = t('byok.err_bad_url');
			document.getElementById('cfg-base-url').focus();
			return;
		}
		if (!next.apiKey) { note.textContent = t('byok.err_key'); document.getElementById('cfg-api-key').focus(); return; }
		// Fall back to the provider's default model if the live list has not
		// loaded (it shows "Loading…" with an empty value) so a quick save is
		// never stuck for a curated provider.
		if (!next.model) {
			var _pv = document.getElementById('cfg-provider').value;
			if (PROVIDERS[_pv] && PROVIDERS[_pv].model) next.model = PROVIDERS[_pv].model;
		}
		if (!next.model) { note.textContent = t('byok.err_model'); return; }
		// The provider has already answered 401/403 to this very key while loading
		// its models. Reporting it "Saved." and lighting the connected padlock
		// would be a lie the first real turn exposes, so refuse it here.
		var wantNow = document.getElementById('cfg-provider').value + ' ' + next.baseUrl + ' ' + next.apiKey;
		if (_keyRejectedFor && wantNow === _keyRejectedFor) {
			note.textContent = t('byok.err_rejected');
			document.getElementById('cfg-api-key').focus();
			return;
		}
		// The provider joins the others rather than replacing them: a second key does not evict
		// the first, which is the whole point of holding more than one.
		var pid = document.getElementById('cfg-provider').value;
		if (pid === 'custom') pid = 'custom:' + next.baseUrl;
		DaimondModels.addProvider(pid, { url: next.baseUrl });
		await DaimondModels.setKey(pid, next.apiKey);
		DaimondModels.setDefault(pid, next.model);
		// Ask it what else it can run, so the list is populated for the picker. A provider that
		// will not answer still works — the model just chosen is already known to be good.
		try { await DaimondModels.fetchModels(pid); } catch (e) { /* the chosen model still stands */ }

		syncCfgFromModels();
		note.textContent = t('files.saved');
		// New settings imply fresh app instances for existing chats and
		// for every Diamond app built on the old key.
		chats.forEach(function (c) { c.app = null; });
		resetDiamondApps();
		// A form that has done its job leaves. The confirmation is not a word in
		// a box that stays open — it is the status header now naming the model
		// Daimond is running on.
		DaimondModels.render();
		// The starred model may have changed, and with it the ceiling the
		// reply-length row reads and the figure Automatic resolves to.
		ReplyLength.render();
		RoundLimit.render();
		FoldModel.render();
		CrystalCap.render();
		var f = document.getElementById('byok-form');
		if (f) f.style.display = 'none';
		DaimondAdmin.status();
	});
		// Picking a provider fills the base URL (Custom exposes the raw field)
		// and refreshes the model list.
		document.getElementById('cfg-provider').addEventListener('change', function () {
			applyProviderChoice(this.value, false);
			// Seed the provider's default model immediately so the form is
			// savable without waiting on the async list fetch; fetchModels then
			// enriches it. This keeps onboarding from stalling on a slow list.
			var def = PROVIDERS[this.value] && PROVIDERS[this.value].model;
			if (def) setModelOptions([{ value: def, label: def }, { value: MODEL_OTHER, label: t('models.other') }], def);
			fetchModels();
		});
		// Auto-load the model list once a key (or a custom URL) is entered —
		// eagerly on input (debounced) so a user who pastes a key and clicks
		// Save straight away still gets a usable model, plus on change/blur.
		var _keyModelTimer = null;
		document.getElementById('cfg-api-key').addEventListener('input', function () {
			clearTimeout(_keyModelTimer);
			_keyModelTimer = setTimeout(fetchModels, 500);
		});
		document.getElementById('cfg-api-key').addEventListener('change', function () { fetchModels(); });
		document.getElementById('cfg-base-url').addEventListener('change', function () { fetchModels(); });
		// Reveal the manual model box only when "Other…" is chosen.
		document.getElementById('cfg-model').addEventListener('change', syncModelCustom);
		// Per-chat model override: switch the model for the current chat only.
		document.getElementById('chat-model-select').addEventListener('change', function () {
			if (!current) return;
			current.model = this.value;
			current.app = null;	// rebuilt with the new model on the next turn
			updateMeters();
		});

	// ── Input wiring ───────────────────────────────────────────
	// Grow with the content up to ~12 lines (the CSS max-height); past that it
	// scrolls, with a hover-only scrollbar.
	chatInput.addEventListener('input', function () {
		chatInput.style.height = 'auto';
		chatInput.style.height = Math.min(chatInput.scrollHeight, 263) + 'px';
		// Mid-turn the button's meaning follows the box: empty it means Stop, with
		// a correction in it it means send that correction into the turn.
		syncSendMode();
	});
	chatInput.addEventListener('keydown', function (e) {
		if (e.key === 'Escape' && _skillMenu) { e.preventDefault(); closeSkillMenu(); return; }
		if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeSkillMenu(); sendUserMessage(); }
	});
	// A `/` alone in an empty box asks what there is. Anything after it is a
	// command being typed, or a path, and the menu gets out of the way.
	chatInput.addEventListener('input', function () {
		if (chatInput.value === '/') openSkillMenu();
		else closeSkillMenu();
	});
	chatSend.addEventListener('click', function () {
		// In stop-mode the same button cancels the current chat's running turn -- but
		// only with an empty box. With something typed in it the button is a Send
		// arrow and sends, because a user who has just written a correction and
		// pressed the button meant to send the correction, not to kill the turn.
		if (sendMode() === 'stop') { stopGeneration(); return; }
		sendUserMessage();
	});
	newSessionBtn.addEventListener('click', newChat);
	if (newDiamondBtn) newDiamondBtn.addEventListener('click', createDiamond);
	// The two faces of a Diamond. Each remembers itself per Diamond, so going back to
	// one you were reading the conversation of puts you back in the conversation.
	var pendSort = document.getElementById('pending-sort');
	if (pendSort) {
		try { pendSort.value = localStorage.getItem(PENDING_KEY + '-sort') || 'priority'; }
		catch (e) { /* default */ }
		pendSort.addEventListener('change', function () {
			try { localStorage.setItem(PENDING_KEY + '-sort', pendSort.value); }
			catch (e) { /* it holds for this session */ }
			Pending.render();
		});
	}
	['crystal', 'chat'].forEach(function (which) {
		var b = document.getElementById('dview-' + which);
		if (!b) return;
		b.addEventListener('click', function () {
			if (!currentDiamond) return;
			selectDiamond(currentDiamond, which);
		});
	});
	var linkGraphBtn = document.getElementById('link-graph-btn');
	if (linkGraphBtn) linkGraphBtn.addEventListener('click', function () {
		DaimondPanels.show('graph');
		// Showing an already-open panel changes no attribute, so ask for the
		// redraw explicitly rather than relying on the visibility observer.
		if (window.DaimondGraph) DaimondGraph.refresh();
	});
	if (agentSearch) agentSearch.addEventListener('input', function () {
		agentQuery = agentSearch.value.trim().toLowerCase();
		Workers.render();
	});
	var agentsClearBtn = document.getElementById('agents-clear');
	if (agentsClearBtn) agentsClearBtn.addEventListener('click', function () { Workers.clearFinished(); });
	var agentsPauseBtn = document.getElementById('agents-pause');
	if (agentsPauseBtn) agentsPauseBtn.addEventListener('click', function () { Workers.pauseAll(); });
	var agentsPlayBtn = document.getElementById('agents-play');
	if (agentsPlayBtn) agentsPlayBtn.addEventListener('click', function () { Workers.resumeAll(); });
	var agentsStopBtn = document.getElementById('agents-stop');
	if (agentsStopBtn) agentsStopBtn.addEventListener('click', function () { Workers.stopAll(); });

	// Show/hide tool blocks in the thread.
	var toolsHidden = localStorage.getItem('daimond-hide-tools') === '1';
	var stepsBtn = document.getElementById('steps-toggle-btn');
	function applyToolsVisibility() {
		chatOutput.classList.toggle('hide-tools', toolsHidden);
		if (stepsBtn) stepsBtn.classList.toggle('dim', toolsHidden);
	}
	if (stepsBtn) stepsBtn.addEventListener('click', function () {
		toolsHidden = !toolsHidden;
		localStorage.setItem('daimond-hide-tools', toolsHidden ? '1' : '0');
		applyToolsVisibility();
	});
	applyToolsVisibility();

	var conciseChip = document.getElementById('concise-chip');
	if (conciseChip) conciseChip.addEventListener('click', function () { toggleConcise(); });
	syncConciseChip();

	// ── Collapse, select, fold, jump ───────────────────────────
	collapseBtn = document.getElementById('collapse-btn');
	selectTools = document.getElementById('select-tools');
	if (collapseBtn) collapseBtn.addEventListener('click', function () { setSelectMode(!_selectMode); });

	var selAllBtn  = document.getElementById('sel-all');
	var selNoneBtn = document.getElementById('sel-none');
	var selFoldBtn = document.getElementById('sel-fold');
	if (selAllBtn)  selAllBtn.addEventListener('click', function () { pickAll(true); });
	if (selNoneBtn) selNoneBtn.addEventListener('click', function () { pickAll(false); });
	if (selFoldBtn) selFoldBtn.addEventListener('click', function () {
		if (!current) return;
		var turns = pickedTurns();
		if (!turns.length) {
			noticeDialog(t('fold.nothing_chosen'), t('fold.nothing_chosen_body'));
			return;
		}
		// The picker is anchored on the button that opened it, and the turns ride along.
		openFoldPicker(current, selFoldBtn, turns);
	});

	var jumpBtn = document.getElementById('chat-jump');
	if (jumpBtn) jumpBtn.addEventListener('click', jumpBack);
	var endBtn = document.getElementById('chat-end');
	if (endBtn) endBtn.addEventListener('click', jumpEnd);

	// ── Boot ───────────────────────────────────────────────────
	async function boot() {
		initTheme();
		initSkin();
		// Only the provider API key is masked as text-with-bullets now. It is
		// somebody else's bearer credential against somebody else's billing, so
		// there is no reason for it to reach a personal keychain. The passphrase
		// fields are REAL password inputs (see index.html): the passphrase is
		// generated, so there is nothing weak or reused to save, and a manager
		// holding it is what stops it being retyped on a phone all day.
		installSecretMask(document.getElementById('cfg-api-key'), '');
		// The push token is masked the same way and for the same reason: it is a
		// credential against the user's own repositories, and a real password field
		// is what invites a manager to file it away.
		installSecretMask(document.getElementById('cfg-push-token'), '');
		// The eye toggles reveal a passphrase field, so a long one typed on a
		// phone can be checked. Each remembers its own state; the icon swaps
		// between an open and a struck-through eye.
		['id-pass', 'id-pass2'].forEach(function (fid) {
			var eye = document.getElementById(fid + '-eye');
			var inp = document.getElementById(fid);
			if (!eye || !inp) return;
			syncEyeIcon(fid);
			eye.addEventListener('click', function () {
				setSecretRevealed(inp, !inp._revealed);
				syncEyeIcon(fid);
				try { inp.focus(); } catch (e) { /* ignore */ }
			});
		});
		// The create screen's own controls: regenerate, copy, the written-it-down
		// acknowledgement, and the way out to a typed passphrase.
		var regenBtn = document.getElementById('id-regen');
		if (regenBtn) regenBtn.addEventListener('click', function () { regenerate(); });
		var copyBtn = document.getElementById('id-gencopy');
		if (copyBtn) copyBtn.addEventListener('click', async function () {
			var v = getSecret(document.getElementById('id-pass'));
			try {
				await navigator.clipboard.writeText(v);
				copyBtn.textContent = t('toast.copied');
				setTimeout(function () { copyBtn.textContent = t('common.copy'); }, 1500);
			} catch (e) {
				// No clipboard permission (or an insecure context): the words are
				// on screen anyway, which is the path that matters.
				copyBtn.textContent = t('changepass.select_above');
				setTimeout(function () { copyBtn.textContent = t('common.copy'); }, 2000);
			}
		});
		var wroteBox = document.getElementById('id-wrote');
		if (wroteBox) wroteBox.addEventListener('change', syncPrimaryEnabled);
		var chooseBtn = document.getElementById('id-choose');
		if (chooseBtn) chooseBtn.addEventListener('click', function () {
			if (idGenMode) {
				// Generated → typed. Clear the generated words rather than leave
				// them sitting in a box the user is now meant to type their own into.
				setGenMode(false);
				var inp = document.getElementById('id-pass');
				if (inp) { setSecret(inp, ''); try { inp.focus(); } catch (e) {} }
				setSecret(document.getElementById('id-pass2'), '');
			} else {
				// Typed → generated. A FRESH passphrase, never whatever was typed:
				// the readout must show words this device picked, and the tick below
				// it says they were written down. Showing a half-typed secret there
				// would invite writing down something the user was still editing.
				setSecret(document.getElementById('id-pass2'), '');
				if (regenerate()) setGenMode(true);
			}
		});
		// A browser may fill its own suggested password into the field. The
		// readout follows the field so the words shown are always the words used.
		var passInp = document.getElementById('id-pass');
		if (passInp) passInp.addEventListener('input', function () {
			if (idGenMode) syncGenReadout();
		});
		// The form is a real form so the browser sees a real submission, which is
		// what makes it offer to save the credential. Enter and the button both
		// arrive here.
		var idForm = document.getElementById('id-form');
		if (idForm) idForm.addEventListener('submit', function (ev) {
			ev.preventDefault();
			idPrimary();
		});
		DaimondPanels.init();
		DaimondAdmin.init();
		initPauseUi();
		if (window.DaimondMail) {
			DaimondMail.init({
				writeBytes:   Files.writeBytes,
				// Mail reads message BYTES, so it must not go through
				// `run_tool('file_read')` — that is the model-facing rendering, which
				// numbers every line and wraps an untrusted path in an envelope.
				// `parseHeaders` saw `1\tFrom: …` and matched nothing, so every message
				// in the panel read "(unknown) / (no subject)". Same fault as the Doc
				// panel's, in a second place. See `readRaw` at :11835.
				readText:     function (path) { return Wasm.read_file(path); },
				openFile:     Files.open,
				refreshFiles: Files.refresh,
				runTool:      function (name, args) {
					return tools().run_tool(name, JSON.stringify(args || {}));
				},
				showMessage:  showMessage,
				showCompose:  showCompose,
				mailDialog:   mailDialog,
				// The mailbox settings dialog, which is phase C's tile dialog wearing a
				// different body. Asked for by name in `mail.js` since phase G part one,
				// which shipped a stand-in of the same furniture rather than a gear that
				// opened nothing.
				bodyDialog:   openBodyDialog,
				// The caller names its own button. Removing a mailbox is destructive and
				// wants a red Remove; fetching a mailbox down is not, and a red button
				// on it would say the wrong thing about what is about to happen.
				confirm:      function (msg, detail, opts) {
					opts = opts || {};
					return confirmDialog(detail || '', opts.ok || 'OK',
						{ title: msg, danger: !!opts.danger });
				},
			});
		}
		if (window.DaimondModels) {
			// The store is loaded (and the old single-provider config carried into it) before
			// anything asks what model to run on.
			DaimondModels.init({
				onChange: function () {
					syncCfgFromModels();
					nudgeSync();	// a provider or key change outside a turn pushes on its own
					DaimondAdmin.status();
					// The panel is a view of the store, so it follows the store. Without this it only
					// redrew when the thing that changed the store happened to remember to ask -- so
					// unlocking with the Models panel open left every provider still reading "sealed".
					DaimondModels.render();
				},
				// The one thing a credits row can offer that a key row cannot: the way to fix it.
				// The models panel does not own the credits form, so it asks for it rather than
				// growing a second copy.
				onTopUp: function () { openCredits('Top up to keep using these models.'); },
			});
			syncCfgFromModels();
		}
		if (window.DaimondTools) {
			DaimondTools.init({
				// The registry the agent is actually handed, not a list of it kept in JavaScript.
				builtins: function () { return JSON.parse(builtin_tools()); },
				// The count is what the rail row says, so the panel tells the rail when it changes
				// rather than the rail asking on a timer.
				onCount:  function () { DaimondAdmin.status(); },
			});
		}
		// The Typst driver installs `window.DaimondTypst`, which is the ONE object the Rust
		// `typst_compile` tool looks for. It is a module, so nothing installs it until something
		// imports it -- and the tool cannot import anything. Without this the tool was in the
		// belt and could never work: a model asked for a PDF correctly reported that it could
		// not make one. The heavy compiler wasm is still built lazily, on the first compile;
		// this only evaluates the ~4 KB module that registers the driver.
		import('./typst.js').catch(function () { /* no Typst on this build; the tool says so */ });
		if (window.DaimondWeb) DaimondWeb.init({
			// A consequential web action — a purchase, a send — is put to the USER,
			// never confirmed by the model. Resolves true only on a real yes.
			confirm: function (reason) {
				return confirmDialog(reason, t('confirm.yes_do_it'), {
					title: t('confirm.irreversible'),
					danger: true,
				});
			},
			// Read a file from the active workspace (OPFS or a real folder), so the
			// Web panel can open a page the agent has just written there. Returns
			// the text, or throws if there is no such file.
			readFile: function (path) {
				return readBytes(path);
			},
		});
		// The machine hand is the browser build's route to a process, and the `run`
		// tool reaches it through `window.DaimondHand` exactly as the web tools reach
		// `window.DaimondWeb`. Nothing used to wire it: the relay was in the page and
		// never spoken to, so the handshake that reports the granted folder was never
		// sent, and without that folder there is no fence to express and every command
		// was refused. This is the wiring — and only the wiring. The link itself opens
		// LAZILY, on the first thing that needs a hand, because opening it is what puts
		// the approval window on the user's screen and a question that arrives merely
		// because the app started is one a person learns to dismiss.
		if (window.DaimondHand) DaimondHand.init({
			onStart: function (id, pid) { runLive('[running, process ' + pid + ']\n'); },
			onChunk: function (id, stream, data) { runLive(data); },
			onEnd:   function (id, exit) { runLive('\n[exit code: ' + exit + ']\n'); },
			// What the relay has to say about the hand itself — that it stopped,
			// that it was never installed — rather than about the command. It is
			// written for the model, and a person watching the panel is owed it too.
			note:    function (msg) { runLive('\n' + msg + '\n'); },
			// The folder the user opened, so the relay can settle whether it is the
			// folder the hand was granted (`hand/REVIEW.md` §1.14). A handle and never
			// a path: the File System Access API gives the page no path at all, which
			// is the whole reason the two ends compare a token in a file instead.
			// Null on the browser sandbox, and that is an ANSWER — there is no folder
			// for a command to run against — not a missing one.
			folder:  function () { return Files.folder(); },
		});
		Files.init();
		Workers.render();
		mshow(document.body.dataset.mpanel || 'ai');
		try {
			await init();               // instantiate the wasm module
			// FIRST, before anything can panic. A wasm panic with no hook is the
			// most opaque failure this app can produce: a bare "Script error." with
			// no file or line, a Promise that never settles, and a poisoned module.
			// An iPhone looped on exactly that for four sessions.
			try { install_panic_hook(); } catch (e) { /* an older bundle has none */ }
			window.__DAIMOND_READY = true;
			// Point OPFS at the current account's subdirectory BEFORE any file tool runs, so this
			// account's workspace and Daimond's own state are isolated from every other account at
			// this browser. Empty for the primary account (the root, unchanged).
			try { set_account_ns(window.DaimondAccounts ? DaimondAccounts.opfsNs() : ''); }
			catch (e) { /* single-account build */ }
			// The permission ladder. Pushed into the wasm BEFORE any agent runs: the
			// engine's copy is the one that decides anything, and a page drawing
			// "Bypass" over an engine still running guarded would be worse than either
			// being wrong on its own. `apply` is here rather than in handmode.js
			// because the wasm is a module and that file is a classic script.
			if (window.DaimondHandMode) DaimondHandMode.init({
				apply:   applyPermissionMode,
				confirm: confirmDialog,
				notice:  function (m) { toast(m, true); },
			});
			// Warm the write-ahead journal (it self-inits, but opening it now surfaces any storage
			// problem before the first turn rather than during it).
			if (window.DaimondJournal) { try { DaimondJournal.init(); } catch (e) { /* no IDB */ } }
			// The built-in tools live in the wasm registry, so nothing can count them until
			// the module exists. Ask again now that it does, or the rail would report the
			// tools bought and none of the tools built in.
			if (window.DaimondTools) DaimondTools.reload();
			// Reconnect a previously opened real folder (silent if still
			// granted, else a one-click reconnect offer).  Best-effort.
			try { await Files.tryReconnect(); } catch (e) { /* stay on OPFS */ }
		} catch (e) {
			appEl.classList.add('wasm-failed');
			appendError('Failed to load the browser engine: ' + String(e));
			window.__DAIMOND_READY = false;
			return;
		}
		chats = await loadChats();  // restore persisted chats (survive reload)
		chats.forEach(function (c) { var n = parseInt((c.id || '').replace(/^c/, ''), 10); if (n >= seq) seq = n + 1; });
		updateUserRow();

		// Identity gate. A returning user unlocks FIRST: nothing of theirs is
		// drawn until they are in. Rendering the app and then laying a modal
		// over it — the old order — left every chat, name and figure legible
		// behind the lock screen.
		if (identityAvailable() && DaimondIdentity.exists()) {
			locked = true;
			document.body.classList.add('locked');
			sessionNameEl.textContent = '';
			chatInputBar.style.display = 'none';
			try { DaimondTrail.note('lock screen', 'boot found a stored identity'); } catch (e) {}
			showIdentity('unlock');
			window.__DAIMOND_READY = true;
			return;
		}

		renderAll();
		fillSettings();          // the pane is on screen; it shows what is configured
		if (identityAvailable() && !cfgReady(cfg) && !cfg.apiKey) {
			showIdentity('create');
		} else if (!cfgReady(cfg)) {
			openSettings('');
		}
	}

	/// Returning from Stripe. The webhook credits the ledger, and it can land a
	/// moment after the browser gets redirected back, so a single read would
	/// often show the old balance and look like the payment had failed.
	async function handleCheckoutReturn() {
		if (!window.DaimondGateway) return;
		var buy = DaimondGateway.consumeReturn();
		if (!buy) return;
		if (buy === 'cancel' || buy === 'card:cancel') {
			noticeDialog(t('checkout.cancelled'), t('checkout.cancelled_body'));
			return;
		}
		// A card came back from Stripe. Nothing was charged, so there is no balance to wait on --
		// but the card arrives by WEBHOOK, so the panel is drawn after a moment's grace rather
		// than immediately, when the gateway would still say there is no card.
		if (buy === 'card:saved') {
			openCredits('');
			for (var k = 0; k < 8; k++) {
				await new Promise(function (r) { setTimeout(r, 800); });
				if (window.DaimondAutoReload) await DaimondAutoReload.render();
				var st = window.DaimondAutoReload && DaimondAutoReload.settings();
				if (st && st.card && st.card.saved) {
					noticeDialog(t('checkout.card_saved'), t('checkout.card_saved_body'));
					return;
				}
			}
			noticeDialog(t('checkout.card_saved'), t('checkout.card_pending_body'));
			return;
		}
		// Pro came back from Stripe. The licence is minted by WEBHOOK, so it may
		// lag the redirect by a moment; poll the licence rather than read it once.
		if (buy === 'pro') {
			openCredits('');
			for (var pk = 0; pk < 12; pk++) {
				await new Promise(function (r) { setTimeout(r, 900); });
				var held = await DaimondGateway.refreshLicence();
				renderCredits();
				if (held) {
					if (window.DaimondSync && DaimondSync.recheck) DaimondSync.recheck();  // sync is on now
					noticeDialog(t('checkout.pro_unlocked'), t('checkout.pro_unlocked_body'));
					return;
				}
			}
			noticeDialog(t('checkout.received'), t('checkout.pro_pending_body'));
			return;
		}
		var before = DaimondGateway.state().credits;
		for (var i = 0; i < 10; i++) {
			await new Promise(function (r) { setTimeout(r, 1000); });
			await DaimondGateway.refreshBalance();
			var now = DaimondGateway.state().credits;
			if (now !== null && now !== before) {
				renderCredits(); updateSpend();
				// The balance moved, so the key minted against the old one is worth less than the
				// account now is -- and a user who has just topped up from nothing has no key at
				// all. Mint against what they actually have before telling them it is theirs.
				await syncCredits();
				noticeDialog(t('credits.added'),
					t('credits.now', { amount: DaimondGateway.fmtMoney(now, DaimondGateway.state().currency) }));
				return;
			}
		}
		renderCredits(); updateSpend();
		syncCredits();
		noticeDialog(t('checkout.received'), t('checkout.credits_pending_body'));
	}
	// The document used to REPLACE the chat, so closing it had to put the chat
	// back. It is a stage panel now and sits beside the chat, so its own closer
	// is the whole of it: there is nothing to restore.

	// Leaving with agents in flight kills them: their fetches die with the page.
	window.addEventListener('beforeunload', function (e) {
		if (!Workers.busy()) return;
		e.preventDefault();
		e.returnValue = '';
	});

	boot().then(handleCheckoutReturn);
})();
