/* The guide's frame: how a guide page learns how to look, and which language to
 * be in.
 *
 * One file, loaded by every page, because the alternative is the same forty
 * lines pasted into every page of every language -- and the palette table
 * inside it would then have to be right in all of them.
 *
 * The guide is framed inside Daimond's Web panel WITHOUT `allow-same-origin`,
 * deliberately, so that a page an agent wrote cannot reach the user's keys. An
 * opaque origin cannot read the app's document at all, so the look arrives over
 * postMessage -- the one channel a sandboxed frame still has. Everything sent
 * is cosmetic and is validated here on arrival, so accepting it from any framer
 * costs nothing.
 */
(function () {
	'use strict';

	/* The palettes, as [tone, ink]. Mirrored from THEMES in js/daimond.js;
	   verify_theme asserts the tables agree. The guide loads the app's own
	   variables.css, so the colours themselves are never restated -- only the
	   two facts a stylesheet needs in order to ask a question about a palette
	   it has never heard of. */
	var P = {
		light:    ['light', 'dark'],  mist:     ['light', 'dark'],
		linen:    ['light', 'dark'],  lollypop: ['mid',   'dark'],
		sage:     ['mid',   'dark'],  dusk:     ['mid',   'light'],
		dark:     ['dark',  'light'], amber:    ['dark',  'light'],
		midnight: ['dark',  'light'],
		forest:   ['dark',  'light'], plum:     ['dark',  'light'],
	};

	var root = document.documentElement;

	/// Wear a palette, by name. Unknown names are ignored rather than guessed
	/// at: a wrong palette is worse than the one already on screen.
	function wear(theme) {
		var spec = P[theme];
		if (!spec) return false;
		root.setAttribute('data-theme', theme);
		root.setAttribute('data-tone', spec[0]);
		root.setAttribute('data-ink', spec[1]);
		return true;
	}

	/// The reader's chosen text size, which travels the same path as the palette.
	function size(scale) {
		var n = parseFloat(scale);
		if (n >= 0.5 && n <= 2) root.style.setProperty('--fs-scale', String(n));
	}

	/// The language. A guide page exists once per locale under its own folder, so
	/// changing language means going to the matching page -- there is no text
	/// here to swap in place. Nothing happens when the reader is already in the
	/// right language, or when this page has no translation.
	function speak(locale) {
		if (!locale || typeof locale !== 'string') return;
		if (!/^[a-zA-Z-]{2,10}$/.test(locale)) return;          // a locale, not a path
		var here = (root.getAttribute('data-guide-locale') || 'en');
		if (locale === here) return;
		var have = (root.getAttribute('data-guide-locales') || '').split(' ');
		if (have.indexOf(locale) < 0) return;                   // not translated: stay put
		var page = location.pathname.split('/').pop() || 'index.html';
		// Every locale but English lives one level down, in its own folder.
		var to = (locale === 'en' ? (here === 'en' ? '' : '../') : (here === 'en' ? '' : '../') + locale + '/');
		location.replace(to + page + location.hash);
	}

	function paint(d) {
		if (d.theme) wear(d.theme);
		size(d.scale);
		speak(d.locale);
	}

	window.addEventListener('message', function (e) {
		var d = e && e.data;
		if (!d || d.daimondGuide !== 'style') return;
		paint(d);
	});

	// Ask the framer to tell us, if there is one.
	try {
		if (window.parent && window.parent !== window) {
			window.parent.postMessage({ daimondGuide: 'ready' }, '*');
		}
	} catch (e) { /* no framer, or one that will not listen. */ }

	// The direct path, for the case where the guide is framed WITHOUT a sandbox
	// and can simply read the app's root. Harmless wherever it is blocked.
	function fromApp(appRoot) {
		wear(appRoot.getAttribute('data-theme'));
		var s = appRoot.style.getPropertyValue('--fs-scale');
		if (s) root.style.setProperty('--fs-scale', s);
	}
	try {
		if (window.parent && window.parent !== window) {
			var appRoot = window.parent.document.documentElement;
			fromApp(appRoot);
			new MutationObserver(function () {
				try { fromApp(window.parent.document.documentElement); } catch (e) {}
			}).observe(appRoot, { attributes: true, attributeFilter: ['data-theme', 'style'] });
		}
	} catch (e) { /* cross-origin or opened directly. */ }

	// Opened on its own, with nothing to mirror: follow the operating system.
	// This runs last so an app that answered first is never overridden. The
	// palettes live in the app's stylesheet now, whose default is the dark one,
	// so without this a light-preferring reader would get a dark guide.
	if (!root.hasAttribute('data-theme')) {
		var light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
		wear(light ? 'light' : 'dark');
	}
})();
