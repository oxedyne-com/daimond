/* ============================================================
   Test -- a merge's create is written or the version is not adopted
   (lane CRF, 2026-09-28; specs/daimond_release_r522_20260927.md, ## LOSTW2 and ## CRF).

   THE BUG. `applyFiles` (www/js/daimond.js) wrote a path it does not hold -- new there, or made
   again there after a delete -- with no read first, and passed over a refusal. The file tools'
   stale-read guard remembers the app's own earlier sync write of the path; a delete carried out
   by another app (a second tab, a daimon's chat, or anything outside Daimond) leaves that memory
   standing, and since RD2 the guard refuses a write to a missing file it remembers ("was deleted
   since you read it"). The create was refused, the version adopted as merged, and the device's
   next push took the file off the account's head (soak seed 023424a4, `soak/log.md`).

   THE FIX. `writeSyncFile(..., null, plan)` means "nothing here": the app reads the path first
   (a read that finds nothing clears the view), the disk must still hold nothing, then it writes.
   Every write the merge decides on -- the create, a conflict copy, the `.synced` copy -- goes
   into `unwritten` when it does not land, so the version is not adopted around it.

   `applyFiles` and `writeSyncFile` are lifted out of daimond.js by source (`dev/syncprobe.mjs`
   `sliceDaimond`); the app is a stand-in whose `file_write` refuses as the engine's guard does
   (`src/tools.rs` `stale_write`), and whose single-path `file_read` fetches a small file held
   only in cloud storage, as the engine's does. `node www/js/createrefused.test.mjs`
   ============================================================ */

import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
const J = (x) => JSON.stringify(x);

// The hash the merge keys files by, from daimond.js itself.
const H = sliceDaimond(makeWindow({}), ['fileHash'], {}).fns.fileHash;

/// The page's tools app, as far as the merge meets it. `seen` is the stale-read guard's view
/// (path -> hash of what this app last read or wrote); `cloud` the paths held only in cloud
/// storage; `fail` the paths whose write the storage refuses whatever is read first.
function toolsApp(disk, { seen = {}, cloud = {}, fail = [] } = {}) {
	const view = new Map(Object.entries(seen));
	const calls = [];
	const cloudOnly = (p) => Object.prototype.hasOwnProperty.call(cloud, p) && !disk.has(p);
	const read = (p, single) => {
		// The single form fetches a small cloud-only file before it reads (`src/tools.rs` ~18157).
		if (single && cloudOnly(p)) disk.set(p, cloud[p]);
		if (disk.has(p)) view.set(p, H(disk.get(p)));
		else if (!cloudOnly(p)) view.delete(p);			// RD2: a read that finds nothing
	};
	return {
		view, calls,
		run_tool_outcome: async (name, argsJson) => {
			const a = JSON.parse(argsJson);
			calls.push(name + ':' + (a.path || (a.paths || []).join(',')));
			if (name === 'dir_create') return { outcome: 'done', text: '' };
			if (name === 'file_read') {
				if (Array.isArray(a.paths)) a.paths.forEach((p) => read(p, false));
				else read(a.path, true);
				return { outcome: 'done', text: '' };
			}
			if (name === 'file_write') {
				const p = a.path;
				if (fail.includes(p)) return { outcome: 'failed', text: 'Error: file_write: QuotaExceededError' };
				// `stale_write`: remembered, and the disk no longer holds what was remembered. A
				// cloud-only file has nothing here to compare and is not asked (`before_bytes`).
				if (view.has(p) && !cloudOnly(p)) {
					const now = disk.has(p) ? H(disk.get(p)) : null;
					if (now !== view.get(p)) {
						return { outcome: 'failed', text: "Error: file_write: '" + p + "' "
							+ (now === null ? 'was deleted since you read it' : 'changed on disk since you read it') };
					}
				}
				disk.set(p, a.content); view.set(p, H(a.content));
				return { outcome: 'done', text: '' };
			}
			throw new Error('unexpected tool ' + name);
		},
	};
}

