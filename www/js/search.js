/* search.js — which service Daimond searches with, and whose key pays for it.
 *
 * There was no search tool. The model was handed eight web tools, none of which searched,
 * so when it wanted to search it wrote a search URL by hand and fetched it — which is how
 * it silently chose Bing. The fix is not a better prompt: it is a tool that takes a QUERY,
 * where the ENGINE is the user's setting and not the model's decision.
 *
 * This file is deliberately `models.js` in miniature. That file already solved
 * bring-your-own-key-or-ours for inference — a `KNOWN` registry, a `credits` pseudo-
 * provider whose key the gateway holds, and every typed key sealed under the passphrase —
 * and a second shape for the same idea is a second thing to keep in step. So the store,
 * the sealing, the memory-only plaintext and the pause check in front of the spend are all
 * the shapes that file uses, in the same order.
 *
 * The store, in localStorage:
 *
 *   {
 *     v: 1,
 *     engine: 'credits',                  which service a search goes to
 *     keys: { <id>: { key, keyEnc } }     the user's own key for that service, sealed
 *   }
 *
 * THE PLAINTEXT KEY NEVER GOES TO THE STORE UNSEALED, AND NEVER LEAVES THE BROWSER EXCEPT
 * IN THE ONE REQUEST THAT PAYS FOR IT. That is the promise the mail password keeps — see
 * `mail.js`, which refuses to file a mailbox at all until there is an identity to wrap the
 * password under — and it is kept here the same way: `setKey` seals with
 * `DaimondIdentity.wrap` or stores nothing. The `key` field is in the record because the
 * contract names it and because `models.js` writes a plaintext key there on the
 * browser-only path; THIS store never writes it, and reads it only so a record that
 * arrived carrying one is not silently unreadable. That is the one place this file
 * deliberately does not mirror `models.js`, and the reason is that an inference key buys
 * tokens where a search key is one line in a support ticket away from the same account:
 * both are bearer credentials, and the newer of the two gets the stricter rule.
 *
 * WHO PAYS. `credits` is the account's Daimond balance: the gateway holds the operator's
 * key, picks the engine, and bills the search. Every other id is the user's own key, used
 * for one call and dropped — the gateway stores it no more than `handlers/mail.rs` stores
 * an IMAP password. A BYOK search still costs Oxedyne a socket, and the gateway charges
 * for the relay rather than pretending it is free.
 *
 * `serper` IS BRING-YOUR-OWN-KEY ONLY. It resells Google results, so its business is an
 * arbitrage that can end without notice. A user taking that risk with their own key is
 * their choice; Oxedyne billing for it is Oxedyne's risk, and the answer is no. That is
 * enforced here — `byokOnly`, read by the picker and by `search` — as well as in the
 * gateway and in the operator console, because a rule about money that lives in one place
 * lives in the place that is easiest to route around.
 */
