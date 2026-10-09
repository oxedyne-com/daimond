/*
 * lensshot.js -- the Lens's picture of this device's screen (D-20261006-14).
 *
 * The owner, debugging from his desk, runs `node dev/lens.mjs shot --device <d>` and gets a
 * picture of what that device shows. Only on his own devices, only on one where he turned
 * "Allow Lens screenshots on this device" on in Settings (off by default, kept per device, never
 * synced), with a toast every time, and at most one a minute. The gateway (`/api/lens-shot`) keeps
 * the pictures seven days.
 *
 * While the setting is on and the page is visible, the device asks the gateway every 5 s whether
 * a picture is wanted. When one is, it shows the toast, draws the window with the app's own
 * rasteriser in viewport mode (`selfshot.js`), lays the visible Diamond page's own picture over
 * its frame (`DaimondCrystal.shotFrames`, which the frame draws itself), and posts the PNG under
 * the ask's id. Anything that stops it is posted as a refusal, so the Lens says why rather than
 * waiting out its timeout. A 403 means this account is not the owner, and the polling stops.
 */
(function () {
	'use strict';

	var KEY		= 'daimond-lensshot';	// '1' on this device only
	var ENDPOINT	= '/api/lens-shot';
	var POLL_MS	= 5000;
	var FLOOR_MS	= 60000;		// the gateway's floor, kept here too so a slip costs nothing
	var CLIENT_API	= 2;			// matches CLIENT_API in gateway.js / debugshare.js

	var notify = null, label = '', timer = null, busy = false, barred = false, lastAt = 0;

	function enabled() {
		try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
	}

	function setEnabled(on) {
		try {
			if (on) localStorage.setItem(KEY, '1');
			else localStorage.removeItem(KEY);
		} catch (e) { /* a private window keeps it for the page only */ }
		barred = false;
		schedule();
	}

	function deviceId() {
		try { return (window.DaimondIdentity && DaimondIdentity.deviceId && DaimondIdentity.deviceId()) || ''; }
		catch (e) { return ''; }
	}

	function url(dev, extra) {
		return ENDPOINT + '?device=' + encodeURIComponent(dev) + (extra || '');
	}

	function call(method, u, body) {
		var o = {
			method:      method,
			credentials: 'same-origin',
			headers:     { 'x-daimond-api': String(CLIENT_API) },
		};
		if (body) {
			o.headers['content-type'] = 'image/png';
			o.body = body;
		}
		return fetch(u, o);
	}

	function refuse(dev, rid, why) {
		return call('POST', url(dev, '&rid=' + encodeURIComponent(rid) + '&refused=' + encodeURIComponent(why)))
			.catch(function () { /* the Lens times out and says so */ });
	}

	function loadImage(src) {
		return new Promise(function (resolve, reject) {
			var img = new Image();
			img.onload = function () { resolve(img); };
			img.onerror = function () { reject(new Error('a picture would not decode')); };
			img.src = src;
		});
	}

	/// The window as a PNG blob: the app drawn in viewport mode, each visible Diamond page's own
	/// picture laid over its frame's box.
	function capture() {
		var S = window.DaimondShot;
		if (!S || typeof S.rasterise !== 'function') return Promise.reject(new Error('no rasteriser'));
		var C = window.DaimondCrystal;
		var frames = C && typeof C.shotFrames === 'function' ? C.shotFrames() : Promise.resolve([]);
		var main = S.rasterise(document.body, { viewport: true, frame_label: label });
		return Promise.all([main, frames]).then(function (got) {
			var m = got[0], fs = got[1] || [];
			return loadImage(m.dataUrl).then(function (base) {
				var cv = document.createElement('canvas');
				cv.width = m.w;
				cv.height = m.h;
				var g = cv.getContext('2d');
				g.drawImage(base, 0, 0);
				var k = m.w / Math.max(1, window.innerWidth);
				var laid = fs.filter(function (f) { return f && f.png_b64; }).map(function (f) {
					return loadImage('data:image/png;base64,' + f.png_b64).then(function (im) {
						g.drawImage(im, f.rect.x * k, f.rect.y * k, f.rect.w * k, f.rect.h * k);
					}, function () { /* the labelled box stays */ });
				});
				return Promise.all(laid).then(function () {
					return new Promise(function (resolve, reject) {
						cv.toBlob(function (b) {
							if (b) resolve(b); else reject(new Error('the canvas gave no picture'));
						}, 'image/png');
					});
				});
			});
		});
	}

	function take(dev, rid) {
		var now = Date.now();
		if (now - lastAt < FLOOR_MS) {
			return refuse(dev, rid, 'rate: the next picture may be taken in '
				+ Math.ceil((FLOOR_MS - (now - lastAt)) / 1000) + ' s');
		}
		lastAt = now;
		// Said before the picture is taken, every time: the owner is never pictured unawares.
		try { if (notify) notify(); } catch (e) { /* the toast is not the picture */ }
		return capture().then(function (blob) {
			return call('POST', url(dev, '&rid=' + encodeURIComponent(rid)), blob).then(function (r) {
				if (r && r.status === 413) return refuse(dev, rid, 'the picture was too large');
			});
		}, function (err) {
			return refuse(dev, rid, 'error: ' + String(err && err.message || err).slice(0, 160));
		});
	}

	function poll() {
		timer = null;
		if (!enabled() || barred) return;
		var dev = deviceId();
		if (busy || document.hidden || !dev) { schedule(); return; }
		busy = true;
		call('GET', url(dev)).then(function (r) {
			if (!r) return null;
			if (r.status === 403) { barred = true; return null; }
			if (!r.ok) return null;
			return r.json().then(function (j) {
				var rid = j && typeof j.want === 'string' ? j.want : '';
				return rid ? take(dev, rid) : null;
			});
		}).catch(function () { /* offline: the next poll asks again */ }).then(function () {
			busy = false;
			schedule();
		});
	}

	function schedule() {
		if (timer || !enabled() || barred) return;
		timer = setTimeout(poll, POLL_MS);
	}

	/// `notify` is the app's toast, said before each picture; `frameLabel` is written in a Diamond
	/// page's box when the page cannot draw itself.
	function wire(o) {
		o = o || {};
		if (typeof o.notify === 'function') notify = o.notify;
		if (typeof o.frameLabel === 'string') label = o.frameLabel;
		schedule();
	}

	document.addEventListener('visibilitychange', function () { if (!document.hidden) schedule(); });

	window.DaimondLensShot = {
		wire:       wire,
		enabled:    enabled,
		setEnabled: setEnabled,
		capture:    capture,	// for www/js tests and dev probes
	};
})();
