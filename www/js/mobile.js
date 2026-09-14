/* ============================================================
   Daimond — the phone shell controller
   ------------------------------------------------------------
   Two surfaces beyond the chat floor and the bottom bar:

     the DRAWER   the rail (Diamonds / Chats / Admin), slid in from
                  the left. Opened by the hamburger, closed by a
                  tap on the scrim, a swipe, or picking a chat.

     the SHEET    a "thing" (Web, Doc, Message, Compose, Tools)
                  raised over the chat at three detents. `half`
                  shows the thing and the tail of the conversation
                  together — the daimon beside the thing. An ask
                  pill at its foot forwards to the one composer, so
                  the thing can be talked over without leaving it.

   `daimond.js` routes here: a stage guest reaching mshow() opens
   the sheet; the rail opens the drawer. This file exposes
   window.DaimondSheet (open/close/onEngineHide) and
   window.DaimondShell (openDrawer/closeDrawer).
   ============================================================ */
(function () {
	'use strict';

	var mq = window.matchMedia('(max-width: 760px)');
	function isPhone() { return mq.matches; }

	// ── Is this MACHINE a mobile one? ──────────────────────────
	//
	// `isPhone` is a LAYOUT question -- is the viewport narrow -- and it was being
	// read as a hardware one. A desktop window dragged under 760px then routed like a
	// phone, and the hand-off election judged a PEER's mobility from the name its
	// owner had typed, so a phone called "Jason's phone" was seatable as a worker.
	// Mobility is a property of the device, decided ONCE from real signals and beaten
	// to the fleet (daimond.js presenceTick), never inferred from a label or a width.
	//
	// The signals, any two of which make a phone or tablet and none of which a
	// desktop browser offers together:
	//
	//   coarse pointer   a finger, not a mouse -- true on a touchscreen laptop too,
	//                    which is why it does not decide alone;
	//   no hover         a pointer that cannot rest over a thing;
	//   touch points     maxTouchPoints > 0, same caveat as coarse;
	//   UA mobility      `navigator.userAgentData.mobile` where the browser offers it
	//                    (Chromium), else the platform string -- the only DIRECT
	//                    statement of the fact, so it decides on its own;
	//   iPadOS           a Mac-shaped UA with touch points: an iPad asking for the
	//                    desktop site, which no real Mac can be.
	//
	// Decided at first call and cached: a device does not stop being a phone, and a
	// flag that moved would make the fleet's view of a seat flicker.
	var _isMobile = null;
	function isMobileDevice() {
		if (_isMobile !== null) return _isMobile;
		_isMobile = detectMobile();
		return _isMobile;
	}

	/// The one-off measurement behind `isMobileDevice`. Every probe is guarded: an
	/// engine missing one of these must read as DESKTOP rather than throw, because a
	/// device that cannot say is better seated than wrongly excluded.
	function detectMobile() {
		var ua = '', uaMobile = null, touch = 0, coarse = false, noHover = false, standalone = false;
		try { ua = String(navigator.userAgent || ''); } catch (e) { ua = ''; }
		try {
			if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') {
				uaMobile = navigator.userAgentData.mobile;
			}
		} catch (e) { uaMobile = null; }
		try { touch = navigator.maxTouchPoints | 0; } catch (e) { touch = 0; }
		try { coarse  = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { coarse = false; }
		try { noHover = !!(window.matchMedia && window.matchMedia('(hover: none)').matches); } catch (e) { noHover = false; }
		// A home-screen PWA is not itself proof of a phone (a desktop can install one),
		// so it only ever adds to the touch evidence below.
		try {
			standalone = !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
				|| window.navigator.standalone);
		} catch (e) { standalone = false; }
		// A direct statement settles it, either way: Chromium's client hint is the fact
		// itself, not a proxy for it.
		if (uaMobile !== null) return uaMobile;
		// An iPhone / Android / iPad names itself. Safari on iPadOS does not (it sends a
		// Mac UA), so a Mac WITH touch points is an iPad asking for the desktop site.
		if (/iphone|ipod|android.*mobile|\bmobile safari\b/i.test(ua)) return true;
		if (/ipad/i.test(ua)) return true;
		if (/\bandroid\b/i.test(ua)) return true;
		if (/macintosh|mac os x/i.test(ua) && touch > 0) return true;
		// No statement and no name: two independent touch signals, which a mouse-driven
		// desktop never has. A touchscreen laptop has coarse+touch but keeps hover.
		var signals = (coarse ? 1 : 0) + (noHover ? 1 : 0) + (touch > 0 ? 1 : 0) + (standalone && coarse ? 1 : 0);
		return signals >= 3;
	}

	// ── The drawer ─────────────────────────────────────────────
	function openDrawer()  { document.body.classList.add('drawer-open'); }
	function closeDrawer() { document.body.classList.remove('drawer-open'); }
	function toggleDrawer() { document.body.classList.toggle('drawer-open'); }

	// ── The drawer's sections ──────────────────────────────────
	//
	// Reported from an iPhone PWA on 2026-09-14: the Diamonds and Chats sections
	// are "impractically small". Measured at 390x844 with ten Diamonds and
	// twenty-five chats, the Diamonds list was 150px of a 549px content and the
	// Chats list 146px of 2538px -- one chat tile of twenty-five fully on screen.
	// The arithmetic is in mobile.css beside the rules; the short of it is that
	// the status strip is `flex: none` and took 345px of the 828 there are, and
	// the desktop's lever on that -- the drag handle between the two lists -- is
	// hidden on a phone with nothing in its place.
	//
	// So each section folds, and folding one gives its room to whatever is still
	// open. The state is per DEVICE: which sections are worth their height is a
	// fact about the screen in the hand, and a phone and a desktop that shared an
	// account would otherwise fight over it.
	var FOLD_KEY  = 'daimond-rail-fold';
	// Diamonds and Chats are what the drawer is for. The status rows are eleven
	// answers to questions nobody is asking while looking for a chat, so they
	// start away -- and their header row, which carries the identity and the only
	// cog a phone has, stays whatever this says.
	var FOLD_DEF  = { diamonds: true, chats: true, status: false };
	var folds     = null;

	function foldState() {
		if (folds) return folds;
		folds = { diamonds: FOLD_DEF.diamonds, chats: FOLD_DEF.chats, status: FOLD_DEF.status };
		try {
			var raw = JSON.parse(localStorage.getItem(FOLD_KEY) || 'null');
			if (raw && typeof raw === 'object') {
				Object.keys(folds).forEach(function (k) {
					if (typeof raw[k] === 'boolean') folds[k] = raw[k];
				});
			}
		} catch (e) { /* private mode, or a key somebody hand-edited */ }
		return folds;
	}

	/// Paint the fold state onto the rail and its three controls.
	///
	/// The attributes are written at every width. The rules that act on them live
	/// inside the phone breakpoint, so a desktop is untouched by a state its user
	/// cannot even see the controls for -- and a window dragged back under 760px
	/// finds the drawer as this device last left it.
	function applyFold() {
		var rail = document.getElementById('panel-rail');
		if (!rail) return;
		var st = foldState();
		Object.keys(st).forEach(function (k) {
			rail.setAttribute('data-fold-' + k, st[k] ? 'on' : 'off');
		});
		var t = (window.DaimondI18n && DaimondI18n.t) ? DaimondI18n.t : null;
		[].slice.call(rail.querySelectorAll('.rail-fold')).forEach(function (b) {
			var k = b.getAttribute('data-fold');
			if (!(k in st)) return;
			var open = !!st[k];
			b.setAttribute('aria-expanded', open ? 'true' : 'false');
			var key = open ? 'rail.fold_section' : 'rail.unfold_section';
			var txt = open ? 'Fold this section away' : 'Open this section';
			// `t` answers with the KEY when a table has no entry, so the English
			// above stands rather than a dotted identifier reaching a tooltip.
			if (t) { try { var got = t(key); if (got && got !== key) txt = got; } catch (e) { /* table not up */ } }
			// The data attributes move with the state, so a language change after
			// the fold re-resolves the label the section is actually wearing.
			b.setAttribute('data-i18n-title', key);
			b.setAttribute('data-i18n-aria-label', key);
			b.title = txt;
			b.setAttribute('aria-label', txt);
		});
	}

	function setFold(k, open) {
		var st = foldState();
		if (!(k in st)) return;
		st[k] = !!open;
		try { localStorage.setItem(FOLD_KEY, JSON.stringify(st)); } catch (e) { /* nothing to remember with */ }
		applyFold();
	}

	function bindFolds() {
		var rail = document.getElementById('panel-rail');
		if (!rail) return;
		applyFold();
		rail.addEventListener('click', function (e) {
			var b = e.target.closest && e.target.closest('.rail-fold');
			if (b && rail.contains(b)) {
				e.preventDefault();
				e.stopPropagation();
				setFold(b.getAttribute('data-fold'), b.getAttribute('aria-expanded') !== 'true');
				return;
			}
			// The heading beside it is the same act with a thumb's worth of target.
			// Phone only: on a desktop that word is a heading and nothing else, and
			// there is a drag handle for what this does.
			if (!isPhone()) return;
			var h = e.target.closest && e.target.closest('.railhead > span[role="heading"]');
			if (!h || !rail.contains(h)) return;
			var head = h.parentNode.querySelector('.rail-fold');
			if (!head) return;
			e.preventDefault();
			setFold(head.getAttribute('data-fold'), head.getAttribute('aria-expanded') !== 'true');
		});
		// A language change repaints the two labels this file owns.
		if (window.DaimondI18n && DaimondI18n.onChange) DaimondI18n.onChange(applyFold);
	}

	// ── The keyboard, which `dvh` does not answer ───────────────
	//
	// `100dvh` is the viewport with the browser chrome retracted, and it does not
	// shrink when iOS raises the keyboard over the page -- so a drawer opened from
	// a focused composer ran its last rows underneath one. `--vvh` is the VISUAL
	// viewport's height, and it is set only while something is genuinely covering
	// the page, so the ordinary case stays the `dvh` it always was rather than a
	// number this file has to keep right through every rotation and scroll.
	function fitVisual() {
		var vv = window.visualViewport;
		var root = document.documentElement;
		if (!vv || !root) return;
		var covered = (window.innerHeight || 0) - vv.height;
		if (covered > 80) root.style.setProperty('--vvh', Math.round(vv.height) + 'px');
		else root.style.removeProperty('--vvh');
	}

	// ── The footer: the chip row ───────────────────────────────
	//
	// The bar carried four hard-wired destinations -- Chat, Email, Files, Agents
	// -- and named four of the seventeen panels there are. It carries the chip
	// row now, which is the row the desktop header carries, MOVED here rather
	// than copied: `#panel-tags` is the one row the layout engine renders, and
	// the one the gallery asks whether a panel is on. A second copy would be a
	// second thing to keep in step with both, and the first to drift.

	/// Put the chip row where this width wants it: the footer on a phone, the
	/// top bar otherwise.
	function placeChips() {
		var row  = document.getElementById('panel-tags');
		var bar  = document.getElementById('mnav');
		var acts = document.querySelector('.top-actions');
		if (!row || !bar || !acts) return;
		var want = isPhone() ? bar : acts;
		if (row.parentNode === want) return;
		// FIRST in the top bar, which is where the markup has it: the icon buttons
		// after it are what the row's left edge is measured against.
		if (want === acts) acts.insertBefore(row, acts.firstChild);
		else bar.appendChild(row);
		bindScroll(row);
		if (window.DaimondPanels) DaimondPanels.reflow();
		markHere();
	}

	/// Which panel the user is actually looking at, or '' if that is the chat
	/// floor with nothing over it.
	///
	/// Three surfaces can be the answer and the phone shows one of them at a
	/// time: the drawer (the rail), the sheet (a guest), and the destination on
	/// the floor. Exported because the chip row's renderer has to fill in the
	/// same chip this marks, and two answers to "where am I" would show as two
	/// chips filled at once.
	function here() {
		if (document.body.classList.contains('drawer-open')) return 'rail';
		// The FACE, not the guest: with the Pages tab selected the thing on screen is
		// the Preview, and its chip is the one that should be filled in.
		if (guest) return (FACES[guest] && face) ? face : guest;
		return document.body.dataset.mpanel || '';
	}

	/// Fill in the chip for wherever we are, and scroll it into view.
	///
	/// On a desktop a filled chip means "this panel is open", which is legible
	/// because you can see the panel. On a phone one thing is on screen, so the
	/// only useful meaning is "this is it" -- an `open` Email panel behind a
	/// Terminal sheet is not where the user is.
	var _here = null;
	function markHere() {
		if (!isPhone()) return;
		var row = document.getElementById('panel-tags');
		if (!row) return;
		var id = here(), on = null;
		row.querySelectorAll('.ptag[data-panel]').forEach(function (c) {
			var is = c.dataset.panel === id;
			c.classList.toggle('on', is);
			c.setAttribute('aria-pressed', is ? 'true' : 'false');
			if (is) on = c;
		});
		// SCROLLED TO ONLY WHEN IT CHANGES. This runs on every attribute change to
		// `body` -- and `class` alone carries `resizing`, `sheet-open` and
		// `drawer-open` -- so a scroll on every call would drag the strip back to
		// wherever the user already is each time anything at all happened, while
		// their thumb was on it looking for something else.
		if (on && id !== _here && on.scrollIntoView) {
			try { on.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } catch (e) { /* old engine */ }
		}
		_here = id;
		markScroll(row);
	}

	/// Say which way there is more of the row, so the fade at its ends is true.
	function markScroll(row) {
		var more = row.scrollWidth - row.clientWidth;
		if (more <= 1) { row.removeAttribute('data-more'); return; }
		var atStart = row.scrollLeft <= 1;
		var atEnd   = row.scrollLeft >= more - 1;
		row.dataset.more = atStart ? 'end' : (atEnd ? 'start' : 'both');
	}

	function bindScroll(row) {
		if (row._moreBound) return;
		row._moreBound = true;
		row.addEventListener('scroll', function () { markScroll(row); }, { passive: true });
		if (typeof ResizeObserver !== 'undefined') {
			new ResizeObserver(function () { markScroll(row); }).observe(row);
		}
	}

	/// What a footer chip means: take me there.
	///
	/// NOT the desktop row's toggle. A chip there is filled while its panel is
	/// open and clicking it puts the panel away, which reads correctly because
	/// you can see both states at once. Here the thing it would put away is the
	/// whole screen -- and for the rail it is worse than that: `hide('rail')`
	/// sets `display: none` on the element the drawer IS, and the hamburger only
	/// toggles a class, so the drawer would never open again. See the capture
	/// handler further down, which exists for the same trap on the rail's own
	/// closer.
	function goTo(id) {
		if (guest && guest !== id) close();		// one thing up at a time
		if (window.DaimondPanels) DaimondPanels.show(id);
		markHere();
	}

	// ── The sheet ──────────────────────────────────────────────
	// Guests that default to full (a thing you mostly read or write)
	// versus half (a thing you glance at while talking to the daimon).
	// A thing you mostly read or write, so it opens at full height rather than
	// half. The terminal belongs here for the plainest reason: at the half detent
	// it is eleven rows, and eleven rows is not a terminal.
	var DEFAULT_FULL = { doc: 1, preview: 1, compose: 1, tools: 1, term: 1 };
	// Guests with nothing to "ask about" hide the ask pill. The trash is one:
	// asking the daimon about a list of things you have deleted would offer to
	// spend money on the one surface whose whole subject is undoing a mistake.
	// Social is another, for the opposite reason: it is ALREADY a box you write
	// in, and a second box under it that sends what you write to a model is two
	// boxes with opposite meanings.
	var NO_ASK       = { compose: 1, tools: 1, trash: 1, social: 1 };

	// ── A guest with two faces ─────────────────────────────────
	//
	// A phone raises one thing at a time, and for most of the app that is the right
	// shape: a message, a terminal, a list. It is the wrong shape for a document,
	// because a document and the pages it is typeset into are ONE thing looked at
	// two ways, and the loop that rebuilds the pages only runs while they are on
	// screen. Raising the Preview as its own guest stashed the source, swapping back
	// stashed the pages, and the watch stopped with them -- silently, so a Save then
	// rebuilt nothing and coming back showed the PDF the button had written rather
	// than the document as it now stands.
	//
	// So the second panel is a TAB of the first, both moved into the sheet together
	// and neither ever stashed while the other is up. A table rather than a special
	// case in `open`: anything else that turns out to be one thing seen two ways
	// joins it with a line.
	var FACES = { doc: 'preview' };
	// Which face each two-faced guest was last left on, so going back to a document
	// puts the reader where he left it rather than at the source every time.
	var faceOf = {};

	var sheetEl, bodyEl, grabEl, titleEl, tabsEl, askWrap, askInput, askSend;
	var guest = null;			// the panel id currently in the sheet, or null
	var face  = null;			// which of a two-faced guest's panels is showing
	var detent = 'half';		// full | half | peek
	var closing = false;		// re-entrancy guard against DaimondPanels.hide
	// What had the keyboard when the sheet went up, so the sheet can give it
	// back. Without this a dismissal dropped focus on the document body and the
	// next Tab started again from the top of the app.
	var opener = null;

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	function label(id) {
		var el = document.getElementById('panel-' + id);
		return (el && el.getAttribute('data-label')) || id;
	}

	// The top bar (~50px) and the bottom bar bound the room the sheet may take.
	var BAR_FALLBACK = 62, TOPBAR = 50, PEEK = 56;

	/// How tall the bottom bar actually is, home indicator included.
	///
	/// MEASURED, not written down. This was the constant 58 while css/mobile.css
	/// drew the bar from its own 58 and variables.css declared 54 -- three copies
	/// of one number, and the sheet's foot is placed from one of them while its
	/// height is worked out from another. A bar that changes (it did, on
	/// 2026-08-28, when the four destinations became the chip row) then puts the
	/// sheet's foot over it, which is what `dev/verify_sweep_mobile.mjs` measures
	/// at every phone width and with a notch inset posed. The fallback is for a
	/// call before the bar is laid out, and errs LARGE, which errs towards a
	/// shorter sheet.
	function barH() {
		var b = document.getElementById('mnav');
		var h = b ? Math.round(b.getBoundingClientRect().height) : 0;
		return h > 0 ? h : BAR_FALLBACK;
	}

	/// How much of the screen the on-screen keyboard is covering, in px.
	///
	/// MEASURED FROM `visualViewport`, which is the only thing that knows. iOS does
	/// not shrink the layout viewport for a keyboard -- `innerHeight` is the same
	/// number with the keys up as without -- so a sheet placed from `innerHeight`
	/// alone puts the line being typed behind the keys, which is what the author met
	/// editing a chapter on the phone. Zero where there is no visual viewport and
	/// zero while no keyboard is up, so every caller can add it unconditionally.
	function kbH() {
		var vv = window.visualViewport;
		if (!vv) return 0;
		var hidden = window.innerHeight - vv.height - vv.offsetTop;
		// A pixel or two of rounding is not a keyboard; a quarter of the screen is.
		return hidden > 24 ? Math.round(hidden) : 0;
	}

	/// Put the measured keyboard where the stylesheet can use it.
	function sayKb() {
		if (!sheetEl) return;
		var k = kbH();
		sheetEl.style.setProperty('--kb', k + 'px');
	}

	/// The most a sheet may grow to: from just under the top bar to just above
	/// the bottom bar, and above the keyboard when one is up.
	function maxH() { return Math.max(PEEK, window.innerHeight - TOPBAR - barH() - kbH()); }

	/// The HEIGHT of the sheet at each detent (it is anchored to the bottom, so
	/// a taller sheet reveals more of the thing and less of the chat).
	function detentH(name) {
		if (name === 'peek') return PEEK;
		if (name === 'full') return maxH();
		return Math.min(maxH(), Math.round(window.innerHeight * 0.52));   // half
	}

	function applyH(px) { sheetEl.style.height = px + 'px'; }

	function snapTo(name) {
		detent = name;
		sheetEl.classList.remove('dragging');
		applyH(detentH(name));		// height is instant; only the slide animates
	}

	/// Hide a guest's own title when the sheet has just said the same thing.
	///
	/// A panel's `.ctitle` is its NAME while it is empty and a live title once it
	/// holds something — a URL, a filename, a subject — so no CSS selector can
	/// tell the two apart, and the stylesheet's attempt to name the offenders was
	/// wrong: it claimed Tools was the only panel that repeated the sheet's label,
	/// and rendering all nine showed Message over Message, Graph over Graph, and a
	/// blank 44px band over Doc, whose title is empty and whose closer is hidden
	/// on a phone. Compose ("New message") and Web (a live URL) are real subtitles
	/// and are left alone.
	///
	/// The test is what is on the screen, made when the guest is raised, so a
	/// panel that later gains a real title keeps it. And a head is dropped only
	/// when it says nothing new AND holds nothing but its own closer: the
	/// Terminal's head repeats the label and carries Start and Stop, and a
	/// terminal you cannot start is not a terminal.
	function hideRedundantHead(el, sheetLabel) {
		var head = el.querySelector('.chead, .railhead');
		if (!head) return;
		var title = head.querySelector('.ctitle');
		var said = title ? (title.textContent || '').trim() : '';
		var same = !said || said.toLowerCase() === String(sheetLabel || '').trim().toLowerCase();
		var ctrls = head.querySelectorAll('button, a[href], input, select, [role="button"]');
		var kept = 0;
		for (var i = 0; i < ctrls.length; i++) {
			// The panel's own closer is what the sheet's own ✕ already is.
			if (!ctrls[i].classList.contains('panel-close')) kept++;
		}
		head.classList.toggle('head-said-twice', same && kept === 0);
	}

	/// Raise a guest. The element is MOVED into the sheet (the same idiom
	/// the desktop layout engine uses to reorder panels); the desktop's
	/// apply() skips reordering on a phone, so it stays put until closed.
	function open(id) {
		if (!sheetEl) return;
		// A face asked for by name raises the guest it belongs to, on that face.
		// Nothing else in the app has to know the sheet folded two panels into one.
		for (var g in FACES) {
			if (FACES[g] !== id) continue;
			open(g);
			tab(id);
			return;
		}
		var el = document.getElementById('panel-' + id);
		if (!el) return;
		if (guest && guest !== id) stashBack();		// only one thing up at a time
		// Captured before anything in the sheet takes the keyboard, and only on
		// the FIRST raise: swapping one guest for another must not make the
		// outgoing guest the thing focus goes home to.
		if (!guest) opener = document.activeElement;
		el.style.display = '';						// clear any inline none left by apply()
		// MOVING AN ELEMENT RESETS EVERY SCROLLER INSIDE IT, so a panel already in
		// the sheet is left exactly where it is. Re-raising the Doc sheet -- which
		// opening another file in it does -- used to re-append both faces, and the
		// live pages came back at page one of a 48-page book every time.
		if (el.parentNode !== bodyEl) bodyEl.appendChild(el);
		guest = id;
		titleEl.textContent = label(id);
		hideRedundantHead(el, label(id));
		// The other face comes up with it, hidden, so the panel the watch draws into
		// is MOUNTED from the moment the sheet opens. Mounted and hidden is a pause;
		// gone is a stop, and the difference is the whole of the loop surviving a tab.
		if (FACES[id]) {
			var other = document.getElementById('panel-' + FACES[id]);
			if (other) {
				other.style.display = '';
				if (other.parentNode !== bodyEl) bodyEl.appendChild(other);
				hideRedundantHead(other, label(FACES[id]));
			}
			// The two share the box rather than halving it; see `.two-faced` in
			// css/mobile.css for why neither is ever taken out of flow.
			bodyEl.classList.add('two-faced');
			drawTabs(id);
			tab(faceOf[id] || id);
		} else {
			bodyEl.classList.remove('two-faced');
			drawTabs(null);
			face = null;
		}
		document.body.classList.add('sheet-open');
		sheetEl.classList.add('open');
		if (NO_ASK[id]) askWrap.classList.add('hidden');
		else {
			askWrap.classList.remove('hidden');
			askInput.placeholder = t('sheet.ask_about', { thing: label(id).toLowerCase() });
		}
		// Size to the detent instantly (still slid off-screen), then add `.open`
		// on the next frame so the transform slides it up into view.
		snapTo(DEFAULT_FULL[id] ? 'full' : 'half');
		requestAnimationFrame(function () { sheetEl.classList.add('open'); });
		setTimeout(function () { sheetEl.classList.add('open'); }, 20);   // headless-safe
	}

	/// Draw the tab strip for a two-faced guest, or take it away.
	///
	/// The strip is its own row under the grabber and NOT inside it, which is not
	/// tidiness: the grabber carries `touch-action: none` and owns every vertical
	/// gesture that starts on it, so a tab drawn there would be a button that moves
	/// the sheet when a thumb slides a pixel on the way down.
	function drawTabs(id) {
		if (!tabsEl) return;
		if (!id || !FACES[id]) { tabsEl.hidden = true; tabsEl.textContent = ''; return; }
		var ids = [id, FACES[id]];
		tabsEl.textContent = '';
		ids.forEach(function (p) {
			var b = document.createElement('button');
			b.type = 'button';
			b.className = 'msheet-tab';
			b.dataset.face = p;
			b.setAttribute('role', 'tab');
			b.setAttribute('aria-controls', 'panel-' + p);
			b.textContent = tabName(p);
			b.addEventListener('click', function () { tab(p); });
			tabsEl.appendChild(b);
		});
		tabsEl.hidden = false;
	}

	/// What a face is called on its tab.
	///
	/// Not the panel's `data-label`: "Doc" and "Preview" name PANELS, and a reader
	/// looking at one document wants the two things he can do with it. The catalogue
	/// carries both, so a language that says it differently can.
	function tabName(p) {
		var k = p === 'doc' ? 'sheet.tab_source' : p === 'preview' ? 'sheet.tab_pages' : '';
		var said = k ? t(k) : '';
		if (said && said !== k) return said;
		return p === 'doc' ? 'Source' : p === 'preview' ? 'Pages' : label(p);
	}

	/// Show one face of a two-faced guest and hide the other.
	///
	/// THE HIDDEN PANEL IS NEITHER MOVED NOR TAKEN OUT OF FLOW. It stays in the sheet
	/// body, laid out, merely invisible -- so the live pages keep their DOM, their
	/// size and the reader's scroll while he is reading the source, and a rebuild that
	/// lands while he types is already up when he turns back. A `display: none` face
	/// loses all three: the browser discards the scroll position of a scroller taken
	/// out of flow, which sent him to page one of a 48-page book on every glance at
	/// the source.
	function tab(p) {
		if (!guest || !FACES[guest]) return;
		var ids = [guest, FACES[guest]];
		if (ids.indexOf(p) < 0) return;
		face = p;
		faceOf[guest] = p;
		// A CLASS AND NOT `style.display`, because `#msheet .panel` carries
		// `display: flex !important` and an inline style loses to `!important`. The
		// first version of this set the inline property, read it back as 'none' and
		// believed it: both panels stayed in the flex column and each took HALF the
		// sheet -- the editor 34px tall under a keyboard, and the pages behind it the
		// whole time the reader thought he was looking at the source.
		ids.forEach(function (q) {
			var el = document.getElementById('panel-' + q);
			if (el) el.classList.toggle('msheet-face-off', q !== p);
		});
		if (tabsEl) {
			tabsEl.querySelectorAll('.msheet-tab').forEach(function (b) {
				var on = b.dataset.face === p;
				b.classList.toggle('on', on);
				b.setAttribute('aria-selected', on ? 'true' : 'false');
				b.tabIndex = on ? 0 : -1;
			});
		}
		// TURNING TO THE PAGES DOES NOT WAIT FOR THE POLL. Nothing is PAUSED by
		// turning away from them, on purpose -- the reader is on Source only for as
		// long as it takes to type and save, and pausing there would hand him a stale
		// document and a rebuild to wait through on every switch (js/typstwatch.js
		// `atHand`). The resume here is for the other way in: a sheet raised again
		// after another guest had it, which the poll would answer a second later.
		try {
			var w = window.DaimondTypstWatch;
			if (w && p === FACES[guest]) w.resume();
		} catch (e) { /* no watch is the ordinary case */ }
		markHere();
	}

	/// Put the guest element back where the desktop engine expects it,
	/// hidden, so a later resize to desktop reseats it correctly.
	///
	/// BOTH FACES, because both were raised: a second panel left in the sheet body
	/// after the sheet came down is a panel the desktop engine cannot seat.
	function stashBack() {
		var stage = document.getElementById('stage');
		if (!stage) return;
		var ids = [guest];
		if (FACES[guest]) ids.push(FACES[guest]);
		ids.forEach(function (id) {
			var el = document.getElementById('panel-' + id);
			if (!el) return;
			el.classList.remove('msheet-face-off');		// the sheet's business, not the stage's
			el.style.display = 'none';
			stage.appendChild(el);
		});
	}

	function teardown() {
		stashBack();
		if (bodyEl) bodyEl.classList.remove('two-faced');
		drawTabs(null);
		guest = null;
		face  = null;
		document.body.classList.remove('sheet-open');
		sheetEl.classList.remove('open');		// slides down (transform), then rests
		applyH(0);
		// Give the keyboard back to whatever raised the sheet, if it is still on
		// screen — a panel that redrew underneath may have taken it with it.
		if (opener && opener.focus && opener.getClientRects && opener.getClientRects().length) {
			try { opener.focus(); } catch (e) { /* gone with the redraw */ }
		}
		opener = null;
	}

	/// A user dismissal: tear the sheet down AND tell the engine the panel
	/// is closed, so its state and (on desktop) its header tag stay honest.
	function close() {
		if (!guest) return;
		var id = guest;
		teardown();
		closing = true;
		try { if (window.DaimondPanels) DaimondPanels.hide(id); }
		finally { closing = false; }
	}

	/// The engine closed a panel (e.g. its own close button was reached).
	/// Mirror it in the sheet, unless we are the ones who asked for it.
	function onEngineHide(id) {
		if (closing) return;
		if (guest === id) { teardown(); return; }
		// A FACE CLOSED OUT FROM UNDER THE SHEET -- the Preview's own closer, or its
		// chip -- leaves the sheet holding a panel with nothing in it. Turn back to
		// the face that is still worth looking at rather than showing the blank.
		if (guest && FACES[guest] === id && face === id) tab(guest);
	}

	// ── Dragging the grabber ───────────────────────────────────
	// Drag UP grows the sheet (reveal more of the thing); drag DOWN shrinks it,
	// and past peek it dismisses.
	//
	// THE SHEET MOVES FROM THE GRABBER AND FROM NOWHERE ELSE. THE GUEST OWNS
	// EVERY DRAG INSIDE ITSELF.
	//
	// That is a rule and not a description, because a guest can now be a
	// SCROLLER: the watched live document puts a tall column of typeset pages in
	// `.tl-scroll` inside this sheet, and a nested scroller under a draggable
	// surface is where gestures fight. Whichever of the two loses becomes
	// impossible — a sheet that takes the drag makes the book unreadable, and a
	// scroller that takes it makes the sheet unmovable — so the line is drawn at
	// the grabber, which is the one strip of the sheet a guest never occupies.
	//
	// Measured at 390x844, with a six-page document in the sheet at `full`:
	//
	//     drag up from the middle of the pages   document +333px, sheet unmoved
	//     drag down near the top, page scrolled  document back to +58, sheet unmoved
	//     drag down at the very top             nothing moves at all: not the
	//                                           scroller, not the sheet body, not
	//                                           the page behind it
	//     drag down on the grabber              sheet 736 -> 439, and the reader
	//                                           stays on page 1 +36pt
	//
	// The third line is the one worth keeping: an overscroll cannot escape,
	// because `responsive.css` pins `html, body { overscroll-behavior: none }`
	// under 760px and `#msheet-body` is not itself a scroller. So a drag that
	// runs off the end of the book does nothing, rather than dragging the sheet
	// or pulling the page down to refresh — and a refresh is the one thing a live
	// compiler does not survive.
	//
	// The obvious "improvement" — letting a drag anywhere in the sheet move it,
	// which is what several phone sheets do — would take the pages away. Do not.
	function bindGrab() {
		var startY = 0, startH = 0, startDetent = 'half', dragging = false;
		grabEl.addEventListener('pointerdown', function (e) {
			dragging = true;
			startY = e.clientY;
			startH = sheetEl.getBoundingClientRect().height;
			startDetent = detent;
			sheetEl.classList.add('dragging');
			grabEl.setPointerCapture(e.pointerId);
		});
		grabEl.addEventListener('pointermove', function (e) {
			if (!dragging) return;
			var h = Math.min(maxH(), Math.max(0, startH + (startY - e.clientY)));
			applyH(h);
		});
		grabEl.addEventListener('pointerup', function (e) {
			if (!dragging) return;
			dragging = false;
			try { grabEl.releasePointerCapture(e.pointerId); } catch (x) {}
			var h = Math.max(0, startH + (startY - e.clientY));
			// Dragged well below peek: dismiss.
			if (h < PEEK - 24) { close(); return; }
			// Otherwise snap to the nearest of full/half/peek by height.
			var opts = [['full', detentH('full')], ['half', detentH('half')], ['peek', detentH('peek')]];
			var best = opts[0], bestD = Infinity;
			opts.forEach(function (o) {
				var d = Math.abs(o[1] - h);
				if (d < bestD) { bestD = d; best = o; }
			});
			snapTo(best[0]);
		});
		// A POINTER STREAM CAN END IN `pointercancel` RATHER THAN `pointerup`, and
		// on a phone it does: the browser claims a gesture mid-drag and takes the
		// pointer with it. Nothing listened for that, so the drag never ended —
		// `dragging` stayed true, `.dragging` stayed on the sheet, and the sheet was
		// left stuck at whatever height the cancelled drag had reached. Worse, the
		// `visualViewport` re-fit below skips a sheet that is `.dragging`, so from
		// then on a keyboard coming up no longer re-fitted it either. Measured: a
		// cancel at 299px left the sheet at 299px through a viewport change to 600.
		//
		// It goes back to the detent the drag STARTED at, not to the nearest one: a
		// gesture the user did not finish decided nothing.
		grabEl.addEventListener('pointercancel', function (e) {
			if (!dragging) return;
			dragging = false;
			try { grabEl.releasePointerCapture(e.pointerId); } catch (x) {}
			snapTo(startDetent);
		});
	}

	// ── The keyboard, and the line being typed ─────────────────
	//
	// A phone editing a file is half a screen of text and half a screen of keys, and
	// the one thing that must be on the visible half is the line the caret is on. Two
	// mechanisms, and both are needed: the SHEET is placed above the keyboard (`kbH`
	// and `--kb`), and the TEXTAREA is scrolled so the caret's own line sits inside
	// what is left. Neither alone is enough -- a sheet above the keys still hides the
	// caret when it is forty lines down, and a scrolled textarea whose foot is behind
	// the keys is scrolled to a place nobody can see.

	/// A hidden copy of the textarea, for measuring where the caret actually IS.
	///
	/// THE ARITHMETIC ANSWER IS WRONG HERE. `.files-edit` is `white-space: pre-wrap`
	/// with `word-break: break-word`, so a logical line is any number of visual ones
	/// and counting `\n` before the caret gives a row that does not exist on screen.
	/// A mirror with the same font, padding and width wraps the same way by
	/// construction, which is the only way to be right about a wrapped line without
	/// asking the engine to lay the text out twice.
	var mirror = null;
	function caretRect(ta) {
		var el = ta || (guest && bodyEl ? bodyEl.querySelector('textarea') : null);
		if (!el || !el.isConnected) return null;
		if (!mirror) {
			mirror = document.createElement('div');
			mirror.setAttribute('aria-hidden', 'true');
			mirror.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;'
				+ 'white-space:pre-wrap;word-break:break-word;overflow:hidden';
			document.body.appendChild(mirror);
		}
		var cs = window.getComputedStyle(el);
		['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
			'textTransform', 'padding', 'border', 'boxSizing', 'tabSize'].forEach(function (k) {
			mirror.style[k] = cs[k];
		});
		mirror.style.width = el.clientWidth + 'px';
		var at = el.selectionStart || 0;
		mirror.textContent = el.value.slice(0, at);
		var mark = document.createElement('span');
		// A zero-width space, so an empty line still has a box with a height.
		mark.textContent = '\u200b';
		mirror.appendChild(mark);
		var line = parseFloat(cs.lineHeight);
		if (!isFinite(line)) line = parseFloat(cs.fontSize) * 1.4;
		var box = el.getBoundingClientRect();
		var top = box.top + mark.offsetTop - el.scrollTop;
		return {
			top:    top,
			bottom: top + line,
			left:   box.left + mark.offsetLeft - el.scrollLeft,
			height: line,
			// What the caller has to fit it into, keyboard and all.
			seen:   { top: TOPBAR, bottom: window.innerHeight - kbH() },
		};
	}

	/// Scroll the editor so the caret's line is in the part of the screen the
	/// keyboard has left, and no further than it has to.
	function keepCaret() {
		if (!guest || !bodyEl) return;
		var ta = bodyEl.querySelector('textarea');
		if (!ta || document.activeElement !== ta) return;
		var r = caretRect(ta);
		if (!r) return;
		var box = ta.getBoundingClientRect();
		// A line of margin either side, so the caret is never flush against an edge
		// and the line above it can be read while the line below is written.
		var pad = Math.round(r.height);
		var lo = Math.max(box.top, r.seen.top) + pad;
		var hi = Math.min(box.bottom, r.seen.bottom) - pad;
		if (hi <= lo) return;			// nothing left to fit it into
		if (r.bottom > hi) ta.scrollTop += (r.bottom - hi);
		else if (r.top < lo) ta.scrollTop -= (lo - r.top);
	}

	/// The sheet knows it is being typed into, so the other face steps aside.
	function typing(on) {
		if (tabsEl) tabsEl.classList.toggle('typing', !!on);
		document.body.classList.toggle('sheet-typing', !!on);
	}

	function bindKeyboard() {
		if (!bodyEl) return;
		bodyEl.addEventListener('focusin', function (e) {
			if (!e.target || e.target.tagName !== 'TEXTAREA') return;
			typing(true);
			// After the engine has scrolled the field into view itself, so this is
			// the last word on where the line ends up rather than the first.
			setTimeout(keepCaret, 60);
		});
		bodyEl.addEventListener('focusout', function (e) {
			if (!e.target || e.target.tagName !== 'TEXTAREA') return;
			typing(false);
		});
		// Every way the caret moves: typing, an arrow key, a tap into the text.
		['input', 'keyup', 'click'].forEach(function (ev) {
			bodyEl.addEventListener(ev, function (e) {
				if (!e.target || e.target.tagName !== 'TEXTAREA') return;
				keepCaret();
			});
		});
	}

	// ── The ask pill: forward to the one composer ──────────────
	function ask() {
		var text = (askInput.value || '').trim();
		if (!text) return;
		if (!(window.DaimondCore && DaimondCore.ask)) return;
		DaimondCore.ask(text);
		askInput.value = '';
		askInput.blur();
		// Park the thing so the answer, which lands on the chat floor
		// behind the sheet, comes fully into view. The peek bar taps back.
		snapTo('peek');
	}

	// ── Init ───────────────────────────────────────────────────
	function init() {
		sheetEl  = document.getElementById('msheet');
		bodyEl   = document.getElementById('msheet-body');
		grabEl   = document.getElementById('msheet-grab');
		titleEl  = document.getElementById('msheet-title');
		tabsEl   = document.getElementById('msheet-tabs');
		askWrap  = document.getElementById('msheet-ask');
		askInput = document.getElementById('msheet-ask-input');
		askSend  = document.getElementById('msheet-ask-send');
		if (!sheetEl) return;

		bindGrab();
		bindKeyboard();
		sayKb();
		document.getElementById('msheet-close').addEventListener('click', close);
		askSend.addEventListener('click', ask);
		askInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
		});

		// The chip row belongs to whichever bar this width uses.
		placeChips();

		// WHERE WE ARE IS WATCHED, NOT REPORTED. Six or more paths change it --
		// `mshow`, the sheet opening and closing, the drawer, a panel closing
		// itself, a saved layout being restored -- and every one of them ends in
		// one of these two attributes. Watching them covers the paths nobody
		// remembered to call from, which is exactly how the old bar's four buttons
		// came to be marked in two places and not in the others.
		var watch = new MutationObserver(markHere);
		watch.observe(document.body, { attributes: true, attributeFilter: ['data-mpanel', 'class'] });

		// The drawer's own accordion, and the keyboard fit that goes with it.
		bindFolds();
		fitVisual();

		// The hamburger and the scrim.
		var burger = document.getElementById('drawer-btn');
		if (burger) burger.addEventListener('click', toggleDrawer);
		var scrim = document.getElementById('scrim');
		if (scrim) scrim.addEventListener('click', closeDrawer);

		// Picking a chat or a Diamond is "go work on this" — the drawer's job
		// is done, so it steps out of the way.
		var rail = document.getElementById('panel-rail');
		if (rail) rail.addEventListener('click', function (e) {
			if (e.target.closest('.session-box, .diamond-box')) closeDrawer();
		});

		// The rail's own closer, which responsive.css leaves on screen here alone
		// (see the note beside `.panel.rail .panel-close`). On a desktop it hides
		// the rail panel; on a phone the rail IS the drawer, so it closes the
		// drawer instead — a cross closes the ONE thing it sits on, and here that
		// thing is the drawer.
		//
		// Caught in the CAPTURE phase and stopped, because the panel engine binds
		// every `[data-close]` on the bubble: left to reach it, `hide('rail')`
		// would set `display: none` on the drawer, and the hamburger — which only
		// toggles `body.drawer-open` — would then open nothing at all.
		if (rail) rail.addEventListener('click', function (e) {
			var b = e.target.closest && e.target.closest('.panel-close');
			if (!b || !isPhone()) return;
			e.stopPropagation();
			e.preventDefault();
			closeDrawer();
			var burger2 = document.getElementById('drawer-btn');
			// The keyboard goes back to what opened the drawer.
			if (burger2) { try { burger2.focus(); } catch (x) { /* not on screen */ } }
		}, true);

		// A left-edge swipe opens the drawer; a swipe on the open drawer's
		// scrim is caught by the scrim tap. Gesture, always paired with the
		// visible hamburger — never gesture-only.
		bindEdgeSwipe();

		// Escape, which neither of these two answered. They are the only surfaces
		// in the app that cover it and had no key out at all — a phone shell run
		// on a tablet with a keyboard, or on a desktop narrowed past 760px, left
		// the keyboard with nothing to press.
		//
		// The innermost thing goes first, and a keystroke a dialog has already
		// dealt with is left alone: the app's dialogs call `preventDefault` on the
		// Escape they consume, so `defaultPrevented` is how one closed OVER the
		// sheet avoids taking the sheet down with it.
		document.addEventListener('keydown', function (e) {
			if (e.key !== 'Escape' || e.defaultPrevented) return;
			if (guest) { close(); return; }
			if (document.body.classList.contains('drawer-open')) {
				closeDrawer();
				var burger3 = document.getElementById('drawer-btn');
				if (burger3) { try { burger3.focus(); } catch (x) { /* not on screen */ } }
			}
		});

		// Keep the sheet honest across a keyboard show/hide and rotation.
		if (window.visualViewport) {
			window.visualViewport.addEventListener('resize', function () {
				fitVisual();
				sayKb();
				if (guest && !sheetEl.classList.contains('dragging')) snapTo(detent);
				keepCaret();
			});
		}
		// AND THE PLAIN `resize` TOO, because that is the one a scripted viewport
		// change fires and the one an engine without a visual viewport has at all.
		window.addEventListener('resize', function () {
			sayKb();
			if (guest && !sheetEl.classList.contains('dragging')) snapTo(detent);
			keepCaret();
		});

		// Crossing the phone boundary: fold the phone surfaces away when we
		// grow to desktop, and let the engine reseat everything. Driven off
		// `resize` (not only the media-query `change`, which some engines fire
		// unreliably under a scripted viewport) so the desktop restore is sure.
		if (mq.addEventListener) mq.addEventListener('change', scheduleMode);
		else if (mq.addListener) mq.addListener(scheduleMode);
		window.addEventListener('resize', scheduleMode);
	}

	// Debounced, and gated on the live width rather than the media query — some
	// engines flip matchMedia a beat after the resize event, and the reseat must
	// not miss that beat and leave a guest stranded in the sheet.
	var modeTimer = null;
	function scheduleMode() {
		if (modeTimer) clearTimeout(modeTimer);
		modeTimer = setTimeout(onMode, 60);
	}
	function onMode() {
		// Either way the chip row has to be in the bar this width uses, so this
		// comes before the desktop-only restore below it.
		placeChips();
		if (window.innerWidth <= 760) return;
		closeDrawer();
		if (guest) teardown();
		if (window.DaimondPanels) DaimondPanels.reflow();
	}

	/// A drag that begins within 24px of the left edge opens the drawer.
	function bindEdgeSwipe() {
		var x0 = 0, y0 = 0, live = false;
		document.addEventListener('touchstart', function (e) {
			if (!isPhone() || document.body.classList.contains('drawer-open')) return;
			var t = e.touches[0];
			if (t.clientX <= 24) { live = true; x0 = t.clientX; y0 = t.clientY; }
		}, { passive: true });
		document.addEventListener('touchmove', function (e) {
			if (!live) return;
			var t = e.touches[0];
			if (t.clientX - x0 > 46 && Math.abs(t.clientY - y0) < 40) { openDrawer(); live = false; }
		}, { passive: true });
		document.addEventListener('touchend', function () { live = false; }, { passive: true });
	}

	window.DaimondSheet = {
		open: open, close: close, onEngineHide: onEngineHide,
		isOpen: function () { return !!guest; },
		guest:  function () { return guest; },
		/// Show one face of a two-faced guest by panel id ('doc' or 'preview').
		tab:    tab,
		/// Which face is showing, or null when the guest has only one.
		face:   function () { return face; },
		caretRect: caretRect,
	};
	window.DaimondShell = {
		openDrawer: openDrawer, closeDrawer: closeDrawer, toggleDrawer: toggleDrawer,
		/// What a footer chip does, and where the chip row's renderer asks which
		/// chip to fill in. See `goTo` and `here`.
		goTo: goTo, here: here, markHere: markHere,
		isPhone: isPhone,
		/// The drawer's accordion, published for `dev/verify_railmobile.mjs`: a
		/// verifier that set the storage key by hand would be measuring its own
		/// idea of the format rather than the one `setFold` writes.
		foldState: function () { var st = foldState(); return { diamonds: st.diamonds, chats: st.chats, status: st.status }; },
		setFold:   setFold,
		/// Is this MACHINE a phone or tablet? A hardware question, decided once from
		/// real signals, unlike `isPhone`, which is the layout's 760px question and
		/// moves when a window is resized. The presence beat carries this.
		isMobileDevice: isMobileDevice,
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
