/* autoreload.js — the standing instruction to buy your own credits.
 *
 * Daimond will charge a saved card while its owner is asleep. That is a serious thing to be
 * allowed to do, and this panel is the only place it is authorised. Three numbers say what it
 * may do, and the third is the one that matters:
 *
 *   below WHEN     the balance at which a reload fires
 *   buy HOW MUCH   one top-up
 *   never more     than this, in a calendar month -- a hard cap, not a target
 *
 * The cap is enforced at the gateway, on the same code path as the charge, so it cannot be
 * walked around by a client that lies. It is here because the user must be able to state it,
 * not because the browser enforces anything.
 *
 * Two things this panel refuses to do:
 *
 *   - It will not let auto-reload be turned on with no card. The gateway refuses that too (422),
 *     but a control that can be switched on and then silently fails is a worse lie than one that
 *     is disabled and says why.
 *   - It does not touch a card. Saving a card is a redirect to Stripe's own hosted page; no
 *     card number, expiry or CVC is ever typed into Daimond, so there is nothing here to leak.
 */
(function () {
	'use strict';

	var G = null;              // DaimondGateway, once it exists
	var cur = null;            // the last settings read back from the gateway
	var busy = false;

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }
	/// Whether figures are being shown in the currency they are billed in.
	function usdDisplay() { return !window.DaimondI18n || DaimondI18n.currency() === 'USD'; }

	function money(minor, ccy) {
		if (window.DaimondGateway && DaimondGateway.fmtMoney) return DaimondGateway.fmtMoney(minor, ccy);
		return ((minor || 0) / 100).toFixed(2);
	}

	/// A standing instruction to charge a card is the sharpest end of the
	/// billing question, so every amount here is a US dollar amount and the
	/// panel says so when the user is reading in something else.
	function billed(minor, ccy) {
		if (window.DaimondGateway && DaimondGateway.fmtBilled) return DaimondGateway.fmtBilled(minor, ccy);
		return money(minor, ccy);
	}

	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	/// Read the panel back into the shape the gateway takes. Amounts are typed in whole units and
	/// held in minor ones, because a price is not a float.
	function readForm() {
		function minor(id) {
			var v = parseFloat((document.getElementById(id) || {}).value);
			return isFinite(v) && v > 0 ? Math.round(v * 100) : 0;
		}
		return {
			enabled:              !!(document.getElementById('ar-on') || {}).checked,
			threshold_minor:      minor('ar-threshold'),
			topup_minor:          minor('ar-topup'),
			monthly_budget_minor: minor('ar-budget'),
		};
	}

	function note(msg, bad) {
		var n = document.getElementById('ar-note');
		if (!n) return;
		n.textContent = msg || '';
		n.classList.toggle('bad', !!bad);
	}

	async function render() {
		var host = document.getElementById('autoreload');
		if (!host) return;
		G = window.DaimondGateway;
		if (!G || !G.state().authed) { host.innerHTML = ''; return; }

		var s = await G.autoReload();
		if (!s) { host.innerHTML = ''; return; }         // no gateway: the panel is not the place to complain
		cur = s;
		host.innerHTML = '';

		host.appendChild(el('div', 'ar-title', t('autoreload.title')));
		host.appendChild(el('p', 'cfg-lead', t('autoreload.lead')));

		// ── The card ────────────────────────────────────────────────
		var cardRow = el('div', 'ar-card');
		var card = s.card || {};
		if (card.saved) {
			cardRow.appendChild(el('span', 'ar-card-has',
				'💳 ' + t('autoreload.card_has', { brand: card.brand || t('autoreload.card_word'), last4: card.last4 || '••••' })));
			var replace = el('button', 'ar-card-btn', t('autoreload.replace'));
			replace.title = t('autoreload.replace_help');
			replace.addEventListener('click', startCard);
			cardRow.appendChild(replace);
		} else {
			cardRow.appendChild(el('span', 'ar-card-none', t('autoreload.no_card')));
			var save = el('button', 'ar-card-btn accent', t('autoreload.save_card'));
			save.title = t('autoreload.save_card_help');
			save.addEventListener('click', startCard);
			cardRow.appendChild(save);
		}
		host.appendChild(cardRow);

		// ── The switch ──────────────────────────────────────────────
		//
		// Disabled without a card, and it says which. A switch that can be flipped and then does
		// nothing teaches the user that the app lies.
		var onRow = el('label', 'ar-switch');
		var box = document.createElement('input');
		box.type = 'checkbox';
		box.id = 'ar-on';
		box.checked = !!s.enabled;
		box.disabled = !card.saved;
		box.addEventListener('change', function () { paintFields(); });
		onRow.appendChild(box);
		onRow.appendChild(el('span', null, card.saved
			? t('autoreload.switch_on')
			: t('autoreload.switch_no_card')));
		host.appendChild(onRow);

		// ── The three numbers ───────────────────────────────────────
		var ccy = s.currency || 'usd';
		host.appendChild(field('ar-threshold', t('autoreload.when_below'),
			s.threshold_minor, ccy, t('autoreload.when_below_hint')));
		host.appendChild(field('ar-topup', t('autoreload.buy_amount'),
			s.topup_minor, ccy, t('autoreload.buy_amount_hint', { max: billed(20000, ccy) })));
		host.appendChild(field('ar-budget', t('autoreload.monthly_cap'),
			s.monthly_budget_minor, ccy, t('autoreload.monthly_cap_hint')));

		// What it has spent against that ceiling, this month. The number that answers "is this
		// thing running away with my money", which is the only question that matters.
		var spent = el('div', 'ar-spent');
		if (s.monthly_budget_minor > 0) {
			var pct = Math.min(100, Math.round(100 * (s.spent_this_month_minor || 0) / s.monthly_budget_minor));
			var bar = el('div', 'ar-bar');
			var fill = el('div', 'ar-bar-fill');
			fill.style.width = pct + '%';
			bar.appendChild(fill);
			spent.appendChild(bar);
		}
		spent.appendChild(el('span', 'ar-spent-txt',
			s.monthly_budget_minor > 0
				? t('autoreload.spent_of', {
					spent: money(s.spent_this_month_minor || 0, ccy),
					cap:   money(s.monthly_budget_minor, ccy) })
				: t('autoreload.spent', { spent: money(s.spent_this_month_minor || 0, ccy) })));
		host.appendChild(spent);

		// The gateway's last complaint, said plainly. A card that has expired or been declined is
		// something the user must be told BEFORE the balance runs out, not after.
		if (s.last_error) {
			var err = el('div', 'ar-last-error');
			err.appendChild(el('span', null, '⚠ ' + t('autoreload.last_error', { reason: s.last_error })));
			host.appendChild(err);
		}

		// The amounts above are charged, not merely shown, so a user reading in
		// another currency is told which currency the card will see.
		if (!usdDisplay()) host.appendChild(el('p', 'ar-hint', t('billing.usd_note')));

		var actions = el('div', 'ar-actions');
		var saveBtn = el('button', 'ar-save accent', t('common.save'));
		saveBtn.id = 'ar-save';
		saveBtn.addEventListener('click', save);
		actions.appendChild(saveBtn);
		host.appendChild(actions);
		host.appendChild(el('div', 'ar-note', ''));

		paintFields();
	}

	/// One labelled amount, in whole units.
	function field(id, label, minorVal, ccy, hint) {
		var wrap = el('div', 'ar-field');
		var lab = el('label', 'ar-label', label);
		lab.setAttribute('for', id);
		var row = el('div', 'ar-input-row');
		// The unit the number is typed in, which is the unit it is billed in.
		// It only spells out "US" when that is not what the user is reading in.
		var unit = (ccy || 'usd').toUpperCase();
		row.appendChild(el('span', 'ar-ccy', unit === 'GBP' ? '£' : (usdDisplay() ? '$' : 'US$')));
		var inp = document.createElement('input');
		inp.type = 'number';
		inp.id = id;
		inp.min = '0';
		inp.step = '1';
		inp.className = 'ar-input';
		inp.value = minorVal > 0 ? String(minorVal / 100) : '';
		row.appendChild(inp);
		wrap.appendChild(lab);
		wrap.appendChild(row);
		if (hint) wrap.appendChild(el('div', 'ar-hint', hint));
		return wrap;
	}

	/// Grey the numbers out when the thing they configure is off, so the panel says at a glance
	/// whether it is doing anything.
	function paintFields() {
		var on = !!(document.getElementById('ar-on') || {}).checked;
		var host = document.getElementById('autoreload');
		if (host) host.classList.toggle('ar-off', !on);
	}

	async function startCard() {
		try { await DaimondGateway.saveCard(); }
		catch (e) { note(e && e.message ? e.message : String(e), true); }
	}

	async function save() {
		if (busy) return;
		busy = true;
		var btn = document.getElementById('ar-save');
		if (btn) { btn.disabled = true; btn.textContent = t('autoreload.saving'); }
		note('');
		try {
			var next = await DaimondGateway.setAutoReload(readForm());
			cur = next;
			note(next.enabled ? t('autoreload.on_note') : t('autoreload.off_note'));
			await render();
		} catch (e) {
			// The gateway's refusals are written for a person to read -- "the monthly budget is
			// smaller than one top-up, so auto-reload could never buy anything" -- so they are
			// shown as they came, not replaced with a generic failure.
			note(e && e.message ? e.message : String(e), true);
		} finally {
			busy = false;
			var b = document.getElementById('ar-save');
			if (b) { b.disabled = false; b.textContent = t('common.save'); }
		}
	}

	window.DaimondAutoReload = {
		render:   render,
		settings: function () { return cur; },
	};
})();
