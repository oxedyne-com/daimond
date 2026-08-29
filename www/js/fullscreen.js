/* ============================================================
   Daimond — the app-wide full-screen toggle (phone only)
   ------------------------------------------------------------
   Firefox on Android does not install the PWA standalone, so an
   old device stuck on it has no immersive view at all. The
   browser Fullscreen API is the one way there: it hides the
   address bar, the tabs and the status bar together. Desktop
   already has F11 and a real standalone install, so this control
   never shows there.

   Nothing is persisted -- full screen is transient, and the
   browser drops it on navigation and on the system back gesture.
   The button's face is kept true by listening for
   `fullscreenchange`, so leaving by the back gesture (no click)
   still flips the icon and label back.

   Gated on `DaimondShell.isPhone()`, the app's own layout signal
   (the single 760 cliff), so the control appears and vanishes
   with the phone layout and stays off the landscape breakpoint
   gap a naive innerWidth check would fall into.
   ============================================================ */
(function () {
	'use strict';

	var docEl = document.documentElement;

	/// The element currently filling the screen, across vendor prefixes.
	function fsElement() {
		return document.fullscreenElement
			|| document.webkitFullscreenElement
			|| document.mozFullScreenElement
			|| document.msFullscreenElement
			|| null;
	}

	/// Does this browser offer the Fullscreen API at all?
	function canFull() {
		return !!(docEl.requestFullscreen || docEl.webkitRequestFullscreen
			|| docEl.mozRequestFullScreen || docEl.msRequestFullscreen);
	}

	function enter() {
		var fn = docEl.requestFullscreen || docEl.webkitRequestFullscreen
			|| docEl.mozRequestFullScreen || docEl.msRequestFullscreen;
		if (fn) try { fn.call(docEl); } catch (e) { /* denied, or no user gesture */ }
	}

	function leave() {
		var fn = document.exitFullscreen || document.webkitExitFullscreen
			|| document.mozCancelFullScreen || document.msExitFullscreen;
		if (fn) try { fn.call(document); } catch (e) { /* already out */ }
	}

	/// A translated string, or the English fallback if the key is absent.
	function t(key, fallback) {
		return (window.DaimondI18n && DaimondI18n.has && DaimondI18n.has(key))
			? DaimondI18n.t(key) : fallback;
	}

	/// Phone only, decided by the app's own signal rather than a width read of
	/// our own -- one 760 cliff, shared with the rail and the sheet.
	function isPhone() {
		return !!(window.DaimondShell && DaimondShell.isPhone && DaimondShell.isPhone());
	}

	var btn = null;

	/// Show or hide the control for the width, and say which state it is in.
	function sync() {
		if (!btn) return;
		// No API, or not the phone layout: the control has no business on screen.
		if (!canFull() || !isPhone()) { btn.style.display = 'none'; return; }
		btn.style.display = '';
		var on = !!fsElement();
		// The label names the destination while the mode is on: "Exit full
		// screen", not "Full screen (on)".
		var label = on ? t('fullscreen.exit', 'Exit full screen')
		               : t('fullscreen.enter', 'Full screen');
		btn.classList.toggle('on', on);
		btn.setAttribute('aria-pressed', on ? 'true' : 'false');
		btn.setAttribute('aria-label', label);
		btn.title = label;
	}

	function init() {
		btn = document.getElementById('fullscreen-btn');
		if (!btn) return;
		// A browser without the API never sees the button.
		if (!canFull()) { btn.style.display = 'none'; return; }

		btn.addEventListener('click', function () {
			if (fsElement()) leave(); else enter();
		});

		// Keep the face true even when the user leaves by the system back
		// gesture, which fires a change event but never a click.
		['fullscreenchange', 'webkitfullscreenchange',
		 'mozfullscreenchange', 'MSFullscreenChange'].forEach(function (ev) {
			document.addEventListener(ev, sync);
		});

		// The 760 cliff, watched the same way the shell watches it.
		var mq = window.matchMedia('(max-width: 760px)');
		if (mq.addEventListener) mq.addEventListener('change', sync);
		else if (mq.addListener) mq.addListener(sync);

		// Re-label on a language change.
		if (window.DaimondI18n && DaimondI18n.onChange) DaimondI18n.onChange(sync);

		sync();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
