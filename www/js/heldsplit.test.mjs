/* ============================================================
   Test -- another device's inline copy of a file held here off the inline section is placed
   against the bytes held here before it is written (lane REV3b, 2026-09-27;
   specs/daimond_fixbrief_r522_rev_20260927.md, S13).

   THE BUG. A file this device carries as a manifest (past its own inline ceiling, under the
   sender's: a phone's 256 kB against a desktop's 1 MiB) is not in its census, so `applyFiles`
   met the sender's inline copy with nothing here to compare and wrote it over the bytes held
   here. A phone's unpushed edit of such a file went to a desktop's concurrent edit, silently
   (`dev/verify_inlinesplit.mjs` C2P).

   THE FIX. `placeHeldCopy`: identical is agreed; a copy the manifest here was made from is older
   and stands; ours is written over only where it is the version theirs was made from (the one
   both last agreed inline, or the one the sender's index names); anything else keeps both.

   `applyFiles` and `placeHeldCopy` are lifted out of daimond.js by source (`dev/syncprobe.mjs`
   `sliceDaimond`), storage and walk stubbed. `node www/js/heldsplit.test.mjs [--break nosplit]`.
   ============================================================ */

import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i >= 0 ? process.argv[i + 1] : ''; })();
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
// The same hash daimond.js uses (`fileHash`).
function h(s) { let x = 5381; for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0; return (x >>> 0).toString(36) + ':' + s.length; }
const fileOf = (text) => ({ size: Buffer.byteLength(text), text: async () => text });

/// One merge of `remote` (inline files) and `theirIx` (the sender's index) into a device that holds
/// `held` off its inline section (none of it in `local`), `base` its fork point, `ix` its own index;
/// `same` the paths whose bytes are the sender's manifest's content; `refuse` the writes that fail.
async function merge({ held = {}, local = {}, base = {}, remote, theirIx = {}, ix = {}, same = [], refuse = [], folder = false }) {
	const w = makeWindow({});
	w.DaimondCloud = {
		manifest: (p) => ix[p] || null,
		descends: (m, id) => !!id && Array.isArray(m.anc) && m.anc.indexOf(id) >= 0,
		localState: async (p) => ({ state: same.includes(p) ? 'same' : 'unknown' }),
	};
	const writes = [], committed = [];
	const plan = { folder, roots: [''], app: {} };
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
		ownHere:           () => false,
		withinShare:       () => true,
		deadCopy:          async () => false,
		deleteSyncFile:    async () => true,
		conflictName:      (p) => p + '.conflict',
		heldLoc:           () => false,
		syncFileAt:        BREAK === 'nosplit' ? async () => null : async (pl, p) => (held[p] != null ? fileOf(held[p]) : null),
		writeSyncFile:     async (app, p, text) => { writes.push(p + '=' + text); return !refuse.includes(p); },
		commitAgreedFiles: async (agreed) => { committed.push(Object.keys(agreed).sort()); },
		_lastConflicts:    [],
	};
	const { fns } = sliceDaimond(w, ['applyFiles'], stub);
	let threw = null;
	try { await fns.applyFiles(remote, true, {}, 'desk', {}, true, theirIx); } catch (e) { threw = String(e && e.message || e); }
	return { threw, writes, agreed: committed[0] || [] };
}

console.log('heldsplit: an inline copy of a file held here off the inline section is placed before it is written\n');
const V1 = 'v1 '.repeat(50), V2 = 'phone edit '.repeat(40), VD = 'desk edit '.repeat(40);

// ── S13: the phone's unpushed edit meets the desktop's concurrent one ──
{
	const r = await merge({ held: { 'p.md': V2 }, remote: { 'p.md': VD }, theirIx: { 'p.md': { key: 'k1', chunks: [] } } });
	check('an edit held here is not written over by another device\'s concurrent edit', !r.writes.includes('p.md=' + VD), JSON.stringify(r.writes));
	check('and theirs is kept beside it, under a name of its own (not the index\'s `.synced` slot)', r.writes.includes('p.md.conflict=' + VD), JSON.stringify(r.writes));
	check('and the path is not agreed', !r.agreed.includes('p.md') && r.threw === null, JSON.stringify(r));
}
// ── The same in a machine folder: a conflict copy ──
{
	const r = await merge({ folder: true, held: { 'p.md': V2 }, remote: { 'p.md': VD } });
	check('in a folder the disk stands and theirs lands beside it', !r.writes.includes('p.md=' + VD) && r.writes.includes('p.md.conflict=' + VD), JSON.stringify(r.writes));
}
// ── Met again on the next pull: the copy beside it is not written twice ──
{
	const r = await merge({ held: { 'p.md': V2, 'p.md.conflict': VD }, remote: { 'p.md': VD } });
	check('the same arrival met again writes nothing new', r.writes.length === 0, JSON.stringify(r.writes));
}
// ── Ours is the version both last agreed inline: theirs is taken ──
{
	const r = await merge({ held: { 'p.md': V1 }, base: { 'p.md': h(V1) }, remote: { 'p.md': VD } });
	check('bytes that are the agreed version take the other device\'s edit', r.writes.includes('p.md=' + VD) && r.agreed.includes('p.md'), JSON.stringify(r));
}
// ── Ours is the version the sender's index names: theirs is taken ──
{
	const r = await merge({ held: { 'p.md': V1 }, remote: { 'p.md': VD }, theirIx: { 'p.md': { key: 'k1', chunks: [] } }, same: ['p.md'] });
	check('bytes that are the version the sender\'s index names take its edit', r.writes.includes('p.md=' + VD), JSON.stringify(r.writes));
}
// ── Identical ──
{
	const r = await merge({ held: { 'p.md': VD }, remote: { 'p.md': VD } });
	check('an identical copy writes nothing and is agreed', r.writes.length === 0 && r.agreed.includes('p.md'), JSON.stringify(r));
}
// ── Theirs is an older inline version the manifest here was made from (a 5.2.1 desktop's stale copy) ──
{
	const r = await merge({ held: { 'p.md': V2 }, remote: { 'p.md': V1 }, ix: { 'p.md': { key: 'k2', anc: ['i:' + h(V1)] } } });
	check('a copy the manifest here was made from is older: nothing is written, nothing kept beside', r.writes.length === 0 && r.threw === null, JSON.stringify(r));
}
// ── Ours unchanged, the write refused: the version is held back (E2's rule, now for a held path) ──
{
	const r = await merge({ held: { 'p.md': V1 }, base: { 'p.md': h(V1) }, remote: { 'p.md': VD }, refuse: ['p.md'] });
	check('a refused write over a held copy fails the files section', !!r.threw && /p\.md/.test(r.threw), r.threw);
}
// ── Not held here: adopted as before ──
{
	const r = await merge({ remote: { 'n.md': VD } });
	check('a path not held here is written as before', r.writes.includes('n.md=' + VD) && r.agreed.includes('n.md'), JSON.stringify(r));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
