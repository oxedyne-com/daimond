/* ============================================================
   Daimond — triggered actions (DaimondTriggers)
   ------------------------------------------------------------
   Notes2, §Diamonds: "Lets allow diamonds to have some
   automation. … new triggered actions (TAs) can be added with a
   + icon, and selected for editing from a pulldown."

   A triggered action is: something happens, and a Diamond's
   daimon is sent an instruction about it. Three triggers ship,
   which are the three notes2 names:

     Daimon Prompted             you typed something to it
     N minutes of user activity  a timer that only runs while
                                 you are actually working
     Email arrival in folder X   mail landed where you said

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
	/// `payload` is what reaches the daimon, and it is not the same for all
	/// three: a prompt carries what the user typed, and a timer or an arrival
	/// carries the instruction the user wrote when they set the TA up. Notes2
	/// states both, and the difference is the reason `fire` takes the occasion
	/// rather than composing from the record alone.
	var KINDS = {
		prompted: { payload: 'user',        needs: [] },
		activity: { payload: 'instruction', needs: ['minutes'] },
		mail:     { payload: 'instruction', needs: ['mailbox', 'folder'] },
	};

	/// A TA as stored. `id` is stable for the life of the action, because it is
	/// half of the pause-tree leaf id and a renumbering would silently resume
	/// something the user paused.
	function blank(kind) {
		return {
			id:          '',
			kind:        kind || 'prompted',
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

	/// The record every Diamond has whether or not the user has touched it.
	///
	/// Notes2: "Currently a diamond daimon is always on, so every diamond has the
	/// first TA ('Daimon Prompted') which defaults to on (play)." It is a real
	/// record rather than an implied one so that it has a pause leaf like the
	/// rest -- an always-on thing with no control is the decoration rule again.
	function defaults() {
		var t = blank('prompted');
		t.id = 'prompted';
		return { v: 1, actions: [t] };
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
		// The always-there one. Added rather than assumed, and only when the file
		// does not already carry it -- a user who deleted it has said something.
		if (!out.actions.some(function (t) { return t.id === 'prompted'; })
			&& !raw) {
			out.actions.unshift(defaults().actions[0]);
		}
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
		if (KINDS[t.kind].payload === 'instruction' && !String(t.instruction || '').trim()) {
			return false;
		}
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
	/// * `said` - What the user typed, for a `prompted` TA. Ignored otherwise.
	function compose(t, said) {
		var body = (KINDS[t.kind] && KINDS[t.kind].payload === 'user')
			? String(said || '')
			: String(t.instruction || '');
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

	var activeMs = 0;
	var lastTick = 0;
	var sawInput = false;

	/// Called by the page on any sign of life.
	function noteActivity() { sawInput = true; }

	/// Advance the clock by `ms` if the user did anything in that window, and
	/// return the total activity accumulated. `reset` zeroes it, which the caller
	/// does when a TA fires on it.
	function tickActivity(ms) {
		if (sawInput) activeMs += Math.max(0, ms | 0);
		sawInput = false;
		return activeMs;
	}
	function activityMinutes() { return activeMs / 60000; }
	function resetActivity() { activeMs = 0; }

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
	/// * `occasion` - `{ kind, minutes, mailbox, folder }`. `kind` is what
	///   happened; the rest narrows it for the kinds that need narrowing.
	function due(diamondId, actions, occasion) {
		var kind = occasion && occasion.kind;
		if (!kind || !KINDS[kind]) return [];
		return (actions || []).filter(function (t) {
			if (t.kind !== kind) return false;
			if (!allowed(diamondId, t)) return false;
			if (kind === 'activity') {
				return (occasion.minutes || 0) >= (t.minutes || 30);
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
