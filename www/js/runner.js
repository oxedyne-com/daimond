/* ============================================================
   runner.js — THIS MACHINE'S RUNNER POSTURE.
   ------------------------------------------------------------
   The account nominates ONE device the always-on runner (the ✭
   in Settings › Devices; daimond.js owns `daimond-nominated`).
   That nomination says WHERE a hand-off should go. It does not
   say that the named machine is actually set up to be one, and
   until this module nothing did: a nominated laptop beat, parked
   only while the Social panel happened to be open, dropped its
   screen lock the moment it went to the background, and drifted
   onto an old build because the updater refuses to reload an
   unlocked tab. Presence said "available" the whole time.

   So the posture is a SECOND, LOCAL answer, and it is the
   machine's own: "yes, I am the runner -- keep me awake and
   keep me listening." Per-computer, in localStorage, never in
   the sync parcel -- exactly like the autonomous posture
   (daimond.js `AUTONOMOUS_KEY`) and for the same reason:
   arming the desktop must not arm the phone.

   WHY IT IS ASKED FOR RATHER THAN ASSUMED. Holding a screen
   wake lock for the life of the process and parking a long-poll
   for ever are things a person should say yes to on the machine
   it happens on. The nomination can be made from the phone; the
   consequences land here.

   READ-ONLY ON EVERYTHING IT DOES NOT OWN. The nominee and this
   device's id are read straight out of their localStorage keys
   and never written, so the roster and the nomination stay in
   one place (daimond.js) and this file cannot race it.
   ============================================================ */
