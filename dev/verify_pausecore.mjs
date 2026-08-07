// verify_pausecore.mjs — the pause tree's rule, proved without a browser.
//
// The rule the whole PPTW rests on: a leaf is binary, a branch is green when
// every leaf under it plays, red when none does, and amber otherwise — with
// amber DERIVED and never settable. That is a statement about a tree and a set,
// so it can be tested as one. `www/js/pause.js` exports its pure core for
// exactly this; nothing here needs a page, a server or a clock.
//
// Two of these checks failed the first time they were run, which is the reason
// the file exists rather than being folded into the widget's browser test:
//
//   - `leavesUnder` treated a node with an EMPTY children array as a leaf, so an
//     empty branch — a mailbox whose folders have not loaded, a new account's
//     Diamonds section — got a pause flag of its own. Pausing the root then
//     wrote a phantom id that nothing would ever resume, and the empty-branch
//     rule in `stateOf` could never fire.
//
// The sorted-record and equal-stamp checks are here for the other reason: the
// sync parcel has to be a FIXED POINT, and a set serialised in hash order is not
// one. Two devices then push at each other for ever. See
// `dev/verify_parcelstable.mjs`.
//
//   node dev/verify_pausecore.mjs
//
// Needs nothing running.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Pause = require(path.join(HERE, '..', 'www', 'js', 'pause.js'));
const core = Pause._core;

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// A tree with every shape that matters: a branch of branches, a Diamond with a
// trigger beside its own `self` leaf, a bare leaf, and an EMPTY branch.
const tree = {
	id: 'root', children: [
		{ id: 'root/diamonds', children: [
			{ id: 'root/diamonds/a', children: [
				{ id: 'root/diamonds/a/self' },
				{ id: 'root/diamonds/a/triggers/t1' },
			] },
			{ id: 'root/diamonds/b', children: [ { id: 'root/diamonds/b/self' } ] },
		] },
		{ id: 'root/chats', children: [ { id: 'root/chats/c1' } ] },
		{ id: 'root/mail', children: [] },			// a mailbox list not yet loaded
		{ id: 'root/workers' },
	],
};
const ALL = {};
for (const l of core.leavesUnder(tree)) ALL[l] = true;

console.log('the tree');
check(core.leavesUnder(tree).length === 5, 'five leaves, and the empty branch is not one',
	JSON.stringify(core.leavesUnder(tree)));
check(core.leavesUnder({ id: 'x' }).length === 1, 'a leaf is its own only leaf');
check(core.leavesUnder({ id: 'y', children: [] }).length === 0, 'an empty branch has no leaves');
check(core.findNode(tree, 'root/diamonds/a/self') !== null, 'a leaf is findable at depth');
check(core.findNode(tree, 'root/nowhere') === null, 'an absent id is null, not a guess');

console.log('the three states');
check(core.stateOf(tree, {}) === 'play', 'everything playing is green');
check(core.stateOf(tree, ALL) === 'pause', 'everything paused is red');
check(core.stateOf(tree, { 'root/workers': true }) === 'mixed', 'one paused leaf is amber');
check(core.stateOf(core.findNode(tree, 'root/mail'), ALL) === 'play',
	'an empty branch is green, not red — nothing is being withheld');

console.log('clicking');
const a = core.findNode(tree, 'root/diamonds/a');
const paused = core.applySet(a, {}, false);
check(paused['root/diamonds/a/self'] && paused['root/diamonds/a/triggers/t1'],
	'pausing a branch writes every leaf under it');
check(!paused['root/diamonds/b/self'] && !paused['root/workers'],
	'and touches nothing outside it');
check(core.stateOf(a, paused) === 'pause', 'the branch then reads red');
check(core.clickWould(a, {}) === 'pause', 'a green branch clicks to paused');
check(core.clickWould(a, { 'root/diamonds/a/self': true }) === 'play',
	'an AMBER branch clicks to playing — the alternative fights the user');
check(core.stateOf(a, core.applySet(a, { 'root/diamonds/a/self': true }, true)) === 'play',
	'resuming an amber branch clears every leaf under it');
// The property, stated as a property: no single click ever lands on amber.
let amberReachable = false;
for (const start of [{}, ALL, { 'root/diamonds/a/self': true }, { 'root/workers': true }]) {
	for (const nodeId of ['root', 'root/diamonds', 'root/diamonds/a', 'root/workers']) {
		const node = core.findNode(tree, nodeId);
		const next = core.applySet(node, start, core.clickWould(node, start) === 'play');
		if (core.stateOf(node, next) === 'mixed') amberReachable = true;
	}
}
check(!amberReachable, 'no click on any node, from any state, leaves that node amber');

console.log('the stored record');
const r = core.toRecord({ z: true, a: true, m: true }, 7);
check(JSON.stringify(r.paused) === '["a","m","z"]', 'the record is sorted', JSON.stringify(r));
check(JSON.stringify(core.toRecord({ m: true, z: true, a: true }, 7)) === JSON.stringify(r),
	'and independent of insertion order — the parcel must be a fixed point');
check(JSON.stringify(core.toRecord(core.fromRecord(r), 7)) === JSON.stringify(r),
	'a record round trips unchanged');
check(JSON.stringify(core.fromRecord({ paused: [null, '', 3, 'ok'] })) === '{"ok":true}',
	'junk in a record is dropped rather than stored');
check(JSON.stringify(core.fromRecord(null)) === '{}', 'no record at all is everything playing');

console.log('merging two devices');
check(JSON.stringify(core.mergeRecords({ paused: ['a'], stamp: 1 }, { paused: ['b'], stamp: 2 }).paused)
	=== '["b"]', 'the later stamp wins whole, so a resume propagates');
const eqA = core.mergeRecords({ paused: ['a'], stamp: 5 }, { paused: ['b'], stamp: 5 });
const eqB = core.mergeRecords({ paused: ['b'], stamp: 5 }, { paused: ['a'], stamp: 5 });
check(JSON.stringify(eqA.paused) === '["a","b"]',
	'equal stamps take the union — erring towards paused, because a wrong pause costs a click and a wrong resume costs money');
check(JSON.stringify(eqA) === JSON.stringify(eqB), 'and the merge is order-independent');
check(JSON.stringify(core.mergeRecords(r, r)) === JSON.stringify(r),
	'merging a record with itself changes nothing');

console.log('node ids');
check(Pause.id('root', 'mail', 'a@b.com', 'INBOX/Sub') === 'root/mail/a@b.com/INBOX%2FSub',
	'a slash inside a name is escaped, so a folder cannot invent a level',
	Pause.id('root', 'mail', 'a@b.com', 'INBOX/Sub'));
check(Pause.id('root', '', null, 'workers') === 'root/workers', 'empty parts are dropped');

console.log(bad ? `\n${bad} failed` : '\nall checks passed');
process.exit(bad ? 1 : 0);
