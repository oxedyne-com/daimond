/* testnet.js — the TEST chip and the Testnet sheet (design §R11.3, tn-U2a).
 *
 * Drawn only when policy.js says this page is on the testnet, so production,
 * served the same bytes, draws nothing. The chip sits beside the wordmark and
 * opens a sheet holding the two things a testnet session needs at hand: the
 * payment sandbox's card, and Report a Problem, which opens support.js's
 * free-text box (test only).
 */
(function () {
	'use strict';

	var CARD = '4242 4242 4242 4242';        // the payment sandbox's test card

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }
	function tOr(k, fallback, v) { var s = t(k, v); return s !== k ? s : String(fallback); }

	function elt(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}

	var _open = null;
	function close() {
		if (_open && _open.parentNode) _open.parentNode.removeChild(_open);
		_open = null;
		if (window.DaimondLayers) DaimondLayers.done('testnet');
	}

	function openSheet() {
		close();
		var wrap = elt('div', 'modal');
		wrap.id = 'testnet-sheet';
		var card = elt('div', 'modal-card tn-sheet');
		card.appendChild(elt('h2', '', tOr('testnet.title', 'Testnet')));

		var row = elt('div', 'tn-row');
		row.appendChild(elt('span', 'tn-label', tOr('testnet.card', 'Sandbox card')));
		row.appendChild(elt('span', 'tn-card-num', CARD));
		// The app's one copy control, so it is drawn as every other is.
		if (window.DaimondCopyBtn) {
			var copy = DaimondCopyBtn(tOr('testnet.card_what', 'the sandbox card'), CARD.replace(/ /g, ''));
			copy.classList.add('tn-copy');
			row.appendChild(copy);
		}
		card.appendChild(row);
		card.appendChild(elt('p', 'tn-note', tOr('testnet.card_note', 'Any future date, any CVC.')));

		var acts = elt('div', 'post-acts');
		var rep = elt('button', 'post-btn report-send tn-report', tOr('testnet.report', 'Report a Problem'));
		rep.type = 'button';
		var done = elt('button', 'post-btn', tOr('support.done', 'Close'));
		done.type = 'button';
		acts.appendChild(rep);
		acts.appendChild(done);
		card.appendChild(acts);
		done.addEventListener('click', close);
		rep.addEventListener('click', function () {
			close();
			if (window.DaimondSupport) DaimondSupport.report('testnet');
		});
		wrap.addEventListener('click', function (e) { if (e && e.target === wrap) close(); });
		wrap.appendChild(card);
		document.body.appendChild(wrap);
		_open = wrap;
		if (window.DaimondLayers) DaimondLayers.open('testnet', close);
		rep.focus();
	}

	/// Put the chip in, or take it out, to match the net policy.js holds.
	function mount() {
		var have = document.querySelector('.net-chip');
		var on = !!(window.DaimondNet && DaimondNet.isTest());
		if (!on) { if (have && have.parentNode) have.parentNode.removeChild(have); return; }
		if (have) return;
		var host = document.querySelector('.brand-group');
		if (!host) return;
		var chip = elt('button', 'net-chip', 'TEST');
		chip.type = 'button';
		chip.title = tOr('testnet.title', 'Testnet');
		chip.setAttribute('aria-label', tOr('testnet.title', 'Testnet'));
		chip.addEventListener('click', openSheet);
		host.appendChild(chip);
	}

	try { window.addEventListener('daimond:policy', mount); } catch (e) { /* no events here */ }
	mount();

	window.DaimondTestnet = { open: openSheet, mount: mount };
})();
