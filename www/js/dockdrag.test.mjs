// dockdrag.test.mjs — what a drop does to an arrangement, proved without a browser.
//
//	node --test www/js/dockdrag.test.mjs
//
// The Dock's arrangement is an array of arrays and a drop is a function of it,
// so every claim about where a panel lands is a claim about lists and can be
// settled here in milliseconds rather than in a headless browser. What the
// browser is still for is the half this file cannot see: that the line is drawn
// where the zone says, that a release seats what the arithmetic decided, that a
// reload brings it back. That is `dev/verify_dockdrag.mjs`.
//
// What is asserted is the PROPERTY, not the number. A test that copied the
// expected columns out of `applyDrop` would agree with a wrong `applyDrop`: so
// the claims here are conservation (no panel is invented and none is lost
// except the one a swap displaced), the caps, idempotence on a panel's own slot,
// and — for `migrate` — agreement with a round robin written independently from
// the rule `apply()` used to seat by.
//
// Zero dependencies, the pattern `graphgeom.test.mjs` established: both modules
// are plain IIFEs that assign to `window`, so they are loaded by evaluating them
// against one stand-in global — graphgeom FIRST, because `pick` is
// `DaimondGraphGeom.nearest` and deliberately not a search of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const shim = { window: {} };
for (const f of ['graphgeom.js', 'dockdrag.js']) {
	// eslint-disable-next-line no-new-func
	new Function('window', fs.readFileSync(path.join(HERE, f), 'utf8'))(shim.window);
}
const D = shim.window.DaimondDockDrag;
// `pick` reaches for the search through `window`, which inside the IIFE is the
// real global rather than the stand-in it was handed.
globalThis.window = shim.window;

const CAP = { maxCols: 3, maxRows: 4 };
const flat = (cols) => cols.flat();
const sorted = (a) => a.slice().sort();

// ── migrate: a v1 record loads into the slots it was drawn in ───────────
test('a flat record round-robins, which is what apply() did to it at draw time', () => {
	// Written from the RULE — panel i went to column i % cols — rather than from
	// the implementation, so the two can disagree.
	const roundRobin = (ids, n) => {
		const out = Array.from({ length: n }, () => []);
		ids.forEach((id, i) => out[i % n].push(id));
		return out.filter((c) => c.length);
	};
	const ids = ['work', 'mail', 'agents', 'spend', 'trash'];
	for (const n of [1, 2, 3]) {
		assert.deepEqual(D.migrate(ids, n), roundRobin(ids, n), `${n} column(s)`);
	}
	// And a one-panel dock never opens a column it cannot fill.
	assert.deepEqual(D.migrate(['work'], 2), [['work']]);
	assert.deepEqual(D.migrate([], 2), []);
});

test('a v2 record is read back unchanged, and tidied', () => {
	const cols = [['work', 'mail'], ['agents']];
	assert.deepEqual(D.migrate(cols, 1), cols);
	assert.deepEqual(D.migrate([['work'], [], ['mail']], 2), [['work'], ['mail']]);
	// Reading must not alias the caller's arrays.
	const got = D.migrate(cols, 1);
	got[0].push('spend');
	assert.deepEqual(cols[0], ['work', 'mail']);
});

test('unmigrate is migrate turned back, so a preset seats what it always did', () => {
	for (const n of [1, 2, 3]) {
		const ids = ['a', 'b', 'c', 'd', 'e'];
		assert.deepEqual(D.unmigrate(D.migrate(ids, n)), ids, `${n} column(s)`);
	}
});

// ── caps: measured, never constant ──────────────────────────────────────
test('a column is offered only when it fits beside the rail and the stage', () => {
	const floors = { dock: 260, stage: 380, stack: 120, handle: 10 };
	const room = (mainW) => D.caps({ mainW, railW: 330, stageSeats: 1, colH: 900 }, floors);
	// 330 rail + 380 stage + 10 handle = 720 before a column is possible.
	assert.equal(room(900).maxCols, 1, '900px has no room for a column, but one is the floor');
	assert.equal(room(1000).maxCols, 1);
	assert.equal(room(1250).maxCols, 2);
	assert.equal(room(1520).maxCols, 3);
	// A second stage seat takes 390 of it, so the same width carries one fewer.
	assert.equal(D.caps({ mainW: 1520, railW: 330, stageSeats: 2, colH: 900 }, floors).maxCols, 1);
	// Rows are the column's height over the stacked panel's floor.
	assert.equal(D.caps({ mainW: 1520, railW: 0, stageSeats: 1, colH: 900 }, floors).maxRows, 7);
	assert.equal(D.caps({ mainW: 1520, railW: 0, stageSeats: 1, colH: 100 }, floors).maxRows, 1);
});

