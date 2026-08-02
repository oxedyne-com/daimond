/* terminal.js — the terminal a person actually looks at.
 *
 * `window.DaimondTerminal.create(host, opts)` puts a working terminal inside an
 * element and hands back a handle. It draws bytes and it produces bytes; it
 * knows nothing about the hand, the wire, or who is on the other end. That is
 * deliberate — the same panel has to serve a pty on this machine, a pty over a
 * WebSocket on another, and a recorded stream in a test, and none of those are
 * the renderer's business.
 *
 * ── Canvas, not DOM ─────────────────────────────────────────────────
 *
 * A node per cell is the obvious way and it does not survive the load case. An
 * 80×24 screen is 1,920 cells; a build printing three thousand lines a second
 * rewrites every one of them many times over. Measured by the benchmark in
 * `dev/termdemo.mjs`, which draws the same screenful both ways and times only
 * the drawing (headless Chromium, software rasterisation, dpr 1 — the
 * PESSIMISTIC environment for canvas and a neutral one for the DOM):
 *
 *                                      80×24     200×50
 *     span-per-cell, rebuilt          12.3 ms    67.5 ms      ← 15 fps at 200×50
 *     canvas, full repaint             0.6 ms     2.7 ms
 *     canvas, full repaint, worst      3.9 ms    12.0 ms      ← every cell its own colour
 *     canvas, scroll-blit              1.0 ms     3.0 ms      ← the load case
 *
 * The DOM figures are the whole frame budget spent laying out text nobody asked
 * to be selectable, and they are the OPTIMISTIC ones: no stylesheet of any size
 * to recalculate against, and no account of the memory ten thousand styled spans
 * take. So: canvas, by a factor of twenty-five at the size that matters.
 *
 * Two numbers worth keeping in view. At a device pixel ratio of 2 the worst case
 * — a colour chart, where no two neighbouring cells share a style and every
 * glyph is its own draw — rises to 94 ms in software rasterisation; the fix for
 * that is a glyph atlas, and it is NOT built here, because the case is a colour
 * chart rather than a build log and the typical figure at dpr 2 is 18 ms. And
 * parsing, which is separate from drawing and never on the frame's critical
 * path, runs at about 15 MB/s: five thousand lines of build log in 22 ms.
 *
 * What that costs is what the rest of this file spends its length on. A canvas
 * has no text, so selection, copy and screen-reader access all have to be built
 * rather than inherited. They are, below, and the accessibility section says
 * plainly what it does and does not achieve.
 *
 * ── The screen model, and the seam it sits behind ───────────────────
 *
 * A VT parser over a grid of cells is being built in fe2o3 as well, to run in
 * wasm. This file does NOT depend on it yet — `createScreen` below is a plain
 * JavaScript model of the same shape — but everything that draws or types talks
 * to the model only through the interface written here, so swapping in the
 * wasm-backed one is a change of source and not a rewrite.
 *
 * A screen model must provide:
 *
 *   cols, rows                      the grid, in cells.
 *   write(u8OrString)               feed output. Parses, mutates the grid, moves
 *                                   the cursor, sets modes, records damage.
 *                                   Never draws and never touches the DOM.
 *   resize(cols, rows)              reflow to a new grid.
 *   reset()                         back to a fresh screen.
 *   compose()                       fill the flat cell arrays for the current
 *                                   viewport and return the damage since the
 *                                   last call: { all, rows, scrolled }. Only
 *                                   damaged rows need be filled.
 *   cells                           { ch, attr, fg, bg }, four Uint32Arrays of
 *                                   cols*rows, row-major, filled by compose().
 *                                   With a wasm model these are views onto its
 *                                   memory, so a caller must re-read them after
 *                                   any resize.
 *   ext(y, x)                       the combining marks on one cell, if any, as
 *                                   a string. Rare; kept out of the flat arrays.
 *   cursor                          { x, y, visible, shape } in viewport cells,
 *                                   or y === -1 when the cursor is scrolled off.
 *   modes                           { appCursor, appKeypad, bracketed, alt,
 *                                     mouse, mouseSgr, wrap, reverse }.
 *   scrollback()                    lines held above the live screen.
 *   viewOffset(), setViewOffset(n)  where the window sits in that scrollback.
 *   absTop()                        absolute index of the topmost line the model
 *                                   still holds, so a selection can be anchored
 *                                   somewhere that survives scrolling.
 *   lineText(abs)                   one line as plain text, trailing blanks cut.
 *   lineCells(abs)                  one line's code points, for a column-exact
 *                                   copy. Null when that line is gone.
 *   onBell, onTitle, onReply        callbacks the model raises. `onReply` is the
 *                                   answer to a query the program made (cursor
 *                                   position, device attributes) and MUST be
 *                                   sent back as input, or a program that asks
 *                                   waits for ever.
 *
 * Colour and attributes are packed into integers rather than objects, because
 * an object per cell is a garbage-collector problem at these rates and because
 * integers are what a wasm model would hand over anyway. See `ATTR` and
 * `packColour`.
 *
 * ── The damage model ────────────────────────────────────────────────
 *
 * Repainting the whole grid on every byte is unusable, and it is also the wrong
 * shape: bytes arrive in bursts far faster than a screen refreshes. So a write
 * only records what changed, and painting happens once per animation frame.
 * Two cases are worth separating, and both are common:
 *
 *   a REPL prompt, a progress bar, a spinner — a handful of cells on one row.
 *   Repaint that row and nothing else.
 *
 *   a build log — every line scrolls the screen, so every row's CONTENT is new
 *   even though the pixels mostly are not. The canvas is blitted up over itself
 *   and only the newly exposed rows are drawn, which is what makes the load
 *   case cost about the same as a single line.
 */