(function () {
	'use strict';

	/// What the app says. The table lives in i18n/en.js.
	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// A string from the table, or the English written here when the table has no entry
	/// for it yet. The twin of `tOr` in daimond.js and models.js, and for the same reason:
	/// the i18n lane fills all eight locales in parallel with this, and a control reading
	/// "search.engine" while it waits is worse than one reading English.
	function tOr(key, fallback, vars) {
		var s = t(key, vars);
		if (s !== key) return s;
		if (!vars) return fallback;
		return String(fallback).replace(/\{(\w+)\}/g, function (whole, k) {
			return vars[k] != null ? String(vars[k]) : whole;
		});
	}

	var KEY      = 'daimond-search-v1';		// per account; accounts.js namespaces daimond-*
	var CREDITS  = 'credits';				// the engine the account's balance buys
	var URL      = '/api/web/search';		// the gateway route; see the contract §6
	var deps     = null;					// { onChange }

	/// The engines, and the same five ids everywhere — Rust enum, gateway request, this
	/// registry, the settings value, the ledger reason.
	///
	/// `url` is where a key is OBTAINED, not an endpoint this file calls: the browser never
	/// dials a search engine. The gateway owns the socket, because `resolve_public` and the
	/// redirect-per-hop check live there and a module that dialled for itself would bypass
	/// both. That is the one field whose meaning differs from `models.js`, where a provider
	/// really is called from the page.
	///
	/// `keyHint` is a placeholder, and nothing is refused on it here. A vendor with no
	/// stable prefix gets an empty one rather than a guess: a wrong hint in a box is worse
	/// than none, because it reads as a rule.
	///
	/// `kinds` is what the engine will answer at all. `credits` claims all three because
	/// the engine behind it is the operator's choice and the browser cannot know which;
	/// the gateway answers for it, and a search that returns nothing is free.
	///
	/// `free` is roughly how many searches a month that vendor gives away, and it is a
	/// NUMBER here rather than a sentence in eight locale files, because a vendor's free
	/// tier changes and nobody goes back to re-read eight locale files when it does. One
	/// value, one edit, and the sentence around it stays translatable. ZERO means "we do
	/// not have a figure we can stand behind", not "there is none" — Exa, Tavily and
	/// Serper all offer something and none of them is written down anywhere this file can
	/// cite, so the row says nothing about them rather than something vague. The 1,000 is
	/// the contract's own figure (§3); if it moves, it moves here.
	var KNOWN = {
		credits: { name: 'Daimond credits', url: '',                              keyHint: '',       kinds: ['web', 'news', 'academic'], free: 0 },
		brave:   { name: 'Brave Search',    url: 'https://brave.com/search/api/',  keyHint: 'BSA…',   kinds: ['web', 'news'],             free: 1000 },
		exa:     { name: 'Exa',             url: 'https://exa.ai/',                keyHint: '',       kinds: ['web', 'academic'],         free: 0 },
		tavily:  { name: 'Tavily',          url: 'https://tavily.com/',            keyHint: 'tvly-…', kinds: ['web', 'news'],             free: 0 },
		serper:  { name: 'Serper',          url: 'https://serper.dev/',            keyHint: '',       kinds: ['web', 'news', 'academic'], free: 0 },
	};

	/// The engines the account's balance may NEVER buy. See the file header: this is a
	/// decision about Oxedyne's risk, not about the engine's quality.
	var BYOK_ONLY = { serper: true };

	/// The kinds a search may ask for, in the order a picker would list them.
	var KINDS = ['web', 'news', 'academic'];

	var store = { v: 1, engine: CREDITS, keys: {} };

	/// Engine id -> plaintext key, memory only. Filled by `unseal()` once the user has
	/// unlocked, emptied by `lock()`. The durable copy is sealed in `store`.
	var plain = {};

	// ── The store ───────────────────────────────────────────────────

	function load() {
		var raw = null;
		try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { raw = null; }
		if (raw && raw.v === 1 && raw.keys && typeof raw.keys === 'object') {
			store = { v: 1, engine: KNOWN[raw.engine] ? raw.engine : CREDITS, keys: raw.keys };
			return;
		}
		store = { v: 1, engine: CREDITS, keys: {} };
	}

	function save() {
		try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* quota */ }
		if (deps && deps.onChange) deps.onChange();
	}

	// ── The engine ──────────────────────────────────────────────────

	/// The configured engine, `credits` by default.
	///
	/// Defaulting rather than trusting the store: a value written by a build that knew a
	/// sixth engine, or edited by hand, must not become a request naming something the
	/// gateway will refuse.
	function engine() {
		return KNOWN[store.engine] ? store.engine : CREDITS;
	}

	/// Choose the engine. Unknown ids are refused rather than stored, and the answer says
	/// whether anything moved.
	function setEngine(id) {
		if (!KNOWN[id] || id === engine()) return false;
		store.engine = id;
		save();
		return true;
	}

	/// Is this engine the user's own key or nothing? See the file header.
	function byokOnly(id) { return !!BYOK_ONLY[id]; }

	/// The engine's name for the screen.
	///
	/// A vendor's name is a proper noun and is never translated; the one name this app made
	/// up for itself — the credits row — is a phrase, and is. The same rule `models.js`
	/// follows, and the same reason.
	function engineName(id) {
		if (id === CREDITS) return tOr('search.credits', 'Daimond credits');
		return (KNOWN[id] && KNOWN[id].name) || id;
	}

	// ── Keys ────────────────────────────────────────────────────────

	/// Decrypt every stored key into memory. Called once the user unlocks: a sealed key is
	/// unreadable until then, which is the point of sealing it.
	async function unseal() {
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return;
		for (var id in store.keys) {
			var row = store.keys[id];
			if (row && row.keyEnc) {
				try { plain[id] = await DaimondIdentity.unwrap(row.keyEnc); }
				catch (e) { plain[id] = ''; }
			} else if (row && row.key) {
				// Never written by this file; read so a record that arrived with one is
				// usable rather than mysteriously dead. See the file header.
				plain[id] = row.key;
			}
		}
		if (deps && deps.onChange) deps.onChange();
	}

	/// Store a key for an engine, sealed under the passphrase.
	///
	/// SEALED OR NOTHING, and the answer says which. There is no plaintext-at-rest fallback
	/// here — `models.js` has one for the skippable browser-only path, and this file does
	/// not, because the promise in its header is the one the mail password keeps. A caller
	/// that gets `false` has a user to tell, not a key to file somewhere else.
	///
	/// An empty key REMOVES the record rather than storing an emptiness, which is how the
	/// push token behaves and for the same reason: "there is no key" is a state the picker
	/// can describe, where "there is a key and it is the empty string" is a refusal from
	/// the engine three steps later.
	async function setKey(id, k) {
		if (!KNOWN[id] || id === CREDITS) return false;
		k = String(k == null ? '' : k).trim();
		if (!k) {
			delete store.keys[id];
			delete plain[id];
			save();
			return true;
		}
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return false;
		var sealed = '';
		try { sealed = await DaimondIdentity.wrap(k); }
		catch (e) { return false; }
		if (!sealed) return false;
		// `key` is written empty, always: the field is in the record because the contract
		// names it, and this store keeps the promise in the header.
		store.keys[id] = { key: '', keyEnc: sealed };
		plain[id] = k;
		save();
		return true;
	}

	/// Re-seal every stored search key under the passphrase that has just replaced
	/// the old one.
	///
	/// **This was missing until 2026-08-14 and the failure was silent and total**:
	/// `setKey` seals with `DaimondIdentity.wrap`, nothing re-wrapped it, and a
	/// passphrase change therefore left every search key unopenable — `unseal`
	/// turning the failed unwrap into an empty string, so the engine simply
	/// reported that it had no key. This file is `models.js` in miniature and it
	/// inherited that file's hole along with its shape.
	///
	/// No read-out phase: like `models.js`, the plaintext is already in `plain` for
	/// the length of an unlocked session, so only the wrapping has to be redone.
	///
	/// A key that was ALREADY unreadable before the change is told apart from an
	/// engine with no key by the ciphertext still being there, and is REPORTED.
	/// Without that, `unseal`'s empty string makes a dead key indistinguishable
	/// from no key at all, and it gets skipped in silence — which is how one stays
	/// dead for ever.
	async function resealAfterRekey() {
		var failed = [], unread = [];
		for (var id in store.keys) {
			var row = store.keys[id];
			if (!row) continue;
			var k = plain[id];
			if (!k) {
				if (row.keyEnc) unread.push(engineName(id));
				continue;
			}
			try {
				row.keyEnc = await DaimondIdentity.wrap(k);
				row.key    = '';				// never leave a plaintext copy behind
			} catch (e) { failed.push(engineName(id)); }
		}
		save();
		return { ok: !failed.length && !unread.length, failed: failed, unread: unread };
	}

	if (window.DaimondRekey) {
		DaimondRekey.register({
			name:   'search',
			reseal: resealAfterRekey,
			sentence: function (kind, list) {
				return kind === 'unread'
					? tOr('changepass.search_not_unsealed',
						'These search services already had unreadable keys before the change, '
						+ 'and still need their keys set again: {list}.', { list: list.join(', ') })
					: tOr('changepass.search_not_resealed',
						'These search services could not be re-encrypted under the new '
						+ 'passphrase and need their keys again: {list}.', { list: list.join(', ') });
			},
		});
	}

	/// The plaintext key for an engine, or '' when there is none or the app is locked.
	function key(id) {
		if (plain[id]) return plain[id];
		var row = store.keys[id];
		return (row && row.key) || '';
	}

	/// Whether an engine holds a key at all, sealed or not. An engine with no key is still
	/// listed and still choosable; it simply says what it is waiting for.
	function hasKey(id) {
		var row = store.keys[id];
		return !!(plain[id] || (row && (row.key || row.keyEnc)));
	}

	/// Whether the key is present but unreadable because the app is locked.
	function isSealed(id) {
		var row = store.keys[id];
		return !!(row && row.keyEnc && !plain[id]);
	}

	/// Forget every key. The lock does this: a locked Daimond holds no readable key.
	function lock() {
		plain = {};
		if (deps && deps.onChange) deps.onChange();
	}

	// ── The pause, refused where the money is committed ─────────────
	// A pause the widget respects and the network does not is decoration, so it is checked
	// HERE, in front of the request, rather than trusted to whatever asked. Cooperative on
	// purpose: `gateway.js` wraps `window.fetch` and turns a held spend into a 423, which
	// is the guard for callers that do not ask — but its own comment says a caller that
	// asked for itself could show the sentence in its own panel instead of taking it off a
	// status code, and this is the first caller to do that.

	function ROOT() { return window.DaimondPause ? DaimondPause.ROOT : 'root'; }

	/// The leaf a search is charged to. `root/web` — the same leaf a page fetch spends on,
	/// and deliberately not a new one: a leaf with no control is the mistake `root/web`
	/// itself made, and a second one would be the same mistake twice.
	function node() {
		return window.DaimondPause ? DaimondPause.id(ROOT(), 'web') : 'root/web';
	}

	function held(id) {
		return !!(id && window.DaimondPause && DaimondPause.isPaused(id));
	}

	/// Is EVERYTHING paused? The global control at the top of the rail is the root of the
	/// same tree, so a held root holds a search even where the leaf itself is running.
	function allHeld() {
		if (!window.DaimondPause) return false;
		try { return DaimondPause.state(ROOT()) === 'pause'; } catch (e) { return false; }
	}

	/// The refusal a pause produces: an Error naming the node. `paused` marks it so a
	/// caller can show a held spend calmly rather than as a fault, and `pauseNode` says
	/// which control to point at — which is now a control that exists, in the Web panel
	/// header.
	function pauseError(id) {
		var e = new Error(tOr('pause.refused.web',
			'{node} is paused. The page was not fetched and nothing was spent. Press '
				+ 'play on it to resume.',
			{ node: id }));
		e.paused    = true;
		e.pauseNode = id;
		return e;
	}

	// ── The search ──────────────────────────────────────────────────

	/// One result row, or null when it is not one.
	///
	/// `title` and `url` may not be empty and a row missing either is DROPPED rather than
	/// passed on hollow: a result the model cannot open is a line of context that costs
	/// tokens and answers nothing. `age` is whatever freshness the engine reported,
	/// verbatim and unparsed — engines disagree about what it means and a wrong date is
	/// worse than no date.
	function row(r) {
		if (!r || typeof r !== 'object') return null;
		var title = String(r.title || '').trim();
		var url   = String(r.url || '').trim();
		if (!title || !url) return null;
		return {
			title:   title,
			url:     url,
			snippet: String(r.snippet || ''),
			age:     String(r.age || ''),
		};
	}

	/// Search, and hand back the one result shape the gateway, this file and the wasm all
	/// agree on: `{ engine, query, results:[{title, url, snippet, age}] }`.
	///
	/// `opts` carries `kind` ('web' | 'news' | 'academic') and `limit`, and NOTHING ELSE.
	/// That is the wasm's half of the bargain and it is the whole of it: the tool sends
	/// those two, omits `limit` when the model named none, and sends no engine and no key.
	/// The engine and the key are added HERE, from the setting.
	///
	/// An `engine` named in `opts` is ignored, deliberately and by omission: the engine is
	/// the user's setting, and a tool argument that could override it would put the choice
	/// back where it was — with a model improvising a search URL.
	///
	/// The refusals it can produce, all of them before anything is spent:
	///
	///   * the leaf (or the whole tree) is paused;
	///   * the engine wants a key and there is none — and for `serper` that is final,
	///     since credits may not buy it;
	///   * the engine cannot answer that kind at all.
	async function search(query, opts) {
		opts = opts || {};
		var q = String(query == null ? '' : query).trim();
		if (!q) throw new Error('A search needs something to search for.');

		var id = engine();

		// The pause, first: a refusal that costs nothing should cost nothing, including the
		// round trip. The leaf, and the root behind it — `gateway.js` charges an
		// unattributed spend to the root, and a search is no different.
		var stop = held(node()) ? node() : (allHeld() ? ROOT() : '');
		if (stop) throw pauseError(stop);

		// A key, where the engine is not the one Daimond holds the key for. Two refusals,
		// because they offer different ways out: an ordinary engine can be swapped for
		// credits, and serper cannot.
		var mine = '';
		if (id !== CREDITS) {
			mine = key(id);
			if (!mine) {
				throw new Error(byokOnly(id)
					? tOr('search.refused_serper', '{engine} can only be used with your own key.',
						{ engine: engineName(id) })
					: tOr('search.no_key', 'Add a key for {engine}, or switch to Daimond credits.',
						{ engine: engineName(id) }));
			}
		}

		var kind = String(opts.kind || 'web');
		// Defaulted here, REFUSED in the wasm -- and the difference is deliberate.
		// `Tool::WebSearch` rejects a kind it does not know rather than quietly
		// reading it as `web`, because a model that asked for `images` and silently
		// got the web would never learn it had asked for something that does not
		// exist. Nothing reaches this line from that path. What does reach it is
		// app code, where a bad kind is a typo in our own source and taking the
		// default is better than an exception in front of the user. Do not make the
		// two agree by loosening the wasm.
		if (KINDS.indexOf(kind) === -1) kind = 'web';
		var can = (KNOWN[id] && KNOWN[id].kinds) || ['web'];
		if (can.indexOf(kind) === -1) {
			throw new Error(engineName(id) + ' does not answer that kind of search. '
				+ 'It can do: ' + can.join(', ') + '.');
		}

		var limit = parseInt(opts.limit, 10);
		if (!isFinite(limit) || limit < 1) limit = 10;
		if (limit > 20) limit = 20;

		// Belt and braces, and the last thing before the request is built. An
		// own-key-only engine reaching the gateway WITHOUT a key is a request for the
		// balance to pay for it, and nothing above can compose one — this is what makes
		// that a property of the module rather than a reading of the lines above it.
		if (byokOnly(id) && !mine) {
			throw new Error(tOr('search.refused_serper', '{engine} can only be used with your own key.',
				{ engine: engineName(id) }));
		}

		var head = { 'content-type': 'application/json' };
		// Read from gateway.js rather than copied: two constants that must match are two
		// constants that will one day not.
		if (window.DaimondGateway && DaimondGateway.clientApi) {
			head['x-daimond-api'] = String(DaimondGateway.clientApi());
		}
		var body = { query: q, kind: kind, limit: limit, engine: id };
		// The one request the key leaves the browser in, and the only one. The gateway uses
		// it for this call and drops it.
		if (mine) body.key = mine;

		var r = await fetch(URL, {
			method:      'POST',
			headers:     head,
			credentials: 'same-origin',
			body:        JSON.stringify(body),
		});
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		// A search spends, and the reply says what is left. One place owns that number;
		// this hands it over rather than letting the header go stale.
		if (window.DaimondGateway && DaimondGateway.noteBalance) DaimondGateway.noteBalance(j);
		if (!r.ok || !j || j.ok === false) {
			var e = new Error((j && (j.error || j.message)) || 'The search could not be run.');
			// 423 is the gateway saying the spend is held. It carries the node, so a caller
			// can point at the control rather than report a fault.
			if (r.status === 423 && j && j.node) { e.paused = true; e.pauseNode = j.node; }
			throw e;
		}
		var list = Array.isArray(j.results) ? j.results : [];
		return {
			// The ENGINE is believed from the reply: for `credits` the operator's knob
			// decides it and this file genuinely does not know which one answered.
			engine:  String(j.engine || id),
			// The QUERY is not. It is what we asked, never the reply's echo of it --
			// the same rule `answer()` in src/wasm/web.rs holds, and for the same
			// reason. The query names the search in the untrusted envelope the model
			// reads and in anything this file shows a person; a reply that echoed
			// something else would be rewriting the record of what was gone looking
			// for. Believing the echo here and not there would also be two answers to
			// one question, which is how a seam rots.
			query:   q,
			results: list.map(row).filter(Boolean),
		};
	}

	// ── Wiring ──────────────────────────────────────────────────────

	function init(d) {
		deps = d || {};
		load();
	}

	// The settings row stays mounted, so a language change redraws it where it stands.
	if (window.DaimondI18n) {
		DaimondI18n.onChange(function () { if (deps && deps.onChange) deps.onChange(); });
	}

	window.DaimondSearch = {
		// The contract's six, in its order.
		KNOWN:     KNOWN,
		engine:    engine,
		setEngine: setEngine,
		key:       key,
		setKey:    setKey,
		search:    search,
		// What the app's own picker and the unlock/lock path need beyond them.
		init:      init,
		unseal:    unseal,
		/// Re-seal after a passphrase change. Public so a test can drive it; the
		/// app itself reaches it only through `DaimondRekey`.
		resealAfterRekey: resealAfterRekey,
		lock:      lock,
		hasKey:    hasKey,
		isSealed:  isSealed,
		byokOnly:  byokOnly,
		engineName: engineName,
		// The leaf a search is charged to, so a caller can point at its control.
		node:      node,
		CREDITS:   CREDITS,
		KINDS:     KINDS,
	};
})();
