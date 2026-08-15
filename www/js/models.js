/* models.js — the models Daimond can reach, across every provider you have a key for.
 *
 * Daimond used to hold ONE provider: a base URL, a key, a model. That is the shape of a
 * demo, not of a working setup — the model you want for a cheap classification is not the
 * one you want for a hard refactor, and they rarely live behind the same key. So a key is
 * held per provider, every provider's models are listed together, and exactly one model is
 * the default a new chat starts with.
 *
 * The store, in localStorage:
 *
 *   {
 *     v: 2,
 *     def: { provider, model },              the default a new chat or Diamond starts with
 *     providers: {
 *       <id>: { name, url, key|keyEnc, models: [id…], fetched }
 *     }
 *   }
 *
 * A key is written to storage ENCRYPTED (`keyEnc`) whenever there is a passphrase identity
 * to encrypt it under, exactly as the single key was; the plaintext exists only in memory,
 * and only after the user has unlocked. `key` is the plaintext-at-rest fallback for the
 * skippable, browser-only path, and it is the same trade the app already made.
 *
 * ACROSS DEVICES. The store travels in the sync parcel — see `exportSync`/`applySync` at the
 * end of this file — because a second device that has to be told about six providers again,
 * and have six keys pasted into it again, is not the same account: it is a second setup. What
 * travels is the SEALED key and never a readable one, which is safe for exactly one reason:
 * both devices hold the same identity (the salt travels in the pairing bundle), so `keyEnc`
 * opens on both and the gateway carrying it holds no key for either.
 *
 * One provider is not like the others. `credits` is the models a Daimond balance buys, and
 * its key is MINTED by the gateway rather than typed by the user — see `mint()`. Everything
 * else about it is ordinary: it is a row in the same store, its models come from the same
 * `fetchModels`, and the browser calls it directly with no relay in the middle. That last
 * part is the whole product, and it is why credits could not simply be proxied.
 */
