// workspace.js — the controls that arrange Daimond: the chip row, the panel
// gallery, the appearance menu and the palette.
//
// These are one module because they are one design. The chip row is deliberately
// allowed to be incomplete -- it shows what the user pinned, not every panel
// there is -- and that is only safe because the gallery and the palette are
// complete. A surface that is the ONLY way to reach a panel must grow with the
// fleet; a surface that is merely the FASTEST way need not.
//
// The layout engine in daimond.js owns the state. This file renders it and calls
// back in; it never seats a panel itself.
(function () {
	'use strict';

	var SCALE_KEY = 'daimond-fs-scale';
	// Four steps, and no free slider. A slider invites a size nobody chose and
	// makes a layout bug impossible to reproduce; four named steps do not.
	var STEPS = [0.85, 1, 1.15, 1.3];
	var STEP_KEYS = ['size.small', 'size.normal', 'size.large', 'size.larger'];

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }
	function tn(k, n, v) { return window.DaimondI18n ? DaimondI18n.tn(k, n, v) : k; }
	function stepName(i) { return t(STEP_KEYS[i]); }

	// The dock's grids are named in the layout engine, which holds no strings.
	// The mapping from a grid's key to what it is called lives here, with the
	// rest of the text.
	var GRID_KEYS = { '1': 'dock.one_column', '2x2': 'dock.2x2', '2x3': 'dock.2x3', '3x2': 'dock.3x2' };

	var P = function () { return window.DaimondPanels; };

	// ── Reading size ────────────────────────────────────────────────────
	// Only the type responds. The frame, the padding and the panel widths stay
	// where they are, because this is a control for reading rather than a zoom:
	// a user who wants the whole interface bigger has the browser's own.

	function scale() {
		var v = parseFloat(localStorage.getItem(SCALE_KEY));
		return STEPS.indexOf(v) === -1 ? 1 : v;
	}

	function setScale(v) {
		if (STEPS.indexOf(v) === -1) return;
		document.documentElement.style.setProperty('--fs-scale', String(v));
		try { localStorage.setItem(SCALE_KEY, String(v)); } catch (e) { /* private mode */ }
		if (P()) P().reflow();
		tellFrames();
	}

	// ── Telling the framed guide how to look ────────────────────────────
	//
	// The guide is our own page, but the Web panel frames it WITHOUT
	// `allow-same-origin` -- deliberately, so that a page an agent wrote cannot
	// reach the user's keys. An opaque origin cannot read this document at all,
	// which is why the guide's older attempt to mirror the theme by reaching for
	// window.parent had silently never worked. postMessage is the one channel a
	// sandboxed frame still has, so the theme and the reading size are pushed
	// down it: on request when the guide loads, and again whenever they change.

	function styleMessage() {
		return {
			daimondGuide: 'style',
			theme: window.DaimondTheme ? DaimondTheme.get() : 'dark',
			scale: scale(),
			// The language travels the same channel. The guide cannot translate
			// itself in place -- it is static pages, one set per locale -- so what
			// it does with this is navigate to the matching page. Sending it here
			// means the guide follows the app's language the way it already
			// follows its palette, instead of being English under a German app.
			locale: window.DaimondI18n ? DaimondI18n.locale() : 'en',
		};
	}

	function tellFrames() {
		var msg = styleMessage();
		[].slice.call(document.querySelectorAll('iframe')).forEach(function (f) {
			// '*' because the frame is in an opaque origin and has no origin to
			// name. What is sent is a theme name and a number, so there is nothing
			// here worth withholding.
			try { f.contentWindow && f.contentWindow.postMessage(msg, '*'); } catch (e) {}
		});
	}

	function initScale() {
		var v = scale();
		if (v !== 1) document.documentElement.style.setProperty('--fs-scale', String(v));
	}

	// ── The chip row ────────────────────────────────────────────────────

	var tagsEl;

	function chip(p) {
		var b = document.createElement('button');
		b.className = 'ptag ptag-' + p.zone + (p.open ? ' on' : '') + (p.evicts ? ' will-evict' : '');
		b.textContent = p.label;
		b.dataset.panel = p.id;
		b.setAttribute('aria-pressed', p.open ? 'true' : 'false');
		if (p.full) {
			b.disabled = true;
			b.title = t('chip.dock_full');
		} else if (p.folded) {
			b.title = t('chip.show', { name: p.label });
		} else if (p.open) {
			b.title = t('chip.close', { name: p.label });
		} else if (p.evicts) {
			b.title = t('chip.open_instead', { name: p.label });
		} else {
			b.title = t('chip.open', { name: p.label });
		}
		b.addEventListener('click', function () { P().activate(p.id); });
		return b;
	}

	function renderTags(model) {
		tagsEl = tagsEl || document.getElementById('panel-tags');
		if (!tagsEl) return;
		tagsEl.innerHTML = '';

		var shown = model.panels.filter(function (p) { return !p.hidden && p.pinned; });
		var spare = model.panels.filter(function (p) { return !p.hidden && !p.pinned; });

		// Zones run left to right in the order they do on screen, so a chip sits
		// on the side the panel it opens will appear. That is a stronger signal
		// than colour, and it is the reason the groups are not merely sorted.
		['rail', 'stage', 'dock'].forEach(function (zone) {
			var inZone = shown.filter(function (p) { return p.zone === zone; });
			if (!inZone.length) return;
			if (tagsEl.children.length) tagsEl.appendChild(el('span', 'ptag-div'));
			var g = el('div', 'ptag-group');
			g.dataset.zone = zone;
			inZone.forEach(function (p) { g.appendChild(chip(p)); });
			tagsEl.appendChild(g);
		});

		// Whatever will not fit joins the spare, so the row shortens itself on a
		// narrow window instead of crowding the controls beside it. Only the TAIL
		// moves, and only into the menu: the order never changes, so a chip is
		// either where it was or one click away, never somewhere else.
		var squeezed = fitRow();

		var hidden = spare.length + squeezed;
		if (hidden) {
			var more = document.createElement('button');
			more.className = 'ptag ptag-more';
			more.id = 'panel-more';
			more.setAttribute('aria-haspopup', 'dialog');
			more.setAttribute('aria-expanded', 'false');
			// Set after the second fit, below, once the true count is known.
			more.innerHTML = '⋯<span class="n">' + hidden + '</span>';
			more.addEventListener('click', function (e) { e.stopPropagation(); toggleGallery(more); });
			tagsEl.appendChild(more);
			// Adding the button costs width of its own, so anything it pushed out
			// has to leave as well.
			squeezed += fitRow();
			var total = spare.length + squeezed;
			var n = more.querySelector('.n');
			if (n) n.textContent = String(total);
			more.title = tn('chip.more', total);
		}
		watchRow();
	}

	/// Drop trailing chips until the row fits the space it has been given.
	///
	/// Taken from the END, so every chip that remains is exactly where it was.
	/// A row that re-sorted itself to fit would be a row whose contents move
	/// under the cursor, which is the failure this design exists to avoid.
	/// Is the row longer than the box it has to live in?
	///
	/// Not the container's own overflow alone. The chips are flex items, so when
	/// the row runs short of room they SHRINK before they overflow: the container
	/// can report a clean fit while each chip clips its own label mid-glyph
	/// against `.panel-tags{overflow:hidden}`. A chip whose text no longer fits
	/// inside it is the honest signal, so both are asked.
	function rowOverflows() {
		if (tagsEl.scrollWidth > tagsEl.clientWidth + 1) return true;
		var chips = tagsEl.querySelectorAll('.ptag');
		for (var i = 0; i < chips.length; i++) {
			if (chips[i].scrollWidth > chips[i].clientWidth + 1) return true;
		}
		return false;
	}

	/// Re-fit when the room the row actually has changes.
	///
	/// The fit is a measurement, and a measurement taken once is taken at
	/// whatever moment the page happened to be in. On an iPad the row was
	/// measured before the header had settled, came out 21px too long, and — a
	/// fixed viewport firing no resize event ever after — stayed that way, with
	/// "Spending" sliced mid-word and no ⋯ to fold it into. So the row watches
	/// its own box, and takes the fit again when the answer would differ.
	var _fitW = -1;
	function watchRow() {
		if (!tagsEl || tagsEl._fitWatched) return;
		tagsEl._fitWatched = true;
		// Webfont metrics arrive after first paint, and every chip is text.
		if (document.fonts && document.fonts.ready) {
			document.fonts.ready
				.then(function () { try { P().reflow(); } catch (e) {} })
				.catch(function () {});
		}
		if (typeof ResizeObserver === 'undefined') return;
		// Only a CHANGE of available width re-fits: re-fitting rewrites the row's
		// children, not its box, so this cannot chase its own tail.
		new ResizeObserver(function () {
			if (!tagsEl.clientWidth || tagsEl.clientWidth === _fitW) return;
			_fitW = tagsEl.clientWidth;
			try { P().reflow(); } catch (e) {}
		}).observe(tagsEl);
	}

	function fitRow() {
		var gone = 0, guard = 0;
		while (rowOverflows() && guard++ < 60) {
			var groups = tagsEl.querySelectorAll('.ptag-group');
			var g = null;
			for (var i = groups.length - 1; i >= 0; i--) {
				if (groups[i].children.length) { g = groups[i]; break; }
			}
			if (!g) break;
			g.removeChild(g.lastElementChild);
			gone++;
			// A group emptied by the squeeze takes its divider with it.
			if (!g.children.length) {
				var prev = g.previousElementSibling;
				g.parentNode.removeChild(g);
				if (prev && prev.className === 'ptag-div') prev.parentNode.removeChild(prev);
			}
		}
		return gone;
	}

	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	// ── The gallery: every panel there is, searchable ────────────────────

	var galEl, galQuery = '';

	function renderGallery() {
		galEl = galEl || document.getElementById('panel-gallery');
		if (!galEl) return;
		var model = P().model();
		galEl.innerHTML = '';

		var input = document.createElement('input');
		input.className = 'gal-search';
		input.type = 'search';
		input.placeholder = t('gallery.search_ph');
		input.setAttribute('aria-label', t('gallery.search_ph'));
		input.value = galQuery;
		input.addEventListener('input', function () { galQuery = input.value; renderGallery(); focusSearch(); });
		galEl.appendChild(input);

		var q = galQuery.trim().toLowerCase();
		var hits = model.panels.filter(function (p) {
			return !q || p.label.toLowerCase().indexOf(q) !== -1;
		});

		if (!hits.length) {
			galEl.appendChild(el('div', 'gal-empty', t('gallery.no_match')));
			return;
		}

		['rail', 'stage', 'dock'].forEach(function (zone) {
			var inZone = hits.filter(function (p) { return p.zone === zone; });
			if (!inZone.length) return;
			galEl.appendChild(el('div', 'pop-head', t('gallery.zone_' + zone)));
			inZone.forEach(function (p) { galEl.appendChild(galleryRow(p)); });
		});

		var note = el('div', 'pop-note');
		note.innerHTML = t('gallery.note');
		galEl.appendChild(note);
	}

	function galleryRow(p) {
		var row = el('div');
		row.style.display = 'flex';
		row.style.alignItems = 'center';

		var go = document.createElement('button');
		go.className = 'gal-row' + (p.open ? ' is-open' : '');
		go.appendChild(el('span', 'nm', p.label));
		var onRow = !!document.querySelector('#panel-tags .ptag[data-panel="' + p.id + '"]');
		go.appendChild(el('span', 'state',
			p.unrevealed ? t('gallery.state_unrevealed')
			: p.full && !p.open ? t('gallery.state_full')
			: p.open ? t('gallery.state_open')
			: (p.pinned && !onRow) ? t('gallery.state_no_room') : ''));
		go.disabled = !!(p.full && !p.open);
		go.addEventListener('click', function () { P().activate(p.id); closeGallery(); });

		// The pin decides the chip row's contents. It is a deliberate choice
		// rather than a frequency ranking: a row that reorders itself destroys the
		// muscle memory that stable positions exist to build.
		var pin = document.createElement('button');
		pin.className = 'gal-pin';
		pin.setAttribute('aria-pressed', p.pinned ? 'true' : 'false');
		pin.title = p.pinned ? t('gallery.unpin', { name: p.label }) : t('gallery.pin', { name: p.label });
		pin.setAttribute('aria-label', pin.title);
		pin.innerHTML = p.pinned
			? '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.2 5.6L20 9.2l-4.2 3.6 1.3 5.7L12 15.6 6.9 18.5l1.3-5.7L4 9.2l5.8-.6z" fill="currentColor" stroke="none"/></svg>'
			: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.2 5.6L20 9.2l-4.2 3.6 1.3 5.7L12 15.6 6.9 18.5l1.3-5.7L4 9.2l5.8-.6z"/></svg>';
		pin.addEventListener('click', function (e) {
			e.stopPropagation();
			P().setPinned(p.id, !p.pinned);
			renderGallery();
		});

		row.appendChild(go);
		row.appendChild(pin);
		return row;
	}

	function focusSearch() {
		var i = galEl && galEl.querySelector('.gal-search');
		if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
	}

	function toggleGallery(anchor) {
		galEl = galEl || document.getElementById('panel-gallery');
		if (!galEl.hidden) { closeGallery(); return; }
		galQuery = '';
		renderGallery();
		openPop(galEl, anchor);
		var more = document.getElementById('panel-more');
		if (more) more.setAttribute('aria-expanded', 'true');
		focusSearch();
	}

	function closeGallery() {
		if (!galEl || galEl.hidden) return;
		galEl.hidden = true;
		var more = document.getElementById('panel-more');
		if (more) { more.setAttribute('aria-expanded', 'false'); more.focus(); }
	}

	// ── The appearance menu ─────────────────────────────────────────────

	var menuEl;

	/// The word each stored spacing id is shown as. The ids are `sharp` and
	/// `warm` in storage and will stay that way; this is the only place the two
	/// vocabularies meet.
	var SPACING_WORD = { sharp: 'compact', warm: 'breathe' };

	function renderMenu() {
		menuEl = menuEl || document.getElementById('settings-menu');
		if (!menuEl) return;
		menuEl.innerHTML = '';
		var model = P().model();

		// Spacing -- the overall shape (corners, typeface, room between things),
		// orthogonal to the palette chosen below. The two settings are stored
		// under their original ids, because a rename that moved them would clear
		// the choice of everyone already using one; only the words changed.
		if (window.DaimondSkin) {
			menuEl.appendChild(el('div', 'pop-head', t('menu.spacing')));
			var skinNow = DaimondSkin.get();
			var sseg = el('div', 'seg');
			['sharp', 'warm'].forEach(function (id) {
				var pair = [id];
				var word = SPACING_WORD[id];
				var sb = el('button', null, t('menu.spacing_' + word));
				sb.setAttribute('aria-pressed', pair[0] === skinNow ? 'true' : 'false');
				sb.title = t('menu.spacing_' + word + '_help');
				sb.addEventListener('click', function () {
					// Only the spacing. Choosing "Breathe" used to also move a dark
					// palette to light, on the reading that the warm skin WAS a light
					// airy look -- but the two axes are orthogonal, and the row now
					// says so in its own name. Reaching for more room and being given
					// a different palette is a setting changing a setting nobody
					// touched, and with a list of palettes to choose from it would
					// throw away a considered choice.
					DaimondSkin.set(pair[0]);
					renderMenu();
				});
				sseg.appendChild(sb);
			});
			menuEl.appendChild(sseg);
		}

		// Theme. A pulldown rather than a row of buttons: ten palettes in three
		// bands is a list to look down, and a segmented control of ten would eat
		// the menu and still not say which of them are light. The bands are the
		// optgroups, so "a light one" is one glance rather than ten guesses.
		menuEl.appendChild(el('div', 'pop-head', t('menu.theme')));
		var now = window.DaimondTheme ? DaimondTheme.get() : 'dark';
		var sel = el('select', 'theme-pick');
		sel.setAttribute('aria-label', t('menu.theme'));
		(window.DaimondTheme ? DaimondTheme.tones() : ['dark']).forEach(function (tone) {
			var grp = document.createElement('optgroup');
			grp.label = t('menu.tone_' + tone);
			DaimondTheme.inTone(tone).forEach(function (name) {
				var o = el('option', null, t('menu.theme_' + name));
				o.value = name;
				// A palette that exists for a REASON says so on hover. Most are a
				// matter of taste and need no note; Amber is not, and a reader
				// scanning ten names would have no way to tell which is which.
				var help = 'menu.theme_' + name + '_help';
				if (t(help) !== help) o.title = t(help);
				if (name === now) o.selected = true;
				grp.appendChild(o);
			});
			sel.appendChild(grp);
		});
		sel.addEventListener('change', function () {
			DaimondTheme.set(sel.value);
			renderMenu();
		});
		menuEl.appendChild(sel);

		// Reading size. The sample is set in the size being chosen, so the control
		// shows the change rather than naming it.
		menuEl.appendChild(el('div', 'pop-head', t('menu.text_size')));
		var cur = STEPS.indexOf(scale());
		var row = el('div', 'size-row');
		var down = el('button', null, 'A');
		down.style.fontSize = 'var(--fs-xs)';
		down.title = t('menu.smaller');
		down.setAttribute('aria-label', down.title);
		down.disabled = cur <= 0;
		down.addEventListener('click', function () { setScale(STEPS[cur - 1]); renderMenu(); });

		var sample = el('div', 'sample', stepName(cur));
		sample.setAttribute('aria-live', 'polite');

		var up = el('button', null, 'A');
		up.style.fontSize = 'var(--fs-2xl)';
		up.title = t('menu.larger');
		up.setAttribute('aria-label', up.title);
		up.disabled = cur >= STEPS.length - 1;
		up.addEventListener('click', function () { setScale(STEPS[cur + 1]); renderMenu(); });

		row.appendChild(down);
		row.appendChild(sample);
		row.appendChild(up);
		row.appendChild(el('span', 'pct', Math.round(STEPS[cur] * 100) + '%'));
		menuEl.appendChild(row);

		// The dock's tiling.
		menuEl.appendChild(el('div', 'pop-head', t('menu.dock_tiling')));
		var grids = P().grids();
		var gseg = el('div', 'seg');
		// Enumerated from the engine, not from a copy kept here: the palette
		// already does this, and two lists of the same thing is one list too many.
		var order = ['auto'].concat(Object.keys(grids).filter(function (k) { return k !== 'auto'; }));
		order.forEach(function (key) {
			var g = grids[key] || { cols: model.cols, rows: model.rows };
			var label = key === 'auto' ? t('menu.dock_auto') : key.replace('x', '×');
			var b = el('button', 'grid-opt');
			b.setAttribute('aria-pressed', P().grid() === key ? 'true' : 'false');
			b.title = key === 'auto'
				? t('menu.dock_auto_help')
				: tn('menu.dock_grid_help', g.cols, { cols: g.cols, cells: g.cols * g.rows });
			var cells = el('div', 'cells');
			var cols = (key === 'auto') ? 2 : g.cols;
			var rows = (key === 'auto') ? 2 : g.rows;
			cells.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
			for (var i = 0; i < cols * rows; i++) {
				// The second column of `auto` is drawn as an outline: it appears only
				// when the window is wide enough, and a solid cell would promise a
				// column that may not be there.
				cells.appendChild(el('i', (key === 'auto' && i % 2 === 1) ? 'maybe' : null));
			}
			b.appendChild(cells);
			b.appendChild(el('span', 'cap', label));
			b.addEventListener('click', function () { P().setGrid(key); renderMenu(); });
			gseg.appendChild(b);
		});
		menuEl.appendChild(gseg);

		// This Diamond's arrangement, when there is a Diamond to hang it on.
		var diamond = window.DaimondDiamond && DaimondDiamond.current && DaimondDiamond.current();
		if (diamond && diamond.id) {
			menuEl.appendChild(el('div', 'pop-head', t('menu.this_diamond')));
			var saved = P().hasArrangement(diamond.id);
			var save = el('button', 'gal-row');
			save.appendChild(el('span', 'nm', saved ? t('menu.arrangement_update')
				: (diamond.name ? t('menu.arrangement_keep', { name: diamond.name })
					: t('menu.arrangement_keep_this'))));
			save.addEventListener('click', function () {
				P().saveArrangement(diamond.id);
				renderMenu();
			});
			menuEl.appendChild(save);
			if (saved) {
				var drop = el('button', 'gal-row');
				drop.appendChild(el('span', 'nm', t('menu.arrangement_forget')));
				drop.addEventListener('click', function () { P().forgetArrangement(diamond.id); renderMenu(); });
				menuEl.appendChild(drop);
			}
			var n = el('div', 'pop-note');
			n.textContent = t('menu.arrangement_note');
			menuEl.appendChild(n);
		}

		renderLanguage(menuEl);
	}

	// ── Language and currency ───────────────────────────────────────────
	//
	// Two more ways the app can be made to fit the person using it, so they sit
	// with the theme and the text size rather than in a settings form of their
	// own. Currency is DISPLAY only: the note under it says so, because a price
	// shown in euros that is charged in dollars is a surprise nobody should get
	// at the card statement.

	var localesReady = null;   // the codes that actually have a table, once probed

	/// Find out which locale files exist, by trying to load them. Once only,
	/// and the picker is redrawn with the answer.
	function probeLocales() {
		if (localesReady !== null || !window.DaimondI18n) return;
		localesReady = [];
		DaimondI18n.available().then(function (codes) {
			localesReady = codes;
			if (menuEl && !menuEl.hidden) renderMenu();
		});
	}

	function renderLanguage(box) {
		if (!window.DaimondI18n) return;

		box.appendChild(el('div', 'pop-head', t('menu.language')));
		// A full-width select and a note under it, which is how everything else
		// in this menu explains itself. A label beside the control would leave
		// each of them too narrow to read.
		var lrow = el('div', 'set-pick');
		var lsel = document.createElement('select');
		lsel.className = 'settings-select';
		lsel.setAttribute('aria-label', t('menu.language'));
		DaimondI18n.locales().forEach(function (l) {
			var o = document.createElement('option');
			o.value = l.code;
			o.textContent = l.name;
			// Until the probe has answered, only the table already in hand is
			// known to exist. A language with no file is offered but not
			// selectable, so the picker shows what is coming without pretending
			// it has arrived.
			if (localesReady && localesReady.indexOf(l.code) === -1) {
				o.disabled = true;
				o.textContent = l.name + ' — ' + t('menu.language_pending');
			}
			if (l.code === DaimondI18n.locale()) o.selected = true;
			lsel.appendChild(o);
		});
		// A language with no file falls back to English, and the picker is drawn
		// again so it shows what actually happened rather than what was asked.
		lsel.addEventListener('change', function () {
			var want = lsel.value;
			DaimondI18n.setLocale(want).then(function (ok) {
				if (!ok && localesReady && localesReady.indexOf(want) === -1) probeLocales();
				if (menuEl && !menuEl.hidden) renderMenu();
			});
		});
		// Probed once per page, and only when someone reaches for the picker: the
		// probe is a load of each file, so what is offered is what is on disk
		// rather than what a list here claims -- but merely opening the
		// appearance menu should not fetch eight files to find out.
		lsel.addEventListener('focus', probeLocales);
		lsel.addEventListener('pointerdown', probeLocales);
		lrow.appendChild(lsel);
		box.appendChild(lrow);
		box.appendChild(el('div', 'pop-note', t('menu.language_help')));

		box.appendChild(el('div', 'pop-head', t('menu.currency')));
		var crow = el('div', 'set-pick');
		var csel = document.createElement('select');
		csel.className = 'settings-select';
		csel.setAttribute('aria-label', t('menu.currency'));
		DaimondI18n.currencies().forEach(function (c) {
			var o = document.createElement('option');
			o.value = c.code;
			o.textContent = c.code + ' — ' + c.name;
			if (c.code === DaimondI18n.currency()) o.selected = true;
			csel.appendChild(o);
		});
		csel.addEventListener('change', function () { DaimondI18n.setCurrency(csel.value); renderMenu(); });
		crow.appendChild(csel);
		box.appendChild(crow);

		var cn = el('div', 'pop-note');
		cn.textContent = DaimondI18n.currency() === 'USD'
			? t('menu.currency_help')
			: t('menu.currency_help') + ' ' + t('billing.usd_note')
				+ ' ' + t('billing.rates_as_of', { date: DaimondI18n.ratesAsOf() });
		box.appendChild(cn);
	}

	function toggleMenu(anchor) {
		menuEl = menuEl || document.getElementById('settings-menu');
		if (!menuEl.hidden) { closeMenu(); return; }
		renderMenu();
		openPop(menuEl, anchor);
		anchor.setAttribute('aria-expanded', 'true');
		var first = menuEl.querySelector('button');
		if (first) first.focus();
	}

	function closeMenu() {
		if (!menuEl || menuEl.hidden) return;
		menuEl.hidden = true;
		var b = document.getElementById('settings-menu-btn');
		if (b) { b.setAttribute('aria-expanded', 'false'); b.focus(); }
	}

	/// Place a popover under the control that opened it, kept inside the window.
	function openPop(pop, anchor) {
		pop.hidden = false;
		var r = anchor.getBoundingClientRect();
		var w = pop.offsetWidth;
		var left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
		pop.style.left = left + 'px';
		pop.style.top = (r.bottom + 6) + 'px';
	}

	// ── The palette ─────────────────────────────────────────────────────
	// Invisible, and therefore never the primary surface -- but complete, which
	// is what allows the visible surfaces to be selective.

	var palEl, palInput, palList, palItems = [], palAt = 0;

	function commands() {
		var out = [];
		P().model().panels.forEach(function (p) {
			out.push({
				kind: t('pal.kind_panel'), name: p.label,
				hint: p.open ? t('pal.hint_open') : (p.full ? t('pal.hint_full') : ''),
				run: function () { (P().goTo || P().activate)(p.id); },
				off: !!(p.full && !p.open),
			});
		});
		(window.DaimondTheme ? DaimondTheme.list() : []).forEach(function (name) {
			out.push({
				kind: t('pal.kind_theme'), name: t('menu.theme_' + name),
				hint: DaimondTheme.get() === name ? t('pal.hint_current') : '',
				run: function () { DaimondTheme.set(name); },
			});
		});
		STEPS.forEach(function (v, i) {
			out.push({
				kind: t('pal.kind_size'), name: stepName(i),
				hint: Math.round(v * 100) + '%',
				run: function () { setScale(v); },
			});
		});
		var grids = P().grids();
		Object.keys(grids).forEach(function (k) {
			// `auto` is held as null in the engine, because its shape is decided by
			// the window rather than fixed; it is offered below on its own terms.
			if (!grids[k]) return;
			out.push({
				kind: t('pal.kind_dock'), name: t(GRID_KEYS[k] || 'dock.automatic'),
				hint: P().grid() === k ? t('pal.hint_current') : '',
				run: function () { P().setGrid(k); },
			});
		});
		out.push({ kind: t('pal.kind_dock'), name: t('dock.automatic'), hint: P().grid() === 'auto' ? t('pal.hint_current') : '',
			run: function () { P().setGrid('auto'); } });
		// Every language and every currency, reachable without opening a menu --
		// which is what makes the appearance menu free to stay short.
		if (window.DaimondI18n) {
			DaimondI18n.locales().forEach(function (l) {
				out.push({
					kind: t('pal.kind_lang'), name: l.name,
					hint: DaimondI18n.locale() === l.code ? t('pal.hint_current') : '',
					run: function () { DaimondI18n.setLocale(l.code); },
				});
			});
			DaimondI18n.currencies().forEach(function (c) {
				out.push({
					kind: t('pal.kind_ccy'), name: c.code + ' — ' + c.name,
					hint: DaimondI18n.currency() === c.code ? t('pal.hint_current') : '',
					run: function () { DaimondI18n.setCurrency(c.code); },
				});
			});
		}
		// The permission ladder, reachable from Ctrl-K. A mode switch is exactly
		// what a palette is for: it is a thing you change while working, from
		// wherever the keyboard already is.
		if (window.DaimondHandMode) {
			DaimondHandMode.list().forEach(function (m) {
				out.push({
					kind: t('pal.kind_permmode'), name: m.label,
					hint: DaimondHandMode.get() === m.name ? t('pal.hint_current') : '',
					run:  function () { DaimondHandMode.set(m.name); },
				});
			});
		}
		return out;
	}

	function renderPalette() {
		var q = palInput.value.trim().toLowerCase();
		palItems = commands().filter(function (c) {
			return !q || (c.name + ' ' + c.kind).toLowerCase().indexOf(q) !== -1;
		});
		if (palAt >= palItems.length) palAt = 0;
		palList.innerHTML = '';
		if (!palItems.length) {
			var e = el('li', 'pal-empty', t('pal.nothing'));
			palList.appendChild(e);
			return;
		}
		palItems.forEach(function (c, i) {
			var li = el('li', 'pal-item');
			li.id = 'pal-i' + i;
			li.setAttribute('role', 'option');
			li.setAttribute('aria-selected', i === palAt ? 'true' : 'false');
			li.appendChild(el('span', 'kind', c.kind));
			li.appendChild(el('span', 'nm', c.name));
			if (c.hint) li.appendChild(el('span', 'hint', c.hint));
			li.addEventListener('mousemove', function () { if (palAt !== i) { palAt = i; renderPalette(); } });
			li.addEventListener('click', function () { runAt(i); });
			palList.appendChild(li);
		});
		palInput.setAttribute('aria-activedescendant', 'pal-i' + palAt);
		var sel = palList.children[palAt];
		if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
	}

	function runAt(i) {
		var c = palItems[i];
		if (!c || c.off) return;
		closePalette();
		c.run();
	}

	/// What had the focus when the palette took it, so it can be given back.
	var palPrev = null;

	function openPalette() {
		palEl = palEl || document.getElementById('palette');
		if (!palEl || !palEl.hidden) return;
		closeMenu(); closeGallery();
		palPrev = document.activeElement;
		palInput = document.getElementById('pal-input');
		palList = document.getElementById('pal-list');
		palInput.value = '';
		palAt = 0;
		palEl.hidden = false;
		renderPalette();
		palInput.focus();
	}

	/// Close, and put the focus back where it was.
	///
	/// Hiding the scrim and stopping left the focus on `<body>`, so the next Tab
	/// restarted at the top of the app -- for a keyboard user, the whole rail and
	/// topbar again, every time the palette was opened and dismissed. `closeMenu`
	/// and `closeGallery` both already do this; this is the third of three.
	///
	/// `runAt` closes BEFORE running the command, so a command that deliberately
	/// moves the focus somewhere else has to win. Restoring here and letting the
	/// command move it afterwards is that order.
	function closePalette() {
		if (!palEl || palEl.hidden) return;
		palEl.hidden = true;
		if (palPrev && palPrev.focus && document.contains(palPrev)) {
			try { palPrev.focus(); } catch (e) { /* gone from the page */ }
		}
		palPrev = null;
	}

	// ── Wiring ──────────────────────────────────────────────────────────

	function init() {
		initScale();

		// A guide page announces itself when it loads, because it cannot be seen
		// from here until it does.
		window.addEventListener('message', function (e) {
			var d = e && e.data;
			if (!d || d.daimondGuide !== 'ready') return;
			try { e.source.postMessage(styleMessage(), '*'); } catch (err) {}
		});

		// Setting the theme must reach the frames too, and the theme is owned by
		// daimond.js -- so the service is wrapped rather than duplicated.
		if (window.DaimondTheme && !DaimondTheme._wrapped) {
			var inner = DaimondTheme.set;
			DaimondTheme.set = function (name) { inner(name); tellFrames(); };
			DaimondTheme._wrapped = true;
		}

		var menuBtn = document.getElementById('settings-menu-btn');
		if (menuBtn) menuBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(menuBtn); });

		// A language or currency change repaints what this file draws. The chip
		// row and the gallery are redrawn from the model, which is re-read from
		// the DOM first, because a panel's name is an attribute on it.
		if (window.DaimondI18n) {
			DaimondI18n.onChange(function () {
				if (P() && P().relabel) P().relabel();
				else if (P()) P().reflow();
				if (galEl && !galEl.hidden) renderGallery();
				if (menuEl && !menuEl.hidden) renderMenu();
				// And the framed guide, which carries the language the same way it
				// carries the palette. Without this line the guide stays in the
				// language it was opened in -- the whole point of sending a locale.
				tellFrames();
			});
		}

		palEl = document.getElementById('palette');
		palInput = document.getElementById('pal-input');
		palList = document.getElementById('pal-list');

		if (palInput) {
			palInput.addEventListener('input', function () { palAt = 0; renderPalette(); });
			palInput.addEventListener('keydown', function (e) {
				if (e.key === 'ArrowDown') { e.preventDefault(); palAt = Math.min(palAt + 1, palItems.length - 1); renderPalette(); }
				else if (e.key === 'ArrowUp') { e.preventDefault(); palAt = Math.max(palAt - 1, 0); renderPalette(); }
				else if (e.key === 'Enter') { e.preventDefault(); runAt(palAt); }
				else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
				// The palette is one box and a list walked with the arrows, and it
				// covers the app. Tab had nowhere to go inside it, so it went behind
				// it instead -- leaving the caret on a rail button under the scrim,
				// with the palette still up and no longer taking what was typed.
				else if (e.key === 'Tab') { e.preventDefault(); }
			});
		}
		if (palEl) palEl.addEventListener('mousedown', function (e) { if (e.target === palEl) closePalette(); });

		document.addEventListener('keydown', function (e) {
			// Ctrl/Cmd-K is the convention users arrive already knowing, and it is
			// not a browser binding on any platform we serve.
			if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
				// Ctrl-K is kill-to-end-of-line in a text field on macOS, so it is
				// left alone there; Cmd-K still opens the palette on that platform.
				var tgt = e.target;
				var typing = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable);
				if (typing && e.ctrlKey && !e.metaKey) return;
				e.preventDefault();
				palEl && palEl.hidden ? openPalette() : closePalette();
				return;
			}
			if (e.key === 'Escape') { closeMenu(); closeGallery(); closePalette(); }
			// Both popovers say `role="dialog"` and cover the app, and Tab used to
			// walk straight out of them into the page behind -- with the popover
			// still up, still covering whatever now had the focus. A dialog that
			// lets the keyboard out from under itself is a dialog in name only, so
			// the promise the markup makes is kept here. The trap is the one the
			// real dialogs use, borrowed rather than copied.
			if (e.key === 'Tab' && window.DaimondCore && DaimondCore.keepFocusIn) {
				var open = (menuEl && !menuEl.hidden) ? menuEl
					: (galEl && !galEl.hidden) ? galEl : null;
				if (open) DaimondCore.keepFocusIn(open, e);
			}
		});

		// A click anywhere else closes a popover, which is what a user expects of
		// one and what stops two being open at once.
		//
		// "Anywhere else" has to be decided from the event's PATH, not from where
		// its target sits now. Every control in the appearance menu re-renders the
		// menu, which throws the clicked button away; by the time this bubbles,
		// `menuEl.contains(e.target)` asks whether a detached node is a descendant
		// and is told no. So the menu closed itself the moment you used it -- one
		// step of text size per opening, and no way to watch the page change under
		// the control that was changing it. The path is computed at dispatch,
		// before any re-render, so it still knows where the click began.
		function beganIn(pop, e) {
			var path = e.composedPath ? e.composedPath() : null;
			return path ? path.indexOf(pop) >= 0 : pop.contains(e.target);
		}
		document.addEventListener('click', function (e) {
			if (menuEl && !menuEl.hidden && !beganIn(menuEl, e)) closeMenu();
			if (galEl && !galEl.hidden && !beganIn(galEl, e)) closeGallery();
		});

		window.addEventListener('resize', function () { closeMenu(); closeGallery(); });
	}

	window.DaimondWorkspace = {
		init: init,
		renderTags: renderTags,
		openPalette: openPalette,
		scale: scale,
		setScale: setScale,
		steps: function () { return STEPS.slice(); },
	};

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
	else init();
})();
