/* syncicon.js -- the sync icon in the top bar, beside the debug lens.
 *
 * It exists because the rail's sync line sits in a section a phone keeps shut, so
 * on a phone nothing said "my work is travelling" unless the rail was open. This
 * is that line's one-glance form: circular arrows that pulse green while a sync is
 * in flight and rest quietly the rest of the time.
 *
 * ONE SOURCE OF TRUTH. js/sync.js paints the rail's sync line and, in the same
 * call, hands this the state word and the line's own words. The hover text is
 * those words, never a second derivation, so the two cannot disagree.
 *
 * INERT. It is a picture with a name, not a button: no press does anything. On a
 * touch screen, which has no hover for the tooltip, a tap (or a long press) shows
 * the same words in a small label under the icon for a few seconds, and nothing else.
 *
 * THE PULSE HAS A MINIMUM ON-TIME. The rail's line has no debounce -- it says
 * "Syncing..." from the first byte and holds "Synced" for under two seconds -- and
 * a round that finishes in 40ms would otherwise flash the icon for 40ms. Once on,
 * the pulse stays at least one whole cycle (`MIN_ON_MS`, the lens's 1.6s), so a
 * short round shows one clean beat and never a flicker. A long round pulses for as
 * long as it runs.
 */
(function () {
	'use strict';

	var MIN_ON_MS = 1600;		// one full cycle of `pulse-ring` (css/app.css)
	var TIP_MS    = 3200;		// how long a tap's label stays

	var el = null, onSince = 0, offTimer = null;
	var tip = null, tipTimer = null, words = '';

	function node() {
		if (!el || !el.isConnected) el = document.getElementById('sync-ico');
		return el;
	}

	/// Turn the pulse on, or off once it has had its minimum.
	function pulse(want) {
		var n = node();
		if (!n) return;
		if (want) {
			if (offTimer) { clearTimeout(offTimer); offTimer = null; }
			if (!n.classList.contains('on')) { n.classList.add('on'); onSince = Date.now(); }
			return;
		}
		if (!n.classList.contains('on') || offTimer) return;
		// Clamped: a wall clock stepped back mid-pulse makes the elapsed time negative, and must not stretch the pulse past its minimum.
		var left = Math.min(MIN_ON_MS, MIN_ON_MS - (Date.now() - onSince));
		if (left <= 0) { n.classList.remove('on'); return; }
		offTimer = setTimeout(function () { offTimer = null; n.classList.remove('on'); }, left);
	}

	/// Set the words (hover, accessible name, tap label) and the pulse.
	///
	/// `state` is the chip's word ('syncing', 'synced', 'stalled', 'off', 'partial')
	/// or '' at rest; `line` is what the rail's sync line says; `detail` is the chip's
	/// own hover, which carries the reason for a standing refusal.
	function paint(state, line, detail) {
		var n = node();
		if (!n) return;
		var standing = state === 'stalled' || state === 'off' || state === 'partial';
		words = (standing && detail) ? line + '\n' + detail : String(line || '');
		n.title = words;
		n.setAttribute('aria-label', words);
		n.dataset.state = state || '';
		if (tip) tip.textContent = words;
		pulse(state === 'syncing');
	}

	function hideTip() {
		if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
		if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
		tip = null;
		document.removeEventListener('pointerdown', hideTip, true);
	}

	/// The tap's label, under the icon and kept inside the screen.
	function showTip() {
		var n = node();
		if (!n || !words) return;
		hideTip();
		tip = document.createElement('div');
		tip.className = 'sync-tip';
		tip.id = 'sync-tip';
		tip.setAttribute('aria-hidden', 'true');		// the icon's own name already says it
		tip.textContent = words;
		document.body.appendChild(tip);
		var r = n.getBoundingClientRect(), w = tip.offsetWidth;
		var left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
		tip.style.left = Math.max(8, left) + 'px';
		tip.style.top  = Math.round(r.bottom + 8) + 'px';
		tipTimer = setTimeout(hideTip, TIP_MS);
		document.addEventListener('pointerdown', hideTip, true);
	}

	function wire() {
		var n = node();
		if (!n || n.dataset.wired) return;
		n.dataset.wired = '1';
		n.addEventListener('pointerup', function (ev) {
			if (ev.pointerType && ev.pointerType !== 'mouse') showTip();
		});
		// A long press on Android raises the context menu; it shows the label instead.
		n.addEventListener('contextmenu', function (ev) { ev.preventDefault(); showTip(); });
	}
	if (typeof document !== 'undefined') {
		if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
		else wire();
	}

	window.DaimondSyncIcon = { paint: paint, pulsing: function () { var n = node(); return !!(n && n.classList.contains('on')); } };
})();
