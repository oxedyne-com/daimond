/* ============================================================
   Daimond — secrets as he types them.
   ------------------------------------------------------------
   Every field that takes a secret (a passphrase, a provider key,
   a mailbox password, a token, a voice) is masked, and every one
   wears the same eye inside its end, so a long secret typed on a
   phone can be checked before it is sent (D-20261025-10).

   It exists because the app had one eye, on the two passphrase
   fields of the identity screen, while the provider key, the push
   token, the search key, the mailbox password and the passphrase
   prompts had none. One control, built here, drawn by one rule
   (app.css `.pass-eye`) and measured as one role
   (dev/verify_consistency.mjs `eye-toggle`).

   The rules the mechanism keeps:

     TWO KINDS OF FIELD, ONE CALL. A real `type="password"` input
     reveals by swapping its type. A field masked by `mask` (a text
     input showing bullets, so no manager offers to file somebody
     else's bearer credential) exchanges its bullets for the value
     it holds. `reveal` does whichever the field needs.

     NOTHING ABOUT THE FIELD CHANGES BUT WHAT IS SHOWN. The
     autocomplete, name and manager attributes are left as they
     were, so revealing never makes a browser offer to save, or
     stop offering.

     IT GOES BACK TO HIDDEN BY ITSELF. Emptied (typed away, or set
     to '' by `set`), submitted (Enter in the field, a form's
     submit, or the caller's own `hide` at its Save), the field is
     masked again, so a secret is never left showing for the next
     thing typed into it.

   Classic, and loaded after the words and before anything that
   builds a field, so `window.DaimondSecret` is there whether the
   caller is a module (daimond.js) or a classic script (models.js,
   tracker.js, improve.js, the console's admin.js).
   ============================================================ */
