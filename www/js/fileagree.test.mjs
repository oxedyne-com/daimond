/* ============================================================
   Test -- a deletion covers every copy its deleter had seen (fix/sync-resurrect, 2026-10-03).
   ------------------------------------------------------------
   THE BUG (the three-device soak, seed 91d4b7e6, `[resurrect]`). Device A edits soak/plan.md, the
   edit lands, A deletes the file, the deletion lands. Device G, which slept through both (or any
   device that reads the mailbox only after both), holds the older text A superseded. The record
   names the bytes A held (`h`), and `owesDeletion` carried a deletion out only on exactly those
   bytes, so G read its own unedited, agreed copy as "a write made since", kept it, wrote a return
   past the deletion and pushed it: the deleted file came back on every device at G's old text.

   THE LAW. The mailbox is one chain of versions and a push lands only on a merged head. A
   deletion record carries `at`, the version at which its deleter agreed the bytes it deleted; a
   device that agreed its copy at or before `at` holds something the deleter had merged, so the
   deletion covers it. A copy agreed AFTER `at` is news the deleter never saw, and stands (an edit
   beats a delete). A record with no `at` (an older build, a relay that dropped it) is the bytes rule.

   Drives the REAL cloud.js (the record's `at` travels through `mark`, `tombs`, `joinTombs`,
   `recordOf`) and the REAL daimond.js functions lifted by `dev/syncprobe.mjs`: `noteFileTombs`
   (the deleter writes `at`; a device that owes the deletion writes no return), `owesDeletion`,
   `commitAgreedFiles` and `commitFileBaseline`'s `noteAgreedAt`.

   Run:  node www/js/fileagree.test.mjs        (TREE=<checkout> runs it against another tree)
   ============================================================ */
import { readFileSync } from 'node:fs';
import { sliceDaimond, declLine, js } from '../../dev/syncprobe.mjs';
import { loadStore } from './storefixture.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined && detail !== '' ? '  (' + detail + ')' : '')); failures++; }
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const J = (x) => JSON.stringify(x);

const Stamp = {
	ms: (v) => { const n = Number(v); return (isFinite(n) && n > 0) ? Math.floor(n) : 0; },
	canon: (v) => JSON.stringify(v, (k, x) => (!x || typeof x !== 'object' || Array.isArray(x)) ? x
		: Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {})),
	next: (prev) => Math.max(Date.now(), Stamp.ms(prev) + 1),
	beats: (at, v, heldAt, held) => { const a = Stamp.ms(at), b = Stamp.ms(heldAt); return a !== b ? a > b : Stamp.canon(v) > Stamp.canon(held); },
};

/// One device: the real cloud.js, and the real daimond.js file-record functions over its storage.
async function device() {
	const kv = new Map();
	const Durable = {
		ready: async () => {}, durable: () => true, migrate: async () => true,
		get: async (k) => clone(kv.has(k) ? kv.get(k) : null),
		set: async (k, v) => { kv.set(k, clone(v)); return true; },
		update: async (k, fn) => { const v = fn(clone(kv.has(k) ? kv.get(k) : null)); kv.set(k, clone(v)); return { ok: true, value: v }; },
	};
	class Channel { constructor() { this.onmessage = null; } postMessage() {} close() {} }
	const box = new Map();
	const ls = { getItem: (k) => (box.has(k) ? box.get(k) : null), setItem: (k, v) => box.set(k, String(v)), removeItem: (k) => box.delete(k) };
	const win = { addEventListener: () => {}, dispatchEvent: () => true, DaimondDurable: Durable, DaimondStamp: Stamp, localStorage: ls, BroadcastChannel: Channel };
	loadStore(win, ls);
	const body = readFileSync(js('cloud.js'), 'utf8');		// the tree under test (TREE)
	new Function('window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'CustomEvent', 'BroadcastChannel',
		'with (window) {\n' + body + '\n}')(win, ls, { storage: {} }, setTimeout, clearTimeout,
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} }, class {}, Channel);
	await win.DaimondCloud.ready();
	const plan = { folder: false, roots: [''], app: {} };
	// `readAgreedAt` is absent from a tree before the fix, so the red can be run against it.
	const names = ['noteFileTombs', 'owesDeletion', 'commitAgreedFiles', 'readFilebaseAt', 'readAgreedAt', 'readMine', 'fileHash'].filter((n) => declLine(n));
	const { fns } = sliceDaimond(win, names, {
		syncFileLoc: () => 'browser', syncFileAt: async () => null, withinShare: () => true,
		writeOldFileTombs: () => {}, ChatStore: { putTombs: () => Promise.resolve(true), dropTombs: () => {} },
		storageAlarm: () => {}, tOr: (k, f) => f,
	});
	return {
		C: win.DaimondCloud, fns, box,
		/// This device and the account hold `files` agreed at mailbox version `at`.
		agree(files, at) {
			const h = {}; Object.keys(files).forEach((p) => { h[p] = fns.fileHash(files[p]); });
			fns.commitAgreedFiles(h, {}, 'browser', at);
		},
		/// The census this device collects holding `files`: a deleted file is simply absent.
		seen: () => (fns.readAgreedAt ? fns.readAgreedAt('browser') : {}),
		collect: (files) => fns.noteFileTombs({ plan, files, large: {}, away: {} }, true),
		/// Does this device owe the record `rec` for its copy of `path`?
		owes: (path, text, rec) => fns.owesDeletion(path, text, rec, fns.readFilebaseAt('browser'), fns.readMine()['browser'] || {}, fns.readAgreedAt ? fns.readAgreedAt('browser') : {}),
	};
}

