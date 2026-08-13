/* legal.js — the Terms and the Privacy Policy, reachable from inside the app.
 *
 * Daimond published both documents at daimond.app and then shipped an app on
 * another origin that never mentioned them. `daimond.oxedyne.com/terms.html`
 * is a 404, so the only way a user could read what they were agreeing to was
 * to know that a second website existed and go there. A consent line with
 * nowhere to point is not consent.
 *
 * A PWA TAB DRAWS ITSELF. The fix is not a link to daimond.app in a new tab:
 * it is the documents, rendered by Daimond, in Daimond's own panel. They are
 * generated into `www/guide/legal/` from the landing pages by
 * dev/legal-pages.mjs — one source of prose, two renditions, and a verifier
 * that fails if they drift — and shown through the machinery the user guide
 * already uses: `DaimondWeb.guide(sub)`, which loads a page of our own site
 * into the Web panel's frame. Nothing new was invented to show them.
 *
 * WHERE THIS IS REACHED FROM, today, in the shipped app:
 *
 *   - The About dialog, whose foot is where the small print already lives.
 *     That row is added from here rather than written into the dialog, so the
 *     module that draws About does not have to know the documents exist.
 *   - The lapse notice (js/lapse.js), whose whole subject is a term of the
 *     contract, and which says which clause it is quoting.
 *
 * And `link()` exists for the one caller that is not built yet: the beta
 * passcode's consent line. It hands back an anchor that opens the document in
 * the panel, so that line can be written without another way out of the app.
 */
(function () {
	'use strict';

	/// What the app says, falling back to English while a key has no translation.
	/// The twin of `tOr` in daimond.js: this file is a classic script and cannot
	/// reach into that closure.
	///
	/// `DaimondI18n.t` answers with the KEY when the table has no entry, which
	/// would put `legal.terms` on screen. These strings are new and no locale
	/// table has them yet, so each carries the English it means.
	function t(k, fallback) {
		var i18n = window.DaimondI18n;
		if (i18n && i18n.has && i18n.has(k)) return i18n.t(k);
		return fallback;
	}

	/// The two documents, and the page each is generated to. The path is relative
	/// to `guide/`, because that is what `DaimondWeb.guide` prefixes.
	var DOCS = {
		terms:   { sub: 'legal/terms.html',   key: 'legal.terms',   en: 'Terms of Service' },
		privacy: { sub: 'legal/privacy.html', key: 'legal.privacy', en: 'Privacy Policy' },
	};

	/// What a document is called, in the reader's language.
	function title(which) {
		var d = DOCS[which];
		return d ? t(d.key, d.en) : '';
	}

	/// Show one of the documents in the Web panel.
	///
	/// `anchor` is a section id from the page itself — `terms.html#five-years`,
	/// say — so a notice can put the reader on the clause it is talking about
	/// rather than at the top of a twelve-page document.
	///
	/// Returns true when the panel took it. The fallback opens the same file in
	/// a tab of THIS origin, which is what the header's guide button does when
	/// the web module is absent; it is still Daimond's own page.
	function open(which, anchor) {
		var d = DOCS[which];
		if (!d) return false;
		var sub = d.sub + (anchor ? '#' + String(anchor).replace(/^#/, '') : '');
		if (window.DaimondWeb && DaimondWeb.guide) {
			DaimondWeb.guide(sub);
			return true;
		}
		try { window.open('guide/' + sub, '_blank', 'noopener'); } catch (e) { /* blocked */ }
		return false;
	}

	/// An anchor that opens a document in the panel.
	///
	/// A real `href`, so it can be copied, opened in a tab by a reader who wants
	/// one, and read by a screen reader as the link it is — but an ordinary click
	/// is taken by the panel instead, which is the whole point.
	function link(which, words, anchor) {
		var d = DOCS[which];
		var a = document.createElement('a');
		a.className = 'legal-link';
		a.href = d ? ('guide/' + d.sub + (anchor ? '#' + String(anchor).replace(/^#/, '') : '')) : '#';
		a.textContent = words || title(which);
		a.addEventListener('click', function (e) {
			// A modified click is the reader asking for a tab. Let the browser
			// have it; everything else belongs in the panel.
			if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
			e.preventDefault();
			open(which, anchor);
		});
		return a;
	}

	// ── The row in About ────────────────────────────────────────────
	//
	// About is where the app already says what it is, which build it is and who
	// made it. The two documents belong in that company, and putting them there
	// costs no new surface: no menu entry, no panel, nothing on screen until
	// somebody asks what this is.
	//
	// It is added by watching for the dialog rather than by editing the module
	// that draws it, so the two stay independent — About knows nothing about the
	// legal pages, and this file knows only the class name of the foot it sits
	// above. If that class ever changes the row is simply not added, and
	// dev/verify_legalreach.mjs fails, which is the point of asserting it there.

	/// Put the row into an About dialog that has just opened.
	function decorate(card) {
		var body = card.querySelector('.about-body');
		if (!body || body.querySelector('.about-legal')) return;

		var row = document.createElement('div');
		row.className = 'about-legal';

		var links = document.createElement('div');
		links.className = 'about-legal-links';
		links.appendChild(link('terms'));
		var dot = document.createElement('span');
		dot.className = 'about-legal-sep';
		dot.textContent = '·';
		dot.setAttribute('aria-hidden', 'true');
		links.appendChild(dot);
		links.appendChild(link('privacy'));
		row.appendChild(links);

		var note = document.createElement('p');
		note.className = 'about-legal-note';
		note.textContent = t('legal.draft_note',
			'Both are drafts, published for review during the closed beta.');
		row.appendChild(note);

		// Above the maker's signature, which is the last thing in the card.
		var maker = body.querySelector('.about-maker');
		if (maker) body.insertBefore(row, maker);
		else body.appendChild(row);
	}

	/// Watch for the About dialog. Cheap: one observer on `body`'s own children,
	/// which change only when a dialog or a toast is put up.
	function watch() {
		var here = document.querySelector('.about-card');
		if (here) decorate(here);
		if (!window.MutationObserver) return;
		new MutationObserver(function (recs) {
			for (var i = 0; i < recs.length; i++) {
				var added = recs[i].addedNodes;
				for (var j = 0; j < added.length; j++) {
					var n = added[j];
					if (!n || n.nodeType !== 1) continue;
					var card = n.classList && n.classList.contains('about-card')
						? n : (n.querySelector ? n.querySelector('.about-card') : null);
					if (card) decorate(card);
				}
			}
		}).observe(document.body, { childList: true });
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', watch);
	} else {
		watch();
	}

	window.DaimondLegal = {
		open:  open,
		link:  link,
		title: title,
		/// Which documents there are, for a caller that offers both.
		docs:  function () { return Object.keys(DOCS); },
	};
})();