/// One pull's file merge. `disk` what this device holds (the census is all of it, inline);
/// `base` the fork point by content; `remote` the parcel's files; `appear` a file that lands on
/// the disk between the merge's census and its write (another app, or the person).
async function merge({ disk: d0 = {}, base = {}, remote, folder = false, seen, cloud, fail, appear, store }) {
	const w = makeWindow({});
	// `store` is cloud.js `fileStore`'s word: `{ now, asked }`, the state as last seen and what asking says.
	const joined = [];
	if (store) w.DaimondCloud = { joinTombs: (t) => joined.push(t), fileStore: () => ({ state: store.now, why: '' }),
		storeWord: async () => store.asked };
	const disk = new Map(Object.entries(d0));
	const app = toolsApp(disk, { seen, cloud, fail });
	const plan = { folder, roots: [''], flagged: [''], app, loc: folder ? 'folder:f:' : 'browser' };
	const committed = [];
	const asked = {};
	const stub = {
		syncWalkPlan:      async () => plan,
		collectFiles:      async () => ({ files: Object.fromEntries(disk), plan }),
		syncFileLoc:       () => plan.loc,
		readFilebaseAt:    () => Object.assign({}, base),
		fileRecord:        () => null,						// no deletion recorded here
		textIs:            async () => false,
		honourFileRecords: async () => ({}),
		syncFilesBudget:   async () => 1 << 20,
		withoutAppState:   (m) => m,
		syncAppState:      () => false,
		withinShare:       () => true,
		deleteSyncFile:    async () => true,
		conflictName:      (p) => p + '.conflict',
		placeHeldCopy:     async () => 'theirs',
		syncFileAt:        async (pl, p) => {
			asked[p] = (asked[p] || 0) + 1;
			if (appear && appear.path === p && asked[p] === 2 && !disk.has(p)) disk.set(p, appear.text);
			if (!disk.has(p)) return null;
			const text = disk.get(p);
			return { size: text.length, text: async () => text };
		},
		heldLoc:           () => false,
		storageAlarm:      () => {},
		storageAlarmClear: () => {},
		tOr:               (k, f) => f,
		commitAgreedFiles: (agreed) => { committed.push(Object.keys(agreed).sort()); },
		_lastConflicts:    [],
	};
	const { fns } = sliceDaimond(w, ['applyFiles'], stub);
	let threw = null;
	try { await fns.applyFiles(remote, true, {}, 'phone', {}, true, {}); }
	catch (e) { threw = String(e && e.message || e); }
	return { threw, disk: Object.fromEntries(disk), agreed: committed[0] || [], calls: app.calls, committed, joined };
}

console.log('createrefused: a merge\'s create is written, or the version is not adopted\n');

