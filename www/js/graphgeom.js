/* graphgeom.js — the Graph pane's geometry, as arithmetic and nothing else.
 *
 * Every function here is a function of numbers. Nothing reads the document,
 * nothing measures a word, nothing keeps state between calls. That is not
 * tidiness: the Graph's whole claim is that the same store draws the same
 * picture, and a coordinate that came from asking the browser how wide a name
 * came out would be a different coordinate on a different machine. Keeping the
 * arithmetic where no DOM is reachable is what makes the claim checkable — see
 * `www/js/graphgeom.test.mjs`, which runs the whole of it under node with no
 * browser at all.
 *
 * It is also where the arithmetic goes when it leaves JavaScript. The shapes
 * below are the shapes `fe2o3_geom::planar` is to carry: `port` is a rectangle
 * port named by side and fraction, `nearest(cands, p, tol)` IS `snap_point(cands,
 * p, tol) -> Option<Snap>`, `elbow` is the orthogonal three-segment route between
 * two rectangles, `pointAt` is the cubic point-at. When the lift happens the app
 * calls a wasm door with these names and the same answers, and this file goes.
 *
 * `nearest` is deliberately the only nearest-candidate search in the tree. The
 * Graph's magnetic snap and the Dock's drag-to-slot are the same question asked
 * of different rectangles, and two implementations of it would settle a tie two
 * ways on one app's two surfaces.
 *
 * A RECTANGLE here is `{ x, y, w, h, kink }`: its top-left corner, its size,
 * and how far its left and right points stand out from its corners. The Graph
 * draws a Diamond as a flattened hexagon — horizontal top and bottom, the two
 * sides kinked out to a point at the middle — and a kink of nought is an
 * ordinary rectangle, which is what any other caller will hand in.
 */
