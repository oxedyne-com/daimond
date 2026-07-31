/* graph.js — the Diamonds and the links between them, drawn as one still,
 * layered picture inside #graph-body.
 *
 * This is a verification instrument, not an ornament. Its whole value is that
 * the same store always draws the same picture: a person looks at it to check
 * that the association structure is the one they believe they built, and a
 * picture that rearranged itself between two looks could not settle that
 * question. So there is no force-direction, no animation and no randomness
 * anywhere below — every coordinate is a pure function of the stored records,
 * and the records are put in a stable order (by Diamond id, then by link id)
 * before anything is computed from them.
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
 *     to draw one would hide exactly the case worth seeing.
 */
(function () {
	'use strict';

	// The wasm module, resolved against THIS script rather than the document, so
	// the app still finds it when served from a sub-path.
	var SELF = (document.currentScript && document.currentScript.src) || '';
	var PKG  = SELF ? new URL('../pkg/oxedyne_daimond.js', SELF).href
	                : '../pkg/oxedyne_daimond.js';

	function t(k, v)     { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }
	function tn(k, n, v) { return window.DaimondI18n ? DaimondI18n.tn(k, n, v) : k; }

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

	var bodyEl  = null;
	var app     = null;     // the wasm handle, built once
	var drawing = false;    // one draw at a time; the last request wins
	var again   = false;

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

	/// Work out where every box goes. Pure arithmetic over the ordered layers.
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
		[['gm-arrow', 'graph-arrow'], ['gm-arrow-back', 'graph-arrow back']].forEach(function (pair) {
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
		var g = el('g', 'graph-node' + (marks.isolate ? ' isolate' : '') + (marks.cycle ? ' cycled' : ''));
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

	/// One link, arrowed from its `from` end to its `to` end. `labelT` says how far
	/// along the line its relation is written, which is what holds two relations
	/// between one pair apart.
	function edgeEl(e, pos, isBack, nudge, bow, labelT, names) {
		var a = pos[e.from], b = pos[e.to];
		var g = el('g', 'graph-edge' + (isBack ? ' back' : ''));
		g.setAttribute('data-link-id', e.id);
		g.setAttribute('data-from', e.from);
		g.setAttribute('data-to', e.to);

		var p0, p1, p2, p3;
		if (isBack) {
			// Out to the right of everything and back, so a closing edge never
			// reads as one more step down the hierarchy.
			p0 = { x: a.x + NODE_W, y: a.y + NODE_H / 2 };
			p3 = { x: b.x + NODE_W, y: b.y + NODE_H / 2 };
			p1 = { x: p0.x + bow, y: p0.y };
			p2 = { x: p3.x + bow, y: p3.y };
		} else {
			p0 = { x: a.x + NODE_W / 2 + nudge, y: a.y + NODE_H };
			p3 = { x: b.x + NODE_W / 2 + nudge, y: b.y };
			var dy = Math.max(24, p3.y - p0.y);
			p1 = { x: p0.x, y: p0.y + dy * 0.42 };
			p2 = { x: p3.x, y: p3.y - dy * 0.42 };
		}
		var path = attrs(el('path', 'graph-edge-line'), {
			d: 'M' + p0.x + ',' + p0.y + ' C' + p1.x + ',' + p1.y + ' ' + p2.x + ',' + p2.y + ' ' + p3.x + ',' + p3.y,
			'marker-end': 'url(#' + (isBack ? 'gm-arrow-back' : 'gm-arrow') + ')',
		});
		g.appendChild(path);

		var lines = [t('graph.edge_tip', { from: names[e.from], to: names[e.to] })];
		if (e.rel)  lines.push(t('graph.edge_rel', { rel: e.rel }));
		if (e.note) lines.push(e.note);
		if (isBack) lines.push(t('graph.back_edge'));
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

		if (!store.diamonds.length) {
			var none = document.createElement('p');
			none.className = 'graph-empty';
			none.textContent = t('graph.no_diamonds');
			bodyEl.appendChild(none);
			return;
		}

		var names = {};
		store.diamonds.forEach(function (d) {
			names[d.id] = (d.name && d.name.trim()) ? d.name : t('graph.unnamed');
		});

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
		var layer = layerise(ids, c.edges, cyc.back);
		var depth = 0;
		ids.forEach(function (id) { if (layer[id] > depth) depth = layer[id]; });
		var layers = [];
		for (var L = 0; L <= depth && ids.length; L++) layers.push([]);
		ids.forEach(function (id) { layers[layer[id]].push(id); });

		// Crossing reduction first, then the geometry, which is a pure function
		// of the layers once they are ordered.
		order(layers, c.edges, cyc.back);
		var geo = geometry(layers, isolates);

		// Back edges bow out to the right; the widest of them decides the
		// drawing's right margin.
		var backList = c.edges.filter(function (e) { return cyc.back[e.id]; });
		var bows = {}, maxBow = 0;
		backList.forEach(function (e, i) {
			var b = 48 + i * 20;
			bows[e.id] = b;
			if (b > maxBow) maxBow = b;
		});

		var width  = geo.contentW + 2 * PAD + (maxBow ? maxBow + 24 : 0);
		var height = geo.height;

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
			var k = e.from + ' ' + e.to;
			(groups[k] || (groups[k] = [])).push(e);
		});

		var edgesG = el('g', 'graph-edges');
		c.edges.forEach(function (e) {
			var isBack = !!cyc.back[e.id];
			var grp    = groups[e.from + ' ' + e.to];
			var lane   = grp.length > 1 ? grp.indexOf(e) - (grp.length - 1) / 2 : 0;
			// A closing edge is already held off its neighbours by its own bow, so
			// only a forward line is moved sideways; the label moves either way.
			var nudge  = isBack ? 0 : lane * NUDGE;
			var labelT = 0.5 + lane * Math.min(LABEL_T, LABEL_SPAN / grp.length);
			edgesG.appendChild(edgeEl(e, geo.pos, isBack, nudge, bows[e.id] || 0, labelT, names));
		});
		svg.appendChild(edgesG);

		var nodesG = el('g', 'graph-nodes');
		store.diamonds.forEach(function (d) {
			if (!geo.pos[d.id]) return;
			nodesG.appendChild(nodeEl(d, geo.pos[d.id], {
				artefacts: c.artefact[d.id] || 0,
				cycle:     !!cyc.onCycle[d.id],
				isolate:   !touched[d.id],
			}));
		});
		svg.appendChild(nodesG);

		if (isolates.length) {
			var band = attrs(el('text', 'graph-band'), { x: PAD, y: geo.bandY + 12 });
			band.textContent = t('graph.isolated');
			svg.appendChild(band);
		}

		nodesG.addEventListener('click', function (ev) {
			var g = ev.target.closest ? ev.target.closest('.graph-node') : null;
			if (g && g.dataset.diamondId) select(g.dataset.diamondId);
		});

		// Nothing is said here about a store that holds Diamonds but no links. The
		// line that used to be said -- that the picture appears here once two
		// Diamonds are linked -- was put ABOVE the picture, and the picture was not
		// missing: every one of those Diamonds was drawn directly below it, in the
		// band headed "not linked". A sentence promising what is already under it,
		// and pointing at the place it is standing in, is worse than no sentence.
		// The band and the stats line say the same thing where the thing is.
		bodyEl.appendChild(svg);

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

	/// Redraw from the store. Safe to call before init, and safe to call twice:
	/// a request arriving mid-draw is folded into one more draw at the end.
	function refresh() {
		bodyEl = document.getElementById('graph-body');
		if (!bodyEl) return Promise.resolve();
		if (!unlocked()) return Promise.resolve();
		if (drawing) { again = true; return Promise.resolve(); }
		drawing = true;
		return load().then(function (store) {
			render(store);
		}).catch(function (e) {
			// A failed read must not leave the last picture standing, or it
			// reads as the current one.
			app = null;
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
		});
		// And when the panel is opened, since it is drawn on being shown rather
		// than kept up to date while nobody is looking at it.
		var p = panelEl();
		if (p) {
			var was = visible();
			new MutationObserver(function () {
				var now = visible();
				if (now && !was) refresh();
				was = now;
			}).observe(p, { attributes: true, attributeFilter: ['class', 'style'] });
		}
		// And when the gate comes down. A saved layout can have this panel
		// already open at the moment the page loads, in which case it never
		// transitions from hidden to shown and the observer above never fires --
		// so signing in has to be a trigger in its own right. It is also the
		// trigger for a SWITCH of account, which changes the whole store.
		var gate = document.getElementById('identity-modal');
		if (gate) {
			var wasLocked = !unlocked();
			new MutationObserver(function () {
				var lockedNow = !unlocked();
				if (wasLocked && !lockedNow) refreshIfVisible();
				wasLocked = lockedNow;
			}).observe(gate, { attributes: true, attributeFilter: ['class', 'style'] });
		}
		if (window.DaimondI18n) DaimondI18n.onChange(refreshIfVisible);
		if (visible()) refresh();
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
	else init();

	window.DaimondGraph = {
		/// Redraw from the store. Safe to call before init.
		refresh: refresh,
	};
})();