// ── LOSTW2's shape: the app remembers its own sync write; another app deleted the file; the other
//    device made it again. ──
{
	const r = await merge({ seen: { 'soak/log.md': H('the first log\n') },
		remote: { 'soak/log.md': 'made again on the other device\n' } });
	check('a file made again elsewhere after a delete here arrives, whatever the guard remembers',
		r.disk['soak/log.md'] === 'made again on the other device\n', J(r));
	check('and the version merges: nothing fails, and the path is agreed',
		r.threw === null && r.agreed.includes('soak/log.md'), J({ threw: r.threw, agreed: r.agreed }));
}
// ── CRF2 (1): a browser that keeps no files takes no part in the files merge (`## SAFEDX`). Every
//    write there is refused, so a merge that ran failed every round and held the whole push. ──
for (const st of [{ now: 'none', asked: 'none' }, { now: 'refused', asked: 'refused' }, { now: '', asked: 'none' }]) {
	const r = await merge({ remote: { 'DAIMOND.md': 'the desktop\'s\n', 'notes/small.txt': 'small\n' },
		fail: ['DAIMOND.md', 'notes/small.txt'], store: st });
	const tag = 'no file store (' + (st.now || 'unasked, then ' + st.asked) + ')';
	check(tag + ': the files merge stands down, failing nothing', r.threw === null, J(r.threw));
	check(tag + ': and writes nothing, agrees nothing', !r.calls.some((c) => /^file_write/.test(c)) && !r.committed.length,
		J({ calls: r.calls, committed: r.committed }));
	check(tag + ': the deletion records still relay', r.joined.length === 1, J(r.joined));
}
// Controls: a store that is held keeps CRF's rule (a refused create holds the version back), and a
// folder's files are on the disk, so it merges whatever the browser's store says.
{
	const r = await merge({ remote: { 'n.md': 'new there\n' }, fail: ['n.md'], store: { now: 'held', asked: 'held' } });
	check('[ctl] a store that is held: a refused create still fails the section (CRF stands)', /could not write 1 file/.test(r.threw || ''), J(r.threw));
	const f = await merge({ remote: { 'n.md': 'new there\n' }, folder: true, store: { now: 'none', asked: 'none' } });
	check('[ctl] a folder with no browser store still merges', f.threw === null && f.disk['n.md'] === 'new there\n', J(f));
}
// ── A create the storage refuses: never passed over ──
{
	const r = await merge({ remote: { 'n.md': 'new there\n', 'y.md': 'also new\n' }, fail: ['n.md'] });
	check('a create that does not land fails the files section, naming the path',
		!!r.threw && /n\.md/.test(r.threw), r.threw);
	check('the rest of the pass still ran, and the fork point holds only what landed',
		r.disk['y.md'] === 'also new\n' && r.agreed.includes('y.md') && !r.agreed.includes('n.md'), J(r));
}
// ── Something made the path here between the census and the write ──
{
	const r = await merge({ remote: { 'r.md': 'theirs\n' }, appear: { path: 'r.md', text: 'made here meanwhile\n' } });
	check('a create never goes over a file that appeared here since the merge looked',
		r.disk['r.md'] === 'made here meanwhile\n', J(r.disk));
	check('and the version is held back for the next pull to place it', !!r.threw && /r\.md/.test(r.threw), r.threw);
}
// ── The sandbox's `.synced` copy: remembered, then deleted by a daimon ──
{
	const r = await merge({ disk: { 'x.md': 'mine\n' }, base: { 'x.md': H('before both\n') },
		remote: { 'x.md': 'theirs\n' }, seen: { 'x.md.synced': H('an earlier conflict\n') } });
	check('both moved: theirs is kept beside ours, whatever the guard remembers of the `.synced` slot',
		r.disk['x.md'] === 'mine\n' && r.disk['x.md.synced'] === 'theirs\n', J(r.disk));
	check('and nothing fails', r.threw === null, r.threw);
}
// ── A folder's conflict copy that does not land ──
{
	const r = await merge({ folder: true, disk: { 'x.md': 'mine\n' }, base: { 'x.md': H('before both\n') },
		remote: { 'x.md': 'theirs\n' }, fail: ['x.md.conflict'] });
	check('a copy of theirs that could not be kept beside ours holds the version back',
		!!r.threw && /x\.md/.test(r.threw) && r.disk['x.md'] === 'mine\n', J(r));
}
// ── Controls ──
{
	const r = await merge({ remote: { 'plain.md': 'new there\n' } });
	check('[ctl] an ordinary create lands and merges', r.disk['plain.md'] === 'new there\n' && r.threw === null, J(r));
}
{
	const r = await merge({ cloud: { 'c.md': 'held only in cloud storage\n' }, seen: { 'c.md': H('held only in cloud storage\n') },
		remote: { 'c.md': 'a newer copy\n' } });
	check('[ctl] a file held here only in cloud storage is not fetched back by the merge\'s read, and the write lands',
		r.disk['c.md'] === 'a newer copy\n' && r.threw === null, J(r));
}
{
	const r = await merge({ disk: { 'e.md': 'old\n' }, base: { 'e.md': H('old\n') }, remote: { 'e.md': 'edited there\n' },
		seen: { 'e.md': H('old\n') } });
	check('[ctl] an edit there over the copy both agreed on lands (REV\'s compare-and-swap)',
		r.disk['e.md'] === 'edited there\n' && r.threw === null, J(r));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
