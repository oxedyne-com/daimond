/* ============================================================
   Daimond — the undo window (undo.js)
   ------------------------------------------------------------
   WHY THIS EXISTS (audit row GEN-02). Nothing in this app could be
   taken back in the second after it was pressed. Delete had the
   Trash panel, which is a different room; rename and fold had
   nothing at all. So an act a person regrets in a second cost them
   a hunt through a panel, or their work.

   ONE TOAST, ONE ACT, FIVE SECONDS. `able` shows an actionable
   toast — role="status", an Undo button, `pointer-events:auto` —
   and holds the act open for `ms`. Press Undo and `revert` runs.
   Let it expire and `commit` runs. One at a time: a second `able`
   commits the first at once rather than stacking, because toasts
   are drawn in one row and two of them are a mess (D8).

   THE SPLIT THAT MAKES IT SAFE. `revert` is cheap and local —
   put the row back on the rail, put the old name back. `commit` is
   where the DESTRUCTIVE tail lives: the tombstone, the compaction,
   the thing that travels and cannot be taken back. An act whose
   tail runs on press is not undoable however good the toast looks,
   which is why the fold's tombstone moved out of
   `clearDaimonSession` and into a commit.

   AND IT NEVER HOLDS AN ACT OPEN PAST ATTENTION. A hidden tab, a
   page going away, or a new turn starting flushes the window: the
   commit runs early rather than late. `dev/verify_versions.mjs
   --break undolate` proves that in reverse.

   The plain `toast()` in daimond.js stays exactly as it is, for
   status that nobody acts on.
   ============================================================ */