(function () {
	'use strict';

	/// What the app says. The table lives in i18n/en.js.
	function t(k, v)     { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }
	function tn(k, n, v) { return window.DaimondI18n ? DaimondI18n.tn(k, n, v) : k; }

	/// A string from the table, or the English written here when the table has no
	/// entry for it yet. The twin of `tOr` in daimond.js, and for the same reason:
	/// a control reading "copy.what_model" is worse than one reading English while
	/// the key is on its way. `vars` fills `{name}` placeholders in either.
	function tOr(key, fallback, vars) {
		var s = t(key, vars);
		if (s !== key) return s;
		if (!vars) return fallback;
		return String(fallback).replace(/\{(\w+)\}/g, function (whole, k) {
			return vars[k] != null ? String(vars[k]) : whole;
		});
	}

	/// The app's copy button, or nothing when daimond.js has not published it yet.
	/// A missing button is a row without a convenience; a thrown error here would
	/// be a Models panel that does not draw.
	function copyBtn(what, get) {
		if (!(window.DaimondUI && DaimondUI.copyBtn)) return null;
		return DaimondUI.copyBtn(what, get);
	}

	// ── The pause, refused where the money is committed ─────────────
	// A pause the widget respects and the network does not is decoration, so it
	// is checked HERE, in front of the mint, rather than trusted to whatever
	// asked. `isPaused` is a set lookup, which is why it can sit in front of
	// every one.

	/// The worker pump's leaf. Every slot key (>=1) is that pump spending,
	/// whichever Diamond asked for it, so one node gates the lot.
	function workersNode() {
		return window.DaimondPause ? DaimondPause.id(DaimondPause.ROOT, 'workers') : 'root/workers';
	}

	/// Is this node paused? Absent module means nothing is, which is the state
	/// the app was in before the tree existed.
	function held(node) {
		return !!(node && window.DaimondPause && DaimondPause.isPaused(node));
	}

	/// The refusal a pause produces: an Error naming the node and how to start
	/// it again. `paused` marks it so a caller can show a held spend calmly
	/// rather than as a fault, and `pauseNode` says which control to point at.
	function pauseError(node) {
		var s = t('pause.refused.turn', { node: node });
		if (s === 'pause.refused.turn') {
			// A byte-for-byte copy of the catalogue entry, `{node}` filled in here.
			// Assembling a second wording is how this drifted from `en.js` unnoticed.
			s = ('{node} is paused. No turn started, nothing spent. '
				+ 'Press play on it to resume.').replace(/\{node\}/g, node);
		}
		var e = new Error(s);
		e.paused    = true;
		e.pauseNode = node;
		return e;
	}

	var KEY     = 'daimond-models-v2';
	var OLD_KEY = 'daimond-byok';           // the single-provider config this replaces
	// Providers deleted on purpose, by id. The sync merge is a UNION, so a row
	// this device removed is simply handed back by the device that still has it,
	// key and all — absence in a parcel means "that device never had it", never
	// "it is gone". A tombstone is what tells the two apart, and it is the same
	// mechanism, TTL and merge rule the chats and the Diamonds use.
	var TOMBS   = 'daimond-provider-tombs';
	var deps    = null;                     // { onChange, onTopUp }

	/// The provider whose key Daimond mints, rather than the user pasting one.
	var CREDITS  = 'credits';
	/// Where a key is minted from. Session-authed, empty body; see `mint()`.
	var MINT_URL = '/api/inference-key';

	/// The providers Daimond knows how to talk to. Every one was verified to allow a direct
	/// browser call, so a key works with no relay in the middle. `model` is a sensible default
	/// where the provider has a stable id worth starting on.
	///
	/// `credits` carries no URL: the gateway names the host when it mints the key, so the one
	/// provider Daimond runs itself is also the one it does not hardcode an endpoint for.
	/// `anthropic` is the one row that is NOT OpenAI-compatible. Its endpoint is the Messages
	/// API, and the wasm client picks the wire dialect off that path — see `Dialect` in
	/// src/llm.rs. It is here because Claude was reachable only through a router, which meant
	/// every turn paid a middleman and no turn could ask for extended thinking at all.
	var KNOWN = {
		credits:    { name: 'Daimond credits', url: '',                                                    model: '' },
		anthropic:  { name: 'Anthropic',    url: 'https://api.anthropic.com/v1/messages',              model: 'claude-opus-5' },
		fireworks:  { name: 'Fireworks AI', url: 'https://api.fireworks.ai/inference/v1/chat/completions', model: 'accounts/fireworks/models/glm-5p2' },
		openrouter: { name: 'OpenRouter',   url: 'https://openrouter.ai/api/v1/chat/completions',          model: '' },
		together:   { name: 'Together AI',  url: 'https://api.together.xyz/v1/chat/completions',           model: '' },
		groq:       { name: 'Groq',         url: 'https://api.groq.com/openai/v1/chat/completions',        model: '' },
		deepinfra:  { name: 'DeepInfra',    url: 'https://api.deepinfra.com/v1/openai/chat/completions',   model: '' },
	};

	/// The Anthropic API version this app is written against.
	///
	/// Pinned rather than tracking latest, and the same constant the wasm client sends
	/// (`ANTHROPIC_VERSION` in src/llm.rs): the version header is what stops a breaking change
	/// to the wire shape arriving without a code change.
	var ANTHROPIC_VERSION = '2023-06-01';

	var store = { v: 2, def: { provider: '', model: '' }, providers: {} };

	/// Provider id -> plaintext key, memory only.
	///
	/// For a key the user typed this is a cache: the durable copy is in `store`, sealed. For
	/// `credits` it is the ONLY copy, and deliberately so. A minted key is a bearer credential
	/// for money — whoever holds it can spend the balance behind it — and it is worth strictly
	/// less to Daimond at rest than it costs to keep: another one is one authenticated request
	/// away. So it is never written to `store`, never to localStorage, never sealed, never
	/// exported, never synced. There is no at-rest story for this key because there is nothing
	/// at rest. `lock()` empties this map, which is the whole of forgetting it.
	var plain = {};

	/// What the last mint said, and what the row says about itself. Memory only, for the same
	/// reason the key is: a balance drawn from disk after a reload is a number that was true
	/// once, and money the user cannot trust is worse than money they cannot see.
	var credits = {
		state: '',      // '' | 'minting' | 'ready' | 'nocredits' | 'offline' | 'failed'
		bal:   0,       // minor units behind the key
		cur:   'usd',
		limit: 0,       // minor units the minted key may itself spend
		via:   '',      // who actually runs the models, per the gateway
		why:   '',      // what went wrong, when something did
	};

	/// Which mint the live key came from, counting up. The gateway keeps at most ONE live key
	/// per account, so a caller holding a key from an earlier generation is holding a revoked
	/// one — and needs the current key, not another mint. See `remint()`.
	var mintGen = 0;
	/// The mint in flight, so simultaneous callers make one request between them.
	var minting = null;

	// ── The store ───────────────────────────────────────────────────

	function load() {
		var raw = null;
		try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { raw = null; }
		if (raw && raw.v === 2 && raw.providers) {
			store = raw;
			if (!store.def) store.def = { provider: '', model: '' };
			return;
		}
		migrate();
	}

	/// Carry the single provider the app used to hold into the store that holds many.
	///
	/// The user has a key in there and a model they chose; losing either because the shape
	/// changed underneath them would be the app forgetting something they told it. The old
	/// record is left where it is — it still carries `maxTokens` and `tools`, which are not
	/// per-provider and are still read from it.
	function migrate() {
		var old = null;
		try { old = JSON.parse(localStorage.getItem(OLD_KEY) || 'null'); } catch (e) { old = null; }
		store = { v: 2, def: { provider: '', model: '' }, providers: {} };
		if (!old || !old.baseUrl) { save(); return; }

		var id = idForUrl(old.baseUrl) || 'custom';
		var models = [];
		try { models = JSON.parse(localStorage.getItem('daimond-models') || '[]'); } catch (e) { models = []; }

		store.providers[id] = {
			name:    (KNOWN[id] && KNOWN[id].name) || 'Custom provider',
			url:     old.baseUrl,
			key:     old.apiKey || '',
			keyEnc:  old.apiKeyEnc || '',
			models:  Array.isArray(models) ? models : [],
			fetched: 0,
		};
		if (old.model) store.def = { provider: id, model: old.model };
		save();
	}

	function save() {
		try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* quota */ }
		if (deps && deps.onChange) deps.onChange();
	}

	/// Stamp a provider row as configured just now.
	///
	/// The merge across devices needs one number per row to compare, and it has to be bumped by
	/// every change a user would be cross to lose — a key, a name, a URL, a manual balance. The
	/// model list carries its own stamp (`fetched`) and is merged on that instead: "who asked
	/// the provider more recently" and "who configured the row more recently" are two different
	/// questions and a single stamp answers neither well.
	function touch(id) {
		var p = store.providers[id];
		if (p) p.touched = Date.now();
	}

	/// Which known provider a base URL belongs to, or '' when it is nobody's.
	function idForUrl(url) {
		for (var id in KNOWN) { if (KNOWN[id].url === url) return id; }
		return '';
	}

	function providerUrl(id) {
		var p = store.providers[id];
		return (p && p.url) || (KNOWN[id] && KNOWN[id].url) || '';
	}
	/// A provider's name for the screen.
	///
	/// A vendor's name is a proper noun and is never translated; the two names
	/// this app made up for itself -- the credits row and the catch-all for a
	/// provider it does not know -- are phrases, and are. They are matched on
	/// the stored English because that is what a store written before the
	/// interface spoke anything else holds.
	function providerName(id) {
		var p = store.providers[id];
		var n = (p && p.name) || (KNOWN[id] && KNOWN[id].name) || id;
		if (id === CREDITS || n === 'Daimond credits') return t('models.credits_row');
		if (n === 'Custom provider') return t('models.custom_provider_name');
		return n;
	}

	/// Whether an endpoint speaks Anthropic's Messages API rather than OpenAI chat completions.
	///
	/// The same two signals the wasm client uses (`Dialect::for_endpoint` in src/llm.rs), and
	/// deliberately the same shape of test, because a browser that lists models one way and a
	/// turn that posts them another is a provider that half works.
	function isAnthropic(url) {
		var s = String(url || '').toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
		if (!s) return false;
		if (/^https?:\/\/([^/:]*\.)?anthropic\.com([:/]|$)/.test(s)) return true;
		return s.slice(-'/v1/messages'.length) === '/v1/messages';
	}

	/// Derive the model-listing endpoint from a turn endpoint.
	///
	/// Anthropic's listing sits at `/v1/models`, a SIBLING of `/v1/messages` — appending
	/// `/models` to the turn endpoint (which is what every other provider needs) would ask
	/// `/v1/messages/models`, which is nobody's endpoint and 404s.
	function modelsUrl(base) {
		if (isAnthropic(base)) return String(base).replace(/\/+$/, '').replace(/\/messages$/, '/models');
		if (base.indexOf('/chat/completions') !== -1) return base.replace('/chat/completions', '/models');
		return base.replace(/\/+$/, '') + '/models';
	}

	/// The headers a listing or turn request needs for `url`.
	///
	/// Anthropic refuses a bearer token: it wants `x-api-key`, a pinned version, and — for a
	/// call made from a page rather than a server — the header that makes its edge answer a
	/// cross-origin request at all. Without that last one the browser never sees a reply, only
	/// a CORS failure, which is why a provider that works from curl can still look broken here.
	function authHeaders(url, key) {
		if (!isAnthropic(url)) return { authorization: 'Bearer ' + key };
		return {
			'x-api-key':         key,
			'anthropic-version': ANTHROPIC_VERSION,
			'anthropic-dangerous-direct-browser-access': 'true',
		};
	}

	// ── Keys ────────────────────────────────────────────────────────

	/// Decrypt every stored key into memory. Called once the user unlocks: a sealed key is
	/// unreadable until then, which is the point of sealing it.
	async function unseal() {
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return;
		for (var id in store.providers) {
			var p = store.providers[id];
			if (p.keyEnc) {
				try { plain[id] = await DaimondIdentity.unwrap(p.keyEnc); }
				catch (e) { plain[id] = ''; }
			} else if (p.key) {
				plain[id] = p.key;
			}
		}
		if (deps && deps.onChange) deps.onChange();
		refreshCredits();
	}

	/// Re-seal every provider key under the passphrase that has just replaced the old one.
	///
	/// Called AFTER `DaimondIdentity.changePassphrase`. No read-out phase is needed, unlike
	/// mail's: a key is already decrypted in `plain` for the length of an unlocked session, so
	/// only the wrapping has to be redone.
	///
	/// **This was missing until 2026-08-14 and the failure was silent and total**: nothing
	/// re-wrapped `keyEnc`, so after a passphrase change every provider key was unreadable,
	/// `ready()` went false and the app lost its model connection — while the notice on screen
	/// said the saved key HAD been re-encrypted. A message that says the opposite of what
	/// happened is worse than no message.
	///
	/// A provider whose key cannot be re-sealed is NAMED, because "OpenRouter needs its key
	/// again" can be acted on and "something went wrong" cannot.
	/// A provider named so the user can tell two of them apart.
	///
	/// `p.name` alone is not enough: `addProvider` defaults it to "Custom provider"
	/// for any unknown id, so somebody with two custom endpoints would be told
	/// "Custom provider needs its key again" and have no way to know which. The URL
	/// is what actually distinguishes them, so it is appended whenever the name is
	/// not unique across the store.
	function labelOf(id) {
		var p = store.providers[id];
		if (!p) return id;
		var nm = p.name || id, seen = 0;
		for (var other in store.providers) {
			if ((store.providers[other].name || other) === nm) seen++;
		}
		return seen > 1 && p.url ? nm + ' (' + p.url + ')' : nm;
	}

	async function resealAfterRekey() {
		var failed = [], unread = [];
		for (var id in store.providers) {
			var p = store.providers[id];
			var key = plain[id];
			if (!key) {
				// Sealed, and `unseal` could not open it — it turns a failed unwrap
				// into an empty string, so a key that was ALREADY unreadable arrives
				// here indistinguishable from a provider with no key at all. Told
				// apart by the ciphertext still being there, and reported: this is
				// the one moment the app holds both the fact and the user's
				// attention, and saying nothing is how a dead key stays dead.
				if (p.keyEnc) unread.push(labelOf(id));
				continue;
			}
			try {
				p.keyEnc = await DaimondIdentity.wrap(key);
				p.key    = '';					// never leave a plaintext copy behind
			} catch (e) { failed.push(labelOf(id)); }
		}
		save();
		return { ok: !failed.length && !unread.length, failed: failed, unread: unread };
	}

	/// Take part in a passphrase change, registered HERE beside the seal.
	///
	/// NO READ-OUT PHASE, deliberately: a key is already decrypted in `plain` for
	/// the length of an unlocked session, so there is nothing to read out under
	/// the old key and nothing held afterwards that was not held before. `mail.js`
	/// is the other shape and needs both phases; the registry expresses both
	/// rather than bending either.
	if (window.DaimondRekey) {
		DaimondRekey.register({
			name:   'models',
			reseal: resealAfterRekey,
			sentence: function (kind, list) {
				return t(kind === 'unread' ? 'changepass.models_not_unsealed'
					: 'changepass.models_not_resealed', { list: list.join(', ') });
			},
		});
	}

	/// Store a key for a provider, sealed under the passphrase where there is one.
	async function setKey(id, key) {
		var p = store.providers[id];
		if (!p) return;
		touch(id);							// a configuration change the other device must see
		plain[id] = key;
		p.key = '';
		p.keyEnc = '';
		if (window.DaimondIdentity && DaimondIdentity.isUnlocked()) {
			try { p.keyEnc = await DaimondIdentity.wrap(key); }
			catch (e) { p.key = key; }             // no identity to seal under: the old trade
		} else {
			p.key = key;
		}
		// A key that was just pasted is a key whose balance nobody has asked about. A stale
		// figure from the PREVIOUS key would be worse than none, so any credit record goes —
		// and with it the gate's memory of the OLD key's probes, whose floor and whose backoff
		// were about a credential this row no longer holds.
		delete p.credit;
		delete probes[id];
		save();
		if (canProbeCredit(providerUrl(id))) {
			fetchCredit(id).then(function (got) {
				if (got && document.getElementById('models-list')) render();
			}).catch(function () { /* no balance is better than a wrong one */ });
		}
	}

	/// The plaintext key for a provider, or '' when it is sealed and the app is locked.
	function keyFor(id) {
		if (plain[id]) return plain[id];
		var p = store.providers[id];
		return (p && p.key) || '';
	}

	/// Whether a provider holds a key at all, sealed or not. A provider with no key is
	/// listed but cannot be used, and says so.
	///
	/// A live key in memory counts, and must: `credits` holds its minted key there and nowhere
	/// else, so a predicate reading only the stored copy called the one provider that was
	/// working keyless. `keyFor()` has always answered from `plain` first, so the two now agree
	/// — which is the actual bug. For a provider whose key the user typed nothing changes:
	/// `plain[id]` is only ever filled from `key` or `keyEnc`, so it can add no new truth.
	function hasKey(id) {
		var p = store.providers[id];
		return !!(p && (plain[id] || p.key || p.keyEnc));
	}

	/// Whether the key is present but unreadable because the app is locked.
	///
	/// A minted key is never sealed — it is not stored to be sealed — so a locked `credits` row
	/// is not "sealed", it is simply keyless until the next mint. Unlocking is still what fixes
	/// it, because minting needs the device signature that unlocking makes available.
	function isSealed(id) {
		var p = store.providers[id];
		return !!(p && p.keyEnc && !plain[id]);
	}

	/// Whether this provider can be used right now: a key, and one we can read.
	function canRun(id) {
		return hasKey(id) && !isSealed(id);
	}

	// ── Credits: the key Daimond mints ──────────────────────────────
	// Credits used to buy everything except the thing the app is for. A user with money in
	// their account could fetch a page, send mail and sync with it, and the model picker still
	// said "no model connected" — the two halves of the product had no seam between them. This
	// is the seam, and it is deliberately a small one: credits are a provider row like any
	// other, and the only difference is who produces the key.

	/// The chat-completions endpoint a minted key is spent at.
	///
	/// The gateway names a BASE url — `https://openrouter.ai/api/v1` — because that is what its
	/// operator configures and what the host documents. A provider row wants the endpoint a turn
	/// is POSTed to verbatim, which is that string plus `/chat/completions`. Both forms are
	/// accepted, since an operator who configures the whole endpoint is not wrong either. The two
	/// are reconciled HERE rather than left to the caller, because a row built on the base URL
	/// looks perfectly well until the first turn, which is much too late to discover it.
	function chatUrl(base) {
		var s = String(base || '').replace(/\/+$/, '');
		if (!s || s.indexOf('/chat/completions') !== -1) return s;
		return s + '/chat/completions';
	}

	/// Who actually runs a minted key's models, for saying so on the row.
	///
	/// The user bought Daimond credits, so the row is named for that — but the request leaves
	/// their browser for somebody else's machine, and an app whose whole claim is that nothing
	/// happens behind the user's back cannot leave that out. The host is read from the URL the
	/// gateway hands back, so the row names whoever it actually minted against rather than
	/// whoever this file was written expecting.
	function hostOf(url) {
		var id = idForUrl(url);
		if (id && KNOWN[id]) return providerName(id);
		try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
	}

	function money(minor, cur) {
		if (window.DaimondGateway && DaimondGateway.fmtMoney) return DaimondGateway.fmtMoney(minor, cur);
		return '$' + ((minor || 0) / 100).toFixed(2);
	}

	/// Mint a fresh inference key, and hold it in memory only.
	///
	/// The gateway authenticates the session, reconciles what the last key drew, and returns a
	/// key capped at the smaller of its float and the balance behind it — so the cap is usually
	/// well UNDER the balance, and a key runs out long before the credits do. That is what
	/// `remint()` is for. No amount is sent: what a key may spend is the account's business, and
	/// a browser that could ask for a number could ask for the wrong one.
	///
	/// Minting also REVOKES the account's previous key: the gateway keeps at most one live per
	/// account. So this is not free to call twice, and a second tab minting will quietly spend
	/// this one's key — which the 401 retry then heals, one turn at a time.
	///
	/// The contract version rides on this call like every other, and is READ from gateway.js
	/// rather than copied: two constants that must match are two constants that will one day
	/// not. A tab too old to serve is answered 426, which is turned into the reload the updater
	/// exists for.
	/// POST the mint endpoint for one slot, returning the parsed reply or throwing.
	///
	/// Factored out of `mint` so the chat (slot 0) and each parallel worker (its
	/// own slot) share exactly one request path. The slot rides in the body, and
	/// the gateway gives each slot its OWN capped key -- so parallel workers never
	/// share a key, and their concurrent requests cannot race a shared cap into an
	/// overspend. A body naming no slot is slot 0, which is the chat's own key.
	///
	/// `node` is the pause-tree leaf the turn belongs to, when the caller knows
	/// it — a chat's leaf, a Diamond's `self`. A mint is where a turn commits, so
	/// a paused leaf is refused here and no request goes out. A slot of 1 or more
	/// is the worker pump spending, and that leaf is checked whether the caller
	/// names one or not: the pump is the same pump however the work reached it.
	async function mintRequest(slot, node) {
		var stop = held(node) ? node
			: (((slot | 0) >= 1 && held(workersNode())) ? workersNode() : '');
		if (stop) throw pauseError(stop);
		var head = { 'content-type': 'application/json' };
		if (window.DaimondGateway && DaimondGateway.clientApi) {
			head['x-daimond-api'] = String(DaimondGateway.clientApi());
		}
		var r = await fetch(MINT_URL, {
			method:      'POST',
			headers:     head,
			credentials: 'same-origin',
			body:        JSON.stringify({ slot: slot | 0 }),
		});
		if (r.status === 426) { try { window.dispatchEvent(new Event('daimond:stale')); } catch (e) {} }
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		// The gateway reconciles the account before it answers, so this reply carries the one
		// balance in an ordinary chat session that has actually moved -- on the refusal as much as
		// on the mint, which is the moment a nearly empty account most needs the figure to be
		// right. `credits.bal` below is this file's own copy for the models panel; the account
		// figure in the rail belongs to gateway.js and has to be told, and was not.
		if (window.DaimondGateway && DaimondGateway.noteBalance) DaimondGateway.noteBalance(j);
		if (!r.ok || !j || j.ok === false) {
			var err = new Error((j && (j.error || j.message))
				|| t('models.err_refused', { status: r.status }));
			// An empty account is not a fault, it is a thing to do, and the row offers the doing
			// of it rather than reporting an error at somebody who has done nothing wrong. `402
			// Payment Required` is the gateway saying exactly that; the balance is checked too,
			// so this holds whichever way it chooses to say it.
			err.noCredits = r.status === 402 || !!(j && j.credits_minor === 0);
			throw err;
		}
		if (!j.key || !j.url) throw new Error(t('models.err_bad_key'));
		return j;
	}

	/// `node` is the leaf the mint is for, when there is one. The mint at unlock
	/// belongs to no leaf and passes none: gating it would leave a paused chat's
	/// pause holding the whole account keyless.
	async function mint(node) {
		var j           = await mintRequest(0, node);
		var url         = chatUrl(j.url);
		plain[CREDITS]  = j.key;                // memory, and nowhere else — see `plain`.
		mintGen++;                              // this key's generation; the last one is revoked.
		credits.bal     = typeof j.credits_minor === 'number' ? j.credits_minor : 0;
		credits.cur     = j.currency || 'usd';
		// What the key itself may draw, which is NOT the balance: the gateway caps a minted key
		// at a float, so a key can be spent while the account still holds credits. That is why
		// a refusal mid-session is answered with another key rather than reported as an error.
		credits.limit   = typeof j.limit_minor === 'number' ? j.limit_minor : 0;
		credits.via     = hostOf(url);
		credits.state   = 'ready';
		credits.why     = '';

		// The row itself is ordinary and IS stored: its name, its host and the models behind it
		// are not secrets, and keeping them means a returning user sees their models while the
		// mint is still in flight rather than an empty panel. `key` and `keyEnc` stay empty for
		// this row, always.
		var p = store.providers[CREDITS];
		store.providers[CREDITS] = {
			name:    KNOWN[CREDITS].name,
			url:     url,
			key:     '',
			keyEnc:  '',
			models:  (p && p.models) || [],
			fetched: (p && p.fetched) || 0,
		};
		save();
		return credits;
	}

	/// Stand the credits row down: no key, and a reason the panel can show.
	///
	/// The row is left in place when it is already there. A user who has been running on
	/// credits and has just run out needs to see that that is what happened, beside the models
	/// they were using; removing the row would leave them looking for something that had
	/// silently gone. A user who never had credits never gets a row at all, so nothing new
	/// appears in the panel of somebody who only ever wanted their own key.
	function standDown(state, why) {
		delete plain[CREDITS];
		credits.state = state;
		credits.why   = why || '';
		if (state !== 'ready') credits.limit = 0;
		if (deps && deps.onChange) deps.onChange();
	}

	/// Make the credits row reflect the account: mint while there is a balance to spend, stand
	/// down when there is not, and list what the key can run.
	///
	/// `acct` is what the caller has just read from the gateway — `{ authed, credits, currency,
	/// offline }`. It is passed in rather than fetched here so the gateway's contract stays in
	/// gateway.js and this file stays about models.
	async function syncCredits(acct) {
		acct = acct || {};
		if (!acct.authed) { standDown(acct.offline ? 'offline' : ''); return false; }
		if (typeof acct.credits === 'number' && acct.credits <= 0) { standDown('nocredits'); return false; }

		credits.state = 'minting';
		if (deps && deps.onChange) deps.onChange();
		try {
			await mint();
		} catch (e) {
			standDown(e && e.noCredits ? 'nocredits' : 'failed', e && e.message ? e.message : String(e));
			return false;
		}
		// The catalogue behind a minted key is large and changes without us, so it is asked for
		// rather than assumed. A refusal here leaves the key good and the row usable on whatever
		// was already listed.
		try { await fetchModels(CREDITS); }
		catch (e) { /* the key still works; the list is just older than we hoped. */ }
		if (deps && deps.onChange) deps.onChange();
		return true;
	}

	/// A fresh key for a spent one, mid-session.
	///
	/// A minted key is capped at a float well under the balance, so it is refused the moment
	/// that cap is reached while the account behind it still holds credits. That is not a key
	/// the user can check and not a failure to report: it is a key to replace. Callers get one
	/// shot at this per turn.
	///
	/// **Coalesced, and that is the whole of this function.** The gateway keeps at most one live
	/// key per account: minting revokes the last one. So several agents that hit a spent key
	/// together must not mint several keys, or each would revoke the one before it and they
	/// would chase each other round — the two-tab race, but automated, at machine speed, and
	/// spending real money on every lap. Two things close it:
	///
	///   * `gen` — the mint generation the caller's key came from. A caller whose key has
	///     ALREADY been replaced by somebody else's mint does not mint: it takes the live key,
	///     which is the very thing it was about to ask for.
	///   * `minting` — callers arriving together wait on the one request in flight rather than
	///     racing it.
	///
	/// Between them, N agents holding one spent key produce exactly ONE mint, whether they fail
	/// at the same instant or one after another.
	///
	/// `node` is the leaf whose turn wants the key. Checked BEFORE the coalescing
	/// guards, so a paused chat neither mints nor takes the key another caller is
	/// minting: joining a mint in flight is how a paused leaf would go on running
	/// on somebody else's key.
	async function remint(gen, node) {
		if (held(node)) throw pauseError(node);
		if (typeof gen === 'number' && gen < mintGen && plain[CREDITS]) return plain[CREDITS];
		if (minting) return await minting;
		minting = (async function () {
			delete plain[CREDITS];
			credits.state = 'minting';
			try {
				await mint(node);
			} catch (e) {
				standDown(e && e.noCredits ? 'nocredits' : 'failed', e && e.message ? e.message : String(e));
				throw e;
			}
			if (deps && deps.onChange) deps.onChange();
			return keyFor(CREDITS);
		})();
		try { return await minting; }
		finally { minting = null; }
	}

	/// Which mint the live key came from. A caller records this when it builds something around
	/// the key, and hands it back to `remint()`, which uses it to tell "my key is spent" from
	/// "my key is merely old" — only the first needs a new one.
	function creditsGen() { return mintGen; }

	// ── Worker slots: a key per parallel worker ─────────────────────
	// The chat spends slot 0 — the key `mint`/`plain[CREDITS]` above hold. Each
	// parallel worker spends its OWN slot (>=1), so no two share a key: a shared
	// key is exactly what lets concurrent requests race the host's stale cap check
	// and overspend it. A slot is owned by one worker at a time (daimond.js hands
	// them out from a free-list), so nothing coalesces here — the single worker on
	// a slot mints and re-mints it in sequence.
	var slots = {};   // slot(>=1) -> { key, url, gen }

	/// Mint (or replace) the key for a worker slot, returning `{ key, url, gen }`.
	///
	/// `node` is the leaf that asked for the worker — the Diamond's `self`, or a
	/// triggered action. The worker pump's own leaf is checked regardless; see
	/// `mintRequest`.
	async function mintSlot(slot, node) {
		var j = await mintRequest(slot, node);
		var s = slots[slot] || (slots[slot] = { key: '', url: '', gen: 0 });
		s.key  = j.key;
		s.url  = chatUrl(j.url);
		s.gen += 1;
		// The balance is account-wide, so a worker's mint keeps the shared row as
		// current as the chat's own mint does.
		if (typeof j.credits_minor === 'number') credits.bal = j.credits_minor;
		return s;
	}

	/// A fresh key for a slot whose key was refused — unless another mint has
	/// already replaced it, the same generation guard `remint` uses, per slot.
	async function remintSlot(slot, gen, node) {
		// Before the generation guard, for the reason `remint` checks before its
		// own: handing back a key somebody else minted is still the paused node
		// carrying on.
		if (held(node)) throw pauseError(node);
		if (held(workersNode())) throw pauseError(workersNode());
		var s = slots[slot];
		if (s && typeof gen === 'number' && gen < s.gen && s.key) return s;
		return await mintSlot(slot, node);
	}

	/// A slot's live `{ key, url, gen }`, or null if it holds none yet.
	function slotConfig(slot) { return slots[slot] || null; }

	/// Forget one slot's key (its worker has finished with it). The key at the
	/// host is left for the next mint on that slot to rotate out, or the sweep.
	function forgetSlot(slot) { delete slots[slot]; }

	/// What the credits row currently is, for a caller that must explain it.
	function creditsState() {
		return {
			state:    credits.state,
			credits:  credits.bal,
			currency: credits.cur,
			limit:    credits.limit,
			via:      credits.via,
			why:      credits.why,
			hasRow:   !!store.providers[CREDITS],
			ready:    canRun(CREDITS),
		};
	}

	// ── The models ──────────────────────────────────────────────────

	/// A per-token price as USD per 1,000,000 tokens, or null when the figure cannot be
	/// trusted.
	///
	/// The units are the whole risk here. An OpenAI-compatible `/models` reply gives PER-TOKEN
	/// prices, usually as strings ("0.0000006153"); read as per-million they would understate
	/// spend by a factor of a million, which is worse than not knowing. So anything above
	/// 0.001/token — $1,000 per million, well above any model that exists — is refused rather
	/// than guessed at, and a provider using a different unit simply contributes nothing and
	/// leaves the table to answer.
	function perM(v) {
		if (v === null || v === undefined || v === '') return null;
		var n = (typeof v === 'number') ? v : parseFloat(v);
		if (!isFinite(n) || n < 0) return null;
		if (n === 0) return 0;                      // a free model is priced, at nothing
		if (n > 1e-3) return null;                  // not per-token; refuse to convert
		return n * 1e6;
	}

	/// The rates and context window one entry of a `/models` reply publishes, or null.
	function ratesOf(m) {
		if (!m || typeof m !== 'object') return null;
		var p = m.pricing || {};
		var inPerM  = perM(p.prompt !== undefined ? p.prompt : p.input);
		var outPerM = perM(p.completion !== undefined ? p.completion : p.output);
		if (inPerM === null || outPerM === null) return null;
		var cached = perM(p.input_cache_read !== undefined ? p.input_cache_read : p.cached_input);
		var ctx = (typeof m.context_length === 'number') ? m.context_length : null;
		var out = { in: inPerM, out: outPerM };
		if (cached !== null) out.cached = cached;
		if (ctx !== null) out.ctx = ctx;
		return out;
	}

	/// Ask a provider what it can run. The list is cached, because a chat's model can be
	/// switched from its header and re-asking on every switch would be rude to the provider
	/// and slow for the user.
	///
	/// The reply's prices and context windows are KEPT. They were being thrown away and the
	/// app then estimated a turn's cost from a hand-maintained table months out of date — while
	/// the provider had just told it, in the same request, exactly what it charges.
	async function fetchModels(id) {
		var url = providerUrl(id);
		var key = keyFor(id);
		if (!url || !key) throw new Error(t('models.err_no_key'));
		var r = await fetch(modelsUrl(url), { headers: authHeaders(url, key) });
		if (!r.ok) throw new Error(t('models.err_key_refused', { status: r.status }));
		var j = await r.json();
		var list = j.data || j.models || [];
		var ids = list
			.map(function (m) { return typeof m === 'string' ? m : (m.id || m.name); })
			.filter(Boolean)
			.sort();
		var rates = {};
		list.forEach(function (m) {
			if (typeof m === 'string') return;
			var mid = m.id || m.name;
			var rr = ratesOf(m);
			if (mid && rr) rates[mid] = rr;
		});
		store.providers[id].models  = ids;
		store.providers[id].rates   = rates;
		store.providers[id].fetched = Date.now();
		save();
		return ids;
	}

	/// What `provider` says it charges for `model`, as `{ inPerM, outPerM, cachedPerM, ctx }`,
	/// or null when it never said.
	///
	/// `DaimondPricing` asks this FIRST and falls back to its own table only when the answer is
	/// null, so a live quote always beats a surveyed figure. `cachedPerM` is null when the
	/// provider publishes no separate cache-read rate; it is NOT filled in with the input rate
	/// here, because "no discount published" and "no discount" are different claims and only
	/// the pricing code should decide what to do about it.
	function rateFor(provider, model) {
		var p = store.providers[provider];
		if (!p || !p.rates) return null;
		var r = p.rates[model];
		if (!r || typeof r.in !== 'number' || typeof r.out !== 'number') return null;
		return {
			inPerM:     r.in,
			outPerM:    r.out,
			cachedPerM: (typeof r.cached === 'number') ? r.cached : null,
			ctx:        (typeof r.ctx === 'number') ? r.ctx : null,
		};
	}

	// ── What is left on a key ───────────────────────────────────────

	/// Sibling endpoints of a chat-completions URL, for the two credit probes.
	function siblingUrl(base, leaf) {
		if (base.indexOf('/chat/completions') !== -1) {
			return base.replace('/chat/completions', '/' + leaf);
		}
		return base.replace(/\/+$/, '') + '/' + leaf;
	}

	/// Whether a provider's endpoint is one whose remaining balance can be ASKED for.
	///
	/// Only OpenRouter is known to answer, and only OpenRouter has been verified to answer a
	/// browser (both probes send CORS headers). Every other provider gets the manual tally
	/// instead — which is not a lesser feature, it is the honest one for a host that will not
	/// say.
	function canProbeCredit(url) {
		return String(url || '').indexOf('openrouter.ai') !== -1;
	}

	// ── When the figure is asked for again ──────────────────────────
	// A displayed balance goes wrong two ways, and the two want opposite treatments.
	//
	// The user SPENT. Daimond watched them do it: the turn and its cost are already in the
	// ledger, so the figure is walked down locally with no request at all — see `creditFor`.
	// That is the frequent case and it costs nothing.
	//
	// The user TOPPED UP. Nothing in the browser can know that; only a probe finds it. So the
	// probe happens at the moments a person would expect it to — unlocking, pasting a key,
	// coming back to the tab, opening this panel, and a heartbeat while the tab is in front —
	// and every one of them passes through the SAME gate, so three arriving together are still
	// one request.

	/// The shortest gap between two automatic probes of one key.
	///
	/// It is the user's own key and their own rate limit, which is what makes a modest poll
	/// cheap — but it is not free, and no limit is published for OpenRouter's `/key` or
	/// `/credits` endpoints. The way to find one out is not to hammer it, so the floor is set
	/// far under any plausible limit (twelve requests an hour at the very worst) while staying
	/// well inside the "I added money and came back" window this figure exists for. Every
	/// automatic trigger shares this one floor, which is what stops them stacking.
	var PROBE_FLOOR_MS = 5 * 60 * 1000;

	/// How often a VISIBLE tab asks the gate whether the floor has passed.
	///
	/// Not the cadence — the floor is the cadence. This only decides how promptly the floor is
	/// noticed once it has gone by, and it is what moves the age line on. A hidden tab does not
	/// beat at all: browsers throttle background timers anyway, and a request nobody is there
	/// to read is money and rate limit spent on nothing.
	var PROBE_BEAT_MS = 60 * 1000;

	/// The longest the gate will hold back a key whose probes keep failing.
	///
	/// A failure doubles the wait rather than retrying on the next beat: whatever is refusing —
	/// a rate limit, a revoked key, an outage — is not fixed by asking faster, and a tab left
	/// open overnight would otherwise spend the night retrying. A success clears it, and so
	/// does the user asking by hand.
	var PROBE_BACKOFF_MAX_MS = 30 * 60 * 1000;

	/// When a reading is old enough for its age to be said emphatically rather than quietly.
	///
	/// Six floors. Inside that, a figure is between beats or has been asked for and refused
	/// once, and neither is worth raising the voice about; past it, something has stopped
	/// working and the age is no longer a footnote on the figure but the point of it.
	var CREDIT_STALE_MS = 30 * 60 * 1000;

	/// Per provider: `{ at, busy, ok, fails }` — when it was last ASKED, whether an ask is in
	/// flight, whether the last completed one answered, and how many have failed in a row.
	///
	/// Memory only, deliberately: an attempt stamp restored from disk would hold back the one
	/// probe a freshly loaded tab most needs, which is the exact case this feature is for.
	var probes = {};

	/// How long the gate holds this key: the floor, doubled once per consecutive failure.
	function probeWait(id) {
		var st = probes[id];
		var n  = (st && st.fails) || 0;
		return Math.min(PROBE_FLOOR_MS * Math.pow(2, n), PROBE_BACKOFF_MAX_MS);
	}

	/// Whether an AUTOMATIC probe of this key is allowed right now. The user asking by hand is
	/// not automatic and does not come through here.
	function probeDue(id) {
		var st = probes[id];
		if (!st) return true;
		if (st.busy) return false;				// one in flight is one request already
		return (Date.now() - st.at) >= probeWait(id);
	}

	/// Ask every key that will answer, wherever the gate allows it.
	///
	/// Fire-and-forget on purpose: this is a nicety on a panel, and nothing may wait on somebody
	/// else's server. A probe that fails writes nothing, so the row keeps the figure it had —
	/// and the age line beside it goes on ageing, which is the only thing that tells a fresh
	/// figure from a frozen one.
	function refreshCredits() {
		for (var id in store.providers) {
			if (id === CREDITS) continue;
			if (!canProbeCredit(providerUrl(id)) || !keyFor(id)) continue;
			if (!probeDue(id)) continue;
			(function (pid) {
				fetchCredit(pid).then(function (got) {
					if (got && document.getElementById('models-list')) render();
					else ageLines();			// a refusal still moves the line that says so
				}).catch(function () { ageLines(); });
			})(id);
		}
	}

	/// Ask a provider what is left on its key.
	///
	/// Two questions, because a key answers only one of them. `/key` describes THIS key: its
	/// spend cap and what remains of it. A key with `limit: null` has no cap, and its
	/// `limit_remaining` is null too — which is not zero, and showing $0 to somebody holding a
	/// hundred dollars of credit would be the worst kind of wrong. So the account-wide figure
	/// from `/credits` answers for an uncapped key.
	///
	/// A failed probe writes NOTHING and returns null: the row then shows no balance at all,
	/// rather than a zero it cannot stand behind. A figure is never stored without the moment it
	/// was true (`asOf`), because a balance drawn from disk with no timestamp is a number that
	/// was true once and is now a claim.
	///
	/// Returns `{ remainingUsd, asOf, capped }` or null.
	///
	/// Every route to a probe comes through here — unlock, a pasted key, the tab returning, the
	/// beat, the panel, the button — so this is where the attempt is stamped and its outcome
	/// recorded. One place, so the floor and the backoff cannot be walked round by adding a
	/// caller. A key that cannot be probed at all is not an attempt and is not stamped.
	async function fetchCredit(id) {
		if (!store.providers[id] || !keyFor(id) || !canProbeCredit(providerUrl(id))) return null;
		var st = probes[id] = {
			at:    Date.now(),				// stamped BEFORE the request, so a slow one still counts
			busy:  true,
			ok:    probes[id] ? probes[id].ok : null,
			fails: (probes[id] && probes[id].fails) || 0,
		};
		var got = null;
		try {
			got = await askCredit(id);
			return got;
		} finally {
			st.busy  = false;
			st.done  = Date.now();
			st.ok    = !!got;
			st.fails = got ? 0 : st.fails + 1;
		}
	}

	/// The two requests themselves. See `fetchCredit`, which is what everything calls.
	async function askCredit(id) {
		var p = store.providers[id];
		var url = providerUrl(id);
		var key = keyFor(id);
		if (!p || !url || !key || !canProbeCredit(url)) return null;
		var auth = { authorization: 'Bearer ' + key };
		var keyData = null;
		try {
			var rk = await fetch(siblingUrl(url, 'key'), { headers: auth });
			if (!rk.ok) return null;
			var jk = await rk.json();
			keyData = jk.data || jk;
		} catch (e) { return null; }
		if (!keyData) return null;

		var remaining = null, capped = false;
		if (typeof keyData.limit === 'number' && typeof keyData.limit_remaining === 'number') {
			remaining = keyData.limit_remaining;
			capped = true;
		} else {
			// Uncapped: the account's own credit is what this key can spend.
			try {
				var rc = await fetch(siblingUrl(url, 'credits'), { headers: auth });
				if (!rc.ok) return null;
				var jc = await rc.json();
				var cd = jc.data || jc;
				if (typeof cd.total_credits === 'number' && typeof cd.total_usage === 'number') {
					remaining = cd.total_credits - cd.total_usage;
				}
			} catch (e) { return null; }
		}
		if (typeof remaining !== 'number' || !isFinite(remaining)) return null;

		var asOf = Date.now();
		p.credit = {
			mode:         'auto',
			remainingUsd: remaining,
			asOf:         asOf,
			// A manual base the user may have set earlier is kept: an auto probe that starts
			// failing tomorrow should fall back to their figure, not forget it.
			baseUsd:      (p.credit && typeof p.credit.baseUsd === 'number') ? p.credit.baseUsd : null,
			baseAt:       (p.credit && typeof p.credit.baseAt === 'number') ? p.credit.baseAt : null,
		};
		save();
		return { remainingUsd: remaining, asOf: asOf, capped: capped };
	}

	/// Record the user's own figure: "I have $X on this key, as of now".
	///
	/// What is displayed afterwards is that figure counted down by the ledger's estimate of what
	/// has been spent on this provider since — and it is labelled as exactly that, because it is
	/// their number minus a guess, not a balance.
	function setCreditBase(id, usd) {
		var p = store.providers[id];
		if (!p) return;
		var n = (typeof usd === 'number') ? usd : parseFloat(usd);
		if (!isFinite(n) || n < 0) return;
		var prev = p.credit || {};
		p.credit = {
			mode:         'manual',
			// The probed figure is dropped: the user has just said what is true, and holding a
			// stale automatic number beside it invites the row to show two different balances.
			remainingUsd: null,
			asOf:         null,
			baseUsd:      n,
			baseAt:       Date.now(),
		};
		if (prev.mode === 'auto') p.credit.mode = 'manual';
		touch(id);
		save();
	}

	/// What the ledger says has gone on this provider's key since `since`.
	///
	/// The ledger is where a turn's cost is ALREADY recorded — one entry per metered turn,
	/// carrying the provider it was billed to — so this is not a second set of books, it is the
	/// same entries read per key. It is this device's ledger and only this device's: a second
	/// device spending the same key is drift, and the next probe replaces the figure outright
	/// rather than correcting it, so the drift cannot accumulate.
	function spentSince(id, since) {
		if (typeof since !== 'number') return 0;
		if (!(window.DaimondLedger && typeof DaimondLedger.perProvider === 'function')) return 0;
		var spent = 0;
		try {
			DaimondLedger.perProvider(since).forEach(function (row) {
				if (row.provider === id) spent += row.usd || 0;
			});
		} catch (e) { spent = 0; }
		return spent;
	}

	/// What this provider's key has left, and how that is known.
	///
	/// `{ mode: 'auto', usd, probedUsd, asOf, spentUsd }` — the provider said so, less what has
	/// been spent on it here since it said it.
	/// `{ mode: 'manual', usd, baseUsd, baseAt, spentUsd }` — the user said so, less the
	/// ledger's estimate of what has gone since.
	/// `null` — nothing is known, and the row must show nothing at all.
	function creditFor(id) {
		var p = store.providers[id];
		var c = p && p.credit;
		if (!c) return null;
		if (c.mode === 'auto' && typeof c.remainingUsd === 'number' && typeof c.asOf === 'number') {
			// Spending is the one movement Daimond can see for itself, so it is applied with no
			// request at all: a figure that sat still through a morning's work was telling the
			// user something it had every means to know was false. The probed number is kept
			// beside it (`probedUsd`) because the sentence has to be able to say which is which.
			var gone = spentSince(id, c.asOf);
			return {
				mode:      'auto',
				// Never below zero: no key holds negative money, and an estimate that ran past
				// the balance would be asserting something no provider could confirm.
				usd:       Math.max(0, c.remainingUsd - gone),
				probedUsd: c.remainingUsd,
				spentUsd:  gone,
				asOf:      c.asOf,
			};
		}
		if (typeof c.baseUsd === 'number' && typeof c.baseAt === 'number') {
			var spent = spentSince(id, c.baseAt);
			return {
				mode:     'manual',
				usd:      c.baseUsd - spent,
				baseUsd:  c.baseUsd,
				baseAt:   c.baseAt,
				spentUsd: spent,
			};
		}
		return null;
	}

	/// A balance as money, from a USD figure rather than the gateway's minor units.
	function usd(v) {
		if (window.DaimondI18n && typeof DaimondI18n.money === 'function') {
			return DaimondI18n.money(v, 'fine');
		}
		return '$' + (v || 0).toFixed(2);
	}

	/// Every model Daimond can reach, across every provider with a key.
	function all() {
		var out = [];
		for (var id in store.providers) {
			(store.providers[id].models || []).forEach(function (m) {
				out.push({ provider: id, name: providerName(id), model: m });
			});
		}
		return out;
	}

	function count() {
		var n = 0;
		for (var id in store.providers) n += (store.providers[id].models || []).length;
		return n;
	}

	function providers() {
		return Object.keys(store.providers).map(function (id) {
			var p    = store.providers[id];
			var mine = id === CREDITS;
			// What is left on the user's OWN key, when anything knows. The credits row's
			// balance is minted money and comes from `credits.bal` instead; the two are
			// different accounts and are never mixed.
			var cr   = mine ? null : creditFor(id);
			return {
				id:      id,
				name:    providerName(id),
				url:     providerUrl(id),
				models:  p.models || [],
				count:   (p.models || []).length,
				hasKey:  hasKey(id),
				sealed:  isSealed(id),
				ready:   canRun(id),
				// Two economies sit in one list. `paid` marks the rows that draw down the balance
				// the user is holding with Daimond; every other row is billed by the provider the
				// user holds an account with, and cannot touch that balance at all. Which of the
				// two a model belongs to is the difference between spending money here and
				// spending it elsewhere, so nothing may show a model without showing this.
				paid:    mine,
				minted:  mine,
				why:     mine ? credits.why : '',
				via:     mine ? credits.via : '',
				balance: mine
					? (credits.state === 'ready' ? money(credits.bal, credits.cur) : '')
					: (cr ? usd(cr.usd) : ''),
				state:   mine ? credits.state : '',
				// How the balance beside the name is known, so the row can say. Empty when
				// there is no balance to explain.
				creditMode: cr ? cr.mode : '',
				credit:     cr,
				// Whether this provider will answer the question at all, which decides
				// between an "ask again" affordance and a "tell me" one.
				canProbeCredit: !mine && canProbeCredit(providerUrl(id)),
			};
		});
	}

	/// The bare name a model id ends in, for spotting one model behind two providers.
	///
	/// Providers prefix ids differently — `accounts/fireworks/models/deepseek-v3` and
	/// `deepseek/deepseek-v3` are one model wearing two names — so only the last segment is
	/// compared. It is a shallow test and deliberately so: a false match marks two rows that did
	/// not need marking, which costs a few characters, where a missed one leaves the user unable
	/// to tell whose money a model spends.
	function baseName(m) {
		var s   = String(m || '');
		var cut = s.lastIndexOf('/');
		return (cut === -1 ? s : s.slice(cut + 1)).toLowerCase();
	}

	/// The model names more than one provider serves.
	///
	/// Llama, DeepSeek and Qwen are on the credits row AND on half the BYOK providers, so the
	/// picker shows the same name twice with different economics behind each. They are NOT
	/// deduped: which of the two is picked decides who gets paid, and that is the user's
	/// decision to make, not ours to make quietly on their behalf. So both are shown, and both
	/// are labelled.
	function dupes() {
		var seen = {}, dup = {};
		for (var id in store.providers) {
			var names = {};
			(store.providers[id].models || []).forEach(function (m) { names[baseName(m)] = 1; });
			for (var n in names) {
				if (seen[n]) dup[n] = 1;
				seen[n] = 1;
			}
		}
		return dup;
	}

	// ── The default, and resolving a chat's model ───────────────────

	function getDefault() {
		return { provider: store.def.provider || '', model: store.def.model || '' };
	}
	function setDefault(provider, model) {
		store.def = { provider: provider, model: model };
		store.defAt = Date.now();			// which device chose last, for the merge
		save();
	}

	/// What a chat needs to actually run: the endpoint, the key and the model.
	///
	/// A chat records the provider it was started on, so switching the default later does not
	/// silently move a running conversation to another model. A chat from before providers
	/// existed carries only a model id, and falls back to the default provider.
	function resolve(provider, model) {
		var d = getDefault();
		var id = provider || d.provider;
		var m  = model || (provider ? '' : d.model);
		if (!id || !store.providers[id]) return null;
		var key = keyFor(id);
		if (!key || !m) return null;
		return { provider: id, baseUrl: providerUrl(id), apiKey: key, model: m };
	}

	/// Whether anything can run at all: one provider, with a readable key, and a default model.
	function ready() {
		return !!resolve('', '');
	}

	function addProvider(id, opts) {
		opts = opts || {};
		store.providers[id] = {
			name:    opts.name || (KNOWN[id] && KNOWN[id].name) || 'Custom provider',
			url:     opts.url  || (KNOWN[id] && KNOWN[id].url)  || '',
			key:     '',
			keyEnc:  '',
			models:  [],
			fetched: 0,
			touched: stampNow(id),
		};
		save();
	}

	/// A stamp for a configuration written NOW, which must also beat any tombstone
	/// this id already carries.
	///
	/// Removing a provider and adding it straight back is one action to the user
	/// and two to the store, and the merge decides on strictly-later: a re-add
	/// stamped in the same millisecond as its own deletion would lose to it and
	/// vanish again on the next pull. A person cannot type that fast; a script,
	/// and a test, can.
	function stampNow(id) {
		return Math.max(Date.now(), ms(tombs()[id]) + 1);
	}

	function removeProvider(id) {
		delete store.providers[id];
		delete plain[id];
		delete probes[id];					// no floor to hold back a key that is gone
		if (store.def.provider === id) store.def = { provider: '', model: '' };
		// Before the store is written, so the very next push carries the deletion:
		// there is one way into this function and every delete in the panel comes
		// through it, which is what keeps the tombstone from being forgotten at one
		// of several call sites.
		tombstone(id);
		save();
	}

	/// The providers deleted on purpose, by id, with anything past its TTL pruned.
	/// The map, the TTL and the union rule are DaimondCore's — one deletion policy
	/// for chats, Diamonds, providers and mailboxes rather than four. A page
	/// without the core module cannot sync at all, so an empty map there is the
	/// truth rather than a fallback.
	function tombs() {
		return (window.DaimondCore && DaimondCore.tombs) ? DaimondCore.tombs(TOMBS) : {};
	}
	function tombstone(id) {
		if (window.DaimondCore && DaimondCore.tombstone) DaimondCore.tombstone(TOMBS, id);
	}
	function mergeTombs(incoming) {
		return (window.DaimondCore && DaimondCore.mergeTombs)
			? DaimondCore.mergeTombs(TOMBS, incoming) : tombs();
	}

	/// Forget every key. The lock does this: a locked Daimond holds no readable key.
	///
	/// This is the whole of forgetting the minted key — it was never anywhere else — and it also
	/// stands the credits row down, because a balance is nobody's business while the app is
	/// locked and a stale one is worse than none.
	function lock() {
		plain = {};
		slots = {};   // the workers' per-slot keys are memory-only too, and go with the rest.
		credits.state = '';
		credits.bal   = 0;
		credits.limit = 0;
		credits.why   = '';
		// `mintGen` is NOT reset: it only ever counts up, and a caller holding a key from before
		// the lock must still be told its key is old rather than matching a rewound counter.
		if (deps && deps.onChange) deps.onChange();
	}

	// ── Travelling in the sync parcel ───────────────────────────────
	// A user who has linked two devices has one account, and an account that knows about six
	// providers on one machine and none on the other is an account only by name. So the store
	// rides in the parcel beside the chats, the workspace and the Diamonds.
	//
	// WHAT TRAVELS, and why each thing was decided:
	//
	//   * `keyEnc`, always — and the plaintext `key`, NEVER. The sealed key is the whole reason
	//     this is safe to do: both devices derive the same wrapping key from the shared salt, so
	//     the ciphertext opens on both and the gateway in the middle can open neither. A
	//     plaintext key exists only on the browser-only path where there is no identity to seal
	//     under, and that path cannot sync at all (sync needs the identity for the parcel), so
	//     carrying it would be shipping a readable credential purely to satisfy a case that
	//     cannot arise.
	//   * The model list and its published rates, stamped with `fetched`. Two devices asked at
	//     different times, and the later answer is the better one.
	//   * The row's configuration — name, URL, sealed key — stamped with `touched`.
	//   * A MANUAL credit base (`baseUsd` + `baseAt`), which is the user telling the app what is
	//     on a key; that is a fact about the key, not about the device, and belongs on both.
	//   * NOT the PROBED balance (`remainingUsd`/`asOf`). It is left behind deliberately. It was
	//     true on the other machine at a moment, and a figure copied here would arrive already
	//     ageing, with the ledger that is supposed to count it down holding this device's spend
	//     rather than that one's. A balance nobody can stand behind is worse than none, which is
	//     the same rule `fetchCredit` follows when a probe fails. This device probes for itself.
	//   * NOT the `credits` row. Its key is minted per device and never stored; its URL and model
	//     list are whatever the gateway last minted against. A device that holds the account will
	//     mint its own on unlock, so carrying the row would only put a keyless one in front of
	//     somebody a second before their own arrives.
	//
	// DETERMINISM IS A REQUIREMENT, not a nicety. sync.js skips a push when the parcel
	// stringifies to what it last sent, so anything whose serialisation depends on enumeration
	// order makes the app push for ever. Provider ids are sorted, model lists are sorted, rate
	// tables are rebuilt with sorted keys, and every row is assembled in a fixed field order.

	/// A millisecond stamp, or 0 when there is none to be had.
	///
	/// NOT `n | 0`. A bitwise operator coerces to a 32-bit int, and an epoch-ms value is far
	/// past that: `1785419676021 | 0` is -1286719115. Every comparison in the merge below is
	/// against another stamp, so the truncation is not merely wrong, it is inconsistently wrong
	/// — a fresher stamp can truncate to a smaller number than an older one, and the freshest
	/// side then loses. This cost the models merge two of its own tests before it was found.
	function ms(v) {
		return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : 0;
	}

	/// One provider's published rates, rebuilt with sorted keys, or null when there are none.
	function sortedRates(rates) {
		if (!rates || typeof rates !== 'object') return null;
		var out = {}, n = 0;
		Object.keys(rates).sort().forEach(function (mid) {
			var r = rates[mid];
			if (!r || typeof r.in !== 'number' || typeof r.out !== 'number') return;
			var row = { in: r.in, out: r.out };
			if (typeof r.cached === 'number') row.cached = r.cached;
			if (typeof r.ctx    === 'number') row.ctx    = r.ctx;
			out[mid] = row;
			n++;
		});
		return n ? out : null;
	}

	/// The tombstone map, rebuilt with sorted keys for the same reason every other
	/// map here is: enumeration order must never reach the wire.
	function sortedTombs() {
		var t = tombs(), out = {};
		Object.keys(t).sort().forEach(function (id) { out[id] = ms(t[id]); });
		return out;
	}

	/// The store as it should travel: JSON-safe, deterministic, and holding no readable key.
	function exportSync() {
		var out = {
			v:     2,
			def:   { provider: store.def.provider || '', model: store.def.model || '' },
			defAt: ms(store.defAt),
			providers: {},
			// What was deleted here, so the other device deletes it too rather than
			// handing it back on the next pull.
			tombs: sortedTombs(),
		};
		Object.keys(store.providers).sort().forEach(function (id) {
			if (id === CREDITS) return;					// minted per device; see above
			var p = store.providers[id] || {};
			var row = {
				name:    String(p.name || ''),
				url:     String(p.url || ''),
				models:  (Array.isArray(p.models) ? p.models.slice() : []).sort(),
				fetched: ms(p.fetched),
				touched: ms(p.touched),
			};
			if (p.keyEnc) row.keyEnc = p.keyEnc;		// sealed only, and only when there is one
			var rates = sortedRates(p.rates);
			if (rates) row.rates = rates;
			if (p.credit && typeof p.credit.baseUsd === 'number' && typeof p.credit.baseAt === 'number') {
				row.credit = { baseUsd: p.credit.baseUsd, baseAt: p.credit.baseAt };
			}
			out.providers[id] = row;
		});
		return out;
	}

	/// Merge another device's store into this one.
	///
	/// A union, never a replacement: a provider only this device has is untouched, and a
	/// provider only the other device has arrives whole. Where both have one, the freshest side
	/// wins per FACT rather than per row — the later `touched` decides the configuration, the
	/// later `fetched` decides the model list — so a device that merely re-asked a provider for
	/// its catalogue does not thereby win an argument about the key.
	///
	/// A DELETION does travel, and it travels as a tombstone. An absence still means "that
	/// device never had it"; a tombstone means "it is gone", and the two are decided on the
	/// stamp — a provider whose `touched` is later than the tombstone is a deliberate re-add
	/// after the deletion and survives, one whose stamp is older is the deleted row coming
	/// round again and is dropped on both sides.
	///
	/// One thing is deliberately left alone: the in-memory plaintext cache is never
	/// overwritten — a device mid-turn goes on running with the key it holds, and an adopted
	/// key is read at the next unlock. A gap in the cache IS filled, since a key that arrives
	/// and cannot be used until a reload is a key the user will assume did not arrive.
	///
	/// A parcel with no `models` section (a v1 or early-v2 device) is a no-op, so an old device
	/// and a new one sync happily in both directions.
	async function applySync(remote) {
		if (!remote || typeof remote !== 'object' || !remote.providers
			|| typeof remote.providers !== 'object') return { added: 0, updated: 0 };
		var added = 0, updated = 0, adopt = [];
		// The tombstones first, unioned both ways: this device learns what the other
		// deleted, and keeps its own so the next push still carries them.
		var dead = mergeTombs(remote.tombs);
		Object.keys(dead).forEach(function (id) {
			if (id === CREDITS) return;					// not the user's to delete
			var p = store.providers[id];
			if (!p) return;
			if (ms(p.touched) > ms(dead[id])) return;	// re-added here since: the re-add wins
			delete store.providers[id];
			delete plain[id];
			if (store.def.provider === id) store.def = { provider: '', model: '' };
			updated++;
		});
		Object.keys(remote.providers).sort().forEach(function (id) {
			if (id === CREDITS) return;					// never carried, never adopted
			var r = remote.providers[id];
			if (!r || typeof r !== 'object') return;
			// A row the other device still holds but this one has buried: it comes
			// back only if it was re-added after the deletion.
			if (dead[id] && !(ms(r.touched) > ms(dead[id]))) return;
			var models  = (Array.isArray(r.models) ? r.models.slice() : []).sort();
			var rates   = sortedRates(r.rates);
			var fetched = ms(r.fetched);
			var stamp   = ms(r.touched);
			var mine    = store.providers[id];
			if (!mine) {
				mine = store.providers[id] = {
					name:    String(r.name || (KNOWN[id] && KNOWN[id].name) || 'Custom provider'),
					url:     String(r.url  || (KNOWN[id] && KNOWN[id].url)  || ''),
					key:     '',
					keyEnc:  r.keyEnc || '',
					models:  models,
					fetched: fetched,
					touched: stamp,
				};
				if (rates) mine.rates = rates;
				added++;
				if (mine.keyEnc) adopt.push(id);
			} else {
				if (stamp > ms(mine.touched)) {
					mine.name = String(r.name || mine.name || '');
					mine.url  = String(r.url  || mine.url  || '');
					// An empty `keyEnc` on the other side is not an instruction to forget this
					// device's key: it means that device never had one.
					if (r.keyEnc && r.keyEnc !== mine.keyEnc) {
						mine.keyEnc = r.keyEnc;
						mine.key    = '';
						adopt.push(id);
					}
					mine.touched = stamp;
					updated++;
				}
				if (fetched > ms(mine.fetched)) {
					mine.models  = models;
					if (rates) mine.rates = rates;
					mine.fetched = fetched;
					updated++;
				}
			}
			// The manual base carries its own stamp, so it is merged on that and on nothing
			// else: a user typing "$20 is on this key" on their laptop said something true
			// about the key, whichever device happens to have been configured more recently.
			if (r.credit && typeof r.credit.baseUsd === 'number' && typeof r.credit.baseAt === 'number') {
				var c = mine.credit || {};
				if (!(typeof c.baseAt === 'number') || r.credit.baseAt > c.baseAt) {
					mine.credit = {
						mode:         c.mode === 'auto' ? 'auto' : 'manual',
						remainingUsd: (typeof c.remainingUsd === 'number') ? c.remainingUsd : null,
						asOf:         (typeof c.asOf === 'number') ? c.asOf : null,
						baseUsd:      r.credit.baseUsd,
						baseAt:       r.credit.baseAt,
					};
					updated++;
				}
			}
		});
		// The default follows the freshest side — but only to a provider that exists here after
		// the merge. A default pointing at nothing is worse than an older default that works,
		// and the stamp is NOT advanced when the choice is refused, so the device that does hold
		// that provider can still win with it later.
		var rAt = ms(remote.defAt);
		if (rAt > ms(store.defAt) && remote.def && remote.def.provider
			&& store.providers[remote.def.provider]) {
			store.def   = { provider: remote.def.provider, model: remote.def.model || '' };
			store.defAt = rAt;
			updated++;
		}
		// Fill the gaps in the plaintext cache, never overwrite it.
		if (window.DaimondIdentity && DaimondIdentity.isUnlocked()) {
			for (var i = 0; i < adopt.length; i++) {
				var pid = adopt[i];
				if (plain[pid]) continue;				// this session's key stays this session's
				try { plain[pid] = await DaimondIdentity.unwrap(store.providers[pid].keyEnc); }
				catch (e) { /* sealed under something this device cannot open; leave it keyless */ }
			}
		}
		if (added || updated) {
			save();
			if (document.getElementById('models-list')) render();
		}
		return { added: added, updated: updated };
	}

	// ── The panel ───────────────────────────────────────────────────

	function esc(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}
	function html(s) {
		var d = document.createElement('div');
		d.innerHTML = s;
		return d.firstElementChild || d;
	}

	/// Whether an element is actually being shown. The panel stays mounted whether or not it is
	/// open, so its mere existence says nothing about whether anybody is looking at it.
	function onScreen(el) {
		return !!(el && (el.offsetParent || el.getClientRects().length));
	}

	var open = {};        // provider id -> is its model list expanded

	/// What a row says about its key, in the row's own terms.
	///
	/// A credits row is never "sealed" and never has a key the user could add, so the three
	/// words the other rows use are all wrong for it. It answers a different question anyway —
	/// not "is there a key" but "is there money" — so it answers that one, and the balance is
	/// the answer when there is one.
	function keyLabel(p) {
		if (!p.minted) {
			return p.sealed ? '🔒 ' + t('models.sealed')
				: p.hasKey ? '🔑 ' + t('models.key_set') : '⚠ ' + t('models.no_key');
		}
		switch (p.state) {
			case 'ready':     return '';                              // the balance says it better
			case 'minting':   return '✦ ' + t('models.connecting');
			case 'nocredits': return '⚠ ' + t('models.no_credits');
			case 'offline':   return '⚠ ' + t('models.offline');
			case 'failed':    return '⚠ ' + t('models.could_not_connect');
			default:          return '🔒 ' + t('models.unlock_to_use');
		}
	}

	/// The credit block inside an expanded provider: what is left, how that is known, and the
	/// one affordance for changing the answer.
	///
	/// Three states, and each says which it is. An automatic figure names the provider as its
	/// source and when it was asked. A manual figure is the user's own number counted down by
	/// the ledger's ESTIMATE of what has been spent since, and says so in those words — it is
	/// not a balance and must not read like one. Nothing known shows the invitation to say.
	function creditBlock(p) {
		var wrap = document.createElement('div');
		wrap.className = 'models-credit';
		wrap.dataset.prov = p.id;
		var c = p.credit;

		wrap.appendChild(html('<div class="models-credit-line"></div>'));
		wrap.appendChild(html('<div class="models-credit-age"></div>'));
		paintCredit(wrap);

		// Ask the provider, where it will answer.
		if (p.canProbeCredit) {
			var ask = document.createElement('button');
			ask.className = 'models-refetch';
			ask.textContent = t(c && c.mode === 'auto' ? 'models.credit_recheck' : 'models.credit_check');
			ask.addEventListener('click', async function () {
				ask.disabled = true;
				ask.textContent = t('models.asking');
				note('');                          // this ask answers for itself
				var got = null;
				try { got = await fetchCredit(p.id); } catch (e) { got = null; }
				if (!got) note(t('models.credit_probe_failed', { provider: p.name }));
				render();
			});
			wrap.appendChild(ask);
		}

		// And the user's own figure, always available: it is the only thing that works for a
		// provider that will not answer, and the thing to fall back on when a probe fails.
		// A div and a button rather than a form: nothing here needs submit semantics, and a
		// form inside a settings panel is one stray Enter away from navigating the page.
		var row = document.createElement('div');
		row.className = 'models-credit-form';
		var input = document.createElement('input');
		input.type = 'text';
		input.className = 'models-credit-input';
		input.inputMode = 'decimal';
		input.placeholder = t('models.credit_base_ph');
		input.setAttribute('aria-label', t('models.credit_base_label'));
		var set = document.createElement('button');
		set.type = 'button';
		set.className = 'models-refetch';
		set.textContent = t(c && c.mode === 'manual' ? 'models.credit_base_update' : 'models.credit_base_set');
		var commit = function () {
			var v = parseFloat(String(input.value || '').replace(/[^0-9.]/g, ''));
			// The refusal, said out loud. This used to be a bare early return: the field simply
			// did not take, with no message, and the user was left to guess what was wrong with
			// what they had typed. `note()` survives the `render()` below, so the success path
			// clears it rather than relying on the redraw to do it.
			if (!isFinite(v) || v < 0) { note(t('models.credit_base_bad')); return; }
			note('');
			setCreditBase(p.id, v);
			render();
		};
		set.addEventListener('click', commit);
		input.addEventListener('keydown', function (ev) {
			if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
		});
		row.appendChild(input);
		row.appendChild(set);
		wrap.appendChild(row);
		return wrap;
	}

	/// The sentence that says what is left and how it is known.
	///
	/// An automatic figure that has been walked down by this device's own spending is no longer
	/// the number the provider said, so it does not go on claiming to be: it names the probed
	/// figure, the moment it was read, and the spending applied since, in the same shape the
	/// manual sentence has always used.
	function creditSentence(c) {
		if (c && c.mode === 'auto') {
			if (c.spentUsd > 0) {
				return t('models.credit_auto_spent', {
					amount: usd(c.usd),
					base:   usd(c.probedUsd),
					spent:  usd(c.spentUsd),
					when:   whenShort(c.asOf),
				});
			}
			return t('models.credit_auto', { amount: usd(c.usd), when: whenShort(c.asOf) });
		}
		if (c && c.mode === 'manual') {
			return t('models.credit_manual', {
				amount: usd(c.usd),
				base:   usd(c.baseUsd),
				spent:  usd(c.spentUsd),
				when:   whenShort(c.baseAt),
			});
		}
		return t('models.credit_unknown');
	}

	/// How old the reading is, and whether the last attempt to renew it answered.
	///
	/// This is the line that makes a failed probe VISIBLE. A probe that fails writes nothing and
	/// keeps the old number, which is right — no balance beats a wrong one — but silence and
	/// freshness look identical on screen. An age that goes on climbing is the difference, and
	/// it is why the operator console stamps every reading it shows with the instant it was
	/// read. Empty when there is nothing that was read at a moment: a figure the user typed
	/// carries its own date in the sentence above.
	function ageSentence(id, c) {
		var out = [];
		if (c && c.mode === 'auto' && typeof c.asOf === 'number') out.push(agoWords(c.asOf));
		var st = probes[id];
		if (st && st.ok === false) out.push(t('models.age_failed'));
		return out.join(' ');
	}

	/// Whether the figure is old enough to be said so in the loud colour.
	function creditStale(id, c) {
		var st = probes[id];
		if (st && st.ok === false) return true;
		if (!c || c.mode !== 'auto' || typeof c.asOf !== 'number') return false;
		return (Date.now() - c.asOf) > CREDIT_STALE_MS;
	}

	/// How long ago, in the coarsest unit that still says something.
	///
	/// Rounded rather than truncated, and "just now" holds for a minute and a half: the point of
	/// this line is whether the number is minutes or hours old, and a reader who has to work out
	/// which from a timestamp is being asked to do the app's job.
	function agoWords(ts) {
		var secs = Math.max(0, Date.now() - ts) / 1000;
		if (secs < 90) return t('models.age_now');
		var mins = Math.round(secs / 60);
		if (mins < 60) return tn('models.age_mins', mins);
		var hrs = Math.round(mins / 60);
		if (hrs < 24) return tn('models.age_hours', hrs);
		return tn('models.age_days', Math.round(hrs / 24));
	}

	/// Write both sentences into a credit block that is already on screen.
	function paintCredit(wrap) {
		var id   = wrap.dataset.prov;
		var c    = creditFor(id);
		var line = wrap.querySelector('.models-credit-line');
		var age  = wrap.querySelector('.models-credit-age');
		if (line) line.textContent = creditSentence(c);
		if (!age) return;
		var words = ageSentence(id, c);
		age.textContent = words;
		age.style.display = words ? '' : 'none';
		age.classList.toggle('stale', creditStale(id, c));
	}

	/// Move every visible age on, and with it every figure the ledger has walked down.
	///
	/// The closed row's mark is refreshed with the open row's sentence, because the two say the
	/// same thing to different readers and a mark that only moved when the panel was redrawn
	/// would be a staleness warning that had itself gone stale.
	///
	/// Text and attributes only, never a `render()`: redrawing the panel would wipe whatever the
	/// user has half-typed into the "I have this much" field, and a clock is not a good enough
	/// reason to take somebody's typing away from them.
	function ageLines() {
		// Nothing is being read, so nothing needs moving on: the panel is redrawn from scratch
		// when it is next opened, which is sooner than anybody could notice.
		if (!onScreen(document.getElementById('models-list'))) return;
		var rows = document.querySelectorAll('.models-prov[data-prov]');
		for (var i = 0; i < rows.length; i++) {
			var id  = rows[i].dataset.prov;
			var blk = rows[i].querySelector('.models-credit');
			if (blk) paintCredit(blk);
			var bal = rows[i].querySelector('.models-bal');
			if (bal) paintBal(bal, id, creditFor(id));
		}
	}

	/// The figure and its age on the closed row, which is all a passer-by sees.
	///
	/// The AMOUNT is rewritten here too, not only the mark. It is drawn from the same
	/// `creditFor` as the sentence inside the row, so leaving it to the next `render()` put two
	/// different balances on screen at once — the head still saying what the provider said while
	/// the block below it had already counted the morning's turns off. The minted credits row is
	/// left alone: its balance is the gateway's, not a probe's, and it has no age to carry.
	function paintBal(bal, id, c) {
		if (id === CREDITS) return;
		if (c) bal.textContent = t('models.balance_left', { amount: usd(c.usd) });
		var words = ageSentence(id, c);
		if (words) bal.setAttribute('title', words); else bal.removeAttribute('title');
		if (words && creditStale(id, c)) bal.setAttribute('data-stale', '1');
		else bal.removeAttribute('data-stale');
	}

	/// A short local date and time for a figure that was true at a moment.
	function whenShort(ts) {
		try {
			var d = new Date(ts);
			return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
				+ ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
		} catch (e) { return ''; }
	}

	/// Draw the providers, each one expandable to the models it can run.
	///
	/// The default is a star ON the model, not a separate dropdown somewhere else: the thing a
	/// new chat starts on is a model belonging to a provider, and showing it anywhere other
	/// than beside that model invites the two to disagree.
	///
	/// The credits row is named for what the user bought — their credits — and not for the
	/// company that ends up running the request, because "OpenRouter" is not a thing they
	/// bought, chose or have an account with. That company is named anyway, quietly, beside it:
	/// a user is entitled to know whose machine their words land on, and burying it would be
	/// the sort of thing this app exists not to do.
	function render() {
		var el = document.getElementById('models-list');
		if (!el) return;
		// Opening this panel is the "I am looking at it now" moment, and the one moment a person
		// most expects the figure to be current. Only when the panel is actually on screen: this
		// same function redraws for a sync pull and a change of language, and neither is somebody
		// looking.
		//
		// The gate is doing two jobs here and the second is load-bearing. It stops the triggers
		// stacking, and it TERMINATES this: a probe that answers redraws the panel, and a redraw
		// asks again. Measured with the gate taken out, that loop reached four thousand requests
		// in the seconds it took to hide and show the tab five times.
		if (onScreen(el)) refreshCredits();
		el.innerHTML = '';

		var list = providers();
		if (!list.length) {
			el.appendChild(html('<div class="models-empty">' + esc(t('models.empty')) + '</div>'));
			return;
		}

		var d   = getDefault();
		var dup = dupes();
		list.forEach(function (p) {
			var row = document.createElement('div');
			row.className = 'models-prov' + (p.paid ? ' paid' : '');
			// Which key this row is about, so the age can be moved on later without redrawing
			// the panel out from under whatever the user is typing into it.
			row.dataset.prov = p.id;

			var head = document.createElement('button');
			head.className = 'models-prov-head';
			// The name, the balance and the host are three units, each kept whole: the rail is
			// narrow enough that all three will not fit on one line, and a line broken through
			// "$8.40 left" leaves a number on one row and its meaning on the next.
			head.innerHTML =
				  '<span class="models-caret">' + (open[p.id] ? '▾' : '▸') + '</span>'
				+ '<span class="models-prov-name">'
				+   '<span class="models-nm">' + esc(p.name) + '</span>'
				+   (p.balance ? '<span class="models-bal">'
						+ esc(t('models.balance_left', { amount: p.balance })) + '</span>' : '')
				+   (p.via ? '<span class="models-via">'
						+ esc(t('models.via', { provider: p.via })) + '</span>' : '')
				+ '</span>'
				+ '<span class="models-prov-key">' + esc(keyLabel(p)) + '</span>'
				+ '<span class="models-prov-count">' + esc(tn('models.count', p.count)) + '</span>';
			head.title = p.paid
				? t('models.row_paid_help', { provider: p.via || t('models.the_provider') })
				: t('models.row_own_help', { provider: p.name });
			head.addEventListener('click', function () { open[p.id] = !open[p.id]; render(); });
			// How old the figure on the head is, for somebody who has not opened the row. The
			// full account lives in the block below; this is the one fact that cannot wait for a
			// click, because a number with no age cannot tell you it has stopped moving.
			var bal = head.querySelector('.models-bal');
			if (bal) paintBal(bal, p.id, p.credit);
			row.appendChild(head);

			if (open[p.id]) {
				var body = document.createElement('div');
				body.className = 'models-prov-body';

				// The gateway says why in words meant for the user — an operator who has not
				// configured a management key gets "bring your own model key to keep working",
				// which is better advice than anything this file knows to give. So it is shown,
				// rather than flattened into the row's one-word state and thrown away.
				if (p.paid && p.why) body.appendChild(html('<div class="models-why">' + esc(p.why) + '</div>'));

				// Out of credits is not an error to read, it is a thing to do: the row says so, and
				// then offers the doing of it. Nothing else in the panel can be fixed with a button.
				if (p.paid && p.state === 'nocredits') {
					var top = document.createElement('button');
					top.className = 'models-refetch';
					top.textContent = t('models.top_up');
					top.addEventListener('click', function () { if (deps && deps.onTopUp) deps.onTopUp(); });
					body.appendChild(top);
				}

				// What is left on this key, and where that figure came from. A row that
				// shows a balance without saying how it knows is asking to be trusted
				// about money; a row that shows nothing when it cannot know is the same
				// promise kept the other way.
				if (!p.minted && p.hasKey && !p.sealed) body.appendChild(creditBlock(p));

				if (!p.count) {
					var refetch = document.createElement('button');
					refetch.className = 'models-refetch';
					refetch.textContent = p.hasKey ? t('models.ask_provider')
						: p.minted ? t('models.waiting_credits') : t('models.add_key_first');
					refetch.disabled = !p.ready;
					refetch.addEventListener('click', async function () {
						refetch.disabled = true;
						refetch.textContent = t('models.asking');
						note('');                  // this ask answers for itself
						// The provider's own words. A key that has been revoked, a base URL
						// with a typo in it and a rate limit all fail differently, and only
						// the provider knows which.
						try { await fetchModels(p.id); }
						catch (e) { note(e && e.message ? e.message : String(e)); }
						render();
					});
					body.appendChild(refetch);
				}

				p.models.forEach(function (m) {
					var isDef = d.provider === p.id && d.model === m;
					var twin  = !!dup[baseName(m)];
					var mr = document.createElement('button');
					mr.className = 'models-model' + (isDef ? ' on' : '');
					// A model on the credits row is marked wherever it appears, because it is the one
					// that moves money the user is holding here. A model with a twin on another row is
					// marked too, on both rows: two identical names doing different things to a
					// person's wallet is precisely the case a picker must not stay quiet about.
					mr.innerHTML = '<span class="models-star">' + (isDef ? '★' : '☆') + '</span>'
						+ '<span class="models-id">' + esc(m) + '</span>'
						+ (p.paid ? '<span class="models-econ paid">' + esc(t('models.econ_credits')) + '</span>'
							: twin ? '<span class="models-econ">' + esc(t('models.econ_own')) + '</span>' : '')
						+ (isDef ? '<span class="models-def">' + esc(t('models.is_default')) + '</span>' : '');
					mr.title = t(isDef ? 'models.model_is_default' : 'models.model_make_default') + '\n'
						+ (p.paid ? t('models.model_paid', { provider: p.via || t('models.the_provider') })
							: t('models.model_own', { provider: p.name }))
						+ (twin ? '\n' + t('models.model_twin', { provider: p.name }) : '');
					mr.addEventListener('click', function () { setDefault(p.id, m); render(); });
					// A model id is a string people paste -- into a config, into a support
					// message, into another provider's console -- and clicking the row here
					// picks a default rather than selecting the text. The copy sits OUTSIDE
					// the row, because the row is a button and a button cannot hold one.
					// Named by the id itself: a long catalogue of buttons all called "Copy
					// model id" tells a listener nothing about which model each one is.
					var cb = copyBtn(tOr('copy.what_model', 'model id {id}', { id: m }), m);
					if (cb) {
						var mrow = document.createElement('div');
						mrow.className = 'models-modelrow';
						mrow.appendChild(mr);
						mrow.appendChild(cb);
						body.appendChild(mrow);
					} else {
						body.appendChild(mr);
					}
				});

				// The credits row is not the user's to remove. It is their balance: taking it out of
				// the panel would neither refund it nor stop it existing, and the next mint would put
				// it straight back. Spending it to zero is the only thing that stands it down.
				if (!p.minted) {
					var rm = document.createElement('button');
					rm.className = 'models-remove';
					rm.textContent = t('models.remove', { provider: p.name });
					rm.addEventListener('click', function () {
						removeProvider(p.id);
						render();
					});
					body.appendChild(rm);
				}
				row.appendChild(body);
			}
			el.appendChild(row);
		});

		var foot = document.createElement('div');
		foot.className = 'models-default';
		foot.textContent = d.provider && d.model
			? t('models.starts_on', { model: providerName(d.provider) + ' · ' + d.model })
			: t('models.no_default');
		// The one model id worth copying without opening a provider first. It copies
		// the BARE id, not the sentence around it: the sentence names the provider
		// for a reader, and nothing takes it as input.
		if (d.provider && d.model) {
			var fc = copyBtn(tOr('copy.what_default_model', 'the default model id'), d.model);
			if (fc) foot.appendChild(fc);
		}
		el.appendChild(foot);
	}

	/// The panel's one message line.
	///
	/// THE TRAP: this lookup was the ONLY line in the whole tree that mentioned `models-note`. No
	/// markup, no JS that built one, not even a CSS rule -- so it returned null every time and
	/// `if (n)` read like a correct guard. A user could type `abc` into the credit field, press
	/// Set, and get an early return with nothing on screen at all. An element that does not exist
	/// reports itself to a browser automation locator as HIDDEN, which is indistinguishable from a
	/// guard doing its job, so no check that asserted "no error is shown" would have caught it.
	/// Every check over this line asserts the element EXISTS and says what it holds.
	///
	/// The element lives in `index.html` beside `#models-list` and NOT inside it, because
	/// `render()` rewrites that list wholesale: a message written just before a redraw would go
	/// with it. The price of that is that it does not expire by itself -- each action that can
	/// produce a message clears it first, rather than `render()` clearing it, so that a background
	/// redraw (a sync pull, a change of language) cannot take a refusal off the screen unasked.
	function note(msg) {
		var n = document.getElementById('models-note');
		if (!n) return;
		n.textContent = msg || '';
	}

	// ── The picker ──────────────────────────────────────────────────

	/// Fill a `<select>` with every model, grouped under the provider that runs it.
	///
	/// The provider is carried on the option (`dataset.provider`) rather than baked into the
	/// value: two providers can serve a model of the same name -- llama-3.3-70b is on four of
	/// them -- so a value alone does not say which key to use. `pick()` reads both back.
	///
	/// A provider whose key cannot be read is shown, and its models are disabled. Hiding it would
	/// leave a user who has locked the app wondering where their models went; saying "sealed"
	/// tells them the answer is to unlock.
	///
	/// Two economies share this list, and that is the thing it has to get right. Most rows spend
	/// money the user holds with somebody else; the credits row spends money they handed to
	/// Daimond, and drawing that down is a surprise if it happens to someone who was only
	/// curious what Claude would say. So the group says which it is and the option says it
	/// again — the group heading is gone the moment the pulldown is closed, and by then the
	/// choice is made.
	// ── Favourites ──────────────────────────────────────────────
	//
	// A working setup reaches a dozen models across four providers, and the two or
	// three a person actually works with are scattered through the list in provider
	// order. The pulldown is a native `<select>`, so finding one means scrolling a
	// list whose order is about where a model is BILLED rather than about how often
	// it is wanted.
	//
	// So the most-used float to the top, in a group of their own. Nothing is starred
	// by hand: what a person uses is already the answer, and a second kind of star
	// beside the default's would make both mean less.
	//
	// USE, not selection. A model chosen in a pulldown and never run is not a model
	// anybody uses, so the count is incremented where a turn actually commits to
	// one — a chat freezing its model, a Diamond's daimon, a dispatched worker.
	//
	// NOT carried in the sync parcel, deliberately. Merging two devices' counters is
	// either wrong (summing double-counts on every round trip) or pointless (taking
	// the larger throws one device's history away), and the list earns itself again
	// on a new device within a few turns. If it ever travels, it should travel as
	// the ordered KEYS with one stamp, not as the counters.

	var USE_KEY = 'daimond-model-use';	// per account; accounts.js namespaces daimond-*

	/// How many float to the top. Five is about a screen's worth on a phone, and
	/// small enough that the group stays a shortlist and not a second copy of the list.
	var FAV_MAX = 5;
	/// Below this there is nothing to scroll, so the group would be clutter.
	var FAV_MIN_MODELS = 8;
	/// And a shortlist of one is not a shortlist.
	var FAV_MIN = 2;
	/// The most entries kept; beyond it the least recently used are dropped, so a
	/// long-lived account cannot grow this without bound.
	var USE_MAX = 60;

	function useKey(provider, model) { return (provider || '') + ' ' + (model || ''); }

	function readUse() {
		try {
			var o = JSON.parse(localStorage.getItem(USE_KEY) || 'null');
			return (o && typeof o === 'object') ? o : {};
		} catch (e) { return {}; }
	}

	/// Record that a turn is about to run on this model.
	function noteUse(provider, model) {
		if (!model) return;
		var use = readUse();
		var k = useKey(provider, model);
		var e = use[k] || { n: 0, t: 0 };
		use[k] = { n: (e.n || 0) + 1, t: Date.now() };
		var keys = Object.keys(use);
		if (keys.length > USE_MAX) {
			keys.sort(function (a, b) { return (use[a].t || 0) - (use[b].t || 0); });
			for (var i = 0; i < keys.length - USE_MAX; i++) delete use[keys[i]];
		}
		try { localStorage.setItem(USE_KEY, JSON.stringify(use)); } catch (e2) { /* quota */ }
	}

	/// The favourites, most used first, filtered to models that still exist on a
	/// provider that is still listed — a model whose provider was removed must not
	/// go on being offered from the top.
	function favourites(list) {
		var use = readUse();
		var live = {};
		list.forEach(function (p) {
			p.models.forEach(function (m) { live[useKey(p.id, m)] = { p: p, m: m }; });
		});
		return Object.keys(use)
			.filter(function (k) { return live[k]; })
			.sort(function (a, b) {
				var d = (use[b].n || 0) - (use[a].n || 0);
				return d !== 0 ? d : (use[b].t || 0) - (use[a].t || 0);
			})
			.slice(0, FAV_MAX)
			.map(function (k) { return { provider: live[k].p, model: live[k].m }; });
	}

	function fillSelect(sel, provider, model) {
		sel.innerHTML = '';
		var list = providers().filter(function (p) { return p.count > 0; });

		if (!list.length) {
			var o = document.createElement('option');
			o.value = '';
			o.textContent = t('models.none_yet');
			sel.appendChild(o);
			sel.disabled = true;
			return;
		}
		sel.disabled = false;

		var d   = getDefault();
		var dup = dupes();

		/// One option, wherever it is drawn. The favourites group holds a SECOND
		/// element for the same model, and the two must carry the same meaning — a
		/// shortcut that read differently from the row it stands for would be worse
		/// than no shortcut, because the economy marking is the part that matters.
		///
		/// `inFav` adds the provider's name, and that is not an inconsistency but
		/// the opposite. A row's full meaning includes the group heading above it;
		/// under "Favourites" that heading is gone, so reproducing only the row's
		/// own text would LOSE information — and two providers offering the same
		/// model under the user's own key would then draw two identical shortcuts.
		function optionFor(p, m, inFav) {
			var twin = !!dup[baseName(m)];
			var o = document.createElement('option');
			o.value = m;
			o.dataset.provider = p.id;
			o.dataset.paid     = p.paid ? '1' : '';
			o.textContent = m
				+ (p.paid ? ' · ' + t('models.econ_credits') : twin ? ' · ' + t('models.econ_own') : '')
				+ (inFav ? ' · ' + p.name : '')
				+ (d.provider === p.id && d.model === m ? '  ★' : '');
			o.title = p.name + ' · ' + m + ' — '
				+ (p.paid ? t('models.model_paid', { provider: p.via || t('models.the_provider') })
					: t('models.model_own', { provider: p.name }));
			o.disabled = !p.ready;
			return o;
		}

		// The shortlist first, when there is a list worth shortening. Every model
		// here appears again under its own provider: this is a shortcut to a row,
		// not a category of its own, and somebody looking for a model by who bills
		// for it must still find it where they expect.
		var total = list.reduce(function (n, p) { return n + p.models.length; }, 0);
		var favs  = total >= FAV_MIN_MODELS ? favourites(list) : [];
		if (favs.length >= FAV_MIN) {
			var fg = document.createElement('optgroup');
			fg.label = t('models.favourites');
			favs.forEach(function (f) {
				var o = optionFor(f.provider, f.model, true);
				o.dataset.fav = '1';
				fg.appendChild(o);
			});
			sel.appendChild(fg);
		}

		list.forEach(function (p) {
			var g = document.createElement('optgroup');
			// Only the credits group is relabelled. A row that spends the user's own provider
			// account is the case this picker has always described, and describing it twice —
			// once here and once on every option — would make the marking mean less, not more:
			// the mark has to be the exception to read as one.
			g.label = p.paid
				? p.name
					+ (p.balance ? ' · ' + t('models.balance_left', { amount: p.balance }) : '')
					+ (p.via ? ' — ' + t('models.via', { provider: p.via }) : '')
					+ (p.ready ? '' : ' (' + t(p.state === 'nocredits'
						? 'models.top_up_to_use' : 'models.connecting') + ')')
				: p.name + (p.sealed ? ' (' + t('models.sealed_unlock') + ')'
					: p.hasKey ? '' : ' (' + t('models.no_key') + ')');
			p.models.forEach(function (m) { g.appendChild(optionFor(p, m)); });
			sel.appendChild(g);
		});

		// Select what was asked for; failing that, the starred default; failing that, the first
		// model anything can actually run.
		if (!select(sel, provider, model) && !select(sel, d.provider, d.model)) {
			var firstUsable = sel.querySelector('option:not([disabled])');
			if (firstUsable) firstUsable.selected = true;
		}
	}

	/// Select the option for one provider's model. True when it was there to select.
	function select(sel, provider, model) {
		if (!model) return false;
		var opts = sel.querySelectorAll('option');
		for (var i = 0; i < opts.length; i++) {
			if (opts[i].value === model && (!provider || opts[i].dataset.provider === provider)) {
				opts[i].selected = true;
				return true;
			}
		}
		return false;
	}

	/// What a `<select>` filled by `fillSelect` is currently pointing at.
	function pick(sel) {
		var o = sel && sel.selectedOptions && sel.selectedOptions[0];
		if (!o || !o.value) return { provider: '', model: '' };
		return { provider: o.dataset.provider || '', model: o.value };
	}

	function init(d) {
		deps = d || {};
		load();
	}

	// The panel stays mounted, so a language change redraws it where it stands.
	if (window.DaimondI18n) {
		DaimondI18n.onChange(function () {
			if (document.getElementById('models-list')) render();
		});
	}

	// ── The tab coming back, and the beat while it is here ──────────
	// The author's own case: money added to the provider's account on another screen, this tab
	// left alone for hours, and the old figure still on it when he came back. Nothing in the
	// browser can be told about a top-up, so the moment the tab is looked at again is the moment
	// to ask. The beat covers the other half of it — a tab that is looked at all day and never
	// hidden — and it beats only while the tab is in front.

	/// The heartbeat, or null while nothing is watching.
	var beat = null;

	function beatOn() {
		if (beat || typeof setInterval !== 'function') return;
		beat = setInterval(function () {
			refreshCredits();		// the gate decides whether this becomes a request
			ageLines();				// the age moves on whether it did or not
		}, PROBE_BEAT_MS);
	}

	function beatOff() {
		if (beat) { clearInterval(beat); beat = null; }
	}

	if (typeof document !== 'undefined' && document.addEventListener) {
		document.addEventListener('visibilitychange', function () {
			if (document.visibilityState === 'hidden') { beatOff(); return; }
			beatOn();
			// Back in front after who knows how long. The gate is what stops a user who flicks
			// between two tabs from spending a probe on every flick.
			refreshCredits();
			ageLines();
		});
		if (document.visibilityState !== 'hidden') beatOn();
	}

	// A turn has just finished, so the ledger has just gained what it cost. Repaint, and NOTHING
	// else: the figure moves from books this device already keeps, with no request and no floor
	// to spend, which is the whole reason spending is treated differently from a top-up. The
	// event already exists and already carries this meaning — daimond.js fires it from the one
	// place every exit from a turn passes through, and the Daimond balance in daimond.js has
	// hung off it for the same reason since before this did.
	if (typeof window !== 'undefined' && window.addEventListener) {
		window.addEventListener('daimond:idle', function () { ageLines(); });
	}

	window.DaimondModels = {
		render:         render,
		noteUse:        noteUse,
		favourites:     favourites,
		fillSelect:     fillSelect,
		pick:           pick,
		init:           init,
		unseal:         unseal,
		/// Re-wrap every key after a passphrase change. The keys never leave this module.
		resealAfterRekey: resealAfterRekey,
		lock:           lock,
		known:          function () { return KNOWN; },
		// Which wire dialect an endpoint speaks, and the headers it wants. Exported because
		// the settings form in daimond.js lists a provider's models with its own fetch, and a
		// bearer token is refused by the one provider that is not OpenAI-compatible.
		isAnthropic:    isAnthropic,
		authHeaders:    authHeaders,
		modelsUrl:      modelsUrl,
		providers:      providers,
		addProvider:    addProvider,
		removeProvider: removeProvider,
		setKey:         setKey,
		keyFor:         keyFor,
		hasKey:         hasKey,
		isSealed:       isSealed,
		fetchModels:    fetchModels,
		// The live rates a provider published, which `DaimondPricing` asks before its table.
		rateFor:        rateFor,
		// What is left on a provider's key: asked for where it can be, told to us otherwise.
		fetchCredit:    fetchCredit,
		// When each key was last asked, and how that went. A snapshot, so nothing outside this
		// file can move the floor the probes are held behind.
		creditProbes:   function () { return JSON.parse(JSON.stringify(probes)); },
		setCreditBase:  setCreditBase,
		creditFor:      creditFor,
		all:            all,
		count:          count,
		getDefault:     getDefault,
		setDefault:     setDefault,
		resolve:        resolve,
		ready:          ready,
		providerName:   providerName,
		// The store as it travels between devices, and the merge on arrival.
		exportSync:     exportSync,
		applySync:      applySync,
		// Credits: the provider Daimond mints the key for.
		CREDITS:        CREDITS,
		syncCredits:    syncCredits,
		remint:         remint,
		creditsGen:     creditsGen,
		creditsState:   creditsState,
		// Per-slot worker keys, so parallel workers never share one.
		mintSlot:       mintSlot,
		remintSlot:     remintSlot,
		slotConfig:     slotConfig,
		forgetSlot:     forgetSlot,
	};
})();
