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
 *     def: { provider, model },              the default a new chat or Focus starts with
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
 * One provider is not like the others. `credits` is the models a Daimond balance buys, and
 * its key is MINTED by the gateway rather than typed by the user — see `mint()`. Everything
 * else about it is ordinary: it is a row in the same store, its models come from the same
 * `fetchModels`, and the browser calls it directly with no relay in the middle. That last
 * part is the whole product, and it is why credits could not simply be proxied.
 */
(function () {
	'use strict';

	var KEY     = 'daimond-models-v2';
	var OLD_KEY = 'daimond-byok';           // the single-provider config this replaces
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
	var KNOWN = {
		credits:    { name: 'Daimond credits', url: '',                                                    model: '' },
		fireworks:  { name: 'Fireworks AI', url: 'https://api.fireworks.ai/inference/v1/chat/completions', model: 'accounts/fireworks/models/glm-5p2' },
		openrouter: { name: 'OpenRouter',   url: 'https://openrouter.ai/api/v1/chat/completions',          model: '' },
		together:   { name: 'Together AI',  url: 'https://api.together.xyz/v1/chat/completions',           model: '' },
		groq:       { name: 'Groq',         url: 'https://api.groq.com/openai/v1/chat/completions',        model: '' },
		deepinfra:  { name: 'DeepInfra',    url: 'https://api.deepinfra.com/v1/openai/chat/completions',   model: '' },
	};

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

	/// Which known provider a base URL belongs to, or '' when it is nobody's.
	function idForUrl(url) {
		for (var id in KNOWN) { if (KNOWN[id].url === url) return id; }
		return '';
	}

	function providerUrl(id) {
		var p = store.providers[id];
		return (p && p.url) || (KNOWN[id] && KNOWN[id].url) || '';
	}
	function providerName(id) {
		var p = store.providers[id];
		return (p && p.name) || (KNOWN[id] && KNOWN[id].name) || id;
	}

	/// Derive the model-listing endpoint from a chat-completions one.
	function modelsUrl(base) {
		if (base.indexOf('/chat/completions') !== -1) return base.replace('/chat/completions', '/models');
		return base.replace(/\/+$/, '') + '/models';
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
	}

	/// Store a key for a provider, sealed under the passphrase where there is one.
	async function setKey(id, key) {
		var p = store.providers[id];
		if (!p) return;
		plain[id] = key;
		p.key = '';
		p.keyEnc = '';
		if (window.DaimondIdentity && DaimondIdentity.isUnlocked()) {
			try { p.keyEnc = await DaimondIdentity.wrap(key); }
			catch (e) { p.key = key; }             // no identity to seal under: the old trade
		} else {
			p.key = key;
		}
		save();
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
		if (id && KNOWN[id]) return KNOWN[id].name;
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
	async function mintRequest(slot) {
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
		if (!r.ok || !j || j.ok === false) {
			var err = new Error((j && (j.error || j.message)) || ('The account service refused (HTTP ' + r.status + ').'));
			// An empty account is not a fault, it is a thing to do, and the row offers the doing
			// of it rather than reporting an error at somebody who has done nothing wrong. `402
			// Payment Required` is the gateway saying exactly that; the balance is checked too,
			// so this holds whichever way it chooses to say it.
			err.noCredits = r.status === 402 || !!(j && j.credits_minor === 0);
			throw err;
		}
		if (!j.key || !j.url) throw new Error('The account service sent a key Daimond cannot use.');
		return j;
	}

	async function mint() {
		var j           = await mintRequest(0);
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
	async function remint(gen) {
		if (typeof gen === 'number' && gen < mintGen && plain[CREDITS]) return plain[CREDITS];
		if (minting) return await minting;
		minting = (async function () {
			delete plain[CREDITS];
			credits.state = 'minting';
			try {
				await mint();
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
	async function mintSlot(slot) {
		var j = await mintRequest(slot);
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
	async function remintSlot(slot, gen) {
		var s = slots[slot];
		if (s && typeof gen === 'number' && gen < s.gen && s.key) return s;
		return await mintSlot(slot);
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

	/// Ask a provider what it can run. The list is cached, because a chat's model can be
	/// switched from its header and re-asking on every switch would be rude to the provider
	/// and slow for the user.
	async function fetchModels(id) {
		var url = providerUrl(id);
		var key = keyFor(id);
		if (!url || !key) throw new Error('That provider has no key yet.');
		var r = await fetch(modelsUrl(url), { headers: { authorization: 'Bearer ' + key } });
		if (!r.ok) throw new Error('The provider refused the key (HTTP ' + r.status + ').');
		var j = await r.json();
		var ids = (j.data || j.models || [])
			.map(function (m) { return typeof m === 'string' ? m : (m.id || m.name); })
			.filter(Boolean)
			.sort();
		store.providers[id].models  = ids;
		store.providers[id].fetched = Date.now();
		save();
		return ids;
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
				balance: mine && credits.state === 'ready' ? money(credits.bal, credits.cur) : '',
				state:   mine ? credits.state : '',
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
		};
		save();
	}

	function removeProvider(id) {
		delete store.providers[id];
		delete plain[id];
		if (store.def.provider === id) store.def = { provider: '', model: '' };
		save();
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

	var open = {};        // provider id -> is its model list expanded

	/// What a row says about its key, in the row's own terms.
	///
	/// A credits row is never "sealed" and never has a key the user could add, so the three
	/// words the other rows use are all wrong for it. It answers a different question anyway —
	/// not "is there a key" but "is there money" — so it answers that one, and the balance is
	/// the answer when there is one.
	function keyLabel(p) {
		if (!p.minted) return p.sealed ? '🔒 sealed' : p.hasKey ? '🔑 key set' : '⚠ no key';
		switch (p.state) {
			case 'ready':     return '';                              // the balance says it better
			case 'minting':   return '✦ connecting…';
			case 'nocredits': return '⚠ no credits';
			case 'offline':   return '⚠ account service unreachable';
			case 'failed':    return '⚠ could not connect';
			default:          return '🔒 unlock to use';
		}
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
		el.innerHTML = '';

		var list = providers();
		if (!list.length) {
			el.appendChild(html('<div class="models-empty">No provider yet. Add one to give Daimond a model to think with.</div>'));
			return;
		}

		var d   = getDefault();
		var dup = dupes();
		list.forEach(function (p) {
			var row = document.createElement('div');
			row.className = 'models-prov' + (p.paid ? ' paid' : '');

			var head = document.createElement('button');
			head.className = 'models-prov-head';
			// The name, the balance and the host are three units, each kept whole: the rail is
			// narrow enough that all three will not fit on one line, and a line broken through
			// "$8.40 left" leaves a number on one row and its meaning on the next.
			head.innerHTML =
				  '<span class="models-caret">' + (open[p.id] ? '▾' : '▸') + '</span>'
				+ '<span class="models-prov-name">'
				+   '<span class="models-nm">' + esc(p.name) + '</span>'
				+   (p.balance ? '<span class="models-bal">' + esc(p.balance) + ' left</span>' : '')
				+   (p.via ? '<span class="models-via">via ' + esc(p.via) + '</span>' : '')
				+ '</span>'
				+ '<span class="models-prov-key">' + esc(keyLabel(p)) + '</span>'
				+ '<span class="models-prov-count">' + p.count + (p.count === 1 ? ' model' : ' models') + '</span>';
			head.title = p.paid
				? 'These models spend your Daimond balance. Your browser calls ' + (p.via || 'the provider')
					+ ' directly — the key is minted for you, and nothing goes through Daimond.'
				: 'These models are billed to your own ' + p.name + ' account. They do not touch your Daimond balance.';
			head.addEventListener('click', function () { open[p.id] = !open[p.id]; render(); });
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
					top.textContent = 'Top up your credits →';
					top.addEventListener('click', function () { if (deps && deps.onTopUp) deps.onTopUp(); });
					body.appendChild(top);
				}

				if (!p.count) {
					var refetch = document.createElement('button');
					refetch.className = 'models-refetch';
					refetch.textContent = p.hasKey ? 'Ask this provider what it can run'
						: p.minted ? 'Waiting for your credits…' : 'Add a key first';
					refetch.disabled = !p.ready;
					refetch.addEventListener('click', async function () {
						refetch.disabled = true;
						refetch.textContent = 'Asking…';
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
						+ (p.paid ? '<span class="models-econ paid">credits</span>'
							: twin ? '<span class="models-econ">your key</span>' : '')
						+ (isDef ? '<span class="models-def">default</span>' : '');
					mr.title = (isDef ? 'New chats and Foci start on this model.\n'
						: 'Make this the model new chats and Foci start on.\n')
						+ (p.paid ? 'Spends your Daimond balance, via ' + (p.via || 'the provider') + '.'
							: 'Billed to your own ' + p.name + ' account.')
						+ (twin ? '\nAnother provider serves a model of this name — this is the ' + p.name + ' one.' : '');
					mr.addEventListener('click', function () { setDefault(p.id, m); render(); });
					body.appendChild(mr);
				});

				// The credits row is not the user's to remove. It is their balance: taking it out of
				// the panel would neither refund it nor stop it existing, and the next mint would put
				// it straight back. Spending it to zero is the only thing that stands it down.
				if (!p.minted) {
					var rm = document.createElement('button');
					rm.className = 'models-remove';
					rm.textContent = 'Remove ' + p.name;
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
			? 'New chats start on: ' + providerName(d.provider) + ' · ' + d.model
			: 'No default model yet — star one above.';
		el.appendChild(foot);
	}

	function note(msg) {
		var n = document.getElementById('models-note');
		if (n) n.textContent = msg || '';
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
	function fillSelect(sel, provider, model) {
		sel.innerHTML = '';
		var list = providers().filter(function (p) { return p.count > 0; });

		if (!list.length) {
			var o = document.createElement('option');
			o.value = '';
			o.textContent = 'No models yet — add a provider key in Models';
			sel.appendChild(o);
			sel.disabled = true;
			return;
		}
		sel.disabled = false;

		var d   = getDefault();
		var dup = dupes();
		list.forEach(function (p) {
			var g = document.createElement('optgroup');
			// Only the credits group is relabelled. A row that spends the user's own provider
			// account is the case this picker has always described, and describing it twice —
			// once here and once on every option — would make the marking mean less, not more:
			// the mark has to be the exception to read as one.
			g.label = p.paid
				? p.name
					+ (p.balance ? ' · ' + p.balance + ' left' : '')
					+ (p.via ? ' — via ' + p.via : '')
					+ (p.ready ? '' : p.state === 'nocredits' ? ' (top up to use)' : ' (connecting…)')
				: p.name + (p.sealed ? ' (sealed — unlock to use)' : p.hasKey ? '' : ' (no key)');
			p.models.forEach(function (m) {
				var twin = !!dup[baseName(m)];
				var o = document.createElement('option');
				o.value = m;
				o.dataset.provider = p.id;
				o.dataset.paid     = p.paid ? '1' : '';
				o.textContent = m
					+ (p.paid ? ' · credits' : twin ? ' · your key' : '')
					+ (d.provider === p.id && d.model === m ? '  ★' : '');
				o.title = p.paid
					? p.name + ' · ' + m + ' — spends your Daimond balance, via ' + (p.via || 'the provider') + '.'
					: p.name + ' · ' + m + ' — billed to your own ' + p.name + ' account.';
				o.disabled = !p.ready;
				g.appendChild(o);
			});
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

	window.DaimondModels = {
		render:         render,
		fillSelect:     fillSelect,
		pick:           pick,
		init:           init,
		unseal:         unseal,
		lock:           lock,
		known:          function () { return KNOWN; },
		providers:      providers,
		addProvider:    addProvider,
		removeProvider: removeProvider,
		setKey:         setKey,
		keyFor:         keyFor,
		hasKey:         hasKey,
		isSealed:       isSealed,
		fetchModels:    fetchModels,
		all:            all,
		count:          count,
		getDefault:     getDefault,
		setDefault:     setDefault,
		resolve:        resolve,
		ready:          ready,
		providerName:   providerName,
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
