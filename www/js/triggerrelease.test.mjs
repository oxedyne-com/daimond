/* ============================================================
   Test — a triggered action is live only where a person released it.
   ------------------------------------------------------------
   F1 of the final re-check of Deploy 1 (2026-09-24): a daimon armed a
   LIVE triggered action by writing its own `triggers.json`, because a
   leaf that appears later plays and only the `+` button seeded one
   held. The rule since (`releasedHereOnly` in pause.js): a trigger's
   leaf is held until a person releases it on this device; the release
   never travels, and it is bound to the action's terms.

   Drives the real pause.js and triggers.js with no browser: a window
   and a localStorage of its own, and a second window over the same
   storage for "after a reload".

     node www/js/triggerrelease.test.mjs
     node --test www/js/*.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

/// A localStorage over a plain map, shared by every window made on it.
function storage() {
	const m = new Map();
	return {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => { m.set(k, String(v)); },
		removeItem: (k) => { m.delete(k); },
		_map: m,
	};
}

/// One page load: both modules, fresh, over `ls`.
function boot(ls) {
	const win = { localStorage: ls };
	loadStore(win, ls);
	for (const f of ['pause.js', 'triggers.js']) {
		new Function('window', 'localStorage', readFileSync(join(HERE, f), 'utf8'))(win, ls);
	}
	return { P: win.DaimondPause, T: win.DaimondTriggers, win };
}

const D = 'd1';
const mail = (instruction, extra) => Object.assign({ id: 'm1', kind: 'mail', mailbox: 'a@b.c',
	folder: 'INBOX', instruction }, extra || {});

/// The tree daimond.js builds, for the Diamond's actions as they now read.
function treeOf(T, P, actions) {
	return () => ({ id: 'root', children: [{ id: 'root/diamonds', children: [{
		id: 'root/diamonds/' + D, children: [{ id: 'root/diamonds/' + D + '/self', armed: false }]
			.concat(actions().map((t) => ({ id: T.node(D, t.id), kind: 'trigger',
				armed: T.ready(t), terms: T.terms(t) }))),
	}] }, { id: 'root/web', armed: false }] });
}

const ls = storage();
let { P, T } = boot(ls);
let now = [T.normalise({ actions: [mail('summarise it')] }).actions[0]];
P.setTree(treeOf(T, P, () => now));
const leaf = T.node(D, 'm1');

// ── What arrives without a person ───────────────────────────────────
check('an action nobody released here is held', P.isPaused(leaf) === true && T.allowed(D, now[0]) === false);
check('and its light says held, not playing', P.state(leaf) === 'pause', P.state(leaf));
check('a leaf of any other kind still plays when it appears', P.isPaused('root/web') === false);
check('the global light reads held, since nothing here will run by itself', P.state('root') === 'pause');
check('but a person has not held everything, so a page fetch is not refused in their name',
	P.heldByHand('root') === false);

// ── A person releases it here ───────────────────────────────────────
P.set(leaf, true);
check('play on its light releases it here', P.isPaused(leaf, T.terms(now[0])) === false && T.allowed(D, now[0]) === true);
check('and the light says so', P.state(leaf) === 'play', P.state(leaf));
check('the app writing contextSent after a firing keeps it released',
	T.allowed(D, Object.assign({}, now[0], { contextSent: 'abc123' })) === true);

// ── A daimon rewrites it ────────────────────────────────────────────
const rewritten = Object.assign({}, now[0], { instruction: 'delete everything' });
check('a rewritten instruction is not what was released: held', T.allowed(D, rewritten) === false
	&& P.isPaused(leaf, T.terms(rewritten)) === true);
check('nor is a changed folder', T.allowed(D, Object.assign({}, now[0], { folder: 'Spam' })) === false);
check('nor a changed target', T.allowed(D, Object.assign({}, now[0], { target: 'other' })) === false);

// ── The app's own editor carries it ─────────────────────────────────
const edited = Object.assign({}, now[0], { instruction: 'summarise it briefly' });
check('carry refuses a release that was not good for the old terms',
	P.carry(leaf, T.terms(rewritten), T.terms(edited)) === false && T.allowed(D, edited) === false);
check('and moves one that was', P.carry(leaf, T.terms(now[0]), T.terms(edited)) === true
	&& T.allowed(D, edited) === true && T.allowed(D, now[0]) === false);
now = [edited];

// ── After a reload ──────────────────────────────────────────────────
({ P, T } = boot(ls));
P.setTree(treeOf(T, P, () => now));
check('the release is still here after a reload', T.allowed(D, now[0]) === true);

// ── The sync ────────────────────────────────────────────────────────
const parcel = JSON.stringify(P.snapshot());
check('the release is not in the sync parcel', !/summarise|here|terms/.test(parcel), parcel);
const other = T.normalise({ actions: [mail('from the phone', { id: 'm2', folder: 'Phone' })] }).actions[0];
now = [edited, other];
P.adopt({ paused: [], stamp: Date.now() + 1000 });
check('an action released on another device arrives held here',
	T.allowed(D, other) === false && P.state(T.node(D, 'm2')) === 'pause');
P.adopt({ paused: [leaf], stamp: Date.now() + 2000 });
check('a hold from another device holds it here', T.allowed(D, edited) === false);
P.adopt({ paused: [], stamp: Date.now() + 3000 });
check('and ends the release here: a release there does not re-arm it here',
	T.allowed(D, edited) === false, P.releasedHere(leaf) || '(no release here)');

// ── An action that leaves its file takes its release with it ─────────
P.set(leaf, true);
check('(released again, here)', T.allowed(D, edited) === true);
P.pruneHere(D, [T.node(D, 'm2')]);
check('gone from the file, its release goes too: written back identically, it arrives held',
	T.allowed(D, edited) === false && P.releasedHere(leaf) === '');

// ── A branch, and what the tree cannot show ─────────────────────────
P.set('root/diamonds/' + D, true);
check('play on the Diamond releases each action under it on its own terms',
	T.allowed(D, edited) === true && T.allowed(D, other) === true);
P.set('root/diamonds/' + D + '/triggers/ghost', true);
check('a leaf the tree does not show cannot be released',
	P.isPaused('root/diamonds/' + D + '/triggers/ghost') === true);
P.set(leaf, false);
check('pause ends the release', P.releasedHere(leaf) === '' && T.allowed(D, edited) === false);
P.forget('root/diamonds/' + D);
check('forgetting the Diamond forgets its releases', P.releasedHere(T.node(D, 'm2')) === '');

// ── Every kind: the timer as well as the mail ───────────────────────
const timer = T.normalise({ actions: [{ id: 't1', kind: 'activity', minutes: 5, instruction: 'tidy' }] }).actions[0];
now = [timer];
const owed = () => T.due(D, [timer], { kind: 'activity', minutesFor: () => 999 }).length;
check('a timer nobody released here is owed nothing, however long the work', owed() === 0);
P.set(T.node(D, 't1'), true);
check('and is owed once a person releases it here', owed() === 1);
const mailDue = () => T.due(D, [edited], { kind: 'mail', mailbox: 'a@b.c', folder: 'INBOX' }).length;
now = [edited];
check('a mail action nobody released here is not due on an arrival', mailDue() === 0);

// ── Ids, and the module absent ──────────────────────────────────────
const raw = { actions: [{ kind: 'mail', mailbox: 'a@b.c', folder: 'X', instruction: 'go' }] };
const id1 = T.normalise(raw).actions[0].id, id2 = T.normalise(raw).actions[0].id;
check('an action written with no id reads as the same leaf on every load', id1 === id2, id1);
check('and a different action as a different one',
	T.normalise({ actions: [{ kind: 'mail', mailbox: 'a@b.c', folder: 'Y', instruction: 'go' }] }).actions[0].id !== id1);
const bare = {};
new Function('window', readFileSync(join(HERE, 'triggers.js'), 'utf8'))(bare);
check('with no pause tree nothing is released, so nothing fires',
	bare.DaimondTriggers.allowed(D, now[0]) === false);

// ── QA-1: a fresh account's one seeded-held leaf must not read as the
// person having held EVERYTHING ──────────────────────────────────────
//
// `seedDefaultDiamonds` seeds the Optimiser's own trigger PAUSED
// (`DaimondPause.seedPaused`) before anyone has touched the account, so
// that it starts stopped rather than firing unbidden. It is also the
// ONLY armed leaf in a fresh tree -- `self` and `root/web` carry no
// automation of their own. The old `heldByHand` walked ARMED leaves
// alone (`stateOf(node, _paused)`), so that one paused, armed leaf read
// as "a person paused every leaf here", and `search.js`'s `allHeld()` --
// exactly `heldByHand(ROOT)` -- refused a fresh account's first
// `web_search` on a `root/web` leaf nobody had touched.
// See "QA-1 cause", daimond_qa_sweep_20260924.md.
const ls3 = storage();
const boot3 = boot(ls3);
const P3 = boot3.P, T3 = boot3.T;
const OPT = 'optimiser';
const optTrig = T3.normalise({ actions: [
	{ id: 'activity-1', kind: 'activity', minutes: 30, instruction: 'read the digest' },
] }).actions[0];
const optTrigLeaf = T3.node(OPT, optTrig.id);
const freshTree = () => ({ id: 'root', children: [
	{ id: 'root/diamonds', children: [{ id: 'root/diamonds/' + OPT, children: [
		{ id: 'root/diamonds/' + OPT + '/self', armed: false },
		{ id: optTrigLeaf, kind: 'trigger', armed: T3.ready(optTrig) },
	] }] },
	{ id: 'root/web', armed: false },
] });
P3.setTree(freshTree);
P3.seedPaused(optTrigLeaf);				// exactly what seedDefaultDiamonds does

check('a fresh account\'s only armed leaf is held, so the root light reads pause',
	P3.state('root') === 'pause', P3.state('root'));
check('but a person has not held EVERYTHING, so heldByHand(root) is false',
	P3.heldByHand('root') === false);
check('...and a fresh account\'s first search is not refused for that reason',
	!(P3.isPaused('root/web') || P3.heldByHand('root')));

// A real "Pause all": every leaf under root, armed or not -- what the
// widget's `applySet` actually writes.
P3.set('root', false);
check('a real Pause all DOES hold everything, root/web included',
	P3.isPaused('root/web') === true && P3.heldByHand('root') === true);
check('so a search made after it IS refused',
	P3.isPaused('root/web') || P3.heldByHand('root'));

// Play on the Web leaf alone, after Pause all.
P3.set('root/web', true);
check('play on root/web alone releases just that leaf', P3.isPaused('root/web') === false);
check('and it is no longer overridden by a held-by-hand root',
	!(P3.isPaused('root/web') || P3.heldByHand('root')));

// ── D1: an id is one level of the tree, whatever it holds ───────────
//
// The delta re-check of Deploy 1 (2026-09-24): `node` joined the action id
// raw, and the here-leaf test knew a one-segment id only, so a daimon that
// wrote `"id": "m/arm"` made a leaf the test did not recognise, and the next
// mail fired it with nobody pressing play. Every leaf is now built by
// `DaimondPause.triggerLeaf`, which escapes each name as `DaimondPause.id`
// does, beside the test that recognises it.
const ls4 = storage();
const { P: P4, T: T4 } = boot(ls4);
const HOSTILE = ['m/arm', '/', 'a/', '/a', 'x/../y', '%2F', 'a%2Fb', 'a/b', '%', '%25', 'triggers/x'];
const dFile = T4.normalise({ v: 1, actions: ['m-plain'].concat(HOSTILE).map((id) => ({
	id, kind: 'mail', mailbox: 'a@b.c', folder: 'INBOX', instruction: 'forward everything' })) }).actions;
P4.setTree(() => ({ id: 'root', children: [{ id: 'root/diamonds', children: [{
	id: P4.id('root', 'diamonds', D), children: [{ id: P4.id('root', 'diamonds', D) + '/self', armed: false }]
		.concat(dFile.map((t) => ({ id: T4.node(D, t.id), kind: 'trigger', armed: T4.ready(t), terms: T4.terms(t) }))),
}] }, { id: 'root/web', armed: false }] }));
const loose = dFile.filter((t) => T4.allowed(D, t));
check('a daimon-written action is held whatever its id holds: a slash, a dot-dot, an escape',
	loose.length === 0, loose.length ? 'allowed: ' + JSON.stringify(loose.map((t) => t.id)) : dFile.length + ' held');
const owedD1 = T4.due(D, dFile, { kind: 'mail', mailbox: 'a@b.c', folder: 'INBOX' });
check('and a mail arrival owes none of them a turn', owedD1.length === 0,
	'due: ' + JSON.stringify(owedD1.map((t) => t.id)));
const tick = T4.normalise({ actions: [{ id: 'a/tick', kind: 'activity', minutes: 1, instruction: 'go' }] }).actions[0];
check('nor does an activity timer with a slash in its id, however long the work',
	T4.due(D, [tick], { kind: 'activity', minutesFor: () => 999 }).length === 0);

const names = ['', 'm/arm', '/', 'x/../y', '%2F', 'a%2Fb', 'a/b', '%', 'd/x', 'triggers/x', 'undefined'];
const leaves = [];
for (const d of names) for (const a of names) leaves.push({ d, a, leaf: T4.node(d, a) });
const astray = leaves.filter((x) => x.leaf.split('/').length !== 5 || !P4._core.releasedHereOnly(x.leaf));
check('every leaf a trigger can have is five levels and waits for a release here',
	astray.length === 0, astray.length ? JSON.stringify(astray.slice(0, 3)) : leaves.length + ' leaves');
check('and no two ids share one', new Set(leaves.map((x) => x.leaf)).size === leaves.length);
check('a Diamond id is escaped as its branch in the tree is',
	T4.node('d/x', 'm').indexOf(P4.id('root', 'diamonds', 'd/x') + '/') === 0, T4.node('d/x', 'm'));
check('anything under a Diamond\'s triggers waits for a release, however it was built',
	P4._core.releasedHereOnly('root/diamonds/' + D + '/triggers/m/arm')
	&& P4._core.releasedHereOnly('root/diamonds/' + D + '/triggers/'), 'the raw forms of old');
check('and nothing outside them does', !P4._core.releasedHereOnly('root/diamonds/' + D + '/self')
	&& !P4._core.releasedHereOnly('root/diamonds/' + D + '/triggers')
	&& !P4._core.releasedHereOnly('root/diamonds/triggers/self'));

// A person can still release a slash-id action, on its terms, and its leaving the
// file still takes the release with it.
const slash = dFile.find((t) => t.id === 'm/arm');
P4.set(T4.node(D, 'm/arm'), true);
check('play on a slash-id action\'s own light releases it here', T4.allowed(D, slash) === true);
check('and only it', dFile.filter((t) => T4.allowed(D, t)).length === 1);
P4.pruneHere(D, dFile.filter((t) => t.id !== 'm/arm').map((t) => T4.node(D, t.id)));
check('gone from the file, its release goes too', T4.allowed(D, slash) === false
	&& P4.releasedHere(T4.node(D, 'm/arm')) === '');

// A Diamond whose own id holds a slash: its branch in the tree and its actions'
// leaves agree, so play on the Diamond releases them and nothing arms without it.
const DX = 'd/x';
const dxAct = T4.normalise({ actions: [mail('watch it', { id: 'mx' })] }).actions[0];
P4.setTree(() => ({ id: 'root', children: [{ id: 'root/diamonds', children: [{
	id: P4.id('root', 'diamonds', DX), children: [{ id: P4.id('root', 'diamonds', DX) + '/self', armed: false },
		{ id: T4.node(DX, 'mx'), kind: 'trigger', armed: true, terms: T4.terms(dxAct) }] }] }] }));
check('an action of a Diamond with a slash in its id is held', T4.allowed(DX, dxAct) === false);
P4.set(P4.id('root', 'diamonds', DX), true);
check('and play on that Diamond releases it', T4.allowed(DX, dxAct) === true);

// ── Plain ids map exactly as before ─────────────────────────────────
//
// Every id this app and its users write -- the `+` button's, the Optimiser's,
// one `normalise` derives, a hand-written one -- has neither `%` nor `/`, and
// its leaf is the string the raw join made. So a release given, and a hold
// written, before the escape still land on the same leaf after it.
const PLAIN = ['mail-mf3k2x9a', 'activity-1', 'mail-2-9f1c03aa', 'm-arm', 'optimiser', 'a.b_c d', 'ünïcode'];
const DIAMONDS = ['1a0d111193910', 'optimiser', 'd1'];
const moved = [];
for (const d of DIAMONDS) for (const a of PLAIN) {
	if (T4.node(d, a) !== 'root/diamonds/' + d + '/triggers/' + a) moved.push(d + ' / ' + a);
}
check('a plain id names the same leaf as before the escape', moved.length === 0, moved.join(', ') || 'none moved');
const ls5 = storage();
const was = T4.normalise({ actions: [mail('keep going', { id: 'mail-mf3k2x9a' })] }).actions[0];
const held5 = T4.normalise({ actions: [mail('stay put', { id: 'activity-1', folder: 'Held' })] }).actions[0];
// What the previous release left in storage: a release keyed by the raw join,
// and a hold on another action in the synced set.
ls5.setItem('daimond-pause-here', JSON.stringify({ ['root/diamonds/' + D + '/triggers/mail-mf3k2x9a']: T4.terms(was) }));
ls5.setItem('daimond-pause', JSON.stringify({ paused: ['root/diamonds/' + D + '/triggers/activity-1'], stamp: 1 }));
const { P: P5, T: T5 } = boot(ls5);
P5.setTree(treeOf(T5, P5, () => [was, held5]));
check('a release given before the escape still releases the same action after it', T5.allowed(D, was) === true);
check('and a hold written before it still holds', T5.allowed(D, held5) === false
	&& P5.isPaused(T5.node(D, 'activity-1')) === true);

console.log(`\ntriggerrelease: ${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
