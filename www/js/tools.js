/* tools.js — what Daimond can do for you, and what more it could.
 *
 * THE UNIT ON THIS PANEL IS A CAPABILITY, NOT A FUNCTION THE MODEL CALLS.
 *
 * It used to be the other way round: twenty-two rows, each one the wire name of a tool
 * in the registry, each with a sentence under it. That is a manifest, and a manifest
 * puts the work of assembling "Daimond can use a website" out of `web_open`,
 * `web_snapshot`, `web_click`, `web_type`, `web_scroll`, `web_read` and `web_close` onto
 * the reader. Nobody does that work, so nobody knows what they have. The word "function"
 * does not appear on this surface at all.
 *
 * So a row here is one thing Daimond does, said in those terms, and it OPENS to the
 * functions that make it possible — which is where `web_click` belongs: available to
 * anyone who wants it, in front of nobody who does not.
 *
 * WHERE THE ROWS COME FROM, and neither source is copied:
 *
 *   the functions   `builtin_tools()` on the wasm module — the registry the agent is
 *                   actually handed, so the panel cannot promise something that is not
 *                   there, nor hide something that is. Each entry carries the `pack` key
 *                   it is sold under, empty for one Daimond ships.
 *   the shelf       `GET /api/tools` — the gateway states which packs are on sale, what
 *                   they cost, and whether this account holds them, because it is the
 *                   gateway that charges.
 *
 * The only thing written down here is WHICH CAPABILITY A FUNCTION BELONGS TO. That map
 * cannot invent a function: a name in it that the registry does not report simply has no
 * members, and a function the registry reports that the map does not place falls into
 * `other`, which is visible and which `dev/verify_toolspanel.mjs` requires to be empty.
 * A tool added to the Rust registry therefore shows up on this panel either in its
 * capability or as a loud failure in the gate — never silently missing.
 *
 * INCLUDED VERSUS SOLD is the gateway's answer and never this file's guess. A capability
 * is on the shelf when every function in it belongs to one pack AND THE GATEWAY IS
 * SELLING THAT PACK. A pack the catalogue has stopped listing is not sold, so the
 * capability sits under Included and everyone keeps it — which is exactly what the
 * gateway does with the entitlement, and the two must not disagree. Nothing that is
 * free today can be drawn as buyable, because nothing here decides that.
 *
 * A pack the catalogue sells that names no function in the registry — the shape the
 * first Research pack will arrive in — is a shelf row of its own, carrying the
 * catalogue's name, blurb and price. It needs no code here to appear.
 */
