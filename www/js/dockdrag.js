/* dockdrag.js — carry a panel into a slot of the Dock, and see where it lands.
 *
 * The Dock's arrangement used to be a CONSEQUENCE. Its state was one flat list
 * of panels "in the order they were opened", and seating was round robin at
 * draw time: panel i went to column i % cols. So a panel's position was decided
 * by the order it happened to be opened in and by how many columns the chosen
 * tiling had, and the only route to a different arrangement was to close panels
 * and open them again in the order you wanted -- six clicks to move the fourth
 * panel of four to the first slot, and no route at all to "Email above the
 * Workspace in the same column".
 *
 * The Dock's state is now COLUMNS: `[['work','mail'], ['agents']]`, left to
 * right and top to bottom, and this file is how a hand changes it. The design is
 * the tab strip's rather than the five-region overlay's, because the Dock is
 * columns of rows and not a canvas: an insertion line between two rows, a band
 * at either edge for a new column, a box over a panel to take its place, and the
 * tear-off for "out of the Dock altogether".
 *
 * TWO HALVES, and the first has no DOM in it.
 *
 *   PURE   `migrate`, `caps`, `zones`, `pick`, `applyDrop`, `keyStep`. Arithmetic
 *          over measured rectangles and lists of ids. Proved under node in
 *          `www/js/dockdrag.test.mjs`, with no browser: what a drop DOES to an
 *          arrangement is a claim about arrays, and settling it in a headless
 *          browser would be settling it slowly and less completely.
 *   DOM    `bind`. The gesture, the ghost, the overlay, the keyboard mode and
 *          the phone's chip strip. It reads rectangles from the document, writes
 *          nothing but the overlay, and reaches the engine only through
 *          `DaimondPanels.dock() / .dockRoom() / .placeDock() / .userHide()`.
 *
 * NEITHER THE GESTURE NOR THE NEAREST-CANDIDATE SEARCH IS WRITTEN HERE. The
 * press-and-drag recogniser is `www/js/gesture.js`, shared with the Graph, so a
 * hand meets one answer for how far a press travels before it is a drag and how
 * long a finger rests before it is one. The search is `DaimondGraphGeom.nearest`,
 * shared for the same reason: which slot a pointer is over and which anchor a
 * link snaps to are the same question asked of different rectangles, and two
 * implementations would settle a tie two ways on one app's two surfaces.
 */