(function () {
	'use strict';

	var DEFAULT_MS = 5000;

	// The act in the window, or null. One at a time, always.
	var held = null;		// { text, revert, commit, shown, since, timer }
	var el = null;			// #daimond-undo, built once and reused

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }
	/// The English at the call site, so this file draws a button before the
	/// tables land -- the discipline `js/trash.js` keeps for the same reason.
	function tOr(k, fallback, v) {
		var s = t(k, v);
		if (s !== k) return s;
		if (!v) return fallback;
		return String(fallback).replace(/\{(\w+)\}/g, function (whole, name) {
			return v[name] != null ? String(v[name]) : whole;
		});
	}

	/// The toast, built once. Rebuilt if something removed it from the document,
	/// because a node held in a closure and detached is a toast nobody can press.
	function ensureEl() {
		if (el && el.parentNode) return el;
		el = document.createElement('div');
		el.id = 'daimond-undo';
		el.className = 'daimond-undo';
		// A status region, not an alert: this interrupts nothing and a screen
		// reader should finish the sentence it is on before reading it.
		el.setAttribute('role', 'status');
		el.setAttribute('aria-live', 'polite');
		el.hidden = true;
		var txt = document.createElement('span');
		txt.className = 'daimond-undo-text';
		var btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'daimond-undo-btn';
		btn.addEventListener('click', function (e) {
			e.stopPropagation();
			undo();
		});
		el.appendChild(txt);
		el.appendChild(btn);
		el._text = txt;
		el._btn = btn;
		document.body.appendChild(el);
		return el;
	}

	/// A ROW OF THE COMPOSER, NOT AN OVERLAY (r547 QA-B F1/F2). A toast floating above the
	/// composer covers whatever is drawn there: at a fixed 96px it stood over Send on a phone
	/// (r545 QA-C2), and measured above the input bar it stood over the workspace strip's "+",
	/// "Nothing kept here", the mark notice and the last message's Retry and Edit; at z 9999
	/// it also stood over a tall dialog's buttons. Every one of those was a tap meant for
	/// something else that reverted the turn's files. So the window is a row in the flow, at
	/// the top of the composer area: the layout makes room for it, it covers nothing, and an
	/// open dialog covers it the way it covers the rest of the page.
	///
	/// The composer areas are the bars marked `data-undo-row`; the attribute names the
	/// element the row goes in front of, or is empty for the bar itself. The row goes to the
	/// one a press at its centre reaches (the phone's sheet over the chat, say), else to the
	/// first whose area is drawn even with its bar hidden (a chat panel with no chat open).
	function home() {
		var bars = document.querySelectorAll('[data-undo-row]'), drawn = null, top = null;
		for (var i = 0; i < bars.length && !top; i++) {
			var id = bars[i].getAttribute('data-undo-row');
			var before = (id && document.getElementById(id)) || bars[i];
			var box = before.parentNode;
			if (!box || !box.getBoundingClientRect) continue;
			var br = box.getBoundingClientRect();
			if (!br.width || !br.height) continue;
			if (!drawn) drawn = before;
			var r = bars[i].getBoundingClientRect(), at = null;
			if (r.width && r.height) {
				try { at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); } catch (e) { /* no layout */ }
			}
			if (at && bars[i].contains(at)) top = before;
		}
		var to = top || drawn;
		if (to && (el.parentNode !== to.parentNode || el.nextSibling !== to)) to.parentNode.insertBefore(el, to);
	}

	function hide() {
		if (el) { el.hidden = true; el.classList.remove('up'); }
	}

	function clearTimer() {
		if (held && held.timer) { clearTimeout(held.timer); held.timer = null; }
	}

	/// Run the destructive tail of whatever is in the window, and close it.
	///
	/// The act is taken OUT of the window before its tail runs: a commit that
	/// itself opens an undo window (nothing does today, and one day something
	/// will) must not find itself being committed a second time.
	function flush() {
		if (!held) return;
		var act = held;
		held = null;
		if (act.timer) clearTimeout(act.timer);
		hide();
		try { if (typeof act.commit === 'function') act.commit(); }
		catch (e) { try { console.warn('[undo] the commit threw; the act stands', e); } catch (e2) { /* no console */ } }
	}

	/// Put it back. The revert is the user's own press, so a failure here is
	/// worth a line: it is the one path where they asked for their work back and
	/// did not get it.
	function undo() {
		if (!held) return;
		// An act of a chat that is no longer on screen is withdrawn, never applied to
		// the page now showing (r547 QA-B F3).
		if (!isShown(held)) { flush(); return; }
		var act = held;
		held = null;
		if (act.timer) clearTimeout(act.timer);
		hide();
		try { if (typeof act.revert === 'function') act.revert(); }
		catch (e) { try { console.warn('[undo] the revert threw', e); } catch (e2) { /* no console */ } }
	}

	/// Offer an act back for `ms`, then let it stand.
	///
	/// # Arguments
	/// * `opts.text` - what the toast says; already translated by the caller.
	/// * `opts.ms` - the window, in milliseconds. 5000 where absent.
	/// * `opts.label` - the button's words, already translated; "Undo" where absent.
	/// * `opts.shown` - is what the act belongs to still on screen? Where given, the act is
	///   withdrawn as soon as it is not (`check`), and a press then reverts nothing.
	function able(opts) {
		opts = opts || {};
		// The one before it stands, now — never two windows open at once (D8).
		flush();
		var ms = typeof opts.ms === 'number' && opts.ms > 0 ? opts.ms : DEFAULT_MS;
		held = {
			text:   String(opts.text == null ? '' : opts.text),
			revert: opts.revert,
			commit: opts.commit,
			shown:  typeof opts.shown === 'function' ? opts.shown : null,
			since:  Date.now(),
			timer:  null,
		};
		var node = ensureEl();
		node._text.textContent = held.text;
		var label = opts.label == null || opts.label === '' ? tOr('undo.undo', 'Undo') : String(opts.label);
		node._btn.textContent = label;
		node._btn.setAttribute('aria-label', label);
		home();
		node.hidden = false;
		// Raised after the node is shown, so the transition has a frame to run in.
		try { requestAnimationFrame(function () { if (el) el.classList.add('up'); }); }
		catch (e) { node.classList.add('up'); }
		held.timer = setTimeout(flush, ms);
	}

	function isShown(act) {
		try { return !act.shown || !!act.shown(); } catch (e) { return false; }
	}

	/// Withdraw the act in the window when what it belongs to has left the screen. Called by
	/// every path that changes the chat on screen; an act with no `shown` stays.
	function check() {
		if (held && !isShown(held)) flush();
	}

	/// What is in the window, for anything that has to know whether an act is
	/// still open — a verifier, or a caller deciding whether to ask again.
	function pending() {
		return held ? { text: held.text, since: held.since } : null;
	}

	// ── The three ways attention leaves ──────────────────────────
	//
	// A window held open by a tab nobody is looking at is a deletion that never
	// finishes: the record sits half-deleted, the tombstone is never written, and
	// the other device never hears about it. So the window closes with the
	// attention, and the commit runs EARLY rather than late.
	try {
		document.addEventListener('visibilitychange', function () {
			if (document.visibilityState === 'hidden') flush();
		});
		window.addEventListener('pagehide', function () { flush(); });
	} catch (e) { /* no document: nothing to hold open either */ }

	window.DaimondUndo = {
		able:    able,
		pending: pending,
		flush:   flush,
		check:   check,
		undo:    undo,
		DEFAULT_MS: DEFAULT_MS,
	};
})();
