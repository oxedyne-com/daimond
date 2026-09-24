// verify_pausemigrate.mjs — the pause record crosses the upgrade to per-id merge losslessly.
//
// The record was one set and one stamp until the R3 QA of 2026-09-24 (M-merge); it is now
// one entry per id (`www/js/pause.js`, "The record"). Every device an owner already has holds
// the old shape, in its store and in the parcel, and some will run the old build for a while
// yet. So this drives the REAL pause.js of both builds -- the old one from git at BASE, the
// new one from the working tree -- over stand-in storage and clocks, and passes records
// between them the way the sync and a hand-off errand do (`snapshot` out, `adopt` in):
//
//   U  the upgrade in place: an old store read by the new build holds what it held; an old
//      tab still open on the same store and the new tab read each other's writes.
//   W  both ways across the wire: an old device's record adopted by a new one, and the new
//      record adopted by an old one, keep every hold either made.
//   M  the old device in the M-merge race: its later pause of one chat cannot undo a new
//      device's Pause all, on either device once both have synced.
//   P  plays: an old device's play of what the app held arrives; its play of what a person
//      held on the new build errs held (the documented cost); a Play all on the new build
//      plays everything on the old one.
//
//   node dev/verify_pausemigrate.mjs            # BASE defaults to 81309ed6, live Release 3
//   BASE=<rev> NEW=<path to pause.js> node dev/verify_pausemigrate.mjs
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TREE_DIR = path.dirname(HERE);
const BASE = process.env.BASE || '81309ed6';
const OLD = execFileSync('git', ['-C', TREE_DIR, 'show', BASE + ':www/js/pause.js'], { maxBuffer: 1 << 26 }).toString();
const NEW = readFileSync(process.env.NEW || path.join(TREE_DIR, 'www/js/pause.js'), 'utf8');

let bad = 0, n = 0;
const check = (name, fn, detail) => {
	n++;
	let pass = false, why = '';
	try { pass = !!fn(); } catch (e) { why = 'threw: ' + String(e && e.message || e).slice(0, 160); }
	if (!pass) bad++;
	const d = why || (detail ? String(detail()).slice(0, 300) : '');
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (pass || !d ? '' : ' — ' + d));
};

function storage() {
	const m = new Map();
	const ls = {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => { m.set(k, String(v)); ls.writes.push(k); },
		removeItem: (k) => { m.delete(k); ls.writes.push(k); },
		writes: [],
	};
	return ls;
}

const OPT  = 'root/diamonds/0da1000000f2';
const SELF = OPT + '/self';
const TRIG = OPT + '/triggers/activity-1';
const X = 'root/chats/x', Y = 'root/chats/y', Z = 'root/chats/z';
const tree = (chats) => () => ({ id: 'root', children: [
	{ id: 'root/diamonds', children: [{ id: OPT, children: [{ id: SELF, armed: false }, { id: TRIG }] }] },
	{ id: 'root/chats', children: chats.map((c) => ({ id: c, armed: false })) },
	{ id: 'root/mail', children: [] },
	{ id: 'root/workers' },
	{ id: 'root/web', armed: false },
] });
const ALL = [SELF, TRIG, X, Y, 'root/workers', 'root/web'];

/// One device or tab on `src`, over `ls`, with its own id and clock.
function device(src, dev, ls, clock, chats) {
	const on = {};
	const win = {
		localStorage: ls,
		addEventListener: (type, fn) => { (on[type] = on[type] || []).push(fn); },
		dispatchEvent: () => true,
		DaimondIdentity: { deviceId: () => dev },
	};
	new Function('window', 'localStorage', 'CustomEvent', 'Date', src)(win, ls,
		function CustomEvent(type) { this.type = type; }, { now: clock });
	const P = win.DaimondPause;
	P.setTree(tree(chats || [X, Y]));
	return { P, ls, hear: (key) => (on.storage || []).forEach((fn) => fn({ key })) };
}
const oldDev = (dev, clock, ls, chats) => device(OLD, dev, ls || storage(), clock, chats);
const newDev = (dev, clock, ls, chats) => device(NEW, dev, ls || storage(), clock, chats);
const held = (P, ids) => ids.every((id) => P.isPaused(id));
const plays = (P, ids) => ids.every((id) => !P.isPaused(id));
const T = 1_800_000_000_000;
const at = (t) => () => t;

