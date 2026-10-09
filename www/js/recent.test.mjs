/* ============================================================
   Test — the Workspace panel's focus section (recent.js, P2 + E4).
   ------------------------------------------------------------
   Recent: a 20-entry ring of the files a diamond's daimon (or a
   chat) wrote, newest first, one row per path and place, kept in
   the diamond's own folder so it travels with the diamond and is
   never a keeper record. Can change: the rows are the fence's own
   inputs (`Files.bounds`), set-equal both ways (N1).

     node www/js/recent.test.mjs
     node --test www/js/*.test.mjs
   ============================================================ */
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const R = require('./recent.js');
const M = require('./markshere.js');

test('pathOf names the written file for the three write tools only', () => {
	assert.equal(R.pathOf('file_write', JSON.stringify({ path: 'docs/plan.md', content: 'x' })), 'docs/plan.md');
	assert.equal(R.pathOf('file_edit', { path: './STATE.md' }), 'STATE.md');
	assert.equal(R.pathOf('file_move', JSON.stringify({ from: 'a.txt', to: 'b.txt' })), 'b.txt');
	assert.equal(R.pathOf('file_read', JSON.stringify({ path: 'a.txt' })), '');
	assert.equal(R.pathOf('dir_create', JSON.stringify({ path: 'd' })), '');
	assert.equal(R.pathOf('file_write', '{not json'), '');
	assert.equal(R.pathOf('file_write', JSON.stringify({})), '');
});

test('append puts the newest first and keeps one row per path and place', () => {
	let ring = [];
	ring = R.append(ring, { path: 'a.md', place: '', at: 1 });
	ring = R.append(ring, { path: 'b.md', place: '', at: 2 });
	ring = R.append(ring, { path: 'a.md', place: '', at: 3 });
	assert.deepEqual(ring.map((e) => e.path), ['a.md', 'b.md']);
	assert.equal(ring[0].at, 3);
	// The same path in another place is another file.
	ring = R.append(ring, { path: 'a.md', place: 'machine:usr#f1', at: 4 });
	assert.equal(ring.length, 3);
	// The input is not changed.
	const before = JSON.stringify(ring);
	R.append(ring, { path: 'z.md', place: '', at: 9 });
	assert.equal(JSON.stringify(ring), before);
});

test('the ring holds at most 20', () => {
	let ring = [];
	for (let i = 0; i < 30; i++) ring = R.append(ring, { path: 'f' + i, place: '', at: i });
	assert.equal(ring.length, R.CAP);
	assert.equal(R.CAP, 20);
	assert.equal(ring[0].path, 'f29');
	assert.equal(ring[19].path, 'f10');
});

test('merge is a union, newest per file, the same from either side', () => {
	const a = [{ path: 'x', place: '', at: 5 }, { path: 'y', place: '', at: 1 }];
	const b = [{ path: 'y', place: '', at: 7 }, { path: 'z', place: '', at: 3 }];
	const ab = R.merge(a, b), ba = R.merge(b, a);
	assert.deepEqual(ab, ba);
	assert.deepEqual(ab.map((e) => e.path + '@' + e.at), ['y@7', 'x@5', 'z@3']);
});

test('parse refuses junk and serialise round-trips', () => {
	assert.deepEqual(R.parse(''), []);
	assert.deepEqual(R.parse('nope'), []);
	assert.deepEqual(R.parse('{"a":1}'), []);
	const ring = R.parse(JSON.stringify([{ path: 'a', place: '', at: 2 }, { path: 7 }, null, { path: 'b', at: 'x' }]));
	assert.deepEqual(ring, [{ path: 'a', place: '', at: 2 }]);
	assert.deepEqual(R.parse(R.serialise(ring)), ring);
});

test('the ring lives in the diamond own folder: it syncs and is no keeper record', () => {
	const p = R.ringPath('d123');
	assert.equal(p, 'diamonds/d123/recent.json');
	assert.ok(M.isStorePath(p), 'a store path travels with the diamond');
	assert.ok(!M.isKeeperRecordPath(p), 'a keeper record never travels');
	assert.equal(R.ringPath(''), '');
});

test('when: just now, minutes, hours, then a day through the one formatter (weekday, then month and day)', () => {
	const now = Date.UTC(2026, 9, 9, 12, 0, 0);
	const just = 'just now';
	const fl = (v, shape) => shape + '@' + v;		// DaimondTime.fmtLocal's place
	assert.equal(R.when(now - 20e3, now, 'en', just, fl), just);
	assert.match(R.when(now - 2 * 60e3, now, 'en', just, fl), /^2\s?min/);
	assert.match(R.when(now - 3 * 3600e3, now, 'en', just, fl), /^3\s?hr/);
	assert.equal(R.when(now - 3 * 86400e3, now, 'en', just, fl), 'dow@' + (now - 3 * 86400e3));
	assert.equal(R.when(now - 40 * 86400e3, now, 'en', just, fl), 'dayMonth@' + (now - 40 * 86400e3));
});

// N1: the rows ARE the fence's inputs, set-equal both ways.
test('N1: Can change rows equal own_dir, marks, kits and waiting marks', () => {
	const b = {
		own_dir: 'diamonds/d1',
		attached: ['docs', 'stories'],
		read_only: ['stories'],
		toolkits: ['rust'],
		unconfirmed: ['notes'],
	};
	const rows = R.canChange(b);
	assert.deepEqual(rows.map((r) => r.kind), ['own', 'mark', 'mark', 'ghost', 'kit']);
	assert.equal(rows[2].ro, true);
	assert.equal(rows[1].ro, false);
	assert.deepEqual(R.rowKeys(rows), R.boundsKeys(b));
	// Both ways: a row the fence lacks, or a grant with no row, breaks equality.
	assert.notDeepEqual(R.rowKeys(rows.slice(1)), R.boundsKeys(b));
	assert.notDeepEqual(R.rowKeys(rows), R.boundsKeys({ ...b, toolkits: ['rust', 'node'] }));
	// No focus, no rows.
	assert.deepEqual(R.canChange({ own_dir: '', attached: [], read_only: [], toolkits: [], unconfirmed: [] }), []);
	assert.deepEqual(R.canChange(null), []);
	// A chat has no own_dir row only when it has no scratch folder.
	assert.deepEqual(R.canChange({ own_dir: 'chats/c1', attached: [] }).map((r) => r.kind), ['own']);
});
