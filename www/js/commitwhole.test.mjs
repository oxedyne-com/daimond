/* ============================================================
   Test — a device commits a chunk index only once it holds the account's
   whole index at the version it commits at (lane CMG, 2026-09-27).
   ------------------------------------------------------------
   Drives the REAL www/js/cloud.js (the mark, kept beside the index) and
   the REAL commit gate lifted out of daimond.js by source: `indexWhole`,
   `syncIndexAt`, `syncIndexOwed`, `mayCommitChunks`, `offloadBlockedReason`.

   THE FAULT (2026-09-13): a folder-mounted desktop that had only merged
   its shares out of the phone's index lost its handle, became a
   committer, and declared its own view at the current version. The
   browser-level proof is dev/verify_commitmerged.mjs; this pins the rule.

   Run:   node www/js/commitwhole.test.mjs
          node www/js/commitwhole.test.mjs --break anyparcel
              (any whole merge of the current version makes the index whole,
               as the first design had it: the device's OWN folder-era parcel
               then vouches for it, and section 3 goes red)
          node www/js/commitwhole.test.mjs --break clearonswitch
              (the mark is cleared on a location switch: section 5, a lone
               device, never commits again)
          node www/js/commitwhole.test.mjs --break nofrom
              (a parcel's chunkedFrom is ignored, as 121c7b0b had it: section
               8, a phone that slept through a folder device's own pushes,
               never commits again -- lane CMG2)
          node www/js/commitwhole.test.mjs --break fromanyway
              (any skipped version is forgiven: section 8's third device and
               section 2's skip go red)
          node www/js/commitwhole.test.mjs --break nohistory
              (a folder Forget left behind does not count: section 9 goes red
               -- QCMG's W)
          node www/js/commitwhole.test.mjs --break notransition
              (no re-seed on an old page's parcel: section 10, the upgrade
               window, never commits again -- QCMG's G3)
          node www/js/commitwhole.test.mjs --break noold
              (a parcel's chunkedOld is ignored: section 11, the upgrade
               crossed while asleep, never commits again -- QCMG2's G4)
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}
const KNOWN = ['anyparcel', 'clearonswitch', 'nofrom', 'fromanyway', 'nohistory', 'notransition', 'noold', 'noupgrade'];
const BREAK = (() => { const i = process.argv.indexOf('--break'); return i >= 0 ? (process.argv[i + 1] || '') : ''; })();
if (BREAK && !KNOWN.includes(BREAK)) { console.error('unknown break ' + BREAK + '; known: ' + KNOWN.join(', ')); process.exit(2); }

function makeStorage() {
	const store = new Map();
	return { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k), store };
}

/// One tab: the real cloud.js in the box path (no IndexedDB), over `ls`.
function makeCloud(win, ls) {
	const body = readFileSync(join(HERE, 'cloud.js'), 'utf8');
	loadStore(win, ls);
	new Function('window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'console',
		'with (window) {\n' + body + '\n}')(win, ls, { storage: {} }, setTimeout, clearTimeout,
		{ log() {}, debug() {}, warn() {}, error() {} });
	return win.DaimondCloud;
}

/// Lift a tab-indented top-level function (or block) out of daimond.js by its first line.
function lift(src, first, endMark) {
	const start = src.indexOf(first);
	if (start < 0) throw new Error('not found in daimond.js: ' + first);
	const end = src.indexOf(endMark, start);
	if (end < 0) throw new Error('end not found for: ' + first);
	return src.slice(start, end + endMark.length);
}
function loadGate(win, env) {
	const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
	let text = lift(src, '\tfunction mayCommitChunks() {', '\n\t}\n')
		+ lift(src, '\tfunction offloadBlockedReason() {', '\n\t}\n')
		+ lift(src, '\tfunction indexWhole() {', '\n\t}\n')
		+ lift(src, '\tvar _chunkedWhole = false;', ';\n')
		+ lift(src, '\tvar _oldHeadAt = -1;', ';\n')
		+ lift(src, '\tfunction syncIndexAt(v, how, state) {', '\n\t}\n')
		+ lift(src, '\tasync function syncIndexOwed(known) {', '\n\t}\n')
		+ lift(src, '\tasync function syncFolderBehind() {', '\n\t}\n')
		+ lift(src, '\tfunction syncFolderHistory() {', '\n\t}\n')
		+ lift(src, '\tfunction readJson(key, fallback) {', '\n\t}\n')
		+ lift(src, '\tvar SYNC_FILEBASE_LOC_KEY', ';\n')
		+ lift(src, '\tvar SYNC_FILEBASE_STASH_KEY', ';\n')
		+ lift(src, '\tvar SYNC_FOLDER_SEEN_KEY', ';\n')
		+ lift(src, '\tvar SYNC_FOLDER_EVER_KEY', ';\n')
		+ lift(src, '\tvar SYNC_FILEBASE_LOCS_KEY', ';\n');
	const breaks = {
		anyparcel:  ["if (full || (was >= 0 && was >= Math.min(from, v - 1))) DaimondCloud.noteWhole(v);",
			'DaimondCloud.noteWhole(v);	// BROKEN: any whole merge of the current version'],
		nofrom:     ["var from = (state && typeof state.chunkedFrom === 'number' && state.chunkedFrom >= 0) ? state.chunkedFrom : v - 1;",
			'var from = v - 1;	// BROKEN: chunkedFrom ignored'],
		fromanyway: ['was >= Math.min(from, v - 1)', 'true	/* BROKEN: any skip forgiven */'],
		nohistory:  ['return folder || syncFolderHistory();', 'return folder;	// BROKEN: Forget forgets the history'],
		notransition: ['var oldHead = _oldHeadAt >= 0 && _oldHeadAt === v;', 'var oldHead = false;	// BROKEN: no transition rule'],
		noold:      ["typeof state.chunkedOld === 'number'", 'false	/* BROKEN: chunkedOld ignored */'],
		noupgrade:  ["var upgraded = up > 0 && !(typeof at === 'number' && at >= up);", 'var upgraded = false;	// BROKEN: a mark outlives the rollback'],
	};
	if (breaks[BREAK]) {
		const [needle, broken] = breaks[BREAK];
		if (!text.includes(needle)) throw new Error('break target not found: ' + BREAK);
		text = text.replace(needle, broken);
	}
	return new Function('window', 'env',
		'var Files = env.Files, FsaDB = env.FsaDB, localStorage = env.ls;\n'
		+ 'function filesSyncable() { return env.syncable(); }\n'
		+ 'function offloadAllowed() { return !!window.DaimondCloud && filesSyncable(); }\n'
		+ 'with (window) {\n' + text + '\n'
		+ 'return { mayCommitChunks, offloadBlockedReason, indexWhole, syncIndexAt, syncIndexOwed,\n'
		+ '\tsetWhole: function (b) { _chunkedWhole = b; } };\n}')(win, env);
}

