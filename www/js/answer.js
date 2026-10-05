/* ============================================================
   Daimond -- the answer rule.
   ------------------------------------------------------------
   A control a person presses either ACTS or VISIBLY ANSWERS why it
   cannot. It never does nothing.

   It exists because the dead-controls crawl found seventeen controls
   that took a press and changed nothing on screen: the Ask pill with an
   empty field, the four Compose buttons, Workspace Refresh. Each had its
   own `if (!ready) return;` and none said so (D-20261003-07).

   The rule, in two halves, kept in one place:

     KNOWN BEFORE THE PRESS. `can()` names the reason a control cannot act
     (a field is empty, nothing is open), or says nothing. A reason MARKS
     the control `aria-disabled` and becomes its title; no reason clears
     the mark and gives its own title back. The control is NOT given the
     real `disabled`: a disabled button takes no click, so a tap on a
     phone, which shows no title, would change nothing and say nothing
     (r533 QA B-4). The stylesheets dim `[aria-disabled="true"]` as they
     dim `:disabled`. `sync()` re-asks, and runs by itself whenever a
     watched field changes, and for every control (`syncAll`) when the
     state a reason reads is published after the control was built.

     KNOWN ONLY AFTER. Whatever the control does on a press ends in a
     note where its surface already keeps notes: that is `act`'s own work.
     The one case here is a press on a control with a reason (a tap, a
     key, or state that changed in between): `can()` is asked again, and
     its reason goes to `say`. Only a hold, a send in flight, sets the
     real `disabled`, and has no reason to give.

   A CONTEXTUAL control, one that only means something in a state (the two
   walk-back buttons under the chat), is not gated: it is HIDDEN while it
   cannot act (`shown`, `show`), since less on screen is the aim. A press on
   a standing control that Refreshes or redraws the same thing ends in a
   `note` where the panel keeps its figures, so it never looks like none.

   A control is only built through `control`; the wiring test refuses a
   new one that binds its own click and returns silently.
   ============================================================ */
(function () {
	'use strict';

	var kept = new WeakMap();	// el -> { was, why }: the title it had before a reason took its place
	var made = new WeakMap();	// el -> control, so a second `control` on one element is the first
	var all  = [];

	// Mark `el` aria-disabled with `why` as its title, or clear the mark and restore the title.
	function gate(el, why) {
		if (!el) return false;
		var st = kept.get(el);
		if (why) {
			var cur = el.getAttribute('title');
			if (!st) st = { was: cur, why: why };
			// A language change rewrites the title under us; what it wrote is the one to give back.
			else if (cur !== st.why) st.was = cur;
			st.why = why;
			kept.set(el, st);
			el.disabled = false;			// a press must still arrive, to be answered
			el.setAttribute('aria-disabled', 'true');
			el.setAttribute('title', why);
			return true;
		}
		el.disabled = false;
		el.removeAttribute('aria-disabled');
		if (st) {
			if (st.was === null || st.was === undefined) el.removeAttribute('title');
			else if (el.getAttribute('title') === st.why) el.setAttribute('title', st.was);
			kept.delete(el);
		}
		return false;
	}

	// opts: can() -> reason | '' ; act(ev) ; say(reason, true) ; fields: [element] whose input/change re-asks.
	function control(el, opts) {
		if (!el) return null;
		if (made.has(el)) return made.get(el);
		var o = opts || {};
		var held = false;
		function sync() {
			var why = held ? '' : String((o.can && o.can()) || '');
			gate(el, why);
			if (held) el.disabled = true;
			return why;
		}
		function go(ev) {
			if (held) return false;
			var why = sync();
			if (why) { if (o.say) o.say(why, true); return false; }
			if (o.act) o.act(ev);
			return true;
		}
		el.addEventListener('click', go);
		(o.fields || []).forEach(function (f) {
			if (!f) return;
			f.addEventListener('input', sync);
			f.addEventListener('change', sync);
		});
		// Held while it works (a send in flight): really disabled, with no reason to give, since the note says what it is doing.
		var c = { el: el, sync: sync, go: go, hold: function (on) { held = !!on; sync(); } };
		made.set(el, c);
		all.push(c);
		sync();
		return c;
	}

	function syncAll() { all.forEach(function (c) { c.sync(); }); }

	// Why each control cannot act, as the key of the words for `t()`, or '' when it can. Pure, so every state is
	// tested without a page; the caller says it in the viewer's language. A new control adds its row here.
	var reasons = {
		// The Ask pill needs the composer behind it, and a question.
		ask:   function (s) {
			if (s.ready === false) return 'common.not_ready';
			return String(s.text || '').trim() ? '' : 'sheet.ask_empty';
		},
		// Compose's Send needs a message open and someone to send it to.
		send:  function (s) { return !s.open ? 'compose.none_open' : (String(s.to || '').trim() ? '' : 'compose.err_no_to'); },
		// Save Draft, Attach and Discard need a message open.
		draft: function (s) { return s.open ? '' : 'compose.none_open'; },
		// Mail's Sync now needs a mailbox to sync.
		sync_mail: function (s) { return s.sel ? '' : 'trig.no_mailbox'; },
		// The home composer's Send needs words; with a turn running and the box empty it is Stop, which needs none.
		send_home: function (s) { return (s.stop || String(s.text || '').trim()) ? '' : 'sheet.ask_empty'; },
	};

	// Whether a contextual control can act now, from the thread's measures: `users` questions, scrolled `top`,
	// whole `height` and visible `view`. True shows it; false hides it. The 48 is the thread's own "at the end".
	var shown = {
		// Walking back needs a question to walk to and more thread than window (a pixel is rounding).
		jump_back: function (s) { return s.users > 0 && s.height - s.view > 1; },
		// The end needs somewhere below the reader.
		jump_end:  function (s) { return s.height - s.top - s.view >= 48; },
	};

	// Show or hide a contextual control through `hidden`, which CSS must honour (`[hidden] { display: none }`).
	function show(el, on) {
		if (!el) return false;
		el.hidden = !on;
		return !!on;
	}

	// A line at the head of `host` that answers a press (Refresh), one at a time, gone after `ms`.
	function note(host, text, isErr, ms) {
		if (!host) return null;
		var old = host.querySelector('.panel-say');
		if (old && old.parentNode) old.parentNode.removeChild(old);
		var n = host.ownerDocument.createElement('div');
		n.className = 'panel-say' + (isErr ? ' err' : '');
		n.setAttribute('role', 'status');
		n.textContent = text;
		host.insertBefore(n, host.firstChild);
		setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, ms || 3000);
		return n;
	}

	// A language change rewrites titles and the words of every reason.
	if (typeof window !== 'undefined' && window.DaimondI18n && window.DaimondI18n.onChange) window.DaimondI18n.onChange(syncAll);

	var api = { gate: gate, control: control, syncAll: syncAll, reasons: reasons, shown: shown, show: show, note: note };
	if (typeof window !== 'undefined') window.DaimondAnswer = api;
})();
