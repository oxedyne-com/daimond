/* tools.js — what Daimond can do, and what the rest would cost.
 *
 * The panel is called Tools and not Upgrades, because most of what it lists is free
 * and already yours: a panel named for the shop, that mostly shows what you already
 * own, misdescribes itself — and it does not survive a third party listing a tool of
 * their own, which is not an "upgrade to Daimond" by any reading. The shop is a view
 * inside Tools, not the other way round.
 *
 * Two sources, and neither is copied:
 *
 *   the built-ins   `builtin_tools()` on the wasm module — the registry the agent is
 *                   actually handed, so the panel cannot promise a tool that is not
 *                   there, nor hide one that is.
 *   the unlockables `GET /api/tools` — the gateway states the price and whether this
 *                   account holds the unlock, because it is the gateway that charges.
 */
(function () {
	'use strict';

	var deps  = null;                // { builtins, checkout, panels }
	var els   = {};
	var state = {
		builtin:  [],                // [{tool, blurb}]
		packs:    [],                // [{tool, name, blurb, price_minor, unlocked, currency}]
		credits:  0,
		err:      '',
		busy:     false,
		loaded:   false,
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
	//
	// This file used to carry its own copy of that rule, one of five identical
	// copies across the app. There is one now, in gateway.js, beside the renewal
	// it drives.

	function esc(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}
	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// An unlock is a charge, so its price is quoted the way it will be taken:
	/// in US dollars, with the converted figure beside it when the user is
	/// reading in something else.
	function fmtPrice(n, cur) {
		return window.DaimondGateway
			? DaimondGateway.fmtBilled(n, cur || 'usd')
			: ('$' + (n / 100).toFixed(2));
	}

	/// How many tools this Daimond holds, out of how many exist. The number the rail row
	/// shows, and the reason a user opens the panel at all.
	function counts() {
		var have = state.builtin.length + state.packs.filter(function (p) { return p.unlocked; }).length;
		return { have: have, all: state.builtin.length + state.packs.length };
	}

	/// Ask the gateway what this account may do. A gateway that cannot be reached is not the
	/// same as an account that owns nothing, so the built-ins still render and the shop says
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
			state.packs   = j.tools || [];
			state.credits = j.credits_minor || 0;
			state.err     = '';
		} catch (e) {
			state.packs = [];
			state.err   = t('tools.unreachable');
		}
		state.loaded = true;
		render();
		if (deps.onCount) deps.onCount(counts());
	}

	/// Buy an unlock. The gateway makes the session; the price on the button came from the
	/// same table the till reads, so what is quoted is what is charged.
	async function unlock(tool) {
		if (state.busy) return;
		state.busy = true;
		render();
		try {
			if (!window.DaimondGateway) throw new Error(t('tools.no_service'));
			var r = await DaimondGateway.gwFetch('/api/checkout/pack', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ pack: tool }),
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

	function card(tool, kind) {
		var d = document.createElement('div');
		d.className = 'tools-card' + (kind === 'locked' ? ' locked' : '');
		d.innerHTML = '<div class="tools-name">' + esc(tool.name || tool.tool) + '</div>'
			+ '<div class="tools-blurb">' + esc(tool.blurb) + '</div>';
		if (kind === 'builtin') {
			d.appendChild(html('<span class="tools-tag">' + esc(t('tools.built_in')) + '</span>'));
		} else if (kind === 'owned') {
			d.appendChild(html('<span class="tools-tag on">' + esc(t('tools.unlocked')) + '</span>'));
		} else {
			var b = document.createElement('button');
			b.className = 'tools-buy';
			b.disabled  = state.busy;
			b.textContent = t('tools.unlock_price', { price: fmtPrice(tool.price_minor, tool.currency) });
			b.title = t('billing.usd_note');
			b.addEventListener('click', function () { unlock(tool.tool); });
			d.appendChild(b);
		}
		return d;
	}
	function html(s) {
		var n = document.createElement('div');
		n.innerHTML = s;
		return n.firstElementChild || n;
	}

	function render() {
		if (!els.body) return;
		els.body.innerHTML = '';

		var c = counts();
		els.body.appendChild(html(
			'<div class="tools-head">'
			+ t('tools.head', { have: c.have, all: c.all })
			+ '</div>'));

		if (state.err) els.body.appendChild(html('<div class="tools-err">' + esc(state.err) + '</div>'));

		var owned = state.packs.filter(function (p) { return p.unlocked; });
		var shop  = state.packs.filter(function (p) { return !p.unlocked; });

		if (owned.length) {
			els.body.appendChild(html('<div class="tools-sec">' + esc(t('tools.sec_unlocked')) + '</div>'));
			owned.forEach(function (tool) { els.body.appendChild(card(tool, 'owned')); });
		}

		if (shop.length) {
			els.body.appendChild(html('<div class="tools-sec">' + esc(t('tools.sec_shop')) + '</div>'));
			shop.forEach(function (tool) { els.body.appendChild(card(tool, 'locked')); });
			els.body.appendChild(html('<div class="tools-fine">' + t('tools.shop_fine') + '</div>'));
			if (window.DaimondI18n && DaimondI18n.currency() !== 'USD') {
				els.body.appendChild(html('<div class="tools-fine">' + esc(t('billing.usd_note')) + '</div>'));
			}
		}

		els.body.appendChild(html('<div class="tools-sec">' + esc(t('tools.built_in')) + '</div>'));
		state.builtin.forEach(function (tool) { els.body.appendChild(card(tool, 'builtin')); });
	}

	/// Show the panel, on the stage: the dock holds a noun as a list, the stage holds the
	/// noun under inspection, and a tool with a price on it is being inspected.
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
	};

	// The panel is drawn from state already in hand, so a language or currency
	// change can simply draw it again.
	if (window.DaimondI18n) DaimondI18n.onChange(function () { if (els.body) render(); });
})();
