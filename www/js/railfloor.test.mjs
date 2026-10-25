// railfloor.test.mjs -- the phone rail's lists each hold five whole tiles at rest, whatever
// day heads fall among them (UNBLOCK-30, D-20261020-12; RAIL-FLOOR, 25 Oct 2026).
//
//	node --test www/js/railfloor.test.mjs
//
// mobile.js `listFloor` sets each list's window from where its fifth tile ends, so a
// "Today" or "Yesterday" head among the first five makes the window taller rather than
// costing a tile. ccp5's dk arms read that window wrong in the hour after midnight, and
// the only gate on the floor was a browser arm before the deploy. This holds the floor
// in the node arm, over every place a head can fall, in milliseconds. It guards working
// code: at WIN_TILES = 4, or with the fifth-tile reading taken out, it goes red.
//
// The function lives in an IIFE this harness cannot load, so it is cut out of the source
// by its name and run alone, against a DOM just large enough for it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'mobile.js'), 'utf8');

function cut(name) {
	const at = SRC.indexOf('function ' + name + '(');
	assert.ok(at >= 0, `mobile.js has no ${name}`);
	let depth = 0;
	for (let i = SRC.indexOf('{', at); i < SRC.length; i++) {
		if (SRC[i] === '{') depth++;
		else if (SRC[i] === '}' && --depth === 0) return SRC.slice(at, i + 1);
	}
	assert.fail(`${name} never closes`);
}
const tiles = /var WIN_TILES = (\d+);/.exec(SRC);
assert.ok(tiles, 'mobile.js names no WIN_TILES');

const PAD = 4, GAP = 2, HEAD = 28, TOP = 600;

// A list as the rail draws it: a head before each tile index in `heads`, tiles of the
// heights in `hs`, and the computed style mobile.css gives the phone's lists.
function railList(hs, heads, scrollTop = 0) {
	let y = TOP + PAD - scrollTop;
	const rows = hs.map((h, i) => {
		if (heads.includes(i)) y += HEAD + GAP;
		const b = { top: y, bottom: y + h, height: h };
		y += h + GAP;
		return { getBoundingClientRect: () => b };
	});
	return {
		rows, scrollTop,
		getClientRects: () => [1],
		getBoundingClientRect: () => ({ top: TOP }),
		querySelectorAll: () => rows,
	};
}
const style = { rowGap: GAP + 'px', paddingTop: PAD + 'px', paddingBottom: PAD + 'px', borderTopWidth: '0px' };
const listFloor = new Function('getComputedStyle', `var WIN_TILES = ${tiles[1]};\n${cut('listFloor')}\nreturn listFloor;`)(() => style);

// Whole tiles a window of `px` holds at rest, its top at the list's top.
function whole(list, px) {
	return list.rows.filter((r) => r.getBoundingClientRect().bottom - TOP + list.scrollTop <= px).length;
}

test('five whole tiles, with a day head before any of the first five', () => {
	const hs = Array(12).fill(57);
	for (let k = 0; k <= 5; k++) {
		const l = railList(hs, k ? [0, k] : [0]);
		const px = listFloor(l, '.session-box');
		assert.ok(whole(l, px) >= 5, `head before tile ${k}: a ${px} px window holds ${whole(l, px)} whole tiles`);
	}
});

test('the floor is read the same scrolled as at the top', () => {
	const hs = Array(12).fill(57);
	assert.equal(listFloor(railList(hs, [0, 1], 140), '.session-box'), listFloor(railList(hs, [0, 1]), '.session-box'));
});

test('a tagged tile taller than the rest still leaves five whole', () => {
	const hs = [66, 66, 92, 66, 66, 66, 66];	// one tile grows a chip line (CHIPLINE)
	const l = railList(hs, []);
	assert.ok(whole(l, listFloor(l, '.diamond-box')) >= 5);
});

test('a search leaving fewer than five holds the window at five of the tallest', () => {
	const l = railList([57, 57], [0]);
	assert.ok(listFloor(l, '.session-box') >= 2 * PAD + 5 * 57 + 4 * GAP);
});