(function () {
	'use strict';

	// ── The pure half ─────────────────────────────────────────

	/// The floors the Dock is measured against, when a caller does not say. The
	/// engine's own `MIN_W` and `MIN_H`, and they are ITS numbers: passed in, so
	/// that this file cannot drift from the widths the panels are actually
	/// clamped to.
	var FLOORS = { dock: 260, stage: 380, stack: 120, handle: 10 };
	/// How wide the band at either edge of the Dock is -- the one that offers a
	/// new column rather than a slot in an existing one.
	var EDGE = 40;
	/// How far outside a zone's band a pointer may be and still be asking for it.
	///
	/// Not nought, and the gaps are why: a column puts 8-10px between two panels
	/// and a divider stands in the same place, so a release aimed exactly at the
	/// boundary between two rows would land on nothing at all and read as "out of
	/// the Dock" -- which, for a panel already placed, closes it. Twelve covers
	/// every gap the layout draws and is far short of the stage.
	var REACH = 12;

	function copy(cols) { return (cols || []).map(function (c) { return c.slice(); }); }

	/// Where a panel sits, or nothing.
	function at(cols, id) {
		for (var c = 0; c < cols.length; c++) {
			var r = cols[c].indexOf(id);
			if (r !== -1) return { col: c, row: r };
		}
		return null;
	}

	function flat(cols) {
		var out = [];
		(cols || []).forEach(function (c) { out = out.concat(c); });
		return out;
	}

	/// Is this an arrangement of columns, rather than the flat list that came
	/// before it?
	function isColumns(v) {
		return Array.isArray(v) && (v.length === 0 || Array.isArray(v[0]));
	}

	/// Read a stored Dock, whichever of the two shapes it is in.
	///
	/// A v1 record is the flat list the Dock kept until 2026-09-15, and it is
	/// round-robinned into `cols` columns -- which is exactly what `apply()` did
	/// to it at draw time, so an arrangement upgraded by this function is drawn
	/// in the same slots it was drawn in before the upgrade. Nothing moves.
	///
	/// A v2 record is already columns and is only tidied: empty columns go, and
	/// so does anything that is not a string, since a column of nothing is a
	/// column the layout would give width to and draw nothing in.
	function migrate(dock, cols) {
		if (isColumns(dock)) {
			return (dock || []).map(function (c) {
				return (Array.isArray(c) ? c : []).filter(function (x) { return typeof x === 'string'; });
			}).filter(function (c) { return c.length; });
		}
		var ids = (dock || []).filter(function (x) { return typeof x === 'string'; });
		var n = Math.max(1, Math.min(cols || 1, ids.length));
		var out = [];
		for (var i = 0; i < n; i++) out.push([]);
		ids.forEach(function (id, i) { out[i % n].push(id); });
		return out.filter(function (c) { return c.length; });
	}

	/// The flat list a v1 record would have held for this arrangement: across
	/// the columns, then down.
	///
	/// The inverse of [migrate]'s round robin, and it has to be, because a preset
	/// chosen after a drag redistributes THIS list. Reading a column at a time
	/// instead would seat the panels somewhere the preset has never put them.
	function unmigrate(cols) {
		var out = [], depth = 0;
		(cols || []).forEach(function (c) { depth = Math.max(depth, c.length); });
		for (var r = 0; r < depth; r++) {
			for (var c = 0; c < cols.length; c++) if (cols[c][r]) out.push(cols[c][r]);
		}
		return out;
	}

	/// How many columns and how many rows the room will carry.
	///
	/// DERIVED from the floors and what has been measured, never a constant:
	/// that was the whole complaint against `dockMax`, which was the number of
	/// dock panels that happened to exist when it was written. A column is worth
	/// offering only if it can be `MIN_W.dock` wide without pushing the stage's
	/// seats under `MIN_W.stage`; a row only if it can be `MIN_H.stack` tall.
	///
	/// # Arguments
	/// * `room`   - `{ mainW, railW, stageSeats, colH }`, in CSS pixels. `railW`
	///              includes the rail's own divider, or is nought when folded.
	/// * `floors` - The engine's `MIN_W`/`MIN_H`, as `{ dock, stage, stack, handle }`.
	function caps(room, floors) {
		var f = floors || FLOORS;
		var seats = Math.max(1, (room && room.stageSeats) || 1);
		var stageNeed = seats * f.stage + (seats - 1) * f.handle;
		var spare = ((room && room.mainW) || 0) - ((room && room.railW) || 0) - stageNeed - f.handle;
		var maxCols = Math.floor(spare / f.dock);
		var maxRows = Math.floor(((room && room.colH) || 0) / f.stack);
		return {
			maxCols: Math.max(1, isFinite(maxCols) ? maxCols : 1),
			maxRows: Math.max(1, isFinite(maxRows) ? maxRows : 1),
		};
	}

	/// Every slot the Dock is offering, as rectangles to hit and rectangles to
	/// draw.
	///
	/// # Arguments
	/// * `cols`   - The arrangement: an array of columns of panel ids.
	/// * `rects`  - What has been measured: `{ dock, cols: [], panels: {}, colW }`,
	///              every rectangle `{ x, y, w, h }` in the pointer's own
	///              coordinates. `dock` is where the Dock is, or -- when it holds
	///              nothing and is therefore not drawn -- where it would be.
	/// * `cap`    - `{ maxCols, maxRows }` from [caps].
	/// * `dragId` - What is being carried, so its own slot is not offered as a
	///              swap and so a column it is leaving is counted as it will be.
	///
	/// Each zone is `{ kind, col, row, rect, hit }`. `rect` is drawn; `hit` is
	/// where the pointer must be. THE EDGE BANDS COME FIRST, and that order is
	/// load-bearing: they lie over the first and last columns' own rows, and
	/// [pick] gives a tie to the earlier candidate.
	function zones(cols, rects, cap, dragId) {
		var out = [];
		var colR  = (rects && rects.cols) || [];
		var panR  = (rects && rects.panels) || {};
		var dockR = rects && rects.dock;
		var colW  = (rects && rects.colW) || FLOORS.dock;
		var maxCols = (cap && cap.maxCols) || 1;
		var maxRows = (cap && cap.maxRows) || 1;
		var from = at(cols, dragId);
		// A column the dragged panel is the whole of goes when it leaves, so the
		// arrangement it would be replaced by is one column shorter.
		var loses = (from && cols[from.col].length === 1) ? 1 : 0;

		// An empty Dock has no column to slot into and exactly one place to go:
		// a placeholder at the right edge, where the Dock itself would be.
		if (!cols.length) {
			if (!dockR) return out;
			var ph = { x: dockR.x + dockR.w - colW, y: dockR.y, w: colW, h: dockR.h };
			out.push({ kind: 'empty', col: 0, row: 0, rect: ph,
				hit: { x: ph.x - EDGE, y: ph.y, w: ph.w + EDGE, h: ph.h } });
			return out;
		}

		if (dockR && cols.length + 1 - loses <= maxCols) {
			out.push({ kind: 'newcol', col: 0, row: 0,
				rect: { x: dockR.x, y: dockR.y, w: colW, h: dockR.h },
				hit:  { x: dockR.x, y: dockR.y, w: EDGE, h: dockR.h } });
			out.push({ kind: 'newcol', col: cols.length, row: 0,
				rect: { x: dockR.x + dockR.w - colW, y: dockR.y, w: colW, h: dockR.h },
				hit:  { x: dockR.x + dockR.w - EDGE, y: dockR.y, w: EDGE, h: dockR.h } });
		}

		cols.forEach(function (ids, c) {
			var cr = colR[c];
			if (!cr) return;
			// A column already at its row cap is offered no insertion -- except to
			// the panel already living in it, which is moving within the column and
			// so does not make it any taller.
			var room = (from && from.col === c) || (ids.length + 1 <= maxRows);
			ids.forEach(function (id, r) {
				var pr = panR[id];
				if (!pr) return;
				// The top of a panel means "above this one", the bottom "below it",
				// and the middle third "instead of it". Thirds rather than halves,
				// because a swap needs a target a hand can actually hit.
				var third = pr.h / 3;
				if (room) out.push({ kind: 'before', col: c, row: r,
					rect: { x: cr.x, y: pr.y, w: cr.w, h: 0 },
					hit:  { x: pr.x, y: pr.y, w: pr.w, h: third } });
				if (id !== dragId) out.push({ kind: 'replace', col: c, row: r,
					rect: { x: pr.x, y: pr.y, w: pr.w, h: pr.h },
					hit:  { x: pr.x, y: pr.y + third, w: pr.w, h: third } });
				if (room) out.push({ kind: 'after', col: c, row: r,
					rect: { x: cr.x, y: pr.y + pr.h, w: cr.w, h: 0 },
					hit:  { x: pr.x, y: pr.y + pr.h - third, w: pr.w, h: third } });
			});
		});
		return out;
	}

	/// The zone a point is in, or nothing -- which means out of the Dock.
	///
	/// `DaimondGraphGeom.nearest` and no search of its own: see the header. It
	/// answers nought for a point inside a rectangle, so the tolerance only
	/// matters for the gaps between the bands.
	function pick(zs, x, y, tol) {
		var G = (typeof window !== 'undefined') ? window.DaimondGraphGeom : null;
		if (!G || !zs || !zs.length) return null;
		var cands = zs.map(function (z) { return { rect: z.hit, z: z }; });
		var got = G.nearest(cands, { x: x, y: y }, tol === undefined ? REACH : tol);
		return got ? got.cand.z : null;
	}

	/// The arrangement a drop makes. Never loses a panel, never breaks a cap,
	/// never leaves an empty column standing, and is a no-op on the panel's own
	/// slot.
	///
	/// A panel DISPLACED out of the Dock -- the one a chip replaced, which had no
	/// slot to be given in return -- is simply absent from the answer. The caller
	/// reads that off the difference and closes it, so there is one statement of
	/// where a panel went rather than two that can disagree.
	function applyDrop(cols, dragId, zone, cap) {
		var same = copy(cols);
		if (!zone || !dragId) return same;
		var next = copy(cols);
		var from = at(next, dragId);

		if (zone.kind === 'replace') {
			var target = (next[zone.col] || [])[zone.row];
			if (!target || target === dragId) return same;
			next[zone.col][zone.row] = dragId;
			// A panel that HAD a slot gives it to the one it displaced. A chip had
			// none, so the displaced panel leaves.
			if (from) next[from.col][from.row] = target;
			return tidy(next, cap, same);
		}
		if (zone.kind === 'empty') return tidy([[dragId]], cap, same);

		// Its own boundary is not a move, and the question is asked BEFORE the
		// removal, while the rows are still the ones the zone was computed from.
		if (from && from.col === zone.col && zone.row === from.row
			&& (zone.kind === 'before' || zone.kind === 'after')) return same;

		if (from) next[from.col].splice(from.row, 1);

		if (zone.kind === 'newcol') {
			var where = zone.col;
			// The removal may have just emptied a column to the left of the edge
			// that was asked for, which shifts every column after it.
			if (from && next[from.col].length === 0 && from.col < where) where--;
			next.splice(Math.max(0, where), 0, [dragId]);
			return tidy(next, cap, same);
		}
		var col = next[zone.col];
		if (!col) return same;
		var i = zone.row + (zone.kind === 'after' ? 1 : 0);
		if (from && from.col === zone.col && from.row < i) i--;
		col.splice(Math.max(0, Math.min(i, col.length)), 0, dragId);
		return tidy(next, cap, same);
	}

	/// Drop the empty columns, and refuse outright anything that would break a
	/// cap.
	///
	/// RELATIVE TO WHAT WAS ALREADY THERE, and that is the care in this. An
	/// arrangement can be over a cap before anything is dragged at all -- a
	/// preset's cells are the preset's own answer and take no notice of the room,
	/// and a window narrowed under a custom layout leaves every column too tall
	/// until the fold catches up. An absolute test refuses every drop in that
	/// state, including the ones that would MEND it: measured on a 300px-tall
	/// Dock of four, where a swap into a full column was rejected because the
	/// column it was already in had four rows. So a drop is refused only when it
	/// makes the arrangement worse than it found it.
	function tidy(next, cap, was) {
		var out = next.filter(function (c) { return c.length; });
		if (!cap) return out;
		var hadRows = 0;
		(was || []).forEach(function (c) { hadRows = Math.max(hadRows, c.length); });
		var hadCols = (was || []).length;
		if (cap.maxCols && out.length > cap.maxCols && out.length > hadCols) return was;
		for (var i = 0; i < out.length; i++) {
			if (cap.maxRows && out[i].length > cap.maxRows && out[i].length > hadRows) return was;
		}
		return out;
	}

	/// Which boundary a zone is: `before` row r and `after` row r-1 are the same
	/// place, so they answer the same number.
	function ord(z) { return z.row + (z.kind === 'after' ? 1 : 0); }

	/// The boundaries of one column, in order, with the duplicates folded away.
	function boundaries(zs, col) {
		var seen = {}, out = [];
		zs.forEach(function (z) {
			if (z.col !== col) return;
			if (z.kind !== 'before' && z.kind !== 'after') return;
			var k = ord(z);
			if (seen[k]) return;
			seen[k] = 1;
			out.push(z);
		});
		return out.sort(function (a, b) { return ord(a) - ord(b); });
	}

	/// The zone an arrow key asks for next, or the one it was already on when
	/// there is nowhere further to go.
	///
	/// Up and down walk the boundaries of the column; left and right cross to the
	/// same height in the neighbouring column, or to the new column the edge
	/// offers when there is no neighbour left to reach. The keyboard does not
	/// reach `replace`: a swap is a two-panel act and the arrows name one place.
	function keyStep(zs, current, dir) {
		var news = (zs || []).filter(function (z) { return z.kind === 'newcol' || z.kind === 'empty'; });
		if (!current) {
			var first = (zs || []).filter(function (z) {
				return z.kind === 'before' || z.kind === 'after';
			});
			return first[0] || news[0] || null;
		}
		if (current.kind === 'newcol' || current.kind === 'empty') {
			// Off an edge band, sideways goes back into the Dock it is beside.
			var back = boundaries(zs, current.col === 0 ? 0 : current.col - 1);
			if ((dir === 'right' && current.col === 0) || (dir === 'left' && current.col !== 0)) {
				return back[0] || current;
			}
			return current;
		}
		var here = boundaries(zs, current.col);
		var i = here.map(ord).indexOf(ord(current));
		if (dir === 'up' || dir === 'down') {
			var j = i + (dir === 'down' ? 1 : -1);
			return (j >= 0 && j < here.length) ? here[j] : current;
		}
		var want = current.col + (dir === 'right' ? 1 : -1);
		var near = boundaries(zs, want);
		if (near.length) return near[Math.min(Math.max(0, i), near.length - 1)];
		var edge = news.filter(function (z) {
			return dir === 'right' ? z.col > current.col : z.col <= current.col;
		});
		return edge.length ? edge[dir === 'right' ? edge.length - 1 : 0] : current;
	}

	var PURE = {
		migrate: migrate, unmigrate: unmigrate, caps: caps, zones: zones,
		pick: pick, applyDrop: applyDrop, keyStep: keyStep, at: at, flat: flat,
		boundaries: boundaries, ord: ord,
		FLOORS: FLOORS, EDGE: EDGE, REACH: REACH,
	};
	if (typeof document === 'undefined') { window.DaimondDockDrag = PURE; return; }

	// ── The impure half: the gesture, the ghost and the overlay ──

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }
	function P() { return window.DaimondPanels; }
	function say(msg) {
		var out = document.getElementById('copy-say');
		if (out) out.textContent = msg;
	}

	var overlay = null, line = null, box = null, colOut = null;
	var ghost = null, live = null, keys = null;

	function build() {
		if (overlay) return overlay;
		overlay = document.createElement('div');
		overlay.id = 'dock-drop';
		overlay.hidden = true;
		line   = document.createElement('div'); line.className   = 'ddz-line';
		box    = document.createElement('div'); box.className    = 'ddz-box';
		colOut = document.createElement('div'); colOut.className = 'ddz-col';
		[line, box, colOut].forEach(function (e) { e.hidden = true; overlay.appendChild(e); });
		document.body.appendChild(overlay);
		return overlay;
	}

	function put(el, r) {
		el.style.left   = r.x + 'px';
		el.style.top    = r.y + 'px';
		el.style.width  = Math.max(0, r.w) + 'px';
		el.style.height = Math.max(0, r.h) + 'px';
		el.hidden = false;
	}

	/// The insertion line sits ON a boundary, so it is given no height of its
	/// own: the stylesheet's weight is the line, and writing a height here would
	/// overrule it with the nought the boundary rectangle carries.
	function putLine(r) {
		line.style.left   = r.x + 'px';
		line.style.top    = r.y + 'px';
		line.style.width  = Math.max(0, r.w) + 'px';
		line.hidden = false;
	}

	/// Draw the one indicator this zone means, and nothing else. No text on any
	/// of them: the shape is the whole message.
	function draw(zone) {
		build();
		[line, box, colOut].forEach(function (e) { e.hidden = true; });
		if (!zone) { overlay.hidden = true; return; }
		overlay.hidden = false;
		if (zone.kind === 'before' || zone.kind === 'after') putLine(zone.rect);
		else if (zone.kind === 'replace') put(box, zone.rect);
		else put(colOut, zone.rect);
	}

	function rectOf(el) {
		var r = el.getBoundingClientRect();
		return { x: r.left, y: r.top, w: r.width, h: r.height };
	}

	/// Measure the Dock once, at the lift.
	///
	/// ONCE, and not per move: a rectangle read on every pointer event is a
	/// layout flush on every pointer event, and nothing under the pointer moves
	/// during a drag anyway -- the overlay is the only thing that does, and it is
	/// out of flow. A `ResizeObserver` re-measures if the window changes shape
	/// mid-gesture.
	function measure() {
		var dockEl = document.getElementById('dock');
		var mainEl = document.getElementById('main');
		var cols = P().dock();
		var out = { cols: [], panels: {}, colW: PURE.FLOORS.dock };
		var drawn = dockEl ? [].slice.call(dockEl.querySelectorAll('.pcol')).filter(function (c) {
			return c.getClientRects().length;
		}) : [];
		if (cols.length && dockEl && dockEl.getClientRects().length) {
			out.dock = rectOf(dockEl);
			out.cols = drawn.map(rectOf);
			if (out.cols.length) out.colW = out.cols[0].w;
			PURE.flat(cols).forEach(function (id) {
				var el = document.querySelector('.panel[data-panel="' + id + '"]');
				if (el && el.getClientRects().length) out.panels[id] = rectOf(el);
			});
		} else if (mainEl) {
			// Nothing docked, so there is no Dock to measure: the placeholder goes
			// where one would be drawn, at the right-hand edge of the row.
			var m = rectOf(mainEl);
			out.dock = { x: m.x + m.w - PURE.FLOORS.dock, y: m.y, w: PURE.FLOORS.dock, h: m.h };
		}
		return out;
	}

	function zoneList(dragId) {
		var cols = P().dock();
		return PURE.zones(cols, measure(), P().dockRoom(), dragId);
	}

	// ── The ghost ─────────────────────────────────────────────

	/// A clone of the panel's chip, from either source. ONE language for both:
	/// a thumbnail of the panel for a header drag and a chip for a chip drag
	/// would be two answers to "what am I carrying".
	function makeGhost(id, label) {
		var src = document.querySelector('#panel-tags .ptag[data-panel="' + id + '"]');
		var g;
		if (src) {
			g = src.cloneNode(true);
			g.removeAttribute('id');
			g.disabled = false;
		} else {
			g = document.createElement('button');
			g.className = 'ptag ptag-dock';
			g.textContent = label || id;
		}
		g.classList.add('ptag-ghost');
		g.classList.remove('on');
		var x = document.createElement('span');
		x.className = 'gx';
		x.textContent = '×';
		x.hidden = true;
		g.appendChild(x);
		document.body.appendChild(g);
		return g;
	}

	function moveGhost(pt) {
		if (!ghost) return;
		ghost.style.transform = 'translate(' + (pt.clientX + 12) + 'px,' + (pt.clientY + 12) + 'px)';
	}

	function dropGhost() {
		if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
		ghost = null;
	}

	// ── One drag ──────────────────────────────────────────────

	function begin(ctx, ev) {
		live = ctx;
		ctx.zones = zoneList(ctx.id);
		ctx.zone = null;
		ghost = makeGhost(ctx.id, ctx.label);
		if (ev) moveGhost({ clientX: ev.clientX, clientY: ev.clientY });
		document.body.classList.add('dock-dragging');
		if (ctx.el) ctx.el.classList.add('dragging');
		draw(null);
	}

	function over(pt) {
		if (!live) return;
		live.zone = PURE.pick(live.zones, pt.clientX, pt.clientY);
		moveGhost(pt);
		draw(live.zone);
		// Out of every zone the ghost says what a release would do: close, for a
		// panel that has a slot; nothing at all, for a chip that has not.
		var out = !live.zone && live.placed;
		var gx = ghost && ghost.querySelector('.gx');
		if (gx) gx.hidden = !out;
		// ONCE PER CROSSING, not once per frame. The cross is the whole message
		// for anybody who can see it; this is the same message for anybody who
		// cannot, and repeating it every sixteen milliseconds would be a reader
		// talked over by its own pointer.
		if (out !== live.said) {
			live.said = out;
			if (out) say(t('dock.drop_close'));
		}
	}

	function end(commit) {
		var ctx = live;
		live = null;
		draw(null);
		dropGhost();
		document.body.classList.remove('dock-dragging');
		if (ctx && ctx.el) ctx.el.classList.remove('dragging');
		if (!ctx || !commit) return;
		if (ctx.zone) {
			if (P().placeDock(ctx.id, ctx.zone)) say(t('dock.moved', { name: ctx.label }));
			return;
		}
		// Out of the Dock: a panel that had a slot is put away, a chip that never
		// had one is left exactly as it was.
		if (ctx.placed) P().userHide(ctx.id);
	}

	/// What a press on this element means, or nothing.
	///
	/// # Arguments
	/// * `el`   - The element naming the panel: a chip, or the panel itself.
	/// * `mark` - What goes dim while the ghost is away, when that is not `el`.
	///            A header drag dims its HEADER and not the whole panel: the
	///            panel is where the user is still reading what they are moving.
	function claim(el, mark) {
		if (!el) return null;
		var id = el.dataset.panel;
		if (!id || P().zone(id) !== 'dock') return null;
		var m = (P().model().panels || []).filter(function (p) { return p.id === id; })[0];
		return { id: id, label: (m && m.label) || id, el: mark || el,
			placed: !!PURE.at(P().dock(), id) };
	}

	// ── The keyboard ──────────────────────────────────────────
	//
	// The same zones, walked rather than pointed at. A heading that can be
	// focused and arrows that move it is the whole of the pointer gesture for
	// somebody who has no pointer, and the overlay is the same overlay -- the
	// alternative was a second, smaller design that would have drifted.

	function keyEnter(id, label) {
		var zs = zoneList(id);
		if (!zs.length) return false;
		var cols = P().dock();
		var from = PURE.at(cols, id);
		var start = null;
		if (from) {
			start = zs.filter(function (z) {
				return z.kind === 'before' && z.col === from.col && z.row === from.row;
			})[0];
		}
		keys = { id: id, label: label, zones: zs, zone: start || PURE.keyStep(zs, null, 'down') };
		// NOT `body.dock-dragging`: that class says a pointer is being held, and
		// it turns the cursor into a fist and takes selection away from the whole
		// page. Nothing is being held here.
		draw(keys.zone);
		say(t('dock.keys'));
		return true;
	}

	function keyLeave(place) {
		if (!keys) return;
		var k = keys;
		keys = null;
		draw(null);
		if (place && k.zone && P().placeDock(k.id, k.zone)) say(t('dock.moved', { name: k.label }));
	}

	var ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

	function onHeadKey(ev, id, label) {
		var dir = ARROWS[ev.key];
		if (dir) {
			ev.preventDefault();
			if (!keys && !keyEnter(id, label)) return;
			keys.zone = PURE.keyStep(keys.zones, keys.zone, dir);
			draw(keys.zone);
			return;
		}
		if (!keys) {
			if (ev.key === 'Delete') { ev.preventDefault(); P().userHide(id); }
			return;
		}
		if (ev.key === 'Enter')  { ev.preventDefault(); keyLeave(true);  return; }
		if (ev.key === 'Escape') { ev.preventDefault(); keyLeave(false); return; }
	}

	/// Make every docked panel's heading a place the keyboard can reach, and say
	/// what it does. Re-run after each layout pass, since a panel that has just
	/// been seated has a heading nobody has marked yet.
	function markHeads() {
		// The phone's strip says once how it is reordered, on the ROW rather than
		// on each chip: a hint repeated fourteen times is a hint read over.
		//
		// A `title`, which is what the rest of this app uses and what a browser
		// falls back on for an element's accessible description -- `aria-
		// description` says it more exactly and is ARIA 1.3, so it reaches some
		// of the engines this ships to and not others. Only on a phone, where
		// there is no hover for a title to pop up over and no other way to learn
		// the gesture.
		var row = document.getElementById('panel-tags');
		if (row) {
			if (isPhone()) row.title = t('chip.reorder');
			else row.removeAttribute('title');
		}
		[].slice.call(document.querySelectorAll('.panel[data-zone="dock"] .railhead')).forEach(function (h) {
			var span = h.querySelector('[role="heading"]');
			var panel = h.closest ? h.closest('.panel[data-panel]') : null;
			if (!span || !panel) return;
			var id = panel.dataset.panel;
			span.title = t('dock.drag');
			if (span.dataset.dockKeys) return;
			span.dataset.dockKeys = '1';
			span.setAttribute('tabindex', '0');
			span.addEventListener('keydown', function (ev) {
				onHeadKey(ev, id, panel.dataset.label || id);
			});
			span.addEventListener('blur', function () { if (keys && keys.id === id) keyLeave(false); });
		});
	}

	// ── The phone's chip strip ────────────────────────────────
	//
	// No Dock is drawn below 760px, so there are no zones and nothing to slot
	// into. What a phone HAS is the footer strip, and its order is the layout:
	// the gesture is the tab strip's -- hold to lift, slide, release -- and what
	// it writes is `pinned`, which is already an ordered, persisted list.

	var strip = null;

	function chipsIn(row) {
		return [].slice.call(row.querySelectorAll('.ptag[data-panel]'));
	}

	/// Which chip a lifted one would land in front of, or nothing for the end.
	///
	/// WITHIN ITS OWN ZONE GROUP, and that is not a restriction added for
	/// tidiness. The row is drawn rail, then stage, then dock -- a chip sits on
	/// the side the panel it opens will appear, which is a stronger signal than
	/// colour -- and `renderTags` groups before it orders. So a chip carried into
	/// another group could not be seated there whatever was written down, and an
	/// insertion line offered there would be a promise the next draw breaks.
	/// Measured: a dock chip dragged over the rail group showed a line, wrote an
	/// order, and came back exactly where it started.
	function slotAt(row, x, dragEl) {
		var group = dragEl.closest ? dragEl.closest('.ptag-group') : null;
		var cs = chipsIn(group || row).filter(function (c) { return c !== dragEl; });
		for (var i = 0; i < cs.length; i++) {
			var r = cs[i].getBoundingClientRect();
			if (x < r.left + r.width / 2) return { before: cs[i], end: cs[cs.length - 1] };
		}
		return { before: null, end: cs[cs.length - 1] || null };
	}

	function insMark(row) {
		var m = row.querySelector('.ptag-ins');
		if (!m) {
			m = document.createElement('span');
			m.className = 'ptag-ins';
			row.appendChild(m);
		}
		return m;
	}

	function stripEnd(commit) {
		if (!strip) return;
		var s = strip;
		strip = null;
		var row = s.row;
		row.classList.remove('reordering');
		s.el.classList.remove('lifted');
		var m = row.querySelector('.ptag-ins');
		if (m && m.parentNode) m.parentNode.removeChild(m);
		document.body.classList.remove('dock-dragging');
		if (!commit || !s.slot) return;
		// The order the row is IN, with the dragged chip moved to where it was
		// released, written back as the pin list. `renderTags` reads it, so the
		// order survives the redraw the write itself causes.
		var all = chipsIn(row).filter(function (c) { return c !== s.el; })
			.map(function (c) { return c.dataset.panel; });
		var i = s.slot.before ? all.indexOf(s.slot.before.dataset.panel)
			: (s.slot.end ? all.indexOf(s.slot.end.dataset.panel) + 1 : all.length);
		if (i < 0) i = all.length;
		all.splice(i, 0, s.id);
		P().setOrder(all);
	}

	/// The chip is lifted: it stands off the strip, the strip stops scrolling
	/// under it, and the phone says so in the hand.
	///
	/// A function of its own because it is the one thing a rest DOES, and the
	/// verifier's `--break tapreorders` needs to be able to attach it to travel
	/// instead -- a break that could only lower the threshold lifted a gesture
	/// that then reordered nothing, which is not a break.
	function lifting(ctx) {
		strip = ctx;
		ctx.el.classList.add('lifted');
		document.body.classList.add('dock-dragging');
		// The strip is its own scroller, and a lifted chip must not also be
		// panning it. `touch-action` is read when the gesture starts and so
		// cannot be changed now; taking the overflow away stops the pan.
		ctx.row.classList.add('reordering');
		try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) { /* no motor */ }
	}

	/// Bind the strip's long-press reorder to the chip row.
	///
	/// TO THE ELEMENT, once, rather than each time the row is moved. `placeChips`
	/// in js/mobile.js moves the one `#panel-tags` between the header and the
	/// footer as the width crosses 760px; it is the same node either side, so a
	/// binding made here travels with it and there is never a second one to keep
	/// in step.
	///
	/// TWO GESTURES SHARE THIS ELEMENT -- this one and the desktop chip drag --
	/// and exactly one of them ever claims a press: each asks `isPhone()` first
	/// and answers nothing on the width that is not its own.
	function bindStrip(row) {
		if (!row || row.dataset.dockStrip) return;
		row.dataset.dockStrip = '1';
		window.DaimondGesture.drag(row, {
			// A press on a chip, and only where the Dock is not drawn at all.
			match: function (ev) {
				if (!isPhone()) return null;
				var el = ev.target && ev.target.closest && ev.target.closest('.ptag[data-panel]');
				return el ? { el: el, id: el.dataset.panel, row: row, slot: null } : null;
			},
			passive: true,
			// A finger that TRAVELS is scrolling the strip, which is what the strip
			// is for. Only a finger that RESTS is asking to move a chip.
			threshold: 1e9,
			onHold: function (ctx) { lifting(ctx); },
			move: function (pt, ctx) {
				if (!strip) return;
				var got = slotAt(ctx.row, pt.clientX, ctx.el);
				ctx.slot = got;
				var m = insMark(ctx.row);
				var into = got.before ? got.before.parentNode
					: (got.end ? got.end.parentNode : ctx.row);
				into.insertBefore(m, got.before);
				// Near either end, walk the strip along so a chip can be carried past
				// what is off screen.
				var r = ctx.row.getBoundingClientRect();
				if (pt.clientX < r.left + 40) ctx.row.scrollLeft -= 12;
				else if (pt.clientX > r.right - 40) ctx.row.scrollLeft += 12;
			},
			drop: function (ev, ctx, lifted) { if (lifted) stripEnd(true); },
			cancel: function () { stripEnd(false); },
		});
	}

	function isPhone() {
		var s = window.DaimondShell;
		if (s && s.isPhone) return s.isPhone();
		return window.matchMedia('(max-width: 760px)').matches;
	}

	// ── Binding ───────────────────────────────────────────────

	/// Bind every drag source the Dock has. Called once, from the engine's
	/// `init`, after the resize handles.
	function bind() {
		build();
		var tags = document.getElementById('panel-tags');
		var dockEl = document.getElementById('dock');

		// A CHIP. Passive, so the browser's own click still fires and a press that
		// never travelled is still the toggle it has always been -- that is the
		// whole of `clickstill`. The capture is taken at the lift, not the press,
		// because a captured pointer retargets the click that follows it.
		if (tags) window.DaimondGesture.drag(tags, {
			match: function (ev) {
				if (isPhone()) return null;
				var el = ev.target && ev.target.closest && ev.target.closest('.ptag[data-panel]');
				return claim(el);
			},
			passive: true,
			lift: function (ev, ctx) { begin(ctx, ev); },
			move: function (pt) { over(pt); },
			drop: function (ev, ctx, lifted) { if (lifted) end(true); },
			cancel: function () { end(false); },
		});

		// A PLACED PANEL'S OWN HEADING. The capture is taken at the PRESS here:
		// the heading of a panel in the leftmost column is a few pixels from the
		// Dock's divider, so the move that lifts the gesture can already be
		// outside the element -- and a press on a heading is not also a click, so
		// there is nothing for an early capture to retarget.
		if (dockEl) window.DaimondGesture.drag(dockEl, {
			match: function (ev) {
				if (isPhone()) return null;
				var tgt = ev.target;
				if (!tgt || !tgt.closest) return null;
				// Everything in a header that does something of its own keeps doing
				// it: the closer, Pending's sort, a link.
				if (tgt.closest('button, select, input, textarea, a')) return null;
				var head = tgt.closest('.railhead');
				if (!head) return null;
				var panel = head.closest('.panel[data-panel]');
				if (!panel) return null;
				// THE HEADING IS FOCUSED BY HAND, because the press is defended
				// below and a defended `pointerdown` gives nothing focus. Without
				// this the keyboard path is reachable only by tabbing to a heading
				// nothing has ever told the user is there -- clicking the very
				// control that says "drag to move" would leave the focus wherever
				// it had been.
				var span = head.querySelector('[role="heading"]');
				if (span && span.focus) { try { span.focus(); } catch (e) { /* not focusable yet */ } }
				return claim(panel, head);
			},
			capture: 'press',
			lift: function (ev, ctx) { begin(ctx, ev); },
			move: function (pt) { over(pt); },
			drop: function (ev, ctx, lifted) { if (lifted) end(true); },
			cancel: function () { end(false); },
		});

		// Escape ends a drag wherever it is, and ends the keyboard mode too.
		document.addEventListener('keydown', function (ev) {
			if (ev.key !== 'Escape') return;
			if (live) { end(false); ev.preventDefault(); }
			if (strip) { stripEnd(false); ev.preventDefault(); }
			// The keyboard mode too, and from wherever the focus happens to be:
			// a mode entered from a CHIP can have the focus on the chip when the
			// user changes their mind, and the heading's own handler would never
			// see the key.
			if (keys) { keyLeave(false); ev.preventDefault(); }
		});

		// A chip the keyboard is on enters the same mode with Shift+Enter, having
		// first been given a slot to move from.
		if (tags) tags.addEventListener('keydown', function (ev) {
			if (ev.key !== 'Enter' || !ev.shiftKey) return;
			var el = ev.target && ev.target.closest && ev.target.closest('.ptag[data-panel]');
			var ctx = claim(el);
			if (!ctx) return;
			ev.preventDefault();
			if (!ctx.placed) P().show(ctx.id);
			// THE HEADING TAKES THE FOCUS, and without this the mode was entered
			// and then unreachable: the arrows are the heading's own handler, and
			// the focus was still on the chip the mode was asked for from.
			var head = document.querySelector('.panel[data-panel="' + ctx.id + '"]'
				+ ' .railhead > [role="heading"]');
			if (head && head.focus) { try { head.focus(); } catch (e) { /* not seated */ } }
			keyEnter(ctx.id, ctx.label);
		});

		// The window changing shape mid-gesture changes where every slot is.
		if (window.ResizeObserver && dockEl) {
			new ResizeObserver(function () {
				if (live) live.zones = zoneList(live.id);
				if (keys) keys.zones = zoneList(keys.id);
			}).observe(dockEl);
		}

		markHeads();
		bindStrip(document.getElementById('panel-tags'));
	}

	window.DaimondDockDrag = {
		migrate: migrate, unmigrate: unmigrate, caps: caps, zones: zones,
		pick: pick, applyDrop: applyDrop, keyStep: keyStep, at: at, flat: flat,
		boundaries: boundaries, ord: ord,
		FLOORS: FLOORS, EDGE: EDGE, REACH: REACH,
		bind: bind, markHeads: markHeads, bindStrip: bindStrip,
		/// What the drag is doing right now, for a verifier that has to know
		/// whether an indicator is the one the pointer is over.
		showing: function () { return live ? live.zone : (keys ? keys.zone : null); },
	};
})();
