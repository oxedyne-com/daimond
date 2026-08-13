/* lapse.js — telling the user, in the app, before something of theirs lapses.
 *
 * Two clauses of the Terms promise a notice on this screen, and until now
 * nothing on this screen gave one:
 *
 *   Terms §13 (Termination), and Privacy §9 (Retention), on stored file data:
 *     "…the stored data above the free allowance IS DELETED. We say 'is', not
 *      'may be', because that is what happens. YOU WILL BE TOLD IN THE APP
 *      BEFORE IT HAPPENS, while there is still time to top up or to bring those
 *      files down onto your own device."
 *
 *   Terms §7 (Credits and the Pro licence), on the five-year term:
 *     "Five years after you buy, the licence ends, and you decide then whether
 *      to buy another." The app never said when that was.
 *
 * So this file holds one surface and two facts. It is small, and it is written
 * against a rule: SAY WHAT THE TERMS SAY, AND NOTHING MORE GENEROUS. A notice
 * that softens a deletion, or implies a grace nobody promised, is worse than no
 * notice at all — it is the app telling the user they are safe when they are
 * not. Every sentence below can be traced to a sentence in landing/terms.html,
 * and dev/verify_legalreach.mjs checks that the two agree on the three facts
 * that matter: what switches off, what does not, and what is never deleted.
 *
 * ── Where the facts come from ───────────────────────────────────────
 *
 * The LICENCE half works today. `/api/licence` returns the signed licence
 * record, which carries `issued_ts`, and the term is five years from purchase —
 * that is the published policy, so the date is arithmetic and needs nothing new
 * from the gateway. Where the gateway states an expiry itself (`expires_ts`),
 * that is the authority and is used instead: the server enforces the term, and
 * a client that computed a different date from a rule would be arguing with it.
 *
 * The STORAGE half cannot work until the gateway says so, and does not pretend
 * to. `grace_start` is written and read only inside gateway/src/storage.rs; no
 * handler returns it, so the browser has no way to know an account is in grace.
 * This file asks `/api/balance` for three fields (`storage_grace_start`,
 * `storage_grace_secs`, `storage_paid_bytes`) and draws nothing at all until
 * they arrive. The client half is finished and proved; the promise is not kept
 * until the gateway answers, and saying so plainly is better than a surface
 * that looks built.
 *
 * ── Why it cannot be dismissed for good ─────────────────────────────
 *
 * A × that silences a deletion notice for ever is a × the user will press by
 * reflex on the day they most needed to read it. Dismissal lasts a day, and is
 * keyed to the DATE in the notice, so a deadline that moves says so again at
 * once.
 */