// ── applyDrop ───────────────────────────────────────────────────────────
const rects = (cols) => {
	// Two columns of 260, panels 200 tall, stacked from y = 0. Enough geometry
	// for `zones` to have something to divide into thirds.
	const out = { dock: { x: 1000, y: 0, w: 260 * cols.length, h: 800 },
		cols: [], panels: {}, colW: 260 };
	cols.forEach((ids, c) => {
		out.cols.push({ x: 1000 + c * 260, y: 0, w: 260, h: 800 });
		ids.forEach((id, r) => {
			out.panels[id] = { x: 1000 + c * 260, y: r * 200, w: 260, h: 200 };
		});
	});
	return out;
};

const zoneFor = (cols, dragId, kind, col, row) => {
	const zs = D.zones(cols, rects(cols), CAP, dragId);
	const z = zs.find((z) => z.kind === kind && z.col === col && (row === undefined || z.row === row));
	assert.ok(z, `no ${kind} zone at column ${col} row ${row}`);
	return z;
};

test('a drop conserves the panel set, except the one a chip displaced', () => {
	const cols = [['work', 'mail'], ['agents']];
	const kinds = [['before', 0, 0], ['after', 0, 1], ['before', 1, 0], ['newcol', 2]];
	for (const [kind, c, r] of kinds) {
		const z = zoneFor(cols, 'agents', kind, c, r);
		const got = D.applyDrop(cols, 'agents', z, CAP);
		assert.deepEqual(sorted(flat(got)), sorted(flat(cols)), `${kind} at ${c}/${r}`);
	}
	// A swap between two PLACED panels loses nobody.
	const swap = D.applyDrop(cols, 'agents', zoneFor(cols, 'agents', 'replace', 0, 0), CAP);
	assert.deepEqual(sorted(flat(swap)), sorted(flat(cols)));
	assert.deepEqual(swap, [['agents', 'mail'], ['work']], 'each takes the other\'s slot');
	// A CHIP has no slot to give back, so the panel it replaced leaves the Dock
	// — and is absent from the answer rather than reported separately.
	const chip = D.applyDrop(cols, 'trash', zoneFor(cols, 'trash', 'replace', 0, 0), CAP);
	assert.deepEqual(chip, [['trash', 'mail'], ['agents']]);
	assert.ok(!flat(chip).includes('work'), 'the displaced panel is the difference');
});

test('a panel dropped on its own boundary does not move', () => {
	const cols = [['work', 'mail'], ['agents']];
	for (const z of [zoneFor(cols, 'work', 'before', 0, 0), zoneFor(cols, 'work', 'after', 0, 0)]) {
		assert.deepEqual(D.applyDrop(cols, 'work', z, CAP), cols, z.kind);
	}
	// And neither does a swap with itself, which `zones` does not offer anyway.
	assert.deepEqual(D.applyDrop(cols, 'work',
		{ kind: 'replace', col: 0, row: 0 }, CAP), cols);
	assert.deepEqual(D.applyDrop(cols, 'work', null, CAP), cols, 'and nor does no zone at all');
});

test('a move within a column lands where the boundary was, not one off it', () => {
	const cols = [['a', 'b', 'c']];
	// `c` above `a`.
	assert.deepEqual(D.applyDrop(cols, 'c', zoneFor(cols, 'c', 'before', 0, 0), CAP), [['c', 'a', 'b']]);
	// `a` below `b` — the boundary between b and c, which the removal of `a`
	// shifts up by one.
	assert.deepEqual(D.applyDrop(cols, 'a', zoneFor(cols, 'a', 'after', 0, 1), CAP), [['b', 'a', 'c']]);
	// `a` to the very bottom.
	assert.deepEqual(D.applyDrop(cols, 'a', zoneFor(cols, 'a', 'after', 0, 2), CAP), [['b', 'c', 'a']]);
});

test('an emptied column goes, and a new one appears where the edge was', () => {
	const cols = [['work'], ['agents']];
	const left = D.applyDrop(cols, 'agents', zoneFor(cols, 'agents', 'newcol', 0), CAP);
	assert.deepEqual(left, [['agents'], ['work']]);
	const right = D.applyDrop([['work', 'mail']], 'mail',
		zoneFor([['work', 'mail']], 'mail', 'newcol', 1), CAP);
	assert.deepEqual(right, [['work'], ['mail']]);
	// A lone panel carried to its own column's edge is a no-op, not a column of
	// nothing beside a column of one.
	assert.deepEqual(D.applyDrop([['work']], 'work',
		zoneFor([['work']], 'work', 'newcol', 0), CAP), [['work']]);
});

test('an empty Dock takes one panel into one column', () => {
	const zs = D.zones([], { dock: { x: 1000, y: 0, w: 260, h: 800 }, cols: [], panels: {}, colW: 260 },
		CAP, 'work');
	assert.equal(zs.length, 1);
	assert.equal(zs[0].kind, 'empty');
	assert.deepEqual(D.applyDrop([], 'work', zs[0], CAP), [['work']]);
});

