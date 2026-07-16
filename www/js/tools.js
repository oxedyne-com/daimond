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

	function esc(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}
	function fmtMinor(n, cur) {
		return window.DaimondGateway
			? DaimondGateway.fmtMoney(n, cur || 'usd')
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
			var r = await fetch('/api/tools', { credentials: 'same-origin' });
			var j = await r.json();
			if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
			state.packs   = j.tools || [];
			state.credits = j.credits_minor || 0;
			state.err     = '';
		} catch (e) {
			state.packs = [];
			state.err   = 'The account service could not be reached, so what is unlocked here is unknown.';
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
			if (!window.DaimondGateway) throw new Error('The account service is unavailable.');
			var r = await fetch('/api/checkout/pack', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ pack: tool }),
			});
			var j = await r.json();
			if (!r.ok || !j.ok || !j.url) throw new Error((j && j.error) || ('HTTP ' + r.status));
			window.location = j.url;
		} catch (e) {
			state.err = (e && e.message) ? e.message : String(e);
			state.busy = false;
			render();
		}
	}

	function card(t, kind) {
		var d = document.createElement('div');
		d.className = 'tools-card' + (kind === 'locked' ? ' locked' : '');
		d.innerHTML = '<div class="tools-name">' + esc(t.name || t.tool) + '</div>'
			+ '<div class="tools-blurb">' + esc(t.blurb) + '</div>';
		if (kind === 'builtin') {
			d.appendChild(html('<span class="tools-tag">Built in</span>'));
		} else if (kind === 'owned') {
			d.appendChild(html('<span class="tools-tag on">Unlocked</span>'));
		} else {
			var b = document.createElement('button');
			b.className = 'tools-buy';
			b.disabled  = state.busy;
			b.textContent = 'Unlock — ' + fmtMinor(t.price_minor, t.currency);
			b.addEventListener('click', function () { unlock(t.tool); });
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
			+ '<b>' + c.have + ' of ' + c.all + '</b> tools. '
			+ 'Most of what Daimond can do it can do for nothing — the tools below are simply '
			+ 'what it is. A few reach the world outside the browser, and those cost what they '
			+ 'cost to run.'
			+ '</div>'));

		if (state.err) els.body.appendChild(html('<div class="tools-err">' + esc(state.err) + '</div>'));

		var owned = state.packs.filter(function (p) { return p.unlocked; });
		var shop  = state.packs.filter(function (p) { return !p.unlocked; });

		if (owned.length) {
			els.body.appendChild(html('<div class="tools-sec">Unlocked on this account</div>'));
			owned.forEach(function (t) { els.body.appendChild(card(t, 'owned')); });
		}

		if (shop.length) {
			els.body.appendChild(html('<div class="tools-sec">Get more tools</div>'));
			shop.forEach(function (t) { els.body.appendChild(card(t, 'locked')); });
			els.body.appendChild(html(
				'<div class="tools-fine">Bought once, kept for good. Nothing renews. What a tool '
				+ 'costs to run — a mailbox synced, a page fetched — is metered against credits, '
				+ 'so ongoing cost tracks ongoing use.</div>'));
		}

		els.body.appendChild(html('<div class="tools-sec">Built in</div>'));
		state.builtin.forEach(function (t) { els.body.appendChild(card(t, 'builtin')); });
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
})();
