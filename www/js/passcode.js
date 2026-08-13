/* passcode.js — the beta passcode, and the refusal that sends somebody to it.
 *
 * WHAT WAS MISSING. The gateway has minted beta passcodes, spent them inside
 * the one critical section that writes the account, and refused every stranger
 * without one, for as long as `/api/passcode/redeem` has existed. Nothing in the
 * browser ever called it. A person holding a code had no box to put it in, and a
 * person refused for not holding one was told nothing at all: `bootstrap()`
 * turned the 403 into `offline`, and the app dropped quietly into BYOK-only
 * mode looking broken. This file is both halves — the sentence, and the door.
 *
 * TWO PLACES, ONE SCREEN. The refusal raises the dialog itself, once, because
 * somebody who has just been refused is looking at the app right now and
 * deserves to be told by it rather than to work it out. The same dialog is
 * reachable afterwards from the Credits drawer, which is where this app already
 * answers "what account have I got" — because the person who gets a code a week
 * later has long since dismissed the dialog. There is one dialog and one set of
 * words; the drawer carries a button to it, not a second copy of it.
 *
 * WHAT IS NOT DRAWN. The passcode field appears only where it could actually
 * work: an identity that exists and is unlocked (the redemption is signed by the
 * device key, so a locked app has nothing to sign with) and no account yet. A
 * field that would refuse the moment it is used is the trap this codebase keeps
 * falling into, and it is cheaper not to draw it.
 *
 * The gateway contract lives in gateway.js, next to the registration it IS —
 * `DaimondGateway.redeemPasscode`. This file collects a code, says what came
 * back, and owns no protocol of its own.
 */
