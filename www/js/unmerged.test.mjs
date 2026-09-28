/* ============================================================
   Test -- a merge that could not write a file another device changed does not count as merged
   (lane REV2, 2026-09-27; specs/daimond_fixbrief_r522_rev_20260927.md, E2).

   THE BUG. `applyFiles` (www/js/daimond.js) answered a refused write of a newer version over the
   copy held here by moving on: the files section succeeded, the version was noted as merged in
   this location, and the next census carried the older copy as this device's own. Every other
   device took it over the newer version (QFB4-1's E2: after a Browser -> folder switch the file
   tools' stale-read guard refused the write).

   THE FIX. Such a write fails the section, after the rest of the pass, naming the path; the fork
   point is committed for what did land. A new path whose write is refused holds the version back
   too (CRF, 2026-09-28): adopted without it, this device's next push replaced the account's head
   without the file, and no device that pulled it after received it (`## LOSTW2`;
   `createrefused.test.mjs` asserts the create itself).

   `applyFiles` is lifted out of daimond.js by source (`dev/syncprobe.mjs` `sliceDaimond`), its
   storage and walk stubbed. `node www/js/unmerged.test.mjs [--break nowrite]`.
   ============================================================ */

import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i >= 0 ? process.argv[i + 1] : ''; })();
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

/// One merge: `local` the census here, `base` the fork point, `remote` the parcel's files; `refuse`
/// the paths whose write fails.
async function merge({ local, base, remote, refuse }) {
	const w = makeWindow({});
	const writes = [], committed = [];
	const plan = { folder: false, roots: [''], app: {} };
	const stub = {
		syncWalkPlan:      async () => plan,
		readFilebase:      () => Object.assign({}, base),
		collectFiles:      async () => ({ files: Object.assign({}, local), plan }),
		syncFileLoc:       () => 'browser',
		readFilebaseAt:    () => Object.assign({}, base),
		fileRecord:        () => null,						// no deletion recorded (FB4's law)
		textIs:            async () => false,
		honourFileRecords: async () => ({}),
		syncFilesBudget:   async () => 1 << 20,
		withoutAppState:   (m) => m,
		syncAppState:      () => false,
		withinShare:       () => true,
		deadCopy:          async () => false,
		deleteSyncFile:    async () => true,
		conflictName:      (p) => p + '.conflict',
		syncFileAt:        async () => null,			// nothing held here off the inline section (S13: heldsplit.test)
		heldLoc:           () => false,
		writeSyncFile:     async (app, p, text) => { writes.push(p); return !refuse.includes(p); },
		commitAgreedFiles: async (agreed, gone) => { committed.push(Object.keys(agreed).sort()); },
		_lastConflicts:    [],
	};
	const { fns } = sliceDaimond(w, ['applyFiles'], stub);
	let body = fns.applyFiles.toString();
	if (BREAK === 'nowrite') {
		// 5.2.1's pass: a refused write is passed over.
		body = body.replace('if (unwritten.length) {', 'if (false) {');
		const lifted = new Function('win', 'stubs', 'with (win) { with (stubs) { return (' + body + '); } }')(w, Object.assign({ window: w, fileHash: fnsHash }, stub));
		return run(lifted);
	}
	return run(fns.applyFiles);
	async function run(fn) {
		let threw = null;
		try { await fn(remote, true, {}, 'phone', {}); } catch (e) { threw = String(e && e.message || e); }
		return { threw, writes, committed };
	}
}
// The same hash daimond.js uses, for the --break body (the lifted one carries its own).
function fnsHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + ':' + s.length; }

console.log('unmerged: a refused write of a newer version over the copy held here holds the version back\n');
const h = fnsHash;

// ── The E2 shape: held here unchanged, changed there, the write refused ──
{
	const r = await merge({ local: { 'x.md': 'old', 'y.md': 'y0' }, base: { 'x.md': h('old'), 'y.md': h('y0') },
		remote: { 'x.md': 'edit', 'y.md': 'y1' }, refuse: ['x.md'] });
	check('a refused write over a held copy fails the files section', !!r.threw && /x\.md/.test(r.threw), r.threw);
	check('the rest of the pass still ran (y.md written)', r.writes.includes('y.md'), JSON.stringify(r.writes));
	check('the fork point is committed for what landed, and not for the refused path',
		r.committed.length === 1 && r.committed[0].includes('y.md') && !r.committed[0].includes('x.md'), JSON.stringify(r.committed));
}
// ── A landed write is merged ──
{
	const r = await merge({ local: { 'x.md': 'old' }, base: { 'x.md': h('old') }, remote: { 'x.md': 'edit' }, refuse: [] });
	check('a landed write is merged (no failure)', r.threw === null, r.threw);
}
// ── A new path refused: not written is not merged (CRF) ──
{
	const r = await merge({ local: {}, base: {}, remote: { 'n.md': 'new' }, refuse: ['n.md'] });
	check('a refused write of a path not held here holds the version back too', !!r.threw && /n\.md/.test(r.threw), r.threw);
	check('and the path is not agreed', r.committed.length === 1 && !r.committed[0].includes('n.md'), JSON.stringify(r.committed));
}
// ── Changed here: nothing is written, nothing fails ──
{
	const r = await merge({ local: { 'x.md': 'mine' }, base: { 'x.md': h('old') }, remote: { 'x.md': 'old' }, refuse: ['x.md'] });
	check('an edit made here with no news there writes nothing and merges', r.threw === null && r.writes.length === 0, JSON.stringify(r));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
