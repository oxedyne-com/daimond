/* ============================================================
   Test — the pause record merges id by id.
   ------------------------------------------------------------
   The R3 QA of 2026-09-24 (M-merge): the record was one set and
   one stamp, and the later stamp won whole, so a press on one chat
   on a device that had not yet pulled a Pause all undid the Pause
   all everywhere. The same whole-record merge let an app write
   climb over a person's press (skew, X2, FC and Q6-1). The record
   is now `id -> [p, t, o]`, merged per id, resolved along the
   path, and an app write never ends a person's hold.

   The pure core first, then the real pause.js over a stand-in
   window, localStorage and clock, as `pausetabs.test.mjs` drives
   it. The shell half asks only the public API, so it can be run
   against an older pause.js to show what it catches there:

     node www/js/pause.test.mjs
     PAUSE_JS=/path/to/old/pause.js node www/js/pause.test.mjs
     node --test www/js/*.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = process.env.PAUSE_JS || join(HERE, 'pause.js');
const SRC  = readFileSync(FILE, 'utf8');

let failures = 0, checks = 0;
/// One check. `fn` answers the condition; one that throws -- an API an older
/// pause.js does not have -- is a failure, not a crash.
function check(name, fn, detail) {
	checks++;
	let cond = false, why = '';
	try { cond = !!fn(); } catch (e) { why = 'threw: ' + String(e && e.message || e).slice(0, 120); }
	const d = why || (typeof detail === 'function' ? safe(detail) : detail);
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (d ? ' — ' + d : '')); failures++; }
}
function safe(f) { try { return f(); } catch (e) { return ''; } }

/// pause.js over its own window, storage and clock. `clock` is a function
/// returning the time this device reads.
function load(ls, dev, clock) {
	const win = {
		localStorage: ls,
		addEventListener: (type, fn) => { (win.on[type] = win.on[type] || []).push(fn); },
		dispatchEvent: () => true,
		DaimondIdentity: { deviceId: () => dev },
		on: {},
	};
	const D = { now: clock || (() => Date.now()) };
	new Function('window', 'localStorage', 'CustomEvent', 'Date', SRC)(win, ls,
		function CustomEvent(type) { this.type = type; }, D);
	return win;
}

const C = load(storage(), 'core').DaimondPause._core;

/// An entry map as bytes, sorted by id.
function bytes(map) {
	return JSON.stringify(Object.keys(map).sort().map((k) => [k, map[k]]));
}
const heldAll = (map, ids) => ids.every((id) => C.resolve(map, id));

const OPT  = 'root/diamonds/0da1000000f2';
const SELF = OPT + '/self';
const TRIG = OPT + '/triggers/activity-1';
const HELP = 'root/diamonds/0da1000000f1/self';
const LEAVES = [SELF, TRIG, HELP, 'root/chats/x', 'root/chats/y', 'root/mail/a@b.c/self',
	'root/mail/a@b.c/INBOX', 'root/workers', 'root/web'];
const TREE = { id: 'root', children: [
	{ id: 'root/diamonds', children: [
		{ id: OPT, children: [{ id: SELF, armed: false }, { id: TRIG }] },
		{ id: 'root/diamonds/0da1000000f1', children: [{ id: HELP, armed: false }] }] },
	{ id: 'root/chats', children: [{ id: 'root/chats/x', armed: false }, { id: 'root/chats/y', armed: false }] },
	{ id: 'root/mail', children: [{ id: 'root/mail/a@b.c', children: [
		{ id: 'root/mail/a@b.c/self' }, { id: 'root/mail/a@b.c/INBOX' }] }] },
	{ id: 'root/workers' },
	{ id: 'root/web', armed: false },
] };

console.log('the core');

// ── The merge is a join: order-independent and repeat-safe ──────────
{
	// A small seeded generator, so a failure repeats.
	let seed = 20260924;
	const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
	const IDS = ['root', 'root/diamonds', OPT, SELF, TRIG, 'root/chats/x', 'root/workers'];
	const ORIGINS = ['h:A', 'h:B', 'a:A', 'a:B', 'a:legacy'];
	const gen = () => {
		const m = {};
		for (let i = rnd(6); i > 0; i--) {
			const e = [rnd(2), rnd(4), ORIGINS[rnd(ORIGINS.length)]];
			if (rnd(5) === 0) e.push(rnd(3));		// now and then a tombstone's time
			m[IDS[rnd(IDS.length)]] = e;
		}
		return m;
	};
	let comm = true, assoc = true, idem = true, sameHeld = true;
	check('the core is there', () => typeof C.mergeEntries === 'function');
	try {
		for (let i = 0; i < 2000; i++) {
			const a = gen(), b = gen(), c = gen();
			const ab = C.mergeEntries(a, b), ba = C.mergeEntries(b, a);
			if (bytes(ab) !== bytes(ba)) comm = false;
			if (bytes(C.mergeEntries(ab, c)) !== bytes(C.mergeEntries(a, C.mergeEntries(b, c)))) assoc = false;
			if (bytes(C.mergeEntries(ab, ab)) !== bytes(ab) || bytes(C.mergeEntries(ab, a)) !== bytes(ab)) idem = false;
			for (const id of IDS) if (C.resolve(ab, id) !== C.resolve(ba, id)) sameHeld = false;
		}
	} catch (e) { comm = assoc = idem = sameHeld = false; }
	check('merge is commutative, to the byte, over 2000 random pairs', () => comm);
	check('merge is associative', () => assoc);
	check('merge is idempotent: merging again, or merging a side back in, changes nothing', () => idem);
	check('and both orders resolve every id alike', () => sameHeld);
}

// ── M-merge: a later press on one chat does not undo a Pause all ─────
{
	const t = 1_800_000_000_000;
	const A = () => C.press({}, 'root', 1, t, 'A');				// A: Pause all
	const B = () => C.press({}, 'root/chats/x', 1, t + 5000, 'B');	// B, not pulled: pauses chat X
	check('M1: after the merge every leaf is held, on both devices',
		() => heldAll(C.mergeEntries(A(), B()), LEAVES) && heldAll(C.mergeEntries(B(), A()), LEAVES));
	check('M2: and a chat neither device had heard of resolves held',
		() => C.resolve(C.mergeEntries(A(), B()), 'root/chats/zz') && C.resolve(C.mergeEntries(B(), A()), 'root/diamonds/new/self'));
	check('a later play of one chat plays that chat only', () => {
		const m = C.mergeEntries(A(), C.press({}, 'root/chats/x', 0, t + 5000, 'B'));
		return !C.resolve(m, 'root/chats/x') && heldAll(m, LEAVES.filter((l) => l !== 'root/chats/x'));
	});
	check('and an old build\'s later record of one pause does not undo it either', () => {
		const viaOld = C.adoptLegacy(A(), { paused: ['root/chats/x'], stamp: t + 5000 });
		return heldAll(viaOld, LEAVES) && C.resolve(viaOld, 'root/chats/zz');
	});
}

// ── Press: one entry, decisive under it ─────────────────────────────
{
	const base = { [SELF]: [1, 1, 'a:A'], [TRIG]: [1, 1, 'a:A'], 'root/chats/x': [1, 900, 'h:B'] };
	check('a press writes one entry at the node pressed and drops the ones under it', () => {
		const p = C.press(base, OPT, 0, 500, 'A');
		return p[OPT][0] === 0 && p[OPT][2] === 'h:A' && !p[SELF] && !p[TRIG] && !!p['root/chats/x'];
	});
	check('and never touches a sibling', () =>
		JSON.stringify(C.press(base, OPT, 0, 500, 'A')['root/chats/x']) === JSON.stringify([1, 900, 'h:B']));
	check('it is stamped past everything on its path and under it, whatever the clock says',
		() => C.press({ [SELF]: [1, 7000, 'h:B'] }, OPT, 1, 10, 'A')[OPT][1] === 7001);
	check('including an ancestor, so a leaf press decides for that leaf', () => {
		const r = C.press({ root: [1, 9000, 'h:B'] }, 'root/chats/x', 0, 10, 'A');
		return r['root/chats/x'][1] === 9001 && !C.resolve(r, 'root/chats/x') && C.resolve(r, 'root/chats/y');
	});
	check('a person\'s pause of what only the app held is not settled: the press makes the hold theirs',
		() => !C.settled({ [SELF]: [1, 1, 'a:A'] }, SELF, 1) && C.settled({ [SELF]: [1, 1, 'h:A'] }, SELF, 1)
		&& C.press({ [SELF]: [1, 1, 'a:A'] }, SELF, 1, 9, 'B')[SELF][2] === 'h:B');
	check('a press that would change nothing is settled', () =>
		C.settled(C.press({}, 'root', 1, 5, 'A'), 'root/chats/x', 1)
		&& !C.settled(C.press({}, 'root', 1, 5, 'A'), 'root/chats/x', 0)
		&& !C.settled({ 'root/chats/x': [1, 9, 'h:A'] }, 'root/chats', 0)
		&& C.settled({}, 'root/web', 0));
}

// ── App writes never end a person's hold (skew, FA, X2, FC, Q6-1) ───
{
	// Skew: the record carries an app stamp far ahead; a press made on a device whose
	// clock is behind it; then two app writes from another device on the same id.
	check('skew: a press stays held through two app writes made on another device', () => {
		const pressed = C.press({ [SELF]: [0, 5000, 'a:B'] }, SELF, 1, 10, 'A');
		let onB = pressed;
		for (let i = 0; i < 2; i++) onB = C.unseedEntry(onB, SELF, 'B') || onB;
		onB = C.forgetEntries(onB, 'root/chats/x', 'B', 1) || onB;
		return C.resolve(C.mergeEntries(pressed, onB), SELF) && C.resolve(onB, SELF);
	});
	check('an app play over a person\'s entry is refused outright',
		() => C.unseedEntry(C.press({}, SELF, 1, 10, 'A'), SELF, 'B') === null);
	const seeded = { [SELF]: [1, 1, 'a:A'], [TRIG]: [1, 1, 'a:A'] };
	check('FA: the repair cannot play self under a person\'s Pause all', () => {
		const all = C.mergeEntries(seeded, C.press({}, 'root', 1, 1000, 'B'));
		return C.unseedEntry(all, SELF, 'A') === null && C.resolve(all, SELF);
	});
	check('X2/FC: nor a self a person paused, in any tab or on any device',
		() => C.unseedEntry(C.mergeEntries(seeded, C.press({}, SELF, 1, 1000, 'B')), SELF, 'A') === null);
	check('Q6-1: nor a self a person held by its Diamond\'s light or the Diamonds branch', () =>
		C.unseedEntry(C.mergeEntries(seeded, C.press({}, OPT, 1, 1000, 'B')), SELF, 'A') === null
		&& C.unseedEntry(C.mergeEntries(seeded, C.press({}, 'root/diamonds', 1, 1000, 'B')), SELF, 'A') === null);
	check('whatever the stamps: an app hold newer than a person\'s Pause all is still not played under it', () => {
		const m = { root: [1, 1000, 'h:B'], [SELF]: [1, 5000, 'a:legacy'] };
		return C.unseedEntry(m, SELF, 'A') === null && C.heldAbove(m, SELF);
	});
	check('but under a person\'s later play of the branch it may be', () => {
		const m = { root: [1, 1000, 'h:B'], 'root/diamonds': [0, 2000, 'h:B'], [SELF]: [1, 5000, 'a:legacy'] };
		return !C.heldAbove(m, SELF) && !!C.unseedEntry(m, SELF, 'A');
	});
	check('the seed\'s own hold is still taken back, one past its stamp, as the app', () => {
		const r = C.unseedEntry(seeded, SELF, 'A');
		return JSON.stringify(r[SELF]) === JSON.stringify([0, 2, 'a:A']) && C.resolve(r, TRIG);
	});
	check('and a press made later anywhere beats that repair', () =>
		C.resolve(C.mergeEntries(C.unseedEntry(seeded, SELF, 'A'), C.press({}, SELF, 1, 1000, 'B')), SELF));
	check('a seed holds a new leaf even under an older Play all, which was not about it', () => {
		const s = C.seedEntry(C.press({}, 'root', 0, 1000, 'A'), TRIG, 'A');
		return !!s && C.resolve(s, TRIG) && s[TRIG][1] === 1001 && s[TRIG][2] === 'a:A';
	});
	check('and over a person\'s older play of the leaf itself: a seed only ever holds', () => {
		const s = C.seedEntry({ [SELF]: [0, 50, 'h:A'] }, SELF, 'A');
		return !!s && C.resolve(s, SELF) && s[SELF][1] === 51;
	});
}

// ── A leaf made after Pause all ────────────────────────────────────
{
	const all = () => C.press({}, 'root', 1, 1000, 'A');
	check('a leaf created after Pause all is held', () => C.resolve(all(), 'root/chats/new'));
	check('and seeding it held writes nothing -- it is held already',
		() => C.seedEntry(all(), 'root/diamonds/new/triggers/t', 'A') === null);
	check('a single-leaf play after it plays that leaf only', () => {
		const played = C.press(all(), 'root/chats/new', 0, 2000, 'A');
		return !C.resolve(played, 'root/chats/new') && C.resolve(played, 'root/chats/x') && C.resolve(played, 'root/chats/other');
	});
	check('Play all plays every older hold', () => LEAVES.every((l) =>
		!C.resolve(C.mergeEntries(C.press(all(), 'root', 0, 3000, 'A'), { [SELF]: [1, 2000, 'h:B'] }), l)));
}

// ── Ties ────────────────────────────────────────────────────────────
{
	const a = { 'root/web': [0, 50, 'h:A'] }, b = { 'root/web': [1, 50, 'h:B'] };
	check('equal stamps, one held and one played: held, whichever side merges',
		() => C.resolve(C.mergeEntries(a, b), 'root/web') && C.resolve(C.mergeEntries(b, a), 'root/web'));
	const c = { 'root/web': [1, 50, 'h:B'] }, d = { 'root/web': [1, 50, 'a:C'] };
	check('equal stamps and state: a person\'s entry over the app\'s, so a repair cannot take it for a seed', () =>
		bytes(C.mergeEntries(c, d)) === bytes(C.mergeEntries(d, c)) && C.mergeEntries(c, d)['root/web'][2] === 'h:B'
		&& C.unseedEntry(C.mergeEntries(d, c), 'root/web', 'A') === null);
	const e = { 'root/web': [1, 50, 'h:B'] }, f = { 'root/web': [1, 50, 'h:A'] };
	check('then the smaller origin, to the byte, whichever side merges',
		() => bytes(C.mergeEntries(e, f)) === bytes(C.mergeEntries(f, e)) && C.mergeEntries(e, f)['root/web'][2] === 'h:A');
	check('an ancestor and a leaf at the same stamp resolve held', () =>
		C.resolve({ root: [0, 9, 'h:A'], 'root/web': [1, 9, 'h:B'] }, 'root/web')
		&& C.resolve({ root: [1, 9, 'h:A'], 'root/web': [0, 9, 'h:B'] }, 'root/web'));
}

// ── Forget: a tombstone, and its pruning ──────────────────────────────
{
	const now = 1_800_000_000_000;
	const both = { [SELF]: [1, 1, 'a:A'], [TRIG]: [1, 1, 'a:A'], 'root/web': [1, 3, 'h:A'] };
	const gone = () => C.forgetEntries(both, OPT, 'A', now);
	check('forgetting an object the app alone wrote leaves one tombstone at it', () => {
		const g = gone();
		return JSON.stringify(g[OPT]) === JSON.stringify([0, 2, 'a:A', now]) && !g[SELF] && !g[TRIG] && !!g['root/web'];
	});
	check('a peer\'s older app hold under it merges back in and still plays',
		() => !C.resolve(C.mergeEntries(gone(), { [TRIG]: [1, 1, 'a:B'] }), TRIG));
	check('forgetting again is a no-op', () => C.forgetEntries(gone(), OPT, 'A', now + 5) === null);
	check('where a person wrote any of it, their entry stays and only the app\'s go', () => {
		const kept = C.forgetEntries({ [SELF]: [1, 900, 'h:B'], [TRIG]: [1, 1, 'a:A'] }, OPT, 'A', now);
		return !!kept[SELF] && !kept[TRIG] && !kept[OPT];
	});
	check('and under a person\'s hold above it, no tombstone plays what they held', () => {
		const kept = C.forgetEntries({ root: [1, 5, 'h:B'], [SELF]: [1, 9, 'a:A'] }, OPT, 'A', now);
		return !kept[OPT] && !kept[SELF] && C.resolve(kept, TRIG);
	});
	const late = (g, dt) => C.mergeEntries(g, { 'root/web': [1, now + dt, 'h:A'] });
	check('a tombstone travels thirty days past the newest time in the record, then is pruned', () =>
		C.prune(late(gone(), C.consts.TOMB_MS)) === null
		&& !(OPT in C.prune(late(gone(), C.consts.TOMB_MS + 1))));
	check('measured on the record, not the clock: two devices holding one record prune alike', () =>
		C.prune(gone()) === null && bytes(C.prune(late(gone(), C.consts.TOMB_MS + 1)))
		=== bytes(C.prune(C.mergeEntries(late(gone(), C.consts.TOMB_MS + 1), {}))));
	check('and pruning leaves every other entry alone',
		() => !!C.prune(late(gone(), C.consts.TOMB_MS + 1))['root/web']);
}

// ── Old builds, both ways ─────────────────────────────────────────────
{
	const S = 1_800_000_000_000;
	check('an old record converts: each id held at its stamp, as the app\'s, and nothing played is invented', () =>
		bytes(C.adoptLegacy({}, { paused: [SELF, TRIG], stamp: S }))
		=== bytes({ [SELF]: [1, S, 'a:legacy'], [TRIG]: [1, S, 'a:legacy'] }));
	// A v2 state with a person's Pause all, a person's play under it, and a seed.
	const E = () => C.mergeEntries(C.press(C.press({}, 'root', 1, S + 10, 'A'), 'root/chats/y', 0, S + 20, 'A'),
		{ 'root/diamonds/other/triggers/t': [1, 1, 'a:B'] });
	check('the v2 record carries the old fields: held leaves, and a stamp no lower than any entry', () => {
		const rec = C.toRecord(E(), 7, TREE);
		return rec.v === 2 && rec.paused.includes(SELF) && rec.paused.includes('root/chats/x')
			&& !rec.paused.includes('root/chats/y') && rec.stamp === S + 20;
	});
	check('and never a branch id, which an old build could never take back out', () => {
		const rec = C.toRecord(E(), 7, TREE);
		return !rec.paused.includes('root') && !rec.paused.includes(OPT) && !rec.paused.includes('root/diamonds');
	});
	check('not even with no tree to say which ids are branches', () => {
		const rec = C.toRecord(C.mergeEntries(C.press({}, 'root', 1, 5, 'A'), C.press({}, OPT, 1, 6, 'A')), 0, null);
		return rec.paused.length === 0;
	});
	check('an old build\'s echo of a v2 record changes nothing, to the byte', () => {
		const rec = C.toRecord(E(), 7, TREE);
		return bytes(C.adoptLegacy(E(), { paused: rec.paused.slice(), stamp: rec.stamp })) === bytes(E());
	});
	check('an old record cannot undo a person\'s hold: the Pause all stands',
		() => heldAll(C.adoptLegacy(E(), { paused: [], stamp: S + 99 }), LEAVES.filter((l) => l !== 'root/chats/y')));
	check('but it can play what the app held', () => {
		const m = C.adoptLegacy({ [TRIG]: [1, 1, 'a:B'], 'root/web': [1, S, 'h:A'] }, { paused: ['root/web'], stamp: S + 99 });
		return !C.resolve(m, TRIG) && C.resolve(m, 'root/web');
	});
	check('except under a person\'s hold above it, however late the old record', () => {
		const m = { root: [1, S, 'h:A'], [SELF]: [1, S + 5, 'a:legacy'] };
		return C.resolve(C.adoptLegacy(m, { paused: [], stamp: S + 99 }), SELF);
	});
	check('and its later pause of what a person played earlier holds it', () =>
		C.resolve(C.adoptLegacy(C.press({}, 'root/chats/x', 0, S, 'A'), { paused: ['root/chats/x'], stamp: S + 1 }), 'root/chats/x'));
	check('an old view older than the latest word on the path adds nothing', () => {
		const m = C.press({}, 'root', 0, S + 50, 'A');
		return bytes(C.adoptLegacy(m, { paused: ['root/chats/x'], stamp: S })) === bytes(m);
	});
	check('an old record adopted twice is the same as once', () => {
		const conv = C.adoptLegacy({}, { paused: [SELF, TRIG], stamp: S });
		return bytes(C.adoptLegacy(conv, { paused: [SELF, TRIG], stamp: S })) === bytes(conv);
	});
}

// ── Stable bytes ──────────────────────────────────────────────────────
{
	const E = () => C.mergeEntries(C.press({}, 'root', 1, 99, 'A'), { [TRIG]: [1, 1, 'a:A'] });
	check('two records of the same state are the same bytes', () => JSON.stringify(C.toRecord(E(), 4, TREE))
		=== JSON.stringify(C.toRecord(C.mergeEntries({}, E()), 4, TREE)));
	check('whichever order two devices merged in', () =>
		JSON.stringify(C.toRecord(C.mergeEntries(E(), { 'root/web': [0, 3, 'h:B'] }), 4, TREE))
		=== JSON.stringify(C.toRecord(C.mergeEntries({ 'root/web': [0, 3, 'h:B'] }, E()), 4, TREE)));
}

// ── The shell: pause.js as a page runs it ─────────────────────────────
//
// Public API only, so an older pause.js answers the same questions.

console.log('the shell');

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

/// One device (or one tab, given another's storage): pause.js over its own
/// storage, with a device id and a clock of its own.
function device(dev, ls, clock) {
	ls = ls || storage();
	const win = load(ls, dev, clock);
	const P = win.DaimondPause;
	P.setTree(() => TREE);
	return { P, ls, win, storage: (key) => (win.on.storage || []).forEach((fn) => fn({ key })) };
}
const entry = (P, id) => (P.entry ? P.entry(id) : null) || [];
const held = (P, ids) => ids.every((id) => P.isPaused(id));

{
	// Two devices; B has not pulled A's Pause all when it pauses one chat, five
	// seconds later.
	const T = 1_800_000_000_000;
	const A = device('aaaa', null, () => T), B = device('bbbb', null, () => T + 5000);
	A.P.set('root', false);
	B.P.set('root/chats/x', false);
	B.P.adopt(A.P.snapshot());
	A.P.adopt(B.P.snapshot());
	check('shell M1: after both have synced, Pause all holds on both',
		() => A.P.heldByHand('root') && B.P.heldByHand('root') && held(A.P, LEAVES) && held(B.P, LEAVES));
	check('shell M2: and a chat made later, on either, is held',
		() => A.P.isPaused('root/chats/later') && B.P.isPaused('root/chats/later'));
	check('the press is recorded as the person\'s, from the device it was made on',
		() => entry(A.P, 'root')[2] === 'h:aaaa' && entry(B.P, 'root')[2] === 'h:aaaa');
	const s1 = JSON.stringify(A.P.snapshot());
	check('two snapshots of unchanged state are identical', () => s1 === JSON.stringify(A.P.snapshot()));
	check('and adopting what it already holds moves nothing',
		() => A.P.adopt(JSON.parse(s1)) === false && B.P.adopt(A.P.snapshot()) === false);
	check('a press that changes nothing writes nothing',
		() => A.P.set('root/chats/y', false) === false && JSON.stringify(A.P.snapshot()) === s1);
}

{
	// The runner of a hand-off holds Pause all; a sender pressed one leaf since.
	let t = 1_800_000_000_000;
	const R = device('runner', null, () => t), S = device('sender', null, () => (t += 5000));
	R.P.set('root', false);
	S.P.set('root/web', false);			// before it heard of the Pause all
	R.P.adopt(S.P.snapshot());			// `pauseHold` adopts the errand's snapshot
	check('runner: an errand from a sender who pressed since cannot lift the runner\'s Pause all',
		() => R.P.heldByHand('root') && R.P.isPaused('root/chats/x'));
	check('runner: it keeps its root hold afterwards', () => entry(R.P, 'root')[0] === 1);
	S.P.adopt(R.P.snapshot());
	S.P.set('root/chats/y', true);		// once it has, a person plays one chat there
	R.P.adopt(S.P.snapshot());
	check('runner: a person\'s later play of one chat does arrive, and only that chat',
		() => !R.P.isPaused('root/chats/y') && R.P.isPaused('root/chats/x') && R.P.heldByHand('root/mail'));
}

{
	// Skew: A's clock runs an hour behind B's. B pressed last, so the record's stamp
	// is ahead of A's clock; A pulls it and pauses one chat; B, not yet pulled, makes
	// two writes of its own (two actions seeded); they sync.
	const T = 1_800_000_000_000;
	const A = device('aaaa', null, () => T - 3_600_000), B = device('bbbb', null, () => T);
	B.P.set('root/web', false);				// B's clock-stamped press is the latest word
	A.P.adopt(B.P.snapshot());
	A.P.set('root/chats/y', false);			// the person's pause, on the slow clock
	B.P.seedPaused(TRIG);
	B.P.seedPaused(OPT + '/triggers/activity-2');
	B.P.adopt(A.P.snapshot());
	A.P.adopt(B.P.snapshot());
	check('skew: a pause pressed on a slow clock holds through app writes made elsewhere',
		() => A.P.isPaused('root/chats/y') && B.P.isPaused('root/chats/y'));
}

{
	// X2: two tabs of one device. Tab 1 loaded before tab 2 pressed pause on the
	// Optimiser's conversation, then its repair runs.
	const ls = storage();
	const t1 = device('dddd', ls), t2 = device('dddd', ls);
	t1.P.seedPaused(TRIG);
	const from = ls.writes.length;
	t2.P.set(SELF, false);
	for (const k of ls.writes.slice(from)) t1.storage(k);
	t1.P.unseed(SELF);
	for (const k of ls.writes.slice(from)) t2.storage(k);
	check('X2: the repair in one tab leaves a pause pressed in another', () => t1.P.isPaused(SELF) && t2.P.isPaused(SELF));
}

{
	// FC and Q6-1: a pause of the Optimiser made on device A -- its light, the
	// Diamonds branch, or its conversation alone -- reaches device C, whose repair
	// then runs.
	for (const [what, node] of [['its light', OPT], ['the Diamonds branch', 'root/diamonds'], ['its conversation', SELF]]) {
		const A = device('aaaa'), Cd = device('cccc');
		A.P.seedPaused(TRIG);
		A.P.set(node, false);
		Cd.P.adopt(A.P.snapshot());
		Cd.P.unseed(SELF);
		A.P.adopt(Cd.P.snapshot());
		check('Q6-1: a pause of the Optimiser by ' + what + ' on another device outlives the repair, on both',
			() => Cd.P.isPaused(SELF) && A.P.isPaused(SELF) && A.P.heldByHand(node));
	}
}

{
	// A seed taken back by the repair, where it is the app's.
	const D = device('dddd');
	D.P.seedPaused(SELF);
	check('the repair still takes back the app\'s own seed', () => D.P.unseed(SELF) === true && !D.P.isPaused(SELF));
	D.P.set(SELF, false);
	check('and leaves a person\'s press after it', () => D.P.unseed(SELF) === false && D.P.isPaused(SELF));
	// FC: the seed held it, and the person pressed pause on it anyway.
	const E = device('eeee');
	E.P.seedPaused(SELF);
	E.P.set(SELF, false);
	check('FC: a pause pressed on what the seed already held is the person\'s, and the repair leaves it',
		() => E.P.unseed(SELF) === false && E.P.isPaused(SELF));
}

// ── The upgrade: what an older build left, and what it still sends ─────
{
	// The store as R3 left it: a chat a person paused, and the Optimiser's seed.
	const R3 = { paused: ['root/chats/x', TRIG], stamp: 1_790_000_000_000 };
	const ls = storage();
	ls.setItem('daimond-pause', JSON.stringify(R3));
	const D = device('dddd', ls);
	check('upgrade: a pause pressed on R3 holds after the upgrade, and nothing else is held by it',
		() => D.P.isPaused('root/chats/x') && D.P.isPaused(TRIG) && !D.P.isPaused('root/chats/y') && !D.P.isPaused(SELF));
	check('upgrade: and its ids carry over as the app\'s, at the old stamp',
		() => JSON.stringify(entry(D.P, 'root/chats/x')) === JSON.stringify([1, R3.stamp, 'a:legacy']));
	check('upgrade: the store keeps what R3 reads, beside the record, after the first write', () => {
		D.P.set('root/web', false);
		const st = JSON.parse(ls.getItem('daimond-pause'));
		return st.v === 2 && st.paused.includes('root/chats/x') && st.paused.includes('root/web')
			&& st.stamp > R3.stamp;
	});
	check('upgrade: a second device upgraded from the same R3 record agrees, to the byte', () => {
		const ls2 = storage();
		ls2.setItem('daimond-pause', JSON.stringify(R3));
		const E = device('eeee', ls2);
		const F = device('ffff', (() => { const l = storage(); l.setItem('daimond-pause', JSON.stringify(R3)); return l; })());
		E.P.adopt(F.P.snapshot());
		return JSON.stringify(E.P.snapshot()) === JSON.stringify(F.P.snapshot());
	});
	check('upgrade: an R3 device\'s later record, still holding the chat, keeps it held', () => {
		const E = device('eeee', (() => { const l = storage(); l.setItem('daimond-pause', JSON.stringify(R3)); return l; })());
		E.P.adopt({ paused: ['root/chats/x', 'root/chats/y', TRIG], stamp: R3.stamp + 60_000 });
		return E.P.isPaused('root/chats/x') && E.P.isPaused('root/chats/y');
	});
	check('upgrade: an R3 device\'s play of the chat, pressed after, still plays it here', () => {
		const E = device('eeee', (() => { const l = storage(); l.setItem('daimond-pause', JSON.stringify(R3)); return l; })());
		E.P.adopt({ paused: [TRIG], stamp: R3.stamp + 60_000 });
		return !E.P.isPaused('root/chats/x') && E.P.isPaused(TRIG);
	});
}

console.log(`\npause: ${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
