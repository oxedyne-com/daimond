// wssearch.test.mjs -- the Workspace search walk: its bounds, its cancel and its order (E5).
//
//	node --test www/js/wssearch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const shim = { window: {} };
// eslint-disable-next-line no-new-func
new Function('window', fs.readFileSync(path.join(HERE, 'wssearch.js'), 'utf8'))(shim.window);
const S = shim.window.DaimondWsSearch;

// A tree as `{ dir: [entries] }`, listed asynchronously the way OPFS answers.
function door(trees, log) {
	return async (root, dir) => {
		if (log) log.push(root.id + ':' + dir);
		await null;
		const t = trees[root.id] || {};
		if (!(dir in t)) throw new Error('gone');
		return t[dir];
	};
}
const f = (name, at) => ({ name, dir: false, at: at || 0 });
const d = (name) => ({ name, dir: true });

const STORE = {
	'':                      [d('stories'), d('diamonds'), f('life-notes.md', 5), f('.hidden-life')],
	'stories':               [f('life-story-draft.md', 3), d('old')],
	'stories/old':           [f('lifestory.txt', 2), f('other.txt')],
	'diamonds':              [d('k1')],
	'diamonds/k1':           [f('FBR_LifeStory_2026.txt', 9), d('.daimond')],
	'diamonds/k1/.daimond':  [f('life.json')],
};

async function all(o) {
	const hits = [];
	const w = S.walk({ pause: async () => {}, ...o, onHit: (h) => hits.push(h) });
	const st = await w.done;
	return { hits, st };
}

test('a partial name finds files in nested folders, own folder first, then breadth first by name', async () => {
	const { hits, st } = await all({
		query: 'LIFE',
		list: door({ s: STORE }),
		roots: [
			{ id: 's', path: 'diamonds/k1' },
			{ id: 's', path: '', skip: ['diamonds/k1'] },
		],
	});
	assert.deepEqual(hits.map((h) => h.path), [
		'diamonds/k1/FBR_LifeStory_2026.txt',
		'life-notes.md',
		'stories/life-story-draft.md',
		'stories/old/lifestory.txt',
	]);
	assert.equal(hits[0].at, 9, 'the time travels with the hit');
	assert.equal(st.capped, false);
});

test('dot-named entries are never walked or matched', async () => {
	const { hits } = await all({ query: 'life', list: door({ s: STORE }), roots: [{ id: 's', path: '' }] });
	assert.ok(!hits.some((h) => h.path.indexOf('/.') !== -1 || h.name.charAt(0) === '.'), JSON.stringify(hits));
});

test('the match cap stops the walk and says so', async () => {
	const { hits, st } = await all({ query: 'life', maxResults: 2, list: door({ s: STORE }), roots: [{ id: 's', path: '' }] });
	assert.equal(hits.length, 2);
	assert.equal(st.capped, true);
});

test('a root visits no more entries than its cap, and the next root still runs', async () => {
	const big = { '': Array.from({ length: 500 }, (_, i) => f('note' + String(i).padStart(3, '0') + '.md')) };
	const { hits, st } = await all({
		query: 'note',
		maxResults: 1000,
		list: door({ big, m: { '': [f('notebook.txt', 1)] } }),
		roots: [{ id: 'big', path: '', cap: 50 }, { id: 'm', path: '', cap: 50 }],
	});
	assert.equal(hits.filter((h) => h.root === 'big').length, 50);
	assert.deepEqual(hits.filter((h) => h.root === 'm').map((h) => h.path), ['notebook.txt']);
	assert.equal(st.capped, true);
	assert.equal(st.visited, 51);
});

test('a folder that cannot be listed is passed over, not fatal', async () => {
	const { hits } = await all({ query: 'x', list: door({ s: { '': [d('gone'), f('x.md')] } }), roots: [{ id: 's', path: '' }] });
	assert.deepEqual(hits.map((h) => h.path), ['x.md']);
});

test('cancel: a walk whose query is gone reports nothing more and lists nothing more', async () => {
	const deep = { '': [d('a'), f('qa.md')] };
	for (let i = 0, p = 'a'; i < 30; i++, p += '/a') deep[p] = [d('a'), f('q' + i + '.md')];
	const hits = [], log = [];
	let w;
	w = S.walk({
		query: 'q', list: door({ s: deep }, log), roots: [{ id: 's', path: '' }], pause: async () => {},
		onHit: (h) => { hits.push(h); if (hits.length === 3) w.cancel(); },
	});
	const st = await w.done;
	assert.equal(st.cancelled, true);
	const n = log.length;
	assert.ok(hits.length <= 4 && n < 8, `hits ${hits.length}, listings ${n}`);
});

test('it yields between batches, so the page is not held for the whole walk', async () => {
	const many = { '': Array.from({ length: 1000 }, (_, i) => f('a' + i)) };
	let yields = 0;
	await all({ query: 'zzz', batch: 100, list: door({ s: many }), roots: [{ id: 's', path: '', cap: 5000 }], pause: async () => { yields++; } });
	// One listing of 1000 entries is visited between two awaits, so the pause comes after it; a walk of
	// many small folders pauses every `batch` entries. Both are checked.
	const tree = {};
	tree[''] = Array.from({ length: 50 }, (_, i) => d('d' + i));
	for (let i = 0; i < 50; i++) tree['d' + i] = Array.from({ length: 20 }, (_, j) => f('f' + j));
	let y2 = 0;
	await all({ query: 'zzz', batch: 100, list: door({ s: tree }), roots: [{ id: 's', path: '', cap: 5000 }], pause: async () => { y2++; } });
	assert.ok(yields >= 1 && y2 >= 9, `yields ${yields}, ${y2}`);
});

test('an empty query walks nothing', async () => {
	const log = [];
	const { hits } = await all({ query: '  ', list: door({ s: STORE }, log), roots: [{ id: 's', path: '' }] });
	assert.equal(hits.length + log.length, 0);
});

test('placeOf: its own folder, or the folder a hit sits in', () => {
	assert.deepEqual(S.placeOf('diamonds/k1/FBR.txt', 'diamonds/k1'), { own: true, dir: '' });
	assert.deepEqual(S.placeOf('diamonds/k1/notes/a.md', 'diamonds/k1'), { own: true, dir: 'notes/' });
	assert.deepEqual(S.placeOf('stories/old/lifestory.txt', 'diamonds/k1'), { own: false, dir: 'stories/old/' });
	assert.deepEqual(S.placeOf('top.md', ''), { own: false, dir: '' });
	assert.deepEqual(S.placeOf('diamonds/k10/x.md', 'diamonds/k1'), { own: false, dir: 'diamonds/k10/' });
});