(function () {
	'use strict';

	/// What a person reads. Nothing the program prints passes through here — the
	/// terminal draws the bytes it is given and translates none of them.
	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }
	function tn(k, n, v) { return window.DaimondI18n ? DaimondI18n.tn(k, n, v) : k; }

	// ── Cell encoding ───────────────────────────────────────────────

	/// Attribute bits, one Uint32 per cell.
	var ATTR = {
		BOLD:      1,
		DIM:       2,
		ITALIC:    4,
		UNDER:     8,
		BLINK:     16,
		REVERSE:   32,
		HIDDEN:    64,
		STRIKE:    128,
		WIDE:      256,		// the left half of a double-width character
		WIDE_TAIL: 512,		// the right half; carries no glyph of its own
	};

	/// A colour, packed into a Uint32.
	///
	/// Mode 0 is "whatever the palette says the default is", which is NOT the
	/// same as any particular colour: it has to follow the app's theme, and a
	/// cell that recorded the resolved value at the time it was printed would
	/// keep the old palette's colour after a theme change.
	function packColour(mode, value) { return ((mode & 3) << 24) | (value & 0xFFFFFF); }
	var COL_DEFAULT = 0;
	var COL_INDEXED = 1;	// value is 0..255 in the xterm palette
	var COL_RGB     = 2;	// value is 0xRRGGBB

	// ── Character width ─────────────────────────────────────────────
	//
	// A terminal grid has to agree with the program about how many cells a
	// character occupies, or every subsequent column on the line is wrong. These
	// are the East Asian Wide and Fullwidth blocks, plus the emoji ranges that
	// every terminal treats as wide, and the combining marks that occupy none.

	var WIDE = [
		[0x1100, 0x115F], [0x2329, 0x232A], [0x2E80, 0x303E], [0x3041, 0x33FF],
		[0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xA000, 0xA4CF], [0xA960, 0xA97F],
		[0xAC00, 0xD7A3], [0xF900, 0xFAFF], [0xFE10, 0xFE19], [0xFE30, 0xFE6F],
		[0xFF00, 0xFF60], [0xFFE0, 0xFFE6], [0x1F300, 0x1F64F], [0x1F680, 0x1F6FF],
		[0x1F900, 0x1F9FF], [0x20000, 0x2FFFD], [0x30000, 0x3FFFD],
	];
	var ZERO = [
		[0x0300, 0x036F], [0x0483, 0x0489], [0x0591, 0x05BD], [0x0610, 0x061A],
		[0x064B, 0x065F], [0x0670, 0x0670], [0x06D6, 0x06DC], [0x0730, 0x074A],
		[0x07A6, 0x07B0], [0x0900, 0x0903], [0x093A, 0x093C], [0x0941, 0x0948],
		[0x0E31, 0x0E31], [0x0E34, 0x0E3A], [0x0EB1, 0x0EB1], [0x0EB4, 0x0EB9],
		[0x1AB0, 0x1AFF], [0x1DC0, 0x1DFF], [0x200B, 0x200F], [0x2060, 0x2064],
		[0x20D0, 0x20F0], [0xFE00, 0xFE0F], [0xFE20, 0xFE2F],
	];

	/// Whether `cp` lies in one of `ranges`, by bisection.
	function inRanges(ranges, cp) {
		var lo = 0, hi = ranges.length - 1;
		while (lo <= hi) {
			var mid = (lo + hi) >> 1;
			if (cp < ranges[mid][0]) hi = mid - 1;
			else if (cp > ranges[mid][1]) lo = mid + 1;
			else return true;
		}
		return false;
	}

	/// How many cells one code point takes: 0, 1 or 2.
	function charWidth(cp) {
		if (cp < 0x0300) return cp < 0x20 ? 0 : 1;	// the fast, overwhelmingly common path
		if (inRanges(ZERO, cp)) return 0;
		if (inRanges(WIDE, cp)) return 2;
		return 1;
	}

	// ── The screen model ────────────────────────────────────────────

	/// One line of the grid.
	///
	/// Four parallel typed arrays rather than an array of cell objects: a screen
	/// of objects is tens of thousands of allocations that the collector then has
	/// to walk, and scrolling would copy pointers rather than memory. `ext` holds
	/// the combining marks that will not fit in a single code point, and is null
	/// on the overwhelming majority of lines.
	function newLine(cols) {
		return {
			ch:   new Uint32Array(cols),
			attr: new Uint32Array(cols),
			fg:   new Uint32Array(cols),
			bg:   new Uint32Array(cols),
			ext:  null,		// index -> string of combining marks
			wrap: false,	// this line continues onto the next
		};
	}

	/// Blank one line, or a span of it, in the given attributes.
	function blankLine(ln, from, to, fg, bg, attr) {
		for (var i = from; i < to; i++) {
			ln.ch[i] = 32; ln.attr[i] = attr; ln.fg[i] = fg; ln.bg[i] = bg;
		}
		if (ln.ext) for (var k in ln.ext) { if (+k >= from && +k < to) delete ln.ext[k]; }
	}

	/// A screen: a grid, a cursor, modes, scrollback and damage.
	///
	/// This is the JavaScript half of the seam described at the top of the file.
	/// Everything below it is the VT parser; everything above it is drawing.
	function createScreen(cols, rows, opts) {
		opts = opts || {};
		var S = {};
		var SB_MAX = opts.scrollback === undefined ? 5000 : opts.scrollback;

		var lines   = [];		// the live screen, rows entries
		var alt     = null;		// the alternate screen, while one is in use
		var sb      = [];		// scrollback, oldest first
		var dropped = 0;		// lines evicted from the front of the scrollback
		var view    = 0;		// how far back the window is, in lines

		var cur   = { x: 0, y: 0, fg: COL_DEFAULT, bg: COL_DEFAULT, attr: 0 };
		var saved = null;
		var pend  = false;		// the deferred wrap: the cursor sits ON the last column
		var top = 0, bot = rows - 1;
		var tabs  = {};

		var dirty    = new Uint8Array(rows);
		var allDirty = true;
		var scrolled = 0;		// net whole-screen scrolls since the last compose

		var flat = {
			ch:   new Uint32Array(cols * rows),
			attr: new Uint32Array(cols * rows),
			fg:   new Uint32Array(cols * rows),
			bg:   new Uint32Array(cols * rows),
		};

		S.cols = cols; S.rows = rows;
		S.cells = flat;
		S.cursor = { x: 0, y: 0, visible: true, shape: 'block' };
		S.modes = {
			appCursor: false, appKeypad: false, bracketed: false,
			alt: false, mouse: 0, mouseSgr: false, wrap: true, reverse: false,
		};
		S.onBell = null; S.onTitle = null; S.onReply = null;

		for (var i = 0; i < rows; i++) { lines.push(newLine(cols)); blankLine(lines[i], 0, cols, 0, 0, 0); }
		for (var c = 8; c < cols; c += 8) tabs[c] = true;

		// ── damage ──────────────────────────────────────────────
		function mark(y) { if (y >= 0 && y < rows) dirty[y] = 1; }
		function markAll() { allDirty = true; }

		// ── the grid ────────────────────────────────────────────

		/// Absolute index of a line: stable while the model holds it, so a
		/// selection anchored on one keeps pointing at the same text as the
		/// screen scrolls underneath it.
		function absOf(y) { return dropped + sb.length + y; }

		/// The line shown at viewport row `y`, honouring the scrollback offset.
		function shown(y) {
			var k = sb.length - view + y;
			return k < sb.length ? sb[k] : lines[k - sb.length];
		}

		/// Push the top line into scrollback and open a blank one at the bottom.
		///
		/// Only the primary screen with a full-height scroll region keeps
		/// history: a full-screen program's redraw is not a transcript, and
		/// keeping it would fill the scrollback with the frames of a `vim`.
		function scrollUp(n) {
			var keep = !S.modes.alt && top === 0 && bot === rows - 1;
			for (var i = 0; i < n; i++) {
				var out = lines[top];
				lines.splice(top, 1);
				if (keep && SB_MAX > 0) {
					sb.push(out);
					if (sb.length > SB_MAX) { sb.shift(); dropped++; }
				}
				var ln = newLine(cols);
				blankLine(ln, 0, cols, cur.fg, cur.bg, 0);
				lines.splice(bot, 0, ln);
			}
			if (keep && n < rows) {
				// The rows moved with their content, so the damage moves with
				// them; the renderer turns this into a blit and repaints only
				// the rows that are genuinely new.
				dirty.copyWithin(0, n);
				dirty.fill(0, rows - n);
				for (var j = rows - n; j < rows; j++) dirty[j] = 1;
				scrolled += n;
				// A window scrolled back stays where the reader put it, which
				// means the whole viewport now shows different lines.
				if (view > 0) { view = Math.min(view + n, sb.length); markAll(); }
			} else {
				markAll();
			}
		}

		function scrollDown(n) {
			for (var i = 0; i < n; i++) {
				lines.splice(bot, 1);
				var ln = newLine(cols);
				blankLine(ln, 0, cols, cur.fg, cur.bg, 0);
				lines.splice(top, 0, ln);
			}
			markAll();
		}

		function lineFeed() {
			if (cur.y === bot) scrollUp(1);
			else if (cur.y < rows - 1) { cur.y++; }
			pend = false;
		}

		/// Print one code point at the cursor, wrapping as the modes say.
		function put(cp) {
			var w = charWidth(cp);
			if (w === 0) {
				// A combining mark belongs to the cell before the cursor.
				var px = cur.x > 0 ? cur.x - 1 : 0;
				var pl = lines[cur.y];
				if (pl.attr[px] & ATTR.WIDE_TAIL) px = px > 0 ? px - 1 : px;
				if (!pl.ext) pl.ext = {};
				pl.ext[px] = (pl.ext[px] || '') + String.fromCodePoint(cp);
				mark(cur.y);
				return;
			}
			if (pend && S.modes.wrap) {
				lines[cur.y].wrap = true;
				cur.x = 0;
				lineFeed();
				pend = false;
			}
			if (cur.x + w > cols) {
				if (!S.modes.wrap) { cur.x = cols - w; }
				else { lines[cur.y].wrap = true; cur.x = 0; lineFeed(); }
			}
			var ln = lines[cur.y], x = cur.x;
			// Overwriting half of a wide character leaves the other half
			// orphaned; blank it, or the grid draws a glyph twice.
			if (ln.attr[x] & ATTR.WIDE_TAIL) blankLine(ln, x - 1, x + 1, cur.fg, cur.bg, 0);
			if ((ln.attr[x] & ATTR.WIDE) && x + 1 < cols) blankLine(ln, x, x + 2, cur.fg, cur.bg, 0);
			ln.ch[x] = cp;
			ln.fg[x] = cur.fg; ln.bg[x] = cur.bg;
			ln.attr[x] = cur.attr | (w === 2 ? ATTR.WIDE : 0);
			if (ln.ext && ln.ext[x] !== undefined) delete ln.ext[x];
			if (w === 2 && x + 1 < cols) {
				ln.ch[x + 1] = 0;
				ln.fg[x + 1] = cur.fg; ln.bg[x + 1] = cur.bg;
				ln.attr[x + 1] = cur.attr | ATTR.WIDE_TAIL;
			}
			mark(cur.y);
			if (cur.x + w >= cols) { cur.x = cols - 1; pend = true; }
			else { cur.x += w; }
		}

		// ── the parser ──────────────────────────────────────────
		//
		// A state machine over the decoded text. Decoding is done by the
		// platform's own streaming UTF-8 decoder, which is both faster than
		// anything written here and correct across a chunk boundary — a control
		// sequence split between two reads is the normal case, not the odd one.

		var dec = new TextDecoder('utf-8');
		var st = 0;			// 0 ground, 1 esc, 2 csi, 3 osc/string, 4 charset
		var pStr = '';		// CSI parameter and intermediate bytes
		var pPriv = '';		// the private marker a CSI opened with
		var oStr = '';		// the OSC/DCS payload
		var oKind = '';		// which string sequence is open

		function params(def) {
			var out = pStr.split(';').map(function (s) {
				var n = parseInt(s.split(':')[0], 10);
				return isNaN(n) ? def : n;
			});
			return out;
		}
		function p1(def) { var v = params(def)[0]; return v === undefined || v === 0 ? (def === 0 ? 0 : def) : v; }

		function sgr() {
			var raw = pStr.length ? pStr.split(';') : ['0'];
			for (var i = 0; i < raw.length; i++) {
				// The colon form (38:2::r:g:b) is what a modern program emits;
				// the semicolon form is what an old one emits. Both are real.
				var bits = raw[i].split(':');
				var n = parseInt(bits[0], 10);
				if (isNaN(n)) n = 0;
				if (n === 38 || n === 48 || n === 58) {
					var col = COL_DEFAULT;
					if (bits.length > 1) {
						if (bits[1] === '5') col = packColour(COL_INDEXED, parseInt(bits[2], 10) || 0);
						else if (bits[1] === '2') {
							// 38:2::r:g:b has an empty colour-space slot; 38:2:r:g:b does not.
							var off = bits.length >= 6 ? 3 : 2;
							col = packColour(COL_RGB,
								((parseInt(bits[off], 10) || 0) << 16)
								| ((parseInt(bits[off + 1], 10) || 0) << 8)
								| (parseInt(bits[off + 2], 10) || 0));
						}
					} else if (raw[i + 1] === '5') {
						col = packColour(COL_INDEXED, parseInt(raw[i + 2], 10) || 0); i += 2;
					} else if (raw[i + 1] === '2') {
						col = packColour(COL_RGB,
							((parseInt(raw[i + 2], 10) || 0) << 16)
							| ((parseInt(raw[i + 3], 10) || 0) << 8)
							| (parseInt(raw[i + 4], 10) || 0)); i += 4;
					}
					if (n === 38) cur.fg = col; else if (n === 48) cur.bg = col;
					continue;
				}
				if (n === 0) { cur.attr = 0; cur.fg = COL_DEFAULT; cur.bg = COL_DEFAULT; }
				else if (n === 1) cur.attr |= ATTR.BOLD;
				else if (n === 2) cur.attr |= ATTR.DIM;
				else if (n === 3) cur.attr |= ATTR.ITALIC;
				else if (n === 4) cur.attr |= ATTR.UNDER;
				else if (n === 5 || n === 6) cur.attr |= ATTR.BLINK;
				else if (n === 7) cur.attr |= ATTR.REVERSE;
				else if (n === 8) cur.attr |= ATTR.HIDDEN;
				else if (n === 9) cur.attr |= ATTR.STRIKE;
				else if (n === 21 || n === 22) cur.attr &= ~(ATTR.BOLD | ATTR.DIM);
				else if (n === 23) cur.attr &= ~ATTR.ITALIC;
				else if (n === 24) cur.attr &= ~ATTR.UNDER;
				else if (n === 25) cur.attr &= ~ATTR.BLINK;
				else if (n === 27) cur.attr &= ~ATTR.REVERSE;
				else if (n === 28) cur.attr &= ~ATTR.HIDDEN;
				else if (n === 29) cur.attr &= ~ATTR.STRIKE;
				else if (n >= 30 && n <= 37) cur.fg = packColour(COL_INDEXED, n - 30);
				else if (n === 39) cur.fg = COL_DEFAULT;
				else if (n >= 40 && n <= 47) cur.bg = packColour(COL_INDEXED, n - 40);
				else if (n === 49) cur.bg = COL_DEFAULT;
				else if (n >= 90 && n <= 97) cur.fg = packColour(COL_INDEXED, n - 90 + 8);
				else if (n >= 100 && n <= 107) cur.bg = packColour(COL_INDEXED, n - 100 + 8);
			}
		}

		/// Switch between the primary and alternate screens.
		///
		/// The alternate screen is what makes `vim` leave your shell's output
		/// where it was: it is a second grid with no scrollback, thrown away
		/// when the program exits.
		function useAlt(on, saveCursor) {
			if (on === S.modes.alt) return;
			if (on) {
				alt = lines;
				if (saveCursor) saved = { x: cur.x, y: cur.y, fg: cur.fg, bg: cur.bg, attr: cur.attr };
				lines = [];
				for (var i = 0; i < rows; i++) { var ln = newLine(cols); blankLine(ln, 0, cols, 0, 0, 0); lines.push(ln); }
				S.modes.alt = true;
				cur.x = 0; cur.y = 0;
			} else {
				lines = alt || lines;
				alt = null;
				S.modes.alt = false;
				if (saveCursor && saved) { cur.x = saved.x; cur.y = saved.y; cur.fg = saved.fg; cur.bg = saved.bg; cur.attr = saved.attr; }
			}
			top = 0; bot = rows - 1;
			pend = false;
			markAll();
		}

		function setMode(on) {
			var ps = params(0);
			for (var i = 0; i < ps.length; i++) {
				var n = ps[i];
				if (pPriv === '?') {
					if (n === 1) S.modes.appCursor = on;
					else if (n === 5) { S.modes.reverse = on; markAll(); }
					else if (n === 7) S.modes.wrap = on;
					else if (n === 25) S.cursor.visible = on;
					else if (n === 12) { /* cursor blink; the renderer decides, see BLINK_MS */ }
					else if (n === 1000 || n === 1002 || n === 1003) S.modes.mouse = on ? n : 0;
					else if (n === 1006) S.modes.mouseSgr = on;
					else if (n === 47 || n === 1047) useAlt(on, false);
					else if (n === 1049) useAlt(on, true);
					else if (n === 2004) S.modes.bracketed = on;
				}
			}
		}

		function csi(fin) {
			var ps, n, ln, i;
			switch (fin) {
			case '@': {			// insert blanks
				n = Math.max(1, p1(1)); ln = lines[cur.y];
				for (i = cols - 1; i >= cur.x + n; i--) {
					ln.ch[i] = ln.ch[i - n]; ln.attr[i] = ln.attr[i - n];
					ln.fg[i] = ln.fg[i - n]; ln.bg[i] = ln.bg[i - n];
				}
				blankLine(ln, cur.x, Math.min(cols, cur.x + n), cur.fg, cur.bg, 0);
				mark(cur.y); break;
			}
			case 'A': cur.y = Math.max(top, cur.y - Math.max(1, p1(1))); pend = false; break;
			case 'B': cur.y = Math.min(bot, cur.y + Math.max(1, p1(1))); pend = false; break;
			case 'C': cur.x = Math.min(cols - 1, cur.x + Math.max(1, p1(1))); pend = false; break;
			case 'D': cur.x = Math.max(0, cur.x - Math.max(1, p1(1))); pend = false; break;
			case 'E': cur.y = Math.min(bot, cur.y + Math.max(1, p1(1))); cur.x = 0; pend = false; break;
			case 'F': cur.y = Math.max(top, cur.y - Math.max(1, p1(1))); cur.x = 0; pend = false; break;
			case 'G': case '`': cur.x = Math.min(cols - 1, Math.max(0, p1(1) - 1)); pend = false; break;
			case 'H': case 'f':
				ps = params(1);
				cur.y = Math.min(rows - 1, Math.max(0, (ps[0] || 1) - 1));
				cur.x = Math.min(cols - 1, Math.max(0, (ps[1] || 1) - 1));
				pend = false; break;
			case 'I': {			// forward tab
				n = Math.max(1, p1(1));
				for (i = 0; i < n; i++) { do { cur.x++; } while (cur.x < cols - 1 && !tabs[cur.x]); }
				cur.x = Math.min(cur.x, cols - 1); break;
			}
			case 'J': {			// erase in display
				n = p1(0);
				var from = n === 0 ? cur.y : 0, to = n === 1 ? cur.y : rows - 1;
				for (i = from; i <= to; i++) {
					var a = (n === 0 && i === cur.y) ? cur.x : 0;
					var b = (n === 1 && i === cur.y) ? cur.x + 1 : cols;
					blankLine(lines[i], a, b, cur.fg, cur.bg, 0);
					lines[i].wrap = false;
				}
				markAll(); break;
			}
			case 'K': {			// erase in line
				n = p1(0); ln = lines[cur.y];
				blankLine(ln, n === 1 ? 0 : cur.x, n === 0 ? cols : cur.x + 1, cur.fg, cur.bg, 0);
				if (n === 2) blankLine(ln, 0, cols, cur.fg, cur.bg, 0);
				mark(cur.y); break;
			}
			case 'L': {			// insert lines
				n = Math.max(1, p1(1));
				if (cur.y >= top && cur.y <= bot) {
					for (i = 0; i < n; i++) {
						lines.splice(bot, 1);
						var nl = newLine(cols); blankLine(nl, 0, cols, cur.fg, cur.bg, 0);
						lines.splice(cur.y, 0, nl);
					}
					markAll();
				}
				break;
			}
			case 'M': {			// delete lines
				n = Math.max(1, p1(1));
				if (cur.y >= top && cur.y <= bot) {
					for (i = 0; i < n; i++) {
						lines.splice(cur.y, 1);
						var ml = newLine(cols); blankLine(ml, 0, cols, cur.fg, cur.bg, 0);
						lines.splice(bot, 0, ml);
					}
					markAll();
				}
				break;
			}
			case 'P': {			// delete characters
				n = Math.max(1, p1(1)); ln = lines[cur.y];
				for (i = cur.x; i < cols; i++) {
					var src = i + n;
					if (src < cols) {
						ln.ch[i] = ln.ch[src]; ln.attr[i] = ln.attr[src];
						ln.fg[i] = ln.fg[src]; ln.bg[i] = ln.bg[src];
					} else { ln.ch[i] = 32; ln.attr[i] = 0; ln.fg[i] = cur.fg; ln.bg[i] = cur.bg; }
				}
				mark(cur.y); break;
			}
			case 'S': scrollUp(Math.max(1, p1(1))); break;
			case 'T': scrollDown(Math.max(1, p1(1))); break;
			case 'X': {			// erase characters
				n = Math.max(1, p1(1));
				blankLine(lines[cur.y], cur.x, Math.min(cols, cur.x + n), cur.fg, cur.bg, 0);
				mark(cur.y); break;
			}
			case 'Z': {			// backward tab
				n = Math.max(1, p1(1));
				for (i = 0; i < n; i++) { do { cur.x--; } while (cur.x > 0 && !tabs[cur.x]); }
				cur.x = Math.max(0, cur.x); break;
			}
			case 'd': cur.y = Math.min(rows - 1, Math.max(0, p1(1) - 1)); pend = false; break;
			case 'g': if (p1(0) === 3) tabs = {}; else delete tabs[cur.x]; break;
			case 'h': setMode(true); break;
			case 'l': setMode(false); break;
			case 'm': sgr(); break;
			case 'n':
				// A program that asks where the cursor is BLOCKS until it is
				// told. Dropping the reply is how a shell appears to hang.
				if (p1(0) === 6 && S.onReply) S.onReply('\x1b[' + (cur.y + 1) + ';' + (cur.x + 1) + 'R');
				else if (p1(0) === 5 && S.onReply) S.onReply('\x1b[0n');
				break;
			case 'c': if (S.onReply) S.onReply('\x1b[?6c'); break;	// a VT102, which is what we draw
			case 'q': {			// DECSCUSR — the cursor's shape
				n = p1(0);
				S.cursor.shape = (n === 3 || n === 4) ? 'underline' : (n === 5 || n === 6) ? 'bar' : 'block';
				break;
			}
			case 'r':
				ps = params(0);
				top = Math.max(0, (ps[0] || 1) - 1);
				bot = Math.min(rows - 1, (ps[1] || rows) - 1);
				if (top >= bot) { top = 0; bot = rows - 1; }
				cur.x = 0; cur.y = top; pend = false; break;
			case 's': saved = { x: cur.x, y: cur.y, fg: cur.fg, bg: cur.bg, attr: cur.attr }; break;
			case 'u': if (saved) { cur.x = saved.x; cur.y = saved.y; cur.fg = saved.fg; cur.bg = saved.bg; cur.attr = saved.attr; } break;
			default: break;		// an unknown final byte is consumed, never printed
			}
		}

		function esc(c) {
			switch (c) {
			case 'D': lineFeed(); break;
			case 'E': cur.x = 0; lineFeed(); break;
			case 'M': if (cur.y === top) scrollDown(1); else if (cur.y > 0) cur.y--; pend = false; break;
			case 'H': tabs[cur.x] = true; break;
			case '7': saved = { x: cur.x, y: cur.y, fg: cur.fg, bg: cur.bg, attr: cur.attr }; break;
			case '8': if (saved) { cur.x = saved.x; cur.y = saved.y; cur.fg = saved.fg; cur.bg = saved.bg; cur.attr = saved.attr; } break;
			case '=': S.modes.appKeypad = true; break;
			case '>': S.modes.appKeypad = false; break;
			case 'c': S.reset(); break;
			default: break;
			}
		}

		function osc() {
			var semi = oStr.indexOf(';');
			var kind = semi < 0 ? oStr : oStr.slice(0, semi);
			var body = semi < 0 ? '' : oStr.slice(semi + 1);
			if ((kind === '0' || kind === '2') && S.onTitle) S.onTitle(body);
		}

		/// Feed the model output. Bytes, or an already decoded string.
		S.write = function (data) {
			var s;
			if (typeof data === 'string') s = data;
			else if (data instanceof Uint8Array) s = dec.decode(data, { stream: true });
			else if (data instanceof ArrayBuffer) s = dec.decode(new Uint8Array(data), { stream: true });
			else return;
			for (var i = 0; i < s.length; i++) {
				var c = s.charCodeAt(i);
				if (st === 0) {
					if (c < 0x20) {
						if (c === 0x1b) { st = 1; }
						else if (c === 0x0a || c === 0x0b || c === 0x0c) lineFeed();
						else if (c === 0x0d) { cur.x = 0; pend = false; }
						else if (c === 0x08) { if (cur.x > 0) cur.x--; pend = false; }
						else if (c === 0x09) { do { cur.x++; } while (cur.x < cols - 1 && !tabs[cur.x]); pend = false; }
						else if (c === 0x07 && S.onBell) S.onBell();
						continue;
					}
					if (c === 0x7f) continue;
					if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
						put(((c - 0xD800) << 10) + (s.charCodeAt(++i) - 0xDC00) + 0x10000);
					} else put(c);
					continue;
				}
				var ch = s[i];
				if (st === 1) {
					if (ch === '[') { st = 2; pStr = ''; pPriv = ''; }
					else if (ch === ']') { st = 3; oStr = ''; oKind = 'osc'; }
					else if (ch === 'P' || ch === 'X' || ch === '^' || ch === '_') { st = 3; oStr = ''; oKind = 'dcs'; }
					else if (ch === '(' || ch === ')' || ch === '*' || ch === '+') { st = 4; }
					else { st = 0; esc(ch); }
					continue;
				}
				if (st === 2) {
					if (!pStr.length && !pPriv.length && '<=>?'.indexOf(ch) >= 0) { pPriv = ch; continue; }
					if (c >= 0x30 && c <= 0x3f) { pStr += ch; continue; }
					if (c >= 0x20 && c <= 0x2f) { pStr += ch; continue; }	// intermediates, kept for the final's sake
					st = 0;
					csi(ch);
					continue;
				}
				if (st === 3) {
					if (c === 0x07) { st = 0; if (oKind === 'osc') osc(); continue; }
					if (c === 0x1b) { continue; }	// the ST's first half
					if (ch === '\\' && oStr.length >= 0 && s.charCodeAt(i - 1) === 0x1b) { st = 0; if (oKind === 'osc') osc(); continue; }
					oStr += ch;
					continue;
				}
				if (st === 4) { st = 0; continue; }	// a charset designation, consumed
			}
			S.cursor.x = cur.x;
			S.cursor.y = cur.y;
		};

		// ── what the renderer reads ─────────────────────────────

		/// Fill the flat cell arrays for whatever has changed, and say what that
		/// was. `everything` is the caller announcing that it is going to repaint
		/// the whole grid regardless — a theme change, a resize, a selection —
		/// and it must be passed, because the arrays hold ONLY what was last
		/// composed: a forced repaint that read them without this drew the rows
		/// as they were several frames ago, which is a stale screen produced by
		/// an optimisation that was working correctly.
		S.compose = function (everything) {
			if (everything) allDirty = true;
			var res = { all: allDirty, rows: dirty, scrolled: allDirty ? 0 : scrolled };
			var from = 0, to = rows;
			for (var y = from; y < to; y++) {
				if (!allDirty && !dirty[y]) continue;
				var ln = shown(y), o = y * cols;
				if (!ln) { flat.ch.fill(32, o, o + cols); flat.attr.fill(0, o, o + cols); flat.fg.fill(0, o, o + cols); flat.bg.fill(0, o, o + cols); continue; }
				flat.ch.set(ln.ch, o);
				flat.attr.set(ln.attr, o);
				flat.fg.set(ln.fg, o);
				flat.bg.set(ln.bg, o);
			}
			// The cursor is only on screen while the window is live.
			S.cursor.x = cur.x;
			S.cursor.y = view > 0 ? -1 : cur.y;
			allDirty = false;
			scrolled = 0;
			dirty = new Uint8Array(rows);
			return res;
		};

		/// The combining marks on one viewport row, or null — which is the
		/// answer on almost every row, and asking once per row rather than once
		/// per cell is the difference between a lookup and ten thousand.
		S.extRow = function (y) {
			var ln = shown(y);
			return (ln && ln.ext) || null;
		};
		S.ext = function (y, x) {
			var e = S.extRow(y);
			return (e && e[x]) || '';
		};

		S.scrollback = function () { return sb.length; };
		S.viewOffset = function () { return view; };
		S.setViewOffset = function (n) {
			n = Math.max(0, Math.min(sb.length, Math.round(n)));
			if (n === view) return false;
			view = n;
			markAll();
			return true;
		};
		S.absTop = function () { return dropped; };
		S.absOfRow = function (y) { return dropped + sb.length - view + y; };
		/// Where an absolute line sits in the viewport, or outside it. Part of the
		/// interface rather than used here: a host that wants to scroll TO a
		/// found line needs it, and it belongs beside its inverse.
		S.rowOfAbs = function (a) { return a - (dropped + sb.length - view); };

		S.lineCells = function (a) {
			var k = a - dropped;
			if (k < 0) return null;
			return k < sb.length ? sb[k] : (lines[k - sb.length] || null);
		};
		S.lineText = function (a) {
			var ln = S.lineCells(a);
			if (!ln) return '';
			var out = '';
			for (var x = 0; x < cols; x++) {
				if (ln.attr[x] & ATTR.WIDE_TAIL) continue;
				out += (ln.ch[x] ? String.fromCodePoint(ln.ch[x]) : ' ') + (ln.ext && ln.ext[x] ? ln.ext[x] : '');
			}
			return out.replace(/\s+$/, '');
		};
		/// Whether the line at `a` was broken by the terminal's own wrap rather
		/// than by the program. A copy joins those, because a wrapped path is
		/// one path and pasting it with a newline in the middle breaks it.
		S.lineWrapped = function (a) { var ln = S.lineCells(a); return !!(ln && ln.wrap); };

		/// The last row of a screen with anything written on it, or 0.
		///
		/// Only ever asked of the PARKED primary screen, and only when a
		/// program moved to the alternate screen without saving a cursor: a
		/// shell prompt sits on the last written row, so that is the row worth
		/// keeping when the window shrinks underneath `vim`.
		function lastUsed(ls) {
			for (var y = ls.length - 1; y >= 0; y--) {
				var ch = ls[y].ch;
				for (var x = 0; x < ch.length; x++) {
					if (ch[x] !== 32 && ch[x] !== 0) return y;
				}
			}
			return 0;
		}

		/// Push one line off the top of a screen into the history.
		///
		/// The same three rules `scrollUp` follows: the history is bounded, what
		/// falls off its front is counted, and a window scrolled back stays on
		/// the text the reader put it on.
		function toScrollback(ln) {
			if (SB_MAX <= 0) return;
			sb.push(ln);
			if (sb.length > SB_MAX) { sb.shift(); dropped++; }
			if (view > 0) view = Math.min(view + 1, sb.length);
		}

		/// Bring one screen to `nr` rows, keeping the cursor on it.
		///
		/// **Checked against tmux**, which is the only authority worth having
		/// here. Shrinking a 20-row screen holding two lines to 10 rows leaves
		/// both lines where they are and the cursor on row 2, because what goes
		/// is the empty rows BELOW the cursor; only once there is nothing left
		/// below it does the top of the screen go into the history, taking the
		/// cursor up with it. Growing takes those same lines back out, so the
		/// screen a reader was looking at comes back exactly — which is what the
		/// oracle does, row for row, and what taking rows from the bottom
		/// regardless did not: it threw the two lines away and left a blank
		/// viewport.
		///
		/// # Arguments
		/// * `ls` - The screen's lines, mutated in place.
		/// * `c` - Its cursor, whose `y` moves with the rows.
		/// * `nr` - The new height.
		function fitHeight(ls, c, nr) {
			while (ls.length > nr) {
				if (c.y + 1 < ls.length) {
					ls.pop();
				} else {
					toScrollback(ls.shift());
					c.y = Math.max(0, c.y - 1);
				}
			}
			while (ls.length < nr) {
				if (sb.length) {
					ls.unshift(sb.pop());
					c.y++;
					if (view > 0) view--;
				} else {
					var ln = newLine(cols);
					blankLine(ln, 0, cols, 0, 0, 0);
					ls.push(ln);
				}
			}
		}

		S.resize = function (nc, nr) {
			nc = Math.max(1, nc | 0); nr = Math.max(1, nr | 0);
			if (nc === cols && nr === rows) return;
			// The PRIMARY screen is the one with a history and a cursor worth
			// keeping, whether or not it is the one being looked at. The
			// alternate is a program's redraw — not a transcript — so it is
			// trimmed from the bottom and contributes nothing to the history.
			// Resizing only the live screen left the parked one at the old
			// width, and a `vim` exited after a resize handed back a grid the
			// renderer then read past the end of.
			var prim = S.modes.alt ? alt : lines;
			var pcur = S.modes.alt ? (saved || { y: lastUsed(prim) }) : cur;
			fitHeight(prim, pcur, nr);
			if (S.modes.alt) {
				while (lines.length > nr) lines.pop();
				while (lines.length < nr) { var b = newLine(cols); blankLine(b, 0, cols, 0, 0, 0); lines.push(b); }
			}
			for (var i = 0; i < prim.length; i++) prim[i] = refit(prim[i], nc);
			if (S.modes.alt) {
				for (var k = 0; k < lines.length; k++) lines[k] = refit(lines[k], nc);
			}
			for (var j = 0; j < sb.length; j++) sb[j] = refit(sb[j], nc);
			cur.y = Math.max(0, Math.min(nr - 1, cur.y));
			cur.x = Math.min(nc - 1, cur.x);
			if (saved) {
				saved.y = Math.max(0, Math.min(nr - 1, saved.y));
				saved.x = Math.min(nc - 1, saved.x);
			}
			cols = nc; rows = nr;
			S.cols = nc; S.rows = nr;
			top = 0; bot = nr - 1;
			tabs = {};
			for (var c2 = 8; c2 < nc; c2 += 8) tabs[c2] = true;
			dirty = new Uint8Array(nr);
			flat.ch = new Uint32Array(nc * nr); flat.attr = new Uint32Array(nc * nr);
			flat.fg = new Uint32Array(nc * nr); flat.bg = new Uint32Array(nc * nr);
			view = Math.min(view, sb.length);
			markAll();
		};

		/// One line at a new width. Truncated or padded; NOT reflowed.
		///
		/// Reflowing history on resize is what a full terminal does and it is a
		/// large piece of work with its own class of bugs (a wrapped line that
		/// was itself the tail of a wrap, a selection anchored inside one). This
		/// is the honest smaller thing, and it is recorded as a gap rather than
		/// dressed up.
		function refit(ln, nc) {
			if (ln.ch.length === nc) return ln;
			var out = newLine(nc);
			blankLine(out, 0, nc, 0, 0, 0);
			var n = Math.min(nc, ln.ch.length);
			out.ch.set(ln.ch.subarray(0, n)); out.attr.set(ln.attr.subarray(0, n));
			out.fg.set(ln.fg.subarray(0, n)); out.bg.set(ln.bg.subarray(0, n));
			out.wrap = ln.wrap;
			if (ln.ext) { out.ext = {}; for (var k in ln.ext) if (+k < nc) out.ext[k] = ln.ext[k]; }
			return out;
		}

		S.reset = function () {
			lines = []; alt = null; sb = []; dropped = 0; view = 0;
			for (var i = 0; i < rows; i++) { var ln = newLine(cols); blankLine(ln, 0, cols, 0, 0, 0); lines.push(ln); }
			cur = { x: 0, y: 0, fg: COL_DEFAULT, bg: COL_DEFAULT, attr: 0 };
			saved = null; pend = false; top = 0; bot = rows - 1;
			S.modes.appCursor = false; S.modes.appKeypad = false; S.modes.bracketed = false;
			S.modes.alt = false; S.modes.mouse = 0; S.modes.mouseSgr = false;
			S.modes.wrap = true; S.modes.reverse = false;
			S.cursor.visible = true; S.cursor.shape = 'block';
			st = 0; markAll();
		};

		/// Everything the model holds, as text. The a11y mirror and a
		/// select-all both want it, and neither should reach past the interface
		/// to get it.
		S.allText = function () {
			var out = [];
			for (var a = dropped; a < dropped + sb.length + rows; a++) out.push(S.lineText(a));
			while (out.length && out[out.length - 1] === '') out.pop();
			return out.join('\n');
		};

		return S;
	}

	// ── Colour resolution ───────────────────────────────────────────
	//
	// The 16 named colours come from the stylesheet, so the terminal wears the
	// palette the app is wearing. 16..255 are the xterm cube and grey ramp,
	// which are DEFINED values — a program asking for colour 208 wants that
	// orange, and tinting it per theme would be answering a different question.

	var CUBE = [0, 95, 135, 175, 215, 255];

	function readPalette(el) {
		var cs = getComputedStyle(el);
		var pal = new Array(256), bgs = new Array(256);
		for (var i = 0; i < 16; i++) {
			pal[i] = (cs.getPropertyValue('--term-ansi-' + i) || '').trim() || '#888888';
			// The same name can need two values. On a paper-white ground, colour
			// 7 as LETTERING has to be dark or the words are invisible, and
			// colour 7 as a BACKGROUND has to be pale or a status bar comes out
			// inverted. Which one is wanted is known at the moment of asking, so
			// it is asked: a background may override its own value, and where it
			// does not, the two are the same colour.
			bgs[i] = (cs.getPropertyValue('--term-ansi-bg-' + i) || '').trim() || pal[i];
		}
		for (var n = 16; n < 232; n++) {
			var k = n - 16;
			pal[n] = 'rgb(' + CUBE[(k / 36) | 0] + ',' + CUBE[((k / 6) | 0) % 6] + ',' + CUBE[k % 6] + ')';
			bgs[n] = pal[n];
		}
		for (var g = 232; g < 256; g++) {
			var v = 8 + (g - 232) * 10;
			pal[g] = 'rgb(' + v + ',' + v + ',' + v + ')';
			bgs[g] = pal[g];
		}
		return {
			ansi:   pal,
			ansiBg: bgs,
			fg:     (cs.getPropertyValue('--term-fg') || '').trim() || '#ddd',
			bg:     (cs.getPropertyValue('--term-bg') || '').trim() || '#111',
			cursor: (cs.getPropertyValue('--term-cursor') || '').trim() || '#ddd',
			sel:    (cs.getPropertyValue('--term-selection') || '').trim() || 'rgba(120,160,255,0.35)',
			font:   (cs.getPropertyValue('--term-font') || cs.getPropertyValue('--font-mono') || 'monospace').trim(),
			size:   parseFloat(cs.getPropertyValue('--term-font-size')) || 13,
		};
	}

	/// One packed colour as something a canvas will take.
	///
	/// The default and the indexed cases are table lookups; only twenty-four-bit
	/// colour builds a string, and those are memoised — a `ls --color` prints
	/// the same handful of colours thousands of times, and rebuilding
	/// `rgb(r,g,b)` per cell is allocation in the tightest loop there is.
	var rgbMemo = new Map();
	function colourOf(pal, packed, dflt, forBg) {
		var mode = (packed >>> 24) & 3;
		if (mode === COL_DEFAULT) return dflt;
		if (mode === COL_INDEXED) return (forBg ? pal.ansiBg : pal.ansi)[packed & 0xFF] || dflt;
		var v = packed & 0xFFFFFF;
		var hit = rgbMemo.get(v);
		if (hit) return hit;
		hit = 'rgb(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ')';
		if (rgbMemo.size < 4096) rgbMemo.set(v, hit);
		return hit;
	}

	// ── Keys ────────────────────────────────────────────────────────
	//
	// An arrow key that sends the wrong bytes makes every REPL feel broken, so
	// these are the xterm sequences rather than something plausible. The
	// modifier code is xterm's: 1 + shift + 2*alt + 4*ctrl + 8*meta, appended as
	// a second parameter, and omitted entirely when it would be 1.

	var TILDE = {
		Insert: 2, Delete: 3, PageUp: 5, PageDown: 6,
		F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24,
	};
	var ARROW = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
	var FKEY  = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' };

	function modCode(ev) {
		return 1 + (ev.shiftKey ? 1 : 0) + (ev.altKey ? 2 : 0) + (ev.ctrlKey ? 4 : 0) + (ev.metaKey ? 8 : 0);
	}

	/// The bytes one keypress sends, or null when the terminal should not send
	/// anything at all (a shortcut, or a key it does not own).
	///
	/// Returned as a string of code points below 256 for the control sequences
	/// and as ordinary text otherwise; the caller UTF-8 encodes the lot, which
	/// is a no-op for the sequences and correct for the text.
	function keyBytes(ev, modes) {
		var k = ev.key, m = modCode(ev), tail = m > 1 ? ';' + m : '';

		// A cursor key in application mode is SS3, not CSI — and only when it
		// carries no modifier, which is the rule readline and vi both assume.
		if (ARROW[k]) {
			var f = ARROW[k];
			if (m > 1) return '\x1b[1' + tail + f;
			return (modes.appCursor ? '\x1bO' : '\x1b[') + f;
		}
		if (TILDE[k] !== undefined) return '\x1b[' + TILDE[k] + tail + '~';
		if (FKEY[k]) return m > 1 ? '\x1b[1' + tail + FKEY[k] : '\x1bO' + FKEY[k];

		switch (k) {
		case 'Enter':
			// CR, not LF. The line discipline turns it into a newline; sending
			// LF straight past it is what makes a shell echo a blank line.
			return ev.altKey ? '\x1b\r' : '\r';
		case 'Backspace':
			// DEL, which is what every Unix terminal has sent for decades.
			// Ctrl-Backspace is the one that sends BS, and readline binds it to
			// "delete the word behind".
			if (ev.ctrlKey) return '\x08';
			return ev.altKey ? '\x1b\x7f' : '\x7f';
		case 'Tab':
			if (ev.shiftKey) return '\x1b[Z';
			return ev.ctrlKey || ev.altKey ? null : '\t';
		case 'Escape':
			return '\x1b';
		case ' ':
			if (ev.ctrlKey) return '\x00';	// Ctrl-Space is NUL, the "set mark" of emacs
			break;
		default: break;
		}

		if (ev.ctrlKey && !ev.altKey && !ev.metaKey && k.length === 1) {
			var cp = k.toUpperCase().charCodeAt(0);
			if (cp >= 64 && cp <= 95) return String.fromCharCode(cp - 64);	// @ A..Z [ \ ] ^ _
			if (k === '?') return '\x7f';
			if (k === '/') return '\x1f';
			if (k === '-') return '\x1f';
			return null;
		}
		if (ev.metaKey) return null;	// the browser's and the operating system's
		if (k.length === 1 || (k.codePointAt(0) > 0xFF && k.length === 2)) {
			return ev.altKey ? '\x1b' + k : k;
		}
		return null;
	}

	// ── The terminal ────────────────────────────────────────────────

	var enc = new TextEncoder();
	var seq = 0;

	/// How long the cursor spends on and off. Honoured only where the reader has
	/// not asked for less motion — a blinking block in the corner of the eye is
	/// exactly what that setting exists to stop.
	var BLINK_MS = 530;

	/// How long the page waits after the last byte before deciding the output
	/// has settled and is worth announcing. Short enough to feel prompt after a
	/// command, long enough that a build does not announce every line.
	var SETTLE_MS = 600;

	/// How many lines an announcement will read out before it summarises
	/// instead. A screen reader given a whole build log recites it, and a person
	/// with a running commentary they cannot stop switches the announcements off.
	var SAY_MAX = 12;

	function create(host, opts) {
		opts = opts || {};
		var id = 'term' + (++seq);
		var onData   = opts.onData || function () {};
		var onResize = opts.onResize || function () {};
		var onBell   = opts.onBell || null;
		var onTitle  = opts.onTitle || null;

		// ── the furniture ───────────────────────────────────
		var root = document.createElement('div');
		root.className = 'term';
		root.setAttribute('data-term', id);

		var canvas = document.createElement('canvas');
		canvas.className = 'term-canvas';
		// The canvas is a picture of text the screen reader is given properly
		// elsewhere; announcing it as an image called "canvas" is worse than
		// silence.
		canvas.setAttribute('aria-hidden', 'true');

		// A real textarea, not a div with a tabindex. It is what gives us an
		// input method for languages that need one, a paste event with the
		// clipboard on it, and a soft keyboard on a phone. It carries no text:
		// anything that lands in it is sent and cleared.
		var input = document.createElement('textarea');
		input.className = 'term-input';
		input.setAttribute('spellcheck', 'false');
		input.setAttribute('autocapitalize', 'off');
		input.setAttribute('autocorrect', 'off');
		input.setAttribute('autocomplete', 'off');
		input.setAttribute('aria-label', opts.label || t('term.label'));
		input.setAttribute('aria-describedby', id + '-hint');
		input.setAttribute('aria-multiline', 'true');
		input.rows = 1;

		var hint = document.createElement('p');
		hint.className = 'term-sr';
		hint.id = id + '-hint';
		hint.textContent = t('term.hint');

		// What has SETTLED, announced once. See the accessibility note in the
		// file header for why this is not the screen itself.
		var say = document.createElement('div');
		say.className = 'term-sr';
		say.setAttribute('role', 'log');
		say.setAttribute('aria-live', 'polite');
		say.setAttribute('aria-atomic', 'false');

		// The screen as text, for a reader to browse at their own pace. Not a
		// live region: it is the transcript, not the announcement.
		var mirror = document.createElement('div');
		mirror.className = 'term-sr term-mirror';
		mirror.setAttribute('role', 'region');
		mirror.setAttribute('aria-label', t('term.screen_label'));

		var chip = document.createElement('div');	// the size, while it is changing
		chip.className = 'term-size';
		chip.setAttribute('aria-hidden', 'true');

		var paste = document.createElement('div');	// the multi-line paste question
		paste.className = 'term-paste';
		paste.hidden = true;

		root.appendChild(canvas);
		root.appendChild(input);
		root.appendChild(chip);
		root.appendChild(paste);
		root.appendChild(hint);
		root.appendChild(say);
		root.appendChild(mirror);
		host.appendChild(root);

		var ctx = canvas.getContext('2d', { alpha: false });
		var pal = readPalette(root);
		var cw = 8, chh = 16, base = 12, dpr = 1;
		var screen = createScreen(80, 24, { scrollback: opts.scrollback });
		var reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

		var sel = null;		// { a: {abs,col}, b: {abs,col}, rect: bool } while there is one
		var dragging = false;
		var frame = 0;
		var blinkOn = true, blinkTimer = 0;
		var lastCur = { x: -1, y: -1 };
		var settleTimer = 0;
		var saidTo = -1;	// the last absolute line already announced
		var wroteSince = 0;
		var alive = true;

		// ── measurement ─────────────────────────────────────
		//
		// Never assume a character is eight pixels wide. The face comes from the
		// palette, the size from the type scale, and a user who has just made
		// the app's text larger has changed both.

		function measure() {
			pal = readPalette(root);
			dpr = window.devicePixelRatio || 1;
			ctx.font = pal.size + 'px ' + pal.font;
			// A long run divided by its length, so the answer is not the
			// rounding of one glyph's advance. The fractional value is KEPT: a
			// rounded cell width drifts a whole column across eighty of them.
			var probe = 'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM';
			cw = ctx.measureText(probe).width / probe.length;
			var m = ctx.measureText('Mg');
			var asc = m.actualBoundingBoxAscent || pal.size * 0.8;
			var desc = m.actualBoundingBoxDescent || pal.size * 0.2;
			chh = Math.ceil(asc + desc + Math.max(2, pal.size * 0.25));
			base = Math.round((chh + asc - desc) / 2);
			if (!(cw > 0)) cw = pal.size * 0.6;
			buildFonts();
			forgetCtx();
		}

		/// Turn the box we have been given into columns and rows, and tell
		/// whoever is listening — which is the only way the kernel ever finds
		/// out, and a program that has not been told draws to the wrong width.
		function fit(quiet) {
			measure();
			var box = root.getBoundingClientRect();
			var pad = 4;
			var cols = Math.max(MIN_COLS, Math.floor((box.width - pad * 2) / cw));
			var rows = Math.max(MIN_ROWS, Math.floor((box.height - pad * 2) / chh));
			if (!isFinite(cols) || !isFinite(rows)) return;
			var changed = cols !== screen.cols || rows !== screen.rows;
			if (changed) screen.resize(cols, rows);
			canvas.width  = Math.ceil(cols * cw * dpr);
			canvas.height = Math.ceil(rows * chh * dpr);
			canvas.style.width  = (cols * cw) + 'px';
			canvas.style.height = (rows * chh) + 'px';
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.textBaseline = 'alphabetic';
			forgetCtx();
			root.setAttribute('data-cols', cols);
			root.setAttribute('data-rows', rows);
			chip.textContent = cols + '×' + rows;
			// The FIRST measurement is always reported, even when it happens to
			// match the grid we started with: a host that is never told the size
			// never tells the kernel, and a program that has not been told draws
			// to eighty columns whatever the panel is.
			if (changed || !reported) {
				reported = true;
				if (!quiet) {
					chip.classList.add('on');
					clearTimeout(chip._t);
					chip._t = setTimeout(function () { chip.classList.remove('on'); }, 900);
				}
				onResize(cols, rows);
			}
			paint(true);
		}
		var MIN_COLS = 20, MIN_ROWS = 4;
		var reported = false;

		// ── painting ────────────────────────────────────────

		/// Whether a code point can be drawn inside a batched run.
		///
		/// A run is one `fillText` for many cells, which is only sound while
		/// every glyph in it advances by exactly one cell. That is true of the
		/// monospace face's own ASCII and true of nothing else we can promise —
		/// a glyph the face lacks comes from a fallback with its own metrics, so
		/// anything outside ASCII is drawn cell by cell and centred.
		function runnable(cp) { return cp >= 0x20 && cp <= 0x7E; }

		/// The box-drawing and block-element ranges, which have to MEET their
		/// neighbours rather than sit politely inside their own cell.
		function boxDrawing(cp) { return cp >= 0x2500 && cp <= 0x259F; }

		/// The four font strings that exist — plain, bold, italic, both — built
		/// once per palette rather than once per run of text.
		var fonts = ['', '', '', ''];
		function buildFonts() {
			for (var i = 0; i < 4; i++) {
				fonts[i] = (i & 2 ? 'italic ' : '') + (i & 1 ? '700 ' : '') + pal.size + 'px ' + pal.font;
			}
		}
		function styleOf(attr) {
			return fonts[(attr & ATTR.BOLD ? 1 : 0) | (attr & ATTR.ITALIC ? 2 : 0)];
		}

		// Assigning to `ctx.font` costs a font-shorthand parse EVERY time, even
		// when the value is the one already there, and a screen of alternating
		// styles assigns it once per cell. Measured on a 200×50 grid of
		// per-cell colour, guarding these three assignments took a full repaint
		// from 99 ms to 6 ms — the single largest thing in this file.
		var curFont = '', curFill = '', curAlpha = 1;
		function setFont(f) { if (f !== curFont) { ctx.font = f; curFont = f; } }
		function setFill(f) { if (f !== curFill) { ctx.fillStyle = f; curFill = f; } }
		function setAlpha(a) { if (a !== curAlpha) { ctx.globalAlpha = a; curAlpha = a; } }
		/// Resizing a canvas throws its whole context state away, so anything
		/// remembered about it has to be forgotten at the same moment or the
		/// guard above starts skipping assignments that are genuinely needed.
		function forgetCtx() { curFont = ''; curFill = ''; curAlpha = -1; }

		/// Where a row's selection starts and ends, in columns, or null.
		function selOn(y) {
			if (!sel) return null;
			var a = sel.a, b = sel.b;
			if (a.abs > b.abs || (a.abs === b.abs && a.col > b.col)) { a = sel.b; b = sel.a; }
			var abs = screen.absOfRow(y);
			if (abs < a.abs || abs > b.abs) return null;
			if (sel.rect) {
				return { from: Math.min(a.col, b.col), to: Math.max(a.col, b.col) };
			}
			return {
				from: abs === a.abs ? a.col : 0,
				to:   abs === b.abs ? b.col : screen.cols,
			};
		}

		function paintRow(y, cells) {
			var cols = screen.cols, o = y * cols;
			var yTop = y * chh;
			var s = selOn(y);
			var rev = screen.modes.reverse;
			var defFg = rev ? pal.bg : pal.fg, defBg = rev ? pal.fg : pal.bg;
			// Asked once for the row, not once per cell: almost every row has
			// none, and this loop is the hottest one in the file.
			var exts = screen.extRow(y);

			// Backgrounds first, as runs — a row of one colour is one rect.
			setAlpha(1);
			setFill(defBg);
			ctx.fillRect(0, yTop, cols * cw, chh);
			var x = 0;
			while (x < cols) {
				var attr = cells.attr[o + x];
				var inv = attr & ATTR.REVERSE;
				var bg = inv ? cells.fg[o + x] : cells.bg[o + x];
				var n = 1;
				while (x + n < cols
					&& (cells.attr[o + x + n] & ATTR.REVERSE) === inv
					&& (inv ? cells.fg[o + x + n] : cells.bg[o + x + n]) === bg) n++;
				if (bg !== 0 || inv) {
					var col = colourOf(pal, bg, inv ? defFg : defBg, true);
					if (col !== defBg) { setFill(col); ctx.fillRect(x * cw, yTop, n * cw, chh); }
				}
				x += n;
			}
			if (s) {
				setFill(pal.sel);
				ctx.fillRect(s.from * cw, yTop, Math.max(0, s.to - s.from) * cw, chh);
			}

			// Then the glyphs, batched by style while it is safe to batch.
			x = 0;
			while (x < cols) {
				var a2 = cells.attr[o + x];
				if (a2 & ATTR.WIDE_TAIL) { x++; continue; }
				var cp = cells.ch[o + x] || 32;
				if (cp === 32 && !(a2 & (ATTR.UNDER | ATTR.STRIKE))) { x++; continue; }
				if (a2 & ATTR.HIDDEN) { x++; continue; }
				var fg = a2 & ATTR.REVERSE ? colourOf(pal, cells.bg[o + x], defBg) : colourOf(pal, cells.fg[o + x], defFg);
				setFont(styleOf(a2));
				setAlpha((a2 & ATTR.DIM) ? 0.62 : 1);
				setFill(fg);
				var extra = (exts && exts[x]) || '';
				if (!runnable(cp) || extra) {
					// Off the safe path: draw the one cell, centred, so a wide
					// glyph or a fallback face lands where the grid says.
					var str = String.fromCodePoint(cp) + extra;
					var w = (a2 & ATTR.WIDE) ? 2 : 1;
					var adv = ctx.measureText(str).width;
					if (adv > 0 && (boxDrawing(cp) || adv > w * cw + 0.5)) {
						// Stretched to the cell rather than centred in it. A
						// box-drawing rule has to MEET its neighbour or a table
						// comes out as a row of disconnected dashes — the mono
						// faces this app names all draw those glyphs wider than
						// their advance so they join on their own, but a face
						// that does not would break every table, and stretching
						// costs nothing on the ones that do. The same stretch
						// pulls an oversized fallback glyph back inside its own
						// cell instead of letting it print over its neighbour.
						ctx.save();
						ctx.translate(x * cw, yTop + base);
						ctx.scale((w * cw) / adv, 1);
						ctx.fillText(str, 0, 0);
						ctx.restore();
						if (a2 & ATTR.UNDER) ctx.fillRect(x * cw, yTop + base + 2, w * cw, 1);
						if (a2 & ATTR.STRIKE) ctx.fillRect(x * cw, yTop + base - pal.size * 0.3, w * cw, 1);
						x += w;
						continue;
					}
					var dx = adv <= w * cw ? (w * cw - adv) / 2 : 0;
					ctx.fillText(str, x * cw + dx, yTop + base);
					if (a2 & ATTR.UNDER) ctx.fillRect(x * cw, yTop + base + 2, w * cw, 1);
					if (a2 & ATTR.STRIKE) ctx.fillRect(x * cw, yTop + base - pal.size * 0.3, w * cw, 1);
					x += w;
					continue;
				}
				var run = '', n2 = 0;
				while (x + n2 < cols) {
					var an = cells.attr[o + x + n2];
					var cn = cells.ch[o + x + n2] || 32;
					if (an !== a2 || cells.fg[o + x + n2] !== cells.fg[o + x] || cells.bg[o + x + n2] !== cells.bg[o + x]) break;
					if (!runnable(cn) || (exts && exts[x + n2])) break;
					run += String.fromCharCode(cn);
					n2++;
				}
				ctx.fillText(run, x * cw, yTop + base);
				if (a2 & ATTR.UNDER) ctx.fillRect(x * cw, yTop + base + 2, n2 * cw, 1);
				if (a2 & ATTR.STRIKE) ctx.fillRect(x * cw, yTop + base - pal.size * 0.3, n2 * cw, 1);
				x += n2;
			}
		}

		function paintCursor(cells) {
			var c = screen.cursor;
			if (!c.visible || c.y < 0 || c.y >= screen.rows) return;
			if (!focused()) {
				// Unfocused: an outline, so it is still findable but does not
				// claim to be taking your typing.
				ctx.strokeStyle = pal.cursor;
				ctx.lineWidth = 1;
				ctx.strokeRect(c.x * cw + 0.5, c.y * chh + 0.5, cw - 1, chh - 1);
				return;
			}
			if (!blinkOn) return;
			setAlpha(1);
			setFill(pal.cursor);
			if (c.shape === 'bar') { ctx.fillRect(c.x * cw, c.y * chh, Math.max(1, cw * 0.15), chh); return; }
			if (c.shape === 'underline') { ctx.fillRect(c.x * cw, c.y * chh + chh - 2, cw, 2); return; }
			ctx.fillRect(c.x * cw, c.y * chh, cw, chh);
			// The character under a block cursor is redrawn in the ground
			// colour, or the cursor swallows it.
			var o = c.y * screen.cols + c.x;
			var cp = cells.ch[o] || 32;
			if (cp !== 32) {
				setFont(styleOf(cells.attr[o]));
				setFill(pal.bg);
				ctx.fillText(String.fromCodePoint(cp), c.x * cw, c.y * chh + base);
			}
		}

		/// One frame. `force` repaints everything; otherwise the damage decides.
		function paint(force) {
			if (!alive) return;
			var d = screen.compose(force);
			var cells = screen.cells;
			var all = force || d.all || (sel && d.scrolled);
			if (all) {
				setAlpha(1);
				setFill(screen.modes.reverse ? pal.fg : pal.bg);
				ctx.fillRect(0, 0, screen.cols * cw, screen.rows * chh);
				for (var y = 0; y < screen.rows; y++) paintRow(y, cells);
			} else {
				if (d.scrolled > 0 && d.scrolled < screen.rows) {
					// The load case. Everything above the new lines is already
					// drawn correctly one row higher, so move the pixels rather
					// than the glyphs and draw only what is genuinely new.
					var shift = d.scrolled * chh;
					ctx.save();
					ctx.setTransform(1, 0, 0, 1, 0, 0);
					ctx.drawImage(canvas,
						0, shift * dpr, canvas.width, canvas.height - shift * dpr,
						0, 0, canvas.width, canvas.height - shift * dpr);
					ctx.restore();
				}
				for (var y2 = 0; y2 < screen.rows; y2++) if (d.rows[y2]) paintRow(y2, cells);
			}
			// The cell the cursor has left must be repainted, and the one it has
			// arrived at drawn over.
			if (!all && (lastCur.x !== screen.cursor.x || lastCur.y !== screen.cursor.y)) {
				if (lastCur.y >= 0 && lastCur.y < screen.rows && !d.rows[lastCur.y]) paintRow(lastCur.y, cells);
				if (screen.cursor.y >= 0 && !d.rows[screen.cursor.y]) paintRow(screen.cursor.y, cells);
			}
			paintCursor(cells);
			lastCur.x = screen.cursor.x; lastCur.y = screen.cursor.y;
			drawScrollHint();
		}

		/// A thumb down the right edge while there is history above. Drawn on the
		/// canvas rather than as a real scrollbar because the canvas IS the
		/// scrolling surface; there is no overflowing box for a browser to give
		/// a bar to.
		function drawScrollHint() {
			var sbLines = screen.scrollback();
			if (!sbLines) return;
			// The strip is CLEARED first. A blitted frame carries the previous
			// thumb up the canvas with it, so drawing the new one over the top
			// left a ghost of the old — and, worse, made the incremental frame
			// and the full repaint disagree, which is the one thing the blit is
			// not allowed to do.
			// On WHOLE pixels. The cell width is fractional by design, so a strip
			// placed at `cols * cw` has an antialiased edge that blends with
			// whatever lies under it — which differs between a blitted frame and
			// a repainted one, and that difference is a real, visible seam.
			var sx = Math.floor(screen.cols * cw) - 3;
			setAlpha(1);
			setFill(screen.modes.reverse ? pal.fg : pal.bg);
			ctx.fillRect(sx, 0, 3, screen.rows * chh);
			var total = sbLines + screen.rows;
			var h = Math.max(18, (screen.rows / total) * screen.rows * chh);
			var atTop = (sbLines - screen.viewOffset()) / sbLines;
			var y = atTop * (screen.rows * chh - h);
			setAlpha(screen.viewOffset() ? 0.55 : 0.22);
			setFill(pal.cursor);
			ctx.fillRect(sx, Math.round(y), 3, Math.round(h));
			setAlpha(1);
		}

		function schedule() {
			if (frame) return;
			frame = requestAnimationFrame(function () { frame = 0; paint(false); });
		}

		function focused() { return document.activeElement === input; }

		// ── the model's own voice ───────────────────────────
		screen.onBell = function () {
			root.classList.add('bell');
			setTimeout(function () { root.classList.remove('bell'); }, 160);
			if (onBell) onBell();
		};
		screen.onTitle = function (s) { if (onTitle) onTitle(s); };
		screen.onReply = function (s) { send(s); };

		// ── input ───────────────────────────────────────────

		function send(str) {
			if (!str) return;
			onData(enc.encode(str));
		}

		var composing = false;
		input.addEventListener('compositionstart', function () { composing = true; });
		input.addEventListener('compositionend', function (e) {
			composing = false;
			if (e.data) send(e.data);
			input.value = '';
		});
		// A soft keyboard on a phone reports keydown as 229 and delivers the
		// text here instead. Without this the terminal takes no typing at all on
		// Android.
		input.addEventListener('input', function () {
			if (composing) return;
			if (input.value) { send(input.value); input.value = ''; }
		});

		input.addEventListener('keydown', function (ev) {
			if (composing) return;
			// The shortcuts the TERMINAL owns, before the program sees anything.
			if (ev.ctrlKey && ev.shiftKey && !ev.altKey) {
				var kk = ev.key.toLowerCase();
				if (kk === 'c') { ev.preventDefault(); copy(); return; }
				// Ctrl-Shift-V is the browser's own paste, and it must be LEFT
				// ALONE: preventing it stops the paste event ever firing, so the
				// shortcut the hint tells people to use would do nothing at all.
				// Plain Ctrl-V is a different key — it sends \x16, readline's
				// quoted-insert — and IS prevented, further down.
				if (kk === 'v') return;
				if (kk === 'a') { ev.preventDefault(); selectAll(); return; }
			}
			if (ev.shiftKey && (ev.key === 'PageUp' || ev.key === 'PageDown')) {
				ev.preventDefault();
				scrollLines(ev.key === 'PageUp' ? -(screen.rows - 1) : (screen.rows - 1));
				return;
			}
			if (ev.shiftKey && ev.ctrlKey === false && ev.key === 'Home' && screen.viewOffset()) {
				ev.preventDefault(); scrollTo(screen.scrollback()); return;
			}
			var bytes = keyBytes(ev, screen.modes);
			if (bytes === null) return;		// not ours; let the browser have it
			ev.preventDefault();
			// Typing is a statement that you want to be where the program is.
			if (screen.viewOffset()) { screen.setViewOffset(0); schedule(); }
			if (sel) { sel = null; schedule(); }
			send(bytes);
		});

		// ── paste ───────────────────────────────────────────
		//
		// A multi-line paste into a shell runs every line the moment it arrives.
		// Bracketed paste exists to stop exactly that, and a program that has
		// asked for it gets the text wrapped so it can tell paste from typing.
		// A program that has NOT asked is the dangerous case, and it is the one
		// where the person is asked first.

		input.addEventListener('paste', function (ev) {
			ev.preventDefault();
			var text = (ev.clipboardData || window.clipboardData).getData('text');
			if (!text) return;
			pasteText(text);
		});

		function pasteText(text) {
			text = text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
			if (screen.modes.bracketed) {
				// The terminator must not appear inside the payload, or the
				// paste ends early and the rest is typed.
				send('\x1b[200~' + text.replace(/\x1b\[201~/g, '') + '\x1b[201~');
				return;
			}
			var lines = text.split('\r').filter(function (s, i, a) { return i < a.length - 1 || s.length; });
			if (lines.length <= 1) { send(text); return; }
			askPaste(text, lines);
		}

		/// The question, drawn inside the terminal rather than as a dialog: it
		/// belongs to this panel, and a modal over the whole app for a paste
		/// would be the wrong weight.
		function askPaste(text, lines) {
			paste.hidden = false;
			paste.innerHTML = '';
			var p = document.createElement('p');
			p.className = 'term-paste-say';
			p.textContent = t('term.paste_warn', { n: lines.length });
			var row = document.createElement('div');
			row.className = 'term-paste-row';
			function btn(label, cls, fn) {
				var b = document.createElement('button');
				b.type = 'button';
				b.className = 'term-paste-btn' + (cls ? ' ' + cls : '');
				b.textContent = label;
				b.addEventListener('click', function () { closePaste(); fn(); });
				row.appendChild(b);
				return b;
			}
			var first = btn(t('term.paste_first'), 'primary', function () { send(lines[0]); });
			btn(t('term.paste_all', { n: lines.length }), '', function () { send(text); });
			btn(t('common.cancel'), '', function () {});
			paste.appendChild(p);
			paste.appendChild(row);
			paste.addEventListener('keydown', escClose);
			first.focus();
		}
		function escClose(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); closePaste(); } }
		function closePaste() {
			paste.hidden = true;
			paste.innerHTML = '';
			paste.removeEventListener('keydown', escClose);
			input.focus();
		}

		// ── selection ───────────────────────────────────────
		//
		// A canvas has no text to select, so the whole of this is built: where
		// the pointer is in cells, what lies between two of those, and how it
		// reads back as text. Without it the terminal is one you cannot copy
		// from, which is one nobody will use.

		function cellAt(ev) {
			var box = canvas.getBoundingClientRect();
			var x = Math.floor((ev.clientX - box.left) / cw);
			var y = Math.floor((ev.clientY - box.top) / chh);
			return {
				col: Math.max(0, Math.min(screen.cols, x)),
				row: Math.max(0, Math.min(screen.rows - 1, y)),
			};
		}

		canvas.addEventListener('mousedown', function (ev) {
			if (ev.button !== 0) return;
			input.focus();
			// While a program is reading the mouse, the mouse is the program's —
			// unless Shift is held, which is the escape hatch every terminal has
			// for exactly this.
			if (screen.modes.mouse && !ev.shiftKey) { mouseReport(ev, 'down'); ev.preventDefault(); return; }
			var c = cellAt(ev);
			var a = { abs: screen.absOfRow(c.row), col: c.col };
			if (ev.detail === 2) { selectWord(c); return; }
			if (ev.detail >= 3) { selectRow(c); return; }
			sel = { a: a, b: { abs: a.abs, col: a.col }, rect: ev.altKey };
			dragging = true;
			paint(true);
			ev.preventDefault();
		});
		window.addEventListener('mousemove', function (ev) {
			if (!dragging) return;
			var c = cellAt(ev);
			sel.b = { abs: screen.absOfRow(c.row), col: c.col };
			paint(true);
		});
		window.addEventListener('mouseup', function (ev) {
			if (screen.modes.mouse && !dragging && !ev.shiftKey) { mouseReport(ev, 'up'); return; }
			if (!dragging) return;
			dragging = false;
			if (sel && sel.a.abs === sel.b.abs && sel.a.col === sel.b.col) { sel = null; paint(true); }
		});

		function selectWord(c) {
			var abs = screen.absOfRow(c.row);
			var text = screen.lineText(abs);
			var word = /[\w./~:@%+=-]/;
			var i = Math.min(c.col, text.length - 1), a = i, b = i;
			if (i < 0 || !word.test(text[i] || '')) { sel = null; paint(true); return; }
			while (a > 0 && word.test(text[a - 1])) a--;
			while (b < text.length - 1 && word.test(text[b + 1])) b++;
			sel = { a: { abs: abs, col: a }, b: { abs: abs, col: b + 1 }, rect: false };
			paint(true);
		}
		function selectRow(c) {
			var abs = screen.absOfRow(c.row);
			sel = { a: { abs: abs, col: 0 }, b: { abs: abs, col: screen.cols }, rect: false };
			paint(true);
		}
		function selectAll() {
			sel = { a: { abs: screen.absTop(), col: 0 },
				b: { abs: screen.absOfRow(screen.rows - 1), col: screen.cols }, rect: false };
			paint(true);
		}

		/// What is selected, as text.
		///
		/// A line the terminal itself wrapped is joined to the next, because it
		/// was one line before the width got in the way — a pasted path with a
		/// newline in the middle of it is not the path.
		function selectionText() {
			if (!sel) return '';
			var a = sel.a, b = sel.b;
			if (a.abs > b.abs || (a.abs === b.abs && a.col > b.col)) { a = sel.b; b = sel.a; }
			var out = [];
			for (var i = a.abs; i <= b.abs; i++) {
				var ln = screen.lineCells(i);
				if (!ln) continue;
				var from = sel.rect ? Math.min(a.col, b.col) : (i === a.abs ? a.col : 0);
				var to   = sel.rect ? Math.max(a.col, b.col) : (i === b.abs ? b.col : screen.cols);
				var s = '';
				for (var x = from; x < to && x < ln.ch.length; x++) {
					if (ln.attr[x] & ATTR.WIDE_TAIL) continue;
					s += (ln.ch[x] ? String.fromCodePoint(ln.ch[x]) : ' ') + (ln.ext && ln.ext[x] ? ln.ext[x] : '');
				}
				out.push({ text: s.replace(/\s+$/, ''), joined: !sel.rect && ln.wrap && i < b.abs });
			}
			var acc = '';
			for (var k = 0; k < out.length; k++) {
				acc += out[k].text;
				if (k < out.length - 1) acc += out[k].joined ? '' : '\n';
			}
			return acc;
		}

		function copy() {
			var text = selectionText();
			if (!text) { announce(t('term.nothing_selected')); return Promise.resolve(false); }
			var n = text.split('\n').length;
			var done = function () { announce(tn('term.copied', n)); return true; };
			if (navigator.clipboard && navigator.clipboard.writeText) {
				return navigator.clipboard.writeText(text).then(done, function () { return legacyCopy(text) && done(); });
			}
			return Promise.resolve(legacyCopy(text) && done());
		}
		function legacyCopy(text) {
			var ta = document.createElement('textarea');
			ta.value = text;
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.select();
			var ok = false;
			try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
			document.body.removeChild(ta);
			input.focus();
			return ok;
		}

		// ── the mouse, when the program is reading it ───────

		function mouseReport(ev, kind) {
			var c = cellAt(ev);
			var b = ev.button === 1 ? 1 : ev.button === 2 ? 2 : 0;
			if (kind === 'wheel') b = ev.deltaY < 0 ? 64 : 65;
			if (ev.shiftKey) b += 4;
			if (ev.altKey) b += 8;
			if (ev.ctrlKey) b += 16;
			if (screen.modes.mouseSgr) {
				send('\x1b[<' + b + ';' + (c.col + 1) + ';' + (c.row + 1) + (kind === 'up' ? 'm' : 'M'));
			} else {
				if (kind === 'up') b = 3;
				send('\x1b[M' + String.fromCharCode(32 + b, 32 + c.col + 1, 32 + c.row + 1));
			}
		}

		// ── scrolling ───────────────────────────────────────

		function scrollTo(n) { if (screen.setViewOffset(n)) paint(true); }
		function scrollLines(n) { scrollTo(screen.viewOffset() - n); }

		canvas.addEventListener('wheel', function (ev) {
			if (screen.modes.mouse) { mouseReport(ev, 'wheel'); ev.preventDefault(); return; }
			if (screen.modes.alt) {
				// A full-screen program has no scrollback of its own, so the
				// wheel becomes the arrow keys — which is what makes `less` and
				// `vim` answer a trackpad at all.
				var n = ev.deltaY < 0 ? 3 : 3;
				var k = ev.deltaY < 0 ? 'A' : 'B';
				var s = '';
				for (var i = 0; i < n; i++) s += (screen.modes.appCursor ? '\x1bO' : '\x1b[') + k;
				send(s);
				ev.preventDefault();
				return;
			}
			scrollLines(ev.deltaY < 0 ? -3 : 3);
			ev.preventDefault();
		}, { passive: false });

		// ── what a screen reader is told ────────────────────
		//
		// The canvas is a picture, and a picture of a terminal is nothing at all
		// to a screen reader. Two separate things are provided, because they
		// answer two different questions.
		//
		//   The LOG says what has just happened, once the output has settled.
		//   Announcing as it arrives would recite a build log at the reader for
		//   as long as the build ran — the same reasoning the guide gives for
		//   announcing an answer once rather than as it is typed. So nothing is
		//   said until the bytes stop for SETTLE_MS, and a torrent is summarised
		//   rather than read.
		//
		//   The MIRROR is the transcript, kept as ordinary text a reader can
		//   arrow through at their own pace, updated on the same settling.
		//
		// What this does NOT achieve, and it should be said rather than implied:
		// no colour or emphasis is conveyed; the cursor's position is not
		// announced as it moves; a full-screen program that redraws in place
		// (`vim`, `top`) gives a snapshot with no narrative, so a reader is told
		// what the screen says and not what changed; and there is no braille
		// cursor routing.

		function announce(text) {
			if (!text) return;
			var p = document.createElement('p');
			p.textContent = text;
			say.appendChild(p);
			while (say.childNodes.length > 4) say.removeChild(say.firstChild);
		}

		function settle() {
			var last = screen.absOfRow(screen.rows - 1);
			var first = screen.absTop();
			if (saidTo < first - 1) saidTo = first - 1;
			var lines = [];
			for (var a = saidTo + 1; a <= last; a++) {
				var s = screen.lineText(a);
				if (s) lines.push(s);
			}
			saidTo = last;
			if (screen.modes.alt) {
				// A redraw is not a transcript. Say what is on the screen now.
				announce(t('term.screen_now') + ' ' + visibleText());
			} else if (lines.length > SAY_MAX) {
				announce(tn('term.printed_lines', lines.length)
					+ ' ' + lines.slice(-SAY_MAX).join('. '));
			} else if (lines.length) {
				announce(lines.join('. '));
			}
			mirrorNow();
			wroteSince = 0;
		}

		function visibleText() {
			var out = [];
			for (var y = 0; y < screen.rows; y++) {
				var s = screen.lineText(screen.absOfRow(y));
				if (s) out.push(s);
			}
			return out.join('. ');
		}

		function mirrorNow() {
			var frag = document.createDocumentFragment();
			for (var y = 0; y < screen.rows; y++) {
				var d = document.createElement('div');
				d.textContent = screen.lineText(screen.absOfRow(y)) || ' ';
				frag.appendChild(d);
			}
			mirror.innerHTML = '';
			mirror.appendChild(frag);
		}

		// ── the handle ──────────────────────────────────────

		function write(data) {
			screen.write(data);
			wroteSince++;
			schedule();
			clearTimeout(settleTimer);
			settleTimer = setTimeout(settle, SETTLE_MS);
		}

		/// Bytes as the wire carries them. Base64 is decoded here rather than by
		/// the caller so a chunk boundary in the middle of a UTF-8 character is
		/// the model's problem, which it already handles.
		function writeBase64(s) {
			var bin = atob(s);
			var u8 = new Uint8Array(bin.length);
			for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
			write(u8);
		}

		// Focus is drawn on the wrapper, outside the canvas, against the panel
		// behind it — see terminal.css. Nothing is done here beyond repainting,
		// because the cursor's own look changes with focus.
		input.addEventListener('focus', function () { blinkOn = true; paint(true); });
		input.addEventListener('blur', function () { paint(true); });

		function startBlink() {
			clearInterval(blinkTimer);
			if (reduced && reduced.matches) { blinkOn = true; return; }
			blinkTimer = setInterval(function () {
				if (!focused() || !screen.cursor.visible) return;
				blinkOn = !blinkOn;
				paint(false);
			}, BLINK_MS);
		}
		startBlink();
		if (reduced && reduced.addEventListener) reduced.addEventListener('change', startBlink);

		// The palette can change under us at any moment. `data-theme` is what
		// the app stamps, so watching it is watching the actual event rather
		// than guessing from a custom one that may or may not be dispatched.
		var themeWatch = new MutationObserver(function () { measure(); paint(true); });
		themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-ink', 'data-skin', 'style'] });

		var ro = null, roTimer = 0;
		if (window.ResizeObserver) {
			ro = new ResizeObserver(function () {
				// Debounced: a drag of a panel edge fires this on every frame,
				// and each one would be a `TIOCSWINSZ` and a SIGWINCH to the
				// program. Programs redraw on that, so an undebounced resize is
				// a hundred full redraws while the mouse is moving.
				clearTimeout(roTimer);
				roTimer = setTimeout(function () { fit(false); }, 120);
			});
			ro.observe(root);
		}

		if (document.fonts && document.fonts.ready) {
			document.fonts.ready.then(function () { if (alive) fit(true); });
		}
		fit(true);
		mirrorNow();

		var handle = {
			el:     root,
			screen: screen,
			write:  write,
			writeBase64: writeBase64,
			/// Text straight into the model, for a note the terminal itself is
			/// making — an exit status, a refusal — never program output.
			say: function (line) { write('\r\n' + line + '\r\n'); },
			send:   send,
			size:   function () { return { cols: screen.cols, rows: screen.rows }; },
			cell:   function () { return { w: cw, h: chh }; },
			fit:    function () { fit(false); },
			focus:  function () { input.focus(); },
			paste:  pasteText,
			copy:   copy,
			selection: selectionText,
			selectAll: selectAll,
			clearSelection: function () { sel = null; paint(true); },
			scrollLines: scrollLines,
			scrollToBottom: function () { scrollTo(0); },
			reset:  function () { screen.reset(); sel = null; saidTo = -1; paint(true); },
			palette: function () { return pal; },
			destroy: function () {
				alive = false;
				clearInterval(blinkTimer);
				clearTimeout(settleTimer);
				clearTimeout(roTimer);
				if (ro) ro.disconnect();
				themeWatch.disconnect();
				if (frame) cancelAnimationFrame(frame);
				if (root.parentNode) root.parentNode.removeChild(root);
			},
			/// Test only: paint synchronously rather than waiting for a frame.
			/// `_paintNow` forces the whole grid; `_paintFrame` is the ordinary
			/// frame, which is the one the damage model actually decides.
			_paintNow: function () { paint(true); },
			_paintFrame: function () { paint(false); },
		};
		return handle;
	}

	window.DaimondTerminal = {
		create: create,
		/// The screen model on its own, for a test or a future host that wants
		/// the grid without the drawing.
		screen: createScreen,
		charWidth: charWidth,
		ATTR: ATTR,
		/// Bytes as base64, which is how the hand's wire carries them.
		b64: function (u8) {
			var s = '';
			for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
			return btoa(s);
		},
	};
})();
