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
// sync parcel has to be a FIXED POINT, and a record serialised in hash order is
// not one. Two devices then push at each other for ever. See
// `dev/verify_parcelstable.mjs`. The record's own merge is proved at length in
// `www/js/pause.test.mjs`.
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
check(core.leavesUnder(mixedArm).length === 2 && core.resolve(core.press({}, 'k', 1, 1, 'x'), 'k/hand'),
	'and the manual leaf is STILL HELD by a click on its branch, so the global control reaches it');

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
// A press is one entry at the node pressed (see `www/js/pause.test.mjs` for the
// record itself); what a light reads is the held set of the leaves under it.
const heldOf = (E) => {
	const out = {};
	for (const l of core.leavesUnder(tree)) if (core.resolve(E, l)) out[l] = true;
	return out;
};
const a = core.findNode(tree, 'root/diamonds/a');
const onA = core.press({}, 'root/diamonds/a', 1, 1, 'x');
const paused = heldOf(onA);
check(paused['root/diamonds/a/self'] && paused['root/diamonds/a/triggers/t1'],
	'pausing a branch holds every leaf under it');
check(!paused['root/diamonds/b/self'] && !paused['root/workers'],
	'and touches nothing outside it');
check(Object.keys(onA).join() === 'root/diamonds/a', 'with one entry, at the branch', Object.keys(onA).join());
check(core.stateOf(a, paused) === 'pause', 'the branch then reads red');
check(core.clickWould(a, {}) === 'pause', 'a green branch clicks to paused');
check(core.clickWould(a, { 'root/diamonds/a/self': true }) === 'play',
	'an AMBER branch clicks to playing — the alternative fights the user');
const amber = core.press({}, 'root/diamonds/a/self', 1, 1, 'x');
check(core.stateOf(a, heldOf(core.press(amber, 'root/diamonds/a', 0, 2, 'x'))) === 'play',
	'resuming an amber branch clears every leaf under it');
// The property, stated as a property: no single click ever lands on amber.
let amberReachable = false;
const starts = [{}, core.press({}, 'root', 1, 1, 'x'), amber, core.press({}, 'root/workers', 1, 1, 'x')];
for (const start of starts) {
	for (const nodeId of ['root', 'root/diamonds', 'root/diamonds/a', 'root/workers']) {
		const node = core.findNode(tree, nodeId);
		const p = core.clickWould(node, heldOf(start)) === 'play' ? 0 : 1;
		if (core.stateOf(node, heldOf(core.press(start, nodeId, p, 5, 'x'))) === 'mixed') amberReachable = true;
	}
}
check(!amberReachable, 'no click on any node, from any state, leaves that node amber');

console.log('the stored record');
const E = { 'z': [1, 3, 'h:x'], 'a': [0, 2, 'h:x'], 'm': [1, 1, 'a:x'] };
const r = core.toRecord(E, 7, null);
check(JSON.stringify(Object.keys(r.leaves)) === '["a","m","z"]' && JSON.stringify(r.paused) === '["m","z"]',
	'the record is sorted', JSON.stringify(r));
check(JSON.stringify(core.toRecord({ m: E.m, z: E.z, a: E.a }, 7, null)) === JSON.stringify(r),
	'and independent of insertion order — the parcel must be a fixed point');
check(JSON.stringify(core.toRecord(core.mergeEntries({}, r.leaves), 7, null)) === JSON.stringify(r),
	'a record round trips unchanged');
check(JSON.stringify(core.mergeEntries({}, { a: [1, 1], b: 'x', c: [2, 1, 'h:x'], ok: [1, 1, 'h:x'] }))
	=== '{"ok":[1,1,"h:x"]}', 'junk in a record is dropped rather than stored');
check(core.heldLeaves(core.mergeEntries({}, null), tree).length === 0, 'no record at all is everything playing');

console.log('merging two devices');
const later = core.mergeEntries({ a: [1, 1, 'h:x'] }, { a: [0, 2, 'h:y'] });
check(!core.resolve(later, 'a'), 'the later entry wins for its id, so a resume propagates');
const eqA = core.mergeEntries({ a: [1, 5, 'h:x'] }, { a: [0, 5, 'h:y'], b: [1, 5, 'h:y'] });
const eqB = core.mergeEntries({ a: [0, 5, 'h:y'], b: [1, 5, 'h:y'] }, { a: [1, 5, 'h:x'] });
check(core.resolve(eqA, 'a') && core.resolve(eqA, 'b'),
	'an equal stamp errs towards paused, because a wrong pause costs a click and a wrong resume costs money');
check(JSON.stringify(core.toRecord(eqA, 0, null)) === JSON.stringify(core.toRecord(eqB, 0, null)),
	'and the merge is order-independent');
check(JSON.stringify(core.toRecord(core.mergeEntries(r.leaves, r.leaves), 7, null)) === JSON.stringify(r),
	'merging a record with itself changes nothing');
const whole = core.mergeEntries(core.press({}, 'root', 1, 10, 'x'), core.press({}, 'root/chats/c1', 1, 20, 'y'));
check(core.leavesUnder(tree).every((l) => core.resolve(whole, l)),
	'and a later press on one leaf elsewhere no longer undoes a Pause all (R3 QA, M-merge)');

console.log('node ids');
check(Pause.id('root', 'mail', 'a@b.com', 'INBOX/Sub') === 'root/mail/a@b.com/INBOX%2FSub',
	'a slash inside a name is escaped, so a folder cannot invent a level',
	Pause.id('root', 'mail', 'a@b.com', 'INBOX/Sub'));
check(Pause.id('root', '', null, 'workers') === 'root/workers', 'empty parts are dropped');

console.log(bad ? `\n${bad} failed` : '\nall checks passed');
process.exit(bad ? 1 : 0);
