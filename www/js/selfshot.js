// selfshot.js — photograph Daimond's OWN view, in the page, with no browser to launch.
//
// WHY THIS EXISTS, WHICH IS NOT WHAT IT DOES. A proposal that changes the UI is not
// done until the changed page has been looked at (DAIMOND.md, "UI changes are seen").
// The daimon may have no vision, so it hands a picture to a worker that has -- and the
// only way it had to make that picture was `dev/shot.mjs`, which launches a headless
// Chromium. The daimon's shell and its workers are FENCED: a process that tries to
// launch Chrome aborts (SIGABRT), so the one step the whole vision gate turns on could
// never run. The gate asked a fenced worker to photograph a browser it was forbidden to
// start, and got nothing back every time.
//
// The daimon itself runs IN a browser. So it does not need to start one: it can draw its
// own live DOM to a bitmap in the page it is already in. That is the whole idea here --
// an in-page rasteriser, reached by the `capture` tool through `window.DaimondShot`, the
// same shape as `window.DaimondAsk` and `window.DaimondDoc` (see src/wasm/shot.rs).
//
// HOW, and its one honest limit. The technique is the one html-to-image and dom-to-image
// use: clone the target subtree, inline every computed style onto the clone so it no
// longer depends on a stylesheet, wrap it in an SVG <foreignObject>, load that SVG into
// an Image and draw the Image to a <canvas>, then read the canvas out as PNG. It is pure
// browser API and adds no dependency, which is the house rule for the frontend.
//
//   THE LIMIT: the canvas is drawn from an SVG loaded as an image, and that image renders
//   in an isolated context. Two things do not cross into it. A web font declared with
//   @font-face is not available, so text falls back to a system face -- layout, colour,
//   size and every box are faithful, the glyph shapes may differ. And a CROSS-ORIGIN
//   image or background taints the canvas, and reading it out then throws; same-origin
//   app assets are fine, and the refusal names the cause so the daimon can narrow the
//   selector past the offending element. Neither touches the question the gate asks --
//   "does the change appear, and is anything else obviously broken" -- but both are said
//   out loud rather than discovered in a picture.
//
// The bytes come back base64 in a JSON envelope for src/wasm/shot.rs to decode and write
// to the workspace, exactly as src/wasm/mail.rs carries a message's bytes. The daimon
// then `file_read`s that PNG with "as":"image" and hands it to a vision worker -- the
// existing image-handoff path, unchanged.

