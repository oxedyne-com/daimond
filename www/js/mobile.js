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

	// ── The drawer ─────────────────────────────────────────────
	function openDrawer()  { document.body.classList.add('drawer-open'); }
	function closeDrawer() { document.body.classList.remove('drawer-open'); }
	function toggleDrawer() { document.body.classList.toggle('drawer-open'); }

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

	var sheetEl, bodyEl, grabEl, titleEl, askWrap, askInput, askSend;
	var guest = null;			// the panel id currently in the sheet, or null
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

	// The bar (~58px) and the top bar (~50px) bound the room the sheet may take.
	var BAR = 58, TOPBAR = 50, PEEK = 56;

	/// The most a sheet may grow to: from just under the top bar to just above
	/// the bottom bar. `full` stops a touch short so a sliver of chat stays.
	function maxH() { return Math.max(PEEK, window.innerHeight - TOPBAR - BAR); }

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
		var el = document.getElementById('panel-' + id);
		if (!el) return;
		if (guest && guest !== id) stashBack();		// only one thing up at a time
		// Captured before anything in the sheet takes the keyboard, and only on
		// the FIRST raise: swapping one guest for another must not make the
		// outgoing guest the thing focus goes home to.
		if (!guest) opener = document.activeElement;
		el.style.display = '';						// clear any inline none left by apply()
		bodyEl.appendChild(el);
		guest = id;
		titleEl.textContent = label(id);
		hideRedundantHead(el, label(id));
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

	/// Put the guest element back where the desktop engine expects it,
	/// hidden, so a later resize to desktop reseats it correctly.
	function stashBack() {
		var el = document.getElementById('panel-' + guest);
		var stage = document.getElementById('stage');
		if (el && stage) { el.style.display = 'none'; stage.appendChild(el); }
	}

	function teardown() {
		stashBack();
		guest = null;
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
		if (guest === id) teardown();
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
		askWrap  = document.getElementById('msheet-ask');
		askInput = document.getElementById('msheet-ask-input');
		askSend  = document.getElementById('msheet-ask-send');
		if (!sheetEl) return;

		bindGrab();
		document.getElementById('msheet-close').addEventListener('click', close);
		askSend.addEventListener('click', ask);
		askInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
		});

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
				if (guest && !sheetEl.classList.contains('dragging')) snapTo(detent);
			});
		}

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
	};
	window.DaimondShell = {
		openDrawer: openDrawer, closeDrawer: closeDrawer, toggleDrawer: toggleDrawer,
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