test('no drop breaks a cap', () => {
	const tight = { maxCols: 2, maxRows: 2 };
	const cols = [['a', 'b'], ['c', 'd']];
	// Nothing is offered that would make a third column or a third row.
	const zs = D.zones(cols, rects(cols), tight, 'e');
	assert.equal(zs.filter((z) => z.kind === 'newcol').length, 0, 'no edge band at the column cap');
	assert.equal(zs.filter((z) => z.kind === 'before' || z.kind === 'after').length, 0,
		'no insertion into a column at the row cap');
	assert.equal(zs.filter((z) => z.kind === 'replace').length, 4, 'but every panel can be replaced');
	// And a zone forged by hand is refused outright rather than honoured.
	assert.deepEqual(D.applyDrop(cols, 'e', { kind: 'before', col: 0, row: 0 }, tight), cols);
	assert.deepEqual(D.applyDrop(cols, 'e', { kind: 'newcol', col: 2, row: 0 }, tight), cols);
});

test('a panel already in a full column may still move within it', () => {
	const tight = { maxCols: 1, maxRows: 2 };
	const cols = [['a', 'b']];
	const zs = D.zones(cols, rects(cols), tight, 'b');
	assert.ok(zs.some((z) => z.kind === 'before' && z.row === 0), 'it is not made taller by moving');
	assert.deepEqual(D.applyDrop(cols, 'b', zoneFor(cols, 'b', 'before', 0, 0), tight), [['b', 'a']]);
});

// ── zones and pick ──────────────────────────────────────────────────────
test('every part of a panel means exactly one thing, and the three cover it', () => {
	const cols = [['work', 'mail']];
	const zs = D.zones(cols, rects(cols), CAP, null);
	const r = rects(cols).panels.work;
	// Walk the panel top to bottom: before, then replace, then after, each over
	// its own third and no pixel claimed twice.
	const seen = [];
	for (let y = r.y + 1; y < r.y + r.h; y += 2) {
		const z = D.pick(zs, r.x + r.w / 2, y);
		assert.ok(z, `nothing at y=${y}`);
		if (!seen.length || seen[seen.length - 1] !== z.kind) seen.push(z.kind);
	}
	assert.deepEqual(seen, ['before', 'replace', 'after'], 'in that order, and each once');
});

test('the gap between two rows is still the Dock, not the outside', () => {
	// The bands are drawn over the panels; a column puts space between them, and
	// a release aimed exactly at a boundary must not read as "out of the Dock",
	// which for a placed panel closes it.
	const cols = [['work', 'mail']];
	const rs = rects(cols);
	rs.panels.mail.y += 8;                      // a gap the layout really draws
	const zs = D.zones(cols, rs, CAP, null);
	const z = D.pick(zs, rs.panels.work.x + 100, 204);
	assert.ok(z && (z.kind === 'after' || z.kind === 'before'), `got ${z && z.kind}`);
});

test('the stage is outside, whatever it is near', () => {
	const cols = [['work']];
	const zs = D.zones(cols, rects(cols), CAP, 'work');
	assert.equal(D.pick(zs, 400, 400), null, 'far to the left of the Dock');
	assert.equal(D.pick(zs, 1130, 1200), null, 'below it');
});

test('the edge band wins the pixels it shares with the column behind it', () => {
	const cols = [['work'], ['mail']];
	const zs = D.zones(cols, rects(cols), CAP, 'trash');
	// Ten pixels inside the Dock's left edge is over the first panel AND inside
	// the forty-pixel band. The band is listed first, and ties go to the earlier
	// candidate, so a new column is what is being asked for.
	assert.equal(D.pick(zs, 1010, 100).kind, 'newcol');
	// Well clear of the band, the panel's own thirds are back.
	assert.equal(D.pick(zs, 1150, 30).kind, 'before');
});

// ── keyStep ─────────────────────────────────────────────────────────────
test('the arrows walk the boundaries, and each is reached once', () => {
	const cols = [['a', 'b', 'c'], ['d']];
	const zs = D.zones(cols, rects(cols), CAP, 'd');
	let z = D.keyStep(zs, null, 'down');
	const walk = [D.ord(z)];
	for (let i = 0; i < 6; i++) { z = D.keyStep(zs, z, 'down'); walk.push(D.ord(z)); }
	// Four boundaries in a column of three, then it stops rather than wrapping.
	assert.deepEqual(walk, [0, 1, 2, 3, 3, 3, 3]);
	let up = z;
	for (let i = 0; i < 5; i++) up = D.keyStep(zs, up, 'up');
	assert.equal(D.ord(up), 0, 'and back to the top, where it also stops');
});

test('left and right cross columns, and reach the edge when there is none', () => {
	const cols = [['a', 'b'], ['c']];
	const zs = D.zones(cols, rects(cols), CAP, 'x');
	const start = zs.find((z) => z.kind === 'before' && z.col === 0 && z.row === 0);
	const right = D.keyStep(zs, start, 'right');
	assert.equal(right.col, 1, 'into the neighbouring column');
	// Past the last column there is no neighbour, so the edge band is offered.
	const past = D.keyStep(zs, right, 'right');
	assert.equal(past.kind, 'newcol');
	assert.equal(past.col, 2);
	// And from an edge band, back in.
	assert.equal(D.keyStep(zs, past, 'left').col, 1);
});
