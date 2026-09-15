// graphgeom.test.mjs — the Graph's geometry, proved without a browser.
//
//	node --test www/js/graphgeom.test.mjs
//
// Every function in `www/js/graphgeom.js` is a function of numbers, so every
// claim about the picture that is really a claim about arithmetic can be settled
// here in milliseconds instead of in a headless browser.  What is asserted is
// the PROPERTY rather than the number: that a port lands on the outline the box
// is drawn as, that the snap picks the nearest candidate and nothing beyond its
// tolerance, that a routed curve never runs back under either of the boxes it
// joins, that zoom-to-pointer holds the point it was given.  A test that copied
// the expected coordinates out of the implementation would agree with a wrong
// implementation.
//
// Zero dependencies, the pattern `dev/listing.test.mjs` established: the module
// is a plain IIFE that assigns to `window`, so it is loaded by evaluating it
// against a stand-in global.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = path.join(HERE, 'graphgeom.js');
const shim = { window: {} };
// eslint-disable-next-line no-new-func
new Function('window', fs.readFileSync(SRC, 'utf8'))(shim.window);
const G = shim.window.DaimondGraphGeom;

// The Graph's own box: 176 × 44, kinked 12 either side.
const NODE = { w: 176, h: 44, kink: 12 };
const box = (x, y) => ({ x, y, ...NODE });

/// Is the point on the hexagon's outline, to within a thousandth?
///
/// Written from the SHAPE — the four straight runs and the two points — rather
/// than from `port`, so it can disagree with it.
function onOutline(r, p) {
	const k = r.kink, near = (a, b) => Math.abs(a - b) < 1e-6;
	const inFlat = p.x >= r.x + k - 1e-6 && p.x <= r.x + r.w - k + 1e-6;
	if (inFlat && (near(p.y, r.y) || near(p.y, r.y + r.h))) return true;
	// A side runs from a top corner out to the mid point and back to the bottom
	// corner: its horizontal stand-off is k at the middle and nought at either end.
	const f = (p.y - r.y) / r.h;
	if (f < -1e-6 || f > 1 + 1e-6) return false;
	const off = k * Math.abs(1 - 2 * f);
	return near(p.x, r.x + off) || near(p.x, r.x + r.w - off);
}

/// The hexagon a box is drawn as, corner by corner.
const hexOf = (r) => [
	{ x: r.x + r.kink, y: r.y }, { x: r.x + r.w - r.kink, y: r.y },
	{ x: r.x + r.w, y: r.y + r.h / 2 },
	{ x: r.x + r.w - r.kink, y: r.y + r.h }, { x: r.x + r.kink, y: r.y + r.h },
	{ x: r.x, y: r.y + r.h / 2 },
];

/// How far the point is from the nearest edge of that hexagon.
function distToOutline(r, p) {
	const hex = hexOf(r);
	let best = Infinity;
	for (let i = 0; i < hex.length; i++) {
		const u = hex[i], v = hex[(i + 1) % hex.length];
		const dx = v.x - u.x, dy = v.y - u.y;
		const len2 = dx * dx + dy * dy;
		let t = len2 ? ((p.x - u.x) * dx + (p.y - u.y) * dy) / len2 : 0;
		t = t < 0 ? 0 : t > 1 ? 1 : t;
		const qx = u.x + t * dx - p.x, qy = u.y + t * dy - p.y;
		best = Math.min(best, Math.sqrt(qx * qx + qy * qy));
	}
	return best;
}

