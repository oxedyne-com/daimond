/* ============================================================
   Daimond — triggered actions (DaimondTriggers)
   ------------------------------------------------------------
   Notes2, §Diamonds: "Lets allow diamonds to have some
   automation. … new triggered actions (TAs) can be added with a
   + icon, and selected for editing from a pulldown."

   A triggered action is: something happens WITHOUT THE USER
   ASKING, and a Diamond's daimon is sent an instruction about it.
   Two triggers ship:

     N minutes of user activity  a timer that only runs while
                                 you are actually working
     Email arrival in folder X   mail landed where you said

   Notes2 named a third, "Daimon Prompted", on every Diamond by
   default. It was built and then removed: prompting a Diamond is
   the user asking, so there was nothing there to arm, and the row
   ended up with a spacer where every other one has a widget. A
   Diamond nobody has automated therefore has NO actions -- which
   is what takes the traffic light off its tile, since it has
   nothing that can spend unbidden.

   ── The three rules that decide everything below ──

   1. A TRIGGER SPENDS, so it is a leaf of the pause tree. The
      tree already has the shape for it -- pause.js documents
      `root/diamonds/<id>/triggers/<n>` -- and a Diamond with one
      trigger held and its daimon running reads amber without
      anyone setting amber. Nothing here decides whether to fire:
      it asks the tree, at the moment of firing.

   2. CONTEXT IS SENT ONCE. Notes2: "Context prepends this if the
      target daimon has not received it before." So the store has
      to remember what each daimon has been told, and it does --
      per TA, as a hash of the context text. Change the context
      and it is sent again, which is what a person means by
      changing it.

   3. THE FILES ARE THE SETTING. They live at
      `diamonds/<id>/triggers.json`, in the open, where the
      System section shows them and a daimon can read and edit
      them with the file tools it already has. Notes2 asks for
      jdat; this is JSON, and the reason is that every other
      browser-side store in this app is JSON, a jdat door from JS
      would be a new wasm surface built for one file, and a model
      reading it as text cannot tell the difference. NOT under
      `.daimond/`, which both trees hide -- "an intuitive system
      directory hierarchy" means one you can see.

   ── What this module does NOT do ──

   It does not run turns. It decides that a turn is owed, to which
   Diamond, with what text, and hands that to a caller which owns
   the daimon. Firing a turn from here would put a second path to
   the model beside `doSteer`, and there would then be two places
   that know how a Diamond spends.

   Attaches `window.DaimondTriggers`. Also exported for Node, so
   the pure decisions can be tested without a browser.
   ============================================================ */
