/* ============================================================
   Test -- no folder travels (UNBLOCK-82 G2f, D-20261031-11).

   A mark is focus only, so nothing grants a real folder's bytes to the account any more,
   and the page opens no machine folder (G5), so `Files.folder()` is gone:
     A1  the parcel collect path (`filesSyncable`, `syncWalkPlan`, `syncLocNow`) runs on a
         `Files` with no folder reader, plans the browser's workspace, and reaches for none;
     A2  a parcel applies through the browser plan (the only one) and calls no folder writer;
     A3  no page module reads or writes a share flag (`shareRoots`, `setShare`, `share: true`);
     A4  nothing calls the retired readers (`Files.folder()`, `folderId()`, `useRoot`,
         `sharedFolderHandle`) in the page modules, cloud.js or debugshare.js.

   `node www/js/nofoldershare.test.mjs`.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWindow } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

// `Files` is the page's own (files_view.js), so it is stubbed, not set on the window. The
// stub has no folder reader, as the real one has none, and records any reach for one.
function folderFiles(asked) {
	return new Proxy({}, { get(_, k) {
		if (typeof k === 'string' && /^(folder|folderId|shareRoots)$/.test(k)) asked.push(k);
		return undefined;
	} });
}

// A1
{
	const asked = [];
	const w = makeWindow({});
	w.DaimondTools = {};
	const P = loadPage({ window: w, stub: { Files: folderFiles(asked), tools: () => ({}) },
		want: ['filesSyncable', 'syncWalkPlan', 'syncLocNow'] });
	let plan, loc, ok;
	try { ok = P.filesSyncable(); plan = await P.syncWalkPlan(); loc = await P.syncLocNow(); }
	catch (e) { plan = 'threw: ' + e.message; }
	check('A1 files are syncable with tools up and no folder reader', ok === true);
	check('A1 the census plans the browser workspace', !!plan && plan.loc === 'browser', JSON.stringify(plan));
	check('A1 the location is the browser', loc === 'browser', String(loc));
	check('A1 no folder reader is reached for', asked.length === 0, asked.join(','));
	const w2 = makeWindow({});
	const P2 = loadPage({ window: w2, stub: { Files: folderFiles(asked), tools: () => ({}) },
		want: ['syncWalkPlan', 'syncLocNow'] });
	check('[ctl] A1 no tools: no plan, location none', (await P2.syncWalkPlan()) === null && (await P2.syncLocNow()) === 'none');
}

// A2
{
	const asked = [], writes = [], merged = [];
	const w = makeWindow({});
	w.DaimondTools = {};
	const m = { hash: 'h1', chunks: ['c1'], size: 3 };
	w.DaimondChunks = { chunkSizeFor: () => 1 << 20 };
	w.DaimondCloud = {
		index:         () => ({ 'proj/a.txt': m }),
		merge:         (inc) => { merged.push(Object.keys(inc || {})); },
		materialiseTo: async (p) => { writes.push('materialiseTo ' + p); return 'OK'; },
		fileUnderRoot: async (h, p) => { writes.push('fileUnderRoot ' + p); return null; },
		localState:    async () => ({ state: 'unknown' }),
		refreshPaths:  async () => {},
		mayDrop:       () => false,
		isContentKey:  () => false,
		forget:        () => {},
		JUDGED_ABSENT: {},
	};
	const plan = { roots: [''], app: {}, loc: 'browser' };		// what `syncWalkPlan` returns
	const P = loadPage({ window: w, stub: { Files: folderFiles(asked), syncWalkPlan: async () => plan }, want: ['applyChunked'] });
	try { await P.applyChunked({ 'proj/a.txt': m }, {}, 'dev-b', {}); }
	catch (e) { writes.push('threw ' + e.message); }
	check('A2 a parcel calls no folder writer', writes.length === 0, writes.join('; '));
	check('[ctl] A2 the parcel ran: it merged into the browser index', merged.length === 1, JSON.stringify(merged));
	check('A2 no folder reader is reached for', asked.length === 0, asked.join(','));
}

// A3
{
	const dir = path.join(HERE, 'page');
	const hits = [];
	for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
		const src = fs.readFileSync(path.join(dir, f), 'utf8');
		for (const pat of ['shareRoots', 'setShare', 'share: true', 'materialiseShared', 'walkShared', 'withinShare']) {
			if (src.indexOf(pat) >= 0) hits.push(f + ': ' + pat);
		}
	}
	check('A3 no page module reads or writes a share flag', hits.length === 0, hits.join('; '));
}

// A4
{
	const files = fs.readdirSync(path.join(HERE, 'page')).filter((n) => n.endsWith('.js')).map((n) => path.join('page', n))
		.concat(['cloud.js', 'debugshare.js']);
	const hits = [];
	for (const f of files) {
		const src = fs.readFileSync(path.join(HERE, f), 'utf8');
		for (const pat of [/\bFiles\.folder\b/, /\.folderId\(/, /\buseRoot\b/, /\bsharedFolderHandle\b/]) {
			if (pat.test(src)) hits.push(f + ': ' + pat.source);
		}
	}
	check('A4 nothing calls the retired folder readers', hits.length === 0, hits.join('; '));
}

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('all passed');