/// Is the point inside the hexagon, by more than `eps`?  A ray cast, so it
/// knows nothing of how the module decides anything.
function deepInside(r, p, eps) {
	const hex = hexOf(r);
	let inside = false;
	for (let i = 0, j = hex.length - 1; i < hex.length; j = i++) {
		const a = hex[i], b = hex[j];
		if ((a.y > p.y) !== (b.y > p.y)
			&& p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
	}
	return inside && distToOutline(r, p) > eps;
}

test('every port of every side lands on the outline the box is drawn as', () => {
	const r = box(100, 60);
	for (const side of G.SIDES) {
		for (const f of [0, 0.25, 0.5, 0.75, 1]) {
			const p = G.port(r, side, f);
			assert.ok(onOutline(r, p), `${side}@${f} → ${JSON.stringify(p)} is off the outline`);
		}
	}
});

test('a kink of nought is an ordinary rectangle', () => {
	const r = { x: 0, y: 0, w: 100, h: 50, kink: 0 };
	assert.deepEqual(G.port(r, 'left', 0.5), { x: 0, y: 25 });
	assert.deepEqual(G.port(r, 'right', 0.5), { x: 100, y: 25 });
	assert.deepEqual(G.port(r, 'top', 0.5), { x: 50, y: 0 });
	assert.deepEqual(G.port(r, 'bottom', 0), { x: 0, y: 50 });
});

test('a box offers four anchors, one per side, in a fixed order', () => {
	const r = box(0, 0);
	const ps = G.ports(r);
	assert.equal(ps.length, 4);
	assert.deepEqual(ps.map((p) => p.side), ['top', 'right', 'bottom', 'left']);
	assert.deepEqual(ps.map((p) => [p.x, p.y]),
		[[88, 0], [176, 22], [88, 44], [0, 22]]);
	// And twice in a row is twice the same, which is the determinism the pane rests on.
	assert.deepEqual(G.ports(r), ps);
});

test('the edge band straddles the outline and leaves the middle alone', () => {
	const r = box(0, 0);            // 176 × 44
	const band = 14, reach = 8;
	assert.ok(G.inEdgeBand(r, { x: 88, y: 2 }, band, reach), 'just inside the top');
	assert.ok(G.inEdgeBand(r, { x: 88, y: -6 }, band, reach), 'just outside the top');
	assert.ok(G.inEdgeBand(r, { x: 4, y: 22 }, band, reach), 'just inside the left');
	assert.ok(!G.inEdgeBand(r, { x: 88, y: 22 }, band, reach), 'the middle is the body');
	assert.ok(!G.inEdgeBand(r, { x: 88, y: -20 }, band, reach), 'well clear is not the band');
	assert.ok(!G.inEdgeBand(r, { x: 300, y: 22 }, band, reach), 'nor is another tile over');
});

test('the snap takes the nearest port and nothing beyond its tolerance', () => {
	const cands = [{ id: 'a', rect: box(0, 0) }, { id: 'b', rect: box(400, 0) }];
	// 10 above the right-hand anchor of `a` (176, 22).
	const near = G.nearestPort(cands, { x: 176, y: 12 }, 24);
	assert.equal(near.id, 'a');
	assert.equal(near.side, 'right');
	assert.ok(Math.abs(near.d - 10) < 1e-9, `distance ${near.d}`);
	// 30 away is past a 24 tolerance, and past it for every port of both boxes.
	assert.equal(G.nearestPort(cands, { x: 176, y: -8 }, 24), null);
	// Between the two boxes, the nearer one wins.
	const mid = G.nearestPort(cands, { x: 370, y: 22 }, 60);
	assert.equal(mid.id, 'b');
	assert.equal(mid.side, 'left');
});

test('the snap is over EVERY candidate, so a third tile can win', () => {
	const cands = [{ id: 'a', rect: box(0, 0) }, { id: 'b', rect: box(400, 0) },
	               { id: 'c', rect: box(200, 0) }];
	const got = G.nearestPort(cands, { x: 200, y: 22 }, 30);
	assert.equal(got.id, 'c');
	assert.equal(got.side, 'left');
	assert.equal(got.d, 0);
});

test('a tie is settled by the order the candidates were given in', () => {
	const cands = [{ id: 'a', rect: box(0, 0) }, { id: 'b', rect: box(176, 0) }];
	// (176, 22) is `a`'s right point and `b`'s left point at once.
	assert.equal(G.nearestPort(cands, { x: 176, y: 22 }, 10).id, 'a');
	const flipped = [cands[1], cands[0]];
	assert.equal(G.nearestPort(flipped, { x: 176, y: 22 }, 10).id, 'b');
});

test('a routed curve starts and lands on the two outlines', () => {
	for (const [dx, dy] of [[0, 200], [400, 200], [-400, 200], [0, -200], [500, 0], [-500, 10]]) {
		const a = box(600, 600), b = box(600 + dx, 600 + dy);
		const r = G.route(a, b, 0);
		assert.ok(onOutline(a, r.p0), `leaves ${dx},${dy} off the source outline`);
		assert.ok(onOutline(b, r.p3), `lands ${dx},${dy} off the target outline`);
	}
});

test('and never runs back under either box it joins', () => {
	// The fault the clear-air guard fixes: two tiles almost level and far apart
	// were routed bottom-to-top, which drew the line down, back up past the
	// source and in through the top of the target.
	const offsets = [];
	for (let dx = -600; dx <= 600; dx += 60) {
		for (let dy = -300; dy <= 300; dy += 30) offsets.push([dx, dy]);
	}
	const separated = offsets.filter(([dx, dy]) =>
		Math.abs(dx) >= NODE.w + 30 || Math.abs(dy) >= NODE.h + 30);
	assert.ok(separated.length > 100, `${separated.length} placements tried`);
	for (const [dx, dy] of separated) {
		const a = box(1200, 1200), b = box(1200 + dx, 1200 + dy);
		const r = G.route(a, b, 0);
		for (let i = 1; i < 200; i++) {
			const p = G.pointAt(r.p0, r.p1, r.p2, r.p3, i / 200);
			assert.ok(!deepInside(a, p, 0.5),
				`at ${dx},${dy} the line runs under its own source at t=${i / 200}`);
			assert.ok(!deepInside(b, p, 0.5),
				`at ${dx},${dy} the line runs under its own target at t=${i / 200}`);
		}
	}
});

test('the nudge that holds parallel links apart never leaves the box', () => {
	const a = box(0, 0), b = box(0, 200);
	for (const n of [-54, -18, 0, 18, 54]) {
		const r = G.route(a, b, n);
		assert.ok(onOutline(a, r.p0), `nudge ${n} left the source outline`);
		assert.ok(onOutline(b, r.p3), `nudge ${n} left the target outline`);
	}
	// And they are actually apart.
	const xs = [-18, 0, 18].map((n) => G.route(a, b, n).p0.x);
	assert.equal(new Set(xs).size, 3, `three lanes, three exits: ${xs}`);
});

test('the elbow is three orthogonal segments between two ports', () => {
	for (const [dx, dy] of [[0, 200], [300, 200], [-300, 200], [0, -200], [500, 0]]) {
		const a = box(600, 600), b = box(600 + dx, 600 + dy);
		const pts = G.elbow(a, b);
		assert.equal(pts.length, 4, 'four points, therefore three segments');
		assert.ok(onOutline(a, pts[0]) && onOutline(b, pts[3]), 'the ends are ports');
		for (let i = 1; i < pts.length; i++) {
			const h = Math.abs(pts[i].y - pts[i - 1].y) < 1e-9;
			const v = Math.abs(pts[i].x - pts[i - 1].x) < 1e-9;
			assert.ok(h || v, `segment ${i} at ${dx},${dy} is neither horizontal nor vertical`);
		}
	}
});

test('a cubic point-at agrees with its own endpoints', () => {
	const p0 = { x: 0, y: 0 }, p1 = { x: 10, y: 40 }, p2 = { x: 90, y: 60 }, p3 = { x: 100, y: 100 };
	assert.deepEqual(G.pointAt(p0, p1, p2, p3, 0), { x: 0, y: 0 });
	assert.deepEqual(G.pointAt(p0, p1, p2, p3, 1), { x: 100, y: 100 });
	const half = G.pointAt(p0, p1, p2, p3, 0.5);
	assert.ok(half.x > 0 && half.x < 100 && half.y > 0 && half.y < 100, JSON.stringify(half));
	// Rounded to a thousandth, so the serialised picture stays short.
	assert.equal(String(half.x), String(Math.round(half.x * 1000) / 1000));
});

test('zoom-to-pointer holds the picture point under the pointer', () => {
	// The scroll that keeps `pic` where it was: screen offset = pic*zoom - scroll.
	const scroll = { x: 900, y: 700 }, pic = { x: 640, y: 380 };
	const before = { x: pic.x * 1 - scroll.x, y: pic.y * 1 - scroll.y };
	for (const next of [0.5, 0.8, 1.6, 2.5]) {
		const s2 = G.zoomAt(scroll, pic, 1, next);
		const after = { x: pic.x * next - s2.x, y: pic.y * next - s2.y };
		assert.ok(Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9,
			`at ${next}: ${JSON.stringify(after)} vs ${JSON.stringify(before)}`);
	}
});

test('and never asks for a scroll the canvas has no room for', () => {
	const got = G.zoomAt({ x: 0, y: 0 }, { x: 10, y: 10 }, 1, 0.2);
	assert.equal(got.x, 0);
	assert.equal(got.y, 0);
});

test('a wheel notch out undoes a notch in, and both stay in range', () => {
	const MIN = 0.12, MAX = 2.5;
	const up = G.zoomStep(1, 1, MIN, MAX);
	assert.ok(up > 1 && up <= MAX, `${up}`);
	assert.ok(Math.abs(G.zoomStep(up, -1, MIN, MAX) - 1) < 0.002, `${G.zoomStep(up, -1, MIN, MAX)}`);
	assert.equal(G.zoomStep(MAX, 6, MIN, MAX), MAX);
	assert.equal(G.zoomStep(MIN, -6, MIN, MAX), MIN);
	// ZOOM_MAX rose from 1 to 2.5, so a tile can be read at two hundred nodes.
	assert.ok(G.zoomStep(1, 8, MIN, MAX) === MAX && MAX === 2.5);
});

test('hit-testing names the tile a point is over, the topmost first', () => {
	const cands = [{ id: 'under', rect: box(0, 0) }, { id: 'over', rect: box(20, 10) }];
	assert.equal(G.hit(cands, { x: 40, y: 20 }).id, 'over');
	assert.equal(G.hit(cands, { x: 4, y: 4 }).id, 'under');
	assert.equal(G.hit(cands, { x: 900, y: 900 }), null);
});

test('nearest is one helper over points and over rectangles alike', () => {
	const pts = [{ id: 'a', at: { x: 0, y: 0 } }, { id: 'b', at: { x: 10, y: 0 } }];
	assert.equal(G.nearest(pts, { x: 7, y: 0 }, 5).cand.id, 'b');
	assert.equal(G.nearest(pts, { x: 5, y: 0 }, 2), null, 'both are further than the tolerance');
	assert.equal(G.nearest(pts, { x: 5, y: 0 }).cand.id, 'a', 'no tolerance means no limit');
	// A point inside a rectangle is nought away from it, which is what makes the
	// same helper answer "which slot is the pointer over".
	const rects = [{ id: 'l', rect: { x: 0, y: 0, w: 50, h: 50 } },
	               { id: 'r', rect: { x: 100, y: 0, w: 50, h: 50 } }];
	assert.equal(G.nearest(rects, { x: 25, y: 25 }, 0).cand.id, 'l');
	assert.equal(G.nearest(rects, { x: 70, y: 25 }, 40).cand.id, 'l');
	assert.equal(G.nearest(rects, { x: 80, y: 25 }, 40).cand.id, 'r');
	assert.equal(G.nearest(rects, { x: 75, y: 25 }, 40).cand.id, 'l', 'a tie goes to the earlier');
	assert.equal(G.nearest(rects, { x: 75, y: 200 }, 40), null);
	// And it hands the candidate back whole, so a caller keeps whatever it put there.
	assert.equal(G.nearest(rects, { x: 25, y: 25 }, 0).cand.rect.w, 50);
	assert.equal(G.nearest(rects, { x: 25, y: 25 }, 0).i, 0);
});

test('distance to a rectangle is nought inside it and honest outside', () => {
	const r = { x: 0, y: 0, w: 10, h: 10 };
	assert.equal(G.distToRect(r, { x: 5, y: 5 }), 0);
	assert.equal(G.distToRect(r, { x: 10, y: 5 }), 0);
	assert.equal(G.distToRect(r, { x: 13, y: 5 }), 3);
	assert.equal(G.distToRect(r, { x: -4, y: 5 }), 4);
	assert.equal(G.distToRect(r, { x: 13, y: 14 }), 5, 'the corner, by Pythagoras');
});

test('a closing edge never runs through the box it closes onto', () => {
	// Found by a red-proof rather than by reasoning: a right-hand bow between two
	// boxes standing SIDE BY SIDE leaves the right edge of one and runs straight
	// through the other. Auto-layout cannot make that arrangement; two drags can.
	const cases = [];
	for (const [dx, dy] of [[640, 10], [-640, 10], [400, 0], [0, -300], [0, 300],
	                        [500, 60], [-500, -60], [240, 30], [900, -8]]) {
		cases.push([box(400, 400), box(400 + dx, 400 + dy)]);
	}
	for (const [a, b] of cases) {
		for (const bow of [48, 68, 88]) {
			const r = G.backRoute(a, b, bow);
			for (let i = 1; i < 200; i++) {
				const p = G.pointAt(r.p0, r.p1, r.p2, r.p3, i / 200);
				assert.ok(!deepInside(a, p, 0.5),
					`bow ${bow} from ${a.x},${a.y} to ${b.x},${b.y} runs under its source at ${i / 200}`);
				assert.ok(!deepInside(b, p, 0.5),
					`bow ${bow} from ${a.x},${a.y} to ${b.x},${b.y} runs under its target at ${i / 200}`);
			}
			assert.ok(onOutline(a, r.p0) && onOutline(b, r.p3), 'and both ends are on an outline');
		}
	}
});

test('and keeps the right-hand bow wherever the layers gave it one', () => {
	// The arrangement auto-layout produces: clear air between the two. The picture
	// this has always drawn, and `verify_graph` compares it byte for byte.
	const a = box(400, 600), b = box(400, 200);
	const r = G.backRoute(a, b, 48);
	assert.deepEqual(r.p0, G.port(a, 'right', 0.5));
	assert.deepEqual(r.p3, G.port(b, 'right', 0.5));
	assert.equal(r.p1.x, r.p0.x + 48);
	assert.equal(r.p2.x, r.p3.x + 48);
});
