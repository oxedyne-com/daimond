/* graph.js — the Diamonds and the links between them, drawn inside #panel-graph
 * and EDITED there.
 *
 * This is a verification instrument that the user may also arrange. Its value
 * is unchanged: the same store always draws the same picture, so a person can
 * look at it to check that the association structure is the one they believe
 * they built, and a picture that rearranged itself between two looks could not
 * settle that question.
 *
 * What changed is where a coordinate may come from. Until now every coordinate
 * was computed from the Diamonds and the links. Now a Diamond may also carry a
 * STORED position, put there by a drag or by "organise", and a stored position
 * wins. That is not a hole in the guarantee, it is the guarantee restated: the
 * picture is a pure function of the store, and the store has one more thing in
 * it. Auto-layout remains the rule for a Diamond with no stored position, so a
 * new one still appears somewhere sensible rather than at the origin.
 *
 * THE ONE ANIMATION, and why the guarantee survives it. While a link is being
 * drawn, an arrow follows the pointer; while a Diamond is being dragged, its
 * box follows the pointer. Both are pointer feedback and neither is stored:
 * they exist only between a mousedown and the mouseup that ends them, they are
 * drawn in a layer of their own that no serialisation of the picture includes,
 * and the moment the gesture finishes the picture is redrawn from the store as
 * it always was. There is still no force-direction and no randomness anywhere
 * below, and no measurement taken from the page is ever used to place anything
 * — a layout that asked the browser how wide a word came out would draw
 * differently at a different font size, and then two people comparing the same
 * store would be comparing two pictures.
 *
 * What is drawn:
 *   - Every Diamond is a node, including one nothing points at. An unlinked
 *     Diamond is information — usually the information that a link you meant to
 *     draw was never drawn — so it goes in a band of its own at the foot rather
 *     than being left out.
 *   - Every link whose BOTH ends are Diamonds is an edge, arrowed from `from`
 *     to `to`, labelled with its relation. Two links between the same pair are
 *     two lines, and their two relations are written at different points ALONG
 *     those lines, since a picture where one word covers another is not one
 *     anybody can check anything against.
 *   - A link to a file, a page or a chat is not a node. It is a count on the
 *     Diamond it touches, because a picture that grew a box for every artefact
 *     would stop showing the structure it exists to show.
 *   - A cycle is legal and is drawn: its closing edges are dashed and badged,
 *     and so are the Diamonds on it. Making one visible is the point; refusing
 *     to draw one would hide exactly the case worth seeing. Dragging does not
 *     suppress it and neither does organising — both redraw from the same
 *     classification.
 *
 * What can be done to it:
 *   - Drag a Diamond to move it. Where it lands is written down.
 *   - Arm "Link", click a source, click a target: a link is asserted, and the
 *     arrow follows the pointer in between. Escape, or a click on empty space,
 *     leaves the mode.
 *   - Click a link to edit its relation and its note, or to delete it.
 *   - Middle-drag to pan. Where the view was left is written down too.
 *   - Right-click for a menu, which carries "organise".
 */