(function () {
	'use strict';

	// Written by daimond.js; read here and NEVER written.
	var NOMINATED_KEY = 'daimond-nominated';	// { id, at }: the account's chosen runner
	var DEVICE_ID_KEY = 'daimond-device-id';	// this device's own id

	// This machine's own answer, and nowhere else. `collectSync` packs a fixed,
	// named set of fields, so a key it does not name never travels -- and neither
	// of these is named there. See dev/verify_runner_posture.mjs, which asserts it.
	var RUNNER_KEY = 'daimond-runner-posture';	// '1' = this machine is the runner
	var ASK_KEY    = 'daimond-runner-asked';	// the nominee id already put to the user

	// Slow on purpose. The nomination arrives by sync, which is slower than this,
	// and the only other thing the tick does is re-ask for a lock the browser may
	// have taken back.
	var TICK_MS = 15000;

	var _tick  = null;
	var _held  = false;		// is a wake lock held ON THE POSTURE'S BEHALF?
	var _asking = false;	// a confirm is on screen, so a second is not raised

	/// The English wording stands in where a locale has no entry. `tOr`, not `t`,
	/// because a missing key must read as a sentence rather than as `runner.confirm`.
	function tOr(k, fallback, v) {
		try {
			var s = DaimondI18n.t(k, v);
			return (s && s !== k) ? s : fallback;
		} catch (e) { return fallback; }
	}

	function get(k) {
		try { return localStorage.getItem(k); } catch (e) { return null; }
	}
	function put(k, v) {
		try { localStorage.setItem(k, v); } catch (e) { /* private mode */ }
	}
	function drop(k) {
		try { localStorage.removeItem(k); } catch (e) { /* private mode */ }
	}

	/// The nominated device's id, or '' when none is set or the record is unreadable.
	/// Tolerant by design: a record this build cannot parse reads as no nomination,
	/// which turns the posture OFF rather than arming a machine on a guess.
	function nominee() {
		var raw = get(NOMINATED_KEY);
		if (!raw) return '';
		try {
			var rec = JSON.parse(raw);
			return (rec && typeof rec === 'object') ? String(rec.id || '') : '';
		} catch (e) { return ''; }
	}

	/// This device's id, or '' before one has been minted.
	function self() { return String(get(DEVICE_ID_KEY) || ''); }

	/// Does THIS machine hold the runner posture?
	///
	/// Off by silence, and off on any read error, for the reason `autonomousPosture`
	/// reads false when it cannot tell: a machine that cannot say whether it was
	/// armed was not armed.
	function isRunner() { return get(RUNNER_KEY) === '1'; }

	// ── The state machine ──────────────────────────────────────
	//
	// Pure, and separated out so a test can drive every transition without a
	// browser, a dialog or a clock (www/js/runner.test.mjs). Four inputs, and the
	// answer says what to DO rather than what is true, so the caller has no second
	// opinion to form.

	/// What this pass should do, given where things stand.
	///
	/// # Arguments
	/// * `st.self`    - this device's id, '' when not minted yet.
	/// * `st.nominee` - the account's nominated runner, '' for none.
	/// * `st.posture` - does this machine already hold the posture?
	/// * `st.asked`   - the nominee id already put to the user, '' for none.
	///
	/// Answers `{ act, why }`, where `act` is one of:
	///   'wait'  - nothing is known yet; change nothing.
	///   'hold'  - the posture is right as it stands.
	///   'ask'   - this device is the nominee and has never been asked: ask.
	///   'arm'   - turn the posture on (the answer was yes).
	///   'clear' - turn it off, and forget having asked.
	function decide(st) {
		st = st || {};
		var me = String(st.self || ''), nom = String(st.nominee || '');
		var on = !!st.posture, asked = String(st.asked || '');
		// No id yet means the identity is still coming up. Deciding here would read
		// "not the nominee" off a blank and clear a posture that is correct.
		if (!me) return { act: 'wait', why: 'no-device-id' };
		// Un-nominated, or the nomination moved to another machine: the posture goes
		// with it, unasked. This is the whole of "cleared when un-nominated", and it
		// also forgets the asking, so re-nominating this device asks again rather
		// than silently re-arming it.
		if (nom !== me) {
			return (on || asked) ? { act: 'clear', why: nom ? 'nominee-elsewhere' : 'un-nominated' }
				: { act: 'hold', why: 'not-nominee' };
		}
		if (on)          return { act: 'hold', why: 'armed' };
		// Asked once and not armed means the answer was no. Asking again every
		// fifteen seconds is the behaviour a person would rightly call broken.
		if (asked === me) return { act: 'hold', why: 'declined' };
		return { act: 'ask', why: 'nominee-unasked' };
	}

	/// Should the screen wake lock be held right now? The posture is the whole of
	/// it: a runner is kept awake whatever it is doing, unlike the per-turn lock
	/// `DaimondWake` holds while a turn is in flight.
	function wantsWake(st) { return !!(st && st.posture); }

	/// Should parking be started on boot? Only with the posture set AND the identity
	/// unlocked -- a locked tab has no keys to open an errand with, so parking it
	/// would hold a long-poll open for answers it cannot read.
	function wantsPark(st) { return !!(st && st.posture && st.unlocked); }

	// ── Acting on it ───────────────────────────────────────────

	/// Arm or disarm this machine. Published so a settings control can set it
	/// outright without going through the nomination prompt.
	function setPosture(on) {
		if (on) put(RUNNER_KEY, '1'); else drop(RUNNER_KEY);
		syncWake();
		return isRunner();
	}

	/// Hold a wake lock for the life of the process while the posture is set, and
	/// let it go the moment it is not. `DaimondWake` is COUNTED, so this takes
	/// exactly one count and gives exactly one back -- a second hold would be a
	/// count that never reaches zero.
	///
	/// The browser drops the lock whenever the page is hidden and hands it back to
	/// nobody, so `regain` is asked on every return to visible. That is why the
	/// posture is a lock "for process life" and not one request at boot.
	function syncWake() {
		var W = window.DaimondWake;
		if (!W) return false;				// daimond.js has not loaded yet; the tick retries
		var want = isRunner();
		if (want && !_held)  { try { W.hold(); } catch (e) { return false; } _held = true; }
		if (!want && _held)  { try { W.release(); } catch (e) { /* gone with the page */ } _held = false; }
		if (want && _held)   { try { W.regain(); } catch (e) { /* inert where unsupported */ } }
		return _held;
	}

	/// Start listening for dispatched errands now, rather than when somebody opens
	/// the Social panel. Idempotent (post.js `parkStart` refuses a second start), so
	/// it is safe beside the `daimond:unlock` listener daimond.js already arms.
	function startPark() {
		var unlocked = false;
		try { unlocked = !!(window.DaimondIdentity && DaimondIdentity.isUnlocked()); }
		catch (e) { unlocked = false; }
		if (!wantsPark({ posture: isRunner(), unlocked: unlocked })) return false;
		try { if (window.DaimondPost && DaimondPost.parkStart) DaimondPost.parkStart(); }
		catch (e) { return false; }
		return true;
	}

	/// Put the question, once, on the machine it lands on. Resolves whether the
	/// posture ended up set.
	function ask() {
		if (_asking) return Promise.resolve(isRunner());
		var me = self();
		_asking = true;
		put(ASK_KEY, me);		// BEFORE the answer: a dialog dismissed by a reload is not a yes
		var C = window.DaimondCore;
		var msg = tOr('runner.confirm',
			'This device is the runner. Keep it awake and listening for turns handed to it, '
			+ 'even when its window is in the background. Leave it switched on and signed in.');
		var okLabel = tOr('runner.confirm_ok', 'This device is the runner');
		var p;
		try {
			p = (C && C.confirm) ? C.confirm(msg, okLabel,
				{ title: tOr('runner.confirm_title', 'Make this device the runner?'), danger: false })
				: Promise.resolve(false);
		} catch (e) { p = Promise.resolve(false); }
		return Promise.resolve(p).then(function (yes) {
			_asking = false;
			if (yes) { setPosture(true); startPark(); }
			return isRunner();
		}, function () { _asking = false; return isRunner(); });
	}

	/// One pass: read where things stand, and do the one thing `decide` names.
	/// Answers the act taken, so a test and a verifier read the same word.
	function reconcile() {
		var st = { self: self(), nominee: nominee(), posture: isRunner(), asked: get(ASK_KEY) || '' };
		var d = decide(st);
		if (d.act === 'clear') { drop(RUNNER_KEY); drop(ASK_KEY); syncWake(); }
		else if (d.act === 'ask') { ask(); }
		else syncWake();
		return d;
	}

	/// Start watching. Idempotent.
	///
	/// It POLLS, at fifteen seconds, rather than hooking the nomination's own
	/// writer. The nomination is a localStorage record another device's parcel can
	/// move at any moment, and the `storage` event fires only in OTHER tabs -- so
	/// there is no event this tab could listen to that covers both. A read of one
	/// key every fifteen seconds is cheaper than the coupling would be.
	function start() {
		if (_tick) return false;
		reconcile();
		startPark();
		_tick = setInterval(reconcile, TICK_MS);
		return true;
	}

	try {
		document.addEventListener('visibilitychange', function () {
			if (document.visibilityState !== 'visible') return;
			// The lock is gone -- the browser takes it back on hidden and returns it to
			// nobody -- so a runner that was backgrounded asks again here. Parking is
			// re-armed too: a throttled background tab may have lost its loop.
			syncWake();
			startPark();
		});
	} catch (e) { /* no document: the module is inert, which is the right failure */ }
	try { window.addEventListener('daimond:unlock', function () { reconcile(); startPark(); }); }
	catch (e) { /* no window */ }
	try { if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	} else { start(); } } catch (e) { /* inert */ }

	window.DaimondRunner = {
		KEY:       RUNNER_KEY,
		ASK_KEY:   ASK_KEY,
		/// Does THIS machine hold the runner posture? Read by the presence beat, so
		/// every other device can see which machine is actually set up to be one.
		on:        isRunner,
		/// The pure decisions, published for www/js/runner.test.mjs.
		decide:    decide,
		wantsWake: wantsWake,
		wantsPark: wantsPark,
		/// One pass of the state machine, answering the act it took.
		reconcile: reconcile,
		/// Arm or disarm outright, for a settings control.
		set:       setPosture,
		/// Put the question now, whatever the tick is doing.
		ask:       ask,
		start:     start,
		/// What is actually held, for a verifier that has to prove any of this.
		state:     function () {
			return { posture: isRunner(), wake: _held, asked: get(ASK_KEY) || '',
				nominee: nominee(), self: self() };
		},
	};
})();
