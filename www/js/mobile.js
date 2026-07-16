/* ============================================================
   Daimond — the phone shell controller
   ------------------------------------------------------------
   Two surfaces beyond the chat floor and the bottom bar:

     the DRAWER   the rail (Foci / Chats / Admin), slid in from
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
	var DEFAULT_FULL = { doc: 1, compose: 1, tools: 1 };
	// Guests with nothing to "ask about" hide the ask pill.
	var NO_ASK       = { compose: 1, tools: 1 };

	var sheetEl, bodyEl, grabEl, titleEl, askWrap, askInput, askSend;
	var guest = null;			// the panel id currently in the sheet, or null
	var detent = 'half';		// full | half | peek
	var closing = false;		// re-entrancy guard against DaimondPanels.hide

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

	/// Raise a guest. The element is MOVED into the sheet (the same idiom
	/// the desktop layout engine uses to reorder panels); the desktop's
	/// apply() skips reordering on a phone, so it stays put until closed.
	function open(id) {
		if (!sheetEl) return;
		var el = document.getElementById('panel-' + id);
		if (!el) return;
		if (guest && guest !== id) stashBack();		// only one thing up at a time
		el.style.display = '';						// clear any inline none left by apply()
		bodyEl.appendChild(el);
		guest = id;
		titleEl.textContent = label(id);
		document.body.classList.add('sheet-open');
		sheetEl.classList.add('open');
		if (NO_ASK[id]) askWrap.classList.add('hidden');
		else {
			askWrap.classList.remove('hidden');
			askInput.placeholder = 'Ask about this ' + label(id).toLowerCase() + '…';
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
	function bindGrab() {
		var startY = 0, startH = 0, dragging = false;
		grabEl.addEventListener('pointerdown', function (e) {
			dragging = true;
			startY = e.clientY;
			startH = sheetEl.getBoundingClientRect().height;
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

		// Picking a chat or a Focus is "go work on this" — the drawer's job
		// is done, so it steps out of the way.
		var rail = document.getElementById('panel-rail');
		if (rail) rail.addEventListener('click', function (e) {
			if (e.target.closest('.session-box, .focus-box')) closeDrawer();
		});

		// A left-edge swipe opens the drawer; a swipe on the open drawer's
		// scrim is caught by the scrim tap. Gesture, always paired with the
		// visible hamburger — never gesture-only.
		bindEdgeSwipe();

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
