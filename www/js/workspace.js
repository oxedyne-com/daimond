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
	var STEP_NAMES = ['Small', 'Normal', 'Large', 'Larger'];

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
	var overflowed = 0;     // chips the width squeezed off the row this render

	function chip(p) {
		var b = document.createElement('button');
		b.className = 'ptag ptag-' + p.zone + (p.open ? ' on' : '') + (p.evicts ? ' will-evict' : '');
		b.textContent = p.label;
		b.dataset.panel = p.id;
		b.setAttribute('aria-pressed', p.open ? 'true' : 'false');
		if (p.full) {
			b.disabled = true;
			b.title = 'The dock is full — choose a larger tiling in the appearance menu, or close a panel.';
		} else if (p.folded) {
			b.title = 'Show ' + p.label;
		} else if (p.open) {
			b.title = 'Close ' + p.label;
		} else if (p.evicts) {
			b.title = 'Open ' + p.label + ', in place of the panel beside the chat';
		} else {
			b.title = 'Open ' + p.label;
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
			more.title = hidden + ' more panel' + (hidden === 1 ? '' : 's');
			more.innerHTML = '⋯<span class="n">' + hidden + '</span>';
			more.addEventListener('click', function (e) { e.stopPropagation(); toggleGallery(more); });
			tagsEl.appendChild(more);
			// Adding the button costs width of its own, so anything it pushed out
			// has to leave as well.
			squeezed += fitRow(more);
			var n = more.querySelector('.n');
			if (n) n.textContent = String(spare.length + squeezed);
		}
		overflowed = squeezed;
	}

	/// Drop trailing chips until the row fits the space it has been given.
	///
	/// Taken from the END, so every chip that remains is exactly where it was.
	/// A row that re-sorted itself to fit would be a row whose contents move
	/// under the cursor, which is the failure this design exists to avoid.
	function fitRow(keep) {
		var gone = 0, guard = 0;
		while (tagsEl.scrollWidth > tagsEl.clientWidth + 1 && guard++ < 60) {
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
		input.placeholder = 'Search panels';
		input.setAttribute('aria-label', 'Search panels');
		input.value = galQuery;
		input.addEventListener('input', function () { galQuery = input.value; renderGallery(); focusSearch(); });
		galEl.appendChild(input);

		var q = galQuery.trim().toLowerCase();
		var hits = model.panels.filter(function (p) {
			return !q || p.label.toLowerCase().indexOf(q) !== -1;
		});

		if (!hits.length) {
			galEl.appendChild(el('div', 'gal-empty', 'No panel by that name.'));
			return;
		}

		var ZONES = { rail: 'The rail', stage: 'Beside the chat', dock: 'The dock' };
		['rail', 'stage', 'dock'].forEach(function (zone) {
			var inZone = hits.filter(function (p) { return p.zone === zone; });
			if (!inZone.length) return;
			galEl.appendChild(el('div', 'pop-head', ZONES[zone]));
			inZone.forEach(function (p) { galEl.appendChild(galleryRow(p)); });
		});

		var note = el('div', 'pop-note');
		note.innerHTML = 'Pinned panels sit in the top bar. Press <kbd>Ctrl</kbd> <kbd>K</kbd> to reach any panel from the keyboard.';
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
			p.unrevealed ? 'not in use yet'
			: p.full && !p.open ? 'dock full'
			: p.open ? 'open'
			: (p.pinned && !onRow) ? 'no room in the bar' : ''));
		go.disabled = !!(p.full && !p.open);
		go.addEventListener('click', function () { P().activate(p.id); closeGallery(); });

		// The pin decides the chip row's contents. It is a deliberate choice
		// rather than a frequency ranking: a row that reorders itself destroys the
		// muscle memory that stable positions exist to build.
		var pin = document.createElement('button');
		pin.className = 'gal-pin';
		pin.setAttribute('aria-pressed', p.pinned ? 'true' : 'false');
		pin.title = p.pinned ? 'Remove ' + p.label + ' from the top bar' : 'Keep ' + p.label + ' in the top bar';
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

	function renderMenu() {
		menuEl = menuEl || document.getElementById('settings-menu');
		if (!menuEl) return;
		menuEl.innerHTML = '';
		var model = P().model();

		// Theme.
		menuEl.appendChild(el('div', 'pop-head', 'Theme'));
		var themes = window.DaimondTheme ? DaimondTheme.list() : ['dark'];
		var now = window.DaimondTheme ? DaimondTheme.get() : 'dark';
		var seg = el('div', 'seg');
		themes.forEach(function (t) {
			var b = el('button', null, t.charAt(0).toUpperCase() + t.slice(1));
			b.setAttribute('aria-pressed', t === now ? 'true' : 'false');
			b.addEventListener('click', function () { DaimondTheme.set(t); renderMenu(); });
			seg.appendChild(b);
		});
		menuEl.appendChild(seg);

		// Reading size. The sample is set in the size being chosen, so the control
		// shows the change rather than naming it.
		menuEl.appendChild(el('div', 'pop-head', 'Text size'));
		var cur = STEPS.indexOf(scale());
		var row = el('div', 'size-row');
		var down = el('button', null, 'A');
		down.style.fontSize = 'var(--fs-xs)';
		down.title = 'Smaller text';
		down.setAttribute('aria-label', 'Smaller text');
		down.disabled = cur <= 0;
		down.addEventListener('click', function () { setScale(STEPS[cur - 1]); renderMenu(); });

		var sample = el('div', 'sample', STEP_NAMES[cur]);
		sample.setAttribute('aria-live', 'polite');

		var up = el('button', null, 'A');
		up.style.fontSize = 'var(--fs-2xl)';
		up.title = 'Larger text';
		up.setAttribute('aria-label', 'Larger text');
		up.disabled = cur >= STEPS.length - 1;
		up.addEventListener('click', function () { setScale(STEPS[cur + 1]); renderMenu(); });

		row.appendChild(down);
		row.appendChild(sample);
		row.appendChild(up);
		row.appendChild(el('span', 'pct', Math.round(STEPS[cur] * 100) + '%'));
		menuEl.appendChild(row);

		// The dock's tiling.
		menuEl.appendChild(el('div', 'pop-head', 'Dock tiling'));
		var grids = P().grids();
		var gseg = el('div', 'seg');
		[['auto', 'Auto'], ['1', '1'], ['2x2', '2×2'], ['2x3', '2×3'], ['3x2', '3×2']].forEach(function (pair) {
			var key = pair[0];
			var g = grids[key] || { cols: model.cols, rows: model.rows };
			var b = el('button', 'grid-opt');
			b.setAttribute('aria-pressed', P().grid() === key ? 'true' : 'false');
			b.title = key === 'auto'
				? 'A second column once the window is wide enough for it'
				: g.cols + ' column' + (g.cols === 1 ? '' : 's') + ', up to ' + (g.cols * g.rows) + ' panels';
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
			b.appendChild(el('span', 'cap', pair[1]));
			b.addEventListener('click', function () { P().setGrid(key); renderMenu(); });
			gseg.appendChild(b);
		});
		menuEl.appendChild(gseg);

		// This Facet's arrangement, when there is a Facet to hang it on.
		var facet = window.DaimondFacet && DaimondFacet.current && DaimondFacet.current();
		if (facet && facet.id) {
			menuEl.appendChild(el('div', 'pop-head', 'This Facet'));
			var saved = P().hasArrangement(facet.id);
			var save = el('button', 'gal-row');
			save.appendChild(el('span', 'nm', saved ? 'Update the saved arrangement' : 'Keep this arrangement with ' + (facet.name || 'this Facet')));
			save.addEventListener('click', function () {
				P().saveArrangement(facet.id);
				renderMenu();
			});
			menuEl.appendChild(save);
			if (saved) {
				var drop = el('button', 'gal-row');
				drop.appendChild(el('span', 'nm', 'Forget it'));
				drop.addEventListener('click', function () { P().forgetArrangement(facet.id); renderMenu(); });
				menuEl.appendChild(drop);
			}
			var n = el('div', 'pop-note');
			n.textContent = 'Opening this Facet again restores the panels it was worked in. Nothing is remembered until you ask for it.';
			menuEl.appendChild(n);
		}
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
				kind: 'Panel', name: p.label,
				hint: p.open ? 'open' : (p.full ? 'dock full' : ''),
				run: function () { P().activate(p.id); },
				off: !!(p.full && !p.open),
			});
		});
		(window.DaimondTheme ? DaimondTheme.list() : []).forEach(function (t) {
			out.push({
				kind: 'Theme', name: t.charAt(0).toUpperCase() + t.slice(1),
				hint: DaimondTheme.get() === t ? 'current' : '',
				run: function () { DaimondTheme.set(t); },
			});
		});
		STEPS.forEach(function (v, i) {
			out.push({
				kind: 'Text size', name: STEP_NAMES[i],
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
				kind: 'Dock', name: grids[k].label,
				hint: P().grid() === k ? 'current' : '',
				run: function () { P().setGrid(k); },
			});
		});
		out.push({ kind: 'Dock', name: 'Automatic', hint: P().grid() === 'auto' ? 'current' : '',
			run: function () { P().setGrid('auto'); } });
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
			var e = el('li', 'pal-empty', 'Nothing matches.');
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

	function openPalette() {
		palEl = palEl || document.getElementById('palette');
		if (!palEl || !palEl.hidden) return;
		closeMenu(); closeGallery();
		palInput = document.getElementById('pal-input');
		palList = document.getElementById('pal-list');
		palInput.value = '';
		palAt = 0;
		palEl.hidden = false;
		renderPalette();
		palInput.focus();
	}

	function closePalette() {
		if (!palEl || palEl.hidden) return;
		palEl.hidden = true;
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
			DaimondTheme.set = function (t) { inner(t); tellFrames(); };
			DaimondTheme._wrapped = true;
		}

		var menuBtn = document.getElementById('settings-menu-btn');
		if (menuBtn) menuBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(menuBtn); });

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
			});
		}
		if (palEl) palEl.addEventListener('mousedown', function (e) { if (e.target === palEl) closePalette(); });

		document.addEventListener('keydown', function (e) {
			// Ctrl/Cmd-K is the convention users arrive already knowing, and it is
			// not a browser binding on any platform we serve.
			if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
				e.preventDefault();
				palEl && palEl.hidden ? openPalette() : closePalette();
				return;
			}
			if (e.key === 'Escape') { closeMenu(); closeGallery(); closePalette(); }
		});

		// A click anywhere else closes a popover, which is what a user expects of
		// one and what stops two being open at once.
		document.addEventListener('click', function (e) {
			if (menuEl && !menuEl.hidden && !menuEl.contains(e.target)) closeMenu();
			if (galEl && !galEl.hidden && !galEl.contains(e.target)) closeGallery();
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