(function () {
	'use strict';

	var BULLET = '•';

	// The eye's two faces: an open eye to show, a struck-through one to hide.
	var EYE_OPEN = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">'
		+ '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/>'
		+ '<circle cx="12" cy="12" r="2.6"/></svg>';
	var EYE_OFF = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">'
		+ '<path d="M2 12s3.5-6.5 10-6.5c1.8 0 3.4.5 4.8 1.2M22 12s-3.5 6.5-10 6.5c-1.8 0-3.4-.5-4.8-1.2"/>'
		+ '<path d="M9.5 9.7a2.6 2.6 0 003.6 3.6M4 4l16 16"/></svg>';

	// The console (www/console) carries no tables: it is read in English.
	var EN = { 'common.show_secret': 'Show', 'common.hide_secret': 'Hide' };
	function t(k) { return window.DaimondI18n ? window.DaimondI18n.t(k) : EN[k]; }
	function dots(n) { return new Array(n + 1).join(BULLET); }

	// ── The mask ───────────────────────────────────────────────
	// The true value lives on `el._real`; the displayed value is bullets. The
	// input handler diffs the change so typing, pasting, backspace, mid-string
	// edits and select-all-replace all preserve the underlying value.
	function mask(el, initial) {
		if (!el || el._secretMasked) return;
		el._secretMasked = true;
		el.setAttribute('autocomplete', 'off');
		el.setAttribute('data-1p-ignore', '');
		el.setAttribute('data-lpignore', 'true');
		el.setAttribute('spellcheck', 'false');
		el._real = initial || '';
		el._revealed = false;
		el.value = dots(el._real.length);
		el.addEventListener('input', function () {
			// Revealed: the field shows the real text, so it IS the value.
			if (el._revealed) { el._real = el.value; return; }
			var old = el._real;
			var cur = el.value;
			// Common leading run of bullets (unchanged prefix).
			var p = 0;
			while (p < old.length && p < cur.length && cur.charAt(p) === BULLET) p++;
			// Common trailing run of bullets (unchanged suffix).
			var s = 0;
			while (s < (old.length - p) && s < (cur.length - p) && cur.charAt(cur.length - 1 - s) === BULLET) s++;
			var inserted = cur.slice(p, cur.length - s);	// the freshly typed or pasted text
			el._real = old.slice(0, p) + inserted + old.slice(old.length - s);
			el.value = dots(el._real.length);
			var caret = p + inserted.length;
			try { el.setSelectionRange(caret, caret); } catch (e) { /* not focusable yet */ }
		});
	}

	function get(el) { return el ? (el._real != null ? el._real : el.value) : ''; }

	function set(el, v) {
		if (!el) return;
		v = v || '';
		// An emptied field starts hidden again: what is typed next is a new secret.
		if (!v && el._revealed) reveal(el, false);
		if (el._real != null) {
			el._real = v;
			el.value = el._revealed ? v : dots(v.length);
		} else {
			el.value = v;
		}
	}

	/// Show or hide a secret field's real text. Reading and typing keep working
	/// in both states; only the display changes, and the eye is redrawn to match.
	function reveal(el, show) {
		if (!el) return;
		el._revealed = !!show;
		if (el._real == null) {
			el.type = show ? 'text' : 'password';
		} else {
			el.value = show ? el._real : dots(el._real.length);
		}
		var caret = el.value.length;
		try { el.setSelectionRange(caret, caret); } catch (e) { /* not focusable yet */ }
		paint(el);
	}

	function hide(el) { if (el && el._revealed) reveal(el, false); }

	// ── The eye ────────────────────────────────────────────────
	/// Redraw a field's eye to say what pressing it will do.
	function paint(el) {
		var b = el && el._eye;
		if (!b) return;
		var shown = !!el._revealed;
		var key = shown ? 'common.hide_secret' : 'common.show_secret';
		b.innerHTML = shown ? EYE_OFF : EYE_OPEN;	// trusted markup, built here
		b.setAttribute('aria-pressed', shown ? 'true' : 'false');
		// The key rides on the button, so a change of language repaints it.
		b.setAttribute('data-i18n-title', key);
		b.setAttribute('data-i18n-aria-label', key);
		b.title = shown ? t('common.hide_secret') : t('common.show_secret');
		b.setAttribute('aria-label', b.title);
	}

	/// Give a secret field its eye, and return the box that now holds both, which
	/// is what a caller still building its row appends in place of the field.
	///
	/// A field already in the page is wrapped where it stands; one inside a
	/// `.pass-wrap` already (the identity screen's markup) keeps that box. The
	/// field's own inline margins move to the box, which is now what sits in the
	/// flow.
	function eye(el) {
		if (!el) return null;
		if (el._eye) return el._eye.parentNode;
		var box = el.parentNode;
		if (!box || !box.classList || !box.classList.contains('pass-wrap')) {
			box = document.createElement('div');
			box.className = 'pass-wrap';
			if (el.parentNode) el.parentNode.insertBefore(box, el);
			box.appendChild(el);
			['marginTop', 'marginBottom'].forEach(function (m) {
				if (el.style[m]) { box.style[m] = el.style[m]; el.style[m] = ''; }
			});
		}
		var b = document.createElement('button');
		b.type = 'button';				// never submit an enclosing form
		b.className = 'pass-eye icon-btn';
		if (el.id) { b.id = el.id + '-eye'; b.setAttribute('aria-controls', el.id); }
		box.appendChild(b);
		el._eye = b;
		if (el._revealed == null) el._revealed = false;
		paint(el);
		b.addEventListener('click', function (e) {
			e.preventDefault();
			reveal(el, !el._revealed);
			try { el.focus(); } catch (x) { /* not on screen */ }
		});
		// Emptied: hidden again. The mask's own handler runs first, so `get` is current.
		el.addEventListener('input', function () { if (el._revealed && !get(el)) reveal(el, false); });
		// Enter is how a field is submitted from the keyboard.
		el.addEventListener('keydown', function (e) { if (e.key === 'Enter') hide(el); });
		return box;
	}

	// A form's submit hides every secret in it, before the browser reads the
	// fields: a revealed password left as `type="text"` at that moment is not
	// offered to a manager.
	document.addEventListener('submit', function (e) {
		var f = e.target;
		if (!f || !f.querySelectorAll) return;
		Array.prototype.forEach.call(f.querySelectorAll('input'), hide);
	}, true);

	window.DaimondSecret = {
		BULLET: BULLET,
		mask:   mask,
		get:    get,
		set:    set,
		reveal: reveal,
		hide:   hide,
		eye:    eye,
	};
})();