/// A device: the real cloud.js and gate, a mailbox cursor, and a switch between the sandbox and a folder.
function device(opts = {}) {
	const ls = opts.ls || makeStorage();
	const win = { addEventListener() {}, dispatchEvent() { return true; } };
	win.window = win;
	const cloud = makeCloud(win, ls);
	let version = opts.version | 0, folder = !!opts.folder, remembers = !!opts.remembers;
	// `upgradedAt`: this page's load found the cursor bare, the build before's (sync.js `loadVersion`).
	win.DaimondSync = { version: () => version, upgradedAt: () => (opts.upgradedAt === undefined ? -1 : opts.upgradedAt) };
	win.DaimondTools = {};
	const env = {
		ls,
		syncable: () => !folder,
		Files: { remembersFolder: () => remembers || folder },
		FsaDB: { load: async () => (remembers ? {} : null) },
	};
	const gate = loadGate(win, env);
	const d = {
		cloud, gate, ls,
		get v() { return version; },
		/// A pull of the parcel at `v`: merged whole (sandbox) or by shares (folder, `partial`).
		/// `from` is the parcel's `chunkedFrom`, when its writer sent one; `old`, a parcel an old
		/// page wrote (no `chunkedFull` field at all); `oldAt`, its `chunkedOld`.
		pull(v, full, partial, from, old, oldAt) {
			version = v;
			gate.setWhole(!folder || !partial);
			const st = old ? {} : { chunkedFull: !!full };
			if (from !== undefined) st.chunkedFrom = from;
			if (oldAt !== undefined) st.chunkedOld = oldAt;
			gate.syncIndexAt(v, 'merged', st);
		},
		adopt(v) { version = v; gate.syncIndexAt(v, 'adopted', null); },
		/// Its own push over the current version: the parcel carries `indexWhole()` as collected.
		push() { const st = { chunkedFull: gate.indexWhole() }; version += 1; gate.syncIndexAt(version, 'pushed', st); return st.chunkedFull; },
		toFolder() { folder = true; remembers = true; if (BREAK === 'clearonswitch') cloud.noteWhole(-1); },
		toSandbox() { folder = false; if (BREAK === 'clearonswitch') cloud.noteWhole(-1); },
		forget() { remembers = false; },		// Forget, leaving no history in this fixture's storage
		may: () => gate.mayCommitChunks(),
		why: () => gate.offloadBlockedReason(),
	};
	return d;
}