const P = 'soak/plan.md';
const X = '# plan\n\nwritten by G at step 46\nline\n', H = '# plan\n\nwritten by A at step 147\nline\n', Y = '# plan\n\nedited by G afterwards\n';

console.log('fileagree: a deletion covers every copy its deleter had seen\n');

// ── The soak in miniature: A edits and deletes while G holds the older text agreed ──
{
	const A = await device(), G = await device();
	A.agree({ [P]: X }, 10); G.agree({ [P]: X }, 10);			// both agreed G's text at version 10
	A.agree({ [P]: H }, 20);									// A's edit landed at version 20
	await A.collect({});										// A deletes the file
	const rec = A.C.recordOf(P);
	check('the deleter\'s record names the bytes and the version it agreed them at', rec && rec.d === 1 && rec.h === A.fns.fileHash(H) && rec.at === 20, J(rec));
	G.C.joinTombs(A.C.tombs());									// the record reaches G, which never saw the edit
	const gr = G.C.recordOf(P);
	check('the version travels through the relay unchanged', gr && gr.at === 20 && gr.s === rec.s, J(gr));
	check('G owes the deletion of its older agreed copy', await G.owes(P, X, gr));
	await G.collect({ [P]: X });
	const after = G.C.recordOf(P);
	check('and writes no return over the deletion (the file does not come back)', after && after.d === 1, J(after));
}

// ── A copy agreed after the deleter's version is news it never saw ──
{
	const A = await device(), G = await device();
	A.agree({ [P]: H }, 20);
	G.agree({ [P]: Y }, 25);									// G's edit landed after A's last merge
	await A.collect({});
	G.C.joinTombs(A.C.tombs());
	const gr = G.C.recordOf(P);
	check('[ctl] a copy agreed after the deleter\'s version is not owed (an edit beats a delete)', !(await G.owes(P, Y, gr)));
	await G.collect({ [P]: Y });
	const after = G.C.recordOf(P);
	check('[ctl] and is returned, as before', after && after.d === 0, J(after));
}

// ── The version is not enough alone: an edit made here since the agreement stands ──
{
	const A = await device(), G = await device();
	A.agree({ [P]: H }, 20); G.agree({ [P]: X }, 10);
	await A.collect({});
	G.C.joinTombs(A.C.tombs());
	check('[ctl] a copy changed here since it was agreed is not owed', !(await G.owes(P, Y, G.C.recordOf(P))));
}

// ── An older record (no version) keeps the bytes rule ──
{
	const G = await device();
	G.agree({ [P]: X }, 10);
	const old = { d: 1, h: G.fns.fileHash(H), s: 5000 };
	check('[ctl] a record with no version does not cover another agreed copy', !(await G.owes(P, X, old)));
	check('[ctl] and still covers exactly its own bytes', await (async () => { G.agree({ [P]: H }, 12); return G.owes(P, H, old); })());
}

// ── A copy whose agreement version is unknown is never read as old ──
{
	const G = await device();
	G.agree({ [P]: X }, 0);										// a round that learnt no version
	check('[ctl] no agreement version recorded for a round that learnt none', J(G.seen()) === '{}', J(G.seen()));
	check('[ctl] so a record\'s version covers nothing there', !(await G.owes(P, X, { d: 1, h: G.fns.fileHash(H), s: 5000, at: 99 })));
	G.agree({ [P]: X }, 10); G.agree({ [P]: Y }, 0);			// then agreed at other bytes with no version
	check('[ctl] a path agreed again at other bytes reads as unknown, not as old', !(await G.owes(P, Y, { d: 1, h: G.fns.fileHash(H), s: 5000, at: 99 })));
}

// ── A device that has just taken the build holds a fork point and no note ──
{
	const A = await device(), G = await device();
	A.agree({ [P]: X }, 10); A.agree({ [P]: H }, 20);
	await A.collect({});
	// G ran the build before this one: its fork point names X, there is no note, and sync.js kept the version it last merged.
	G.agree({ [P]: X }, 0); G.box.delete('daimond-file-agreed-at');
	G.box.set('daimond-sync-merged-at', J({ browser: 15 }));
	G.C.joinTombs(A.C.tombs());
	check('an upgraded device with no note owes the deletion of its older agreed copy', await G.owes(P, X, G.C.recordOf(P)));
	check('the note is seeded at the version the location last merged', J(G.seen()[P]) === J([G.fns.fileHash(X), 15]), J(G.seen()));
	await G.collect({ [P]: X });
	check('and the first deletion it hears writes no return over it', (G.C.recordOf(P) || {}).d === 1, J(G.C.recordOf(P)));
	// A copy the location had merged past the deleter's version is news the deleter never saw.
	const N = await device();
	N.agree({ [P]: Y }, 0); N.box.delete('daimond-file-agreed-at');
	N.box.set('daimond-sync-merged-at', J({ browser: 25 }));
	N.C.joinTombs(A.C.tombs());
	check('[ctl] a seed at a version past the deleter\'s owes nothing (an edit beats a delete)', !(await N.owes(P, Y, N.C.recordOf(P))));
	// No note and no merged version anywhere: the bytes rule, never a guess.
	const U = await device();
	U.agree({ [P]: X }, 0); U.box.delete('daimond-file-agreed-at');
	U.C.joinTombs(A.C.tombs());
	check('[ctl] with no merged version known, nothing is seeded and the bytes rule holds', !(await U.owes(P, X, U.C.recordOf(P))) && J(U.seen()) === '{}', J(U.seen()));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
