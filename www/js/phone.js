/* ============================================================
   Daimond — when the phone layout turns on or off
   ------------------------------------------------------------
   Every surface that moves when the page crosses into or out of the phone
   layout (the rail into the home page, the settings body, the chip row,
   the folds) hears it here, not from the query's own 'change'.

   WebKit can settle a woken tab's true viewport without firing that
   'change': his iPhone, upright, measured 852x393 at a typed unlock
   (9 Nov), then its real width, and the rail stayed in its desktop seat
   with the phone stylesheet on it, full width and deaf to a swipe. So
   every event that can move the viewport asks the query again, and a
   watcher is told once per real flip, whichever event carried it.
   ============================================================ */
(function () {
	'use strict';

	var mq = window.matchMedia('(max-width: 760px), (pointer: coarse) and (max-height: 500px)');
	var was = mq.matches;
	var fns = [];

	function check() {
		var now = mq.matches;
		if (now === was) return;
		was = now;
		fns.slice().forEach(function (fn) {
			try { fn(now); } catch (e) { console.error('DaimondPhone: a watcher failed', e); }
		});
	}
	// A resize can arrive a frame before the query answers for it, so it asks again after the next frame.
	function soon() {
		check();
		requestAnimationFrame(function () { requestAnimationFrame(check); });
	}

	if (mq.addEventListener) mq.addEventListener('change', check);
	else if (mq.addListener) mq.addListener(check);
	window.addEventListener('resize', soon);
	window.addEventListener('orientationchange', soon);
	window.addEventListener('pageshow', soon);
	document.addEventListener('visibilitychange', function () { if (!document.hidden) soon(); });
	if (window.visualViewport) window.visualViewport.addEventListener('resize', soon);

	window.DaimondPhone = {
		/// Is the page laid out as a phone now?
		is: function () { return mq.matches; },
		/// Call `fn(isPhone)` at each flip of the phone layout.
		watch: function (fn) { fns.push(fn); },
	};
})();