console.log('\n1. a fresh device learns wholeness from the empty mailbox, and keeps it on its own pushes');
{
	const d = device();
	check('before anything, it may not commit', !d.may(), d.why());
	check('the reason is index-not-merged', d.why() === 'index-not-merged');
	d.gate.syncIndexAt(0, 'empty', null);
	check('an empty mailbox is the whole account', d.may() && d.cloud.wholeAt() === 0);
	check('its own push carries chunkedFull and keeps it whole', d.push() === true && d.may(), 'at v' + d.v);
	check('and again', d.push() === true && d.may());
}

console.log('\n2. a whole device stays whole over a peer\'s parcel, whole or not');
{
	const d = device();
	d.gate.syncIndexAt(0, 'empty', null); d.push();			// v1
	d.pull(2, false, false);
	check('a sandbox merge of the next version keeps the chain, whatever the parcel said', d.may(), 'v' + d.v);
	d.pull(4, false, false);
	check('a version skipped breaks the chain (v3 was never merged)', !d.may() && d.why() === 'index-not-merged');
	d.pull(5, true, false);
	check('a parcel whose writer was whole makes it whole again', d.may());
}

console.log('\n3. the 09-13 shape: a folder device merges the phone\'s parcel by its shares, pushes, loses the folder');
{
	const d = device({ version: 1 });
	d.gate.syncIndexAt(1, 'merged', { chunkedFull: true }); d.gate.setWhole(false);
	d.toFolder();
	d.pull(2, true, true);										// the phone's whole parcel, merged by shares
	check('in the folder it may not commit (folder-mounted)', !d.may() && d.why() === 'folder-mounted');
	const flag = d.push();										// argonaut's own folder-era parcel, v3
	check('its own folder-era parcel says it is not whole', flag === false);
	d.toSandbox();												// the handle is lost
	check('back in the sandbox it still may not commit', !d.may() && d.why() === 'index-not-merged', d.why());
	d.pull(3, false, false);									// the round merges the current version again: its own parcel
	check('merging its own folder-era parcel whole does not make it whole', !d.may(),
		'wholeAt=' + d.cloud.wholeAt() + ' at v' + d.v);
	check('its next parcel still says so', d.push() === false && !d.may());
	d.pull(5, true, false);										// the phone pushes a whole parcel
	check('the phone\'s whole parcel, merged whole, lets it commit', d.may());
	check('and its own next parcel says it is whole', d.push() === true && d.may());
}

console.log('\n4. a parcel taken without being opened, and a mailbox that went back');
{
	const d = device();
	d.gate.syncIndexAt(0, 'empty', null); d.push(); d.push();	// v2
	d.adopt(3);
	check('a version adopted unopened leaves it not whole', !d.may());
	check('and its own parcel over it says so', d.push() === false);
	const e = device();
	e.gate.syncIndexAt(0, 'empty', null); for (let i = 0; i < 5; i++) e.push();	// whole at v5
	e.pull(2, false, false);									// a reset: the mailbox is at 2 now
	check('a mailbox below the mark clears it', e.cloud.wholeAt() === -1 && !e.may());
	for (let v = 3; v <= 5; v++) e.pull(v, false, false);
	check('climbing back to the old mark does not restore it', !e.may(), 'wholeAt=' + e.cloud.wholeAt());
}