// ── U. the upgrade in place ────────────────────────────────────────────
console.log('\nU. the upgrade in place');
{
	// On the old build: the seed held the action, then a person paused chat X.
	const ls = storage();
	const O = oldDev('dddd', at(T), ls);
	O.P.seedPaused(TRIG);
	O.P.set(X, false);
	const stored = JSON.parse(ls.getItem('daimond-pause'));
	check('U0: the old build wrote its own shape', () => !stored.v && stored.paused.length === 2,
		() => JSON.stringify(stored));
	// The same device loads the new build over the same store.
	const N = newDev('dddd', at(T + 60_000), ls);
	check('U1: a pause pressed on the old build holds on the new one, and so does the seed',
		() => held(N.P, [X, TRIG]) && plays(N.P, [Y, SELF, 'root/web']), () => JSON.stringify(N.P.snapshot()));
	N.P.set(Y, false);
	const up = JSON.parse(ls.getItem('daimond-pause'));
	check('U2: its first write keeps the old fields beside the record', () => up.v === 2
		&& ['root/chats/x', 'root/chats/y', TRIG].every((k) => up.paused.includes(k)) && up.stamp > stored.stamp,
		() => JSON.stringify(up));
	// A tab still on the old build, open on the same store, hears that write and reads it.
	const from = ls.writes.length;
	const O2 = oldDev('dddd', at(T + 120_000), ls);
	check('U3: an old tab reads the new store: every hold stands', () => held(O2.P, [X, Y, TRIG]));
	O2.P.set('root/web', false);					// and writes its own shape back over it
	for (const k of ls.writes.slice(from)) N.hear(k);
	check('U4: the new tab reads the old tab\'s write, and loses nothing it held', () => held(N.P, [X, Y, TRIG, 'root/web']),
		() => JSON.stringify(N.P.snapshot()));
	N.P.set(Z, false);
	check('U5: and its next write carries the old tab\'s pause on', () =>
		JSON.parse(ls.getItem('daimond-pause')).paused.includes('root/web'));
}

// ── W. both ways across the wire ───────────────────────────────────────
console.log('\nW. both ways across the wire');
{
	const O = oldDev('oooo', at(T)), N = newDev('nnnn', at(T + 10_000));
	O.P.set(X, false);								// a person, on the old build
	N.P.adopt(O.P.snapshot());
	check('W1: an old device\'s pause arrives on a new one', () => N.P.isPaused(X));
	N.P.set(Y, false);								// a person, on the new build
	O.P.adopt(N.P.snapshot());
	check('W2: a new device\'s pause arrives on an old one, beside its own', () => held(O.P, [X, Y]));
	const before = JSON.stringify(N.P.snapshot());
	N.P.adopt(O.P.snapshot());						// the old device echoes it back
	check('W3: the old device\'s echo changes nothing on the new one, to the byte',
		() => JSON.stringify(N.P.snapshot()) === before, () => before + ' vs ' + JSON.stringify(N.P.snapshot()));
	// A second new device that has only ever heard from the old one.
	const N2 = newDev('mmmm', at(T + 20_000));
	N2.P.adopt(O.P.snapshot());
	N2.P.adopt(N.P.snapshot());
	N.P.adopt(N2.P.snapshot());
	check('W4: two new devices, one fed through the old one, agree to the byte',
		() => JSON.stringify(N2.P.snapshot().leaves) === JSON.stringify(N.P.snapshot().leaves)
			&& held(N2.P, [X, Y]));
}

// ── M. the old device in the M-merge race ──────────────────────────────
console.log('\nM. an old device\'s later pause of one chat, against a new device\'s Pause all');
{
	for (const order of ['new-first', 'old-first']) {
		const N = newDev('nnnn', at(T)), O = oldDev('oooo', at(T + 5000));
		N.P.set('root', false);						// Pause all, on the new build
		O.P.set(X, false);							// five seconds later, not yet pulled
		if (order === 'new-first') { N.P.adopt(O.P.snapshot()); O.P.adopt(N.P.snapshot()); }
		else { O.P.adopt(N.P.snapshot()); N.P.adopt(O.P.snapshot()); O.P.adopt(N.P.snapshot()); }
		check('M1 (' + order + '): the Pause all stands on the new device', () => N.P.heldByHand('root') && held(N.P, ALL));
		check('M2 (' + order + '): and on the old one once both have synced', () => held(O.P, ALL),
			() => JSON.stringify(O.P.snapshot()));
	}
}

// ── P. plays ───────────────────────────────────────────────────────────
console.log('\nP. plays across the upgrade');
{
	// The app held the action (a seed); the old device's person plays it later.
	const N = newDev('nnnn', at(T)), O = oldDev('oooo', at(T + 5000));
	N.P.seedPaused(TRIG);
	O.P.adopt(N.P.snapshot());
	O.P.set(TRIG, true);
	N.P.adopt(O.P.snapshot());
	check('P1: an old device\'s play of what the app held arrives', () => !N.P.snapshot().paused.includes(TRIG)
		&& !(N.P.entry(TRIG) || [1])[0]);
	// A person held chat X on the new build; the old device plays it later.
	N.P.set(X, false);
	O.P.adopt(N.P.snapshot());
	const O2 = oldDev('oooo', at(T + 60_000), O.ls);
	O2.P.set(X, true);
	N.P.adopt(O2.P.snapshot());
	check('P2: an old device\'s play of what a person held on the new build errs held (the documented cost)',
		() => N.P.isPaused(X));
	// A Play all on the new build reaches the old one whole.
	N.P.set('root', false);
	O2.P.adopt(N.P.snapshot());
	check('P3: the old device holds everything the new one\'s Pause all holds', () => held(O2.P, ALL));
	N.P.set('root', true);
	O2.P.adopt(N.P.snapshot());
	check('P4: and a Play all on the new build plays everything on the old one', () => plays(O2.P, [SELF, X, Y, 'root/workers', 'root/web']),
		() => JSON.stringify(O2.P.snapshot()));
}

console.log('\n' + (n - bad) + '/' + n + ' checks passed');
process.exit(bad ? 1 : 0);
