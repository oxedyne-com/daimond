/* ============================================================
   Test — the default avatar a Diamond or a chat is given (avatar.js, D-20261015-13).
   ------------------------------------------------------------
   At creation the name and tags are matched against Tabler's tags; with no
   match a Diamond gets the diamond and a chat gets the speech bubble. The
   picks below are the ones the design pass (variant K) was judged on.
   The choice rides the sync parcel as a freshest-wins map.

     node www/js/avatar.test.mjs
   ============================================================ */
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const A = require('./avatar.js');

test('the design pass picks: name and tags matched against Tabler tags', () => {
	assert.equal(A.pick('Fred Hoogland', ['family', 'person'], 'diamond'), 'user');
	assert.equal(A.pick('Ontheism', ['philosophy', 'religion', 'project'], 'diamond'), 'yin-yang');
	assert.equal(A.pick('Lifelog', [], 'diamond'), 'notebook');
	assert.equal(A.pick('Brand voice', [], 'diamond'), 'speakerphone');
	assert.equal(A.pick('Ship the launch', [], 'diamond'), 'rocket');
	assert.equal(A.pick('Summarise the launch checklist', [], 'chat'), 'list-check');
	assert.equal(A.pick('Is it possible to build a small solar powered aircraft?', [], 'chat'), 'plane');
});

test('plain words find the icon of the same name or with that tag', () => {
	assert.equal(A.pick('Garden', [], 'diamond'), 'plant');
	assert.equal(A.pick('Recipes', ['cooking'], 'diamond'), 'chef-hat');
	assert.equal(A.pick('Tax return', ['money'], 'diamond'), 'coin');
	assert.equal(A.pick('Rust crate', ['code'], 'diamond'), 'code');
});

test('no match: a Diamond gets the diamond, a chat the bubble', () => {
	assert.equal(A.pick('Xyzzy plugh', [], 'diamond'), 'diamond');
	assert.equal(A.pick('Xyzzy plugh', [], 'chat'), 'message-circle');
	assert.equal(A.pick('', null, 'chat'), 'message-circle');
	assert.equal(A.pick(undefined, undefined, 'diamond'), 'diamond');
	// Stop words alone are no match.
	assert.equal(A.pick('Is it the one?', [], 'chat'), 'message-circle');
});

test('every pick is an icon the core set can draw', () => {
	const CORE = require('./avatar_core.js');
	for (const [n, tags] of [['Fred', ['person']], ['A trip to Rome', []], ['Workout plan', []], ['Budget', []]]) {
		const p = A.pick(n, tags, 'diamond');
		assert.ok(CORE[p], p + ' must be in avatar_core.js');
	}
	assert.ok(CORE.diamond && CORE['message-circle']);
});

test('suggestions: eight, the default first, no duplicates', () => {
	const s = A.suggest('Fred Hoogland', ['family', 'person'], 'diamond');
	assert.equal(s.length, 8);
	assert.equal(s[0], 'user');
	assert.equal(new Set(s).size, 8);
});

test('the synced map: the strictly fresher stamp wins, verbatim', () => {
	const mine = { 'd:a': { i: 'rocket', at: 10 }, 'c:x': { i: 'plane', at: 5 } };
	const theirs = { 'd:a': { i: 'user', at: 9 }, 'c:x': { i: 'notebook', at: 7 }, 'd:b': { i: '', at: 3 } };
	const out = A.merge(mine, theirs);
	assert.deepEqual(out.next, { 'd:a': { i: 'rocket', at: 10 }, 'c:x': { i: 'notebook', at: 7 }, 'd:b': { i: '', at: 3 } });
	assert.equal(out.changed, true);
	// Nothing fresher: nothing moves.
	assert.equal(A.merge(out.next, theirs).changed, false);
	// Junk is ignored, not adopted.
	assert.equal(A.merge(mine, { 'd:a': { i: 'rocket', at: 'soon' }, 'zz': 1 }).changed, false);
	assert.equal(A.merge(mine, null).changed, false);
	// A tie on the stamp settles on the larger name, so two devices agree.
	assert.equal(A.merge({ 'd:a': { i: 'a', at: 4 } }, { 'd:a': { i: 'b', at: 4 } }).next['d:a'].i, 'b');
	assert.equal(A.merge({ 'd:a': { i: 'b', at: 4 } }, { 'd:a': { i: 'a', at: 4 } }).changed, false);
});

test('which icon to draw: a chosen one, else the stored default, else the computed one', () => {
	assert.equal(A.resolve({ i: 'rocket', at: 1 }, 'Lifelog', [], 'diamond'), 'rocket');
	// "Use Default" is an empty choice, so the default is computed again.
	assert.equal(A.resolve({ i: '', at: 2 }, 'Lifelog', [], 'diamond'), 'notebook');
	assert.equal(A.resolve(null, 'Lifelog', [], 'diamond'), 'notebook');
	// A name this build cannot draw falls back to the default rather than a hole.
	assert.equal(A.resolve({ i: 'no-such-icon', at: 3 }, 'Lifelog', [], 'diamond', function () { return false; }), 'notebook');
});

test('search matches Tabler names and tags, names first', () => {
	const set = [['rocket', 0, 'launch startup space'], ['plane', 0, 'aircraft flight'], ['rocket-off', 0, 'launch'], ['user', 0, 'person']];
	assert.deepEqual(A.search(set, 'rocket'), ['rocket', 'rocket-off']);
	assert.deepEqual(A.search(set, 'launch'), ['rocket', 'rocket-off']);
	assert.deepEqual(A.search(set, 'AIRcraft'), ['plane']);
	assert.deepEqual(A.search(set, ''), []);
});
