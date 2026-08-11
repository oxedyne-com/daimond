/* The guide's frame: how a guide page learns how to look, which language to be
 * in, and where a jump to a heading lands.
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

	/* ── Where a jump lands ──────────────────────────────────────────────────
	   The header is sticky at the top of the page, so scrolling a heading to
	   the very top of the scrollport puts it UNDER the header: a reader who
	   picks a search result, or follows a deep link into the guide, arrives at
	   a heading they cannot see.

	   `scroll-margin-top` on the target fixes all of those at once, because in
	   every one of them it is the browser doing the scrolling -- a click on a
	   search result, the browser's own fragment navigation, and any later
	   `scrollIntoView`. Nothing has to know about the header except this.

	   The height is measured rather than written down. The header wraps: nine
	   nav links and a search box take one row on a wide screen and four on a
	   narrow one, the German labels wrap where the English ones do not, and the
	   reader can change the text size at any moment over the channel above. No
	   single number is right for all of that. The rule is installed from here
	   rather than kept in guide.css because the value in it can only come from
	   JavaScript, and a rule split across two files is one that gets half
	   changed. */

	// Clear air between the header's lower edge and the heading it uncovers.
	var GAP = 12;

	/// The height last published, so a size that has not moved writes nothing.
	var lastH = -1;

	/// Publish the header's height, for the rule below to keep clear of.
	///
	/// `h` is the height the caller ALREADY HAS -- the observer in `settle` is
	/// handed one with every notification, and passes it. Measuring here instead,
	/// from inside that callback, forces a layout while the notifications are
	/// still being delivered: any size change that was pending lands mid-delivery,
	/// the header therefore counts as having resized again after its own turn, and
	/// Safari reports "ResizeObserver loop completed with undelivered
	/// notifications" -- which Chromium swallows, so it only ever showed on
	/// WebKit. It also meant measuring and laying the page out twice in one frame,
	/// on a phone, for a number the observer was already carrying. Only the first
	/// call, made before anything observes, measures.
	function headroom(h) {
		if (h === undefined) {
			var head = document.querySelector('.site-head');
			if (!head) return;
			h = head.getBoundingClientRect().height;
		}
		h = Math.round(h);
		if (h <= 0 || h === lastH) return;
		lastH = h;
		root.style.setProperty('--guide-head-h', (h + GAP) + 'px');
	}

	/// The browser jumps to a fragment while the page is still parsing, long
	/// before the header exists to be measured, so a deep link lands using the
	/// fallback in the rule. Once the real height is known, put the reader
	/// where they asked to be. Only on arrival: a `hashchange` after this
	/// scrolls with the measured value already in hand.
	function reland() {
		var id = (location.hash || '').slice(1);
		if (!id) return;
		var el = document.getElementById(id);
		if (el && el.scrollIntoView) el.scrollIntoView();
	}

	// Installed now, while the page is still in its head, so the rule is already
	// in force for the browser's own jump to a fragment. 7rem is two wrapped
	// header rows plus its padding: what a jump uses until the measurement
	// lands, and what it keeps using on a page with no header at all.
	var rule = document.createElement('style');
	rule.textContent = 'main [id] { scroll-margin-top: var(--guide-head-h, 7rem); }';
	document.head.appendChild(rule);

	function settle() {
		headroom();
		reland();

		var head = document.querySelector('.site-head');
		if (head && window.ResizeObserver) {
			new ResizeObserver(function (entries) {
				var e = entries[entries.length - 1];
				// The BORDER box, which is what the measurement above returns;
				// `contentRect` is the content box and would lose the header's
				// padding. An engine without `borderBoxSize` gets the measurement.
				var b = e.borderBoxSize && e.borderBoxSize[0];
				headroom(b ? b.blockSize : undefined);
			}).observe(head);
		} else {
			// The listener is handed an Event, which is not a height.
			window.addEventListener('resize', function () { headroom(); });
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', settle);
	} else {
		settle();
	}
})();
