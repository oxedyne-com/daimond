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

	/// The rasteriser, kept as ONE function whose only free names are the page's own globals
	/// (`document`, `getComputedStyle`, `Image`, `XMLSerializer`, `setTimeout`). That is on
	/// purpose: `crystal.js` hands its SOURCE to a Diamond's sandboxed page, which runs it
	/// against ITS OWN DOM, so one rasteriser serves both the app and the frame and the two
	/// cannot drift. Nothing here may close over anything outside this function.
	function rasteriser() {
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
		/// worker handed a transparent PNG reads the compositor's black, not the app. `dflt` is
		/// what is behind the document itself when nothing in it is opaque: a Diamond's page is
		/// transparent over the app, and white under its light theme text drew a blank strip.
		function backdrop(el, asked, dflt) {
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
			return dflt || '#ffffff';
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

		/// The children a node DRAWS, which are not always its DOM children. A shadow host draws its
		/// shadow tree and not its light children (the Typst preview's pages are an `<svg>` in one,
		/// `www/js/typstwatch.js`), and `cloneNode` copies no shadow root, so a capture of the
		/// preview came back as an empty box. A `<slot>` draws what is assigned to it, else its own
		/// fallback.
		function kidsOf(s) {
			if (s.shadowRoot) return s.shadowRoot.childNodes || [];
			if (s.tagName === 'SLOT' && typeof s.assignedNodes === 'function') {
				var a = s.assignedNodes({ flatten: true });
				if (a && a.length) return a;
			}
			return s.childNodes || [];
		}

		/// How many elements `el` draws, shadow trees included: the node gate's count.
		function drawnCount(el) {
			var n = 0;
			(function walk(s) {
				var k = kidsOf(s);
				for (var i = 0; i < k.length; i++) {
					if (k[i].nodeType !== 1) continue;
					n++;
					walk(k[i]);
				}
			})(el);
			return n;
		}

		/// A drawn node's copy that the SVG image can draw itself, or null when it draws nothing.
		/// An `<img>` is loaded inside the SVG image, which fetches nothing, so its pixels are put
		/// in as a data URL; a `<canvas>` becomes an `<img>` of its pixels; a form control's value
		/// is pinned as an attribute. A `<style>` from a shadow tree is dropped, since its rules
		/// are scoped to that tree and the computed style is inlined already.
		function copyOf(s, d, shadow) {
			if (s.tagName === 'CANVAS') {
				try {
					var img = document.createElement('img');
					img.setAttribute('src', s.toDataURL('image/png'));
					img.setAttribute('style', d.getAttribute('style') || '');
					return img;
				} catch (e) { return d; }	// a tainted canvas stays a blank box; the shot goes on
			}
			if (s.tagName === 'IMG' && s.complete && s.naturalWidth > 0
				&& !/^data:/.test(String(s.currentSrc || s.src || ''))) {
				try {
					var c = document.createElement('canvas');
					c.width = s.naturalWidth;
					c.height = s.naturalHeight;
					c.getContext('2d').drawImage(s, 0, 0);
					d.setAttribute('src', c.toDataURL('image/png'));
					d.removeAttribute('srcset');
				} catch (e) { /* cross-origin: left as it is, and it draws nothing */ }
				return d;
			}
			if (s.tagName === 'INPUT') {
				if (s.type === 'checkbox' || s.type === 'radio') {
					if (s.checked) d.setAttribute('checked', 'checked');
				} else if (s.value != null) {
					d.setAttribute('value', s.value);
				}
				return d;
			}
			if (s.tagName === 'TEXTAREA') { d.textContent = s.value; return d; }
			return null;
		}

		/// Is `s` one of the elements the picture must draw empty: another conversation's rail
		/// row or file panel (CAPTURE-FENCE QA A F2)? `blank` is the caller's list, or none.
		function blanked(s, el, blank) {
			return s !== el && !!blank && blank.indexOf(s) >= 0;
		}

		/// `s` as its own box and nothing inside it: styled, sized as it lays out, and empty.
		function emptied(s, d) {
			var r = s.getBoundingClientRect();
			inlineStyle(s, d);
			d.style.setProperty('box-sizing', 'border-box');
			d.style.setProperty('width', r.width + 'px');
			d.style.setProperty('height', r.height + 'px');
			return d;
		}

		/// Clone `el` and inline the computed style of it and every node it draws, shadow trees
		/// included (`kidsOf`). An element in `blank` keeps its box and loses its contents.
		function cloneStyled(el, blank) {
			function walk(s, shadow) {
				if (s.nodeType === 3) return s.cloneNode(false);
				if (s.nodeType !== 1 || DROP[s.tagName] || (shadow && s.tagName === 'STYLE')) return null;
				var d = s.cloneNode(false);
				if (blanked(s, el, blank)) return emptied(s, d);
				inlineStyle(s, d);
				var leaf = copyOf(s, d, shadow);
				if (leaf) return leaf;
				var k = kidsOf(s), inner = shadow || !!s.shadowRoot;
				for (var i = 0; i < k.length; i++) {
					var c = walk(k[i], inner);
					if (c) d.appendChild(c);
				}
				return d;
			}
			return walk(el, false);
		}

		/// The viewport's worth of `el` (D-20261006-14, the Lens's picture of a device): only what
		/// intersects the window is cloned and styled, so a chat of any length costs what is on
		/// screen. A node wholly outside the window keeps its own box, emptied and sized, so what
		/// is visible lays out as it does live; a scrolled container's children are translated by
		/// its scroll, since the clone starts unscrolled; a frame becomes a labelled box, because
		/// a frame cannot be drawn from outside it (its picture, when it sends one, goes on top).
		function cloneView(el, opts) {
			var box = opts.clip || { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
			var seen = 0;
			var label = typeof opts.frame_label === 'string' ? opts.frame_label : '';
			function off(r) { return r.bottom <= box.top || r.right <= box.left || r.top >= box.bottom || r.left >= box.right; }
			function walk(s, shadow) {
				if (s.nodeType === 3) return s.cloneNode(false);
				if (s.nodeType !== 1 || DROP[s.tagName] || (shadow && s.tagName === 'STYLE')) return null;
				var r = s.getBoundingClientRect();
				var d = s.cloneNode(false);
				var cs = getComputedStyle(s);
				if (cs.display === 'none') { d.setAttribute('style', 'display:none'); return d; }
				if (s !== el && off(r)) return emptied(s, d);
				if (blanked(s, el, opts.blank)) return emptied(s, d);
				if (++seen > MAX_NODES) {
					throw new Error('the view holds more than ' + MAX_NODES + ' elements on screen');
				}
				inlineStyle(s, d);
				if (s.tagName === 'IFRAME') {
					var box = document.createElement('div');
					box.setAttribute('style', d.getAttribute('style') || '');
					box.style.setProperty('box-sizing', 'border-box');
					box.style.setProperty('width', r.width + 'px');
					box.style.setProperty('height', r.height + 'px');
					box.style.setProperty('display', 'flex');
					box.style.setProperty('align-items', 'center');
					box.style.setProperty('justify-content', 'center');
					box.style.setProperty('border', '1px dashed #888');
					box.style.setProperty('color', '#888');
					box.textContent = label;
					return box;
				}
				var leaf = copyOf(s, d, shadow);
				if (leaf) return leaf;
				var sx = s === el ? 0 : s.scrollLeft, sy = s === el ? 0 : s.scrollTop;
				var kids = kidsOf(s), inner = shadow || !!s.shadowRoot;
				for (var j = 0; j < kids.length; j++) {
					var k = walk(kids[j], inner);
					if (!k) continue;
					if ((sx || sy) && k.nodeType === 1) {
						k.style.setProperty('transform',
							'translate(' + (-sx) + 'px,' + (-sy) + 'px) ' + (k.style.transform || ''));
					}
					d.appendChild(k);
				}
				return d;
			}
			var clone = walk(el, false);
			var at = el.getBoundingClientRect();
			// The root's own place in the box: a scrolled page puts its top above zero.
			clone.style.setProperty('transform', 'translate(' + ((at.left || 0) - box.left) + 'px,'
				+ ((at.top || 0) - box.top) + 'px)');
			clone.style.setProperty('transform-origin', '0 0');
			return clone;
		}

		/// Draw `el` to a PNG and answer `{ dataUrl, b64, w, h, bytes }`.
		///
		/// `opts`: `max_w` caps the output width (default TARGET_MAX_W, scaling the whole
		/// picture down to fit); `background` paints behind a see-through view; `scale`
		/// forces a device-pixel ratio instead of the fitted one; `viewport` draws only the window's
		/// worth of `el` at the window's size (`cloneView`), labelling a frame `frame_label`, or
		/// only what falls in `clip` (`{ left, top, right, bottom }`, window pixels) at its size;
		/// every element in `blank` is drawn as its empty box.
		function rasterise(el, opts) {
			opts = opts || {};
			var vp = opts.viewport === true;
			var rect = el.getBoundingClientRect();
			var clip = opts.clip;
			var w = Math.max(1, Math.ceil(clip ? clip.right - clip.left : vp ? window.innerWidth : rect.width));
			var h = Math.max(1, Math.ceil(clip ? clip.bottom - clip.top : vp ? window.innerHeight : rect.height));
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
			var bg = backdrop(el, opts.background, opts.fallback);

			var clone = vp ? cloneView(el, opts) : cloneStyled(el, opts.blank);
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
		return { rasterise: rasterise, MAX_NODES: MAX_NODES, drawnCount: drawnCount, backdrop: backdrop };
	}

	var R = rasteriser();
	var MAX_NODES = R.MAX_NODES;
	var rasterise = R.rasterise;

	/// Can a Diamond's page be rendered for the daimon? Asked of `crystal.js`, which owns the frames.
	function crystalDriver() {
		var c = window.DaimondCrystal;
		return !!(c && typeof c.render === 'function');
	}

	/// Is `el` drawn in the window now: displayed, visible, and with some of its box on screen?
	function shown(el) {
		if (!el || !el.getBoundingClientRect) return false;
		var cs = getComputedStyle(el);
		if (cs.display === 'none' || cs.visibility === 'hidden') return false;
		return !!clipOf(el);
	}

	/// The part of `el`'s box inside the window, in window pixels, or null when none is.
	function clipOf(el) {
		var r = el.getBoundingClientRect();
		var l = r.left || 0, t = r.top || 0;
		var c = {
			left:   Math.max(0, l),
			top:    Math.max(0, t),
			right:  Math.min(window.innerWidth, r.right != null ? r.right : l + r.width),
			bottom: Math.min(window.innerHeight, r.bottom != null ? r.bottom : t + r.height),
		};
		return c.right - c.left >= 1 && c.bottom - c.top >= 1 ? c : null;
	}

	var VIEW_NAME = /^[a-z][a-z0-9_-]*$/;

	/// The views `in` can name right now, in the order the daimon should read them: the panels on
	/// screen by their `data-panel` names (the Typst preview is `preview`, a file is `doc`), then
	/// `screen` (the window as drawn) and `crystal` (a Diamond's page, drawn afresh).
	function viewsNow() {
		var out = [];
		var ps = document.querySelectorAll ? document.querySelectorAll('.panel[data-panel]') : [];
		for (var i = 0; i < ps.length; i++) {
			var n = ps[i].getAttribute('data-panel');
			if (n && VIEW_NAME.test(n) && out.indexOf(n) < 0 && shown(ps[i])) out.push(n);
		}
		out.push('screen');
		if (crystalDriver()) out.push('crystal');
		return out;
	}

	/// The sentence every refusal ends with, so the daimon's next call can name a real view.
	function viewsLine() {
		return ' Views on screen now: ' + viewsNow().join(', ')
			+ '. Call capture with in:"<view>" (and a selector inside it if you need less).';
	}

	/// A panel named by `in`, when it is on screen, else null.
	function viewEl(name) {
		if (!VIEW_NAME.test(name)) return null;
		var el = document.querySelector('.panel[data-panel="' + name + '"]');
		return el && shown(el) ? el : null;
	}

	/// Resolve the request's selector to one element, or throw in the daimon's language.
	///
	/// A selector that matches nothing is very often a selector for the Diamond's page, which
	/// is not in this document at all: it runs in a sandboxed iframe with an opaque origin, so
	/// no query here can reach it. The refusal says so, and names the views that can be drawn.
	function target(sel) {
		if (!sel || !String(sel).trim()) return document.body;
		var el = document.querySelector(String(sel));
		if (!el) {
			throw new Error(
				"Nothing on the page matches the selector '" + sel + "'. Selectors are the app's own DOM, "
				+ 'which you need not know: name a view instead.' + viewsLine()
				+ (crystalDriver()
					? ' A Diamond\'s page lives in a sandboxed frame no selector here can reach: in:"crystal" '
						+ 'draws it afresh and measures it.'
					: ''));
		}
		return el;
	}

	/// `in:<view>`: a panel on screen (or `screen`, the whole window) drawn as it is now, only
	/// what is inside the window, at its size on screen. A selector narrows it to one element
	/// inside the panel.
	function captureView(req, name, blank) {
		var root = name === 'screen' ? document.body : viewEl(name);
		if (!root) {
			return Promise.reject(new Error('No view called ' + JSON.stringify(name) + ' is on screen.' + viewsLine()));
		}
		var el = root;
		if (req.selector != null && String(req.selector).trim()) {
			el = root.querySelector(String(req.selector));
			if (!el) {
				return Promise.reject(new Error("Nothing in the " + name + " view matches the selector '"
					+ req.selector + "'. Leave the selector out to capture the whole view." + viewsLine()));
			}
		}
		if (theirs(el, blank)) return Promise.reject(new Error(THEIRS + viewsLine()));
		var clip = name === 'screen' && el === root ? null : clipOf(el);
		if (name !== 'screen' && !clip) {
			return Promise.reject(new Error('That part of the ' + name + ' view is scrolled out of sight.' + viewsLine()));
		}
		var shot;
		try {
			shot = rasterise(el, { viewport: true, clip: clip, max_w: req.max_w, background: req.background,
				scale: req.scale, frame_label: 'a Diamond page: capture in:"crystal"', blank: blank });
		} catch (e) {
			var m = String((e && e.message) || e);
			if (/elements on screen/.test(m)) {
				m = 'The ' + name + ' view holds more than ' + MAX_NODES + ' elements on screen, too many to '
					+ 'draw without freezing the app. Name a selector inside it.' + viewsLine();
			}
			return Promise.reject(new Error(m));
		}
		return shot.then(envelope);
	}

	/// Why the screen may not be drawn for `owner`, or '' where it may (FIRE-B QA F1, 2026-10-12).
	///
	/// Everything but `crystal` draws what is on screen NOW, and a turn runs on whatever the person
	/// has opened since it started: a daimon's capture taken after its user moved to another
	/// Diamond photographed that one into its own folder. So the screen is drawn for a turn only
	/// while its own place is on it and the app is visible -- the rule a question's paint keeps,
	/// asked of `window.DaimondScreen` in daimond.js rather than copied. `owner` is the turn's
	/// keeper; none is the person's own door (a dev probe), which may draw what it likes.
	///
	/// And each VIEW has an owner, not only the centre (CAPTURE-FENCE QA A F1, 2026-10-12): `view`
	/// is the panel `in` names, which `unseen` refuses when it shows another conversation's file.
	function fence(owner, view) {
		if (owner == null || owner === '') return '';
		var s = window.DaimondScreen;
		var why = s ? s.unseen(String(owner), view || '') : 'this page cannot tell what is on screen';
		if (!why) return '';
		return 'Nothing was photographed: ' + why + ', and capture draws the screen only while your own '
			+ 'conversation is on it.'
			+ (String(owner).indexOf('chat:') === 0 ? ''
				: ' in:"crystal" draws your Diamond\'s page off screen at any time.');
	}

	/// What on the page draws a conversation other than `owner`'s: its rail rows, and a file
	/// panel opened in it (CAPTURE-FENCE QA A F2). A picture of the screen or the rail draws
	/// each as its empty box. None for the person's own door, which may draw what it likes.
	function foreignTo(owner) {
		if (owner == null || owner === '') return [];
		var s = window.DaimondScreen;
		return s && typeof s.foreign === 'function' ? s.foreign(String(owner)) : [];
	}

	/// Is `el` inside, or itself, something `blank` names? A selector there would photograph
	/// another conversation's pixels whole, so it is refused rather than drawn empty.
	function theirs(el, blank) {
		for (var i = 0; i < blank.length; i++) if (blank[i] === el || blank[i].contains(el)) return true;
		return false;
	}

	var THEIRS = 'Nothing was photographed: that part of the screen shows another conversation, and capture '
		+ 'draws only your own.';

	function envelope(result) {
		return JSON.stringify({ ok: true, png_b64: result.b64, w: result.w, h: result.h, bytes: result.bytes });
	}

	/// `in:"crystal"`: draw the Diamond's own page afresh in a hidden sandboxed frame, at one
	/// width, and measure it and photograph it from inside, through `crystal.js`. The caller
	/// (src/tools.rs) reads the stored page and `crystal.json` and sends them as `page` and
	/// `data`, so this works whether or not the page is on screen and on a page just edited.
	/// The table and the picture come together unless the request says `"png": false`.
	///
	/// Request : { "in": "crystal", "page": text, "data": text, "id": the Diamond, "width"?: int, "selector"?: CSS,
	///             "max_w"?: int, "background"?: CSS colour, "png"?: false for the table alone,
	///             "look"?: [selector or "text:words"] for crystal_look's measured targets }
	/// Answer  : { "ok": true, "table": text, "png_b64"?: ..., "w"?: int, "h"?: int, "bytes"?: int }
	function renderCrystal(req) {
		if (!crystalDriver()) {
			return Promise.reject(new Error(
				'This build cannot draw a Diamond page from here: the crystal driver is not loaded.'));
		}
		var maxW = Number(req.max_w);
		return window.DaimondCrystal.render({
			page:       req.page == null ? '' : String(req.page),
			data:       req.data == null ? '' : String(req.data),
			id:         req.id == null ? '' : String(req.id),
			width:      Number(req.width) || 0,
			sel:        req.selector == null ? '' : String(req.selector),
			max_w:      maxW > 0 ? maxW : 0,
			background: req.background == null ? '' : String(req.background),
			png:        req.png !== false,
			// crystal_look: the targets to measure, each a selector or `text:` and its words.
			look:       Array.isArray(req.look) ? req.look : [],
			// The load proof (K1): the verdict and the debug count come back beside the table.
			proof:        req.proof === true,
			graphics_min: Number(req.graphics_min) || 0,
		}).then(function (r) {
			var out = { ok: true, table: String(r.table) };
			if (typeof r.proof === 'string' && r.proof) { out.proof = r.proof; out.debug = Number(r.debug) || 0; }
			if (typeof r.trace === 'string' && r.trace) out.trace = r.trace;
			if (r.png_b64) {
				out.png_b64 = r.png_b64;
				out.w       = r.w;
				out.h       = r.h;
				out.bytes   = Math.floor(r.png_b64.length * 3 / 4);
			}
			return JSON.stringify(out);
		});
	}

	/// The whole surface to the wasm edge: hand it a JSON request, get a JSON string back.
	///
	/// Request : { "selector"?: CSS, "max_w"?: int, "background"?: CSS colour, "scale"?: number,
	///             "in"?: "crystal" (then see `renderCrystal`), "screen" or a view (`captureView`) }
	/// Answer  : { "ok": true, "png_b64": ..., "w": int, "h": int, "bytes": int }
	/// A refusal rejects the promise with an Error whose message src/wasm/shot.rs surfaces
	/// verbatim, exactly as DaimondAsk and DaimondDoc do.
	function capture(reqJson) {
		var req;
		try { req = JSON.parse(String(reqJson || '{}')); } catch (e) { req = {}; }
		if (req.in === 'crystal') return renderCrystal(req);
		var name = req.in != null && req.in !== '' && req.in !== 'app' ? String(req.in).trim().toLowerCase() : '';
		var unseen = fence(req.for, name);
		if (unseen) return Promise.reject(new Error(unseen));
		var blank = foreignTo(req.for);
		if (name) {
			try { return captureView(req, name, blank); }
			catch (e) { return Promise.reject(e); }
		}
		var el;
		try { el = target(req.selector); }
		catch (e) { return Promise.reject(e); }
		if (theirs(el, blank)) return Promise.reject(new Error(THEIRS + viewsLine()));

		// Node gate -- counted BEFORE any clone or style work, so a huge subtree (the
		// whole page via a blank selector, the transcript, the chat pane) is refused
		// instantly rather than discovered by freezing on the O(nodes x style-props)
		// walk inside `rasterise`. This is the fix for the live freeze: a throw from
		// deep in `rasterise` used to escape as an uncaught exception and trap the wasm
		// instance (src/wasm/shot.rs calls `capture` with no catch); a subtree this
		// size never reaches that code path at all.
		var n = R.drawnCount(el);
		if (n > MAX_NODES) {
			return Promise.reject(new Error(
				(el === document.body ? 'That is the whole page -- ' : 'That selector -- ')
				+ n + ' elements -- is above the ' + MAX_NODES + ' the self-capture rasteriser '
				+ 'can style and serialise without freezing the app. Name a view, which draws only '
				+ 'what is on screen, or the smallest selector that shows the change.' + viewsLine()));
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
				blank:      blank,
			});
		} catch (e) {
			return Promise.reject(e);
		}
		return shot.then(envelope);
	}

	window.DaimondShot = {
		capture:   capture,
		views:     viewsNow,
		backdrop:  R.backdrop,	// what is behind an element as drawn: a crystal capture's fallback	// the names `in` takes now, for the tool's refusals and the Lens
		rasterise: rasterise,	// exported for www/js tests and dev probes
		// The rasteriser's own source, which `crystal.js` runs inside a Diamond's page.
		rasteriserSource: rasteriser.toString(),
	};
})();