(function () {
	'use strict';

	// The wasm module, resolved against THIS script rather than the document, so
	// the app still finds it when served from a sub-path.
	var SELF = (document.currentScript && document.currentScript.src) || '';
	var PKG  = SELF ? new URL('../pkg/oxedyne_daimond.js', SELF).href
	                : '../pkg/oxedyne_daimond.js';

	// ── Words ──────────────────────────────────────────────────

	/// The editor's own strings, held here until they reach `i18n/en.js`.
	///
	/// A key no table carries renders AS THE KEY, which would put `graph.organise`
	/// on a button. These are the fallback for exactly that window; the lookup
	/// below prefers a real table entry the moment one exists, so moving them into
	/// the locale files needs no change here.
	var STR = {
		'graph.link_mode':       'Link',
		'graph.link_help':       'Click the Diamond a link starts at, then the one it points at. Escape cancels.',
		'graph.organise':        'Organise',
		'graph.organise_help':   'Lay the Diamonds out again to reduce crossings, and keep where it puts them.',
		'graph.pick_source':     'Click the source, then the target. Escape cancels.',
		'graph.pick_target':     'From {name} — click the target, or Escape.',
		'graph.menu_link':       'Link from here…',
		'graph.menu_open':       'Open this Diamond',
		'graph.menu_reset_node': 'Put this Diamond back',
		'graph.menu_reset_all':  'Put every Diamond back',
		'graph.menu_reset_view': 'Reset the view',
		'graph.menu_edit_link':  'Edit this link…',
		'graph.menu_drop_link':  'Delete this link',
		'graph.edit_title':      'Link',
		'graph.new_title':       'New link',
		'graph.rel_label':       'Relation',
		'graph.rel_ph':          'part-of, blocks, supersedes…',
		'graph.note_label':      'Note',
		'graph.note_ph':         'Whatever the relation does not say.',
		'graph.save':            'Save',
		'graph.create':          'Create',
		'graph.cancel':          'Cancel',
		'graph.drop':            'Delete',
		'graph.self_link':       'A link joins two different Diamonds.',
		'graph.write_failed':    'That could not be written: {err}',
		'graph.edit_help':       'Edit this link',
	};

	/// Fill `{name}` placeholders, the way the i18n tables do.
	function interp(s, v) {
		if (!v) return s;
		return String(s).replace(/\{(\w+)\}/g, function (m, k) {
			return v[k] == null ? m : String(v[k]);
		});
	}

	/// A string. The shipped tables win where they carry the key; `has()` asks the
	/// ACTIVE table only, so an existing key under a part-translated locale still
	/// falls through to DaimondI18n and its English fallback.
	function t(k, v) {
		if (window.DaimondI18n && DaimondI18n.has(k)) return DaimondI18n.t(k, v);
		if (STR[k] != null) return interp(STR[k], v);
		return window.DaimondI18n ? DaimondI18n.t(k, v) : k;
	}

	/// The plural form, delegated so a locale's own rule still applies.
	function tn(k, n, v) {
		var key = k + (n === 1 ? '.one' : '.other');
		if (STR[key] != null && !(window.DaimondI18n && DaimondI18n.has(key))) {
			var w = { n: n };
			if (v) for (var x in v) if (Object.prototype.hasOwnProperty.call(v, x)) w[x] = v[x];
			return interp(STR[key], w);
		}
		return window.DaimondI18n ? DaimondI18n.tn(k, n, v) : key;
	}

	var SVGNS = 'http://www.w3.org/2000/svg';

	// ── The drawing's fixed measurements ───────────────────────
	// Constants, not measurements taken from the page: a layout that asked the
	// browser how wide a word came out would draw differently at a different
	// font size or on a different machine, and then two people comparing the
	// same store would be comparing two pictures.
	var NODE_W  = 176;      // a Diamond box
	var NODE_H  = 44;
	var H_GAP   = 30;       // between boxes on one layer
	var V_GAP   = 92;       // between layers, which is where the labels live
	var PAD     = 28;       // around the whole picture
	var ISO_GAP = 64;       // before the band of unlinked Diamonds
	var BAND_H  = 22;       // that band's heading
	var NAME_MAX = 20;      // characters of a name a box holds
	var SWEEPS  = 4;        // barycentre passes; more does not move anything
	var NUDGE   = 18;       // between parallel lines running the same way
	// How far along its own line a parallel label slides, per lane. The drop
	// between two layers is V_GAP, and 0.26 of the curve is about a fifth of it --
	// some twenty pixels, comfortably more than a line of type -- so two labels
	// clear each other however long the relations are, which pushing them
	// sideways by a fixed amount could never promise.
	var LABEL_T = 0.26;
	// And the whole spread the labels of one group may use, so that four or five
	// parallel links stagger inside their line rather than off the end of it.
	var LABEL_SPAN = 0.72;
	// How far the pointer must travel before a press on a Diamond is a drag
	// rather than a click. Below it the gesture still opens the Diamond, which is
	// what a click on a node has always meant.
	var DRAG_MIN = 4;

	var bodyEl  = null;
	var app     = null;     // the wasm handle, built once
	var drawing = false;    // one draw at a time; the last request wins
	var again   = false;
	var lastStore = null;   // what the picture on screen was drawn from
	var lastGeo   = null;   // and where that draw put every box

	// ── Where a Diamond has been put ───────────────────────────

	/// The layout store: which Diamond sits where, and where the view was left.
	///
	/// localStorage rather than OPFS, and per account -- accounts.js namespaces
	/// every `daimond-*` key, so one person's arrangement is never another's. The
	/// alternative was a field in each Diamond's `meta.json`, which would have put
	/// a coordinate inside the record a daimon reads and folds; where a box sits
	/// on one person's screen is not part of what a Diamond IS, and a fold that
	/// had to preserve it would be carrying furniture.
	///
	/// Shape, and it is the shape asked of the sync parcel:
	///
	///   { v: 1, pos: { "<diamondId>": { x, y, t } }, pan: { x, y } }
	///
	/// `t` is the wall-clock millisecond that position was last set, PER DIAMOND,
	/// so two devices that moved two different Diamonds keep both moves. A single
	/// stamp over the whole map would make the later device's whole arrangement
	/// win, and losing an arrangement is exactly the kind of quiet data loss the
	/// tag-loss incident was.
	var LAYOUT_KEY = 'daimond-graph';
	var layout = null;

	function loadLayout() {
		if (layout) return layout;
		layout = { v: 1, pos: {}, pan: { x: 0, y: 0 } };
		try {
			var raw = localStorage.getItem(LAYOUT_KEY);
			if (raw) {
				var rec = JSON.parse(raw);
				if (rec && typeof rec === 'object') {
					layout.pos = sanePos(rec.pos);
					layout.pan = sanePan(rec.pan);
				}
			}
		} catch (e) { /* blocked or corrupt: nothing has been moved */ }
		return layout;
	}

	/// Keep only what is a position. A hand-edited or half-written record must
	/// not be able to put a box at `NaN`, which SVG draws nowhere at all.
	function sanePos(o) {
		var out = {};
		if (!o || typeof o !== 'object') return out;
		Object.keys(o).forEach(function (id) {
			var p = o[id];
			if (!p || typeof p !== 'object') return;
			var x = Number(p.x), y = Number(p.y), ts = Number(p.t);
			if (!isFinite(x) || !isFinite(y)) return;
			out[id] = { x: Math.round(x), y: Math.round(y), t: isFinite(ts) ? ts : 0 };
		});
		return out;
	}

	function sanePan(o) {
		var x = o ? Number(o.x) : 0, y = o ? Number(o.y) : 0;
		return { x: isFinite(x) ? Math.max(0, Math.round(x)) : 0,
		         y: isFinite(y) ? Math.max(0, Math.round(y)) : 0 };
	}

	function saveLayout() {
		try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(loadLayout())); }
		catch (e) { /* private mode, or full: the picture still draws */ }
	}

	/// Where this Diamond has been put, or nothing.
	function storedPos(id) {
		var p = loadLayout().pos[id];
		return p ? { x: p.x, y: p.y } : null;
	}

	/// Write where a Diamond sits. Negative coordinates are clamped away: the
	/// canvas grows to the right and downwards, so a box at -40 would be off the
	/// only edge that cannot be scrolled to.
	function putPos(id, x, y, stamp) {
		var l = loadLayout();
		l.pos[id] = {
			x: Math.max(0, Math.round(x)),
			y: Math.max(0, Math.round(y)),
			t: stamp || Date.now(),
		};
	}

	/// Forget where a Diamond was put, so auto-layout has it again.
	function dropPos(id) { delete loadLayout().pos[id]; }

	/// Drop the positions of Diamonds that are no longer there.
	///
	/// Run on every draw, which is the only moment the live set is known here. A
	/// deleted Diamond leaves an entry nothing will ever read again, and left
	/// alone the map would grow for the life of the account. Pruning is safe
	/// against the sync: the other device still holding that Diamond still holds
	/// its position, and the union puts it back — so this loses a coordinate only
	/// when the Diamond it belongs to has gone everywhere.
	function pruneLayout(liveIds) {
		var live = {}, l = loadLayout(), gone = 0;
		liveIds.forEach(function (id) { live[id] = 1; });
		Object.keys(l.pos).forEach(function (id) {
			if (!live[id]) { delete l.pos[id]; gone++; }
		});
		return gone;
	}

	/// The layout as the sync parcel should carry it.
	///
	/// The positions only. The pan is deliberately NOT here: it is a scroll offset
	/// into a picture whose size depends on this window, and adopting another
	/// device's would move the view for no reason the user could see.
	function snapshot() {
		var l = loadLayout(), pos = {}, stamp = 0;
		Object.keys(l.pos).sort().forEach(function (id) {
			var p = l.pos[id];
			pos[id] = { x: p.x, y: p.y, t: p.t || 0 };
			if (p.t > stamp) stamp = p.t;
		});
		// Sorted, and only the three fields, so two collects with nothing between
		// them serialise to the same bytes -- which is what the push-skip in
		// sync.js rests on. A map serialised in enumeration order would push for
		// ever.
		return { v: 1, stamp: stamp, pos: pos };
	}

	/// Take a layout record from the sync, merged against what is held here.
	/// Returns true when something local moved.
	///
	/// Per Diamond, the later stamp wins; on an equal stamp what is here is kept,
	/// so applying a parcel this device already agrees with changes nothing and
	/// the next parcel is unchanged. A section that restamped itself on apply is
	/// the loop that had a freshly paired phone always holding news.
	function adopt(rec) {
		var incoming = sanePos(rec && rec.pos);
		var l = loadLayout(), moved = false;
		Object.keys(incoming).forEach(function (id) {
			var mine = l.pos[id], theirs = incoming[id];
			if (mine && (mine.t || 0) >= (theirs.t || 0)) return;
			if (mine && mine.x === theirs.x && mine.y === theirs.y) return;
			l.pos[id] = theirs;
			moved = true;
		});
		if (moved) { saveLayout(); refreshIfVisible(); }
		return moved;
	}

	// ── The wasm handle ────────────────────────────────────────

	/// The `DaimondApp` this pane reads through, built on first use.
	///
	/// The link reads are pure OPFS operations and work on any instance, so the
	/// provider fields are placeholders -- nothing here ever calls a model.
	function reader() {
		if (app) return Promise.resolve(app);
		return import(PKG).then(function (mod) {
			app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
			return app;
		});
	}

	// ── Small helpers ──────────────────────────────────────────

	function el(name, cls) {
		var n = document.createElementNS(SVGNS, name);
		if (cls) n.setAttribute('class', cls);
		return n;
	}

	function attrs(n, o) {
		for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) n.setAttribute(k, String(o[k]));
		return n;
	}

	/// A plain HTML element, since the furniture around the picture is not SVG.
	function h(name, cls, text) {
		var n = document.createElement(name);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	}

	/// A `<title>`, which is how SVG carries a tooltip.
	function tip(n, text) {
		if (!text) return n;
		var ti = el('title');
		ti.textContent = text;
		n.insertBefore(ti, n.firstChild);
		return n;
	}

	/// Cut a name to what a box holds, with an ellipsis to say it was cut. The
	/// full name is always on the node's tooltip, so nothing is lost.
	function clip(s) {
		var str = String(s || '');
		var chars = Array.from(str);   // so a cut never lands inside a character
		if (chars.length <= NAME_MAX) return str;
		return chars.slice(0, NAME_MAX - 1).join('') + '…';
	}

	/// The Diamond id a `diamond:<id>` reference names, or nothing.
	function diamondOf(ref) {
		var s = String(ref || '');
		return s.slice(0, 8) === 'diamond:' ? s.slice(8) : null;
	}

	// ── Reading the store ──────────────────────────────────────

	/// Everything the picture is drawn from, in a fixed order.
	function load() {
		return reader().then(function (a) {
			return Promise.all([a.list_diamonds(), a.all_links()]);
		}).then(function (raw) {
			var diamonds = JSON.parse(raw[0] || '[]');
			var links    = JSON.parse(raw[1] || '[]');
			// The rail is ordered by when a Diamond was last worked on, which
			// changes under the picture. Ordered by id it does not.
			diamonds.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
			links.sort(function (a, b) {
				if (a.owner !== b.owner) return a.owner < b.owner ? -1 : 1;
				return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
			});
			return { diamonds: diamonds, links: links };
		});
	}

	// ── The model behind the picture ───────────────────────────

	/// Sort the store into what is drawn: Diamond-to-Diamond edges, artefact
	/// counts, and the links that point at a Diamond which is no longer there.
	function classify(store) {
		var known = {};
		store.diamonds.forEach(function (d) { known[d.id] = d; });

		var edges    = [];   // both ends are Diamonds that exist
		var artefact = {};   // diamond id -> how many links to a file, page or chat
		var dangling = 0;    // links naming a Diamond that has been deleted

		store.links.forEach(function (l) {
			var a = diamondOf(l.from), b = diamondOf(l.to);
			var aOk = a !== null && known[a], bOk = b !== null && known[b];
			if (a !== null && b !== null) {
				if (aOk && bOk) edges.push({ id: l.id, owner: l.owner, from: a, to: b, rel: l.rel || '', note: l.note || '', by: l.by || '' });
				else dangling++;
				return;
			}
			// One end is an artefact. It counts against whichever end is a
			// Diamond we hold; a link between two artefacts touches nothing here.
			if (aOk) artefact[a] = (artefact[a] || 0) + 1;
			if (bOk) artefact[b] = (artefact[b] || 0) + 1;
			if (!aOk && !bOk && (a !== null || b !== null)) dangling++;
		});
		return { known: known, edges: edges, artefact: artefact, dangling: dangling };
	}

	/// Which edges close a cycle, and which Diamonds sit on one.
	///
	/// The closing edges come from an iterative depth-first search in id order:
	/// an edge into a node still on the search stack is a back edge, and which
	/// edge of a cycle gets called the closing one has to be the same on every
	/// draw. The Diamonds ON a cycle are a separate question, answered by
	/// [sccCycles] -- a node can sit on a cycle it joins through a cross edge
	/// the search never calls "back", so the stack segment a back edge closes
	/// does not name every member.
	function findCycles(ids, out) {
		var back = {}, colour = {};
		ids.forEach(function (id) {
			if (colour[id] !== undefined) return;
			colour[id] = 1;
			var stack = [{ id: id, i: 0 }];
			while (stack.length) {
				var top = stack[stack.length - 1];
				var os  = out[top.id] || [];
				if (top.i < os.length) {
					var e = os[top.i++];
					var c = colour[e.to];
					if (c === undefined) {
						colour[e.to] = 1;
						stack.push({ id: e.to, i: 0 });
					} else if (c === 1) {
						back[e.id] = true;
					}
				} else {
					colour[top.id] = 2;
					stack.pop();
				}
			}
		});
		return { back: back, onCycle: sccCycles(ids, out) };
	}

	/// The Diamonds whose strongly connected component holds more than
	/// themselves, which is exactly the Diamonds on a cycle -- the store rejects
	/// a self-link, so a component of one cannot be one. An iterative Tarjan
	/// walk in id order, deterministic like everything else here.
	function sccCycles(ids, out) {
		var index = {}, low = {}, onStk = {}, stk = [], n = 0, onCycle = {};
		ids.forEach(function (root) {
			if (index[root] !== undefined) return;
			index[root] = low[root] = n++;
			stk.push(root);
			onStk[root] = true;
			var work = [{ id: root, i: 0 }];
			while (work.length) {
				var top = work[work.length - 1];
				var os  = out[top.id] || [];
				if (top.i < os.length) {
					var to = os[top.i++].to;
					if (index[to] === undefined) {
						index[to] = low[to] = n++;
						stk.push(to);
						onStk[to] = true;
						work.push({ id: to, i: 0 });
					} else if (onStk[to] && index[to] < low[top.id]) {
						low[top.id] = index[to];
					}
				} else {
					work.pop();
					if (work.length) {
						var p = work[work.length - 1].id;
						if (low[top.id] < low[p]) low[p] = low[top.id];
					}
					// This node roots a component: pop the component off.
					if (low[top.id] === index[top.id]) {
						var comp = [];
						for (;;) {
							var v = stk.pop();
							onStk[v] = false;
							comp.push(v);
							if (v === top.id) break;
						}
						if (comp.length > 1) comp.forEach(function (v) { onCycle[v] = true; });
					}
				}
			}
		});
		return onCycle;
	}

	/// Put every connected Diamond on a layer: the length of the longest chain of
	/// links ending at it. A Diamond nothing points at is on layer 0, at the top,
	/// so the arrows read downwards.
	///
	/// Back edges are left out of this, which is what makes it terminate: a cycle
	/// has no longest path. They are drawn afterwards, over the layering the rest
	/// of the graph settled.
	function layerise(ids, edges, back) {
		var indeg = {}, out = {}, layer = {};
		ids.forEach(function (id) { indeg[id] = 0; out[id] = []; layer[id] = 0; });
		edges.forEach(function (e) {
			if (back[e.id]) return;
			out[e.from].push(e);
			indeg[e.to]++;
		});
		var ready = ids.filter(function (id) { return indeg[id] === 0; });
		// The layer numbers are decided by the graph, not by the order this
		// queue happens to drain, so no ordering is imposed on it.
		while (ready.length) {
			var v = ready.shift();
			out[v].forEach(function (e) {
				if (layer[v] + 1 > layer[e.to]) layer[e.to] = layer[v] + 1;
				if (--indeg[e.to] === 0) ready.push(e.to);
			});
		}
		return layer;
	}

	/// Order the nodes across each layer so fewer lines cross.
	///
	/// The classic barycentre heuristic: a node wants to sit at the average
	/// horizontal position of what it is joined to, and the layers are swept
	/// downwards and upwards a few times. Every step is a stable sort over an
	/// order that began as the Diamond ids, so it converges to one arrangement
	/// rather than merely a good one.
	function order(layers, edges, back) {
		var preds = {}, succs = {};
		edges.forEach(function (e) {
			if (back[e.id]) return;
			(preds[e.to]   || (preds[e.to]   = [])).push(e.from);
			(succs[e.from] || (succs[e.from] = [])).push(e.to);
		});
		// Where a node sits across its own layer, from 0 to 1, so layers holding
		// different numbers of Diamonds can still be averaged against each other.
		var at = {};
		function reindex() {
			layers.forEach(function (row) {
				row.forEach(function (id, i) { at[id] = row.length > 1 ? i / (row.length - 1) : 0.5; });
			});
		}
		function sweep(L, side) {
			var row = layers[L];
			if (!row || row.length < 2) return;
			var key = {};
			row.forEach(function (id) {
				var ns = side[id] || [];
				if (!ns.length) { key[id] = at[id]; return; }
				var sum = 0;
				ns.forEach(function (n) { sum += at[n]; });
				key[id] = sum / ns.length;
			});
			// A stable sort, so equal keys keep the order they already had --
			// which traces back, through every sweep, to the Diamond ids.
			row.sort(function (a, b) { return key[a] - key[b]; });
			reindex();
		}
		reindex();
		for (var it = 0; it < SWEEPS; it++) {
			for (var L = 1; L < layers.length; L++) sweep(L, preds);
			for (var M = layers.length - 2; M >= 0; M--) sweep(M, succs);
		}
	}

	// ── Geometry ───────────────────────────────────────────────

	/// Work out where every box goes when nothing has been dragged. Pure
	/// arithmetic over the ordered layers.
	function geometry(layers, isolates) {
		var pos = {};   // diamond id -> { x, y } of the box's top-left corner
		var connW = 0;
		layers.forEach(function (row) {
			var w = row.length ? row.length * NODE_W + (row.length - 1) * H_GAP : 0;
			if (w > connW) connW = w;
		});
		// The unlinked band wraps to the width the connected picture already
		// needs, so it never widens the drawing on its own account.
		var perRow = connW > 0 ? Math.max(1, Math.floor((connW + H_GAP) / (NODE_W + H_GAP)))
		                       : Math.min(Math.max(isolates.length, 1), 6);
		if (isolates.length && perRow > isolates.length) perRow = isolates.length;
		var isoRows = Math.ceil(isolates.length / perRow);
		var isoW    = isolates.length ? perRow * NODE_W + (perRow - 1) * H_GAP : 0;
		var contentW = Math.max(connW, isoW);

		layers.forEach(function (row, L) {
			var w = row.length ? row.length * NODE_W + (row.length - 1) * H_GAP : 0;
			var x0 = PAD + (contentW - w) / 2;
			var y  = PAD + L * (NODE_H + V_GAP);
			row.forEach(function (id, i) { pos[id] = { x: x0 + i * (NODE_W + H_GAP), y: y }; });
		});

		var bandY = layers.length ? PAD + layers.length * (NODE_H + V_GAP) - V_GAP + ISO_GAP : PAD;
		isolates.forEach(function (id, i) {
			var r = Math.floor(i / perRow), c = i % perRow;
			var n = Math.min(perRow, isolates.length - r * perRow);
			var w = n * NODE_W + (n - 1) * H_GAP;
			pos[id] = {
				x: PAD + (contentW - w) / 2 + c * (NODE_W + H_GAP),
				y: bandY + BAND_H + r * (NODE_H + H_GAP),
			};
		});

		var h = PAD;
		if (layers.length) h = PAD + layers.length * (NODE_H + V_GAP) - V_GAP;
		if (isolates.length) h = bandY + BAND_H + isoRows * (NODE_H + H_GAP) - H_GAP;
		return { pos: pos, contentW: contentW, bandY: bandY, height: h + PAD, perRow: perRow };
	}

	/// The point a fraction `t` along a cubic bezier, which is where an edge's
	/// label sits -- halfway for a lone edge, and a little further along or back
	/// for one of a parallel group.
	///
	/// Rounded to a thousandth of a unit, which is far finer than a pixel and
	/// keeps the coordinate short in the serialised picture.
	function pointAt(p0, p1, p2, p3, t) {
		var u = 1 - t;
		var a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
		var r = function (v) { return Math.round(v * 1000) / 1000; };
		return {
			x: r(a * p0.x + b * p1.x + c * p2.x + d * p3.x),
			y: r(a * p0.y + b * p1.y + c * p2.y + d * p3.y),
		};
	}

	// ── Drawing ────────────────────────────────────────────────

	/// The two arrowheads, which have to be declared before they are pointed at.
	function defs() {
		var d = el('defs');
		[['gm-arrow', 'graph-arrow'], ['gm-arrow-back', 'graph-arrow back'],
		 ['gm-arrow-live', 'graph-arrow live']].forEach(function (pair) {
			var m = attrs(el('marker'), {
				id: pair[0], viewBox: '0 0 10 10', refX: 9, refY: 5,
				markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
			});
			var p = attrs(el('path', pair[1]), { d: 'M 0 0 L 10 5 L 0 10 z' });
			m.appendChild(p);
			d.appendChild(m);
		});
		return d;
	}

	/// One Diamond.
	function nodeEl(d, p, marks) {
		var g = el('g', 'graph-node' + (marks.isolate ? ' isolate' : '')
			+ (marks.cycle ? ' cycled' : '') + (marks.placed ? ' placed' : '')
			+ (marks.source ? ' link-source' : ''));
		g.setAttribute('data-diamond-id', d.id);
		g.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
		g.appendChild(attrs(el('rect', 'graph-node-box'), {
			x: 0, y: 0, width: NODE_W, height: NODE_H, rx: 8, ry: 8,
		}));
		var name = d.name && d.name.trim() ? d.name : t('graph.unnamed');
		var tx = attrs(el('text', 'graph-node-name'), { x: 12, y: NODE_H / 2 + 4 });
		tx.textContent = clip(name);
		g.appendChild(tx);
		tip(g, name);

		if (marks.artefacts) {
			var b = el('g', 'graph-badge');
			b.setAttribute('transform', 'translate(' + (NODE_W - 10) + ',' + 14 + ')');
			var bt = attrs(el('text', 'graph-badge-text'), { x: 0, y: 0 });
			bt.textContent = '◈ ' + marks.artefacts;
			b.appendChild(bt);
			tip(b, tn('graph.artefacts', marks.artefacts));
			g.appendChild(b);
		}
		if (marks.cycle) {
			var c = el('g', 'graph-cycle');
			c.setAttribute('transform', 'translate(' + (NODE_W - 10) + ',' + (NODE_H - 9) + ')');
			var ct = attrs(el('text', 'graph-cycle-text'), { x: 0, y: 0 });
			ct.textContent = '⟲';
			c.appendChild(ct);
			tip(c, t('graph.in_cycle'));
			g.appendChild(c);
		}
		return g;
	}

	/// Where an edge leaves, where it lands, and the two control points that bow
	/// it between them.
	///
	/// The LAYERED case is exactly what it always was -- out of the bottom of the
	/// source, into the top of the target -- and it is the only case auto-layout
	/// can produce, because a forward edge's target is always on a lower layer.
	/// So a picture drawn from a store nothing has been dragged in is the picture
	/// this module has always drawn, to the byte.
	///
	/// Dragging can put a target level with its source or above it, and there
	/// bottom-to-top would draw a line doubling back through both boxes. Only
	/// that case anchors elsewhere: on the facing sides when the two are mostly
	/// side by side, and top-to-bottom when the target is mostly above. The
	/// arrowhead therefore always lands on the edge of the box it points at and
	/// never inside it.
	function route(a, b, nudge) {
		var ac = { x: a.x + NODE_W / 2, y: a.y + NODE_H / 2 };
		var bc = { x: b.x + NODE_W / 2, y: b.y + NODE_H / 2 };
		var p0, p1, p2, p3;
		if (bc.y > ac.y) {
			p0 = { x: ac.x + nudge, y: a.y + NODE_H };
			p3 = { x: bc.x + nudge, y: b.y };
			var dy = Math.max(24, p3.y - p0.y);
			p1 = { x: p0.x, y: p0.y + dy * 0.42 };
			p2 = { x: p3.x, y: p3.y - dy * 0.42 };
			return { p0: p0, p1: p1, p2: p2, p3: p3 };
		}
		var dx = bc.x - ac.x, dv = bc.y - ac.y;
		if (Math.abs(dx) >= Math.abs(dv)) {
			var right = dx >= 0;
			p0 = { x: right ? a.x + NODE_W : a.x, y: ac.y + nudge };
			p3 = { x: right ? b.x : b.x + NODE_W, y: bc.y + nudge };
			var run = Math.max(24, Math.abs(p3.x - p0.x)) * 0.42 * (right ? 1 : -1);
			p1 = { x: p0.x + run, y: p0.y };
			p2 = { x: p3.x - run, y: p3.y };
			return { p0: p0, p1: p1, p2: p2, p3: p3 };
		}
		p0 = { x: ac.x + nudge, y: a.y };
		p3 = { x: bc.x + nudge, y: b.y + NODE_H };
		var rise = Math.max(24, p0.y - p3.y) * 0.42;
		p1 = { x: p0.x, y: p0.y - rise };
		p2 = { x: p3.x, y: p3.y + rise };
		return { p0: p0, p1: p1, p2: p2, p3: p3 };
	}

	/// One link, arrowed from its `from` end to its `to` end. `labelT` says how far
	/// along the line its relation is written, which is what holds two relations
	/// between one pair apart.
	function edgeEl(e, pos, isBack, nudge, bow, labelT, names) {
		var a = pos[e.from], b = pos[e.to];
		var g = el('g', 'graph-edge' + (isBack ? ' back' : ''));
		g.setAttribute('data-link-id', e.id);
		g.setAttribute('data-from', e.from);
		g.setAttribute('data-to', e.to);
		g.setAttribute('data-owner', e.owner || '');

		var p0, p1, p2, p3;
		if (isBack) {
			// Out to the right of everything and back, so a closing edge never
			// reads as one more step down the hierarchy.
			p0 = { x: a.x + NODE_W, y: a.y + NODE_H / 2 };
			p3 = { x: b.x + NODE_W, y: b.y + NODE_H / 2 };
			p1 = { x: p0.x + bow, y: p0.y };
			p2 = { x: p3.x + bow, y: p3.y };
		} else {
			var r = route(a, b, nudge);
			p0 = r.p0; p1 = r.p1; p2 = r.p2; p3 = r.p3;
		}
		var d = 'M' + p0.x + ',' + p0.y + ' C' + p1.x + ',' + p1.y + ' ' + p2.x + ',' + p2.y + ' ' + p3.x + ',' + p3.y;
		// A wide invisible twin under the line, because 1.4 pixels of stroke is
		// not something a pointer can be asked to hit. It carries the clicks; the
		// drawn line carries the look.
		g.appendChild(attrs(el('path', 'graph-edge-hit'), { d: d }));
		var path = attrs(el('path', 'graph-edge-line'), {
			d: d,
			'marker-end': 'url(#' + (isBack ? 'gm-arrow-back' : 'gm-arrow') + ')',
		});
		g.appendChild(path);

		var lines = [t('graph.edge_tip', { from: names[e.from], to: names[e.to] })];
		if (e.rel)  lines.push(t('graph.edge_rel', { rel: e.rel }));
		if (e.note) lines.push(e.note);
		if (isBack) lines.push(t('graph.back_edge'));
		lines.push(t('graph.edit_help'));
		tip(g, lines.join('\n'));

		if (e.rel) {
			// The label rides its own line rather than floating beside it, so the
			// halo behind it sits where the line it belongs to is.
			var m  = pointAt(p0, p1, p2, p3, labelT);
			var lt = attrs(el('text', 'graph-edge-label'), { x: m.x, y: m.y });
			lt.textContent = e.rel;
			g.appendChild(lt);
		}
		return g;
	}

	// ── Selecting a Diamond ────────────────────────────────────

	/// Open the clicked Diamond in the centre.
	///
	/// Through the rail's own box rather than through a function of its own: the
	/// rail already turns a click into the whole of what selecting means (the
	/// centre, the arrangement, the phone's panel), and a second door into that
	/// would be a second thing to keep in step with it.
	function select(id) {
		var safe = (window.CSS && CSS.escape) ? CSS.escape(id) : String(id).replace(/"/g, '\\"');
		var box = document.querySelector('#diamond-list .diamond-box[data-id="' + safe + '"]');
		if (!box) {
			// The rail is filtered to a tag this Diamond does not carry, so its
			// box is not in the document to click.
			console.warn('graph: no rail entry for Diamond ' + id);
			return;
		}
		box.click();
	}

	// ── The draw ───────────────────────────────────────────────

	function render(store) {
		var c = classify(store);
		bodyEl.textContent = '';
		lastStore = store;
		lastGeo = null;

		if (!store.diamonds.length) {
			var none = document.createElement('p');
			none.className = 'graph-empty';
			none.textContent = t('graph.no_diamonds');
			bodyEl.appendChild(none);
			paintToolbar(false);
			return;
		}
		paintToolbar(true);

		var names = {};
		store.diamonds.forEach(function (d) {
			names[d.id] = (d.name && d.name.trim()) ? d.name : t('graph.unnamed');
		});

		// Anything left behind by a Diamond that has gone. Done here because this
		// is where the live set is known.
		if (pruneLayout(store.diamonds.map(function (d) { return d.id; }))) saveLayout();

		// Connected and unlinked, both already in id order.
		var touched = {};
		c.edges.forEach(function (e) { touched[e.from] = true; touched[e.to] = true; });
		var ids      = store.diamonds.map(function (d) { return d.id; }).filter(function (id) { return touched[id]; });
		var isolates = store.diamonds.map(function (d) { return d.id; }).filter(function (id) { return !touched[id]; });

		// Out-edges per node, in link-id order, so the cycle search always calls
		// the same edge the closing one.
		var out = {};
		ids.forEach(function (id) { out[id] = []; });
		c.edges.forEach(function (e) { out[e.from].push(e); });
		ids.forEach(function (id) {
			out[id].sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
		});

		var cyc   = findCycles(ids, out);
		var auto  = autoLayout(ids, isolates, c.edges, cyc.back);

		// The stored positions, over the computed ones. Auto-layout never reads
		// them, so moving one Diamond cannot move another: what has not been
		// dragged sits exactly where it sat.
		var pos = {}, placed = {};
		Object.keys(auto.pos).forEach(function (id) { pos[id] = { x: auto.pos[id].x, y: auto.pos[id].y }; });
		Object.keys(pos).forEach(function (id) {
			var s = storedPos(id);
			if (s) { pos[id] = s; placed[id] = true; }
		});

		// Back edges bow out to the right; the widest of them decides the
		// drawing's right margin.
		var backList = c.edges.filter(function (e) { return cyc.back[e.id]; });
		var bows = {}, maxBow = 0;
		backList.forEach(function (e, i) {
			var b = 48 + i * 20;
			bows[e.id] = b;
			if (b > maxBow) maxBow = b;
		});

		// The canvas is the ink plus its margin, measured off the boxes rather
		// than off the layout, so a dragged Diamond can be scrolled to. For a
		// store nothing has been dragged in this is the arithmetic the layout
		// already did, to the pixel.
		var maxX = 0, maxY = 0;
		Object.keys(pos).forEach(function (id) {
			if (pos[id].x + NODE_W > maxX) maxX = pos[id].x + NODE_W;
			if (pos[id].y + NODE_H > maxY) maxY = pos[id].y + NODE_H;
		});
		var width  = maxX + PAD + (maxBow ? maxBow + 24 : 0);
		var height = maxY + PAD;

		var svg = attrs(el('svg', 'graph-svg'), {
			viewBox: '0 0 ' + width + ' ' + height,
			width: width, height: height,
			xmlns: SVGNS,
		});
		svg.setAttribute('id', 'graph-svg');
		svg.appendChild(defs());

		// Parallel links between one pair are nudged apart, so two relations
		// between the same two Diamonds are two visible lines. The lines alone were
		// not enough: each label sat at the middle of its OWN line, so two long
		// relations were written one over the other however far apart the lines they
		// belong to had been pushed -- eighteen pixels is not a word. So a lane moves
		// both: the line sideways, and the label along the line, where the room is.
		//
		// The lanes are handed out in the edges' own order, which is link-id order, so
		// the same store gives the same link the same lane on every draw.
		var groups = {};
		c.edges.forEach(function (e) {
			var k = e.from + ' ' + e.to;
			(groups[k] || (groups[k] = [])).push(e);
		});

		var edgesG = el('g', 'graph-edges');
		c.edges.forEach(function (e) {
			var isBack = !!cyc.back[e.id];
			var grp    = groups[e.from + ' ' + e.to];
			var lane   = grp.length > 1 ? grp.indexOf(e) - (grp.length - 1) / 2 : 0;
			// A closing edge is already held off its neighbours by its own bow, so
			// only a forward line is moved sideways; the label moves either way.
			var nudge  = isBack ? 0 : lane * NUDGE;
			var labelT = 0.5 + lane * Math.min(LABEL_T, LABEL_SPAN / grp.length);
			edgesG.appendChild(edgeEl(e, pos, isBack, nudge, bows[e.id] || 0, labelT, names));
		});
		svg.appendChild(edgesG);

		var nodesG = el('g', 'graph-nodes');
		store.diamonds.forEach(function (d) {
			if (!pos[d.id]) return;
			nodesG.appendChild(nodeEl(d, pos[d.id], {
				artefacts: c.artefact[d.id] || 0,
				cycle:     !!cyc.onCycle[d.id],
				isolate:   !touched[d.id],
				placed:    !!placed[d.id],
				source:    link.from === d.id,
			}));
		});
		svg.appendChild(nodesG);

		if (isolates.length) {
			// The heading tracks the boxes it heads rather than the place the
			// layout would have put them, so dragging one does not leave the words
			// pointing at nothing. Where nothing has moved this is the same y it
			// always was: the band's first row sits BAND_H below bandY.
			var isoTop = Infinity;
			isolates.forEach(function (id) { if (pos[id] && pos[id].y < isoTop) isoTop = pos[id].y; });
			var band = attrs(el('text', 'graph-band'), { x: PAD, y: isoTop - 10 });
			band.textContent = t('graph.isolated');
			svg.appendChild(band);
		}

		// The layer the pointer feedback is drawn in, and the reason the guarantee
		// survives it: nothing here is ever written, and it is empty except during
		// a gesture.
		svg.appendChild(el('g', 'graph-live'));

		// Nothing is said here about a store that holds Diamonds but no links. The
		// line that used to be said -- that the picture appears here once two
		// Diamonds are linked -- was put ABOVE the picture, and the picture was not
		// missing: every one of those Diamonds was drawn directly below it, in the
		// band headed "not linked". A sentence promising what is already under it,
		// and pointing at the place it is standing in, is worse than no sentence.
		// The band and the stats line say the same thing where the thing is.
		bodyEl.appendChild(svg);

		lastGeo = { pos: pos, edges: c.edges, names: names, width: width, height: height };
		wireCanvas(svg);
		if (link.from) drawLive(link.at);

		var backCount = backList.length;
		var stats = [
			tn('graph.stat_diamonds', store.diamonds.length),
			tn('graph.stat_links', c.edges.length),
		];
		if (backCount)  stats.push(tn('graph.stat_cycles', backCount));
		if (c.dangling) stats.push(tn('graph.stat_dangling', c.dangling));
		var line = document.createElement('div');
		line.className = 'graph-stats';
		line.textContent = stats.join(' · ');
		bodyEl.appendChild(line);

		restorePan();
	}

	/// Where the layout would put every Diamond, ignoring anything stored.
	///
	/// Split out of the draw because "organise" needs exactly this and nothing
	/// else: the coordinates the instrument would choose, which it then writes
	/// down. Two calls on one store give one answer, which is what makes
	/// organising twice the same as organising once.
	function autoLayout(ids, isolates, edges, back) {
		var layer = layerise(ids, edges, back);
		var depth = 0;
		ids.forEach(function (id) { if (layer[id] > depth) depth = layer[id]; });
		var layers = [];
		for (var L = 0; L <= depth && ids.length; L++) layers.push([]);
		ids.forEach(function (id) { layers[layer[id]].push(id); });
		order(layers, edges, back);
		return geometry(layers, isolates);
	}

	// ── Organising ─────────────────────────────────────────────

	/// Lay every Diamond out again, and WRITE where the layout put it.
	///
	/// What it optimises, stated plainly because "reduce clutter" is not a
	/// specification. It does three things and no more:
	///
	///   1. It puts every connected Diamond on a layer equal to the longest chain
	///      of links ending at it, so every forward arrow reads downwards and the
	///      depth of the structure is the height of the picture.
	///   2. It orders each layer by the barycentre heuristic -- four sweeps down
	///      and up, a node pulled towards the average position of its neighbours
	///      -- which REDUCES crossings between adjacent layers. It does not
	///      minimise them: the minimum crossing number is NP-hard, and a
	///      heuristic that lands on it is lucky rather than correct.
	///   3. It staggers the labels of parallel links along their own lines, so
	///      two relations between one pair are two readable words.
	///
	/// What it does NOT do: it does not shorten edges, it does not straighten
	/// long ones through dummy nodes (so a link spanning four layers still cuts
	/// across the three between), it does not consider the WIDTH of a name, and
	/// it does not try to keep a label off a line it does not belong to. Nor does
	/// it read the positions it is about to overwrite -- which is why running it
	/// twice from one store gives one picture.
	function organise() {
		if (!lastStore) return refresh();
		var c = classify(lastStore);
		var touched = {};
		c.edges.forEach(function (e) { touched[e.from] = true; touched[e.to] = true; });
		var ids      = lastStore.diamonds.map(function (d) { return d.id; }).filter(function (id) { return touched[id]; });
		var isolates = lastStore.diamonds.map(function (d) { return d.id; }).filter(function (id) { return !touched[id]; });
		var out = {};
		ids.forEach(function (id) { out[id] = []; });
		c.edges.forEach(function (e) { out[e.from].push(e); });
		ids.forEach(function (id) {
			out[id].sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
		});
		var cyc  = findCycles(ids, out);
		var auto = autoLayout(ids, isolates, c.edges, cyc.back);
		// One stamp for the whole arrangement: organising is one act, and giving
		// each box its own millisecond would let a sync interleave two of them.
		var now = Date.now();
		Object.keys(auto.pos).forEach(function (id) {
			putPos(id, auto.pos[id].x, auto.pos[id].y, now);
		});
		saveLayout();
		redraw();
	}

	/// Forget every stored position, so the whole picture is computed again.
	function resetAll() {
		var l = loadLayout();
		l.pos = {};
		saveLayout();
		redraw();
	}

	// ── The view ───────────────────────────────────────────────

	// Set while the view is being put back, so the scroll that causes does not
	// come back round as a scroll the user made. A panel drawn before it has been
	// laid out has no room to scroll in, and saving the nought the browser
	// clamped to would lose the pan on every redraw.
	var restoring = false;

	/// Put the view back where it was left. The picture is drawn at a fixed scale
	/// and panned by scrolling, so the pan IS the scroll offset.
	function restorePan() {
		var p = loadLayout().pan;
		if (!bodyEl) return;
		if (!p.x && !p.y) return;
		restoring = true;
		bodyEl.scrollLeft = p.x;
		bodyEl.scrollTop  = p.y;
		setTimeout(function () { restoring = false; }, 0);
	}

	function savePan() {
		if (!bodyEl || restoring) return;
		var l = loadLayout();
		l.pan = { x: Math.round(bodyEl.scrollLeft), y: Math.round(bodyEl.scrollTop) };
		saveLayout();
	}

	function resetView() {
		var l = loadLayout();
		l.pan = { x: 0, y: 0 };
		saveLayout();
		if (!bodyEl) return;
		restoring = true;
		bodyEl.scrollLeft = 0;
		bodyEl.scrollTop  = 0;
		setTimeout(function () { restoring = false; }, 0);
	}

	// ── The toolbar ────────────────────────────────────────────

	var bar = null, barLink = null, barOrg = null, barSay = null;

	/// The strip above the picture. Built once, into the panel rather than into
	/// the scrolling body, so it neither scrolls away nor is wiped by a redraw.
	function buildToolbar() {
		var p = panelEl();
		if (!p || !bodyEl || bar) return;
		bar = h('div', 'graph-bar');

		barLink = h('button', 'graph-btn', t('graph.link_mode'));
		barLink.type = 'button';
		barLink.id = 'graph-link-btn';
		barLink.title = t('graph.link_help');
		barLink.setAttribute('aria-pressed', 'false');
		barLink.addEventListener('click', function () { toggleLinkMode(); });

		barOrg = h('button', 'graph-btn', t('graph.organise'));
		barOrg.type = 'button';
		barOrg.id = 'graph-organise-btn';
		barOrg.title = t('graph.organise_help');
		barOrg.addEventListener('click', function () { organise(); });

		barSay = h('span', 'graph-say', '');
		barSay.id = 'graph-say';

		bar.appendChild(barLink);
		bar.appendChild(barOrg);
		bar.appendChild(barSay);
		p.insertBefore(bar, bodyEl);
	}

	function paintToolbar(on) {
		buildToolbar();
		if (!bar) return;
		bar.style.display = on ? '' : 'none';
		if (!barLink) return;
		barLink.textContent = t('graph.link_mode');
		barLink.title = t('graph.link_help');
		barLink.classList.toggle('on', !!link.armed);
		barLink.setAttribute('aria-pressed', link.armed ? 'true' : 'false');
		barOrg.textContent = t('graph.organise');
		barOrg.title = t('graph.organise_help');
		barSay.textContent = link.armed
			? (link.from ? t('graph.pick_target', { name: nameOf(link.from) }) : t('graph.pick_source'))
			: '';
	}

	function nameOf(id) {
		if (!lastStore) return id;
		var d = lastStore.diamonds.filter(function (x) { return x.id === id; })[0];
		return d && d.name && d.name.trim() ? d.name : t('graph.unnamed');
	}

	// ── Linking by click ───────────────────────────────────────

	// `armed` is the mode; `from` is the source once one has been picked; `at` is
	// where the pointer was, in picture coordinates, for the live arrow.
	var link = { armed: false, from: null, at: null };

	function toggleLinkMode(on) {
		var want = (on === undefined) ? !link.armed : !!on;
		link.armed = want;
		if (!want) { link.from = null; link.at = null; }
		clearLive();
		paintToolbar(true);
		if (bodyEl) bodyEl.classList.toggle('linking', link.armed);
		redraw();
	}

	/// Leave link mode. The one way out, so Escape, a click on empty space and
	/// the button all end in the same state.
	function cancelLink() {
		if (!link.armed && !link.from) return false;
		toggleLinkMode(false);
		return true;
	}

	/// A pointer position in the picture's own coordinates.
	function atPoint(svg, ev) {
		var r = svg.getBoundingClientRect();
		var vb = (svg.getAttribute('viewBox') || '0 0 1 1').split(/\s+/);
		var w = parseFloat(vb[2]) || 1, hgt = parseFloat(vb[3]) || 1;
		// The SVG is drawn at its own size, so this is a translation and not a
		// scale -- but the ratio is taken anyway, so a stylesheet that ever does
		// scale it cannot silently put the arrow somewhere else.
		return {
			x: (ev.clientX - r.left) * (w / (r.width || w)),
			y: (ev.clientY - r.top)  * (hgt / (r.height || hgt)),
		};
	}

	function liveLayer() {
		var svg = bodyEl && bodyEl.querySelector('svg#graph-svg');
		return svg ? svg.querySelector('g.graph-live') : null;
	}

	function clearLive() {
		var g = liveLayer();
		if (g) g.textContent = '';
	}

	/// The arrow that follows the pointer while a link is being drawn.
	///
	/// The only moving thing in the module. It is drawn from the source box's
	/// nearest edge to wherever the pointer is, it lives in `g.graph-live`, and
	/// it is thrown away the moment the gesture ends. Nothing about it is ever
	/// stored, so no reload can show it and no two devices can disagree about it.
	function drawLive(at) {
		var g = liveLayer();
		if (!g) return;
		g.textContent = '';
		if (!link.from || !at || !lastGeo || !lastGeo.pos[link.from]) return;
		var a = lastGeo.pos[link.from];
		var ac = { x: a.x + NODE_W / 2, y: a.y + NODE_H / 2 };
		// Leave the box on the side the pointer is, so the line never starts
		// under the box it starts at.
		var dx = at.x - ac.x, dy = at.y - ac.y;
		var p0 = Math.abs(dx) > Math.abs(dy)
			? { x: dx >= 0 ? a.x + NODE_W : a.x, y: ac.y }
			: { x: ac.x, y: dy >= 0 ? a.y + NODE_H : a.y };
		g.appendChild(attrs(el('path', 'graph-live-line'), {
			d: 'M' + p0.x + ',' + p0.y + ' L' + at.x + ',' + at.y,
			'marker-end': 'url(#gm-arrow-live)',
		}));
	}

	/// A click landed on a Diamond while link mode was armed.
	function linkClick(id) {
		if (!link.from) {
			link.from = id;
			link.at = null;
			paintToolbar(true);
			redraw();
			return;
		}
		if (link.from === id) {
			// The store refuses a link from a thing to itself, and it is right to:
			// a loop on one box says nothing. Say so rather than failing silently.
			say(t('graph.self_link'));
			return;
		}
		var from = link.from;
		toggleLinkMode(false);
		openEditor({ mode: 'new', from: from, to: id });
	}

	/// A sentence in the toolbar, for a refusal that has nowhere else to go.
	function say(msg) {
		if (!barSay) return;
		barSay.textContent = msg;
		barSay.classList.add('warn');
		setTimeout(function () {
			if (!barSay) return;
			barSay.classList.remove('warn');
			paintToolbar(true);
		}, 2600);
	}

	// ── Dragging a Diamond ─────────────────────────────────────

	var drag = null;    // { id, g, orig, from, moved }

	function startDrag(g, id, ev, svg) {
		var at = atPoint(svg, ev);
		drag = {
			id: id, g: g, svg: svg,
			orig: lastGeo && lastGeo.pos[id] ? { x: lastGeo.pos[id].x, y: lastGeo.pos[id].y } : { x: 0, y: 0 },
			from: at, moved: false,
		};
		g.classList.add('dragging');
		document.addEventListener('mousemove', onDragMove, true);
		document.addEventListener('mouseup', onDragUp, true);
	}

	function onDragMove(ev) {
		if (!drag) return;
		var at = atPoint(drag.svg, ev);
		var dx = at.x - drag.from.x, dy = at.y - drag.from.y;
		if (!drag.moved && Math.abs(dx) < DRAG_MIN && Math.abs(dy) < DRAG_MIN) return;
		drag.moved = true;
		var x = Math.max(0, Math.round(drag.orig.x + dx));
		var y = Math.max(0, Math.round(drag.orig.y + dy));
		drag.g.setAttribute('transform', 'translate(' + x + ',' + y + ')');
		drag.now = { x: x, y: y };
		ev.preventDefault();
	}

	function onDragUp() {
		if (!drag) return;
		var d = drag;
		endDrag();
		if (!d.moved || !d.now) return;
		// The one write. Everything before it was the pointer moving a box about;
		// this is what makes the picture reproduce.
		putPos(d.id, d.now.x, d.now.y);
		saveLayout();
		swallowClick();
		redraw();
	}

	/// Eat the click the browser fires after the mouseup that ended a drag.
	///
	/// Cleared on the next task rather than by the click itself: a release
	/// outside the picture fires no click at all, and a flag nothing clears would
	/// swallow the next real one instead.
	function swallowClick() {
		suppressClick = true;
		setTimeout(function () { suppressClick = false; }, 0);
	}

	/// Put the box back and forget the gesture. Escape during a drag lands here,
	/// so a drag begun by accident costs nothing.
	function abortDrag() {
		if (!drag) return false;
		var d = drag;
		endDrag();
		d.g.setAttribute('transform', 'translate(' + d.orig.x + ',' + d.orig.y + ')');
		swallowClick();
		return true;
	}

	function endDrag() {
		if (drag && drag.g) drag.g.classList.remove('dragging');
		drag = null;
		document.removeEventListener('mousemove', onDragMove, true);
		document.removeEventListener('mouseup', onDragUp, true);
	}

	// ── Panning ────────────────────────────────────────────────

	var pan = null;   // { x, y, left, top }

	function startPan(ev) {
		pan = { x: ev.clientX, y: ev.clientY, left: bodyEl.scrollLeft, top: bodyEl.scrollTop };
		bodyEl.classList.add('panning');
		document.addEventListener('mousemove', onPanMove, true);
		document.addEventListener('mouseup', onPanUp, true);
	}

	function onPanMove(ev) {
		if (!pan) return;
		bodyEl.scrollLeft = pan.left - (ev.clientX - pan.x);
		bodyEl.scrollTop  = pan.top  - (ev.clientY - pan.y);
		ev.preventDefault();
	}

	function onPanUp() {
		if (!pan) return;
		endPan();
		savePan();
	}

	function endPan() {
		pan = null;
		if (bodyEl) bodyEl.classList.remove('panning');
		document.removeEventListener('mousemove', onPanMove, true);
		document.removeEventListener('mouseup', onPanUp, true);
	}

	// ── The right-click menu ───────────────────────────────────

	var menu = null;

	function closeMenu() {
		if (!menu) return false;
		menu.remove();
		menu = null;
		return true;
	}

	/// Put a floating thing inside the panel, clamped so it cannot be drawn
	/// outside the card -- the card clips, so anything past its edge is gone
	/// rather than merely awkward.
	function place(node, clientX, clientY) {
		var p = panelEl();
		if (!p) return;
		p.appendChild(node);
		var pr = p.getBoundingClientRect();
		var nr = node.getBoundingClientRect();
		var x = clientX - pr.left, y = clientY - pr.top;
		x = Math.max(4, Math.min(x, pr.width  - nr.width  - 4));
		y = Math.max(4, Math.min(y, pr.height - nr.height - 4));
		node.style.left = x + 'px';
		node.style.top  = y + 'px';
	}

	/// The menu the right button opens. What is on it depends on what was under
	/// the pointer, so a right-click on a link offers the link's own actions and
	/// one on empty space offers the picture's.
	function openMenu(ev, ctx) {
		closeMenu();
		closeEditor();
		menu = h('div', 'graph-menu');
		menu.id = 'graph-menu';
		menu.setAttribute('role', 'menu');

		function item(label, fn, cls) {
			var b = h('button', 'graph-menu-item' + (cls ? ' ' + cls : ''), label);
			b.type = 'button';
			b.setAttribute('role', 'menuitem');
			b.addEventListener('click', function () { closeMenu(); fn(); });
			menu.appendChild(b);
			return b;
		}
		function sep() { menu.appendChild(h('div', 'graph-menu-sep')); }

		if (ctx.node) {
			item(t('graph.menu_link'), function () {
				toggleLinkMode(true);
				link.from = ctx.node;
				paintToolbar(true);
				redraw();
			});
			item(t('graph.menu_open'), function () { select(ctx.node); });
			if (storedPos(ctx.node)) {
				item(t('graph.menu_reset_node'), function () {
					dropPos(ctx.node); saveLayout(); redraw();
				});
			}
			sep();
		}
		if (ctx.link) {
			item(t('graph.menu_edit_link'), function () {
				openEditor({ mode: 'edit', link: ctx.link, at: { x: ev.clientX, y: ev.clientY } });
			});
			item(t('graph.menu_drop_link'), function () { dropLink(ctx.link); }, 'danger');
			sep();
		}
		item(t('graph.organise'), organise);
		item(t('graph.menu_reset_all'), resetAll);
		item(t('graph.menu_reset_view'), resetView);

		place(menu, ev.clientX, ev.clientY);
	}

	// ── Editing a link ─────────────────────────────────────────

	var editor = null;

	function closeEditor() {
		if (!editor) return false;
		editor.remove();
		editor = null;
		return true;
	}

	/// The link form: a relation, a note, and the two or three things that can be
	/// done with them.
	///
	/// Deliberately small. The store's own words are that a relation is a word
	/// and a note is a sentence, and a form with more fields than the record has
	/// would be inviting the user to fill in something nothing reads.
	///
	/// SAVING AN EXISTING LINK RE-ASSERTS IT. The store has `add_link` and
	/// `remove_link` and no update, and a link is deliberately never edited in
	/// place -- `union_links` keys by id, so two copies sharing an id are one
	/// record. An edit is therefore a delete and a fresh assertion, which gives
	/// the link a new id and a new timestamp; the form says so rather than
	/// letting the user discover it. `src/wasm/diamond.rs` wanting an
	/// `update_link` is the real fix and is not one this module may make.
	function openEditor(spec) {
		closeMenu();
		closeEditor();
		var isNew = spec.mode === 'new';
		var l = spec.link || null;

		editor = h('div', 'graph-edit');
		editor.id = 'graph-edit';
		editor.setAttribute('role', 'dialog');
		editor.setAttribute('aria-label', isNew ? t('graph.new_title') : t('graph.edit_title'));

		var from = isNew ? spec.from : l.from;
		var to   = isNew ? spec.to   : l.to;
		editor.appendChild(h('div', 'graph-edit-head',
			nameOf(from) + ' → ' + nameOf(to)));

		var relLab = h('label', 'graph-edit-lab', t('graph.rel_label'));
		var rel = h('input', 'graph-edit-input');
		rel.type = 'text';
		rel.id = 'graph-edit-rel';
		rel.placeholder = t('graph.rel_ph');
		rel.value = l ? (l.rel || '') : '';
		rel.setAttribute('list', 'graph-rel-list');
		relLab.setAttribute('for', rel.id);
		editor.appendChild(relLab);
		editor.appendChild(rel);
		editor.appendChild(relations());

		var noteLab = h('label', 'graph-edit-lab', t('graph.note_label'));
		var note = h('textarea', 'graph-edit-note');
		note.id = 'graph-edit-note';
		note.rows = 2;
		note.placeholder = t('graph.note_ph');
		note.value = l ? (l.note || '') : '';
		noteLab.setAttribute('for', note.id);
		editor.appendChild(noteLab);
		editor.appendChild(note);


		var row = h('div', 'graph-edit-row');
		var ok = h('button', 'graph-btn primary', isNew ? t('graph.create') : t('graph.save'));
		ok.type = 'button';
		ok.id = 'graph-edit-ok';
		ok.addEventListener('click', function () {
			var r = rel.value, n = note.value;
			closeEditor();
			if (isNew) addLink(from, to, r, n);
			else       replaceLink(l, r, n);
		});
		var cancel = h('button', 'graph-btn', t('graph.cancel'));
		cancel.type = 'button';
		cancel.id = 'graph-edit-cancel';
		cancel.addEventListener('click', function () { closeEditor(); });
		row.appendChild(ok);
		row.appendChild(cancel);
		if (!isNew) {
			var del = h('button', 'graph-btn danger', t('graph.drop'));
			del.type = 'button';
			del.id = 'graph-edit-delete';
			del.addEventListener('click', function () { closeEditor(); dropLink(l); });
			row.appendChild(del);
		}
		editor.appendChild(row);

		var at = spec.at || anchorOf(l) || { x: 0, y: 0 };
		place(editor, at.x, at.y);
		rel.focus();
	}

	/// The relations already in use, offered as completions. Suggesting a word
	/// the store already holds is what keeps `part-of` from becoming three
	/// relations spelled three ways.
	function relations() {
		var seen = {}, list = h('datalist');
		list.id = 'graph-rel-list';
		if (lastStore) {
			lastStore.links.forEach(function (l) {
				var r = (l.rel || '').trim();
				if (!r || seen[r]) return;
				seen[r] = 1;
				var o = document.createElement('option');
				o.value = r;
				list.appendChild(o);
			});
		}
		return list;
	}

	/// Where on screen a link's own line is, so the form opens beside the thing
	/// it is about.
	function anchorOf(l) {
		if (!l || !bodyEl) return null;
		var g = bodyEl.querySelector('g.graph-edge[data-link-id="' + cssq(l.id) + '"] path.graph-edge-line');
		if (!g || !g.getBoundingClientRect) return null;
		var r = g.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	}

	function cssq(s) {
		return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
	}

	// ── Writing ────────────────────────────────────────────────

	/// Tell the rest of the app a link changed, exactly as its own link form
	/// does, so the Diamond's list and its artefact strip repaint too.
	function announce() {
		document.dispatchEvent(new CustomEvent('daimond-links-changed'));
	}

	function addLink(from, to, rel, note) {
		return reader().then(function (a) {
			// The source Diamond owns the record. `all_links` walks the sidecars,
			// so which one holds it decides nothing about the picture -- but it
			// decides which Diamond is stamped, and the assertion belongs to the
			// end that made it.
			return a.add_link(from, 'diamond:' + from, 'diamond:' + to, rel || '', note || '', 'user');
		}).then(function () {
			announce();
		}).catch(function (e) {
			say(t('graph.write_failed', { err: (e && e.message) || String(e) }));
		});
	}

	function dropLink(l) {
		return reader().then(function (a) {
			return a.remove_link(l.owner, l.id);
		}).then(function () {
			announce();
		}).catch(function (e) {
			say(t('graph.write_failed', { err: (e && e.message) || String(e) }));
		});
	}

	/// Revise a link in place.
	///
	/// This used to be a delete and a fresh assertion, because the store had no
	/// update — so changing the word on a line gave it a new id and a new `ts`,
	/// and the record of when the relationship was first asserted was lost. The
	/// dialog said so in a line of its own; `update_link` means it no longer has
	/// to. No equality check here either: `update_link` makes the same judgement,
	/// and makes it after normalising, so "  INFORMS  " over `informs` correctly
	/// writes nothing and does not stamp the Diamond for having done nothing.
	function replaceLink(l, rel, note) {
		return reader().then(function (a) {
			return a.update_link(l.owner, l.id, rel || '', note || '');
		}).then(function () {
			announce();
		}).catch(function (e) {
			say(t('graph.write_failed', { err: (e && e.message) || String(e) }));
		});
	}

	// ── Wiring the picture ─────────────────────────────────────

	var suppressClick = false;

	/// The one place a pointer meets the picture. Re-attached on every draw,
	/// because the SVG is rebuilt on every draw.
	function wireCanvas(svg) {
		svg.addEventListener('mousedown', function (ev) {
			if (ev.button === 1) {           // middle: pan
				ev.preventDefault();
				startPan(ev);
				return;
			}
			if (ev.button !== 0) return;
			closeMenu();
			var g = ev.target.closest ? ev.target.closest('.graph-node') : null;
			// Not while linking: there the press is a pick, and a box that slid
			// under the pointer as the link was aimed would be a surprise.
			if (g && g.dataset.diamondId && !link.armed) {
				// Or the browser sweeps a text selection across every label the
				// pointer passes, which is what a press-and-move means to it.
				ev.preventDefault();
				startDrag(g, g.dataset.diamondId, ev, svg);
			}
		});

		svg.addEventListener('click', function (ev) {
			if (suppressClick) { suppressClick = false; return; }
			var node = ev.target.closest ? ev.target.closest('.graph-node') : null;
			var edge = ev.target.closest ? ev.target.closest('.graph-edge') : null;
			if (node && node.dataset.diamondId) {
				if (link.armed) linkClick(node.dataset.diamondId);
				else            select(node.dataset.diamondId);
				return;
			}
			if (edge && edge.dataset.linkId) {
				var l = linkById(edge.dataset.linkId);
				if (l) openEditor({ mode: 'edit', link: l, at: { x: ev.clientX, y: ev.clientY } });
				return;
			}
			// Empty space. The way out of link mode a pointer already knows, and
			// the way out of anything else standing open.
			if (cancelLink()) return;
			closeEditor();
		});

		svg.addEventListener('mousemove', function (ev) {
			if (!link.from) return;
			link.at = atPoint(svg, ev);
			drawLive(link.at);
		});

		svg.addEventListener('contextmenu', function (ev) {
			ev.preventDefault();
			var node = ev.target.closest ? ev.target.closest('.graph-node') : null;
			var edge = ev.target.closest ? ev.target.closest('.graph-edge') : null;
			openMenu(ev, {
				node: node ? node.dataset.diamondId : null,
				link: edge ? linkById(edge.dataset.linkId) : null,
			});
		});

		// Chrome's autoscroll would otherwise take the middle button off us.
		svg.addEventListener('auxclick', function (ev) { if (ev.button === 1) ev.preventDefault(); });
		bodyEl.addEventListener('scroll', onScroll);
	}

	var scrollTimer = null;
	/// Remember the view after the scrolling stops, not on every pixel of it.
	function onScroll() {
		if (scrollTimer) clearTimeout(scrollTimer);
		scrollTimer = setTimeout(function () { scrollTimer = null; savePan(); }, 250);
	}

	function linkById(id) {
		if (!lastStore || !id) return null;
		var hit = lastStore.links.filter(function (l) { return l.id === id; })[0];
		if (!hit) return null;
		return {
			id: hit.id, owner: hit.owner, rel: hit.rel || '', note: hit.note || '',
			from: diamondOf(hit.from), to: diamondOf(hit.to),
		};
	}

	/// Everything that is open, shut, in the order a user means when they press
	/// Escape: the innermost thing first.
	///
	/// One function and one key handler, on the document rather than on the
	/// panel, because a handler that only fires while the focus is inside the
	/// thing stops working the moment somebody clicks the words they are reading.
	function dismiss() {
		if (closeEditor()) return true;
		if (closeMenu()) return true;
		if (abortDrag()) return true;
		if (cancelLink()) return true;
		return false;
	}

	// ── Refreshing ─────────────────────────────────────────────

	function panelEl() { return document.getElementById('panel-graph'); }

	function visible() {
		var p = panelEl();
		return !!(p && !p.classList.contains('closed') && p.offsetParent !== null);
	}

	/// Whether there is an account open to draw the store of.
	///
	/// Until the gate is passed the OPFS namespace is not the signed-in one, so a
	/// draw made then would show an EMPTY store -- and would look exactly like a
	/// workspace with nothing in it. Better to draw nothing and wait.
	function unlocked() {
		var m = document.getElementById('identity-modal');
		return !m || m.style.display === 'none';
	}

	/// Draw again from what was last read, for a change that is the layout's
	/// alone -- a drag, an organise, arming the mode. Going back to OPFS for it
	/// would be a read the store has nothing new to answer.
	function redraw() {
		if (!bodyEl || !lastStore) return refresh();
		render(lastStore);
	}

	/// Redraw from the store. Safe to call before init, and safe to call twice:
	/// a request arriving mid-draw is folded into one more draw at the end.
	function refresh() {
		bodyEl = document.getElementById('graph-body');
		if (!bodyEl) return Promise.resolve();
		if (!unlocked()) return Promise.resolve();
		// A redraw under a gesture would pull the box out from under the pointer.
		if (drag || pan) { again = true; return Promise.resolve(); }
		if (drawing) { again = true; return Promise.resolve(); }
		drawing = true;
		closeMenu();
		return load().then(function (store) {
			render(store);
		}).catch(function (e) {
			// A failed read must not leave the last picture standing, or it
			// reads as the current one.
			app = null;
			lastStore = null;
			bodyEl.textContent = '';
			var p = document.createElement('p');
			p.className = 'graph-empty';
			p.textContent = t('graph.failed', { err: (e && e.message) || String(e) });
			bodyEl.appendChild(p);
		}).then(function () {
			drawing = false;
			if (again) { again = false; return refresh(); }
		});
	}

	/// Redraw only when the pane is on screen, which is every trigger below
	/// except being opened.
	function refreshIfVisible() {
		if (visible()) refresh();
	}

	function init() {
		bodyEl = document.getElementById('graph-body');
		if (!bodyEl) return;

		// The other half of the link UI says when a link changed.
		document.addEventListener('daimond-links-changed', refreshIfVisible);
		// Another tab's Diamond mutation. OPFS fires nothing across tabs; this
		// nonce in localStorage is the only signal there is.
		window.addEventListener('storage', function (e) {
			if (e.key === 'daimond-diamonds-rev') refreshIfVisible();
			// Another tab moved a box. The shim in accounts.js prefixes the key
			// per account, so it is the SUFFIX that identifies it -- and only the
			// current account's tab is looking at the current account's picture.
			if (e.key && e.key.length >= LAYOUT_KEY.length
				&& e.key.slice(-LAYOUT_KEY.length) === LAYOUT_KEY) {
				layout = null;
				refreshIfVisible();
			}
		});
		// Escape, from anywhere. Capture, so a form field inside the editor
		// cannot swallow it first.
		document.addEventListener('keydown', function (e) {
			if (e.key !== 'Escape') return;
			if (!visible() && !menu && !editor) return;
			if (dismiss()) { e.stopPropagation(); e.preventDefault(); }
		}, true);
		// A click anywhere else shuts the menu, which is how every menu behaves.
		document.addEventListener('mousedown', function (e) {
			if (menu && !menu.contains(e.target)) closeMenu();
			if (editor && !editor.contains(e.target)
				&& !(e.target.closest && e.target.closest('.graph-edge'))) closeEditor();
		}, true);
		// And when the panel is opened, since it is drawn on being shown rather
		// than kept up to date while nobody is looking at it.
		var p = panelEl();
		if (p) {
			var was = visible();
			new MutationObserver(function () {
				var now = visible();
				if (now && !was) refresh();
				if (!now && was) { closeMenu(); closeEditor(); cancelLink(); }
				was = now;
			}).observe(p, { attributes: true, attributeFilter: ['class', 'style'] });
		}
		// And when the gate comes down. A saved layout can have this panel
		// already open at the moment the page loads, in which case it never
		// transitions from hidden to shown and the observer above never fires --
		// so signing in has to be a trigger in its own right. It is also the
		// trigger for a SWITCH of account, which changes the whole store, and
		// therefore the whole arrangement.
		var gate = document.getElementById('identity-modal');
		if (gate) {
			var wasLocked = !unlocked();
			new MutationObserver(function () {
				var lockedNow = !unlocked();
				if (wasLocked && !lockedNow) { layout = null; refreshIfVisible(); }
				wasLocked = lockedNow;
			}).observe(gate, { attributes: true, attributeFilter: ['class', 'style'] });
		}
		if (window.DaimondI18n) DaimondI18n.onChange(function () {
			paintToolbar(!!(lastStore && lastStore.diamonds.length));
			refreshIfVisible();
		});
		if (visible()) refresh();
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
	else init();

	window.DaimondGraph = {
		/// Redraw from the store. Safe to call before init.
		refresh: refresh,
		/// Lay the Diamonds out again and keep where the layout put them.
		organise: organise,
		/// Arm or disarm link mode; with no argument, toggle it.
		linkMode: toggleLinkMode,
		/// Shut whatever is open, innermost first. Returns whether anything was.
		escape:   dismiss,
		/// The stored arrangement, for the sync parcel. Positions only: the pan is
		/// this window's, not this account's.
		snapshot: snapshot,
		/// Take an arrangement from the sync, merged per Diamond by its stamp.
		adopt:    adopt,
		/// What is on screen, for a verifier: where every box is and what the
		/// store said. Never used by the app itself.
		_geometry: function () { return lastGeo; },
	};
})();
