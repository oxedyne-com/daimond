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
 */
(function () {
	'use strict';

	var KEY     = 'daimond-models-v2';
	var OLD_KEY = 'daimond-byok';           // the single-provider config this replaces
	var deps    = null;                     // { onChange }

	/// The providers Daimond knows how to talk to. Every one was verified to allow a direct
	/// browser call, so a key works with no relay in the middle. `model` is a sensible default
	/// where the provider has a stable id worth starting on.
	var KNOWN = {
		fireworks:  { name: 'Fireworks AI', url: 'https://api.fireworks.ai/inference/v1/chat/completions', model: 'accounts/fireworks/models/glm-5p2' },
		openrouter: { name: 'OpenRouter',   url: 'https://openrouter.ai/api/v1/chat/completions',          model: '' },
		together:   { name: 'Together AI',  url: 'https://api.together.xyz/v1/chat/completions',           model: '' },
		groq:       { name: 'Groq',         url: 'https://api.groq.com/openai/v1/chat/completions',        model: '' },
		deepinfra:  { name: 'DeepInfra',    url: 'https://api.deepinfra.com/v1/openai/chat/completions',   model: '' },
	};

	var store = { v: 2, def: { provider: '', model: '' }, providers: {} };
	var plain = {};                         // provider id -> plaintext key, memory only

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
	function hasKey(id) {
		var p = store.providers[id];
		return !!(p && (p.key || p.keyEnc));
	}

	/// Whether the key is present but unreadable because the app is locked.
	function isSealed(id) {
		var p = store.providers[id];
		return !!(p && p.keyEnc && !plain[id]);
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
			var p = store.providers[id];
			return {
				id:      id,
				name:    providerName(id),
				url:     providerUrl(id),
				models:  p.models || [],
				count:   (p.models || []).length,
				hasKey:  hasKey(id),
				sealed:  isSealed(id),
				ready:   hasKey(id) && !isSealed(id),
			};
		});
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
	function lock() {
		plain = {};
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

	/// Draw the providers, each one expandable to the models it can run.
	///
	/// The default is a star ON the model, not a separate dropdown somewhere else: the thing a
	/// new chat starts on is a model belonging to a provider, and showing it anywhere other
	/// than beside that model invites the two to disagree.
	function render() {
		var el = document.getElementById('models-list');
		if (!el) return;
		el.innerHTML = '';

		var list = providers();
		if (!list.length) {
			el.appendChild(html('<div class="models-empty">No provider yet. Add one to give Daimond a model to think with.</div>'));
			return;
		}

		var d = getDefault();
		list.forEach(function (p) {
			var row = document.createElement('div');
			row.className = 'models-prov';

			var head = document.createElement('button');
			head.className = 'models-prov-head';
			head.innerHTML =
				  '<span class="models-caret">' + (open[p.id] ? '▾' : '▸') + '</span>'
				+ '<span class="models-prov-name">' + esc(p.name) + '</span>'
				+ '<span class="models-prov-key">'
				+ (p.sealed ? '🔒 sealed' : p.hasKey ? '🔑 key set' : '⚠ no key')
				+ '</span>'
				+ '<span class="models-prov-count">' + p.count + (p.count === 1 ? ' model' : ' models') + '</span>';
			head.addEventListener('click', function () { open[p.id] = !open[p.id]; render(); });
			row.appendChild(head);

			if (open[p.id]) {
				var body = document.createElement('div');
				body.className = 'models-prov-body';

				if (!p.count) {
					var refetch = document.createElement('button');
					refetch.className = 'models-refetch';
					refetch.textContent = p.hasKey ? 'Ask this provider what it can run' : 'Add a key first';
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
					var mr = document.createElement('button');
					mr.className = 'models-model' + (isDef ? ' on' : '');
					mr.innerHTML = '<span class="models-star">' + (isDef ? '★' : '☆') + '</span>'
						+ '<span class="models-id">' + esc(m) + '</span>'
						+ (isDef ? '<span class="models-def">default</span>' : '');
					mr.title = isDef
						? 'New chats and Foci start on this model.'
						: 'Make this the model new chats and Foci start on.';
					mr.addEventListener('click', function () { setDefault(p.id, m); render(); });
					body.appendChild(mr);
				});

				var rm = document.createElement('button');
				rm.className = 'models-remove';
				rm.textContent = 'Remove ' + p.name;
				rm.addEventListener('click', function () {
					removeProvider(p.id);
					render();
				});
				body.appendChild(rm);
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

		var d = getDefault();
		list.forEach(function (p) {
			var g = document.createElement('optgroup');
			g.label = p.name + (p.sealed ? ' (sealed — unlock to use)' : p.hasKey ? '' : ' (no key)');
			p.models.forEach(function (m) {
				var o = document.createElement('option');
				o.value = m;
				o.dataset.provider = p.id;
				o.textContent = m + (d.provider === p.id && d.model === m ? '  ★' : '');
				o.title = p.name + ' · ' + m;
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
	};
})();