console.log('\n5. alone on an account, a switch to a folder and back keeps it whole');
{
	const d = device();
	d.gate.syncIndexAt(0, 'empty', null); d.push();
	d.toFolder(); d.push(); d.toSandbox();
	check('its folder-era push was its own, so it is still whole', d.may(), 'wholeAt=' + d.cloud.wholeAt() + ' v' + d.v);
	d.push();
	check('and commits on', d.may());
}

console.log('\n8. a phone asleep: whose were the versions it slept through (chunkedFrom, lane CMG2)');
{
	const d = device();
	d.gate.syncIndexAt(0, 'empty', null); d.push();			// the phone, whole at v1
	d.pull(4, false, false, 1);									// argonaut's v2..v4: its own since the phone's v1
	check('woken past a run of one writer\'s own pushes since its version, it is still whole', d.may(),
		'wholeAt=' + d.cloud.wholeAt() + ' v' + d.v);
	d.pull(7, false, false, 5);									// Q's v5, merged by argonaut in its folder; argonaut's v6, v7
	check('woken past a third device\'s version that the writer took, it is not', !d.may() && d.why() === 'index-not-merged',
		'wholeAt=' + d.cloud.wholeAt());
	d.pull(9, false, false, 8);
	check('and a later run of that writer\'s does not restore it', !d.may());
	d.pull(10, true, false, 9);
	check('a parcel whose writer was whole does', d.may());
	const e = device();
	e.gate.syncIndexAt(0, 'empty', null); e.push();			// v1
	e.pull(2, false, false, 9);									// a chunkedFrom above the version before it
	check('the next version still chains, whatever chunkedFrom says', e.may());
	e.pull(4, false, false, 9);
	check('and a chunkedFrom above the reader\'s mark forgives no skip', !e.may());
	const f = device();
	f.gate.syncIndexAt(0, 'empty', null); f.push();			// v1
	f.toFolder();
	f.pull(3, false, true, 1);									// merged by shares, over a skip it would forgive
	f.toSandbox();
	check('a merge by shares breaks it, whatever the parcel says', !f.may(), 'wholeAt=' + f.cloud.wholeAt());
}

