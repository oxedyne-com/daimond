// verify_pausecore.mjs — the pause tree's rule, proved without a browser.
//
// The rule the whole PPTW rests on: a leaf is binary, a branch is green when
// every ARMED leaf under it plays, red when none does, and amber otherwise —
// with amber DERIVED and never settable. That is a statement about a tree and a
// set, so it can be tested as one. `www/js/pause.js` exports its pure core for
// exactly this; nothing here needs a page, a server or a clock.
//
// THE WORD "ARMED" IS NEW AND IT MOVED THE ANSWER, so the checks it changed are
// written out rather than quietly edited. The light used to count every leaf, so
// a node nobody had paused read green — and green was read, correctly, as
// "running". The owner read the Email panel exactly that way: it "shows green
// when all mailboxes are updated manually", which is green while nothing was
// automated at all. It now counts only leaves with something set up to spend
// WITHOUT BEING ASKED, and a node with none of those is `idle`: red, and said in
// words as "nothing set up to run on its own", because red alone cannot tell
// that apart from "the automation here is stopped".
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

console.log('the four states');
check(core.stateOf(tree, {}) === 'play', 'everything playing is green');
check(core.stateOf(tree, ALL) === 'pause', 'everything paused is red');
check(core.stateOf(tree, { 'root/workers': true }) === 'mixed', 'one paused leaf is amber');
check(core.stateOf(core.findNode(tree, 'root/mail'), ALL) === 'idle',
	'an empty branch is IDLE — there is nothing there to be running or stopped');

console.log('armed, which is what the light counts');
// A leaf with no `armed` field is armed. The default matters: a leaf added later
// by somebody who has not read this file behaves exactly as it did before rather
// than silently dropping out of every light above it.
check(core.armedUnder({ id: 'x' }).length === 1,
	'a leaf that says nothing about it is armed');
check(core.armedUnder({ id: 'x', armed: false }).length === 0,
	'and one that says otherwise is not');
check(core.armedUnder({ id: 'x', armed: true }).length === 1,
	'and one that says so is');

// THE OWNER'S DEFAULT CASE, which is the whole reason for this section: a node
// with leaves, none of them automated. It read GREEN, meaning "running", with
// nothing whatever running. It is red now, and the word says why.
const manual = { id: 'm', children: [
	{ id: 'm/1', armed: false },
	{ id: 'm/2', armed: false },
	{ id: 'm/3', armed: false },
] };
check(core.leavesUnder(manual).length === 3, 'the leaves are still there');
check(core.armedUnder(manual).length === 0, 'and none of them is armed');
check(core.stateOf(manual, {}) === 'idle',
	'a node whose every leaf is manual is IDLE and not green');
check(core.stateOf(manual, { 'm/1': true, 'm/2': true, 'm/3': true }) === 'idle',
	'and pausing all of them does not make it red for a different reason');

// An unarmed leaf CONTRIBUTES NOTHING TO THE COLOUR while staying in the tree,
// which is the property that lets the global control keep pausing it. Asserted
// as an invariance: the same node, two different pause sets, one answer.
const mixedArm = { id: 'k', children: [
	{ id: 'k/auto', armed: true },
	{ id: 'k/hand', armed: false },
] };
check(core.stateOf(mixedArm, {}) === 'play',
	'one armed leaf playing beside a manual one is green, not amber');
check(core.stateOf(mixedArm, { 'k/hand': true }) === 'play',
	'and pausing the manual one changes nothing the light says');
check(core.stateOf(mixedArm, { 'k/auto': true }) === 'pause',
	'while pausing the armed one turns it red');
check(core.leavesUnder(mixedArm).length === 2 && core.applySet(mixedArm, {}, false)['k/hand'],
	'and the manual leaf is STILL WRITTEN by a click, so the global control reaches it');

// The light can never count a leaf that is not in the tree. Written as a subset
// test over every node rather than as one example, because the failure this
// guards is a recursion that visits a child list twice.
let subsetOk = true;
for (const id of ['root', 'root/diamonds', 'root/diamonds/a', 'root/mail', 'root/workers']) {
	const n = core.findNode(tree, id);
	const leaves = core.leavesUnder(n);
	for (const a of core.armedUnder(n)) if (!leaves.includes(a)) subsetOk = false;
}
check(subsetOk, 'every armed leaf is a leaf — the light cannot count what is not there');

// AND THE OWNER'S THREE SENTENCES, as one table. "In the default case, the light
// should show red, since there is no automation running, and the play icon
// should be normal with the pause icon greyed out. As soon as one TA is active,
// it should switch to orange, with both play and pause not greyed."
const ta = (n, armed) => ({ id: 'd/triggers/' + n, armed: armed });
const dia = (...kids) => ({ id: 'd', children: [{ id: 'd/self', armed: false }].concat(kids) });
check(core.stateOf(dia(), {}) === 'idle',
	'a Diamond with no triggered action reads red — there is no automation running');
check(core.stateOf(dia(ta(1, true), ta(2, false)), {}) === 'play',
	'a TA that cannot fire is not counted, so the one that can makes it green');
check(core.stateOf(dia(ta(1, true), ta(2, true)), { 'd/triggers/1': true }) === 'mixed',
	'one of two armed triggers held is orange');
check(core.stateOf(dia(ta(1, true)), { 'd/triggers/1': true }) === 'pause',
	'and the only armed trigger held is red');

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
