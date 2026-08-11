/* ============================================================
   Daimond — the closer.
   ------------------------------------------------------------
   One cross, built one way, for every dialog, popover, drawer and
   sheet the app puts over the top of itself.

   It exists because the app had five of them. A panel head wrote
   its × in static markup, the tile dialog drew one in JS, the
   phone sheet used the '✕' character, the admin drawer used '×',
   and the appearance menu — the one the user actually reported —
   had none at all. Five spellings of one control drift, and four
   of the five were under the thumb's floor.

   The rules the mechanism keeps:

     A CROSS CLOSES THE ONE THING IT SITS ON. Never something
     larger. `name` says which thing, out loud, so a screen reader
     hears "Close Appearance and layout" rather than a fourth
     button called Close.

     THE INK IS DRAWN, NOT TYPED. A glyph's ink is not centred in
     its own em box and which box it gets depends on whichever font
     the platform found it in; a path on the 24-unit grid is
     centred by geometry.

     THE TARGET IS A THUMB'S, THE INK IS AN EYE'S. `.ui-close` is
     28px on a pointer and 44px where the pointer is coarse (see
     app.css), while the drawn cross stays 16px in both. The floor
     is the point of this file: on a phone the appearance menu left
     19px of screen either side of itself to tap, which is not a
     way out.

   Classic, and loaded before everything that builds a surface, so
   `window.DaimondCloser` is there whether the caller is a module
   (daimond.js) or a classic script (workspace.js, mobile.js).
   ============================================================ */
(function () {
	'use strict';

	/// The app's cross. The same path the static markup uses (www/index.html,
	/// every panel head), so a closer built in JS is the identical mark to one
	/// written in HTML.
	var SVG = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

	function t(k, v) { return window.DaimondI18n ? window.DaimondI18n.t(k, v) : k; }

	/// Mark a string so a language change repaints it. Only worth doing for a
	/// string the tables can be traced back to: an interpolated one ("Close
	/// Appearance and layout") has no key of its own and is set plainly.
	function say(node, attr, text) {
		if (window.DaimondI18n && window.DaimondI18n.mark) window.DaimondI18n.mark(node, attr, text);
		else if (attr === 'title') node.title = text;
		else node.setAttribute(attr, text);
	}

	/// The closer for one surface.
	///
	/// # Arguments
	/// * `opts.name` - What this closes, in the user's own words. It becomes the
	///   spoken name, so a reader hears which of the app's crosses this is.
	/// * `opts.onClose` - Called when it is pressed. The event is stopped first:
	///   a closer inside a popover must not also read as a click outside one.
	/// * `opts.cls` - Extra classes, for a surface with its own hooks.
	function make(opts) {
		opts = opts || {};
		var b = document.createElement('button');
		b.type = 'button';				// never submit an enclosing form
		b.className = 'ui-close' + (opts.cls ? ' ' + opts.cls : '');
		b.innerHTML = SVG;				// trusted markup, built here
		say(b, 'title', t('common.close'));
		b.setAttribute('aria-label', opts.name
			? t('common.close_named', { name: opts.name })
			: t('common.close'));
		if (typeof opts.onClose === 'function') {
			b.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				opts.onClose(e);
			});
		}
		return b;
	}

	/// A title row: what the surface is, and the way out of it, in the corner
	/// every other closer in the app holds.
	///
	/// The title is not decoration. The appearance menu was identified only by
	/// the button you had pressed to open it, which on a phone is behind the
	/// menu — so the cross had nothing on screen to say what it would close.
	///
	/// `opts.titleEl` puts an element the caller already built (a dialog's own
	/// `h2`) in the row instead of a fresh span, so a card does not end up
	/// naming itself twice. `opts.closeCls` adds a class to the cross, for the
	/// hooks a surface's own code and its verifiers reach for.
	function head(title, opts) {
		opts = opts || {};
		var row = document.createElement('div');
		row.className = 'ui-head' + (opts.cls ? ' ' + opts.cls : '');
		var t0 = opts.titleEl;
		if (!t0) {
			t0 = document.createElement('div');
			t0.className = 'ui-head-title';
			t0.textContent = title || '';
		}
		row.appendChild(t0);
		row.appendChild(make({ name: opts.name || title, onClose: opts.onClose, cls: opts.closeCls }));
		return row;
	}

	window.DaimondCloser = {
		SVG:  SVG,
		make: make,
		head: head,
	};
})();