(function () {
	'use strict';

	/// Every trigger kind, with what it needs and what it sends.
	///
	/// `needs` is what a kind cannot fire without. What REACHES the daimon is the
	/// same for both of them -- the instruction the user wrote when they set the
	/// TA up -- so there is no longer a `payload` field to say which; the kind
	/// whose payload was "whatever the user just typed" is gone.
	///
	/// THERE IS NO `prompted` KIND. There was: notes2 said every Diamond carries
	/// a "Daimon Prompted" TA, defaulting to on. It was built, and it was
	/// decoration -- it had no light of its own (the daimon's `/self` leaf is
	/// already that control), no edit, no copy, no delete, and a spacer where
	/// every other row has a widget. The user's ruling, and it is the simpler
	/// model: TYPING A PROMPT IS THE ACTIVATION. There is nothing to arm, so
	/// there is nothing to represent, and a Diamond nobody has automated has no
	/// triggered actions at all.
	///
	/// Removing the kind is also the migration. `normalise` drops an action whose
	/// kind it does not know, so a `triggers.json` written by an earlier release
	/// loses its `prompted` row the first time it is read.
	var KINDS = {
		activity: { needs: ['minutes'] },
		mail:     { needs: ['mailbox', 'folder'] },
	};

	/// A TA as stored. `id` is stable for the life of the action, because it is
	/// half of the pause-tree leaf id and a renumbering would silently resume
	/// something the user paused.
	function blank(kind) {
		return {
			id:          '',
			kind:        kind || 'activity',
			on:          true,
			target:      '',        // '' means the Diamond that owns the TA
			instruction: '',
			context:     '',
			// What context this TA has already sent, so it is sent once. A HASH
			// rather than a flag: changing the context means it has not been sent,
			// which is what a person means by changing it.
			contextSent: '',
			minutes:     30,
			mailbox:     '',
			folder:      'INBOX',
			priority:    'normal',
		};
	}

	/// The record a Diamond starts with, which is an EMPTY one.
	///
	/// Notes2 asked for a first TA on every Diamond -- "Daimon Prompted", always
	/// on -- and it was built. The user has since ruled it out, and the reason is
	/// the rule this whole module is built on: a TA is an arrangement for the
	/// Diamond to spend WITHOUT being asked. Prompting it is being asked. There
	/// is nothing there to arm or hold, which is why that row ended up with a
	/// spacer where every other one has a light.
	///
	/// So a Diamond nobody has automated has no actions, and therefore nothing
	/// spendable of its own -- which is what takes the traffic light off an
	/// ordinary Diamond's tile. See `pauseTree` in daimond.js.
	function defaults() {
		return { v: 1, actions: [] };
	}

	/// Normalise whatever came off disk. A file the user has edited by hand is
	/// the ordinary case here, not the exceptional one, so a missing field is
	/// filled and an unknown kind is dropped rather than throwing.
	function normalise(raw) {
		var out = { v: 1, actions: [] };
		var list = (raw && Array.isArray(raw.actions)) ? raw.actions : [];
		var seen = {};
		list.forEach(function (r, i) {
			if (!r || typeof r !== 'object') return;
			if (!KINDS[r.kind]) return;
			var t = blank(r.kind);
			Object.keys(t).forEach(function (k) {
				if (r[k] !== undefined && r[k] !== null) t[k] = r[k];
			});
			t.on = r.on !== false;
			t.minutes = Math.max(1, Math.round(Number(t.minutes) || 30));
			// An id that is absent or already taken gets one, so two TAs can never
			// share a pause leaf.
			if (!t.id || seen[t.id]) t.id = t.kind + '-' + (i + 1) + '-' + Date.now().toString(36);
			seen[t.id] = 1;
			out.actions.push(t);
		});
		// Nothing is added. There used to be an always-there `prompted` action put
		// back here; a Diamond with no actions is now the ordinary case and means
		// exactly what it says -- this Diamond acts when you prompt it, and at no
		// other time.
		return out;
	}

	/// Does this TA have everything it needs to fire?
	///
	/// Asked before firing rather than at edit time: a file edited by hand can be
	/// half-written, and a mail trigger with no folder would otherwise watch
	/// every folder of every mailbox.
	function ready(t) {
		if (!t || !KINDS[t.kind]) return false;
		if (t.on === false) return false;
		var needs = KINDS[t.kind].needs;
		for (var i = 0; i < needs.length; i++) {
			if (!t[needs[i]]) return false;
		}
		// Every kind sends the instruction the user wrote, so an empty one is a
		// TA that would send nothing.
		if (!String(t.instruction || '').trim()) return false;
		return true;
	}

	/// A short, stable hash of a context, for "has this daimon been told?".
	///
	/// FNV-1a: not a security question, and a 32-bit answer is plenty for
	/// "is this the same paragraph I sent last time".
	function hash(text) {
		var h = 0x811c9dc5, s = String(text || '');
		for (var i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
		}
		return h.toString(16);
	}

	/// What the daimon is actually sent, and whether the context went with it.
	///
	/// Returns `{ text, sentContext }`. The caller writes `contextSent` back only
	/// when the turn was accepted -- composing it here and recording it there is
	/// what stops a refused dispatch from consuming the one chance the context
	/// had to be delivered.
	///
	/// # Arguments
	/// * `t` - The triggered action.
	function compose(t) {
		var body = String(t.instruction || '');
		var ctx = String(t.context || '').trim();
		var fresh = ctx && hash(ctx) !== t.contextSent;
		return {
			text: fresh ? (ctx + '\n\n---\n\n' + body) : body,
			sentContext: fresh ? hash(ctx) : t.contextSent,
		};
	}

	/// The pause-tree leaf for one TA. Kept here so the one shape is written
	/// once; `pause.js` documents it and `daimond.js` builds the tree from it.
	function node(diamondId, actionId) {
		return 'root/diamonds/' + diamondId + '/triggers/' + actionId;
	}

	/// Is this TA allowed to spend right now?
	///
	/// The tree is the authority and it is asked HERE, at the moment of firing,
	/// rather than being copied into the record: a pause that arrived from
	/// another device between the schedule and the fire has to be honoured.
	function allowed(diamondId, t) {
		if (!ready(t)) return false;
		try {
			if (typeof window !== 'undefined' && window.DaimondPause) {
				return !window.DaimondPause.isPaused(node(diamondId, t.id));
			}
		} catch (e) { /* module not up: fall through to allowed */ }
		return true;
	}

	// ── The activity clock ─────────────────────────────────────
	//
	// "N minutes of USER ACTIVITY", not N minutes of wall clock. A timer that
	// ran while the tab sat untouched overnight would greet the user with eight
	// turns they did not ask for and a bill to match -- which is the failure this
	// whole section of notes2 is written against.
	//
	// Activity is a keystroke, a pointer press or a scroll, and the clock counts
	// a minute only if something happened in it. Held in memory rather than on
	// disk: a reload is not activity, and carrying a part-finished interval
	// across one would make a closed tab count towards the next fire.
	//
	// ONE STOPWATCH PER TRIGGERED ACTION, not one for the account. A single
	// counter was the first shape and it starved the longer TAs: firing anything
	// zeroed the one clock, so a 5-minute TA on one Diamond reset the count a
	// 30-minute TA on another was waiting on, every five minutes, for ever. The
	// longer one could not fire -- not late, impossible -- while its light said
	// it was armed. The shortest TA anywhere governed every other one.
	//
	// The per-TA clocks are MARKS against one monotonic total rather than a
	// counter each advanced in step. `activeMs` only ever goes up; a TA remembers
	// the reading it started from, and its age is the difference. A tick then
	// costs the same whatever anybody has armed, and a TA nobody has asked about
	// cannot be advanced by accident.
	//
	// Keyed by the pause-tree leaf, which is the identity a TA already has here --
	// the same string its hold is written against -- so there is no second naming
	// scheme to keep in step with the first.
	//
	// A HELD TA has no clock: `due` drops it before asking its age, so nothing
	// starts counting until it is released. That is what a Diamond seeded paused
	// wants -- the Optimiser's 30-minute timer counts thirty minutes from the day
	// its owner lets it go, not from the day it was made. A TA that WAS running
	// and is then held keeps the mark it already had, so a short hold does not
	// throw away the work that went past before it; whether that should also be
	// put back to the moment of release is a question nobody has answered yet.

	var activeMs  = 0;    // Total activity this page has seen. Monotonic.
	var tickStart = 0;    // The reading at the start of the minute being counted.
	var marks     = {};   // TA leaf -> the reading that TA's own clock started at.
	var sawInput  = false;

	/// Called by the page on any sign of life.
	function noteActivity() { sawInput = true; }

	/// Advance the clock by `ms` if the user did anything in that window.
	///
	/// Returns the running total, which is NOT what any TA is measured against --
	/// `activityMinutes` is, because each one counts from its own mark.
	function tickActivity(ms) {
		tickStart = activeMs;
		if (sawInput) activeMs += Math.max(0, ms | 0);
		sawInput = false;
		return activeMs;
	}

	/// How long this one TA has been counting, in minutes.
	///
	/// Asking starts its clock, so a TA first seen now needs its full N minutes
	/// from now and cannot inherit an hour that accrued before it existed. It
	/// starts at the BEGINNING of the minute it is first asked about, because the
	/// tick counts the minute and then asks what is owed: mark it at the reading
	/// in hand and every timer is a minute late, for its whole first period.
	function activityMinutes(diamondId, actionId) {
		var k = node(diamondId, actionId);
		if (marks[k] === undefined) marks[k] = tickStart;
		return (activeMs - marks[k]) / 60000;
	}

	/// Start this TA's clock again, which the caller does when it FIRED, and only
	/// then.
	///
	/// A dispatch that was refused leaves the mark where it is, so the time it had
	/// accrued is still there on the next tick rather than thrown away. The caller
	/// is the only one who knows the difference: `due` is pure, and cannot see
	/// that a turn was already running or that the Diamond was not on screen.
	function resetActivity(diamondId, actionId) {
		marks[node(diamondId, actionId)] = activeMs;
	}

	// ── What is owed ───────────────────────────────────────────

	/// Which of a Diamond's TAs are due on this occasion.
	///
	/// Pure: it takes the occasion and the records and returns the ones that
	/// should fire. Nothing here reads a clock, opens a file or sends anything,
	/// which is what makes the decision testable and what keeps a second path to
	/// the model out of this module.
	///
	/// # Arguments
	/// * `diamondId` - Whose TAs these are.
	/// * `actions` - The Diamond's normalised list.
	/// * `occasion` - `{ kind, minutesFor, mailbox, folder }`. `kind` is what
	///   happened; the rest narrows it for the kinds that need narrowing.
	///   `minutesFor(diamondId, t)` is how long that ONE TA has been counting,
	///   supplied by the caller because every TA now has its own stopwatch and
	///   this function may not read one -- a lookup handed in keeps the decision
	///   pure, where a module variable read from under it would not be. An
	///   occasion with no lookup is an occasion where nothing has accrued: fail
	///   closed, so a caller that forgets it spends nothing rather than spending
	///   everything.
	function due(diamondId, actions, occasion) {
		var kind = occasion && occasion.kind;
		if (!kind || !KINDS[kind]) return [];
		return (actions || []).filter(function (t) {
			if (t.kind !== kind) return false;
			if (!allowed(diamondId, t)) return false;
			if (kind === 'activity') {
				var mins = (typeof occasion.minutesFor === 'function')
					? Number(occasion.minutesFor(diamondId, t)) || 0
					: 0;
				return mins >= (t.minutes || 30);
			}
			if (kind === 'mail') {
				// A folder is watched by name; a mailbox by address. Both must match,
				// because "Sent" means something different in two accounts.
				return t.mailbox === occasion.mailbox && t.folder === occasion.folder;
			}
			return true;
		});
	}

	var api = {
		KINDS:       KINDS,
		blank:       blank,
		defaults:    defaults,
		normalise:   normalise,
		ready:       ready,
		compose:     compose,
		hash:        hash,
		node:        node,
		allowed:     allowed,
		due:         due,
		// The activity clock.
		noteActivity:    noteActivity,
		tickActivity:    tickActivity,
		activityMinutes: activityMinutes,
		resetActivity:   resetActivity,
	};

	if (typeof window !== 'undefined') window.DaimondTriggers = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