(function () {
	'use strict';

	/// What the app says, falling back to English while a key has no translation.
	/// The twin of `tOr` in daimond.js: this file is a classic script and cannot
	/// reach into that closure. `{name}` in either the translation or the
	/// fallback is filled from `vars`.
	function t(k, fallback, vars) {
		var i18n = window.DaimondI18n;
		if (i18n && i18n.has && i18n.has(k)) return i18n.t(k, vars);
		if (!vars) return fallback;
		return String(fallback).replace(/\{(\w+)\}/g, function (whole, name) {
			return vars[name] != null ? String(vars[name]) : whole;
		});
	}

	// ── What is asked, and how often ────────────────────────────────
	//
	// `/api/balance` reconciles the account before it answers, so it is not a
	// free call and is not polled tightly. Once per session, then every six
	// hours, and again when the tab is brought back after being away that long.
	// A deadline measured in days needs nothing finer.

	var EVERY_MS = 6 * 3600 * 1000;
	var FIRST_MS = 8000;             // after the unlock settles, not during it

	/// How long before a licence ends the app starts saying so. The Terms fix no
	/// notice period for this one — the [TO CONFIRM] on notice periods is about
	/// the storage deletion — so a month is chosen here: long enough to decide
	/// and to buy again, short enough not to be furniture.
	var LICENCE_LEAD_DAYS = 30;

	/// The Pro term, in years. Terms §7: "It is a single payment for a five-year
	/// licence". Used only when the gateway states no expiry of its own.
	var TERM_YEARS = 5;

	/// How long a dismissal lasts.
	var HUSH_MS = 24 * 3600 * 1000;

	var HUSH_KEY = 'daimond-lapse-hushed';

	var state = {
		/// Whether the account is in grace at all.
		storageOn:  false,
		/// Unix ms the stored data is deleted, or 0 when the gateway has not
		/// said how long the grace runs.
		storageAt:  0,
		/// Bytes above the free allowance, as the gateway last reported them.
		paidBytes:  -1,
		/// Unix ms the Pro licence ends, or 0 when no licence is held.
		licenceAt:  0,
	};

	var timer = null;
	var last  = 0;      // when the gateway was last asked, ms

	// ── Words ───────────────────────────────────────────────────────

	/// A date in the language the app is in — not the browser's. A reader who has
	/// put Daimond into German reads every other word of the notice in German.
	function fmtDate(ms) {
		var loc;
		try { loc = window.DaimondI18n ? DaimondI18n.locale() : undefined; }
		catch (e) { loc = undefined; }
		try {
			return new Date(ms).toLocaleDateString(loc || undefined,
				{ day: 'numeric', month: 'long', year: 'numeric' });
		} catch (e) { return ''; }
	}

	/// A size a person reads. The twin of `fmtBytes` in trash.js and daimond.js;
	/// this file is a classic script and cannot reach into either closure.
	function fmtBytes(n) {
		if (!n) return '0 B';
		var u = ['B', 'KB', 'MB', 'GB'], i = 0;
		while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
		return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
	}

	// ── Being quiet for a day ───────────────────────────────────────

	function hushed() {
		try { return JSON.parse(localStorage.getItem(HUSH_KEY) || '{}') || {}; }
		catch (e) { return {}; }
	}

	/// Is this exact notice — this kind, this deadline — put away for now?
	function isHushed(kind, at) {
		var h = hushed()[kind + ':' + at];
		return !!h && (Date.now() - h) < HUSH_MS;
	}

	function hush(kind, at) {
		var h = hushed();
		h[kind + ':' + at] = Date.now();
		// Anything about a deadline that has passed out of the window is dropped,
		// so this key cannot grow for ever.
		Object.keys(h).forEach(function (k) {
			if (Date.now() - h[k] >= HUSH_MS) delete h[k];
		});
		try { localStorage.setItem(HUSH_KEY, JSON.stringify(h)); } catch (e) { /* full, or private */ }
		render();
	}

	// ── Reading the gateway ─────────────────────────────────────────

	/// One session-authed GET, through the gateway's own wrapper so a lapsed
	/// session costs a renewal and not the answer.
	async function ask(path) {
		var g = window.DaimondGateway;
		if (!g || !g.gwFetch) return null;
		var r = await g.gwFetch(path, {
			credentials: 'same-origin',
			headers: { 'x-daimond-api': String(g.clientApi ? g.clientApi() : '') },
		});
		if (!r || !r.ok) return null;
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		if (!j || j.ok === false) return null;
		return j;
	}

	/// When this licence ends, in unix ms, or 0 if there is none.
	///
	/// The gateway's own `expires_ts` wins wherever it is given: the server
	/// enforces the term, so a date computed here from the published rule must
	/// never be shown in preference to the one being enforced.
	function expiryOf(j) {
		if (!j) return 0;
		if (typeof j.expires_ts === 'number' && j.expires_ts > 0) return j.expires_ts * 1000;
		var lic = j.licence;
		if (!lic || typeof lic !== 'object') return 0;
		var issued = Number(lic.issued_ts);
		if (!issued || issued <= 0) return 0;
		// Five calendar years from the purchase, which is what "five years after
		// you buy" means to the person who bought it.
		var d = new Date(issued * 1000);
		d.setFullYear(d.getFullYear() + TERM_YEARS);
		return d.getTime();
	}

	/// Ask the gateway both questions and redraw. Never throws: a gateway that
	/// cannot be reached leaves the last answer standing, which is the honest
	/// state — nothing has been learned, so nothing has changed.
	async function check() {
		var g = window.DaimondGateway;
		if (!g || !g.state || !g.state().authed) return state;
		last = Date.now();

		try {
			var bal = await ask('/api/balance');
			if (bal) {
				// The figure moved on the server while it reconciled; the one place
				// that owns the app's balance is told, rather than this file keeping
				// a second copy of it.
				try { if (g.noteBalance) g.noteBalance(bal); } catch (e) { /* not fatal */ }
				if (typeof bal.storage_grace_start === 'number') {
					var start = bal.storage_grace_start;
					var len   = Number(bal.storage_grace_secs) || 0;
					// TWO FACTS, NOT ONE. Whether the account is in grace and when
					// the grace ends arrive together and could arrive apart, and a
					// missing LENGTH must not silence a notice about a DELETION —
					// the user is owed the warning even where the day cannot be
					// named. No date is ever guessed at: the notice says what it
					// knows and no more.
					state.storageOn = start > 0;
					state.storageAt = (start > 0 && len > 0) ? (start + len) * 1000 : 0;
					state.paidBytes = (typeof bal.storage_paid_bytes === 'number')
						? bal.storage_paid_bytes : -1;
				}
			}
		} catch (e) { /* offline, paused, or refused: say nothing new */ }

		try {
			var lic = await ask('/api/licence');
			if (lic) state.licenceAt = expiryOf(lic);
		} catch (e) { /* as above */ }

		render();
		return state;
	}

	// ── The notice ──────────────────────────────────────────────────

	/// One notice card: a heading, what happens, and what can be done about it.
	function card(spec) {
		var box = document.createElement('div');
		box.className = 'lapse-note lapse-' + spec.kind;
		box.setAttribute('role', 'status');
		box.dataset.kind = spec.kind;
		box.dataset.at   = String(spec.at);

		var head = document.createElement('div');
		head.className = 'lapse-head';
		head.textContent = spec.head;
		box.appendChild(head);

		spec.body.forEach(function (words) {
			var p = document.createElement('p');
			p.className = 'lapse-body';
			p.textContent = words;
			box.appendChild(p);
		});

		var acts = document.createElement('div');
		acts.className = 'lapse-acts';
		spec.acts.forEach(function (a) { acts.appendChild(a); });
		box.appendChild(acts);

		var x = document.createElement('button');
		x.type = 'button';
		x.className = 'lapse-x';
		x.setAttribute('aria-label', t('lapse.hide', 'Hide until tomorrow'));
		x.title = t('lapse.hide', 'Hide until tomorrow');
		x.textContent = '×';
		x.addEventListener('click', function () { hush(spec.kind, spec.at); });
		box.appendChild(x);

		return box;
	}

	/// A button in a notice. Only ever drawn for something that really happens:
	/// see the note on renewal in `licenceSpec`.
	function act(words, go, primary) {
		var b = document.createElement('button');
		b.type = 'button';
		b.className = 'lapse-act' + (primary ? ' lapse-act-primary' : '');
		b.textContent = words;
		b.addEventListener('click', go);
		return b;
	}

	/// A link into the clause the notice is quoting, drawn by js/legal.js so it
	/// opens in Daimond's own panel rather than leaving the app.
	function clause(which, anchor, words) {
		if (window.DaimondLegal && DaimondLegal.link) {
			var a = DaimondLegal.link(which, words, anchor);
			// It is one of this notice's controls as well as a link, so it wears
			// the class the row is styled and asserted through.
			a.className += ' lapse-act';
			return a;
		}
		var span = document.createElement('span');
		span.className = 'lapse-act';
		span.textContent = words;
		return span;
	}

	/// The storage notice, or null when there is nothing to say.
	///
	/// Shown for the WHOLE grace period rather than a few days before the end.
	/// The promise is a notice "while there is still time to top up or to bring
	/// those files down", and the honest reading of that is the earliest moment
	/// the app knows — the day the meter pauses — not the last.
	function storageSpec() {
		if (!state.storageOn) return null;
		var when = state.storageAt ? fmtDate(state.storageAt) : '';
		var body = [
			t('lapse.storage_why',
				'Your credits will not cover the cloud storage you are holding, so the '
				+ 'metering has paused. Nothing is being back-charged, and you can still '
				+ 'read everything you have stored.'),
			t('lapse.storage_what',
				'If the balance is not restored by then, the stored data above the free '
				+ 'allowance is deleted. Files on this device are untouched.'),
		];
		if (state.paidBytes > 0) {
			body.splice(1, 0, t('lapse.storage_size',
				'About {size} is held above the free allowance.',
				{ size: fmtBytes(state.paidBytes) }));
		}
		var acts = [];
		if (window.DaimondAdmin && DaimondAdmin.credits) {
			acts.push(act(t('lapse.top_up', 'Top up credits'), function () {
				DaimondAdmin.credits(t('lapse.credits_pitch',
					'Topping up stops the stored data above the free allowance being deleted.'));
			}, true));
		}
		acts.push(clause('terms', 'storage-lapse', t('lapse.read_clause', 'What the Terms say')));
		return {
			kind: 'storage',
			at:   state.storageAt,
			// Named where it is known, and honestly vague where it is not. Both
			// sentences leave "by then" in the next paragraph with something to
			// refer to.
			head: when
				? t('lapse.storage_head',
					'Stored files above the free allowance will be deleted on {date}.',
					{ date: when })
				: t('lapse.storage_head_undated',
					'Stored files above the free allowance will be deleted when the grace period ends.'),
			body: body,
			acts: acts,
		};
	}

	/// The licence notice, or null when there is nothing to say.
	///
	/// NO RENEW BUTTON, deliberately. `/api/checkout/pro` answers 409 while a
	/// licence record exists for the account, so a Buy again drawn here would be
	/// a button that refuses — and a control that does not do what it appears to
	/// do is the defect this app keeps shipping. When checkout accepts a second
	/// purchase after a term ends, one belongs here.
	function licenceSpec() {
		if (!state.licenceAt) return null;
		var now  = Date.now();
		var lead = LICENCE_LEAD_DAYS * 86400 * 1000;
		if (state.licenceAt - now > lead) return null;
		var over = state.licenceAt <= now;
		var when = fmtDate(state.licenceAt);
		return {
			kind: 'licence',
			at:   state.licenceAt,
			head: over
				? t('lapse.lic_head_past', 'Your Pro licence ended on {date}.', { date: when })
				: t('lapse.lic_head', 'Your Pro licence ends on {date}.', { date: when }),
			body: [
				over
					? t('lapse.lic_off_past',
						'Cross-device sync, cloud storage and Daimond Email are off, because each '
						+ 'of those is a service we run on our side.')
					: t('lapse.lic_off',
						'Cross-device sync, cloud storage and Daimond Email switch off then, because '
						+ 'each of those is a service we run on our side.'),
				t('lapse.lic_keep',
					'Everything on this device carries on exactly as before: your files, your chats, '
					+ 'your Diamonds, your identity and your own provider key. Nothing is deleted, '
					+ 'nothing is locked, and nothing you have made becomes unreadable.'),
				t('lapse.lic_pull',
					'Pulling down what you have already stored never stops, and your credits are '
					+ 'unaffected.'),
			],
			acts: [clause('terms', 'five-years', t('lapse.read_clause', 'What the Terms say'))],
		};
	}

	/// Draw whatever is true and not hushed, and take down whatever is not.
	function render() {
		var host = document.getElementById('lapse-notices');
		var specs = [storageSpec(), licenceSpec()].filter(function (s) {
			return s && !isHushed(s.kind, s.at);
		});
		if (!specs.length) {
			if (host && host.parentNode) host.parentNode.removeChild(host);
			return;
		}
		if (!host) {
			host = document.createElement('div');
			host.id = 'lapse-notices';
			host.className = 'lapse-notices';
			document.body.appendChild(host);
		}
		// Redrawn whole. There are at most two of these and they change about
		// twice a year; keeping them in place would be machinery for nothing.
		host.textContent = '';
		specs.forEach(function (s) { host.appendChild(card(s)); });
	}

	// ── Running ─────────────────────────────────────────────────────

	function start() {
		if (timer) return;
		timer = setInterval(function () { check(); }, EVERY_MS);
		setTimeout(function () { check(); }, FIRST_MS);
	}

	// There is a session now — the same event sync and the credit header wait
	// for. Before it, `/api/balance` has nobody to answer about.
	window.addEventListener('daimond:authed', start);

	// A tab that has been away for longer than the interval asks on its way back,
	// because a background tab's timers are throttled to the point of stopping.
	document.addEventListener('visibilitychange', function () {
		if (document.hidden) return;
		if (Date.now() - last >= EVERY_MS) check();
	});

	// The language can change under an open notice.
	if (window.DaimondI18n && DaimondI18n.onChange) DaimondI18n.onChange(function () { render(); });

	window.DaimondLapse = {
		/// Ask the gateway now, and redraw. Returns what it learned.
		check:  check,
		/// What it last learned, as a copy.
		state:  function () { return Object.assign({}, state); },
		/// Redraw from what is already known.
		render: render,
	};
})();