(function () {
	'use strict';

	/// The most a captured PNG should weigh, so `file_read` can still show it: its own
	/// limit is 2 MB (src/tools.rs, `image_too_big`). A picture near that is scaled down
	/// rather than refused, because a slightly soft screenshot answers the gate and a
	/// refused one does not.
	var TARGET_MAX_W = 1600;

	/// The most descendants a target subtree may hold before `capture` refuses it. The
	/// rasteriser is O(nodes x style-props) -- one `getComputedStyle` walk of ~350-400
	/// properties per node -- so a subtree above this froze the whole app's main thread
	/// (proven live against `document.body` with the ~700-tile transcript in view). The
	/// count is taken with a single cheap `querySelectorAll('*').length` BEFORE any
	/// cloning or style work starts, so the refusal is instant rather than discovered by
	/// hanging.
	var MAX_NODES = 3000;

	/// The canvas limits a browser enforces (Chromium refuses a dimension over 16384px
	/// or an area over ~64 million pixels and silently hands back `"data:,"`). Rejecting
	/// first, with a message that names the size, beats a mysterious empty image.
	var MAX_CANVAS_H = 16384;
	var MAX_CANVAS_PX = 64e6;

	/// Elements that draw nothing and only bloat -- or break -- the serialised SVG.
	var DROP = { SCRIPT: 1, NOSCRIPT: 1, LINK: 1, TEMPLATE: 1 };

	/// The colour to paint behind a view whose own background is see-through. A vision
	/// worker handed a transparent PNG reads the compositor's black, not the app.
	function backdrop(el, asked) {
		if (asked) return asked;
		var probe = el;
		while (probe) {
			var c = getComputedStyle(probe).backgroundColor;
			if (c && c !== 'transparent' && !/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(c)) {
				return c;
			}
			probe = probe.parentElement;
		}
		var body = getComputedStyle(document.body).backgroundColor;
		if (body && body !== 'transparent'
			&& !/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(body)) {
			return body;
		}
		return '#ffffff';
	}

	/// Copy every computed property from `src` onto `dst`'s inline style, so the clone
	/// renders without the stylesheet it can no longer see.
	function inlineStyle(src, dst) {
		var cs = getComputedStyle(src);
		var out = '';
		for (var i = 0; i < cs.length; i++) {
			var name = cs[i];
			out += name + ':' + cs.getPropertyValue(name) + ';';
		}
		dst.setAttribute('style', out);
	}

	/// Clone `el` and inline the computed style of it and every descendant, walking the
	/// live tree and the clone in lock-step. A `<canvas>` is turned into an `<img>` of
	/// its pixels, because a foreignObject does not carry a canvas's contents; a form
	/// control's current value is pinned as an attribute for the same reason.
	function cloneStyled(el) {
		var clone = el.cloneNode(true);
		var srcAll = [el].concat(Array.prototype.slice.call(el.querySelectorAll('*')));
		var dstAll = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll('*')));
		// Back-to-front, so removing a dropped node never shifts an index we have not
		// reached yet.
		for (var i = srcAll.length - 1; i >= 0; i--) {
			var s = srcAll[i];
			var d = dstAll[i];
			if (!d) continue;
			if (DROP[s.tagName]) { if (d.parentNode) d.parentNode.removeChild(d); continue; }
			inlineStyle(s, d);
			if (s.tagName === 'CANVAS') {
				try {
					var png = s.toDataURL('image/png');
					var img = document.createElement('img');
					img.setAttribute('src', png);
					img.setAttribute('style', d.getAttribute('style') || '');
					if (d.parentNode) d.parentNode.replaceChild(img, d);
				} catch (e) { /* a tainted canvas stays a blank box; the shot goes on */ }
				continue;
			}
			if (s.tagName === 'INPUT') {
				if (s.type === 'checkbox' || s.type === 'radio') {
					if (s.checked) d.setAttribute('checked', 'checked');
				} else if (s.value != null) {
					d.setAttribute('value', s.value);
				}
			} else if (s.tagName === 'TEXTAREA') {
				d.textContent = s.value;
			}
		}
		return clone;
	}

	/// Draw `el` to a PNG and answer `{ dataUrl, b64, w, h, bytes }`.
	///
	/// `opts`: `max_w` caps the output width (default TARGET_MAX_W, scaling the whole
	/// picture down to fit); `background` paints behind a see-through view; `scale`
	/// forces a device-pixel ratio instead of the fitted one.
	function rasterise(el, opts) {
		opts = opts || {};
		var rect = el.getBoundingClientRect();
		var w = Math.max(1, Math.ceil(rect.width));
		var h = Math.max(1, Math.ceil(rect.height));
		var maxW = opts.max_w > 0 ? opts.max_w : TARGET_MAX_W;
		var scale = opts.scale > 0 ? opts.scale : Math.min(1, maxW / w);
		var cw = Math.max(1, Math.round(w * scale));
		var ch = Math.max(1, Math.round(h * scale));
		if (ch > MAX_CANVAS_H || cw * ch > MAX_CANVAS_PX) {
			throw new Error(
				'The capture would draw a ' + cw + 'x' + ch + ' canvas, over the browser\'s '
				+ 'limit (' + MAX_CANVAS_H + 'px tall, or ' + MAX_CANVAS_PX + ' pixels total) '
				+ 'and liable to come back as an empty image. Pass a smaller "max_w", or name '
				+ 'a narrower selector.');
		}
		var bg = backdrop(el, opts.background);

		var clone = cloneStyled(el);
		clone.style.margin = '0';
		clone.style.setProperty('box-sizing', 'border-box');

		var SVG = 'http://www.w3.org/2000/svg';
		var XHTML = 'http://www.w3.org/1999/xhtml';
		var svg = document.createElementNS(SVG, 'svg');
		svg.setAttribute('xmlns', SVG);
		svg.setAttribute('width', String(w));
		svg.setAttribute('height', String(h));
		svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
		var fo = document.createElementNS(SVG, 'foreignObject');
		fo.setAttribute('x', '0');
		fo.setAttribute('y', '0');
		fo.setAttribute('width', String(w));
		fo.setAttribute('height', String(h));
		var holder = document.createElementNS(XHTML, 'div');
		holder.setAttribute('xmlns', XHTML);
		holder.appendChild(clone);
		fo.appendChild(holder);
		svg.appendChild(fo);

		var xml = new XMLSerializer().serializeToString(svg);
		var url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);

		return new Promise(function (resolve, reject) {
			// Watchdog: an SVG that never fires onload or onerror (a decoder wedged on
			// pathological markup) must not hang the turn. Cleared the moment either
			// fires, so the normal path pays nothing.
			var settled = false;
			var watchdog = setTimeout(function () {
				if (settled) return;
				settled = true;
				reject(new Error(
					'The view did not rasterise within 20s and was abandoned. Capture a '
					+ 'smaller selector.'));
			}, 20000);
			function settle(fn) {
				return function (arg) {
					if (settled) return;
					settled = true;
					clearTimeout(watchdog);
					fn(arg);
				};
			}
			var img = new Image();
			img.onload = settle(function () {
				try {
					var canvas = document.createElement('canvas');
					canvas.width = cw;
					canvas.height = ch;
					var g = canvas.getContext('2d');
					g.fillStyle = bg;
					g.fillRect(0, 0, cw, ch);
					g.drawImage(img, 0, 0, cw, ch);
					var dataUrl = canvas.toDataURL('image/png');
					var b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
					resolve({
						dataUrl: dataUrl,
						b64:     b64,
						w:       cw,
						h:       ch,
						bytes:   Math.floor(b64.length * 3 / 4),
					});
				} catch (e) {
					// A SecurityError here is a tainted canvas: a cross-origin image or
					// background in the subtree. Name the cause the daimon can act on.
					reject(new Error(
						'The view could not be read out as a picture: ' + (e && e.message || e)
						+ '. A cross-origin image or background taints the canvas -- capture a '
						+ 'selector that excludes it.'));
				}
			});
			img.onerror = settle(function () {
				reject(new Error(
					'The view could not be rasterised. An embedded resource may be cross-origin, '
					+ 'or the subtree may hold markup the SVG serialiser rejected.'));
			});
			img.src = url;
		});
	}

	/// Resolve the request's selector to one element, or throw in the daimon's language.
	function target(sel) {
		if (!sel || !String(sel).trim()) return document.body;
		var el = document.querySelector(String(sel));
		if (!el) {
			throw new Error(
				"Nothing on the page matches the selector '" + sel + "'. Capture the whole view "
				+ 'by leaving the selector out, or name one that exists.');
		}
		return el;
	}

	/// The whole surface to the wasm edge: hand it a JSON request, get a JSON string back.
	///
	/// Request : { "selector"?: CSS, "max_w"?: int, "background"?: CSS colour, "scale"?: number }
	/// Answer  : { "ok": true, "png_b64": ..., "w": int, "h": int, "bytes": int }
	/// A refusal rejects the promise with an Error whose message src/wasm/shot.rs surfaces
	/// verbatim, exactly as DaimondAsk and DaimondDoc do.
	function capture(reqJson) {
		var req;
		try { req = JSON.parse(String(reqJson || '{}')); } catch (e) { req = {}; }
		var el;
		try { el = target(req.selector); }
		catch (e) { return Promise.reject(e); }

		// Node gate -- counted BEFORE any clone or style work, so a huge subtree (the
		// whole page via a blank selector, the transcript, the chat pane) is refused
		// instantly rather than discovered by freezing on the O(nodes x style-props)
		// walk inside `rasterise`. This is the fix for the live freeze: a throw from
		// deep in `rasterise` used to escape as an uncaught exception and trap the wasm
		// instance (src/wasm/shot.rs calls `capture` with no catch); a subtree this
		// size never reaches that code path at all.
		var n = el.querySelectorAll('*').length;
		if (n > MAX_NODES) {
			return Promise.reject(new Error(
				(el === document.body ? 'That is the whole page -- ' : 'That selector -- ')
				+ n + ' elements -- is above the ' + MAX_NODES + ' the self-capture rasteriser '
				+ 'can style and serialise without freezing the app. Name the smallest selector '
				+ '(an #id or a specific class) that shows the change; never capture the whole '
				+ 'page, the transcript (#chat-output) or the chat pane.'));
		}

		// Throw-to-reject guard -- `rasterise` does real work synchronously before it
		// returns its Promise (getBoundingClientRect, the pixel gate, cloneStyled,
		// XMLSerializer). Any of those throwing must become a rejection, never an
		// uncaught exception, because src/wasm/shot.rs calls this method with no catch
		// and an uncaught JS exception there traps the whole wasm instance.
		var shot;
		try {
			shot = rasterise(el, {
				max_w:      req.max_w,
				background: req.background,
				scale:      req.scale,
			});
		} catch (e) {
			return Promise.reject(e);
		}
		return shot.then(function (result) {
			return JSON.stringify({
				ok:      true,
				png_b64: result.b64,
				w:       result.w,
				h:       result.h,
				bytes:   result.bytes,
			});
		});
	}

	window.DaimondShot = {
		capture:   capture,
		rasterise: rasterise,	// exported for www/js tests and dev probes
	};
})();
