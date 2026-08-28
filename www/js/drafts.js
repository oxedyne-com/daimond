/* ============================================================
   Daimond — what somebody is half-way through typing (drafts.js)
   ------------------------------------------------------------
   A screen refresh used to empty every box in the app. A note
   part-written in the Social panel, a reply part-written on a
   proposal, a message part-typed to a daimon: reload, and the
   words were gone with nothing anywhere reporting that anything
   had been lost. Reported by the owner in those terms -- "I would
   expect all live text input to persist" -- and he is right: a
   text box is the one place in an app where the user, not the
   app, is holding the only copy.

   So every live box in the app registers here, and this keeps
   what is in it on this device until it is sent or cleared.

   ── A DRAFT IS NOT A SEND QUEUE, AND THIS FILE IS NOT ONE ───

   The next person to read this will think it breaks the Social
   panel's central promise. It does not, and the difference is
   worth stating rather than leaving to be re-derived.

   `dev/IMPROVE_CONTRACT.md` §4: "A note leaves this device only
   when a person presses Send on that one note, and what leaves is
   exactly the characters that are on the screen at that moment.
   Nothing about a note is queued, retried, batched, synced or
   kept for later sending."

   Every clause of that survives, because what is forbidden is
   SENDING WITHOUT A PRESS and this file has no sender in it. It
   holds no network code, imports none, and is reachable by
   nothing that does. A draft here is not "waiting to go" -- it is
   waiting to be LOOKED AT, by the person who typed it, on the
   device they typed it on. `outgoing()` still reads the box at
   the moment of the press, so what leaves is still what is on the
   screen; restoring the box is what puts it on the screen in the
   first place.

   The clause that would have been broken is "kept for later
   SENDING", and the word is doing all the work. A queue outlives
   the consent that filled it: the user said yes once, the app
   remembered the yes, and the text goes later without anybody
   present. Here nothing was consented to at all -- Send was never
   pressed -- so there is no consent to outlive, and the text goes
   only if a person comes back and presses the button while
   looking at it.

   THREE RULES THAT KEEP IT THAT WAY, and each is a thing this
   file deliberately does not do:

   - IT NEVER SYNCS. `sync.js` collects a parcel from named
     stores; this key is in none of them, so a draft is one
     device's and stays there. A draft that crossed to a phone
     would be text moving without a press, which is the thing.
   - IT NEVER SENDS, RETRIES OR SCHEDULES. There is no timer here
     that does anything but write to disk, and nothing here reads
     a draft except the box it came from.
   - IT IS DROPPED THE MOMENT THE BOX IS. Sending, keeping and
     clearing all drop the draft, so a sent note is not also a
     draft of itself sitting in storage afterwards.

   ── WHERE IT LIVES ──────────────────────────────────────────

   One `daimond-drafts` record, so `accounts.js` namespaces the
   whole of it per account with no call site aware of it -- two
   people at one browser have two sets of drafts and neither can
   see the other's. NOT one key per box: a box whose owner is gone
   (a proposal nobody will open again, a chat that was deleted)
   would leave a key nothing ever removes, and a hundred of those
   is a storage quota spent on nothing.

   Not encrypted, and that is a decision rather than an oversight.
   The identity may be locked when a box needs restoring -- the
   whole point is that it survives a reload, which lands on the
   passphrase gate -- so a wrapped draft could not be put back
   until the user had unlocked, which is exactly the moment they
   are looking at the box. It sits beside the chat store, which is
   also plaintext and holds the same words once they are sent.

   Attaches one global, `window.DaimondDrafts`.
   ============================================================ */
