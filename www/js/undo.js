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
   are drawn at one fixed place and two of them are a mess (D8).

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
	var held = null;		// { text, revert, commit, since, timer }
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
	function able(opts) {
		opts = opts || {};
		// The one before it stands, now — never two windows open at once (D8).
		flush();
		var ms = typeof opts.ms === 'number' && opts.ms > 0 ? opts.ms : DEFAULT_MS;
		held = {
			text:   String(opts.text == null ? '' : opts.text),
			revert: opts.revert,
			commit: opts.commit,
			since:  Date.now(),
			timer:  null,
		};
		var node = ensureEl();
		node._text.textContent = held.text;
		node._btn.textContent = tOr('undo.undo', 'Undo');
		node._btn.setAttribute('aria-label', tOr('undo.undo', 'Undo'));
		node.hidden = false;
		// Raised after the node is shown, so the transition has a frame to run in.
		try { requestAnimationFrame(function () { if (el) el.classList.add('up'); }); }
		catch (e) { node.classList.add('up'); }
		held.timer = setTimeout(flush, ms);
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
		undo:    undo,
		DEFAULT_MS: DEFAULT_MS,
	};
})();