(function () {
	'use strict';

	/// What the app says.
	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	/// The gateway's view of this device, or an empty one on a stripped build.
	function acct() {
		try {
			return (window.DaimondGateway && DaimondGateway.state()) || {};
		} catch (e) { return {}; }
	}

	/// Is there a key here to sign a redemption with?
	///
	/// Both halves. An identity that exists but is locked cannot sign, and an
	/// app with none cannot either -- and the two need different sentences, so
	/// they are asked separately wherever the difference shows.
	function canSign() {
		return !!(window.DaimondIdentity
			&& DaimondIdentity.exists()
			&& DaimondIdentity.isUnlocked());
	}

	/// The heading for a refusal, or for the dialog opened with none on record.
	///
	/// THREE, not two. With no refusal on record -- the gateway was never asked,
	/// or could not be reached at all -- naming a closed beta would be a claim
	/// about a server this device has heard nothing from. That is the state a
	/// device is in whenever the gateway is simply down, which is common, so the
	/// wrong heading there would be the one most people saw.
	function titleFor(reason) {
		if (reason === 'beta_only')   return t('beta.title');
		if (reason === 'unavailable') return t('beta.title_unavailable');
		return t('beta.title_plain');
	}

	/// The sentence explaining where this device stands.
	///
	/// The app's own words, in the reader's language, keyed on the machine
	/// `reason` -- which is exactly what the gateway documents that field for.
	/// A reason this build has never heard of falls through to the gateway's own
	/// English, kept verbatim in `state.refusal`, so a refusal added on the
	/// server is still legible in an old tab rather than silently blank.
	function leadFor(s) {
		if (s.refused === 'beta_only')   return t('beta.lead_beta_only');
		if (s.refused === 'unavailable') return t('beta.lead_unavailable');
		if (s.refusal)                   return s.refusal;
		return t('beta.lead_no_reason');
	}

	// ── The dialog ─────────────────────────────────────────────
	//
	// The same shape pairing.js uses for the same kind of moment: a scrim, a
	// card, Escape and a Tab that stays inside it, and the one cross every
	// surface in this app wears.

	function overlay(build) {
		var scrim = el('div', 'beta-scrim');
		var box   = el('div', 'beta-box');
		scrim.appendChild(box);
		var prev = document.activeElement;			// where the keyboard was.
		function close() {
			document.removeEventListener('keydown', onKey, true);
			try { document.body.removeChild(scrim); } catch (e) { /* already gone */ }
			if (prev && prev.focus && prev.getClientRects && prev.getClientRects().length) {
				try { prev.focus(); } catch (e) { /* gone with a redraw */ }
			}
		}
		/// The controls in here that can take focus.
		function stops() {
			return [].filter.call(
				box.querySelectorAll('button,input,a[href],[tabindex]:not([tabindex="-1"])'),
				function (n) { return !n.disabled && n.getClientRects().length; });
		}
		function onKey(e) {
			if (e.key === 'Escape') { e.preventDefault(); close(); return; }
			if (e.key !== 'Tab') return;
			var f = stops();
			if (!f.length) return;
			var first = f[0], last = f[f.length - 1];
			if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
			if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
			else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
		}
		document.addEventListener('keydown', onKey, true);
		scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
		build(box, close);
		if (window.DaimondCloser) {
			var h3 = box.querySelector('h3');
			var row = h3
				? DaimondCloser.head(h3.textContent || '', { titleEl: h3, onClose: close })
				: DaimondCloser.head('', { name: t('common.close'), onClose: close });
			box.insertBefore(row, box.firstChild);
		}
		document.body.appendChild(scrim);
		// The first real control, not the closer: the way out should not be what
		// the keyboard lands on in a card that exists to be answered.
		var f0 = stops().filter(function (n) { return !n.classList.contains('ui-close'); })[0]
			|| stops()[0];
		if (f0) { try { f0.focus(); } catch (e) { /* not focusable */ } }
		return close;
	}

	/// Is a dialog of ours already up? Two of these over each other would be one
	/// code field the user cannot see behind another.
	function isOpen() { return !!document.querySelector('.beta-scrim'); }

	/// The screen: what the gateway said, and the box that answers it.
	///
	/// `opts.reason` overrides what the gateway state carries, for the one caller
	/// that has a refusal in hand before the state has caught up. Everything else
	/// reads the state, so the dialog says the same thing however it was opened.
	function show(opts) {
		if (isOpen()) return;
		opts = opts || {};
		var s = acct();
		if (opts.reason) { s = Object.assign({}, s, { refused: opts.reason }); }

		overlay(function (box, close) {
			box.appendChild(el('h3', null, titleFor(s.refused)));
			box.appendChild(el('p', null, leadFor(s)));
			box.appendChild(el('p', null, t('beta.have_code')));

			var lab = el('label', 'beta-label', t('beta.code'));
			lab.setAttribute('for', 'beta-code-input');
			box.appendChild(lab);
			var input = el('input', 'beta-input');
			input.id = 'beta-code-input';
			input.setAttribute('placeholder', t('beta.code_ph'));
			input.setAttribute('autocapitalize', 'off');
			input.setAttribute('autocomplete', 'off');
			input.setAttribute('autocorrect', 'off');
			input.setAttribute('spellcheck', 'false');
			box.appendChild(input);

			var err = el('div', 'beta-err');
			box.appendChild(err);

			var row = el('div', 'beta-row');
			var not = el('button', 'beta-btn ghost', t('dlg.not_now'));
			not.type = 'button';
			not.addEventListener('click', close);
			row.appendChild(not);

			// Only for the refusal it answers. A gateway that could not read its
			// own gate is asked again; one that refused on purpose would give the
			// same answer to the same question, and a button that redoes a
			// decision is a button that lies about what it does.
			var again = null;
			if (s.refused === 'unavailable') {
				again = el('button', 'beta-btn ghost', t('beta.try_again'));
				again.type = 'button';
				again.addEventListener('click', async function () {
					err.textContent = '';
					again.disabled = true;
					var got = false;
					try { got = !!(await DaimondGateway.bootstrap()); } catch (e) { got = false; }
					again.disabled = false;
					refresh();
					if (got) { done(box, close, { created: false, pro: acct().pro === true, authed: true }); }
					else { err.textContent = t('beta.still_closed'); }
				});
				row.appendChild(again);
			}

			var go = el('button', 'beta-btn', t('beta.redeem'));
			go.type = 'button';
			row.appendChild(go);
			box.appendChild(row);

			async function submit() {
				if (go.disabled) return;
				err.textContent = '';
				go.disabled = true;
				var was = go.textContent;
				go.textContent = t('beta.redeeming');
				try {
					var r = await DaimondGateway.redeemPasscode(input.value);
					refresh();
					done(box, close, r);
				} catch (e) {
					go.disabled = false;
					go.textContent = was;
					// The gateway's own distinction, said in the reader's
					// language and not softened into one answer: see
					// `redeemWords` in gateway.js.
					err.textContent = (e && e.message) || t('beta.err_generic');
					try { input.focus(); input.select(); } catch (e2) { /* gone */ }
				}
			}
			go.addEventListener('click', submit);
			input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
		});
	}

	/// What the card says once the code is spent.
	///
	/// The account exists from here whatever else happened, so nothing in this
	/// panel may read as a failure. The one thing that can still be untrue is
	/// the session -- `redeemPasscode` reports it rather than throwing, because
	/// the credential is gone and telling somebody it did not work would leave
	/// them with no way back in -- so that is said plainly and separately.
	function done(box, close, r) {
		box.innerHTML = '';
		box.appendChild(el('h3', null, t('beta.done_title')));
		box.appendChild(el('p', null, r && r.pro ? t('beta.done_pro') : t('beta.done_plain')));
		if (r && r.handle) {
			box.appendChild(el('p', 'beta-note', t('beta.done_handle', { handle: r.handle })));
		}
		if (r && !r.authed) {
			box.appendChild(el('p', 'beta-note', t('beta.done_not_signed_in')));
		}
		var row = el('div', 'beta-row');
		var ok = el('button', 'beta-btn', t('common.close'));
		ok.type = 'button';
		ok.addEventListener('click', close);
		row.appendChild(ok);
		box.appendChild(row);
		if (window.DaimondCloser) {
			var h3 = box.querySelector('h3');
			box.insertBefore(
				DaimondCloser.head(h3.textContent || '', { titleEl: h3, onClose: close }),
				box.firstChild);
		}
		try { ok.focus(); } catch (e) { /* not focusable */ }
	}

	// ── The block in the Credits drawer ────────────────────────
	//
	// WHY THERE. The Credits view is where this app already answers "what
	// account have I got, and what does it cost me" -- the balance, the Pro
	// licence, and the invitation to make an account are all in it. A closed
	// registration is an answer to the same question, so it belongs beside them
	// rather than on a surface of its own that nobody would think to look at.
	// The status row above the drawer already reads "No credits account" for a
	// refused device, and it opens this view, so the chain from the rail to the
	// code field is one click and existed before this file did.
	//
	// It draws into `#credits-beta` and touches nothing else in the view.

	function host() { return document.getElementById('credits-beta'); }

	/// Draw the block, or empty it where there is nothing honest to put in it.
	///
	/// Called by `DaimondCredits.render` -- which daimond.js invokes every time
	/// the Credits view is drawn, on opening it and on a language change -- and
	/// again whenever the account's state moves under an open drawer.
	function render() {
		var h = host();
		if (!h) return;
		h.innerHTML = '';
		if (!window.DaimondGateway) return;
		var s = acct();
		// An account already exists: there is nothing here to redeem for, and a
		// passcode field on a signed-in account would be a control looking for a
		// problem.
		if (s.authed) return;
		// Nothing to sign with. The view's own "Create an account" path is the
		// step before this one, and it is already on screen below.
		if (!canSign()) return;

		h.appendChild(el('div', 'beta-head', titleFor(s.refused)));
		h.appendChild(el('p', 'beta-lead', leadFor(s)));
		var b = el('button', 'beta-btn', t('beta.enter_code'));
		b.type = 'button';
		b.id = 'beta-open';
		b.addEventListener('click', function () { show(); });
		h.appendChild(b);
	}

	/// Redraw whatever of ours is on screen. Cheap, and safe from anywhere.
	function refresh() {
		try { render(); } catch (e) { /* the drawer is not built yet */ }
	}

	// ── Being told ─────────────────────────────────────────────

	/// The refusals this browsing session has already put on screen.
	///
	/// Once per reason per session. `bootstrap()` runs on every unlock and the
	/// standing renewal retries on a timer, so a device that is refused is
	/// refused repeatedly -- and a dialog that came back each time would be a
	/// nag rather than an answer. It comes back in a new sitting, because the
	/// state it describes is still true and a person who dismissed it a week ago
	/// has forgotten. The drawer's block carries it in between.
	var SAID = 'daimond-beta-said';

	function alreadySaid(reason) {
		try { return sessionStorage.getItem(SAID) === reason; }
		catch (e) { return false; }				// private mode: say it, rather than never.
	}
	function noteSaid(reason) {
		try { sessionStorage.setItem(SAID, reason); } catch (e) { /* private mode */ }
	}

	function onRefused(ev) {
		var reason = (ev && ev.detail && ev.detail.reason) || acct().refused || '';
		refresh();
		if (!reason || !canSign()) return;
		if (alreadySaid(reason)) return;
		noteSaid(reason);
		// After the frame the unlock is finishing on, so the card does not land
		// on top of the identity modal's own fade.
		setTimeout(function () { show({ reason: reason }); }, 600);
	}

	function start() {
		window.addEventListener('daimond:refused', onRefused);
		// The account moved -- signed in, balance read, logged out. Whatever of
		// ours is on screen is about to be wrong.
		window.addEventListener('daimond:authed',  refresh);
		window.addEventListener('daimond:credits', function () {
			// AFTER daimond.js's own listener, which redraws the Credits view
			// from scratch when the drawer is open. Ours is registered first --
			// this file is a classic script and daimond.js is a module -- so a
			// direct call here would paint into a block the redraw then walks
			// past. A task boundary puts it back on the correct side.
			setTimeout(refresh, 0);
		});
		refresh();
	}

	// ── Public surface ─────────────────────────────────────────

	window.DaimondPasscode = {
		/// The dialog. `show()` reads the gateway state; `show({reason})` says
		/// which refusal it is answering.
		show:    show,
		/// Draw the Credits drawer's block from the state as it stands now.
		render:  render,
	};

	// THE MOUNT POINT. daimond.js's `drawCredits` calls `DaimondCredits.render()`
	// every time the Credits view is drawn -- on opening it, and on a language
	// change -- immediately after `renderCredits` has laid the view out. It is an
	// extension point with no other implementor, and it is the only hook into
	// that view that does not mean editing daimond.js. Anything else wanting to
	// draw in the Credits view has to come through here rather than replace it.
	window.DaimondCredits = { render: render };

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
	else start();
})();