(function () {
	'use strict';

	var LS = 'daimond-drafts';

	/// The most one box may keep. The Social panel's own note cap, because that is
	/// the longest thing any of these boxes may legally send -- a draft larger
	/// than what could be sent is a draft of something that would be refused.
	var MAX = 20000;

	/// How long after the last keystroke the draft is written.
	///
	/// A write on every character would put the whole box through `JSON.stringify`
	/// and `localStorage` per keypress, which is synchronous and on the main
	/// thread. Long enough to cost nothing while typing, short enough that a
	/// reload a moment after stopping still finds the words.
	var SETTLE = 400;

	var _all  = null;			// key -> text, lazily read
	var _timer = 0;

	function read() {
		if (_all) return _all;
		_all = {};
		try {
			var raw = localStorage.getItem(LS);
			if (raw) {
				var j = JSON.parse(raw);
				if (j && typeof j === 'object' && j.d && typeof j.d === 'object') {
					Object.keys(j.d).forEach(function (k) {
						if (typeof j.d[k] === 'string' && j.d[k]) _all[k] = j.d[k];
					});
				}
			}
		} catch (e) { /* blocked or corrupt: everything starts empty, which is the old behaviour */ }
		return _all;
	}

	/// Write the whole record. Failure is SILENT and that is deliberate: a full
	/// quota must not put an error in front of somebody who is typing, and the
	/// worst case is exactly what the app did before this file existed.
	function flush() {
		_timer = 0;
		try { localStorage.setItem(LS, JSON.stringify({ v: 1, d: read() })); }
		catch (e) { /* private mode, or full */ }
	}

	function later() {
		if (_timer) return;
		_timer = setTimeout(flush, SETTLE);
	}

	/// What is kept under this key, or ''.
	function get(key) {
		var s = read()[String(key)];
		return typeof s === 'string' ? s : '';
	}

	/// Keep what is in a box. An empty value DROPS the entry rather than storing
	/// one: a box somebody emptied on purpose must not come back full.
	function set(key, text) {
		var k = String(key);
		var s = String(text == null ? '' : text);
		if (s.length > MAX) s = s.slice(0, MAX);
		var all = read();
		if (!s) { if (!(k in all)) return; delete all[k]; }
		else    { if (all[k] === s) return; all[k] = s; }
		later();
	}

	/// Forget one draft, at once rather than on the timer. Called where a box is
	/// sent or cleared, so a sent note is never also a draft of itself.
	function drop(key) {
		var all = read();
		if (!(String(key) in all)) return;
		delete all[String(key)];
		flush();
	}

	/// Forget every draft whose key starts with `pre` -- one conversation's, one
	/// proposal's -- for a caller that is deleting the thing they belong to.
	function dropUnder(pre) {
		var all = read(), p = String(pre), hit = false;
		Object.keys(all).forEach(function (k) {
			if (k.indexOf(p) === 0) { delete all[k]; hit = true; }
		});
		if (hit) flush();
	}

	/// Attach a box to a key: put back what was kept, and keep what is typed.
	///
	/// Returns the restored text, so a caller that has to do something else about
	/// it -- resize a composer, redraw a counter -- can tell whether anything came
	/// back without reading the box a second time.
	///
	/// A box already bound to this key is not bound twice; a box bound to a
	/// DIFFERENT key is re-pointed, which is what a reused element needs.
	function bind(el, key) {
		if (!el) return '';
		var k = String(key);
		if (el.dataset.draftKey === k) return String(el.value || '');
		el.dataset.draftKey = k;
		var had = get(k);
		if (had && !el.value) el.value = had;
		if (!el.dataset.draftBound) {
			el.dataset.draftBound = '1';
			el.addEventListener('input', function () {
				set(el.dataset.draftKey || '', el.value);
			});
		}
		return String(el.value || '');
	}

	// A reload can arrive before the settle timer has fired, and the words typed
	// in that last fraction of a second are exactly the ones somebody is most
	// annoyed to lose. `pagehide` rather than `unload`, which a browser back/forward
	// cache does not fire.
	if (typeof window !== 'undefined' && window.addEventListener) {
		window.addEventListener('pagehide', function () { if (_timer) { clearTimeout(_timer); flush(); } });
		window.addEventListener('visibilitychange', function () {
			if (document.visibilityState === 'hidden' && _timer) { clearTimeout(_timer); flush(); }
		});
	}

	window.DaimondDrafts = {
		MAX:       MAX,
		get:       get,
		set:       set,
		drop:      drop,
		dropUnder: dropUnder,
		bind:      bind,
		/// Write now rather than on the settle timer. For a caller about to do
		/// something that ends the page, and for a test that will not wait.
		flush:     function () { if (_timer) clearTimeout(_timer); flush(); },
		/// Everything kept, for a verifier. A copy, so reading cannot alter it.
		all:       function () { return JSON.parse(JSON.stringify(read())); },
		/// Forget the lot. For an account switch and for a test.
		reset:     function () { _all = null; if (_timer) { clearTimeout(_timer); _timer = 0; } },
	};
})();
