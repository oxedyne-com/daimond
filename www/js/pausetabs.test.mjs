/* ============================================================
   Test — two tabs of one account on one device share one pause.
   ------------------------------------------------------------
   D2 of the delta re-check of Deploy 1 (2026-09-24): pause.js read
   its two records once per page, so "Pause all" in one tab left a
   second open tab playing -- its triggers fired and its turns reached
   the provider -- and a stale tab's next save wrote back a set it had
   never loaded. Now a `storage` event from the other tab re-reads both
   records, and every change re-reads them before it writes.

   Drives the real pause.js with no browser: two windows over one
   localStorage, and the `storage` event delivered by hand, as the
   browser delivers it to every tab but the writer.

     node www/js/pausetabs.test.mjs
     node --test www/js/*.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

/// A localStorage over a plain map, shared by every tab made on it, that
/// remembers each write so it can be delivered to the other tabs as an event.
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

/// One tab: pause.js and triggers.js, fresh, over `ls`, with a window that
/// keeps its listeners so a `storage` event can be handed to it.
function tab(ls, prefix) {
	const on = {};
	const win = {
		localStorage: ls,
		addEventListener: (type, fn) => { (on[type] = on[type] || []).push(fn); },
		dispatchEvent: () => true,
	};
	if (prefix) win.DaimondAccounts = { prefix: () => prefix };
	for (const f of ['pause.js', 'triggers.js']) {
		new Function('window', 'localStorage', 'CustomEvent', readFileSync(join(HERE, f), 'utf8'))(win, ls,
			function CustomEvent(type) { this.type = type; });
	}
	const P = win.DaimondPause, T = win.DaimondTriggers;
	let heard = 0;
	P.subscribe(() => { heard++; });
	return {
		P, T,
		heard: () => heard,
		/// What the browser does in this tab when another writes `key`.
		storage: (key) => (on.storage || []).forEach((fn) => fn({ key, storageArea: ls })),
	};
}

/// Hand this tab every write the others made since `from`, in order.
function deliver(t, ls, from) {
	for (const k of ls.writes.slice(from)) t.storage(k);
}

const D = 'd1';
const act = (id, folder) => ({ id, kind: 'mail', mailbox: 'a@b.c', folder, instruction: 'summarise ' + folder });
const tree = (T, P, actions) => () => ({ id: 'root', children: [
	{ id: 'root/diamonds', children: [{ id: P.id('root', 'diamonds', D), children:
		[{ id: P.id('root', 'diamonds', D) + '/self', armed: false }].concat(actions.map((t) =>
			({ id: T.node(D, t.id), kind: 'trigger', armed: T.ready(t), terms: T.terms(t) }))) }] },
	{ id: 'root/web', armed: false },
] });

// ── Pause all in one tab holds the other ────────────────────────────
{
	const ls = storage();
	const A = tab(ls), B = tab(ls);
	const acts = A.T.normalise({ actions: [act('m1', 'INBOX'), act('m2', 'Other')] }).actions;
	A.P.setTree(tree(A.T, A.P, acts));
	B.P.setTree(tree(B.T, B.P, acts));
	A.P.set(A.T.node(D, 'm1'), true);
	let mark = ls.writes.length;
	B.P.isPaused('root/web');						// B has read the store before A's pause
	deliver(B, ls, 0);
	check('a release in one tab reaches the other', B.T.allowed(D, acts[0]) === true);

	mark = ls.writes.length;
	const heard = B.heard();
	A.P.set('root', false);							// Pause all, in tab A
	deliver(B, ls, mark);
	check('Pause all in one tab holds a released action in the other',
		B.T.allowed(D, acts[0]) === false && B.T.due(D, acts, { kind: 'mail', mailbox: 'a@b.c', folder: 'INBOX' }).length === 0);
	check('and the web, and everything a person could hold', B.P.isPaused('root/web') === true
		&& B.P.heldByHand('root') === true);
	check('and the other tab says so, so its lights and pump follow', B.heard() > heard, (B.heard() - heard) + ' announcement(s)');
	check('the pause there also ends the release given there', B.P.releasedHere(B.T.node(D, 'm1')) === '');

	mark = ls.writes.length;
	B.P.set('root/web', true);						// play on the Web leaf, in tab B
	deliver(A, ls, mark);
	check('a play in the second tab reaches the first', A.P.isPaused('root/web') === false
		&& A.P.isPaused(A.P.id('root', 'diamonds', D) + '/self') === true);

	const quiet = A.heard();
	A.storage('daimond-chats');
	A.storage('daimond-pause');						// nothing moved since A last read it
	check('a write to some other key, or one that moved nothing, is not an announcement', A.heard() === quiet);
}

// ── A stale tab writes onto the other's change, never over it ────────
//
// No event delivered: the save itself re-reads first. Both directions.
{
	const ls = storage();
	const A = tab(ls), B = tab(ls);
	const acts = A.T.normalise({ actions: [act('m1', 'INBOX'), act('m2', 'Other')] }).actions;
	A.P.setTree(tree(A.T, A.P, acts));
	B.P.setTree(tree(B.T, B.P, acts));
	A.P.isPaused('root'); B.P.isPaused('root');		// both loaded, before anything moved

	A.P.set('root/web', false);						// A pauses the web
	B.P.set(B.P.id('root', 'diamonds', D) + '/self', false);	// B, stale, pauses the Diamond
	const both = JSON.parse(ls.getItem('daimond-pause')).paused;
	check('a stale tab\'s pause keeps the other tab\'s pause', both.includes('root/web')
		&& both.includes('root/diamonds/' + D + '/self'), JSON.stringify(both));

	A.P.set('root/web', true);						// A plays the web again
	B.P.seedPaused(B.T.node(D, 'm2'));				// B, stale, seeds a hold
	const after = JSON.parse(ls.getItem('daimond-pause')).paused;
	check('and does not undo the other tab\'s play', !after.includes('root/web')
		&& after.includes(B.T.node(D, 'm2')), JSON.stringify(after));

	A.P.set(A.T.node(D, 'm1'), true);				// A releases m1 here
	B.P.set(B.T.node(D, 'm2'), true);				// B, stale, releases m2 here
	const rel = JSON.parse(ls.getItem('daimond-pause-here'));
	check('a stale tab\'s release keeps the other tab\'s release', !!rel[A.T.node(D, 'm1')] && !!rel[A.T.node(D, 'm2')],
		Object.keys(rel).join(', '));

	A.P.set(A.T.node(D, 'm1'), false);				// A pauses m1: its release ends
	B.P.set(B.T.node(D, 'm2'), false);				// B, stale, pauses m2
	const rel2 = JSON.parse(ls.getItem('daimond-pause-here') || '{}');
	check('and does not bring back a release the other tab ended', !rel2[A.T.node(D, 'm1')]
		&& !rel2[B.T.node(D, 'm2')], JSON.stringify(rel2));
	const C = tab(ls);
	C.P.setTree(tree(C.T, C.P, acts));
	check('so a third tab opened now finds both held', C.T.allowed(D, acts[0]) === false && C.T.allowed(D, acts[1]) === false);
}

// ── A stamp from a clock ahead does not freeze the other tab ─────────
//
// A record adopted from a device whose clock runs ahead carries a stamp in this
// device's future. A change made after it must still read as later, here and in
// every tab, or the other tab's re-read would keep the older set.
{
	const ls = storage();
	const A = tab(ls), B = tab(ls);
	A.P.isPaused('root'); B.P.isPaused('root');
	let mark = ls.writes.length;
	const ahead = Date.now() + 3600e3;
	A.P.adopt({ paused: ['root/web'], stamp: ahead });
	deliver(B, ls, mark);
	check('(the future stamp reached the other tab)', B.P.isPaused('root/web') === true);
	mark = ls.writes.length;
	B.P.set('root/web', true);
	deliver(A, ls, mark);
	check('a play made after it wins in the other tab', A.P.isPaused('root/web') === false
		&& A.P.snapshot().stamp > ahead, 'stamp ' + (A.P.snapshot().stamp - ahead) + ' ms past the one adopted');
}

// ── A second account's keys are namespaced ──────────────────────────
//
// accounts.js prefixes every daimond-* key of any account but the first, so the
// event another tab raises names the prefixed key. This plain map cannot prefix,
// so the record is written where the module reads it, and the event is raised
// with the key the browser would report.
{
	const ls = storage();
	const pre = 'd~0123456789abcdef~';
	const B = tab(ls, pre);
	B.P.isPaused('root');
	ls.setItem('daimond-pause', JSON.stringify({ paused: ['root/workers'], stamp: Date.now() + 5 }));
	const heard = B.heard();
	B.storage(pre + 'daimond-pause');
	check('the event for this account\'s own key is heard', B.P.isPaused('root/workers') === true
		&& B.heard() > heard);
	const quiet = B.heard();
	ls.setItem('daimond-pause', JSON.stringify({ paused: [], stamp: Date.now() + 10 }));
	B.storage('d~fedcba9876543210~daimond-pause');
	B.storage('daimond-pause');
	check('and another account\'s is not', B.P.isPaused('root/workers') === true && B.heard() === quiet);
}

console.log(`\npausetabs: ${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