console.log('\n6. the first load of this build (no mark)');
(async () => {
	const phone = device({ version: 7 });
	check('no mark recorded yet', phone.cloud.wholeAt() === null);
	const owed = await phone.gate.syncIndexOwed(true);
	check('a sandbox device that synced before, remembering no folder, is seeded', owed === false && phone.may(),
		'wholeAt=' + phone.cloud.wholeAt());
	const argo = device({ version: 7, remembers: true });
	const owed2 = await argo.gate.syncIndexOwed(true);
	check('one that remembers a folder is not, and owes a merge', owed2 === true && !argo.may() && argo.cloud.wholeAt() === -1);
	const fresh = device({ version: 7 });
	check('a device new to the account is not seeded', (await fresh.gate.syncIndexOwed(false)) === true && !fresh.may());
	const folder = device({ version: 7, folder: true });
	check('a folder-mounted device owes nothing and records nothing', (await folder.gate.syncIndexOwed(true)) === false
		&& folder.cloud.wholeAt() === null);

	console.log('\n6b. an upgrade load with a mark left over: a rollback and re-upgrade (QCMG3b\'s R)');
	const rb = device({ version: 11, upgradedAt: 11 });
	await rb.cloud.noteWhole(7);
	check('a sandbox member whose mark is from before the rollback is seeded at the upgrade', (await rb.gate.syncIndexOwed(true)) === false
		&& rb.may() && rb.cloud.wholeAt() === 11, 'wholeAt=' + rb.cloud.wholeAt());
	const rbf = device({ version: 11, upgradedAt: 11, remembers: true });
	await rbf.cloud.noteWhole(7);
	check('one with a folder behind it is not, and keeps its mark', (await rbf.gate.syncIndexOwed(true)) === true && !rbf.may()
		&& rbf.cloud.wholeAt() === 7, 'wholeAt=' + rbf.cloud.wholeAt());
	const rbn = device({ version: 11 });
	await rbn.cloud.noteWhole(7);
	check('without an upgrade load, a mark left behind is not re-seeded', (await rbn.gate.syncIndexOwed(true)) === true && !rbn.may());
	const rbo = device({ version: 11, upgradedAt: 11 });
	await rbo.cloud.noteWhole(7);
	await rbo.gate.syncIndexOwed(true);
	rbo.pull(13, false, false, 13);								// a skip it cannot chain across
	check('the seed fires once: past it, a device that lost whole is not re-seeded', !rbo.may()
		&& (await rbo.gate.syncIndexOwed(true)) === true && !rbo.may() && rbo.cloud.wholeAt() === 11, 'wholeAt=' + rbo.cloud.wholeAt());

	console.log('\n7. the mark is kept beside the index, and a lost one reads as lost');
	const ls = makeStorage();
	const a = device({ ls });
	a.gate.syncIndexAt(0, 'empty', null); a.push(); a.push();
	await new Promise((r) => setTimeout(r, 10));
	const b = device({ ls, version: 2 });
	await b.cloud.ready();
	check('a new tab over the same storage reads the mark', b.cloud.wholeAt() === 2, String(b.cloud.wholeAt()));
	ls.removeItem('daimond-cloud-merged');
	const c = device({ ls, version: 2 });
	await c.cloud.ready();
	check('a store that lost the mark, where one was written, reads -1, not "never"', c.cloud.wholeAt() === -1);
	check('and is not seeded', (await c.gate.syncIndexOwed(true)) === true && !c.may());

	console.log('\n9. a folder Forget left behind still refuses the seed (QCMG\'s W)');
	for (const [what, key, val] of [
		['the fork point set aside for a folder', 'daimond-sync-filebase-stash', JSON.stringify({ loc: 'folder:f1:work', map: {} })],
		['the location in use naming a folder', 'daimond-sync-filebase-loc', 'folder:f1:work'],
		['the shared folder\'s change record', 'daimond-foldershare-seen', JSON.stringify({ 'work/a.md': '12:34' })],
		['its own record that it collected a folder (5.3)', 'daimond-sync-folder-ever', '1'],
		['a folder among its fork-point locations (5.2.2)', 'daimond-sync-filebase-locs', JSON.stringify(['browser', 'folder:f1:work'])],
	]) {
		const ls9 = makeStorage();
		ls9.setItem(key, val);
		const d9 = device({ ls: ls9, version: 7 });
		check('not seeded after Forget, by ' + what, (await d9.gate.syncIndexOwed(true)) === true && !d9.may()
			&& d9.cloud.wholeAt() === -1, 'wholeAt=' + d9.cloud.wholeAt());
	}
	const ls9b = makeStorage();
	ls9b.setItem('daimond-sync-filebase-loc', 'browser');
	ls9b.setItem('daimond-sync-filebase-stash', JSON.stringify({ loc: 'browser', map: {} }));
	ls9b.setItem('daimond-foldershare-seen', '{}');
	ls9b.setItem('daimond-sync-filebase-locs', JSON.stringify(['browser']));
	const d9b = device({ ls: ls9b, version: 7 });
	check('and a device whose records name only the Browser still is', (await d9b.gate.syncIndexOwed(true)) === false && d9b.may());

	console.log('\n10. the upgrade window: an old page\'s parcels (QCMG\'s G3)');
	const ph = device({ version: 7 });
	await ph.gate.syncIndexOwed(true);							// seeded: whole at 7
	ph.pull(9, false, false, undefined, true);					// the old page pushed 8 and 9 while it slept
	check('a gap in an old page\'s parcels cannot be proved', !ph.may(), 'wholeAt=' + ph.cloud.wholeAt());
	check('so while it stands on an old page\'s parcel it is re-seeded, as the old rule would commit',
		(await ph.gate.syncIndexOwed(true)) === false && ph.may(), 'wholeAt=' + ph.cloud.wholeAt());
	ph.pull(12, false, false, 9);								// the old page loads 5.3: its parcels say chunkedFrom 9
	check('and when that page loads 5.3, its chunkedFrom bridges from there', ph.may(), 'wholeAt=' + ph.cloud.wholeAt());
	const ph2 = device({ version: 7 });
	await ph2.gate.syncIndexOwed(true);
	ph2.pull(9, false, false, 8);								// a 5.3 parcel over a version it slept through
	check('a 5.3 parcel is not an old page\'s: no re-seed over a gap it cannot bridge',
		(await ph2.gate.syncIndexOwed(true)) === true && !ph2.may());
	const ls10 = makeStorage();
	ls10.setItem('daimond-foldershare-seen', JSON.stringify({ 'work/a.md': '1:2' }));
	const ar = device({ ls: ls10, version: 7 });
	await ar.gate.syncIndexOwed(true);
	ar.pull(9, false, false, undefined, true);
	check('a device with a folder behind it is not re-seeded on an old page\'s parcel',
		(await ar.gate.syncIndexOwed(true)) === true && !ar.may());
	const nw = device({ version: 7 });
	nw.pull(9, false, false, undefined, true);
	check('nor is a device new to the account', (await nw.gate.syncIndexOwed(false)) === true && !nw.may());
	const cr = device();
	cr.gate.syncIndexAt(0, 'empty', null); cr.push(); cr.push();	// it made the account this session: whole at 2
	cr.pull(4, false, false, undefined, true);					// an old page pushed 3 and 4 while it slept
	check('a device whole on the account before the gap is one of its devices, loaded this session or not',
		(await cr.gate.syncIndexOwed(false)) === false && cr.may(), 'wholeAt=' + cr.cloud.wholeAt());
	const fm = device();
	fm.gate.syncIndexAt(0, 'empty', null); fm.push();
	fm.toFolder();
	fm.pull(3, false, true, undefined, true);					// merged by its shares, in a folder
	fm.toSandbox(); fm.forget();								// isolates the merge: no folder behind it now
	check('an old page\'s parcel merged by shares does not re-seed', (await fm.gate.syncIndexOwed(true)) === true && !fm.may());
	const kp = device({ version: 7 });
	await kp.gate.syncIndexOwed(true);
	kp.push();													// its own push at 8: not an old page's
	check('its own push over an old page\'s parcel ends the window for it', kp.may() && (await kp.gate.syncIndexOwed(true)) === false);

	console.log('\n11. the upgrade crossed while it slept: chunkedOld (QCMG2\'s G4)');
	const g4 = device({ version: 2 });
	await g4.gate.syncIndexOwed(true);							// seeded: whole at 2
	// argonaut pushed v3 as 5.2.1, then loaded 5.3 at cursor 3 and pushed v4 and v5, taking nothing foreign.
	g4.pull(5, false, false, 3, false, 3);
	check('a 5.3 parcel whose chunkedFrom reaches back to its writer\'s upgrade is of the old era: re-seeded',
		(await g4.gate.syncIndexOwed(true)) === false && g4.may(), 'wholeAt=' + g4.cloud.wholeAt());
	const g4b = device({ version: 2 });
	await g4b.gate.syncIndexOwed(true);
	g4b.pull(7, false, false, 6, false, 3);						// the writer took a foreign version (6) since
	check('once its writer has taken a foreign version past it, the old era is over for that parcel',
		(await g4b.gate.syncIndexOwed(true)) === true && !g4b.may());
	const g4c = device({ version: 2 });
	await g4c.gate.syncIndexOwed(true);
	g4c.toFolder();
	g4c.pull(5, false, true, 3, false, 3);
	g4c.toSandbox(); g4c.forget();
	check('an old-era parcel merged by shares re-seeds nothing', (await g4c.gate.syncIndexOwed(true)) === true && !g4c.may());

	console.log(failures ? `\n${failures} FAILED` : '\nall passed');
	process.exit(failures ? 1 : 0);
})();
