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

	// SAY THE CARD AGAIN WHERE IT STANDS, when the language changes under it.
	//
	// This is a question somebody is part-way through answering, so it is relabelled
	// and never rebuilt: a redraw would take away the code they had half typed and
	// the focus with it. Each state of the card leaves a function here that puts its
	// own words right in place, and closing the card clears the slot.
	//
	// ONE registration, against whatever card is up, rather than one per opening --
	// `DaimondI18n.surface` has no way to let go of a registration, and a card that
	// registered on every open would leave one behind each time.
	var relabelCard = null;
	if (window.DaimondI18n) {
		DaimondI18n.surface(
			function () { return document.querySelector('.beta-scrim'); },
			function () { if (relabelCard) relabelCard(); });
	}

	function overlay(build) {
		var scrim = el('div', 'beta-scrim');
		var box   = el('div', 'beta-box');
		scrim.appendChild(box);
		var prev = document.activeElement;			// where the keyboard was.
		function close() {
			relabelCard = null;
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
			var h3   = el('h3', null, titleFor(s.refused));
			var lead = el('p', null, leadFor(s));
			var have = el('p', null, t('beta.have_code'));
			box.appendChild(h3);
			box.appendChild(lead);
			box.appendChild(have);

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
			// ── And the way to ASK for one ─────────────────────────
			//
			// This card told people to have a passcode and gave them no way to get
			// one, which was merely unhelpful while there was nowhere to send them
			// and is a dead end now that `/apply.html` exists. A route in
			// production that nothing reaches is the defect this codebase keeps
			// finding, and it is found from the outside every time.
			//
			// `?for=test` is not decoration: the form reads the query to choose
			// between applying to the test and joining the waitlist, and somebody
			// arriving from a REFUSAL is asking for the first. A bare path would
			// land them on whichever half the form defaults to.
			//
			// LAST IN THE CARD, deliberately. The dialog opens with the keyboard on
			// the first control that is not the closer; a link above the field
			// would take that focus, and the field is what somebody holding a code
			// came here for. It also reads in the right order: put the code in, and
			// if you have none, here is how to ask.
			//
			// A new tab rather than a navigation. Leaving the page would take the
			// app down with it -- a refused device still has Diamonds, a provider
			// key and possibly a turn running -- to show a form.
			// `beta-ask` and not `beta-note`: the note class dims its whole subtree
			// with `opacity`, and opacity cannot be undone by a child -- the link
			// would be dimmed with the sentence around it.
			var ask = el('p', 'beta-ask', t('beta.no_code') + ' ');
			var a = el('a', 'beta-apply', t('beta.apply'));
			// Root-absolute, as `/console/` is: the app is one document at the site
			// root and this is its sibling, so a relative path would only differ
			// from this by being wrong the first time anything is served deeper.
			a.href = '/apply.html?for=test';
			a.target = '_blank';
			a.rel = 'noopener';
			ask.appendChild(a);
			box.appendChild(ask);

			go.addEventListener('click', submit);
			input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });

			// Every word the card is built from, gathered where they can be said again.
			// `go` is left alone while it is disabled: that is a redemption in flight,
			// carrying "Redeeming…", and putting "Redeem" back over it would report a
			// request as finished that has not been answered.
			relabelCard = function () {
				h3.textContent   = titleFor(s.refused);
				lead.textContent = leadFor(s);
				have.textContent = t('beta.have_code');
				lab.textContent  = t('beta.code');
				input.setAttribute('placeholder', t('beta.code_ph'));
				not.textContent  = t('dlg.not_now');
				if (again) again.textContent = t('beta.try_again');
				if (!go.disabled) go.textContent = t('beta.redeem');
				if (ask.firstChild) ask.firstChild.nodeValue = t('beta.no_code') + ' ';
				a.textContent = t('beta.apply');
			};
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
		// Nothing here is typed into, so this state's words are said again by drawing
		// it over -- which is also the only way to reach the consent block's own.
		relabelCard = function () { done(box, close, r); };
		box.innerHTML = '';
		box.appendChild(el('h3', null, t('beta.done_title')));
		box.appendChild(el('p', null, r && r.pro ? t('beta.done_pro') : t('beta.done_plain')));
		if (r && r.handle) {
			box.appendChild(el('p', 'beta-note', t('beta.done_handle', { handle: r.handle })));
		}
		if (r && !r.authed) {
			box.appendChild(el('p', 'beta-note', t('beta.done_not_signed_in')));
		}

		// ── And the one question we ask them ───────────────────
		//
		// HERE, AND NOT A LINE EARLIER. The code is spent, the account exists and
		// the Pro licence is granted before this is drawn, so nothing about
		// saying no can cost them anything -- which is the difference between
		// asking and extracting. A consent collected while somebody is still
		// waiting to find out whether their passcode worked is not freely given.
		var ask = canAsk(r);
		if (ask) {
			box.appendChild(consentBlock(ask, close));
		} else {
			var row = el('div', 'beta-row');
			var ok = el('button', 'beta-btn', t('common.close'));
			ok.type = 'button';
			ok.addEventListener('click', close);
			row.appendChild(ok);
			box.appendChild(row);
		}
		if (window.DaimondCloser) {
			var h3 = box.querySelector('h3');
			box.insertBefore(
				DaimondCloser.head(h3.textContent || '', { titleEl: h3, onClose: close }),
				box.firstChild);
		}
		try { ok.focus(); } catch (e) { /* not focusable */ }
	}

	// ── The one question, and the only place it is asked ───────
	//
	// WHAT THIS IS. A beta tester may agree to send counts of how they use
	// Daimond -- numbers, never words. `www/js/telemetry.js` is the whole of what
	// would be sent and says so in prose a tester can read; the Privacy Policy
	// says it again at `#beta-telemetry`, which the link below opens IN THE APP
	// (a PWA tab draws itself, and a consent line pointing at another origin is a
	// consent line with nowhere to point).
	//
	// FOUR THINGS THIS CARD HAS TO BE, and each is a line of code below rather
	// than an intention:
	//
	//   1. A REAL CHOICE. Two buttons of the same weight, neither pre-pressed,
	//      neither dressed as the way out. Nothing is ticked, because there is no
	//      tick: consent here is a function call that only a press can make.
	//   2. DECLINING AS EASY AS AGREEING, and the DEFAULT. Closing the card,
	//      pressing Escape, clicking the scrim, walking away -- every one of them
	//      leaves `consent()` uncalled, so silence is a no. There is no path
	//      through this file that agrees on somebody's behalf.
	//   3. HONEST ABOUT THE COST. It says what is sent, what is never sent, that
	//      it is not anonymous, and that saying no costs nothing -- because it
	//      does not: the account, Pro and everything else are already granted by
	//      the time this is drawn.
	//   4. WITHDRAWABLE, AND IT SAYS WHERE. The same question lives in the
	//      Credits drawer for as long as the account does, so "you can turn it
	//      off in Credits" names a control that is really there. See `render`.

	/// Can this reply be turned into a question worth asking?
	///
	/// All four, or the card stays quiet: a client to record with, an intake to
	/// record under, an account to scope the agreement to, and a session -- a
	/// redemption that could not sign in has nothing to send under, and asking
	/// then would be collecting an answer we could not honour.
	function canAsk(r) {
		if (!window.DaimondTelemetry) return null;
		if (!r || !r.authed) return null;
		var wave = r.wave, account = r.account;
		if (typeof wave !== 'number' || wave < 1 || !account) return null;
		return { wave: wave, account: account };
	}

	/// Say yes, for this account. The one call in this file that starts a
	/// recorder, and it is reachable only from a button.
	function grant(ask) {
		try { DaimondTelemetry.consent({ wave: ask.wave, account: ask.account }); }
		catch (e) { /* a build without the client; the question was not drawn */ }
	}

	/// Say no, or take it back. Also the only call that stops one.
	function revoke() {
		try { DaimondTelemetry.withdraw(); }
		catch (e) { /* nothing to withdraw from */ }
	}

	/// The words, the link and the two buttons.
	///
	/// `after` is what to do once either button is pressed -- close the card, or
	/// redraw the drawer. It is called for BOTH answers and with no argument
	/// saying which, so nothing downstream can behave differently for a person
	/// who declined.
	function consentBlock(ask, after) {
		var wrap = el('div', 'beta-consent');
		wrap.appendChild(el('div', 'beta-head', t('beta.tel_title')));
		wrap.appendChild(el('p', null, t('beta.tel_lead')));
		wrap.appendChild(el('p', null, t('beta.tel_never')));
		wrap.appendChild(el('p', null, t('beta.tel_who')));
		wrap.appendChild(el('p', 'beta-note', t('beta.tel_free')));

		// The policy, in the panel, at the section that describes this exactly.
		// `DaimondLegal.link` was written for this caller and no other.
		if (window.DaimondLegal && DaimondLegal.link) {
			var p = el('p', 'beta-ask');
			p.appendChild(DaimondLegal.link('privacy', t('beta.tel_more'), 'beta-telemetry'));
			wrap.appendChild(p);
		}

		var row = el('div', 'beta-row');
		// NO FIRST. Not because the order decides anything on its own, but
		// because the eye lands left and the button that costs the reader nothing
		// should be the one it lands on. Both carry `beta-btn`: same size, same
		// weight, same colour.
		var no = el('button', 'beta-btn', t('beta.tel_no'));
		no.type = 'button';
		no.addEventListener('click', function () { revoke(); if (after) after(); });
		row.appendChild(no);

		var yes = el('button', 'beta-btn', t('beta.tel_yes'));
		yes.type = 'button';
		yes.addEventListener('click', function () { grant(ask); if (after) after(); });
		row.appendChild(yes);
		wrap.appendChild(row);
		return wrap;
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

	/// Usage counts, on or off, for an account that is in the test.
	///
	/// TWO STATES AND ONE SET OF WORDS. Off, it draws the same question the
	/// redemption card drew -- same sentences, same link, same two buttons -- so
	/// somebody who said no at the door and has since changed their mind is asked
	/// exactly what they were asked before, rather than being offered a shorter
	/// version that leaves the cost out. On, it says so and offers the way out.
	///
	/// The way out is the reason this exists. Consent that cannot be withdrawn is
	/// not consent, and until this block existed the only honest thing to do with
	/// the whole feature was to leave it unbuilt.
	function telemetryBlock(s) {
		var wrap = el('div', 'beta-tel');
		var on = false;
		try { on = DaimondTelemetry.agreed(s.accountId); } catch (e) { on = false; }
		if (!on) {
			wrap.appendChild(consentBlock({ wave: s.wave, account: s.accountId }, refresh));
			return wrap;
		}
		wrap.appendChild(el('div', 'beta-head', t('beta.tel_title_on')));
		wrap.appendChild(el('p', 'beta-lead', t('beta.tel_on')));
		if (window.DaimondLegal && DaimondLegal.link) {
			var p = el('p', 'beta-ask');
			p.appendChild(DaimondLegal.link('privacy', t('beta.tel_more'), 'beta-telemetry'));
			wrap.appendChild(p);
		}
		var stop = el('button', 'beta-btn', t('beta.tel_stop'));
		stop.type = 'button';
		stop.addEventListener('click', function () {
			revoke();
			// Redrawn from the module's own answer rather than from what this
			// button believes it just did, so what is on screen is what is true.
			refresh();
		});
		wrap.appendChild(stop);
		return wrap;
	}

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
		//
		// BUT A BETA ACCOUNT HAS ONE THING TO SAY HERE, and this is where the
		// consent given at redemption is taken back. It is in the Credits view
		// because that is where this app already answers "what account have I
		// got"; it is in THIS file because this file asked the question, and one
		// question with two surfaces must not become two sets of words.
		//
		// Drawn only for an account the gateway still names in the beta on this
		// boot, which is the same standing `rearm()` reads: a revoked passcode
		// leaves nothing here, because there is nothing left to withdraw.
		if (s.authed) {
			if (window.DaimondTelemetry && s.beta === true && s.wave && s.accountId) {
				h.appendChild(telemetryBlock(s));
			}
			return;
		}
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

	// ── Asked for at the front door ────────────────────────────
	//
	// The identity screen offers three ways in to a browser that has never held
	// an account (`syncDoors`, js/daimond.js). Two are links to /apply.html. The
	// third is this dialog -- and it cannot open there, because a redemption is
	// SIGNED by the device key and a stranger at that screen has none. The order
	// is forced: passphrase first, code second.
	//
	// So the button records that a code is waiting, and `resume()` opens the
	// dialog at the first moment it could work. The flag is sessionStorage and
	// not a variable: creating an identity can end in a reload on some paths,
	// and an intent that a reload forgets is a route that works when tested by
	// hand and not when used.
	var WANT = 'daimond-beta-wanted';

	function wanted() {
		try { return sessionStorage.getItem(WANT) === '1'; }
		catch (e) { return false; }
	}
	function noteWanted(on) {
		try {
			if (on) sessionStorage.setItem(WANT, '1');
			else sessionStorage.removeItem(WANT);
		} catch (e) { /* private mode: the refusal path still gets there */ }
	}

	/// The front door's "I have a passcode".
	///
	/// Returns true when the dialog is up and false when it could not be -- the
	/// caller says what happens next, because what to say depends on the screen
	/// it is said on.
	function front() {
		if (canSign()) { noteWanted(false); show(); return true; }
		noteWanted(true);
		return false;
	}

	/// Open the dialog if one was asked for before it could be opened.
	///
	/// Called once the gate is down and there is a key to sign with. Silent when
	/// nothing was asked for, when the account already exists (there is nothing
	/// left to redeem for), or when the dialog is already on screen.
	function resume() {
		if (!wanted()) return;
		if (!canSign()) return;
		if (acct().authed) { noteWanted(false); return; }
		noteWanted(false);
		// The same delay the refusal path uses, and for the same reason: the
		// identity modal is still fading out of the frame this runs on.
		setTimeout(function () { show(); }, 600);
	}

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

	// ── Recording again, for somebody who already said yes ─────
	//
	// The boot half of consent. A tester agrees once, at redemption; every
	// session after that has to start recording again on its own, and this is
	// the only thing that does it. It is `resume()` and never `consent()`: the
	// difference is that this cannot create an agreement, only restore one that
	// the person made and that the gateway still stands behind on THIS boot.
	//
	// Three facts must line up, and all three come off the gateway's own answer
	// rather than off anything remembered here -- see `beta_standing` in
	// gateway/src/handlers/account.rs. A revoked passcode takes the account's
	// status with it, so the next boot names no wave and this quietly does
	// nothing.

	/// Restore a recorder for an account that has already agreed.
	function rearm() {
		if (!window.DaimondTelemetry) return;			// a build without the client.
		var s = acct();
		if (!s.authed || s.beta !== true || !s.wave || !s.accountId) return;
		try { DaimondTelemetry.resume({ wave: s.wave, account: s.accountId }); }
		catch (e) { /* telemetry may never break the app it reports on */ }
	}

	function start() {
		window.addEventListener('daimond:refused', onRefused);
		// The account moved -- signed in, balance read, logged out. Whatever of
		// ours is on screen is about to be wrong.
		window.addEventListener('daimond:authed',  function () { rearm(); refresh(); });
		window.addEventListener('daimond:credits', function () {
			// AFTER daimond.js's own listener, which redraws the Credits view
			// from scratch when the drawer is open. Ours is registered first --
			// this file is a classic script and daimond.js is a module -- so a
			// direct call here would paint into a block the redraw then walks
			// past. A task boundary puts it back on the correct side.
			setTimeout(refresh, 0);
		});
		// A tab that was already signed in when this file loaded raises no
		// `daimond:authed` for us to hear, and that is the ordinary case on a
		// reload. Without this line consent survived a reload in name only.
		rearm();
		refresh();
	}

	// ── Public surface ─────────────────────────────────────────

	window.DaimondPasscode = {
		/// The dialog. `show()` reads the gateway state; `show({reason})` says
		/// which refusal it is answering.
		show:    show,
		/// Draw the Credits drawer's block from the state as it stands now.
		render:  render,
		/// The identity screen's "I have a passcode". True when the dialog is up,
		/// false when the intent was recorded for `resume()` instead.
		front:   front,
		/// Open a dialog `front()` could not, now that there is a key to sign with.
		resume:  resume,
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
