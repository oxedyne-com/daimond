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
		// The node BY NAME -- the Diamond's or the chat's, from the tree -- and never the
		// id, which tells a person nothing (R2 QA, F0b). `pauseNode` keeps the id.
		var name = node;
		try { if (window.DaimondPause) name = DaimondPause.label(node) || node; }
		catch (e) { name = node; }
		var s = t('pause.refused.turn', { node: name });
		if (s === 'pause.refused.turn') {
			// A byte-for-byte copy of the catalogue entry, `{node}` filled in here.
			// Assembling a second wording is how this drifted from `en.js` unnoticed.
			s = ('{node} is paused. No turn started, nothing spent. '
				+ 'Press play on it to resume.').replace(/\{node\}/g, name);
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
	// The stamped choices, each one register merged on its own stamp `<slot>At` (SIM-18):
	// the default, then the global Jobs picks. A Jobs pick unset means "as the daimon".
	var CHOICES  = ['def', 'draft', 'workers', 'images'];
	var JOB_SLOT = { drafting: 'draft', workers: 'workers', images: 'images' };

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
		var raw = window.DaimondStore.get(KEY, null);
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
		// A cold iOS/WebKit tab can read BOTH keys empty before the storage area has
		// finished loading (the timing family behind identity.js existsSettled), and
		// persisting the fresh empty store here would BLANK the real one on disk before
		// `loadSettled` could re-read it. So an empty migration is left in memory only:
		// `save()` is deferred to the first real change, which is exactly the pre-migration
		// state, and a cold read is recovered by re-reading rather than overwritten.
		if (!old || !old.baseUrl) { return; }

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

	/// Store the store: what the disk holds now (a sibling tab's save) is merged in
	/// first, by the store's law, and the result written. True when it landed; one the
	/// box refuses is held owed by `DaimondStore`, merged over the disk by the same law
	/// on every retry, and said on screen (SIM-11).
	function save() {
		takeDisk();
		noteRunnable();
		var landed = window.DaimondStore.put(KEY, store, storeLaw);
		if (deps && deps.onChange) deps.onChange();
		return landed;
	}

	// ── Two tabs, one store ─────────────────────────────────────────
	// Every tab of a device holds the whole store in memory, and a write in one tab
	// reaches the others as a `storage` event. Replacing this tab's copy with the
	// disk's lost whichever change this tab was making across an await (a key being
	// sealed, a parcel's key being opened): the mutator went on writing to the object
	// that had been swapped out, and its save wrote the sibling's copy back (r52d QA
	// F1). So the disk's copy is MERGED into this one, in place, fact by fact on the
	// same stamps the parcel merge decides on, and every save reads, merges and
	// writes. Two tabs' saves then converge whatever order they land in, and a
	// mutator that re-reads its row after an await sees the other tab's change.
	//
	// The law, per provider row, each fact on its own stamp:
	//   - the configuration (name, URL, key, sealed key) on `touched`, the later one
	//     whole, and its credit record with it: a probed balance or a base is about
	//     the key the row held when it was taken;
	//   - the catalogue (models and rates) on `fetched`;
	//   - each model's routing text on its own `routedAt`;
	//   - at an equal configuration, the credit base on `baseAt` and the probed
	//     figure on `asOf`.
	// A row the provider tombstones name is gone from both sides unless it was
	// re-added since, exactly as `applySync` rules. The default and the drafting
	// model are one stamped choice each; `lastRun` keeps the later runnable choice.

	/// A deep copy, for a record taken from the other side.
	function copy(v) { return (v === undefined) ? undefined : JSON.parse(JSON.stringify(v)); }

	/// The facts `touched` decides, as the tie between two equal stamps compares them.
	function localConfig(p) {
		return { name: String(p.name || ''), url: String(p.url || ''),
			key: String(p.key || ''), keyEnc: String(p.keyEnc || '') };
	}

	/// Merge the credit records of two rows that hold one configuration: the base on
	/// its own stamp, the probed figure on when it was asked.
	function mergeCredit(mine, r) {
		if (!r) return mine;
		if (!mine) return copy(r);
		var out = copy(mine);
		if (DaimondStamp.beats(r.baseAt, r.baseUsd == null ? null : r.baseUsd,
				mine.baseAt, mine.baseUsd == null ? null : mine.baseUsd)) {
			out.baseUsd = r.baseUsd;
			out.baseAt  = r.baseAt;
		}
		if (DaimondStamp.beats(r.asOf, [r.mode || '', r.remainingUsd == null ? null : r.remainingUsd],
				mine.asOf, [mine.mode || '', mine.remainingUsd == null ? null : mine.remainingUsd])) {
			out.mode         = r.mode;
			out.remainingUsd = r.remainingUsd;
			out.asOf         = r.asOf;
			if (r.binds) out.binds = r.binds; else delete out.binds;
		}
		return out;
	}

	/// Merge one provider row `r` into `mine`, in place. Does the key change?
	function mergeRow(mine, r) {
		var keyWas = mine.keyEnc + '\n' + mine.key;
		var cm = localConfig(mine), cr = localConfig(r);
		if (DaimondStamp.beats(r.touched, cr, mine.touched, cm)) {
			mine.name = cr.name; mine.url = cr.url; mine.key = cr.key; mine.keyEnc = cr.keyEnc;
			mine.touched = r.touched;
			if (r.credit) mine.credit = copy(r.credit); else delete mine.credit;
		} else if (ms(r.touched) === ms(mine.touched) && DaimondStamp.canon(cr) === DaimondStamp.canon(cm)) {
			var c = mergeCredit(mine.credit, r.credit);
			if (c) mine.credit = c;
		}
		var mModels = (Array.isArray(mine.models) ? mine.models.slice() : []).sort();
		var rModels = (Array.isArray(r.models) ? r.models.slice() : []).sort();
		if (DaimondStamp.beats(r.fetched, [rModels, sortedRates(r.rates) || null],
				mine.fetched, [mModels, sortedRates(mine.rates) || null])) {
			mine.models  = rModels;
			if (r.rates) mine.rates = copy(r.rates); else delete mine.rates;
			mine.fetched = r.fetched;
		}
		var rr = r.routing || {}, ra = r.routedAt || {};
		Object.keys(rr).concat(Object.keys(ra)).forEach(function (m) {
			var mr = mine.routing || {}, ma = mine.routedAt || {};
			if (!DaimondStamp.beats(ra[m], rr[m] || '', ma[m], mr[m] || '')) return;
			mine.routing  = mr;
			mine.routedAt = ma;
			if (rr[m]) mr[m] = rr[m]; else delete mr[m];
			if (ra[m]) ma[m] = ra[m];
		});
		return mine.keyEnc + '\n' + mine.key !== keyWas;
	}

	/// Merge the store `from` into `into`, in place, by the law above. The ids whose key
	/// moved in `into`, a row gone included, so the opened keys can follow.
	function absorb(into, from) {
		var moved = [], dead = tombs();
		var gone = function (id, p) { return id !== CREDITS && dead[id] && !(ms(p.touched) > ms(dead[id])); };
		Object.keys(into.providers).forEach(function (id) {
			if (gone(id, into.providers[id])) { delete into.providers[id]; moved.push(id); }
		});
		Object.keys(from.providers || {}).sort().forEach(function (id) {
			var r = from.providers[id];
			if (!r || typeof r !== 'object' || gone(id, r)) return;
			var mine = into.providers[id];
			if (!mine) { into.providers[id] = copy(r); moved.push(id); return; }
			if (mergeRow(mine, r)) moved.push(id);
		});
		CHOICES.forEach(function (slot) {
			var f = from[slot], at = slot + 'At';
			if (!f || !choiceWins(f, ms(from[at]), into[slot] || { provider: '', model: '' }, ms(into[at]))) return;
			into[slot] = { provider: String(f.provider || ''), model: String(f.model || '') };
			into[at]   = ms(from[at]);
		});
		CHOICES.forEach(function (slot) {
			var r = from.lastRun && from.lastRun[slot];
			if (!r) return;
			var mine = into.lastRun && into.lastRun[slot];
			if (mine && !DaimondStamp.beats(r.at, [r.provider, r.model], mine.at, [mine.provider, mine.model])) return;
			(into.lastRun = into.lastRun || {})[slot] = copy(r);
		});
		if (from.topups && window.DaimondMoney) DaimondMoney.marksMerge(into.topups = into.topups || {}, from.topups);
		return moved;
	}

	/// `DaimondStore`'s law for this record: what this tab owes, merged over what the
	/// box holds, so a retried write never undoes a sibling's.
	function storeLaw(stored, owed) {
		if (!stored || stored.v !== 2 || !stored.providers) return owed;
		var out = copy(owed);
		absorb(out, stored);
		return out;
	}

	/// Merge the disk's copy into this tab's, in place. The opened keys follow the stored
	/// ones: a key another tab set, changed or removed is dropped here and opened again,
	/// as a boot opens it (`unseal` answers its own onChange once they are open). The
	/// minted credits key is memory only, so it stays. Did anything move?
	function takeDisk() {
		var disk = window.DaimondStore.get(KEY, null);
		if (!disk || disk.v !== 2 || !disk.providers) return false;
		var moved = absorb(store, disk), reopen = [];
		moved.forEach(function (id) {
			if (id === CREDITS) return;
			delete plain[id];
			if (store.providers[id]) reopen.push(id);
		});
		if (reopen.length) unseal(reopen);
		return moved.length > 0;
	}

	/// The retry budget for `loadSettled`, mirroring identity.js's `existsSettled`.
	/// A cold read settles within a tick or two; this is several times that, and is
	/// only ever spent on a boot whose first read of the store came back empty.
	var SETTLE_TRIES = 12;	// re-reads after the first
	var SETTLE_GAP   = 50;	// ms between them (<=600ms worst case)

	function settleSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

	function hasProviders() {
		return !!(store && store.providers && Object.keys(store.providers).length);
	}

	/// `load()` that does not trust a single cold read.
	///
	/// THE BUG THIS EXISTS FOR: on a freshly opened iOS/WebKit tab the first
	/// `localStorage.getItem` calls can return EMPTY before the storage area has
	/// finished loading from disk -- the timing family behind the seq-222/223 iOS
	/// reports (see identity.js existsSettled). Read that way the models store looks
	/// like "no providers configured", which would decide the composer gate
	/// (`resolve`/`pendingStartBlock`) against a user who has one, and unseal nothing.
	///
	/// This re-reads a bounded number of times, yielding a tick between reads, and
	/// returns the moment providers appear. It NEVER invents a provider: after the
	/// budget the store is left exactly as `load()` left it, so a genuine first-run
	/// user pays one bounded wait at boot and nothing more. Because `migrate()` no
	/// longer persists an empty store, a cold read cannot overwrite the real one
	/// before this recovers it.
	async function loadSettled() {
		load();
		if (hasProviders()) return;
		for (var i = 0; i < SETTLE_TRIES; i++) {
			await settleSleep(SETTLE_GAP);
			load();
			if (hasProviders()) return;
		}
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
		if (p) p.touched = DaimondStamp.next(p.touched);	// past the stamp it replaces, whatever the clocks
	}

	/// A provider row's configuration as the merge compares it at an equal `touched`:
	/// what that stamp decides, as it travels.
	function configOf(p) {
		return { name: String(p.name || ''), url: String(p.url || ''), keyEnc: String(p.keyEnc || '') };
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

	/// Decrypt every stored key into memory, or only the rows `only` names (the keys another
	/// tab moved). Called once the user unlocks: a sealed key is unreadable until then,
	/// which is the point of sealing it.
	async function unseal(only) {
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return;
		var ids = Array.isArray(only) ? only : Object.keys(store.providers);
		for (var i = 0; i < ids.length; i++) {
			var id = ids[i], p = store.providers[id];
			if (!p) continue;
			if (p.keyEnc) {
				var enc = p.keyEnc, k = '';
				try { k = await DaimondIdentity.unwrap(enc); }
				catch (e) { k = ''; }
				// Opened for the row as it was: a key another tab set meanwhile is opened
				// by the unseal its merge started.
				if (store.providers[id] && store.providers[id].keyEnc === enc) plain[id] = k;
			} else if (p.key) {
				plain[id] = p.key;
			}
		}
		if (deps && deps.onChange) deps.onChange();
		refreshCredits();
	}

	/// Clear every stored key that the CURRENT identity cannot read, and name them.
	///
	/// Called after a DELIBERATE identity replacement (the boot/create guard in
	/// daimond.js): the new keypair derives a different wrapping key, so every
	/// `keyEnc` sealed under the old one is permanently unreadable. Left in place it
	/// would sit as a provider that reads present-but-sealed forever; cleared, the
	/// provider reads as keyless and the ordinary "add your key" path is offered.
	/// Only ever run while unlocked, so a key that DOES unwrap is proven readable and
	/// kept -- nothing is dropped that the identity can still open.
	async function dropUnreadableKeys() {
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return [];
		var cleared = [], ids = Object.keys(store.providers);
		for (var i = 0; i < ids.length; i++) {
			var id = ids[i], p = store.providers[id];
			if (!p || !p.keyEnc) continue;
			var enc = p.keyEnc, k = null;
			try { k = await DaimondIdentity.unwrap(enc); } catch (e) { k = null; }
			// The row as it stands after the await, and only while it still holds the seal
			// that was tried: another tab may have set a key since.
			p = store.providers[id];
			if (!p || p.keyEnc !== enc) continue;
			if (k !== null) { plain[id] = k; continue; }
			cleared.push(labelOf(id));
			touch(id);						// a stamped clear, so a sibling's copy cannot put it back
			p.keyEnc = '';
			p.key    = '';
			delete plain[id];
		}
		if (cleared.length) {
			save();
			if (deps && deps.onChange) deps.onChange();
		}
		return cleared;
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
		var failed = [], unread = [], sealed = {}, ids = Object.keys(store.providers);
		for (var i = 0; i < ids.length; i++) {
			var id = ids[i], p = store.providers[id];
			if (!p) continue;
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
			var was = p.keyEnc + '\n' + p.key;
			try { sealed[id] = { enc: await DaimondIdentity.wrap(key), was: was }; }
			catch (e) { failed.push(labelOf(id)); }
		}
		// Written after the last await, onto the rows as they stand now: a row another tab
		// removed stays removed, and a key another tab set meanwhile is newer than this one.
		Object.keys(sealed).forEach(function (id) {
			var p = store.providers[id];
			if (!p || p.keyEnc + '\n' + p.key !== sealed[id].was) return;
			touch(id);						// the new seal outranks every copy of the old one
			p.keyEnc = sealed[id].enc;
			p.key    = '';					// never leave a plaintext copy behind
		});
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
		if (!store.providers[id]) return;
		// Sealed first, and the row written after the await, in one step: another tab may
		// save the store meanwhile, and its copy is merged into this one, so the row is read
		// again here rather than held across the await (r52d QA F1).
		var sealed = '';
		if (window.DaimondIdentity && DaimondIdentity.isUnlocked()) {
			try { sealed = await DaimondIdentity.wrap(key); }
			catch (e) { sealed = ''; }             // no identity to seal under: the old trade
		}
		var p = store.providers[id];
		if (!p) return;						// removed meanwhile: the removal is the later word
		touch(id);							// a configuration change the other device must see
		plain[id] = key;
		p.keyEnc = sealed;
		p.key    = sealed ? '' : key;
		// A key that was just pasted is a key whose balance nobody has asked about. A stale
		// figure from the PREVIOUS key would be worse than none, so any credit record goes —
		// and with it the gate's memory of the OLD key's probes, whose floor and whose backoff
		// were about a credential this row no longer holds.
		delete p.credit;
		delete probes[id];
		// And the catalogue gate's memory, for the same reason: its floor and its failure count
		// were earned by a credential this row no longer holds, and a key pasted to replace a
		// revoked one should not wait out the backoff the revoked one collected.
		delete lists[id];
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
	async function mintRequest(slot, node, opts) {
		var stop = held(node) ? node
			: (((slot | 0) >= 1 && held(workersNode())) ? workersNode() : '');
		if (stop) throw pauseError(stop);
		var head = { 'content-type': 'application/json' };
		if (window.DaimondGateway && DaimondGateway.clientApi) {
			head['x-daimond-api'] = String(DaimondGateway.clientApi());
		}
		var body = { slot: slot | 0 };
		// `ensure` asks the gateway to RAISE this slot's live key in place, to
		// `want_minor` of headroom, rather than mint a fresh one -- so a turn costing
		// more than the mint float is not refused and re-run on a new key. The number is
		// a REQUEST: the gateway clamps it to its own [float, max_headroom] band, for
		// the reason `mint`'s own note gives (a browser that could ask for a number
		// could ask for the wrong one). Both fields are absent on an ordinary mint, so a
		// gateway that predates `ensure` sees byte-for-byte the request it always did.
		if (opts && opts.ensure) {
			body.ensure     = true;
			body.want_minor = Math.max(0, opts.wantMinor | 0);
		}
		var r = await fetch(MINT_URL, {
			method:      'POST',
			headers:     head,
			credentials: 'same-origin',
			body:        JSON.stringify(body),
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
		// An `ensure` that RAISED a live key answers with no key -- the key the caller
		// already holds is the one that was raised -- so the key/url check is the
		// caller's (`ensure` gates on `raised_minor`), not this one's.
		if (opts && opts.ensure) return j;
		if (!j.key || !j.url) throw new Error(t('models.err_bad_key'));
		return j;
	}

	/// `node` is the leaf the mint is for, when there is one. The mint at unlock
	/// belongs to no leaf and passes none: gating it would leave a paused chat's
	/// pause holding the whole account keyless.
	async function mint(node) {
		return installCreditsFromReply(await mintRequest(0, node));
	}

	/// Install a mint reply as the live credits key.
	///
	/// Factored out of `mint` so `ensure` can adopt a key too: a raise cannot save a
	/// dead key, so a gateway that had to mint after all answers WITH a key, and it is
	/// installed here exactly as `mint` would install it.
	function installCreditsFromReply(j) {
		var url         = chatUrl(j.url);
		plain[CREDITS]  = j.key;                // memory, and nowhere else — see `plain`.
		mintGen++;                              // this key's generation; the last one is revoked.
		credits.bal     = typeof j.credits_minor === 'number' ? j.credits_minor : 0;
		credits.cur     = j.currency || 'usd';
		// What the key itself may draw, which is NOT the balance: the gateway caps a minted key
		// at a float, so a key can be spent while the account still holds credits. `ensure`
		// raises that cap in place; only a dead key reaches this path, so a fresh cap is set.
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

	/// Make the credits row reflect the account: ask the gateway for a key, stand down on its
	/// refusal, and list what the key can run.
	///
	/// `acct` is what the caller has just read from the gateway — `{ authed, credits, currency,
	/// offline }`. It is passed in rather than fetched here so the gateway's contract stays in
	/// gateway.js and this file stays about models.
	async function syncCredits(acct) {
		acct = acct || {};
		if (!acct.authed) { standDown(acct.offline ? 'offline' : ''); return false; }
		// No balance check here: the mint's answer is the only verdict on whether there is
		// money to spend. An account may run below zero by design (the house account, up to
		// its `house_limit_minor`), and a page that judged the figure for itself showed that
		// account "no credits" and never asked. A refusal comes back with its own words.

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

	/// Make one request on `provider`'s key, healing a refused credits key once.
	///
	/// For a caller with no agent to rebuild -- a one-shot request such as an images-model look
	/// -- that would otherwise meet the 401 every tab but the last to mint gets: the gateway
	/// keeps one live key per account slot, which bounds what a leaked or runaway key can draw
	/// to one float, so a mint on another device revokes this tab's key by design. The chat
	/// heals that in its turn loop (`canRemint`); this is the same heal for everyone else.
	///
	/// `send(r)` gets `resolve(provider, model)` and answers `{ ok, status, ... }`. A 401, 402
	/// or 403 on the credits row takes the live key (or mints one, coalesced, under `node`'s
	/// pause) and sends again, once. Answers what `send` last answered, with `reminted` set when
	/// it retried and `remintError` when the fresh key could not be had; null when there is no
	/// usable key at all.
	async function sendOnKey(provider, model, node, send) {
		var gen = mintGen, r = resolve(provider, model);
		if (!r) return null;
		var res = await send(r);
		if (provider !== CREDITS || !res || [401, 402, 403].indexOf(res.status | 0) < 0) return res;
		try { await remint(gen, node); }
		catch (e) { res.remintError = String((e && e.message) || e); return res; }
		var r2 = resolve(provider, model);
		if (!r2) { res.remintError = 'no key after the mint'; return res; }
		var again = await send(r2);
		if (again) again.reminted = true;
		return again;
	}

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
		return installSlotFromReply(slot, await mintRequest(slot, node));
	}

	/// Install a mint reply as a worker slot's key, counting its generation up.
	/// Factored out of `mintSlot` for the same reason `installCreditsFromReply` is: an
	/// `ensure` on a slot whose key was dead adopts the fresh key the gateway minted.
	function installSlotFromReply(slot, j) {
		var s = slots[slot] || (slots[slot] = { key: '', url: '', gen: 0 });
		s.key  = j.key;
		s.url  = chatUrl(j.url);
		s.gen += 1;
		// The balance is account-wide, so a worker's mint keeps the shared row as
		// current as the chat's own mint does.
		if (typeof j.credits_minor === 'number') credits.bal = j.credits_minor;
		return s;
	}

	// ── Ensure: raise a live key's cap in place, sized to the turn ───
	// The mint float is the LEAST headroom a key gets, not the most it may ever draw.
	// A turn worth more than the float used to be refused at the cap and re-run on a
	// fresh key -- billed once for nothing, and stuck when the refusal was a 402 the
	// old regex did not match. `ensure` raises the SAME key instead, so the turn runs
	// on the key it started on and the partial draw is that key's own usage.

	/// An `ensure` in flight, per slot, so callers arriving together make one request.
	var ensuring = {};
	/// Set once a reply arrives WITHOUT `raised_minor`: the gateway predates `ensure`
	/// and treated the call as a mint. From then on `ensure` is a no-op, so an old
	/// gateway is never made to rotate the key on every turn -- the client falls back
	/// to plain mint/remint.
	var ensureUnsupported = false;

	/// Raise this slot's key to `wantMinor` of headroom, without rotating it.
	///
	/// Returns the gateway reply, or `null` when `ensure` is unsupported. The caller
	/// reads `reply.key`: absent means the live key was raised in place and the app
	/// around it stands; present means a dead key forced a mint and the app must be
	/// rebuilt around the new key, exactly as a `remint` would make it.
	async function ensure(slot, wantMinor, node) {
		if (ensureUnsupported) return null;
		var s = slot | 0;
		if (ensuring[s]) return await ensuring[s];
		ensuring[s] = (async function () {
			var j = await mintRequest(s, node, { ensure: true, wantMinor: wantMinor });
			// The gate: a gateway that understands `ensure` always reports what it
			// raised, even a raise of zero. Its absence means this call was read as a
			// mint -- so adopt the key it gave (this turn is not billed for nothing on a
			// key the gateway just revoked) and never ensure again this session.
			if (!j || typeof j.raised_minor !== 'number') {
				ensureUnsupported = true;
				if (j && j.key && j.url) {
					if (s === 0) installCreditsFromReply(j);
					else installSlotFromReply(s, j);
				}
				return j;
			}
			if (j.key && j.url) {
				// A raise cannot save a dead key, so the gateway minted after all.
				if (s === 0) installCreditsFromReply(j);
				else installSlotFromReply(s, j);
			} else {
				// Raised in place: the key stands, only the ceiling and balance moved.
				if (s === 0 && typeof j.limit_minor === 'number') credits.limit = j.limit_minor;
				if (typeof j.credits_minor === 'number') credits.bal = j.credits_minor;
				if (deps && deps.onChange) deps.onChange();
			}
			return j;
		})();
		try { return await ensuring[s]; }
		finally { delete ensuring[s]; }
	}

	/// Is `ensure` still worth calling? False once a gateway without it has answered,
	/// so a mid-turn top-up loop can stop reaching for it.
	function ensureActive() { return !ensureUnsupported; }

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
		// A price per picture sent, in dollars, where the provider quotes one (OpenRouter's
		// `pricing.image`); a look's cost counts it.
		var img = (typeof p.image === 'number') ? p.image : parseFloat(p.image);
		if (isFinite(img) && img > 0) out.img = img;
		return out;
	}

	/// Does one entry of a `/models` reply say that the model takes pictures? True or false when
	/// the provider says, and null when it says nothing, which is not the same as "no".
	///
	/// OpenRouter publishes `architecture.input_modalities` (and the older `architecture.modality`,
	/// "text+image->text"); some providers carry the list at the top of the entry or as a
	/// `capabilities` flag. THE PROVIDER'S WORD, because a hand table of model names is wrong for
	/// every model released after it was written -- which is how two multimodal daimons told the
	/// owner they could not be shown pictures. The engine treats this as outranking its own tables
	/// (`LlmClient::set_sight`).
	function sightOf(m) {
		if (!m || typeof m !== 'object') return null;
		var a = (m.architecture && typeof m.architecture === 'object') ? m.architecture : {};
		var list = Array.isArray(a.input_modalities) ? a.input_modalities
			: Array.isArray(m.input_modalities) ? m.input_modalities : null;
		if (list && list.length) {
			return list.some(function (x) { return String(x).toLowerCase() === 'image'; });
		}
		if (typeof a.modality === 'string' && a.modality.indexOf('->') > 0) {
			return a.modality.split('->')[0].toLowerCase().indexOf('image') >= 0;
		}
		var c = (m.capabilities && typeof m.capabilities === 'object') ? m.capabilities : null;
		if (c) {
			if (typeof c.vision === 'boolean') return c.vision;
			if (c.image_input && typeof c.image_input.supported === 'boolean') {
				return c.image_input.supported;
			}
		}
		return null;
	}

	/// The reasoning levels the rungs of a model's Effort are drawn from, low to high. A level
	/// a provider names that is not on this ladder is dropped rather than guessed at.
	var EFFORT_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

	/// The levels `m` (a `/models` entry) says it takes, as `{ levels, dflt }` ordered low to
	/// high, or null when it names none. OpenRouter publishes `reasoning.supported_efforts` and
	/// `reasoning.default_effort`; an on/off switch alone is not a level. THE PROVIDER'S WORD,
	/// for the reason `sightOf` gives: a hand table is wrong for every model released after it.
	function effortsOf(m) {
		if (!m || typeof m !== 'object') return null;
		var r = (m.reasoning && typeof m.reasoning === 'object') ? m.reasoning : null;
		if (!r || !Array.isArray(r.supported_efforts)) return null;
		var named = r.supported_efforts.map(function (x) { return String(x).toLowerCase(); });
		var levels = EFFORT_LADDER.filter(function (l) { return named.indexOf(l) >= 0; });
		if (!levels.length) return null;
		var d = typeof r.default_effort === 'string' ? r.default_effort.toLowerCase() : '';
		return { levels: levels, dflt: levels.indexOf(d) >= 0 ? d : '' };
	}

	/// The catalogue's own name for a model ("DeepSeek: DeepSeek V4.1 Flash"), or '' when it
	/// gives none beyond the id. Kept so lists can show a person's name for the model.
	function nameOf(m, mid) {
		var n = (m && typeof m.name === 'string') ? m.name.trim() : '';
		return (n && n !== mid) ? n.slice(0, 120) : '';
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
			var sees = sightOf(m);
			var eff  = effortsOf(m);
			var nm   = nameOf(m, mid);
			if (!mid || (!rr && sees === null && !eff && !nm)) return;
			// The pictures flag, the Effort levels and the catalogue's own name for the model
			// ride the rates row, so they are stored, merged and synced with them.
			var row = rr || {};
			if (sees !== null) row.sees = sees;
			if (nm) row.name = nm;
			if (eff) {
				row.efforts = eff.levels;
				if (eff.dflt) row.effortDefault = eff.dflt;
			}
			rates[mid] = row;
		});
		var p = store.providers[id];
		if (!p) return ids;					// removed while it was asked
		p.models  = ids;
		p.rates   = rates;
		p.fetched = Date.now();
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

	/// What `provider` says of pictures for `model`: true, false, or null when it never said.
	///
	/// The page hands this to the engine (`set_sight`) before a model is dispatched, so a model
	/// the engine's name tables have never heard of is still shown a picture when the provider
	/// lists it as taking one.
	function sightFor(provider, model) {
		var p = store.providers[provider];
		if (!p || !p.rates) return null;
		var r = p.rates[model];
		return (r && typeof r.sees === 'boolean') ? r.sees : null;
	}

	// What one look costs a model: the page's pictures and the ask, read, and the description
	// written (D-20261009-27).
	var LOOK_IN = 1500, LOOK_OUT = 200;

	/// Who made `model`: the catalogue's own prefix (`maker/name`), or the provider itself for a
	/// provider that lists only its own models under bare names.
	function makerOf(provider, model) {
		var m = String(model || ''), i = m.indexOf('/');
		return i > 0 ? m.slice(0, i).replace(/^~/, '') : String(provider || '');
	}

	/// The account's default images model (D-20261009-27): of the models a provider with a key
	/// lists as taking pictures, the one whose look costs least at its quoted rates, as
	/// `{ provider, model, usd, familiar }`, or null when none is both seeing and priced. A model
	/// quoted at nothing is passed over, since a free endpoint is rate-limited and a look must not
	/// wait on it, and so is a batch variant; ties go to a provider the account already chats on,
	/// then the provider's id, then the model's. `skip` (`{ provider, model }`)
	/// is a model that may not describe its own pictures.
	///
	/// The floor: a catalogue lists hundreds of seeing models, and the cheapest of them all is
	/// as often one nobody here has tried. So the pick is first made among the makers the
	/// account already thinks with -- its default and drafting models, and `uses` (the caller's
	/// list of `{ provider, model }`, the Diamonds' own) -- and `familiar` says so; only when none
	/// of those makers offers a seeing priced model is the catalogue-wide cheapest taken.
	function cheapestSeeing(skip, uses) {
		var makers = {}, rows = {};
		[getDefault(), getDraft()].concat(uses || []).forEach(function (u) {
			if (u && u.model) { makers[makerOf(u.provider, u.model)] = true; rows[u.provider || ''] = true; }
		});
		// A tie goes first to a provider the account already chats on, whose key is the one
		// in daily use: the same model at the same price on another row (2026-10-12, credits
		// beside openrouter) is a second key that can be stale while the first is live.
		var beats = function (c, b) {
			return !b || c.usd < b.usd || (c.usd === b.usd && rows[c.provider] && !rows[b.provider]);
		};
		var best = null, near = null;
		Object.keys(store.providers).sort().forEach(function (pid) {
			var p = store.providers[pid];
			if (!p || !p.rates || !keyFor(pid)) return;
			Object.keys(p.rates).sort().forEach(function (mid) {
				var r = p.rates[mid];
				if (!r || r.sees !== true || typeof r.in !== 'number' || typeof r.out !== 'number') return;
				if (r.in <= 0 && r.out <= 0) return;
				// A catalogue's batch variant answers on its own schedule, and a look must not wait.
				if (/:batch$/.test(mid)) return;
				if (skip && skip.provider === pid && skip.model === mid) return;
				var usd = (LOOK_IN * r.in + LOOK_OUT * r.out) / 1e6 + (typeof r.img === 'number' ? r.img : 0);
				var c = { provider: pid, model: mid, usd: usd };
				if (beats(c, best)) best = { provider: pid, model: mid, usd: usd, familiar: false };
				if (makers[makerOf(pid, mid)] && beats(c, near)) near = { provider: pid, model: mid, usd: usd, familiar: true };
			});
		});
		return near || best;
	}

	/// The Effort levels `provider` lists for `model`, as `{ levels, dflt }`, or null when it
	/// lists none (and the chat then shows no Effort and sends none).
	function effortsFor(provider, model) {
		var p = store.providers[provider];
		if (!p || !p.rates) return null;
		var r = p.rates[model];
		if (!r || !Array.isArray(r.efforts) || !r.efforts.length) return null;
		return { levels: r.efforts.slice(), dflt: typeof r.effortDefault === 'string' ? r.effortDefault : '' };
	}

	/// A chat's Effort after its model changes: kept when the new model offers it, cleared
	/// (and `cleared` set, so the page can say so) when it does not.
	function effortAfterSwitch(effort, provider, model) {
		if (!effort) return { effort: '', cleared: false };
		var f = effortsFor(provider, model);
		if (f && f.levels.indexOf(effort) >= 0) return { effort: effort, cleared: false };
		return { effort: '', cleared: true };
	}

	/// A daimon's Effort on the model in force. `rec` pairs the level with the model it was set
	/// for (`effort`, `effortProvider`, `effortModel`), as the engine's `ChosenEffort` does, so a
	/// Diamond that follows the default never has to pin a model to keep one. On that model the
	/// level holds; on another (the default moved) it is kept where the model offers it and
	/// otherwise `dropped`, for the caller to forget quietly.
	function effortInForce(rec, provider, model) {
		var e = rec && typeof rec.effort === 'string' ? rec.effort : '';
		if (!e) return { effort: '', dropped: false };
		if ((rec.effortModel || '') === (model || '') && (rec.effortProvider || '') === (provider || '')) {
			return { effort: e, dropped: false };
		}
		var f = effortsFor(provider, model);
		if (f && f.levels.indexOf(e) >= 0) return { effort: e, dropped: false };
		return { effort: '', dropped: true };
	}

	/// The raw provider-routing text set on this model's own row, or '' when nobody has set
	/// one. Free text the user typed -- "Novita, Together / DeepInfra" or similar -- parsed
	/// only where it is used (`DaimondModels.parseRouting`); this file never reads it.
	///
	/// Added for proposal 15, 2026-09-15: the incident's own export named the upstream
	/// provider (`Makora`) that served the stalled round, and there was nowhere on this side
	/// to act on that evidence -- OpenRouter's own `provider.order`/`provider.ignore` are
	/// per-request fields, and the app had no setting that reached them at all.
	function routing(providerId, model) {
		var p = store.providers[providerId];
		if (!p || !p.routing) return '';
		return typeof p.routing[model] === 'string' ? p.routing[model] : '';
	}

	/// Set the routing text for `model` under `providerId`; a blank string clears it.
	function setRouting(providerId, model, text) {
		var p = store.providers[providerId];
		if (!p) return;
		if (!p.routing) p.routing = {};
		if (!p.routedAt) p.routedAt = {};
		text = String(text || '').trim();
		if (text) p.routing[model] = text;
		else delete p.routing[model];
		p.routedAt[model] = DaimondStamp.next(p.routedAt[model]);	// a clear is stamped too
		save();
	}

	/// Read one routing field into the three things OpenRouter's `provider` object wants.
	///
	/// SYNTAX: comma-separated provider names; a leading `-` marks one to IGNORE rather than
	/// prefer, and a bare `!` token on its own means "only these -- refuse every fallback"
	/// (OpenRouter's `allow_fallbacks:false`). No name here is ever hard-coded by this app --
	/// every one came from what the user typed on the model's own row.
	///
	///     "Novita, Together"          -> prefer Novita then Together, fallbacks allowed
	///     "Novita, -DeepInfra"        -> prefer Novita, never DeepInfra
	///     "Novita, !"                 -> ONLY Novita, refuse every other provider
	///
	/// Returns `{ order, ignore, only }`, each list already trimmed and never containing an
	/// empty string.
	function parseRouting(text) {
		var order = [], ignore = [], only = false;
		String(text || '').split(',').forEach(function (raw) {
			var tok = raw.trim();
			if (!tok) return;
			if (tok === '!') { only = true; return; }
			if (tok.charAt(0) === '-') {
				var nm = tok.slice(1).trim();
				if (nm) ignore.push(nm);
			} else {
				order.push(tok);
			}
		});
		return { order: order, ignore: ignore, only: only };
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

	/// When a catalogue is old enough to be asked for again without anybody asking.
	///
	/// A provider publishes a model when it publishes one and tells nobody; a list a day old
	/// has very likely missed something, and a list an hour old very likely has not. That is
	/// the whole of the reasoning, and it is also why this is compiled in rather than offered:
	/// every figure between an hour and a day produces the same experience for the same person,
	/// so a control over it would be a choice with nothing on either side of it.
	///
	/// Two orders of magnitude above `CREDIT_STALE_MS` above, and the gap is the point. A
	/// balance moves whenever the user spends or tops up; a catalogue moves when a company
	/// ships. The two figures are next to each other so that neither is ever copied from the
	/// other by somebody in a hurry.
	var LIST_STALE_MS = 24 * 60 * 60 * 1000;

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

	// ── When the catalogue is asked for again ───────────────────────
	// A balance goes wrong because the user spent or topped up. A LIST goes wrong for a reason
	// nothing in this browser can see: the provider published something. The button beside the
	// list is the deliberate way to find out, and it was the ONLY way — so a catalogue asked for
	// on the day a key was pasted stayed that way until somebody thought to press it, which for
	// the models a person actually uses is never. So it is also asked for by itself, at the two
	// moments a person would expect it to be current: the panel coming up, and the app starting.
	//
	// THE GATE IS THE WHOLE OF THIS. `fetchModels` ends in `save()`, `save()` tells daimond.js
	// the store changed, and daimond.js redraws this panel — so an ask made BY a redraw makes a
	// redraw that makes an ask. It is the loop the comment above `refreshCredits` measured at
	// four thousand requests, with two differences, both bad: this one runs against a third
	// party rather than the same one twice, and it carries the user's own API key while it does
	// it. Three things stop it, and all three are needed:
	//
	//   * BUSY — the redraw from `save()` happens while the first ask is still in flight, and so
	//     does every redraw for a row expanded or a language changed in the meantime. Without
	//     this, a tight run of redraws is a request each, because none of them has an answer
	//     yet and the list is still as stale as it was.
	//   * THE FLOOR — a FAILED ask writes nothing, so `fetched` stays old and staleness alone
	//     would wave the next redraw straight through. The floor is what makes a refusal cost
	//     one request rather than one per redraw.
	//   * THE FAILURE COUNT — a provider that is refusing is not persuaded by being asked
	//     faster, and a tab left open overnight would otherwise spend the night asking.
	//
	// A SEPARATE RECORD from `probes`, deliberately. "When the balance was last asked" and "when
	// the list was last asked" are different facts about different endpoints, and one record
	// answering both would have each of them lying about the other.

	/// The shortest gap between two automatic asks for one provider's catalogue.
	///
	/// It governs the failing case and only that: a successful ask stamps `fetched`, after which
	/// `LIST_STALE_MS` holds the next one off for a day. So it is set at the length of a network
	/// hiccup rather than at anything to do with catalogues — a provider unreachable at boot
	/// should get another chance when the panel is opened, and should not have spent a whole day
	/// on one refusal.
	var LIST_FLOOR_MS = 10 * 60 * 1000;

	/// Per provider: `{ at, busy, ok, fails }`, the same shape and the same job as `probes`.
	///
	/// Memory only, and for the same reason: an attempt stamp restored from disk would hold back
	/// the one ask a freshly loaded tab most needs.
	var lists = {};

	/// How long the gate holds this catalogue: the floor, doubled once per consecutive failure,
	/// and never longer than the staleness it exists to notice. A provider refusing all day is
	/// still asked once a day, which is what a provider answering perfectly gets anyway.
	function listWait(id) {
		var st = lists[id];
		var n  = (st && st.fails) || 0;
		return Math.min(LIST_FLOOR_MS * Math.pow(2, n), LIST_STALE_MS);
	}

	/// Whether an AUTOMATIC ask for this provider's catalogue is allowed right now. The button
	/// under the list is the user asking, is not automatic, and does not come through here.
	function listDue(id) {
		var p = store.providers[id];
		if (!p) return false;
		// The minted row asks for its own list after every mint (`syncCredits`), which is a
		// better moment than either of ours: the key it would be asked with did not exist a
		// second earlier. Asking again here would be asking for work already done.
		if (id === CREDITS) return false;
		// No key, or a key sealed under a passphrase nobody has typed yet. Either way there is
		// nothing to ask with, and an ask would spend a request to be told so.
		if (!canRun(id)) return false;
		var st = lists[id];
		if (st) {
			if (st.busy) return false;				// one in flight is one request already
			if ((Date.now() - st.at) < listWait(id)) return false;
		}
		return (Date.now() - ms(p.fetched)) >= LIST_STALE_MS;
	}

	/// Ask one provider for its catalogue, silently.
	///
	/// The button reports what the provider said, because somebody pressed it and is waiting for
	/// an answer. This did not ask, so it says nothing: a panel that opens with a provider's
	/// error across it is blaming the user for arriving. The old list stands, and the line under
	/// it goes on saying how old it is, which is the honest account of what happened. The
	/// failure is counted, because that is the one thing that has to happen — see `listWait`.
	async function askList(id) {
		var st = lists[id] = {
			at:    Date.now(),				// stamped BEFORE the request, so a slow one still counts
			busy:  true,
			ok:    lists[id] ? lists[id].ok : null,
			fails: (lists[id] && lists[id].fails) || 0,
		};
		var got = false;
		try {
			await fetchModels(id);
			got = true;
		} catch (e) {
			/* a revoked key, a typo in a URL, a rate limit: none of it was asked for */
		} finally {
			st.busy  = false;
			st.done  = Date.now();
			st.ok    = got;
			st.fails = got ? 0 : st.fails + 1;
		}
	}

	/// Ask every provider whose catalogue has gone stale, wherever the gate allows it.
	///
	/// Fire-and-forget, like `refreshCredits` beside it: nothing on screen may wait on somebody
	/// else's server. An ask that answers redraws the panel through `save()`, which is how a
	/// model published this morning arrives without anybody pressing anything.
	function refreshLists() {
		// Offline is not a refusal to hold against a provider — there is nothing to ask — so it
		// returns before anything is stamped and nothing is counted against anybody.
		if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
		for (var id in store.providers) {
			if (!listDue(id)) continue;
			askList(id);
		}
	}

	/// Whether a check is already waiting for the panel to appear.
	var showCheck = false;

	/// Try the panel again one task after a redraw that found nothing on screen.
	///
	/// `settings()` in daimond.js draws this list and THEN reveals the drawer holding it, so at
	/// the instant of that draw the list has no box and `onScreen` is quite correctly false —
	/// which means the redraw the trigger was written for, the panel being OPENED, is the one
	/// redraw the trigger misses. Measured: a click on Models asks nothing, and the ask waits
	/// for whatever the user does next inside the panel. A task later the drawer is up and the
	/// box is real, so the same test is asked again then.
	///
	/// The credit probe above has the same blind spot and is deliberately left with it: it has a
	/// heartbeat behind it that catches the panel within the minute, this has none, and rewiring
	/// somebody else's trigger is not what this change is.
	///
	/// One timer at a time. A run of redraws must not become a run of timers — that is the same
	/// loop again wearing a different hat — and a single check is all any of them wanted.
	function askWhenShown() {
		if (showCheck || typeof setTimeout !== 'function') return;
		showCheck = true;
		setTimeout(function () {
			showCheck = false;
			// Still nothing on screen: the redraw was a sync pull or a change of language, and
			// nobody is looking. The panel will be drawn again when somebody is.
			if (!onScreen(document.getElementById('models-list'))) return;
			refreshLists();
		}, 0);
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
	/// Returns `{ remainingUsd, asOf, capped, binds }` or null; `binds` is 'limit' or 'credit',
	/// whichever of the key's cap and the account's credit is the smaller.
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

		// THE BINDING NUMBER (D-20261020-13). A key spends the account's credit, and a capped
		// key spends no more than its cap besides, so what it can spend is the smaller of the
		// two, and `binds` says which. An uncapped key's figure is the account's credit alone,
		// and is named as that, never as the key's: the owner could not find "his key's
		// balance" on the API Keys page because a key has none.
		var capped = (typeof keyData.limit === 'number' && typeof keyData.limit_remaining === 'number');
		var account = null;
		try {
			var rc = await fetch(siblingUrl(url, 'credits'), { headers: auth });
			if (rc.ok) {
				var jc = await rc.json();
				var cd = jc.data || jc;
				if (cd && typeof cd.total_credits === 'number' && typeof cd.total_usage === 'number') {
					account = cd.total_credits - cd.total_usage;
				}
			}
		} catch (e) { account = null; }
		var remaining = null, binds = '';
		if (capped && typeof account === 'number' && isFinite(account) && account < keyData.limit_remaining) {
			remaining = account; binds = 'credit';
		} else if (capped) {
			// The cap is the lower, or the account would not say: the cap is what this key
			// can spend at most, and it is named as the cap.
			remaining = keyData.limit_remaining; binds = 'limit';
		} else {
			remaining = account; binds = 'credit';
		}
		if (typeof remaining !== 'number' || !isFinite(remaining)) return null;

		// The row as it stands after the awaits: a figure about a key the row no longer
		// holds is not kept.
		p = store.providers[id];
		if (!p || keyFor(id) !== key) return null;
		var asOf = Date.now();
		p.credit = {
			mode:         'auto',
			remainingUsd: remaining,
			asOf:         asOf,
			binds:        binds,
			// A manual base the user may have set earlier is kept: an auto probe that starts
			// failing tomorrow should fall back to their figure, not forget it.
			baseUsd:      (p.credit && typeof p.credit.baseUsd === 'number') ? p.credit.baseUsd : null,
			baseAt:       (p.credit && typeof p.credit.baseAt === 'number') ? p.credit.baseAt : null,
		};
		save();
		return { remainingUsd: remaining, asOf: asOf, capped: capped, binds: binds };
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
			baseAt:       DaimondStamp.next(prev.baseAt),
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
				binds:     c.binds || 'credit',
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
	/// A price-tag mark, drawn as the tag wherever the string lands
	/// (`fillPrices`, `pricesHtml`, or `pricesText` where no tag can be drawn).
	function usd(v) {
		return DaimondI18n.priceMark(v, { mode: 'fine' });
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
				// When the catalogue was last asked for, so the panel can say. A list has
				// no other age: it is not re-asked on a beat the way a balance is, and a
				// count with no date behind it cannot tell you it was taken a month ago.
				fetched: ms(p.fetched),
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
					? (credits.state === 'ready' ? DaimondI18n.priceMarkMinor(credits.bal, credits.cur) : '')
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
	/// compared, and Fireworks' version spelling is read as everybody else's: `v4p1` is `v4.1`
	/// and `glm-5p3` is `glm-5.3` (a `p` between two digits is its decimal point). Without that,
	/// Email's `deepseek-v4p1-flash` and OpenRouter's `deepseek-v4.1-flash` never paired.
	function baseName(m) {
		var s   = String(m || '');
		var cut = s.lastIndexOf('/');
		return (cut === -1 ? s : s.slice(cut + 1)).toLowerCase().replace(/(\d)p(?=\d)/g, '$1.');
	}

	/// What a person calls `model` on `provider`: the catalogue's `name` without its maker prefix
	/// ("DeepSeek: DeepSeek V4.1 Flash" reads "DeepSeek V4.1 Flash"), else the name a twin's
	/// catalogue gives it, else the id's last segment as its maker writes it (`tidyName`).
	function displayName(provider, model) {
		var own = catName(provider, model);
		if (own) return own;
		var b = baseName(model);
		for (var id in store.providers) {
			var p = store.providers[id];
			if (id === provider || !p.rates) continue;
			for (var mid in p.rates) {
				if (baseName(mid) === b && p.rates[mid] && p.rates[mid].name) return catName(id, mid);
			}
		}
		return tidyName(model);
	}

	function catName(provider, model) {
		var p = store.providers[provider];
		var r = p && p.rates && p.rates[model];
		var n = (r && typeof r.name === 'string') ? r.name : '';
		var colon = n.indexOf(': ');
		return colon > 0 ? n.slice(colon + 2) : n;
	}

	/// The model-list source: every model once, its twins behind other providers folded into it.
	///
	/// Returns `[{ name, base, offers: [{ provider, model }] }]` by display name; `offers` puts
	/// the preferred payer first (`preferredOf`). Which offer is picked decides who is billed,
	/// so a twin is one row with each other payer named under it, never two rows of one name.
	/// Only the first id of a provider joins a twin: one provider listing two ids of one bare
	/// name has two models, not one.
	function catalogue() {
		var by = {}, out = [];
		providers().forEach(function (p) {
			p.models.forEach(function (m) {
				var k = baseName(m), e = by[k];
				if (e && e.offers.some(function (o) { return o.provider === p.id; })) {
					k = p.id + '\u0000' + m;
					e = by[k];
				}
				if (!e) { e = by[k] = { name: '', base: baseName(m), offers: [] }; out.push(e); }
				e.offers.push({ provider: p.id, model: m });
			});
		});
		var pref = preferredOf();
		out.forEach(function (e) {
			e.offers.sort(function (a, b) { return pref(a.provider) - pref(b.provider); });
			e.name = displayName(e.offers[0].provider, e.offers[0].model);
		});
		out.sort(function (a, b) { return a.name.localeCompare(b.name) || (a.base < b.base ? -1 : a.base > b.base ? 1 : 0); });
		return out;
	}

	/// Rank of a provider as payer, lowest first: the default's provider is his preferred one,
	/// then the rest in the panel's order.
	function preferredOf() {
		var d = getDefault(), ids = Object.keys(store.providers);
		return function (id) { return id === d.provider ? -1 : ids.indexOf(id); };
	}

	/// The second line a model row carries, "Through Fireworks AI", or '' when it needs none:
	/// only when the paying provider is not his preferred one, or when another also offers it.
	function throughLine(provider, model) {
		var d = getDefault(), b = baseName(model), others = 0;
		for (var id in store.providers) {
			if (id === provider) continue;
			if ((store.providers[id].models || []).some(function (m) { return baseName(m) === b; })) others++;
		}
		if (!others && (!d.provider || provider === d.provider)) return '';
		return t('models.through', { provider: providerName(provider) });
	}

	// Words a model id spells in lower case that its maker spells otherwise.
	var NAME_WORDS = { glm: 'GLM', gpt: 'GPT', deepseek: 'DeepSeek', llm: 'LLM', oss: 'OSS', vl: 'VL',
		ai: 'AI', it: 'IT', moe: 'MoE', openai: 'OpenAI', minimax: 'MiniMax' };

	/// A model id read as its maker writes it, `displayName`'s last fallback when no catalogue
	/// names it (D-20261018-09 §3): "z-ai/glm-5.3-flash" as "GLM 5.3 Flash". Fireworks' version spelling reads as the others
	/// do (`v4p1` is V4.1), and a size keeps its unit ("70B"). The id stays in the hover, the
	/// search text and the details; nothing stores this.
	function tidyName(model) {
		var s = String(model || '');
		var leaf = s.slice(s.lastIndexOf('/') + 1).replace(/(\d)p(\d)/g, '$1.$2');
		var out = [];
		leaf.split(/[-_ ]+/).forEach(function (w) {
			if (!w) return;
			var lo = w.toLowerCase();
			var nm = NAME_WORDS[lo] ? NAME_WORDS[lo]
				: /^v?\d/.test(lo) ? lo.replace(/^v/, 'V').replace(/(\d)([bkm])$/, function (a, d, u) { return d + u.toUpperCase(); })
				: /^[a-z]\d/.test(lo) ? lo.charAt(0).toUpperCase() + lo.slice(1)
				: w.charAt(0).toUpperCase() + w.slice(1);
			// GPT keeps its hyphen before the version: "GPT-5.2 Mini".
			if (out.length && out[out.length - 1] === 'GPT' && /^\d/.test(nm)) out[out.length - 1] += '-' + nm;
			else out.push(nm);
		});
		return out.join(' ') || s;
	}

	// ── The default, and resolving a chat's model ───────────────────

	function getDefault() { return standing(store.def, store.defAt, 'def'); }

	/// The default or the drafting model (`slot` 'def' or 'draft') as stored and synced, not as
	/// `standing` reads it on this device. Null while the store holds no provider: a cold read
	/// (`loadSettled`) or a first run, neither of which may be compared against.
	function storedChoice(slot) {
		if (!hasProviders()) return null;
		var c = store[slot];
		return { provider: (c && c.provider) || '', model: (c && c.model) || '' };
	}

	/// A choice -- the default, the drafting model -- as it stands here.
	///
	/// The stored choice is a register merged on its own stamp and nothing else, so
	/// every device holds the same one whatever order the parcels came in (SIM-18).
	/// What it SAYS is read from it and the provider tombstones, which merge just as
	/// surely: a choice whose provider was deleted after it was made reads as cleared
	/// -- the tombstone is the stamped write that clears it -- and a choice made after
	/// the deletion stands. One whose provider is not on this device at all is not
	/// run here: a default pointing at nothing is worse than an older default that
	/// works, so this device goes on with the last choice it could run (`lastRun`,
	/// its own and never sent) until that provider arrives.
	function standing(choice, at, slot) {
		var p = (choice && choice.provider) || '';
		if (!p) return { provider: '', model: (choice && choice.model) || '' };
		if (ms(tombs()[p]) > ms(at)) return { provider: '', model: '' };
		if (runnable(choice, at, slot)) return { provider: p, model: (choice && choice.model) || '' };
		var last = store.lastRun && store.lastRun[slot];
		if (last && runnable(last, last.at, slot)) return { provider: last.provider, model: last.model || '' };
		return { provider: '', model: '' };
	}

	/// Can this device run a choice stamped `at`: its provider here, and not deleted since?
	///
	/// The default (`slot` 'def') needs a key here as well (D-20261018-09 U2b). A provider row
	/// arrives from another device whether or not its key can, and `resolve` runs nothing
	/// without one. A Jobs pick that cannot run falls to its next link (`effective`); the
	/// default has none, so a keyless one would leave every follower asking for a key while
	/// this device holds an older default it can run. A sealed key counts, so a lock does not
	/// move it, and the credits row counts unkeyed, its key being minted here on unlock.
	function runnable(choice, at, slot) {
		var p = choice && choice.provider;
		if (!p || !store.providers[p] || ms(tombs()[p]) > ms(at)) return false;
		return slot !== 'def' || p === CREDITS || hasKey(p);
	}

	/// Remember each choice this device can run as it stands, for `standing`. Asked on
	/// every store write, so a merge, a press and a provider arriving all count.
	function noteRunnable() {
		var last = store.lastRun || (store.lastRun = {});
		CHOICES.forEach(function (slot) {
			var c = store[slot], at = store[slot + 'At'];
			if (c && runnable(c, at, slot)) last[slot] = { provider: c.provider, model: c.model || '', at: ms(at) };
		});
	}
	/// Move the default (the star). A pick equal to the new default now follows it, so it is
	/// cleared in the same change set (`setEveryone`).
	function setDefault(provider, model) { return setEveryone({ provider: provider, model: model }, false); }

	// ── The drafting model ──────────────────────────────────────────
	// The note→proposal drafting in triage.js runs on the CHAT model unless a model
	// is chosen HERE. This is the one global task routed to a model of its own, the
	// way a Diamond's vision and worker already are per Diamond. UNSET means "same as
	// chat", so the whole feature is exactly as it was until somebody chooses.

	function getDraft() { return getJob('drafting'); }
	function setDraft(provider, model) { setJob('drafting', provider, model); }

	/// A global Jobs pick -- `'drafting'`, `'workers'` or `'images'` -- as it stands here.
	function getJob(role) {
		var slot = JOB_SLOT[role];
		return slot ? standing(store[slot], store[slot + 'At'], slot) : { provider: '', model: '' };
	}

	/// Empty model clears the pick: the job falls back to the daimon. The provider is
	/// dropped with it, since a provider with no model names nothing.
	function setJob(role, provider, model) {
		var slot = JOB_SLOT[role];
		if (!slot) return;
		store[slot]         = { provider: model ? (provider || '') : '', model: model || '' };
		store[slot + 'At']  = DaimondStamp.next(store[slot + 'At']);	// which device chose last, for the merge
		save();
	}

	/// What the note→proposal drafting runs on: the drafting model when one is set,
	/// the chat model when it is not. The SAME shape `resolve` answers, so a caller
	/// cannot tell a defaulted run from a chosen one and the cost line prices
	/// whichever it actually is.
	function resolveDraft() {
		var dr = effective(null, 'drafting');
		if (dr.model) return resolve(dr.provider, dr.model);
		return resolve('', '');
	}

	// ── One resolver ────────────────────────────────────────────────
	// D-20261018-09 U1b. Every dispatch -- a chat turn, a worker, an image task, the drafting
	// and the summarising -- asks `effective`, and the chain is the spec's §3: the target's
	// own pick for the role, then the global Jobs pick, then the target's daimon (or chat)
	// model, then the default. The records are the page's; it hands over its reader once
	// (`bindPicks`), so this file reaches into nothing.

	var picks = null;	// the page's reader, from `bindPicks`

	/// Take the page's reader: `diamond(id)` and `chat(chat)` each answer the target's own
	/// `{ daimon, workers, images }` as `{ provider, model }` pairs, '' where unset, and
	/// `summarising()` the global Summarising pick. Its writers, for *Everyone uses*
	/// (U2a): `list()` names every target, `[{ target, name }]`; `clear(target, role)`
	/// clears one text pick ('daimon' or 'workers', or 'summarising' on `{ kind: 'jobs' }`)
	/// as the page's own stamped write; `set(target, role, pair)` writes one back, for Undo
	/// (U2b); `settle()` saves what a run of clears or sets left unsaved.
	function bindPicks(reader) { picks = reader || null; }

	function blankPair() { return { provider: '', model: '' }; }

	function ownPicks(target) {
		var got = null;
		if (picks && target && target.kind === 'diamond' && picks.diamond) got = picks.diamond(target.id);
		if (picks && target && target.kind === 'chat'    && picks.chat)    got = picks.chat(target.chat);
		got = got || {};
		return { daimon: got.daimon || blankPair(), workers: got.workers || blankPair(), images: got.images || blankPair(),
			effort: got.effort || { level: '', provider: '', model: '', at: 0 } };
	}

	/// A pick as it runs here, or null when it names no model or its provider cannot run
	/// here (no key, deleted), so the chain moves on to its next link.
	function runPick(pair, from) {
		if (!pair || !pair.model) return null;
		var r = resolve(pair.provider || '', pair.model);
		return r ? { provider: r.provider, model: r.model, from: from } : null;
	}

	/// What `role` runs on for `target`: `{ provider, model, from }`.
	///
	/// # Arguments
	/// * `target` - `{ kind: 'diamond', id }`, `{ kind: 'chat', chat }`, `{ kind: 'run',
	///   provider }` (a built conversation known only by its key, for Summarising) or null.
	/// * `role` - `'daimon'`, `'workers'`, `'images'`, `'drafting'` or `'summarising'`.
	///
	/// `from` names the link that answered: `'own'`, `'jobs'`, `'daimon'`, `'workers'` (an
	/// image task on the workers' own or Jobs pick) or `'default'`. The daimon's own pick is
	/// taken as stored, as `diamondModel` always has: a Diamond pinned to a provider with no
	/// key here asks for the key rather than spending on another one. Images stops at the
	/// global Images pick and otherwise runs where the workers do; `Workers.unseeable` moves
	/// a refused picture. Summarising rides the conversation's own key ("Same provider or
	/// nothing"), so a pick on another provider answers model '' -- the conversation's own.
	function effective(target, role) {
		var own = ownPicks(target);
		var d   = getDefault();
		var dm  = own.daimon.model
			? { provider: own.daimon.provider || '', model: own.daimon.model, from: 'own' }
			: { provider: d.provider || '', model: d.model || '', from: 'default' };
		if (role === 'daimon') return dm;
		// The third link, the daimon's (or chat's) model; with no target there is none.
		var up = target ? { provider: dm.provider, model: dm.model, from: 'daimon' } : dm;
		if (role === 'summarising') {
			var run = (target && target.kind === 'run') ? (target.provider || '') : up.provider;
			var sp  = (picks && picks.summarising && picks.summarising()) || blankPair();
			if (sp.model && (sp.provider || '') === run) return { provider: run, model: sp.model, from: 'jobs' };
			return { provider: run, model: '', from: up.from };
		}
		if (role === 'images') {
			var im = runPick(own.images, 'own') || runPick(getJob('images'), 'jobs');
			if (im) return im;
			var w = effective(target, 'workers');
			return (w.from === 'own' || w.from === 'jobs') ? { provider: w.provider, model: w.model, from: 'workers' } : w;
		}
		if (role === 'workers')  return runPick(own.workers, 'own') || runPick(getJob('workers'), 'jobs') || up;
		if (role === 'drafting') return runPick(getJob('drafting'), 'jobs') || up;
		return up;
	}

	// ── Everyone uses X (D-20261018-09 U2a) ─────────────────────────
	// One call moves the default and, in the same synchronous change set, every pick that only
	// restates it: a pick equal to the default is "follows" (§3). With Move Them Too every
	// text-model pick goes. Images never: an images model is chosen for what it can see, and no
	// text default stands in for one. No toast and no history here: a Diamond's note is written
	// at its next turn, when the model in force is seen to differ from its last turn's (U2c).

	function pairOf(p) { return { provider: (p && p.provider) || '', model: (p && p.model) || '' }; }

	/// Is `p` the pick `to`? The same provider and the same model; a pick naming no provider
	/// names the default's, which from this change on is `to`'s.
	function isPick(p, to) {
		return !!(p && p.model) && p.model === to.model && (p.provider || to.provider) === to.provider;
	}

	/// What moving the default to `to` clears, read and not written: `fields` (each with the
	/// target as the reader knows it, `ref` as an undo record names it, the role and the pick
	/// before), and the plan's `follow`, `own`, `equal` and `imagesKept`.
	///
	/// Without `moveAll` a pick is cleared only where clearing changes nothing that runs now. A
	/// daimon equal to `to` follows. A Workers pick falls back to the global Workers pick, and
	/// only then to its daimon, so it is cleared only where it equals `to`, the global pick (if
	/// any) is `to` too, and its daimon is on `to`; the global Workers pick only where every
	/// daimon that reads it is on `to`. Drafting falls back to the default, and Summarising is
	/// cleared when equal, as the migration clears it.
	function everyoneSweep(to, moveAll) {
		var out = { fields: [], follow: { daimons: 0, chats: 0 }, own: [], equal: [], imagesKept: [] };
		var d = pairOf(store.def);
		var moves = d.provider !== to.provider || d.model !== to.model;	// do followers switch?
		var held  = false;	// does a daimon other than `to` read the global Workers pick?
		var list  = (picks && typeof picks.list === 'function' && picks.list()) || [];
		var gw    = pairOf(store.workers);
		var gwTo  = !gw.model || isPick(gw, to);	// is the next link of an own Workers pick `to`?
		list.forEach(function (t) {
			var kind = t.target.kind, own = ownPicks(t.target);
			var ref  = kind === 'chat' ? { kind: 'chat', id: (t.target.chat && t.target.chat.id) || t.target.id || '' }
				: { kind: kind, id: t.target.id };
			var who  = { name: t.name || '', kind: kind, roles: [] };
			var dEq  = isPick(own.daimon, to);
			var dGo  = !!own.daimon.model && (moveAll || dEq);
			var onTo = !own.daimon.model || dGo;	// its daimon runs on `to` from now
			var wGo  = !!own.workers.model && (moveAll || (onTo && gwTo && isPick(own.workers, to)));
			if (dGo) out.fields.push({ target: t.target, ref: ref, role: 'daimon',  before: pairOf(own.daimon) });
			if (wGo) out.fields.push({ target: t.target, ref: ref, role: 'workers', before: pairOf(own.workers) });
			if (!own.daimon.model && moves) out.follow[kind === 'chat' ? 'chats' : 'daimons']++;
			if (own.daimon.model && !dGo)   who.roles.push('daimon');
			if (own.workers.model && !wGo)  who.roles.push('workers');
			if (who.roles.length) out.own.push(who);
			if (dEq) out.equal.push({ name: who.name, kind: kind, roles: ['daimon'] });
			if (own.images.model) out.imagesKept.push({ name: who.name, kind: kind, roles: ['images'] });
			if (!onTo && !(own.workers.model && !wGo)) held = true;
		});
		var jobs = { kind: 'jobs' };
		var job  = function (role, pick, go) {
			var who = { name: '', kind: 'jobs', roles: [role] };
			if (!pick.model) return;
			if (go) out.fields.push({ target: jobs, ref: jobs, role: role, before: pick });
			else out.own.push(who);
			if (isPick(pick, to)) out.equal.push(who);
		};
		var dr = pairOf(store.draft), wk = gw;
		var sp = pairOf(picks && typeof picks.summarising === 'function' && picks.summarising());
		job('drafting',    dr, moveAll || isPick(dr, to));
		job('workers',     wk, moveAll || (isPick(wk, to) && !held));
		job('summarising', sp, moveAll || isPick(sp, to));
		if (pairOf(store.images).model) out.imagesKept.push({ name: '', kind: 'jobs', roles: ['images'] });
		return out;
	}

	/// What *Everyone uses* `pick` would do, for the confirm: `follow` counts the daimons and
	/// chats that switch at their next turn; `own` names each exception Keep Theirs keeps, with
	/// the `roles` it keeps; `equal` the picks already on `pick`, which now follow and are never
	/// named; `imagesKept` the Images picks, which stay either way. Writes nothing.
	function planEveryone(pick) {
		var to = pairOf(pick);
		var sw = everyoneSweep(to, false);
		return { follow: sw.follow, own: sw.own, equal: sw.equal, imagesKept: sw.imagesKept };
	}

	/// Everyone uses `pick`: set the default and clear every pick equal to it; with `moveAll`
	/// (Move Them Too) every text-model pick. One synchronous change set, so one store write and
	/// one sync parcel. The undo record, `{ def: { wrote, before }, fields: [{ target, role,
	/// wrote, before }], efforts: [{ target, before, at }] }`, holds every pair it wrote over,
	/// for a compare-and-set Undo (U2b), and each Diamond's Effort as it stood: a model that
	/// lacks the level drops it at the next read (`diamondEffort`), and Undo brings it back.
	function setEveryone(pick, moveAll) {
		var to   = pairOf(pick);
		var sw   = to.model ? everyoneSweep(to, !!moveAll) : { fields: [] };
		var undo = { def: { wrote: pairOf(to), before: pairOf(store.def) }, fields: [], efforts: [] };
		var list = (picks && typeof picks.list === 'function' && picks.list()) || [];
		list.forEach(function (t) {
			var e = t.target.kind === 'diamond' && ownPicks(t.target).effort;
			if (e && e.level) undo.efforts.push({ target: { kind: 'diamond', id: t.target.id },
				before: { level: e.level, provider: e.provider || '', model: e.model || '' }, at: +e.at || 0 });
		});
		store.def   = to;
		store.defAt = DaimondStamp.next(store.defAt);		// which device chose last, for the merge
		sw.fields.forEach(function (f) {
			var slot = f.target.kind === 'jobs' && JOB_SLOT[f.role];
			if (slot) {
				store[slot]        = blankPair();
				store[slot + 'At'] = DaimondStamp.next(store[slot + 'At']);
			} else if (picks && typeof picks.clear === 'function') {
				picks.clear(f.target, f.role);
			} else {
				return;
			}
			undo.fields.push({ target: f.ref, role: f.role, wrote: blankPair(), before: f.before });
		});
		if (picks && typeof picks.settle === 'function') picks.settle();
		save();
		return undo;
	}

	// ── Undo, compare-and-set (D-20261018-09 U2b) ───────────────────
	// Undo puts back each field, and the default, only where it still holds what
	// `setEveryone` wrote. A field changed since, here or on another device, is a newer
	// decision and stays. Each restore is the ordinary stamped write, so it travels.

	function samePair(a, b) {
		var x = pairOf(a), y = pairOf(b);
		return x.provider === y.provider && x.model === y.model;
	}

	/// Undo an *Everyone uses* record (`setEveryone`'s return): `{ restored, kept }`, where
	/// `kept` names each field left alone because it changed since, as `{ name, kind, role }`
	/// (the default as `{ name: '', kind: 'default', role: 'default' }`). One change set.
	function undoEveryone(rec) {
		var out = { restored: 0, kept: [] };
		if (!rec || typeof rec !== 'object') return out;
		var list  = (picks && typeof picks.list === 'function' && picks.list()) || [];
		var named = function (ref) {
			var hit = list.filter(function (t) {
				var id = t.target.kind === 'chat' ? ((t.target.chat && t.target.chat.id) || t.target.id) : t.target.id;
				return t.target.kind === ref.kind && id === ref.id;
			})[0];
			return hit || null;
		};
		var defBack = false;	// is the default put back?
		var pinned  = {};		// Diamond id -> was its own model put back?
		if (rec.def && rec.def.wrote) {
			if (samePair(store.def, rec.def.wrote)) {
				store.def   = pairOf(rec.def.before);
				store.defAt = DaimondStamp.next(store.defAt);
				defBack     = true;
				out.restored++;
			} else {
				out.kept.push({ name: '', kind: 'default', role: 'default' });
			}
		}
		(rec.fields || []).forEach(function (f) {
			var ref = f.target || {}, slot = ref.kind === 'jobs' && JOB_SLOT[f.role];
			var t   = ref.kind === 'jobs' ? { target: { kind: 'jobs' }, name: '' } : named(ref);
			var own = ref.kind === 'diamond' && f.role === 'daimon';
			if (own) pinned[ref.id] = false;
			var now = !t ? null
				: slot ? pairOf(store[slot])
				: ref.kind === 'jobs' ? (f.role === 'summarising' && picks && typeof picks.summarising === 'function'
					? pairOf(picks.summarising()) : null)
				: (ownPicks(t.target)[f.role] || null);
			if (!now || !samePair(now, f.wrote)) {
				out.kept.push({ name: (t && t.name) || '', kind: ref.kind || '', role: f.role });
				return;
			}
			if (own) pinned[ref.id] = true;
			if (samePair(now, f.before)) return;
			if (slot) {
				store[slot]        = pairOf(f.before);
				store[slot + 'At'] = DaimondStamp.next(store[slot + 'At']);
			} else if (picks && typeof picks.set === 'function') {
				picks.set(t.target, f.role, pairOf(f.before));
			} else {
				if (own) pinned[ref.id] = false;
				out.kept.push({ name: t.name || '', kind: ref.kind || '', role: f.role });
				return;
			}
			out.restored++;
		});
		// An Effort level the meanwhile model lacked was dropped quietly, on its own stamp. Put it
		// back with the model only where it is still that drop: an Effort chosen since, here or on
		// another device, moved the stamp and stays. A level that never dropped needs nothing.
		// The level goes back only onto the model it was set for: the Diamond's own model, or
		// the default it still follows, put back above. A model picked since keeps no stray level.
		(rec.efforts || []).forEach(function (e) {
			var t = e && e.target && named(e.target);
			if (!t || !e.before || !e.before.level || !picks || typeof picks.set !== 'function') return;
			var own = ownPicks(t.target);
			var back = Object.prototype.hasOwnProperty.call(pinned, e.target.id) ? pinned[e.target.id]
				: defBack && !own.daimon.model;
			if (!back) return;
			var now = own.effort;
			if (now.level || (+now.at || 0) !== (+e.at || 0)) return;
			picks.set(t.target, 'effort', e.before);
			out.restored++;
		});
		if (picks && typeof picks.settle === 'function') picks.settle();
		save();
		return out;
	}

	/// The default as this device stands on it, for *Everyone uses*: `pick` as chosen and
	/// synced, `here` whether this device can run it, `using` what it runs instead (the last
	/// default it could, `standing`'s fallback; blank when none) and `missing` the display
	/// name of the provider it lacks, '' when `here`.
	function everyoneStanding() {
		var pick  = pairOf(store.def);
		var using = pairOf(getDefault());
		var here  = !pick.model || samePair(pick, using);
		return { pick: pick, here: here, using: using, missing: here ? '' : providerName(pick.provider) };
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
		var gone = store.providers[id];
		delete store.providers[id];
		delete plain[id];
		delete probes[id];					// no floor to hold back a key that is gone
		// Before the store is written, so the very next push carries the deletion:
		// there is one way into this function and every delete in the panel comes
		// through it, which is what keeps the tombstone from being forgotten at one
		// of several call sites.
		// The tombstone also clears a default or drafting model on this provider:
		// see `standing`. Not a write to the choice itself, so a choice another
		// device made meanwhile is not undone by this deletion (SIM-18).
		// Stamped past the row it removes, so the deletion outranks every copy of that
		// row whatever the clocks: a row touched by a device whose clock runs ahead, or a
		// millisecond ago, would otherwise outrank the removal and come back on the save.
		tombstone(id, gone ? DaimondStamp.next(gone.touched) : 0);
		save();
	}

	/// Does an incoming choice `{ value, at }` win over this one? The later stamp,
	/// and at an equal stamp the greater value, so two devices reach one answer
	/// whichever parcel arrives first (A3). Never on the provider being here: that
	/// made the merge depend on arrival order, and is asked when the choice is read.
	function choiceWins(rv, rAt, mv, mAt) {
		if (rAt !== mAt) return rAt > mAt;
		var r = (rv.provider || '') + '\n' + (rv.model || ''), m = (mv.provider || '') + '\n' + (mv.model || '');
		return r > m;
	}

	/// The providers deleted on purpose, by id, with anything past its TTL pruned.
	/// The map, the TTL and the union rule are DaimondCore's — one deletion policy
	/// for chats, Diamonds, providers and mailboxes rather than four. A page
	/// without the core module cannot sync at all, so an empty map there is the
	/// truth rather than a fallback.
	function tombs() {
		return (window.DaimondCore && DaimondCore.tombs) ? DaimondCore.tombs(TOMBS) : {};
	}
	function tombstone(id, at) {
		if (window.DaimondCore && DaimondCore.tombstone) DaimondCore.tombstone(TOMBS, id, at);
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
			var priced = !!r && typeof r.in === 'number' && typeof r.out === 'number';
			var sighted = !!r && typeof r.sees === 'boolean';
			var levelled = !!r && Array.isArray(r.efforts) && r.efforts.length > 0;
			var named = !!r && typeof r.name === 'string' && r.name !== '';
			if (!priced && !sighted && !levelled && !named) return;
			var row = priced ? { in: r.in, out: r.out } : {};
			if (named) row.name = r.name;
			if (priced && typeof r.cached === 'number') row.cached = r.cached;
			if (priced && typeof r.ctx    === 'number') row.ctx    = r.ctx;
			if (priced && typeof r.img    === 'number') row.img    = r.img;
			if (sighted) row.sees = r.sees;
			if (levelled) {
				row.efforts = r.efforts.map(String);
				if (typeof r.effortDefault === 'string' && r.effortDefault) row.effortDefault = r.effortDefault;
			}
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
	///
	/// A LOCKED (or identity-less) device publishes NOTHING here, the same rule
	/// `DaimondPost.snapshot()` and the look record keep. The whole parcel is already
	/// gated on an unlocked identity (`sync.ready`), so this is defence in depth rather
	/// than the primary guard -- but it keeps the section honest on its own terms, so no
	/// caller can put a store this device cannot currently read onto the wire, and a
	/// `null` reads to the merge on the far side as "nothing to say" (see `applySync`).
	function exportSync() {
		if (window.DaimondIdentity && DaimondIdentity.isUnlocked && !DaimondIdentity.isUnlocked()) return null;
		var out = {
			v:     2,
			def:   { provider: store.def.provider || '', model: store.def.model || '' },
			defAt: ms(store.defAt),
			draft:   { provider: (store.draft && store.draft.provider) || '',
				model:  (store.draft && store.draft.model)  || '' },
			draftAt: ms(store.draftAt),
			providers: {},
			// What was deleted here, so the other device deletes it too rather than
			// handing it back on the next pull.
			tombs: sortedTombs(),
		};
		// The Jobs picks travel once made, so a store with none sends the bytes it always did.
		['workers', 'images'].forEach(function (slot) {
			if (!ms(store[slot + 'At'])) return;
			out[slot] = { provider: (store[slot] && store[slot].provider) || '', model: (store[slot] && store[slot].model) || '' };
			out[slot + 'At'] = ms(store[slot + 'At']);
		});
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
		// The money pools' top-up marks (D-20261020-13), so two devices draw one level. Sent
		// only once there is one, so a store with none sends the bytes it always did.
		var marks = window.DaimondMoney ? DaimondMoney.marksParcel(store.topups) : {};
		if (Object.keys(marks).length) out.topups = marks;
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
	/// And a DIVERGENT identity is the one case where a fresher row must NOT win the key. A
	/// re-minted device (a new phone) shares neither salt nor wrapping key, so a sealed key it
	/// receives will not open on it. Where this device holds a key it CAN read and the incoming
	/// sealed key does not unwrap here, the readable one is kept: a synced key that is a dead
	/// credential on this device must never bury a working one — that clobber would otherwise
	/// show only after a reload, as a device that used to run dropping into the re-enter prompt.
	/// A row with no readable key of its own still adopts the unreadable sealed key, so it lands
	/// in the compose-resilience "this device can't read your keys" path rather than a silent
	/// dead end. See the adopt loop below.
	///
	/// A parcel with no `models` section (a v1 or early-v2 device) is a no-op, so an old device
	/// and a new one sync happily in both directions.
	async function applySync(remote) {
		if (!remote || typeof remote !== 'object' || !remote.providers
			|| typeof remote.providers !== 'object') return { added: 0, updated: 0 };
		var added = 0, updated = 0, adopt = [], guard = {};
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
				// The later configuration, and at an equal stamp the canonically greater
				// one, the same on every device.
				if (DaimondStamp.beats(stamp, configOf(r), mine.touched, configOf(mine))) {
					mine.name = String(r.name || mine.name || '');
					mine.url  = String(r.url  || mine.url  || '');
					// An empty `keyEnc` on the other side is not an instruction to forget this
					// device's key: it means that device never had one.
					if (r.keyEnc && r.keyEnc !== mine.keyEnc) {
						// A readable local key must survive an incoming sealed one this
						// device cannot open (a DIVERGENT identity -- a re-minted phone
						// shares neither salt nor wrapping key). Remember it, so the adopt
						// phase below can put it back when the newcomer will not unwrap:
						// losing a working key to a dead one is the clobber the merge must
						// never do, and it would otherwise surface only after a reload,
						// dropping the device into the re-enter prompt holding a key that
						// used to work.
						if (plain[id]) guard[id] = { keyEnc: mine.keyEnc, key: mine.key, plain: plain[id] };
						mine.keyEnc = r.keyEnc;
						mine.key    = '';
						adopt.push(id);
					}
					mine.touched = stamp;
					updated++;
				}
				if (DaimondStamp.beats(fetched, [models, rates || null], mine.fetched,
						[(Array.isArray(mine.models) ? mine.models.slice() : []).sort(), sortedRates(mine.rates) || null])) {
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
				if (!(typeof c.baseAt === 'number')
					|| DaimondStamp.beats(r.credit.baseAt, r.credit.baseUsd, c.baseAt, c.baseUsd)) {
					mine.credit = {
						mode:         c.mode === 'auto' ? 'auto' : 'manual',
						remainingUsd: (typeof c.remainingUsd === 'number') ? c.remainingUsd : null,
						asOf:         (typeof c.asOf === 'number') ? c.asOf : null,
						binds:        c.binds || '',
						baseUsd:      r.credit.baseUsd,
						baseAt:       r.credit.baseAt,
					};
					updated++;
				}
			}
		});
		// The default and each Jobs pick are ONE choice with its stamp, and the
		// later choice wins -- a cleared one included, since clearing is stamped too. Taken
		// whole and on nothing else, so the merge is the same in any order (SIM-18); a
		// choice whose provider is not here reads as unset until it is (`resolve`).
		CHOICES.forEach(function (slot) {
			var r = remote[slot], rAt = ms(remote[slot + 'At']);
			if (!r || typeof r !== 'object'
				|| !choiceWins(r, rAt, store[slot] || { provider: '', model: '' }, ms(store[slot + 'At']))) return;
			store[slot]          = { provider: String(r.provider || ''), model: String(r.model || '') };
			store[slot + 'At']   = rAt;
			updated++;
		});
		// Each pool's top-up mark on its own time, the later top-up winning. An old build's
		// parcel has none, and changes nothing here.
		if (remote.topups && typeof remote.topups === 'object' && window.DaimondMoney
			&& DaimondMoney.marksMerge(store.topups = store.topups || {}, remote.topups)) updated++;
		// Fill the gaps in the plaintext cache, never overwrite it.
		if (window.DaimondIdentity && DaimondIdentity.isUnlocked()) {
			for (var i = 0; i < adopt.length; i++) {
				var pid = adopt[i];
				// A row whose readable key was just replaced by an incoming sealed one:
				// adopt the newcomer only if it OPENS on this device. If it does not (a
				// divergent identity), put the readable key back -- a synced key we cannot
				// read must never bury a working one. When it DOES open (an ordinary key
				// rotation on the shared identity) nothing is restored and the in-memory
				// key is still left alone this session, exactly as the gap-fill below.
				// Each row is read again after its await, and acted on only while it still
				// holds the sealed key that was adopted: another tab may have saved meanwhile.
				var row = store.providers[pid], enc = row ? row.keyEnc : '';
				if (!row) continue;
				if (guard[pid]) {
					var opens = true;
					try { await DaimondIdentity.unwrap(enc); }
					catch (e) { opens = false; }
					row = store.providers[pid];
					if (!opens && row && row.keyEnc === enc) {
						row.keyEnc = guard[pid].keyEnc;
						row.key    = guard[pid].key;
						if (!plain[pid]) plain[pid] = guard[pid].plain;
					}
					continue;							// this session's key stays this session's
				}
				if (plain[pid]) continue;				// this session's key stays this session's
				var opened = '';
				try { opened = await DaimondIdentity.unwrap(enc); }
				catch (e) { opened = ''; }				// sealed under something this device cannot open; leave it keyless
				row = store.providers[pid];
				if (opened && row && row.keyEnc === enc && !plain[pid]) plain[pid] = opened;
			}
		}
		if (added || updated) {
			var landed = save();
			if (document.getElementById('models-list')) render();
			// Merged here and held owed, but not stored: the section is re-pulled
			// rather than read as applied (SIM-16, A5).
			if (!landed) throw window.DaimondStore.refusal(KEY);
		}
		return { added: added, updated: updated };
	}

	// ── Top-up marks (D-20261020-13) ────────────────────────────────
	// The full height of each money pool: its balance right after the last top-up
	// (D-20261015-14), `{ full, at }` synced in the parcel and `last`, this device's
	// own last reading, kept beside it. Until this build the marks lived in this
	// device's localStorage alone, so two devices drew two levels for one pool.

	var CREDCYL = 'daimond-credcyl';		// the per-device copy this replaces
	var credcylRead = false;

	/// Take the per-device marks once, as a seed under the synced ones, and retire
	/// them. A single own key's cylinder was keyed 'own'; it seeds that key's pool.
	function seedTopups() {
		if (credcylRead) return false;
		credcylRead = true;
		var old = null, seeded = false;
		try { old = JSON.parse(localStorage.getItem(CREDCYL) || 'null'); } catch (e) { old = null; }
		if (old && typeof old === 'object') {
			var marks = store.topups = store.topups || {};
			var own = Object.keys(store.providers).filter(function (id) { return id !== CREDITS && hasKey(id); });
			Object.keys(old).forEach(function (k) {
				var o = old[k];
				var key = (k === 'own') ? (own.length === 1 ? own[0] : '') : k;
				if (!key || marks[key] || !o || typeof o.peak !== 'number' || !isFinite(o.peak)) return;
				marks[key] = { full: o.peak, at: 0, last: (typeof o.last === 'number') ? o.last : o.peak };
				seeded = true;
			});
		}
		try { localStorage.removeItem(CREDCYL); } catch (e) { /* it is simply read again */ }
		return seeded;
	}

	/// Write the store without `onChange`. The marks are noted from a paint (the rail's
	/// money rows and Balance cell), and `onChange` repaints the rail and nudges a sync
	/// push: from inside a paint that is a nested repaint and a push per top-up seen,
	/// which flipped verify_credits' rail row to "No credits account" mid-run. A mark is
	/// not urgent; it travels in the next parcel, which the next turn's spend pushes.
	function saveQuiet() {
		takeDisk();
		noteRunnable();
		return window.DaimondStore.put(KEY, store, storeLaw);
	}

	/// The top-up marks by pool key, for `DaimondMoney.pools`.
	function topups() {
		if (seedTopups()) saveQuiet();
		return copy(store.topups || {});
	}

	/// Keep each pool's mark as `DaimondMoney.pools` left it. Stored only when a
	/// full height moved, which is once a top-up, so a repaint never writes.
	function noteTopups(list) {
		var marks = store.topups = store.topups || {}, moved = false;
		(list || []).forEach(function (p) {
			var m = p && p.key && p.mark;
			if (!m || typeof m.full !== 'number') return;
			var was = marks[p.key];
			if (!was || was.full !== m.full || (+was.at || 0) !== (+m.at || 0)) moved = true;
			marks[p.key] = { full: m.full, at: +m.at || 0, last: m.last };
		});
		if (moved) saveQuiet();
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
		// [glyph role, words]: the glyph is drawn by its `.lead-*` role, never typed (app.css).
		if (!p.minted) {
			return p.sealed ? ['lead-lock', t('models.sealed')]
				: p.hasKey ? ['lead-key', t('models.key_set')] : ['lead-warn', t('models.no_key')];
		}
		switch (p.state) {
			case 'ready':     return ['', ''];                        // the balance says it better
			case 'minting':   return ['lead-wait', t('models.connecting')];
			case 'nocredits': return ['lead-warn', t('models.no_credits')];
			case 'offline':   return ['lead-warn', t('models.offline')];
			case 'failed':    return ['lead-warn', t('models.could_not_connect')];
			default:          return ['lead-lock', t('models.unlock_to_use')];
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

	/// This model's OpenRouter routing, as rows of hosts (D-20261018-09 U5b): one row per host
	/// measured for it (`DaimondHostSpeed.figures()`, D-20261020-10) with its first token, rate,
	/// stalls and rounds, the host used last marked, a host the measurement is leaving out shown as
	/// Avoided with the reason, and an Auto / Prefer / Avoid choice that writes the same stored text
	/// the typed field did (`DaimondRoutingRows` holds the mapping; `parseRouting` reads it), so the
	/// engine and an older build read it unchanged.  A stored value the rows cannot say is shown as
	/// typed, with a Clear, never rewritten.  Drawn from the store on every render.  Appended to `box`;
	/// the only place routing is drawn.
	///
	/// A disclosure per model: open from the start when the model has measured rounds or a stored
	/// choice, otherwise closed until the person opens it, and kept as they left it (`routeOpen`).
	/// Opening it asks OpenRouter which hosts serve that one model (`askHosts`, held by
	/// `DaimondRoutingRows.hostCache`: 30 min, 64 models, in memory), so a model nobody has measured
	/// still has hosts to Prefer or Avoid; closed rows ask nothing.
	function routingFor(providerId, model, box) {
		var RR   = window.DaimondRoutingRows;
		var typed = routing(providerId, model);
		var p    = parseRouting(typed);
		var figs = window.DaimondHostSpeed ? window.DaimondHostSpeed.figures() : [];
		var loc  = window.DaimondI18n && DaimondI18n.locale ? DaimondI18n.locale() : undefined;
		var num  = function (v, dp) {
			try { return Number(v).toLocaleString(loc, { maximumFractionDigits: dp || 0 }); }
			catch (e) { return String(Math.round(v)); }
		};
		var el = function (tag, cls, text) {
			var n = document.createElement(tag);
			if (cls) n.className = cls;
			if (text != null) n.textContent = text;
			return n;
		};
		var write = function (q) { setRouting(providerId, model, RR.text(q)); render(); };
		var k    = providerId + '\n' + model;
		var disc = el('details', 'models-routing');
		disc.dataset.routeKey = k;
		disc.open = k in routeOpen ? routeOpen[k]
			: !!typed || figs.some(function (f) { return f && f.model === model; });
		disc.appendChild(el('summary', 'models-route-head', t('models.route_head')));
		var wrap = el('div', 'models-route-body');
		disc.appendChild(wrap);
		box.appendChild(disc);
		if (!RR) return;
		var plain = RR.expressible(p);
		var fill = function () {
			wrap.textContent = '';
			var got   = hostCache() ? hostCache().get(model) : null;
			var rows  = RR.rows(plain ? p : { order: [], ignore: [], only: false }, figs, model, got ? got.hosts : []);
			if (!rows.length && plain) wrap.appendChild(el('div', 'models-route-none',
				t(got && got.state === 'busy' ? 'models.route_asking' : 'models.route_none')));
			if (got && got.state === 'failed') wrap.appendChild(el('div', 'models-route-none', t('models.route_ask_failed')));
			rows.forEach(function (r) {
				var row = el('div', 'models-route-row');
				row.dataset.host = r.host;
				var top = el('div', 'models-route-top');
				top.appendChild(el('span', 'models-route-host', r.host));
				if (r.last) top.appendChild(el('span', 'models-route-last', t('models.route_last')));
				row.appendChild(top);
				if (r.fig) {
					var f = r.fig, bits = [];
					if (f.firstMs != null) bits.push(t('models.route_first', { s: num(f.firstMs / 1000, 1) }));
					if (f.tps != null) bits.push(t('models.route_tps', { tps: num(f.tps) }));
					var st = Math.round(f.stallShare * f.rounds);
					if (st) bits.push(tn('models.route_stalls', st));
					bits.push(tn('models.route_rounds', f.rounds));
					row.appendChild(el('div', 'models-route-figs', bits.join(' · ')));
					var why = RR.reason(r);
					if (why && RR.avoided(r, p.only)) {
						var v = why.vars, said =
							  why.kind === 'stalls' ? tn('models.route_why_stalls', why.n, v)
							: why.kind === 'behind' ? tn('models.route_why_behind', why.n, { tps: num(v.tps), best: num(v.best) })
							: why.kind === 'wait'   ? tn('models.route_why_wait', why.n, v)
							:                         tn('models.route_why_rate', why.n, { tps: num(v.tps) });
						row.appendChild(el('div', 'models-route-why', said));
					} else if (why && r.choice === 'prefer') {
						row.appendChild(el('div', 'models-route-why kept', t('models.route_kept')));
					}
				} else {
					row.appendChild(el('div', 'models-route-figs', t('models.route_none')));
				}
				if (plain) {
					var said3 = { auto: t('models.route_auto'), prefer: t('models.route_prefer'), avoid: t('models.route_avoid') };
					var seg = el('div', 'seg models-route-seg');
					seg.setAttribute('role', 'group');
					seg.setAttribute('aria-label', t('models.route_for', { host: r.host }));
					['auto', 'prefer', 'avoid'].forEach(function (what) {
						var b = el('button', 'models-route-btn', said3[what]);
						b.type = 'button';
						b.dataset.choice = what;
						b.setAttribute('aria-pressed', r.choice === what ? 'true' : 'false');
						b.addEventListener('click', function () {
							if (r.choice !== what) write(RR.set(p, r.host, what));
						});
						seg.appendChild(b);
					});
					row.appendChild(seg);
				}
				wrap.appendChild(row);
			});
			if (plain && rows.length) {
				var lab = el('label', 'models-route-only');
				var cb  = el('input');
				cb.type = 'checkbox';
				cb.checked = p.only;
				cb.disabled = !p.order.length;	// "only these" of nothing would refuse every host
				cb.addEventListener('change', function () { write(RR.setOnly(p, cb.checked)); });
				lab.appendChild(cb);
				lab.appendChild(document.createTextNode(t('models.route_only')));
				wrap.appendChild(lab);
			}
			if (!plain) {
				var odd = el('div', 'models-route-odd');
				odd.appendChild(el('span', 'models-route-typed', t('models.route_typed', { text: typed })));
				var clr = el('button', 'models-route-clear', t('models.route_clear'));
				clr.type = 'button';
				clr.addEventListener('click', function () { setRouting(providerId, model, ''); render(); });
				odd.appendChild(clr);
				wrap.appendChild(odd);
			}
		};
		disc._fill = fill;
		var ask = function () {
			var c = hostCache();
			if (c) c.want(model, function () { return askHosts(providerId, model); }, function () {
				// The answer lands after the draw: refill whichever copy of this detail is on screen now.
				document.querySelectorAll('details.models-routing').forEach(function (d) {
					if (d.dataset.routeKey === k && d.open && d._fill) d._fill();
				});
			});
		};
		disc.addEventListener('toggle', function () {
			routeOpen[k] = disc.open;
			if (disc.open) { ask(); fill(); }
		});
		if (disc.open) { ask(); fill(); }
	}

	var routeOpen = {};		// providerId + '\n' + model -> the person left its routing open (true) or shut
	var routeHosts = null;

	/// The one cache of OpenRouter's hosts per model; see `DaimondRoutingRows.hostCache` for its bounds.
	function hostCache() {
		if (!routeHosts && window.DaimondRoutingRows) routeHosts = window.DaimondRoutingRows.hostCache();
		return routeHosts;
	}

	/// OpenRouter's list of the hosts serving `model`: GET `/models/{author}/{slug}/endpoints`.  A
	/// public listing, so no key is sent.  A `:free`-style variant asks for its base model, whose
	/// list includes the variant's hosts.  Throws on anything but a 2xx, so the cache records a
	/// failure rather than an empty list.
	async function askHosts(providerId, model) {
		var url = providerUrl(providerId);
		if (!url || !canProbeCredit(url)) throw new Error('not an OpenRouter endpoint');
		var path = String(model).split(':')[0].split('/').map(encodeURIComponent).join('/');
		var r = await fetch(siblingUrl(url, 'models/' + path + '/endpoints'));
		if (!r.ok) throw new Error('HTTP ' + r.status);
		return r.json();
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
					when:   window.DaimondTime.fmtLocal(c.asOf, 'when'),
				});
			}
			return t('models.credit_auto', { amount: usd(c.usd), when: window.DaimondTime.fmtLocal(c.asOf, 'when') });
		}
		if (c && c.mode === 'manual') {
			return t('models.credit_manual', {
				amount: usd(c.usd),
				base:   usd(c.baseUsd),
				spent:  usd(c.spentUsd),
				when:   window.DaimondTime.fmtLocal(c.baseAt, 'when'),
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
		if (line) DaimondI18n.fillPrices(line, creditSentence(c));
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
		if (c) bal.textContent = t('models.balance_left', { amount: DaimondI18n.held(c.usd, 'USD') });
		var words = ageSentence(id, c);
		if (words) bal.setAttribute('title', words); else bal.removeAttribute('title');
		if (words && creditStale(id, c)) bal.setAttribute('data-stale', '1');
		else bal.removeAttribute('data-stale');
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
		//
		// The catalogue joins on exactly those terms, and needed its own gate to do it: an ask
		// that answers ends in `save()`, and `save()` is a redraw. Same shape, same trap, and
		// see the paragraph above `refreshLists` for what the second gate holds back that the
		// first one could not have.
		//
		// The `else` is not decoration; see `askWhenShown`. The one redraw that matters most —
		// the panel being opened — happens while the panel is still hidden, so the test above is
		// false at exactly the moment it was written for.
		if (onScreen(el)) { refreshCredits(); refreshLists(); }
		else askWhenShown();
		el.innerHTML = '';

		var list = providers();
		if (!list.length) {
			el.appendChild(html('<div class="models-empty">' + esc(t('models.empty')) + '</div>'));
			return;
		}

		// The top half, once there is a model to choose: one answer, its exceptions, the jobs.
		if (list.some(function (p) { return p.count > 0; })) {
			el.appendChild(everyoneBlock());
			var exc = exceptBlock();
			if (exc) el.appendChild(exc);
			el.appendChild(jobsBlock());
		}

		renderProviders(el);

		var d = getDefault();

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

	// ── The Models view, top half (D-20261018-09 U3a) ───────────────
	// *Everyone uses*, then *Except*, then *Jobs*, above the providers: one answer at the top and
	// a short list of exceptions. The confirm and the Undo line are module state, not DOM: `render`
	// redraws on every store change, and a confirm held only in the DOM went at the first pull.

	var everyoneAsk  = null;	// { to }: a change waiting on Move Them Too or Keep Theirs
	var everyoneDone = null;	// { undo, to } after a change; { kept } after its Undo

	var JOB_ROLES = ['workers', 'images', 'drafting', 'summarising'];

	function elt(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	}

	/// A list of names as the reader's language joins them ("Daimond and Email").
	function joinNames(names) {
		try { return new Intl.ListFormat(window.DaimondI18n ? DaimondI18n.locale() : 'en',
			{ style: 'long', type: 'conjunction' }).format(names); }
		catch (e) { return names.join(', '); }
	}

	/// "4 daimons and 2 chats", leaving out a kind there is none of.
	function countWhat(daimons, chats) {
		var parts = [];
		if (daimons) parts.push(DaimondI18n.tn('models.n_daimons', daimons));
		if (chats)   parts.push(DaimondI18n.tn('models.n_chats', chats));
		return joinNames(parts);
	}

	/// What one typical turn on `pair` costs: under a US cent in tenths of a cent ("0.2¢"),
	/// otherwise the money figure. '' with nothing to go on.
	function turnCost(pair) {
		var tt = (window.DaimondLedger && DaimondLedger.typicalTurn && pair.model)
			? DaimondLedger.typicalTurn(pair.provider, pair.model) : null;
		if (!tt || !isFinite(tt.usd) || tt.usd < 0) return '';
		if (DaimondI18n.currency() === 'USD' && tt.usd > 0 && tt.usd < 0.01) {
			var c = Math.max(tt.usd * 100, 0.1);
			return new Intl.NumberFormat(DaimondI18n.locale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 })
				.format(c) + '¢';
		}
		return DaimondI18n.money(tt.usd, 'fine');
	}

	/// The name a plan or an Undo gives one field's owner: a Diamond or chat by its name, a
	/// Jobs pick by its job, the default as "The default". Nameless records go unnamed.
	function ownerName(o) {
		if (o.kind === 'default') return t('models.the_default');
		if (o.kind === 'jobs')    return t('models.job_' + ((o.roles && o.roles[0]) || o.role || ''));
		return o.name || '';
	}

	/// The named Diamonds and chats, `[{ target, name }]`.
	function namedTargets() {
		var list = (picks && typeof picks.list === 'function' && picks.list()) || [];
		return list.filter(function (x) { return !!x.name; });
	}

	function secHead(text) { return elt('div', 'models-head', text); }

	/// *Everyone uses*: the default as chosen, the turn it costs, and the confirm or Undo line.
	function everyoneBlock() {
		var box = elt('div', 'models-everyone');
		box.appendChild(secHead(t('models.everyone_head')));
		var st  = everyoneStanding();
		var cur = everyoneAsk ? everyoneAsk.to : st.pick;

		var sel = elt('select', 'settings-select models-everyone-sel');
		box.appendChild(sel);
		fillSelect(sel, cur.provider, cur.model);
		picker(sel);
		sel.addEventListener('change', function () {
			var g = pick(sel);
			everyoneDone = null;
			if (!g.model || samePair(g, st.pick)) { everyoneAsk = null; render(); return; }
			if (!planEveryone(g).own.length) {
				everyoneAsk  = null;
				everyoneDone = { undo: setEveryone(g, false), to: g };
			} else {
				everyoneAsk = { to: g };
			}
			render();
		});

		var cost = turnCost(cur);
		if (cost) box.appendChild(elt('div', 'models-sub models-turn', t('models.turn_cost', { cost: cost })));
		if (!st.here && !everyoneAsk) {
			box.appendChild(elt('div', 'models-sub models-not-here', st.using.model
				? t('models.everyone_not_here', { provider: st.missing, model: displayName(st.using.provider || '', st.using.model) })
				: t('models.everyone_not_here_none', { provider: st.missing })));
		}
		if (everyoneAsk)  box.appendChild(askBox(everyoneAsk.to));
		else if (everyoneDone) { var dl = doneLine(); if (dl) box.appendChild(dl); }
		return box;
	}

	/// The inline confirm: what switches, who keeps their own, and the two answers.
	function askBox(to) {
		var plan = planEveryone(to);
		var box  = elt('div', 'models-ask');
		var n    = plan.follow.daimons + plan.follow.chats;
		var says = [];
		if (n) says.push(DaimondI18n.tn('models.everyone_switch', n,
			{ what: countWhat(plan.follow.daimons, plan.follow.chats) }));
		var names = plan.own.map(ownerName).filter(Boolean);
		if (names.length) says.push(DaimondI18n.tn('models.everyone_own', names.length, { names: joinNames(names) }));
		box.appendChild(elt('div', 'models-ask-text', says.join(' ')));
		var row  = elt('div', 'models-ask-btns');
		var move = elt('button', 'models-move', t('models.move_them_too'));
		var keep = elt('button', 'models-keep', t('models.keep_theirs'));
		move.type = keep.type = 'button';
		var go = function (all) {
			everyoneAsk  = null;
			everyoneDone = { undo: setEveryone(to, all), to: to };
			render();
		};
		move.addEventListener('click', function () { go(true); });
		keep.addEventListener('click', function () { go(false); });
		row.appendChild(move);
		row.appendChild(keep);
		box.appendChild(row);
		return box;
	}

	/// The line after a change, with its Undo, or after the Undo, what it put back.
	function doneLine() {
		var box = elt('div', 'models-done');
		if (everyoneDone.kept) {
			var kept = everyoneDone.kept.map(ownerName).filter(Boolean);
			box.appendChild(elt('span', 'models-done-text', kept.length
				? DaimondI18n.tn('models.everyone_kept_other', kept.length, { names: joinNames(kept) })
				: t('models.everyone_undone')));
			return box;
		}
		var to = everyoneDone.to;
		// A newer choice of the default, here or arriving, ends the offer.
		if (!samePair(store.def, to)) { everyoneDone = null; return null; }
		var on = { daimons: 0, chats: 0 }, all = { daimons: 0, chats: 0 }, off = [];
		namedTargets().forEach(function (x) {
			var k = x.target.kind === 'chat' ? 'chats' : 'daimons';
			all[k]++;
			if (samePair(effective(x.target, 'daimon'), to)) on[k]++;
			else off.push(x.name);
		});
		var model = displayName(to.provider, to.model), text;
		if (!off.length) {
			text = t('models.everyone_all', { what: countWhat(all.daimons, all.chats), model: model });
		} else {
			var n = on.daimons + on.chats;
			text = (n ? DaimondI18n.tn('models.everyone_some', n, { what: countWhat(on.daimons, on.chats), model: model }) + ' ' : '')
				+ DaimondI18n.tn('models.everyone_kept_own', off.length, { names: joinNames(off) });
		}
		box.appendChild(elt('span', 'models-done-text', text));
		var undo = elt('button', 'models-undo', t('models.undo'));
		undo.type = 'button';
		undo.addEventListener('click', function () {
			var rec = everyoneDone && everyoneDone.undo;
			everyoneDone = { kept: undoEveryone(rec).kept };
			render();
		});
		box.appendChild(undo);
		return box;
	}

	/// *Except*: each named Diamond or chat whose model is its own, or with a job of its own.
	/// Null when there are none, so the section is not drawn.
	function exceptBlock() {
		var def  = pairOf(store.def);
		var rows = namedTargets().filter(function (x) {
			var own = ownPicks(x.target);
			return (own.daimon.model && !isPick(own.daimon, def)) || !!own.workers.model || !!own.images.model;
		});
		if (!rows.length) return null;
		var box = elt('div', 'models-except');
		box.appendChild(secHead(t('models.except_head')));
		rows.forEach(function (x) { box.appendChild(exceptRow(x, def)); });
		return box;
	}

	function exceptRow(x, def) {
		var own = ownPicks(x.target);
		var row = elt('div', 'models-exc');
		row.dataset.kind = x.target.kind;
		var top = elt('div', 'models-exc-top');
		top.appendChild(elt('span', 'models-exc-name', x.name));
		var sel = elt('select', 'models-exc-sel');
		sel.title = t('models.change_row', { name: x.name });
		top.appendChild(sel);
		row.appendChild(top);
		fillSelect(sel, own.daimon.provider, own.daimon.model);
		var first = elt('option', '', t('models.default_named', { model: def.model ? displayName(def.provider, def.model) : '—' }));
		first.value = '';
		sel.insertBefore(first, sel.firstChild);
		if (!own.daimon.model) first.selected = true;
		picker(sel);
		// "Default" or the default itself clears the pick: the row follows from then on.
		sel.addEventListener('change', function () {
			var g = pick(sel);
			if (!picks || typeof picks.set !== 'function') return;
			picks.set(x.target, 'daimon', (!g.model || isPick(g, pairOf(store.def))) ? null : g);
			if (typeof picks.settle === 'function') picks.settle();
			render();
		});
		var sub = [];
		var run = effective(x.target, 'daimon');
		if (run.provider && run.provider !== def.provider) sub.push(t('models.through', { provider: providerName(run.provider) }));
		if (own.workers.model) sub.push(t('models.job_pin', { job: t('models.job_workers'), model: displayName(own.workers.provider, own.workers.model) }));
		if (own.images.model)  sub.push(t('models.job_pin', { job: t('models.job_images'),  model: displayName(own.images.provider, own.images.model) }));
		if (sub.length) row.appendChild(elt('div', 'models-sub models-exc-sub', sub.join(' · ')));
		return row;
	}

	/// *Jobs*: Workers, Images, Drafting and Summarising, each "Same as daimon" unless set.
	function jobsBlock() {
		var box = elt('div', 'models-jobs');
		box.appendChild(secHead(t('models.jobs_head')));
		JOB_ROLES.forEach(function (role) {
			var cur = JOB_SLOT[role] ? pairOf(store[JOB_SLOT[role]])
				: pairOf(picks && typeof picks.summarising === 'function' && picks.summarising());
			var lab = elt('label', 'models-job');
			lab.appendChild(elt('span', 'models-job-lab', t('models.job_' + role)));
			if (role === 'drafting') lab.title = t('models.drafting_help');
			var sel = elt('select', 'settings-select models-job-sel');
			sel.dataset.job = role;
			lab.appendChild(sel);
			box.appendChild(lab);
			fillSelect(sel, cur.provider, cur.model);
			var same = elt('option', '', t('models.same_as_daimon'));
			same.value = '';
			sel.insertBefore(same, sel.firstChild);
			if (!cur.model) same.selected = true;
			picker(sel);
			sel.addEventListener('change', function () {
				var g = pick(sel);
				if (JOB_SLOT[role]) setJob(role, g.provider, g.model);
				else if (picks && typeof picks.set === 'function') {
					picks.set({ kind: 'jobs' }, 'summarising', g.model ? g : null);
					if (typeof picks.settle === 'function') picks.settle();
				}
				render();
			});
		});
		return box;
	}

	/// The figure a provider's head shows: what is left, in the currency it is held in
	/// ("US$18.40 left", "A$12.60 left"), or '' when nothing knows. An own key's figure is
	/// `p.credit`, the binding number (the smaller of the key's cap and the account's credit);
	/// the credits row's is the gateway's, in the account's currency.
	function headBalance(p) {
		if (p.minted) {
			return credits.state === 'ready' && typeof credits.bal === 'number'
				? t('models.balance_left', { amount: DaimondI18n.held(credits.bal / 100, credits.cur) }) : '';
		}
		var c = p.credit;
		return c ? t('models.balance_left', { amount: DaimondI18n.held(c.usd, 'USD') }) : '';
	}

	/// The provider rows, one per key, drawn into `box`: each head holds the name and the
	/// balance and nothing else (D-20261018-09 U5a). Opened, a row holds the key, the balance
	/// and its check, "What is on this key now", the catalogue refresh, its models and Remove.
	function renderProviders(box) {
		var list = providers();
		var d    = getDefault();
		var cat  = catalogue();
		list.forEach(function (p) {
			var row = document.createElement('div');
			row.className = 'models-prov' + (p.paid ? ' paid' : '');
			// Which key this row is about, so the age can be moved on later without redrawing
			// the panel out from under whatever the user is typing into it.
			row.dataset.prov = p.id;

			var head = document.createElement('button');
			head.className = 'models-prov-head';
			head.setAttribute('aria-expanded', open[p.id] ? 'true' : 'false');	// draws the caret
			var bal = headBalance(p);
			head.innerHTML =
				  '<span class="models-caret" aria-hidden="true"></span>'
				+ '<span class="models-prov-name">' + esc(p.name) + '</span>'
				+ (bal ? '<span class="models-bal">' + esc(bal) + '</span>' : '');
			head.title = p.paid
				? t('models.row_paid_help', { provider: p.via || t('models.the_provider') })
				: t('models.row_own_help', { provider: p.name });
			head.addEventListener('click', function () { open[p.id] = !open[p.id]; render(); });
			// How old the figure is rides the hover, and the stale colour the figure itself.
			var balEl = head.querySelector('.models-bal');
			if (balEl) paintBal(balEl, p.id, p.credit);
			row.appendChild(head);

			if (open[p.id]) {
				var body = document.createElement('div');
				body.className = 'models-prov-body';

				// The gateway says why in words meant for the user — an operator who has not
				// configured a management key gets "bring your own model key to keep working",
				// which is better advice than anything this file knows to give. So it is shown,
				// rather than flattened into the row's one-word state and thrown away.
				if (p.paid && p.why) body.appendChild(html('<div class="models-why">' + esc(p.why) + '</div>'));
				// Whose machine the credits row's words land on, said once, inside the row.
				if (p.via) body.appendChild(html('<div class="models-via">' + esc(t('models.via', { provider: p.via })) + '</div>'));

				// Out of credits is not an error to read, it is a thing to do: the row says so, and
				// then offers the doing of it. Nothing else in the panel can be fixed with a button.
				if (p.paid && p.state === 'nocredits') {
					var top = document.createElement('button');
					top.className = 'models-refetch';
					top.textContent = t('models.top_up');
					top.addEventListener('click', function () { if (deps && deps.onTopUp) deps.onTopUp(); });
					body.appendChild(top);
				}

				body.appendChild(keyBlock(p));

				// What is left on this key, and where that figure came from. A row that
				// shows a balance without saying how it knows is asking to be trusted
				// about money; a row that shows nothing when it cannot know is the same
				// promise kept the other way.
				if (!p.minted && p.hasKey && !p.sealed) body.appendChild(creditBlock(p));

				// A catalogue is asked for, never delivered: a provider that answered once
				// can answer again, and a model released this morning appears on nobody's
				// screen until somebody asks. The minted row is the exception: it re-asks
				// itself after every mint, and Top up above is its single deliberate thing.
				if (!p.minted) {
					var refetch = document.createElement('button');
					refetch.className = 'models-refetch';
					// The LABEL carries the state; the button's existence never does. A
					// control that is simply absent is indistinguishable from one that is
					// working, so a row that cannot ask yet still draws the button, disabled,
					// saying why.
					refetch.textContent = !p.hasKey ? t('models.add_key_first')
						: p.count ? t('models.ask_provider_again')
						: t('models.ask_provider');
					refetch.disabled = !p.ready;
					refetch.addEventListener('click', async function () {
						refetch.disabled = true;
						refetch.textContent = t('models.asking');
						note('');                  // this ask answers for itself
						// The provider's own words: a revoked key, a typo in a base URL and a
						// rate limit all fail differently, and only the provider knows which.
						try { await fetchModels(p.id); }
						catch (e) { note(e && e.message ? e.message : String(e)); }
						render();
					});
					body.appendChild(refetch);

					// When the list was last asked for, under the button that asks again.
					var age = document.createElement('div');
					age.className = 'models-list-age';
					age.textContent = p.fetched
						? t('models.list_asked', { when: window.DaimondTime.fmtLocal(p.fetched, 'when') })
						: t('models.list_never');
					body.appendChild(age);
				}

				// Per-model OpenRouter routing. `LlmClient::set_provider_routing` only ever sends
				// it for an `openrouter.ai` endpoint, so another row would offer a dead control.
				var isRoutable = canProbeCredit(p.url);

				// A provider whose catalogue has not been fetched draws no model rows, so a
				// routing preference set earlier would be unreachable. Surfaced here, collapsed,
				// only when there is something in it.
				if (isRoutable && !p.count) {
					var known = Object.keys((store.providers[p.id] || {}).routing || {});
					if (known.length) {
						var disc = document.createElement('details');
						disc.className = 'models-routing-disc';
						var sum = document.createElement('summary');
						sum.textContent = t('models.routing_disclosure');
						disc.appendChild(sum);
						known.forEach(function (mm) { routingFor(p.id, mm, disc); });
						body.appendChild(disc);
					}
				}

				// One model, one row (D-20261018-09 §3): a model lives under its preferred payer,
				// and each other provider that offers it is a line under it naming that payer.
				// Which line is picked decides who is billed.
				cat.forEach(function (e) {
					if (e.offers[0].provider !== p.id) return;
					e.offers.forEach(function (o, i) {
						body.appendChild(modelRow(e, o, i > 0, d));
						if (canProbeCredit(providerUrl(o.provider))) routingFor(o.provider, o.model, body);
					});
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
			box.appendChild(row);
		});
	}

	/// One offer of a catalogue entry as a row: the model's name in the text face (or, for
	/// `alt`, another payer of the same model as "Through Fireworks AI"), its id in the hover
	/// and the copy. Clicking it makes that offer the default.
	function modelRow(e, o, alt, d) {
		var pr    = store.providers[o.provider] || {};
		var paid  = o.provider === CREDITS;
		var isDef = d.provider === o.provider && d.model === o.model;
		var via   = alt ? t('models.through', { provider: providerName(o.provider) })
			: e.offers.length > 1 ? throughLine(o.provider, o.model) : '';
		var mr = document.createElement('button');
		mr.className = 'models-model' + (alt ? ' alt' : '') + (isDef ? ' on' : '');
		mr.dataset.provider = o.provider;
		mr.dataset.model    = o.model;
		mr.innerHTML = '<span class="models-star">' + (isDef ? '★' : '☆') + '</span>'
			+ '<span class="models-id">'
			+   (alt ? '' : '<span class="models-nm">' + esc(e.name) + '</span>')
			+   (via ? '<span class="models-through">' + esc(via) + '</span>' : '')
			+ '</span>'
			+ (isDef ? '<span class="models-def">' + esc(t('models.is_default')) + '</span>' : '');
		mr.title = o.model + '\n'
			+ t(isDef ? 'models.model_is_default' : 'models.model_make_default') + '\n'
			+ (paid ? t('models.model_paid', { provider: credits.via || t('models.the_provider') })
				: t('models.model_own', { provider: pr.name || providerName(o.provider) }));
		mr.addEventListener('click', function () { setDefault(o.provider, o.model); render(); });
		// The copy sits OUTSIDE the row, because the row is a button and a button cannot hold
		// one. It copies the id, which is what a config or a support message wants.
		var cb = copyBtn(tOr('copy.what_model', 'model id {id}', { id: o.model }), o.model);
		if (!cb) return mr;
		var mrow = document.createElement('div');
		mrow.className = 'models-modelrow';
		mrow.appendChild(mr);
		mrow.appendChild(cb);
		return mrow;
	}

	/// What a provider's key is, inside its opened row, and the field that replaces it. The
	/// credits row's key is minted, never his, so it says how the row stands instead.
	function keyBlock(p) {
		var wrap = document.createElement('div');
		wrap.className = 'models-key';
		var k = keyLabel(p);
		if (k[1]) {
			var st = document.createElement('div');
			st.className = 'models-key-state';
			st.innerHTML = (k[0] ? '<span class="' + k[0] + '" aria-hidden="true"></span>' : '') + esc(k[1]);
			wrap.appendChild(st);
		}
		if (p.minted) return wrap;
		var row = document.createElement('div');
		row.className = 'models-key-form';
		var input = document.createElement('input');
		input.type = 'password';
		input.className = 'models-key-input';
		input.autocomplete = 'off';
		input.placeholder = t(p.hasKey ? 'models.key_replace_ph' : 'models.key_add_ph');
		input.setAttribute('aria-label', t('models.key_label', { provider: p.name }));
		var set = document.createElement('button');
		set.type = 'button';
		set.className = 'models-refetch';
		set.textContent = t('models.key_save');
		var commit = async function () {
			var v = String(input.value || '').trim();
			if (!v) { note(t('models.key_empty')); return; }
			note('');
			await setKey(p.id, v);
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

	function fillSelect(sel, provider, model, opts) {
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
		var cat = catalogue();
		var byId = {};
		list.forEach(function (p) { byId[p.id] = p; });
		var twins = {};	// offers of a model another provider also offers
		cat.forEach(function (e) {
			if (e.offers.length > 1) e.offers.forEach(function (o) { twins[useKey(o.provider, o.model)] = 1; });
		});

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
		///
		/// A twin's other payers are rows of their own under the first ("Through Fireworks
		/// AI", `alt`): picking one is picking who is billed, so each stays selectable, but
		/// the model's name is drawn once. The id is in the title and the search, not the text.
		function optionFor(p, m, inFav, alt) {
			var name = displayName(p.id, m);
			var o = document.createElement('option');
			o.value = m;
			o.dataset.provider = p.id;
			o.dataset.pname    = p.name;
			o.dataset.paid     = p.paid ? '1' : '';
			o.dataset.name     = name;
			o.dataset.via      = alt ? '' : throughLine(p.id, m);
			if (alt) o.dataset.alt = '1';
			o.textContent = (alt ? t('models.through', { provider: p.name }) : name)
				+ (p.paid ? ' · ' + t('models.econ_credits') : '')
				+ (inFav || (!alt && twins[useKey(p.id, m)]) ? ' · ' + p.name : '')
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
					+ (p.balance ? ' · ' + DaimondI18n.pricesText(t('models.balance_left', { amount: p.balance })) : '')
					+ (p.via ? ' — ' + t('models.via', { provider: p.via }) : '')
					+ (p.ready ? '' : ' (' + t(p.state === 'nocredits'
						? 'models.top_up_to_use' : 'models.connecting') + ')')
				: p.name + (p.sealed ? ' (' + t('models.sealed_unlock') + ')'
					: p.hasKey ? '' : ' (' + t('models.no_key') + ')');
			// Each model once, under the group of its preferred payer, its twins' payers after it.
			cat.forEach(function (e) {
				if (e.offers[0].provider !== p.id) return;
				g.appendChild(optionFor(p, e.offers[0].model));
				e.offers.slice(1).forEach(function (x) {
					if (byId[x.provider]) g.appendChild(optionFor(byId[x.provider], x.model, false, true));
				});
			});
			if (g.children.length) sel.appendChild(g);
		});

		// Select what was asked for. A model that was asked for and is not offered (its provider
		// removed, its key gone, the catalogue no longer lists it) stays the selection as an
		// option of its own, first, so the pulldown says what the record holds and a Change
		// cannot carry it to a model nobody picked. The starred default stands in for an empty
		// ask only; failing that, the first model anything can actually run.
		if (model) {
			if (!select(sel, provider, model)) {
				var kept = document.createElement('option');
				kept.value            = model;
				kept.dataset.provider = provider || '';
				kept.dataset.kept     = '1';
				kept.dataset.name     = displayName(provider, model);
				kept.textContent      = kept.dataset.name + ' · ' + t('models.not_offered');
				kept.title            = model;
				sel.insertBefore(kept, sel.firstChild);
				kept.selected = true;
			}
			return;
		}
		if (!select(sel, d.provider, d.model)) {
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
				if (sel._mp) sel._mp.repaint();
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

	// ── The filter list ─────────────────────────────────────────────
	//
	// Every model pulldown in the app is drawn by this one control (D-20261008-13). A native
	// `<select>` can neither be searched nor ranked, and a list of forty models across five
	// providers, in the order they are billed, is a list nobody can use at a glance.
	//
	// The `<select>` STAYS, hidden, and is still the state: its options, its value, its change
	// event and `pick()` are what every caller reads, so a site converts with one call and
	// nothing that read the select has to learn the new control. What a person touches is an
	// input beside it and one list drawn on the body, below the field.
	//
	//  - A click opens the whole list, as the select holds it.
	//  - Typing narrows it. The words are split on spaces and EVERY word must be found
	//    somewhere in the model's name, its id or its provider -- not only at the start.
	//  - The models that match are ordered by how much each has been used (`readUse`, the
	//    record `noteUse` keeps), then by recency; the ones that cannot run go last.
	//  - Up, Down, Enter and Escape; a tap on a row; rows a finger can hit.

	var mpPop = null;		// the one list, shared
	var mpCur = null;		// the picker that has it open
	var mpSeq = 0;
	var mpBound = false;

	/// What a row is found by: the words shown, the model id, and the provider's id and name.
	function mpHay(o) {
		return (o.textContent + ' ' + (o.dataset.name || '') + ' ' + o.value + ' ' + (o.dataset.provider || '') + ' '
			+ (o.dataset.pname || '')).toLowerCase();
	}

	/// The rows of a select for a query, as `{ grp }` headings and `{ o }` options.
	///
	/// An empty query is the list exactly as the select holds it: the favourites group and then
	/// each provider. A query flattens it, drops the favourites' duplicates (the real row is in
	/// the list), and orders what is left by use.
	function mpItems(sel, words) {
		var items = [], i, kids = sel.children;
		if (!words.length) {
			for (i = 0; i < kids.length; i++) {
				var k = kids[i];
				if (k.tagName === 'OPTGROUP') {
					items.push({ grp: k.label || '' });
					for (var j = 0; j < k.children.length; j++) items.push({ o: k.children[j] });
				} else if (k.tagName === 'OPTION') items.push({ o: k });
			}
			return items;
		}
		var use = readUse(), hits = [], keep = [], all = sel.options;
		for (i = 0; i < all.length; i++) {
			var o = all[i];
			if (o.dataset.fav) continue;
			var hay = mpHay(o), good = true;
			for (var w = 0; w < words.length; w++) {
				if (hay.indexOf(words[w]) < 0) { good = false; break; }
			}
			if (o.dataset.keep) { keep.push({ o: o }); continue; }
			if (!good) continue;
			var u = use[useKey(o.dataset.provider, o.value)] || {};
			hits.push({ o: o, i: i, n: u.n || 0, t: u.t || 0, d: o.disabled ? 1 : 0 });
		}
		hits.sort(function (a, b) {
			return (a.d - b.d) || (b.n - a.n) || (b.t - a.t) || (a.i - b.i);
		});
		return hits.concat(keep);
	}

	/// Turn a native `<select>` into the filter field. Call it once the select is in its place.
	function picker(sel) {
		if (!sel) return null;
		if (sel._mp) return sel._mp;
		if (!sel.parentNode) return null;

		var wrap = document.createElement('span');
		wrap.className = 'mp';
		// The select's own role classes, prefixed, so the field wears the pulldown it
		// replaces by the role's own CSS rather than by a rule per site.
		for (var c = 0; c < sel.classList.length; c++) wrap.classList.add('mp-' + sel.classList[c]);
		var inp = document.createElement('input');
		inp.type = 'text';
		inp.className = 'mp-in';
		inp.setAttribute('role', 'combobox');
		inp.setAttribute('aria-autocomplete', 'list');
		inp.setAttribute('aria-expanded', 'false');
		inp.setAttribute('aria-haspopup', 'listbox');
		inp.autocomplete = 'off';
		inp.spellcheck = false;
		inp.setAttribute('autocapitalize', 'off');
		inp.setAttribute('autocorrect', 'off');
		inp.setAttribute('data-1p-ignore', '');
		inp.setAttribute('data-lpignore', 'true');
		wrap.appendChild(inp);
		sel.parentNode.insertBefore(wrap, sel.nextSibling);
		sel.classList.add('mp-native');

		var isOpen = false, query = '', items = [], rows = [], act = -1, side = '', tick = 0;

		function labelText() {
			var l = sel.labels && sel.labels[0];
			return (sel.getAttribute('aria-label') || (l && l.firstChild && l.firstChild.nodeType === 3
				? l.firstChild.textContent : '') || sel.title || t('models.find')).trim();
		}
		function repaint() {
			var o = sel.selectedOptions && sel.selectedOptions[0];
			if (!isOpen) inp.value = o ? o.textContent.trim() : '';
			inp.disabled = sel.disabled;
			inp.placeholder = t('models.find');
			inp.title = sel.title || '';
			inp.setAttribute('aria-label', labelText());
		}
		function enabled(n) { return n >= 0 && n < rows.length && !rows[n].disabled; }
		function setAct(n, scroll) {
			if (act >= 0 && rows[act]) rows[act].el.classList.remove('mp-act');
			act = n;
			if (n >= 0 && rows[n]) {
				rows[n].el.classList.add('mp-act');
				inp.setAttribute('aria-activedescendant', rows[n].el.id);
				if (scroll) rows[n].el.scrollIntoView({ block: 'nearest' });
			} else inp.removeAttribute('aria-activedescendant');
		}

		function place() {
			if (!isOpen || !mpPop) return;
			if (!inp.isConnected) { close(true); return; }
			var vv  = window.visualViewport;
			var vw  = vv ? vv.width : window.innerWidth;
			var vh  = vv ? vv.height : window.innerHeight;
			var ox  = vv ? vv.offsetLeft : 0;
			var oy  = vv ? vv.offsetTop : 0;
			var r   = inp.getBoundingClientRect();
			var low = oy + vh - r.bottom - 8;
			var up  = r.top - oy - 8;
			// Below, unless there is more room above and too little below to be worth it.
			if (!side) side = (low >= 220 || low >= up) ? 'below' : 'above';
			var room = Math.max(120, side === 'below' ? low - 4 : up - 4);
			var width = Math.max(r.width, Math.min(320, vw - 16));
			mpPop.style.width     = width + 'px';
			mpPop.style.maxHeight = Math.min(360, room) + 'px';
			var left = Math.min(Math.max(r.left, ox + 8), ox + vw - 8 - width);
			mpPop.style.left = left + 'px';
			var h = mpPop.offsetHeight;
			mpPop.style.top = (side === 'below' ? r.bottom + 4 : Math.max(oy + 8, r.top - 4 - h)) + 'px';
		}

		function render() {
			var words = query.toLowerCase().split(/\s+/).filter(Boolean);
			items = mpItems(sel, words);
			mpPop.innerHTML = '';
			rows = [];
			var cur = sel.selectedOptions && sel.selectedOptions[0];
			var curKey = cur ? useKey(cur.dataset.provider, cur.value) : '';
			var markAt = -1, reason = '';
			items.forEach(function (it) {
				if (it.grp !== undefined) {
					var g = document.createElement('div');
					g.className = 'mp-grp';
					g.textContent = it.grp;
					mpPop.appendChild(g);
					// A group heading ends in what keeps its models from running.
					var m = /\(([^)]*)\)\s*$/.exec(it.grp);
					reason = m ? m[1] : '';
					return;
				}
				var o = it.o;
				var el = document.createElement('div');
				el.className = 'mp-row';
				el.id = 'mp-r' + (++mpSeq);
				el.setAttribute('role', 'option');
				el.dataset.value = o.value;
				el.dataset.provider = o.dataset.provider || '';
				el.setAttribute('aria-selected', 'false');
				if (o.disabled) el.setAttribute('aria-disabled', 'true');
				if (o.title) el.title = o.title;
				var main = document.createElement('span');
				main.className = 'mp-main';
				// A flat list has lost the row above an alt payer, so it names the model again.
				var flatAlt = words.length && o.dataset.alt;
				main.textContent = flatAlt ? o.dataset.name : o.textContent.trim();
				if (o.dataset.alt && !words.length) el.classList.add('mp-alt');
				el.appendChild(main);
				// "Through X" always; a flat list has also lost the heading that said whose model it is.
				var via  = flatAlt ? t('models.through', { provider: o.dataset.pname || '' }) : (o.dataset.via || '');
				var subT = via || (words.length ? (o.dataset.pname || '') : '');
				if (o.disabled && reason) subT += (subT ? ' · ' : '') + reason;
				if (subT && (via || words.length)) {
					var sub = document.createElement('span');
					sub.className = 'mp-sub';
					sub.textContent = subT;
					el.appendChild(sub);
				}
				mpPop.appendChild(el);
				rows.push({ el: el, o: o, disabled: o.disabled });
			});
			// The chosen model is marked once: its own row, or failing that the row of the
			// same model under the same provider (a flat list drops the favourites' copies).
			for (var k = 0; cur && k < rows.length; k++) if (rows[k].o === cur) { markAt = k; break; }
			for (var k2 = 0; cur && markAt < 0 && k2 < rows.length; k2++) {
				if (useKey(rows[k2].o.dataset.provider, rows[k2].o.value) === curKey) { markAt = k2; break; }
			}
			if (markAt >= 0) rows[markAt].el.setAttribute('aria-selected', 'true');
			// Rows the filter always keeps ("Other…") do not count as a match.
			var real = 0;
			for (var r0 = 0; r0 < rows.length; r0++) if (!rows[r0].o.dataset.keep) real++;
			if (!real && (words.length || !rows.length)) {
				var none = document.createElement('div');
				none.className = 'mp-none';
				none.textContent = t('models.no_match');
				mpPop.appendChild(none);
			}
			act = -1;
			var first = markAt >= 0 && !words.length ? markAt : -1;
			if (first < 0) {
				for (var f = 0; f < rows.length; f++) {
					if (!rows[f].disabled && !(words.length && rows[f].o.dataset.keep)) { first = f; break; }
				}
			}
			setAct(first, false);
			place();
			if (!words.length && markAt >= 0) rows[markAt].el.scrollIntoView({ block: 'nearest' });
			else mpPop.scrollTop = 0;
		}

		function show() {
			if (isOpen) return;
			if (mpCur && mpCur !== api) mpCur.close(true);
			if (inp.disabled) return;
			if (!mpPop) {
				mpPop = document.createElement('div');
				mpPop.className = 'mp-pop';
				mpPop.id = 'mp-pop';
				mpPop.setAttribute('role', 'listbox');
				document.body.appendChild(mpPop);
			}
			mpBind();
			isOpen = true; mpCur = api; side = ''; query = '';
			// Escape belongs to the layer stack, which would close the dialog this field sits
			// in; claiming it makes the first press shut the list and the second the dialog.
			if (window.DaimondLayers) {
				DaimondLayers.claim('mp', function () { if (!isOpen) return false; close(true); return true; });
			}
			mpPop.hidden = false;
			inp.setAttribute('aria-expanded', 'true');
			inp.setAttribute('aria-controls', 'mp-pop');
			mpPop.onmousedown = function (e) { e.preventDefault(); };
			mpPop.onclick = function (e) {
				var el = e.target.closest ? e.target.closest('.mp-row') : null;
				if (!el) return;
				for (var i = 0; i < rows.length; i++) if (rows[i].el === el) { choose(i, true); return; }
			};
			mpPop.onmousemove = function (e) {
				var el = e.target.closest ? e.target.closest('.mp-row') : null;
				if (!el) return;
				for (var i = 0; i < rows.length; i++) {
					if (rows[i].el === el) { if (i !== act && !rows[i].disabled) setAct(i, false); return; }
				}
			};
			render();
			// A field that is gone while its list stands -- a dialog closed, a panel redrawn --
			// takes the list with it.
			tick = setInterval(function () { if (!inp.isConnected) close(true); }, 400);
		}

		function close(restore) {
			if (!isOpen) return;
			isOpen = false; query = '';
			clearInterval(tick);
			if (window.DaimondLayers) DaimondLayers.release('mp');
			if (mpCur === api) mpCur = null;
			if (mpPop) { mpPop.hidden = true; mpPop.innerHTML = ''; }
			inp.setAttribute('aria-expanded', 'false');
			inp.removeAttribute('aria-activedescendant');
			if (restore !== false) repaint();
		}

		/// Choose row `n`. The select takes it and says so, exactly as a native pick would.
		function choose(n, byPointer) {
			if (!enabled(n)) return;
			var o = rows[n].o;
			var changed = sel.selectedOptions[0] !== o;
			if (changed) o.selected = true;
			close(true);
			if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
			// A finger is done with the keyboard once it has chosen.
			if (byPointer && window.matchMedia && matchMedia('(pointer: coarse)').matches) inp.blur();
		}

		function step(d) {
			if (!rows.length) return;
			var n = act;
			for (var i = 0; i < rows.length; i++) {
				n = (n + d + rows.length) % rows.length;
				if (!rows[n].disabled) break;
			}
			setAct(n, true);
		}

		inp.addEventListener('click', function () {
			if (!isOpen) { show(); inp.select(); }
		});
		inp.addEventListener('input', function () {
			if (!isOpen) show();
			if (!isOpen) return;
			query = inp.value;
			render();
		});
		inp.addEventListener('keydown', function (e) {
			var k = e.key;
			if (k === 'ArrowDown' || k === 'ArrowUp') {
				e.preventDefault();
				if (!isOpen) { show(); inp.select(); return; }
				step(k === 'ArrowDown' ? 1 : -1);
			} else if (k === 'Tab') {
				// Escape is not here: the layer stack's claim ('mp', in `show`) takes it
				// first, so one press closes the list and not the dialog under it.
				close(true);
			}
		});
		inp.addEventListener('blur', function () { close(true); });
		// The label of a hidden select forwards its click here.
		sel.addEventListener('click', function () { inp.focus(); show(); inp.select(); });
		sel.addEventListener('change', repaint);
		// Existing code sets these on the select and expects the screen to follow.
		['value', 'selectedIndex'].forEach(function (key) {
			var d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, key);
			Object.defineProperty(sel, key, {
				configurable: true,
				get: function () { return d.get.call(sel); },
				set: function (v) { d.set.call(sel, v); repaint(); },
			});
		});
		sel.focus = function (o) { inp.focus(o); };
		// And whoever refills the select.
		new MutationObserver(function () {
			repaint();
			if (isOpen) render();
		}).observe(sel, { childList: true, subtree: true, attributes: true,
			attributeFilter: ['disabled', 'title', 'aria-label'] });

		/// Enter, routed here by `mpBind` ahead of the dialog's own handler.
		function enter() { if (act >= 0) choose(act, false); }

		var api = { el: wrap, input: inp, repaint: repaint, close: close, place: place, enter: enter };
		sel._mp = api;
		repaint();
		return api;
	}

	/// The listeners the open list needs on the window, bound once.
	function mpBind() {
		if (mpBound) return;
		mpBound = true;
		var move = function () { if (mpCur) mpCur.place(); };
		var inList = function (e) { return mpPop && e.target && mpPop.contains(e.target); };
		// Enter on an open list chooses the row. A form dialog submits on Enter from a capture
		// listener on the document, so this one is on the window, which comes before it.
		window.addEventListener('keydown', function (e) {
			if (!mpCur || e.key !== 'Enter' || e.isComposing || e.target !== mpCur.input) return;
			e.preventDefault(); e.stopPropagation();
			mpCur.enter();
		}, true);
		window.addEventListener('resize', move);
		window.addEventListener('scroll', function (e) { if (!inList(e)) move(); }, true);
		if (window.visualViewport) {
			window.visualViewport.addEventListener('resize', move);
			window.visualViewport.addEventListener('scroll', move);
		}
		// A press anywhere else closes it; iOS does not blur a field for a press on a
		// control that cannot take the focus.
		document.addEventListener('pointerdown', function (e) {
			if (!mpCur) return;
			if (inList(e) || (mpCur.el && mpCur.el.contains(e.target))) return;
			mpCur.close(true);
		}, true);
	}

	/// The consequence of pointing a daimon (or a chat) at a different model.
	///
	/// `before` and `after` are `{ provider, model }`; `used` is the context the
	/// conversation already holds, in tokens. `changed` is whether the pick really
	/// differs from what runs now — the daimon settings button reads "Change" only
	/// when it does. `window` is the new model's context window in tokens, or 0
	/// where nobody publishes one, so the meter can be redrawn against it. The
	/// switch REUSES the existing conversation: the thread belongs to the record,
	/// not to the model, so nothing here ends it. `needsFresh` is the single case
	/// it cannot carry over — a published window the held context already exceeds
	/// outright — and even then it is the engine's fold on the next turn that acts;
	/// this only names the state so a caller need not compute it twice.
	function planModelSwitch(before, after, used) {
		before = before || {}; after = after || {};
		var changed = String(after.model || '')    !== String(before.model || '')
			|| String(after.provider || '') !== String(before.provider || '');
		var win = window.DaimondPricing
			? (DaimondPricing.contextWindow(after.model || '', after.provider || '') || 0) : 0;
		return {
			changed:    changed,
			window:     win,
			needsFresh: changed && win > 0 && (used || 0) > win,
		};
	}

	/// The pair a chat's WORKERS run on once the chat itself moves from `before` to `after`.
	///
	/// Workers the user never moved off the chat's model follow it: an empty pair, or one equal to
	/// the model being left, is the chat's own model carried along, and leaving it behind would
	/// turn into a separate choice nobody made -- one that peer routing then reads as a worker
	/// chat, since a pair that differs from the chat's own is what marks one. A pair the user set
	/// apart from the chat's model stays where it was set.
	function workerAfterSwitch(before, after, worker) {
		before = before || {}; after = after || {}; worker = worker || {};
		var wm = String(worker.model || ''), wp = String(worker.provider || '');
		var inherited = !wm
			|| (wm === String(before.model || '') && (!wp || wp === String(before.provider || '')));
		if (inherited) return { provider: after.provider || '', model: after.model || '' };
		return { provider: wp, model: wm };
	}

	function init(d) {
		deps = d || {};
		load();
	}

	/// Take up the store another tab of this device wrote: merged into this tab's copy in
	/// place (see "Two tabs, one store"), never swapped for it.
	function reloadFromDisk(e) {
		if (e && e.newValue === null && window.DaimondStore.get(KEY, null) === null) {
			// Erased (a Forget, a sign-out): the erasure is the later word, so this tab's
			// copy goes with it rather than a merge writing it back.
			load();
			Object.keys(plain).forEach(function (id) { if (id !== CREDITS) delete plain[id]; });
		} else {
			takeDisk();
		}
		if (deps.onChange) deps.onChange();	// redraw, and let sync carry what this tab now holds
	}

	// Another tab of this device wrote the store. A tab that never took it up would carry
	// the sibling's change in no parcel it collects: a provider added in a tab that closed
	// before its push landed was lost with that tab.
	// The browser fires this in the OTHER tabs only; a null key is the whole box cleared.
	if (typeof window !== 'undefined' && window.addEventListener) {
		window.addEventListener('storage', function (e) {
			if (!deps || !e || (e.key !== null && !(e.key && e.key.indexOf(KEY) !== -1))) return;
			reloadFromDisk(e);
		});
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
		cheapestSeeing: cheapestSeeing,
		noteUse:        noteUse,
		favourites:     favourites,
		fillSelect:     fillSelect,
		// A model's display name, "GLM 5.3 Flash" for z-ai/glm-5.3-flash (U3a).
		displayName:    displayName,
		pick:           pick,
		picker:         picker,
		// Whether a picked model differs from the one in force, the new model's window,
		// and whether the held context cannot fit it at all. Drives the daimon "Change".
		planModelSwitch: planModelSwitch,
		workerAfterSwitch: workerAfterSwitch,
		init:           init,
		// Re-read the store over a bounded budget when a cold tab read it empty at
		// boot, before the composer gate is decided against it (see loadSettled).
		loadSettled:    loadSettled,
		unseal:         unseal,
		/// Clear the keys the current identity cannot read, after a deliberate
		/// identity replacement, and name them. See the reconcile in daimond.js.
		dropUnreadableKeys: dropUnreadableKeys,
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
		// Whether a provider lists a model as taking pictures; see `sightOf`.
		sightOf:        sightOf,
		sightFor:       sightFor,
		// A model's own reasoning levels, which the chat's Effort is drawn from.
		effortsOf:      effortsOf,
		effortsFor:     effortsFor,
		effortAfterSwitch: effortAfterSwitch,
		effortInForce:  effortInForce,
		// OpenRouter provider routing, set on a model's own row; see `routing` above.
		routing:        routing,
		setRouting:     setRouting,
		parseRouting:   parseRouting,
		// What is left on a provider's key: asked for where it can be, told to us otherwise.
		fetchCredit:    fetchCredit,
		// When each key was last asked, and how that went. A snapshot, so nothing outside this
		// file can move the floor the probes are held behind.
		creditProbes:   function () { return JSON.parse(JSON.stringify(probes)); },
		// Ask every provider whose catalogue has gone stale, if the gate allows it. Exported for
		// the one caller that is not this file: daimond.js, at the moment the app finishes
		// starting, which is the other occasion a list ought to be current.
		refreshLists:   refreshLists,
		// When each catalogue was last asked for, and how that went. A snapshot, like
		// `creditProbes`, so nothing outside this file can move the floor the asks are held
		// behind by writing to the record that holds them.
		listAsks:       function () { return JSON.parse(JSON.stringify(lists)); },
		setCreditBase:  setCreditBase,
		creditFor:      creditFor,
		topups:         topups,
		noteTopups:     noteTopups,
		all:            all,
		count:          count,
		getDefault:     getDefault,
		setDefault:     setDefault,
		// The stored, synced choice, for the one-off copies-to-follows migration in daimond.js.
		storedChoice:   storedChoice,
		resolve:        resolve,
		// The drafting model: the note→proposal task's own model, defaulting to chat.
		getDraft:       getDraft,
		setDraft:       setDraft,
		resolveDraft:   resolveDraft,
		// The global Jobs picks (Drafting, Workers, Images), and the one resolver.
		getJob:         getJob,
		setJob:         setJob,
		effective:      effective,
		bindPicks:      bindPicks,
		// Everyone uses X: the one call, and what it would do, for the confirm.
		setEveryone:    setEveryone,
		planEveryone:   planEveryone,
		// Its Undo, compare-and-set, and whether this device can run the default.
		undoEveryone:     undoEveryone,
		everyoneStanding: everyoneStanding,
		ready:          ready,
		providerName:   providerName,
		// The store as it travels between devices, and the merge on arrival.
		exportSync:     exportSync,
		applySync:      applySync,
		// Credits: the provider Daimond mints the key for.
		CREDITS:        CREDITS,
		syncCredits:    syncCredits,
		remint:         remint,
		sendOnKey:      sendOnKey,
		// Raise a live key's cap in place, sized to the turn — the F1 charge-for-nothing fix.
		ensure:         ensure,
		ensureActive:   ensureActive,
		creditsGen:     creditsGen,
		creditsState:   creditsState,
		// Per-slot worker keys, so parallel workers never share one.
		mintSlot:       mintSlot,
		remintSlot:     remintSlot,
		slotConfig:     slotConfig,
		forgetSlot:     forgetSlot,
		// The pause check every dispatch must pass, and the refusal it throws when the
		// leaf is held -- exported so a turn's OWN dispatch (daimond.js's `runTurn`)
		// asks this directly rather than only meeting it inside `mintRequest`. A turn
		// on the user's own key never mints, so that was the one door with no check
		// behind it; both doors now ask the identical question.
		held:           held,
		pauseError:     pauseError,
	};
})();