(function () {
	'use strict';

	// The wasm module, resolved against THIS script rather than the document, so the app
	// still finds it when served from a sub-path. Same reasoning as graph.js.
	var SELF = (document.currentScript && document.currentScript.src) || '';
	var PKG  = SELF ? new URL('../pkg/oxedyne_daimond.js', SELF).href
	                : '../pkg/oxedyne_daimond.js';

	var deps  = null;                // { builtins, onCount }
	var els   = {};
	var state = {
		builtin:  [],                // [{tool, blurb, pack}] — the registry, verbatim
		packs:    [],                // [{tool, name, blurb, price_minor, unlocked, currency}]
		err:      '',
		busy:     false,
		loaded:   false,
		open:     {},                // capability id -> disclosed, kept across redraws
	};

	// ── The gateway, and a session that has gone ───────────────
	//
	// Both calls below go through `DaimondGateway.gwFetch`, which meets a 401 by
	// renewing the session once and asking once more. The gateway's session lives
	// an hour and only an unlock ever minted one, so an hour into a sitting
	// `GET /api/tools` came back 401 and this panel said the account service
	// could not be reached -- which was untrue, and which no amount of reopening
	// the panel would clear.
	//
	// Safe to repeat here, and this is why: `common::authed_account` is the first
	// statement of both `tools_impl` and `pack_impl` in the gateway, so a 401 is
	// proof that nothing happened -- no body parsed, no checkout session made.

	function esc(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	/// A string, from the catalogue.
	///
	/// This panel's strings used to be held in a local English table beside the
	/// catalogue's, because the keys were new. They are in `www/i18n/en.js` now
	/// and every locale carries them, so the copy is gone: two tables of the same
	/// sentences are two tables that will eventually disagree, and the one an
	/// editor never opens is the one that goes stale.
	function t(k, v) {
		return window.DaimondI18n ? DaimondI18n.t(k, v) : k;
	}

	/// An unlock is a charge, so its price is quoted the way it will be taken:
	/// in US dollars, with the converted figure beside it when the user is
	/// reading in something else.
	function fmtPrice(n, cur) {
		return window.DaimondGateway
			? DaimondGateway.fmtBilled(n, cur || 'usd')
			: ('$' + (n / 100).toFixed(2));
	}

	// ── The capabilities ────────────────────────────────────────
	//
	// One entry per thing Daimond does, in the order a reader meets them: their own files
	// first, the world outside last. `fns` names functions in the Rust registry; a name
	// the registry does not report contributes nothing, which is how `dispatch` and
	// `graph` sit here ready for the day `builtin_tools()` reports them (today it reads
	// `Tool::browser()`, which holds neither) without this file claiming they are present.
	//
	// THE OFFICE TRIO IS IN `files` AND NOT IN A ROW OF ITS OWN. `sheet_read`, `doc_edit`
	// and `sheet_write` are the file tools said in the only vocabulary those formats leave:
	// a .docx is a compressed archive, so `file_edit` has no bytes to match a phrase
	// against and `doc_edit` is what does, and a workbook's useful unit is a rectangle of
	// cells rather than the file. The REACH is identical — the same workspace, the same
	// paths, and `write_targets` in src/tools.rs puts them through `file_write`'s own door,
	// so the bounds, a skill's allow-list and the absolute-path refusal all apply unchanged.
	// A row of their own would offer the reader a thing to grant or withhold separately
	// when there is none: whoever has `files` can already overwrite that same .docx whole
	// and delete it. Every other row here differs from `files` in what it REACHES — your
	// cloud, your screen, your machine, the web, a worker, the graph — and none of them
	// splits on a file's format, which is the only thing these three do.

	var CAPS = [
		{ id: 'files',    fns: ['file_read', 'file_write', 'file_edit', 'file_list',
		                        'file_search', 'file_glob', 'file_delete', 'file_move',
		                        'dir_create',
		                        'sheet_read', 'doc_edit', 'sheet_write'] },
		{ id: 'cloud',    fns: ['file_fetch'] },
		{ id: 'work',     fns: ['artefact_add'] },
		// `say` sat here beside `file_show` until folding stopped being a tool: an answer
		// is written at two depths in the model's own prose now, so there is no function
		// to list and nothing for a person to grant or withhold.
		{ id: 'show',     fns: ['file_show'] },
		// `runs` is here and not in a capability of its own: it says what the machine hand
		// is still running and stops one of them, and a person who granted the starting of
		// commands has already granted this. Withholding it would not stop a command being
		// left behind -- it would only stop Daimond being able to clear it up.
		{ id: 'machine',  fns: ['run', 'runs', 'shell'] },
		// ITS OWN CAPABILITY, not a member of `machine`, because it is the one tool that
		// runs a process OUTSIDE the fence -- a named verifier from the tracked tree, never
		// a command the model wrote. That is a different thing to grant from `run`, so it is
		// a different thing to withhold.
		{ id: 'checking', fns: ['verify'] },
		{ id: 'reading',  fns: ['web_fetch', 'web_search'] },
		{ id: 'browsing', fns: ['web_open', 'web_snapshot', 'web_read', 'web_click',
		                        'web_type', 'web_scroll', 'web_close'] },
		{ id: 'typeset',  fns: ['typst_compile'] },
		{ id: 'dispatch', fns: ['spawn_agent'] },
		{ id: 'graph',    fns: ['link_list', 'link_add', 'link_remove'] },
	];

	/// The capability a function belongs to, or `other` for one nobody has placed.
	function capOf(name) {
		for (var i = 0; i < CAPS.length; i++) {
			if (CAPS[i].fns.indexOf(name) >= 0) return CAPS[i].id;
		}
		return 'other';
	}

	/// The pack listing for a key, or null when the catalogue is not selling it.
	///
	/// This is the whole of the included-versus-sold rule. A function carries the pack key
	/// it *would* be sold under; whether it IS sold is this lookup, and the gateway is the
	/// only thing that answers it.
	function saleOf(pack) {
		if (!pack) return null;
		for (var i = 0; i < state.packs.length; i++) {
			if (state.packs[i].tool === pack) return state.packs[i];
		}
		return null;
	}

	/// The panel's rows, assembled from the registry and the catalogue.
	///
	/// Returns `{ included: [row], shelf: [row] }` where a row is
	/// `{ id, name, blurb, fns:[{name, blurb, pack}], sale, owned }`. `sale` is the
	/// catalogue entry when this row is a pack and null when it is included.
	function rows() {
		var byCap = {};
		var order = [];
		state.builtin.forEach(function (fn) {
			var id = capOf(fn.tool);
			if (!byCap[id]) { byCap[id] = []; order.push(id); }
			byCap[id].push(fn);
		});

		var included = [], shelf = [], claimed = {};

		// Capabilities in the panel's own order, then anything unplaced, so a function
		// the map has not caught up with is at the bottom rather than absent.
		var ids = CAPS.map(function (c) { return c.id; });
		order.forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });

		ids.forEach(function (id) {
			var fns = byCap[id];
			if (!fns || !fns.length) return;
			var row = {
				id:    id,
				name:  t('tools.cap.' + id + '.name'),
				blurb: t('tools.cap.' + id + '.blurb'),
				fns:   fns.map(function (f) {
					return { name: f.tool, blurb: f.blurb, sale: saleOf(f.pack) };
				}),
				sale:  null,
				owned: true,
			};
			// A capability is SOLD only when every one of its functions is sold under
			// one and the same pack the catalogue is currently listing. A mixed
			// capability stays included and the sold function carries the note itself,
			// because "half of this is for sale" is not a thing a row can honestly say.
			var sales = row.fns.map(function (f) { return f.sale; });
			var first = sales[0];
			if (first && sales.every(function (s) { return s === first; })) {
				row.sale  = first;
				row.owned = !!first.unlocked;
				claimed[first.tool] = 1;
				shelf.push(row);
			} else {
				included.push(row);
			}
		});

		// Packs the catalogue sells that name no function this build reports — Email
		// today, Research next. The catalogue owns their words, so they are shown in
		// them, and they disclose nothing because there is nothing to disclose.
		state.packs.forEach(function (p) {
			if (claimed[p.tool]) return;
			shelf.push({
				id:    'pack:' + p.tool,
				name:  p.name || p.tool,
				blurb: p.blurb || '',
				fns:   [],
				sale:  p,
				owned: !!p.unlocked,
			});
		});

		// Owned before for-sale: what you have is not a shop.
		shelf.sort(function (a, b) { return (b.owned ? 1 : 0) - (a.owned ? 1 : 0); });
		return { included: included, shelf: shelf };
	}

	/// How much of Daimond this account can reach, out of how much there is. The number
	/// the rail row shows, and the reason a user opens the panel at all.
	///
	/// Counted in CAPABILITIES, which is the unit this panel deals in. A rail that
	/// counted functions and a panel that listed capabilities would be two answers to one
	/// question.
	function counts() {
		var r = rows();
		var have = r.included.length + r.shelf.filter(function (x) { return x.owned; }).length;
		return { have: have, all: r.included.length + r.shelf.length };
	}

	// ── Telling the build what was not bought ───────────────────
	//
	// `/api/tools` is the only thing that knows which packs this account holds, and the
	// wasm is the only thing that can refuse a tool. This is the wire between them, and
	// until now there was none: `set_locked_packs` existed, `Tool::guard` read what it
	// set, `www/js/typst.js` asked `tool_locked` before building the compiler -- and
	// NOTHING IN THE PAGE EVER CALLED THE SETTER. The gate was complete and unreached,
	// so a pack the gateway was selling ran free on every device.
	//
	// Only a read that SUCCEEDED pushes. A gateway that could not be reached leaves the
	// last good answer standing rather than replacing it with "nothing is locked": a
	// device that has never reached the gateway locks nothing, which is the honest
	// default, but a network blink is not a reason to hand over a pack.

	/// Hand the wasm the packs this account has not bought.
	async function pushLocks() {
		var locked = state.packs
			.filter(function (p) { return !p.unlocked; })
			.map(function (p) { return p.tool; })
			.join(',');
		try {
			var mod = await import(PKG);
			mod.set_locked_packs(locked);
		} catch (e) {
			// No module yet: `reload()` runs again once it is up, from daimond.js.
		}
	}

	/// Ask the gateway what this account may do. A gateway that cannot be reached is not the
	/// same as an account that owns nothing, so the built-ins still render and the shelf says
	/// plainly that it could not ask.
	async function load() {
		try {
			state.builtin = deps.builtins();
		} catch (e) {
			state.builtin = [];
		}
		try {
			if (window.DaimondGateway && !DaimondGateway.state().authed) {
				await DaimondGateway.bootstrap();
			}
			var r = await DaimondGateway.gwFetch('/api/tools', { credentials: 'same-origin' });
			var j = await r.json();
			if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
			state.packs = j.tools || [];
			state.err   = '';
			await pushLocks();
		} catch (e) {
			// The listing goes, the engine's locks stay. The two then disagree for as
			// long as the gateway is down -- the panel showing a pack as included that
			// the engine will refuse -- and that is the right way round: the banner says
			// in words that what is unlocked here is unknown, whereas keeping the last
			// listing would make a positive claim of OWNERSHIP out of stale data, and
			// pushing an empty lock list would hand a pack to somebody who has not
			// bought one. A wrong chip is cheaper than either.
			state.packs = [];
			state.err   = t('tools.unreachable');
		}
		state.loaded = true;
		render();
		if (deps.onCount) deps.onCount(counts());
	}

	/// Buy a pack. The gateway makes the session; the price on the button came from the
	/// same table the till reads, so what is quoted is what is charged.
	async function unlock(pack) {
		if (state.busy) return;
		state.busy = true;
		render();
		try {
			if (!window.DaimondGateway) throw new Error(t('tools.no_service'));
			var r = await DaimondGateway.gwFetch('/api/checkout/pack', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ pack: pack }),
			});
			// A 401 that survived the renewal is a session this device cannot get
			// back, not a fault in the purchase. The gateway's own words for it
			// ("No valid session.") say nothing a user can act on.
			if (r.status === 401) throw new Error(t('tools.unreachable'));
			var j = await r.json();
			if (!r.ok || !j.ok || !j.url) throw new Error((j && j.error) || ('HTTP ' + r.status));
			window.location = j.url;
		} catch (e) {
			state.err = (e && e.message) ? e.message : String(e);
			state.busy = false;
			render();
		}
	}

	function html(s) {
		var n = document.createElement('div');
		n.innerHTML = s;
		return n.firstElementChild || n;
	}

	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	}

	/// One capability, closed, with everything it needs to be opened.
	///
	/// The disclosure is a button and a `hidden` block rather than `<details>`: `hidden`
	/// is genuinely not rendered, so "the function is not on screen until you open it" is
	/// a fact a verifier can measure instead of a claim about a shadow root.
	function capCard(row) {
		var card = el('div', 'cap');
		card.setAttribute('data-cap', row.id);
		card.setAttribute('data-state',
			!row.sale ? 'included' : (row.owned ? 'owned' : 'locked'));

		var head = el('div', 'cap-head');
		var txt  = el('div', 'cap-text');
		txt.appendChild(el('div', 'cap-name', row.name));
		if (row.blurb) txt.appendChild(el('div', 'cap-blurb', row.blurb));
		if (row.sale && !row.owned) {
			txt.appendChild(el('div', 'cap-why',
				t('tools.locked_why', { pack: row.sale.name || row.sale.tool })));
		}
		head.appendChild(txt);

		var side = el('div', 'cap-side');
		if (row.sale && !row.owned) {
			var b = el('button', 'tools-buy');
			b.disabled    = state.busy;
			b.textContent = t('tools.unlock_price',
				{ price: fmtPrice(row.sale.price_minor, row.sale.currency) });
			b.title = t('billing.usd_note');
			b.setAttribute('data-buy', row.sale.tool);
			b.addEventListener('click', function () { unlock(row.sale.tool); });
			side.appendChild(b);
		} else {
			var chip = el('span', 'cap-chip' + (row.sale ? ' on' : ''),
				t(row.sale ? 'tools.status_owned' : 'tools.status_included'));
			side.appendChild(chip);
		}
		head.appendChild(side);
		card.appendChild(head);

		if (!row.fns.length) return card;

		var listId = 'cap-fns-' + row.id.replace(/[^a-z0-9]+/gi, '-');
		var body   = el('div', 'cap-fns');
		body.id = listId;
		row.fns.forEach(function (f) {
			var line = el('div', 'cap-fn');
			line.setAttribute('data-fn', f.name);
			line.appendChild(el('code', 'cap-fn-name', f.name));
			var w = el('span', 'cap-fn-blurb', f.blurb);
			line.appendChild(w);
			// A function sold under a pack this row did not become — a mixed
			// capability — says so on its own line, because the row above did not.
			if (f.sale && !f.sale.unlocked && !row.sale) {
				line.appendChild(el('span', 'cap-fn-pack',
					t('tools.fn_pack', { pack: f.sale.name || f.sale.tool })));
			}
			body.appendChild(line);
		});

		var more = el('button', 'cap-more');
		more.setAttribute('aria-controls', listId);
		var draw = function () {
			var on = !!state.open[row.id];
			more.setAttribute('aria-expanded', on ? 'true' : 'false');
			more.textContent = on ? t('tools.collapse')
			                      : t('tools.expand', { n: row.fns.length });
			body.hidden = !on;
		};
		more.addEventListener('click', function () {
			state.open[row.id] = !state.open[row.id];
			draw();
		});
		draw();
		card.appendChild(more);
		card.appendChild(body);
		return card;
	}

	function render() {
		if (!els.body) return;
		els.body.innerHTML = '';

		var r = rows();
		var c = counts();

		els.body.appendChild(html('<div class="tools-intro">' + esc(t('tools.intro')) + '</div>'));
		els.body.appendChild(html('<div class="tools-count">' + t('tools.count', c) + '</div>'));

		if (state.err) els.body.appendChild(html('<div class="tools-err">' + esc(state.err) + '</div>'));

		els.body.appendChild(html('<div class="tools-sec">' + esc(t('tools.sec_included')) + '</div>'));
		r.included.forEach(function (row) { els.body.appendChild(capCard(row)); });

		// The shelf is drawn whether or not anything is on it. It is the answer to "is
		// there more?", and a section that vanishes when the answer is "not yet" makes
		// the reader wonder whether they missed it — and leaves nowhere for the first
		// pack to appear without a change here, which is how a shelf ends up unreachable.
		els.body.appendChild(html('<div class="tools-sec">' + esc(t('tools.sec_packs')) + '</div>'));
		if (r.shelf.length) {
			r.shelf.forEach(function (row) { els.body.appendChild(capCard(row)); });
			els.body.appendChild(html('<div class="tools-fine">' + esc(t('tools.packs_fine')) + '</div>'));
			if (window.DaimondI18n && DaimondI18n.currency() !== 'USD') {
				els.body.appendChild(html('<div class="tools-fine">' + esc(t('billing.usd_note')) + '</div>'));
			}
		} else {
			els.body.appendChild(html('<div class="tools-none">' + esc(t('tools.packs_none')) + '</div>'));
		}
	}

	/// Show the panel, on the stage: the dock holds a noun as a list, the stage holds the
	/// noun under inspection, and a thing with a price on it is being inspected.
	function show() {
		DaimondPanels.show('tools');
		DaimondPanels.reflow();
		load();
	}

	function init(d) {
		deps = d;
		els.body = document.getElementById('tools-body');
		if (!els.body) return;
		// The count on the rail row is the reason anyone opens this, so it is fetched once at
		// boot rather than waiting for the panel to be opened for the first time.
		load();
	}

	window.DaimondTools = {
		init:   init,
		show:   show,
		reload: load,
		counts: counts,
		// For the gate, which asks what this panel decided rather than what it drew.
		rows:   rows,
	};

	// The panel is drawn from state already in hand, so a language or currency
	// change can simply draw it again.
	if (window.DaimondI18n) DaimondI18n.onChange(function () { if (els.body) render(); });
})();