(function () {
	'use strict';

	/// Hold a fraction to its own side. A line held so far along a side that it
	/// left the box altogether would point at nothing.
	function clamp01(f) { return f < 0 ? 0 : f > 1 ? 1 : f; }

	/// A point on a rectangle's outline: which side, and how far along it.
	///
	/// # Arguments
	/// * `r`    - The rectangle, `{ x, y, w, h, kink }`.
	/// * `side` - `top`, `bottom`, `left` or `right`.
	/// * `f`    - How far along that side, from 0 to 1.
	///
	/// The top and bottom run corner to corner, which is the width less the two
	/// kinks. The sides are not straight, so the point is pulled in by as much
	/// of the kink as it stands away from the middle — which is what keeps an
	/// arrowhead ON the edge it lands against rather than beside it.
	function port(r, side, f) {
		var k = r.kink || 0;
		var off = k * Math.abs(1 - 2 * f);
		if (side === 'top')    return { x: r.x + k + f * (r.w - 2 * k), y: r.y };
		if (side === 'bottom') return { x: r.x + k + f * (r.w - 2 * k), y: r.y + r.h };
		if (side === 'left')   return { x: r.x + off, y: r.y + f * r.h };
		return { x: r.x + r.w - off, y: r.y + f * r.h };
	}

	/// The four anchors a rectangle offers: the middle of each side, named.
	///
	/// In a fixed order — top, right, bottom, left — so two draws of one picture
	/// put the same anchor in the same place in the list, and a verifier reading
	/// the third one is reading the same anchor it read last time.
	var SIDES = ['top', 'right', 'bottom', 'left'];
	function ports(r) {
		return SIDES.map(function (side) {
			var p = port(r, side, 0.5);
			return { side: side, f: 0.5, x: p.x, y: p.y };
		});
	}

	/// Which of the three ports on a side faces the other box, given how far off
	/// centre it lies and how much of an offset counts as "off centre".
	function portFor(d, span, thirds) {
		var t = thirds || [0.25, 0.5, 0.75];
		if (d >  span) return t[2];
		if (d < -span) return t[0];
		return t[1];
	}

	/// Is the point in the band that straddles a rectangle's outline?
	///
	/// `reach` is how far OUTSIDE the outline the band runs and `band` how far
	/// inside. A pointer in the middle of a tile is holding the tile; a pointer
	/// near its edge — or just short of it, on the way in — is reaching for an
	/// anchor. Two numbers rather than one because the two are asked for
	/// different reasons, and a single tolerance would either make the middle of
	/// a 44-pixel tile unreachable or make the anchors impossible to approach.
	function inEdgeBand(r, p, band, reach) {
		var b = band || 0, out = reach || 0;
		if (p.x < r.x - out || p.x > r.x + r.w + out) return false;
		if (p.y < r.y - out || p.y > r.y + r.h + out) return false;
		// Inside the outline by more than `band` on every side is the body.
		return !(p.x > r.x + b && p.x < r.x + r.w - b
		      && p.y > r.y + b && p.y < r.y + r.h - b);
	}

	/// How far a point is from a rectangle: nought when it is inside.
	function distToRect(r, p) {
		var dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
		var dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
		return Math.sqrt(dx * dx + dy * dy);
	}

	/// THE nearest-candidate helper, and there is deliberately only one.
	///
	/// `snap_point(cands, p, tol) -> Option<Snap>` in the shape `fe2o3_geom` is
	/// to carry it. A candidate is `{ at }` — a point — or `{ rect }`, which is
	/// nought away when the point is inside it; anything else on the candidate
	/// is the caller's and is handed back untouched. Answers `{ i, cand, d }`, or
	/// nothing when the nearest is further than `tol`.
	///
	/// TIES GO TO THE EARLIER CANDIDATE, which is why the caller's order matters
	/// and why every caller in this tree fixes one. The magnetic snap on the
	/// Graph's canvas and the slot a panel is dropped into on the Dock are the
	/// same question asked of different rectangles, and two implementations of
	/// it would answer a tie differently on two surfaces of one app.
	///
	/// `tol` is in the coordinates the points are in. A caller working in screen
	/// pixels over a scaled picture divides by the scale before calling; doing it
	/// here would put a view inside the arithmetic.
	function nearest(cands, p, tol) {
		var best = null;
		var lim = (tol === undefined || tol === null) ? Infinity : tol;
		for (var i = 0; i < cands.length; i++) {
			var c = cands[i];
			var d = c.rect ? distToRect(c.rect, p)
			              : Math.sqrt((c.at.x - p.x) * (c.at.x - p.x) + (c.at.y - p.y) * (c.at.y - p.y));
			if (d > lim) continue;
			if (best && best.d <= d) continue;
			best = { i: i, cand: c, d: d };
		}
		return best;
	}

	/// The nearest port of any candidate rectangle within `tol` of a point, or
	/// nothing.
	///
	/// The magnetic snap, and it is [nearest] over the four anchors of every
	/// candidate rather than a second search: the answer names which rectangle,
	/// which side, where, and how far, so a caller can both draw the line to the
	/// right place and say which tile to light up.
	function nearestPort(cands, p, tol) {
		var pts = [];
		for (var i = 0; i < cands.length; i++) {
			var c = cands[i], ps = ports(c.rect);
			for (var j = 0; j < ps.length; j++) {
				pts.push({ id: c.id, side: ps[j].side, f: ps[j].f,
				           at: { x: ps[j].x, y: ps[j].y } });
			}
		}
		var got = nearest(pts, p, tol);
		if (!got) return null;
		return { id: got.cand.id, side: got.cand.side, f: got.cand.f,
		         x: got.cand.at.x, y: got.cand.at.y, d: got.d };
	}

	/// Which rectangle holds the point, or nothing. Last match wins, so a
	/// caller listing tiles in draw order gets the one drawn on top.
	function hit(cands, p) {
		var found = null;
		for (var i = 0; i < cands.length; i++) {
			var r = cands[i].rect;
			if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) found = cands[i];
		}
		return found;
	}

	/// Where an edge leaves, where it lands, and the two control points that bow
	/// it between them.
	///
	/// The LAYERED case is the ordinary one — out of the bottom of the source,
	/// into the top of the target — and it is the only case auto-layout can
	/// produce, because a forward edge's target is always on a lower layer.
	///
	/// Dragging can put a target level with its source or above it, and there a
	/// vertical route needs CLEAR AIR to run through — `gap` of it, between the
	/// bottom of one box and the top of the other. Without that guard two tiles
	/// whose centres were ten pixels apart vertically were routed bottom to top,
	/// which drew a line that went DOWN out of the source, back UP past it, and
	/// in through the top of a target standing beside it: under both of its own
	/// endpoints for most of its length. Anything with no air to run through
	/// leaves and lands on the facing sides, where there always is room.
	///
	/// WHICH POINT of a side is not always the middle. Each side offers three,
	/// and a line takes the one that faces where it is going, so four boxes
	/// hanging off one do not leave it through a single point.
	///
	/// `nudge`, which holds parallel links apart, is spent ALONG the side rather
	/// than added to a coordinate: pixels added to a coordinate could push a
	/// line's end clean off the box it belonged to.
	function route(a, b, nudge, opts) {
		var o = opts || {};
		var gap    = o.gap === undefined ? 24 : o.gap;
		var thirds = o.thirds;
		var ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
		var bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
		var dx = bc.x - ac.x, dv = bc.y - ac.y;
		var flatA = a.w - 2 * (a.kink || 0);
		var below = b.y - (a.y + a.h);     // clear air under the source
		var above = a.y - (b.y + b.h);     // and over it
		var p0, p1, p2, p3, f, n;
		if (bc.y > ac.y && below >= gap) {
			f  = portFor(dx, a.w / 2, thirds);
			n  = nudge / flatA;
			p0 = port(a, 'bottom', clamp01(f + n));
			p3 = port(b, 'top', clamp01(1 - f + n));
			var dy = Math.max(24, p3.y - p0.y);
			p1 = { x: p0.x, y: p0.y + dy * 0.42 };
			p2 = { x: p3.x, y: p3.y - dy * 0.42 };
			return { p0: p0, p1: p1, p2: p2, p3: p3 };
		}
		if (Math.abs(dx) < Math.abs(dv) && above >= gap) {
			f  = portFor(dx, a.w / 2, thirds);
			n  = nudge / flatA;
			p0 = port(a, 'top', clamp01(f + n));
			p3 = port(b, 'bottom', clamp01(1 - f + n));
			var rise = Math.max(24, p0.y - p3.y) * 0.42;
			p1 = { x: p0.x, y: p0.y - rise };
			p2 = { x: p3.x, y: p3.y + rise };
			return { p0: p0, p1: p1, p2: p2, p3: p3 };
		}
		// Level with each other, or too close to run between: out of the facing
		// sides, where there is always room.
		var right = dx >= 0;
		f  = portFor(dv, a.h / 2, thirds);
		n  = nudge / a.h;
		p0 = port(a, right ? 'right' : 'left', clamp01(f + n));
		p3 = port(b, right ? 'left' : 'right', clamp01(1 - f + n));
		var run = Math.max(24, Math.abs(p3.x - p0.x)) * 0.42 * (right ? 1 : -1);
		p1 = { x: p0.x + run, y: p0.y };
		p2 = { x: p3.x - run, y: p3.y };
		return { p0: p0, p1: p1, p2: p2, p3: p3 };
	}

	/// The route a CLOSING edge takes: out of one box and back into the other the
	/// long way round, so that the edge which makes a cycle a cycle never reads as
	/// one more step down the hierarchy.
	///
	/// Two bows, and which one is taken is the same question [route] asks. Out to
	/// the RIGHT of both boxes when there is clear air between them vertically,
	/// which is the layered arrangement auto-layout produces and the picture this
	/// has always drawn. OVER THE TOP when there is not — because a right-hand bow
	/// between two boxes standing SIDE BY SIDE runs from the right edge of one
	/// straight through the other, which is a line drawn under its own target for
	/// half its length. Nothing in an auto-layout can produce that arrangement;
	/// two drags can, and did.
	///
	/// # Arguments
	/// * `bow` - How far out the arc swings. The caller hands out a different one
	///           per closing edge so that several do not lie on top of each other.
	function backRoute(a, b, bow, opts) {
		var o = opts || {};
		var gap = o.gap === undefined ? 24 : o.gap;
		var clear = (b.y - (a.y + a.h) >= gap) || (a.y - (b.y + b.h) >= gap);
		if (clear) {
			var r0 = port(a, 'right', 0.5), r3 = port(b, 'right', 0.5);
			return { p0: r0, p1: { x: r0.x + bow, y: r0.y },
			         p2: { x: r3.x + bow, y: r3.y }, p3: r3 };
		}
		var t0 = port(a, 'top', 0.5), t3 = port(b, 'top', 0.5);
		return { p0: t0, p1: { x: t0.x, y: t0.y - bow },
		         p2: { x: t3.x, y: t3.y - bow }, p3: t3 };
	}

	/// The orthogonal three-segment route between two rectangles: out of a port,
	/// across, and in to a port, with every segment horizontal or vertical.
	///
	/// Answers the polyline as points, `p0` first and the landing last. Four
	/// points and therefore three segments, always, so a caller drawing it does
	/// not have to ask how many there were. Where the two ports face each other
	/// exactly the middle segment is nought long and the line reads as straight,
	/// which is correct rather than a special case.
	function elbow(a, b, opts) {
		var o = opts || {};
		var gap = o.gap === undefined ? 24 : o.gap;
		var p0, p3, mid;
		if (b.y - (a.y + a.h) >= gap) {
			p0 = port(a, 'bottom', 0.5);
			p3 = port(b, 'top', 0.5);
			mid = (p0.y + p3.y) / 2;
			return [p0, { x: p0.x, y: mid }, { x: p3.x, y: mid }, p3];
		}
		if (a.y - (b.y + b.h) >= gap) {
			p0 = port(a, 'top', 0.5);
			p3 = port(b, 'bottom', 0.5);
			mid = (p0.y + p3.y) / 2;
			return [p0, { x: p0.x, y: mid }, { x: p3.x, y: mid }, p3];
		}
		var right = (b.x + b.w / 2) >= (a.x + a.w / 2);
		p0 = port(a, right ? 'right' : 'left', 0.5);
		p3 = port(b, right ? 'left' : 'right', 0.5);
		mid = (p0.x + p3.x) / 2;
		return [p0, { x: mid, y: p0.y }, { x: mid, y: p3.y }, p3];
	}

	/// The point a fraction `t` along a cubic bezier.
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

	/// Where the view must be scrolled to so that a picture point stays under
	/// the pointer when the scale changes.
	///
	/// The whole of zoom-to-pointer, and it is one line of algebra: the drawing's
	/// left edge sits at `pictureX * scale` behind the scroll, so holding
	/// `pictureX` still under a fixed screen position means moving the scroll by
	/// exactly what that product moved. Nothing about the window is needed, which
	/// is why this is here and not in the pane.
	///
	/// Clamped at nought because the canvas has no negative side to scroll into.
	function zoomAt(scroll, pic, zoom, next) {
		return {
			x: Math.max(0, scroll.x + pic.x * (next - zoom)),
			y: Math.max(0, scroll.y + pic.y * (next - zoom)),
		};
	}

	/// A scale a wheel notch away from this one, held inside the view's range.
	///
	/// Geometric rather than additive, so a notch out undoes a notch in and the
	/// steps feel the same size at every scale.
	function zoomStep(zoom, notches, min, max, factor) {
		var f = factor || 1.15;
		var z = zoom * Math.pow(f, notches);
		if (!isFinite(z) || z <= 0) return zoom;
		return Math.max(min, Math.min(max, Math.round(z * 1000) / 1000));
	}

	window.DaimondGraphGeom = {
		clamp01:     clamp01,
		nearest:     nearest,
		distToRect:  distToRect,
		port:        port,
		ports:       ports,
		portFor:     portFor,
		inEdgeBand:  inEdgeBand,
		nearestPort: nearestPort,
		hit:         hit,
		route:       route,
		backRoute:   backRoute,
		elbow:       elbow,
		pointAt:     pointAt,
		zoomAt:      zoomAt,
		zoomStep:    zoomStep,
		SIDES:       SIDES,
	};
})();
