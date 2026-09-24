// verify_foldershare.mjs — a flagged folder reaches the devices that cannot open it.
//
// THE GAP THIS CLOSES. Sync carried the OPFS sandbox only -- "a real folder is the
// user's own disk, device-specific" -- and a device that boots with a folder open holds
// work that a device of the same account with no native access cannot reach at all: the
// only route to a file was a chat turn handed to the first device, which answered in
// prose. A device with a folder open now sends what the user FLAGGED for sharing to the
// devices that have no native access, and writes their edits back into the folder. The
// folder stays the canonical copy: Syncthing, git, Ore and the owner's own `dev` script
// read the same bytes as before.
//
// AND THE FLAG IS THE FIRST GUARD, added 2026-09-14 within a day of the share shipping
// without one. A mark on a folder is the grant its daimon works under -- permission to
// READ -- and the first version of this read that as permission to replicate, so the
// owner's twenty-six gigabytes of marks were all up for copying and the walk that found
// so cost four minutes a round. The copy grant is now its own flag on the attachment,
// generic with respect to devices, off until somebody turns it on.
//
// THE FIXTURE IS THE BOOK. `~/usr/books/ontheism/TheOrder/Onthearche` -- 582 files and
// about 89 MB once the `assets` symlink is followed, 411 of them text, five of them
// compiled PDFs, 91 of them over the inline ceiling. It is READ and never written: the
// only thing this run writes is the browser profile and the OPFS folder it mounts, so
// there is no copy to make and none to leave behind.
//
// FIVE GUARDS, each with its own break:
//
//   THE FLAG. A marked folder shares nothing. What travels is what carries `share` on
//   its attachment, and on a device that has flagged nothing not one `file_list` is
//   issued -- which is the state of the whole fleet the day this ships.
//
//   CEILING, PER FLAGGED FOLDER. `SYNC_FOLDER_SHARE_MAX` is 200 MiB, symlinked trees
//   counted. Past it THAT folder travels no part of itself and the panel names it by
//   name; the other flagged folders go on travelling. Below it the existing budgets
//   apply unchanged.
//
//   IGNORE. `.gitignore` and `.oreignore` are honoured over a built-in floor of build
//   output. Without it a `typst watch` rebuild -- a fresh 1.7 MB PDF beside the source
//   on every keystroke -- would offload a megabyte and wake every device, per keystroke.
//
//   CONTENT, NEVER TIME. Two devices kept identical by Syncthing hold one file at two
//   modification times. What travels is keyed on the content hash. The parcels cannot be
//   byte-identical in every section -- a chunk address is the hash of CIPHERTEXT and the
//   seal takes a fresh IV per device, so two devices addressing identical bytes address
//   them differently -- so what is asserted is what is achievable and is the whole of
//   what matters: the inline section identical byte for byte, every manifest agreeing on
//   `key`, `size` and `bytes` and carrying no clock at all, and each device's own parcel
//   a fixed point. The ten-minute half of that property is in
//   `dev/verify_syncfixedpoint.mjs`, which now stands two mounted devices beside the
//   one without native access.
//
//   NO DELETION BY ABSENCE. A file in the folder goes only on an explicit tombstone from
//   a device that HELD it, and only while the bytes on disk are still the bytes the
//   tombstone was written about.
//
// And the write-back conflict rule: the disk wins and is not touched; the arriving
// version lands beside it as `<name>.conflict-<device>-<stamp>.<ext>`, keeping the real
// extension so the tools that open these files still can.
//
// CHROMIUM ONLY FOR THE FOLDER, and said rather than skipped. Playwright's Linux WebKit
// has no `navigator.storage` at all, so there is no origin-private filesystem to mount
// as a folder and no workspace for either device to hold. Real iOS Safari has had OPFS
// since 15.2; this is a limit of the test engine. What WebKit CAN answer is asked of it:
// the rows a compile would fetch, and the banner that names the folders left out -- both
// string arithmetic over localStorage, and both what a device with no native access
// actually reads.
//
//   bash dev/world.sh 32 --up ; eval "$(bash dev/world.sh 32 --env)"
//   node dev/verify_foldershare.mjs
//   node dev/verify_foldershare.mjs --break oldrule      # a folder syncs nothing (the state before)
//   node dev/verify_foldershare.mjs --break noignore     # the PDFs and the archive travel
//   node dev/verify_foldershare.mjs --break noceiling    # a folder over the ceiling is shared anyway
//   node dev/verify_foldershare.mjs --break timekeyed    # the manifest carries a clock again
//   node dev/verify_foldershare.mjs --break nolargeback  # a file past the inline cap never comes back
//   node dev/verify_foldershare.mjs --break nohydrate    # the phone typesets without its own fonts
//   node dev/verify_foldershare.mjs --break awayisgone   # a file this device freed reads as deleted
//   node dev/verify_foldershare.mjs --break deleteabsent # absence deletes off somebody's disk
//   node dev/verify_foldershare.mjs --break noearlyexit  # the walk finishes the tree before judging the ceiling
//   node dev/verify_foldershare.mjs --break nomemo       # a round's three callers each re-walk the tree
//   node dev/verify_foldershare.mjs --break markshares   # a mark shares the folder, flag or no flag
//   node dev/verify_foldershare.mjs --break allornothing # one folder over the ceiling stops them all
//   node dev/verify_foldershare.mjs --break nonames      # the banner counts the folders instead of naming them
//   node dev/verify_foldershare.mjs --break flagstuck    # the far panel never hears the flag move
//   node dev/verify_foldershare.mjs --break skillprobe   # a SKILL.md's own folder being fenced is believed over the file
//   bash dev/world.sh 32 --down
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { open, signInAs, scratch, BROWSER, markHere } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name
		+ (detail !== undefined && detail !== '' ? ' — ' + detail : ''));
};
const note = (t) => console.log('        · ' + t);
const arg = (flag, dflt) => {
	const i = process.argv.indexOf(flag);
	return i > 0 ? String(process.argv[i + 1] || dflt) : dflt;
};
const BREAK = arg('--break', '');

// ── The breaks: each one is a guard undone ───────────────────────────

const BREAKS = {
	// The rule as it stood until 2026-09-14: a real folder is the user's own disk and
	// nothing in it syncs. B holds zero files, which is the red this file starts from.
	oldrule: [{ file: 'js/daimond.js',
		find: '		var plan = await syncWalkPlan();\n		if (!plan) return out;',
		with: '		var plan = await syncWalkPlan();\n		if (!plan || plan.folder) return out;' }],
	// No ignore rules at all, so the compiled PDFs and the archive tree travel.
	noignore: [{ file: 'js/daimond.js',
		find: '		var rules = await folderIgnoreRules(roots);',
		with: '		var rules = null; if (0) await folderIgnoreRules(roots);' }],
	// The ceiling stops binding.
	noceiling: [{ file: 'js/daimond.js',
		find: '			if (w.bytes > SYNC_FOLDER_SHARE_MAX) {',
		with: '			if (false && w.bytes > SYNC_FOLDER_SHARE_MAX) {' }],
	// THE STATE THE SHARE SHIPPED IN: a mark is read as a copy grant, so every folder
	// any Diamond holds is replicated whether or not anybody asked for it.
	markshares: [{ file: 'js/daimond.js',
		find: '						// The flag, and not the mark. See above.\n						if (!a.share) return;',
		with: '						// BROKEN: the mark is the grant again\n						if (false && !a.share) return;' }],
	// THE CEILING GOES BACK TO BEING ALL-OR-NOTHING, so one oversized folder stops
	// every other flagged folder travelling.
	allornothing: [{ file: 'js/daimond.js',
		find: '				left.push({ root: roots[i], bytes: w.bytes });\n				continue;',
		with: '				left.push({ root: roots[i], bytes: w.bytes });\n				kept = []; break;		// BROKEN: one over the ceiling stops them all' }],
	// The banner counts the folders instead of naming them, which is the notice the
	// person cannot act on: the ceiling is per folder, so which folder is the whole
	// of the news.
	nonames: [{ file: 'js/daimond.js',
		find: '			function (r) { return r.root; },',
		with: '			function (r) { return \'\'; },			// BROKEN: counted, never named' }],
	// The flag moves on one device and the other device's panel never hears about it.
	// TWO SPECS, because the redraw has two carriers and either alone is enough: the
	// links ride with their Diamond and the merge says the links moved, and a landed
	// parcel re-lists an open Workspace panel whatever moved. Breaking one leaves the
	// other drawing the right row, which is a guard proved by nothing -- found by this
	// file on 2026-09-14, when a one-anchor break went green.
	flagstuck: [
		{ file: 'js/daimond.js',
		  find: '		signalLinksChanged();                      // links ride with their Diamond, so the graph moved',
		  with: '		if (false) signalLinksChanged();           // BROKEN: the merge says nothing moved' },
		{ file: 'js/daimond.js',
		  find: '				if (Files.refresh) Files.refresh();',
		  with: '				if (false && Files.refresh) Files.refresh();		// BROKEN: a landed parcel redraws nothing' }],
	// The manifest carries the modification time again, which is what two desktops
	// disagree about while agreeing about every byte.
	timekeyed: [{ file: 'js/daimond.js',
		find: '					shared ? { file: f, timeless: true } : null);',
		with: '					shared ? { file: f, timeless: false } : null);' }],
	// THE STATE BEFORE G1: `applyChunked` refuses the whole merge on a folder-mounted
	// device, so a file past the inline ceiling reaches cloud storage and stops there.
	nolargeback: [{ file: 'js/daimond.js',
		find: '		if (!folder && !filesSyncable()) return;',
		with: '		if (!filesSyncable()) return;		// BROKEN: a folder merges no index' }],
	// THE STATE BEFORE G2: the compile does not fetch the pictures and fonts this
	// device holds as ☁ rows, so it typesets whatever happens to be here.
	nohydrate: [{ file: 'js/daimond.js',
		find: '				if (!(await hydrateProject(main, msgEl))) return;',
		with: '				if (false && !(await hydrateProject(main, msgEl))) return;' }],
	// A FILE THIS DEVICE FREED READS AS A GAP AGAIN. The census's third half -- the
	// paths cloud storage holds that this device is not holding -- stops being consulted,
	// so a phone that offloaded and reclaimed tells the desktop to delete the file off
	// the disk it is sitting on. Found by this file on 2026-09-14.
	awayisgone: [{ file: 'js/daimond.js',
		find: '				|| Object.prototype.hasOwnProperty.call(away, p)) {',
		with: '				|| /* BROKEN: a file this device freed reads as a gap */ false) {' }],
	// Deletion by absence, off somebody's disk.
	deleteabsent: [{ file: 'js/daimond.js',
		find: '		if (plan.folder) {\n			// A FILE ON SOMEBODY\'S DISK IS DELETED ONLY ON A TOMBSTONE',
		with: '		if (plan.folder && remoteComplete === true) {\n			// BROKEN: absence deletes\n			for (var ap in base) {\n'
			+ '				if (!Object.prototype.hasOwnProperty.call(base, ap)) continue;\n'
			+ '				if (Object.prototype.hasOwnProperty.call(remoteFiles, ap)) continue;\n'
			+ '				if (local[ap] == null) continue;\n'
			+ '				if (await deleteSyncFile(app, ap)) gone[ap] = 1;\n'
			+ '			}\n			}\n		if (false) {\n			// A FILE ON SOMEBODY\'S DISK IS DELETED ONLY ON A TOMBSTONE' }],
	// THE STATE BEFORE THIS FILE'S guard 1a: the walk always finishes the whole tree
	// before `syncWalkPlan` judges it over the ceiling, so a verdict the first few
	// hundred listings already had still costs the rest of them.
	noearlyexit: [{ file: 'js/daimond.js',
		find: '					if (out.bytes > SYNC_FOLDER_SHARE_MAX) { out.complete = false; return out; }',
		with: '					if (false && out.bytes > SYNC_FOLDER_SHARE_MAX) { out.complete = false; return out; }' }],
	// THE MEMO NEVER HITS: a TTL of zero is the state every one of a round's three
	// callers -- the parcel, the baseline commit and the pull merge -- stood in
	// before `syncWalkPlan` cached the walk, each paying for its own full census.
	nomemo: [{ file: 'js/daimond.js',
		find: '\tvar SYNC_WALKPLAN_TTL_MS = 25000;\t\t// 25s: covers one round\'s three callers, well inside the next',
		with: '\tvar SYNC_WALKPLAN_TTL_MS = 0;\t\t// BROKEN: the memo never hits' }],
	// THE STATE BEFORE THIS FIX: a refused PARENT listing is believed over the file
	// itself, so `.daimond/skills/<name>/SKILL.md` -- fenced at the folder, open at the
	// manifest -- goes back to "would not list" on every census.
	skillprobe: [{ file: 'js/daimond.js',
		find: '\t\tvar rr;\n\t\ttry { rr = await app.run_tool_outcome(\'file_read\', JSON.stringify({ path: path })); }',
		with: '\t\treturn null;\t\t// BROKEN: never falls back to file_read (skillprobe)\n\t\tvar rr;\n\t\ttry { rr = await app.run_tool_outcome(\'file_read\', JSON.stringify({ path: path })); }' }],
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

// ═══════════════════════════════════════════════════════════════════════
// WHAT A COMPILE WOULD FETCH — ON EITHER ENGINE
// ═══════════════════════════════════════════════════════════════════════
//
// EVERY OPFS ASSERTION IN THIS FILE IS CHROMIUM-ONLY, and this one is not. The rule
// that decides what a phone downloads before it typesets is a function of the cloud
// path list and the document's own folder chain -- localStorage and string arithmetic,
// which WebKit has -- so it is asked of BOTH engines, and the iPhone's real engine is
// WebKit. A phone that fetched the wrong set would either typeset the wrong book or
// pull down somebody's photo library, and neither needs a filesystem to be wrong.
{
	const away = {
		// Under the document's own chain: what a compile of it looks for.
		'TheOrder/Onthearche/assets/fonts/Cormorant-Regular.ttf': 666700,
		'TheOrder/Onthearche/assets/png/Narrative/Aisha.png':     1496536,
		'TheOrder/fonts/Shared-Regular.otf':                      120000,
		// Outside it: another book's pictures, and the account's own photographs.
		'TheOther/Book/assets/png/cover.png':                     900000,
		'photos/2026/holiday/IMG_0001.jpg':                       4000000,
		'system/guide/sync.md':                                   4096,
	};
	const wantIn = [
		'TheOrder/Onthearche/assets/fonts/Cormorant-Regular.ttf',
		'TheOrder/Onthearche/assets/png/Narrative/Aisha.png',
		'TheOrder/fonts/Shared-Regular.otf',
	].sort();
	let w = null;
	try {
		w = await open({ name: 'fs-rows', profile: scratch('pw', 'foldershare-rows-' + BROWSER),
			signIn: false, connect: false, defaults: false });
		await w.page.waitForFunction(() => !!(window.DaimondFiles && DaimondFiles.compileCloudRows
			&& window.DaimondCore && DaimondCore.noteFoldersLeft), null, { timeout: 30000 });
		const got = await w.page.evaluate((a) => {
			localStorage.setItem('daimond-cloud-paths', JSON.stringify(a.away));
			const rows = window.DaimondFiles.compileCloudRows(a.main) || [];
			return { paths: rows.map(r => r.path), bytes: rows.reduce((n, r) => n + r.size, 0) };
		}, { away: away, main: 'TheOrder/Onthearche/onthearche.typ' });
		check(`a compile asks for the pictures and fonts of ITS OWN document, and nothing else (${BROWSER})`,
			got.paths.join() === wantIn.join(),
			got.paths.join() === wantIn.join()
				? `${got.paths.length} row(s), ${(got.bytes / 1048576).toFixed(1)} MiB`
				: 'asked for: ' + got.paths.join(', '));
		const none = await w.page.evaluate(() => {
			localStorage.setItem('daimond-cloud-paths', '{}');
			return (window.DaimondFiles.compileCloudRows('a/b/main.typ') || []).length;
		});
		check(`and a device holding everything already fetches nothing (${BROWSER})`, none === 0);

		// THE BANNER IS A LIST AND A STRING TABLE, so this engine can answer it too --
		// and it is the one sentence that tells a person WHICH folder is not going to
		// their other devices. The ceiling is per folder now, so a notice that said
		// only "a folder is too big" would name nothing anybody could act on.
		const banner = await w.page.evaluate(() => {
			const draw = (list) => {
				window.DaimondCore.noteFoldersLeft(list);
				const el = document.querySelector('.left-banner-msg');
				return el ? el.textContent : '';
			};
			const one = draw([{ root: 'TheOrder/Onthearche', bytes: 220 * 1024 * 1024 }]);
			const two = draw([{ root: 'TheOrder/Onthearche', bytes: 220 * 1024 * 1024 },
				{ root: 'photos/2026', bytes: 900 * 1024 * 1024 }]);
			const cleared = draw([]);
			return { one, two, cleared };
		});
		check(`the folder left out is NAMED in the banner, with the ceiling beside it (${BROWSER})`,
			banner.one.indexOf('TheOrder/Onthearche') >= 0 && banner.one.indexOf('200') >= 0,
			banner.one.slice(0, 130) || 'no banner');
		check(`two of them are both named, and the row clears when the list empties (${BROWSER})`,
			banner.two.indexOf('TheOrder/Onthearche') >= 0 && banner.two.indexOf('photos/2026') >= 0
			&& banner.cleared === '',
			banner.two.slice(0, 150) || 'no banner');
	} catch (e) {
		// A CELL THAT COULD NOT RUN IS RED, not absent: this is the one claim in this
		// file that the iPhone's real engine can answer, and a silent skip of it would
		// leave the phone half of a cross-device feature checked on Chromium alone.
		check(`what a compile would fetch, on ${BROWSER}`, false,
			(e && e.message ? e.message : String(e)).split('\n')[0].slice(0, 140));
	} finally {
		if (w) await w.close().catch(() => {});
	}
}

// SAID, AND NOT RED. A WebKit sweep runs every verifier here, and a refusal that exits
// non-zero would report a defect where there is only a missing API in the test engine --
// so this says in one line what it could not look at and stops. It does not pass quietly:
// the reason is on the line that carries it, and the count above is what this engine
// COULD answer.
if (BROWSER !== 'chromium') {
	console.log(`\n— the shared folder, ${BROWSER} —`);
	console.log(`  --   not covered on ${BROWSER}: mounting a folder needs an origin-private `
		+ `filesystem, and Playwright's ${BROWSER} has no navigator.storage at all, so there `
		+ `is no workspace for either device to hold. Real iOS Safari has had OPFS since `
		+ `15.2; this is a limit of the test engine. Run this one under Chromium.`);
	console.log(`\n${ok.length} ok, ${bad.length} failed, 1 not covered on ${BROWSER}`);
	process.exit(bad.length ? 1 : 0);
}

// ── The seams must be present, or a green run proves nothing ─────────

const SEAM = [
	{ file: 'js/ignore.js',   want: 'DaimondIgnore',
	  why: 'there is no ignore parser, so a compiled PDF would travel on every keystroke' },
	{ file: 'js/daimond.js',  want: 'SYNC_FOLDER_SHARE_MAX',
	  why: 'a shared folder has no ceiling' },
	{ file: 'js/daimond.js',  want: 'syncWalkPlan',
	  why: 'the census still has one source and a folder shares nothing' },
	{ file: 'js/daimond.js',  want: 'SYNC_FILE_TOMBS_KEY',
	  why: 'a deletion is still inferred from absence at the far end' },
	{ file: 'js/daimond.js',  want: 'hasOwnProperty.call(away, p)',
	  why: 'a file this device freed after uploading it still reads as one it deleted' },
	{ file: 'js/cloud.js',    want: 'fileUnderRoot',
	  why: 'the census can only read the sandbox, so a folder\'s bytes are unreachable' },
	{ file: 'js/cloud.js',    want: 'materialiseTo',
	  why: 'nothing can write a chunked file into the folder, so a big edit cannot come back' },
	{ file: 'js/daimond.js',  want: 'hydrateProject',
	  why: 'a compile does not fetch the pictures and fonts held as ☁ rows' },
	{ file: 'js/daimond.js',  want: 'if (out.bytes > SYNC_FOLDER_SHARE_MAX) { out.complete = false; return out; }',
	  why: 'the walk finishes the whole tree before giving a verdict it had hundreds of listings ago' },
	{ file: 'js/daimond.js',  want: '_walkPlanCache',
	  why: 'the walk is not memoised, so a round\'s three callers each re-walk the whole tree' },
	{ file: 'js/daimond.js',  want: 'if (!a.share) return;',
	  why: 'a mark is read as a copy grant again, and every marked folder is replicated' },
	{ file: 'js/daimond.js',  want: 'noteFoldersLeft',
	  why: 'a folder left out for its size is not named, so nobody can tell which it was' },
];
{
	const missing = [];
	for (const s of SEAM) {
		const src = fs.readFileSync(path.join(WWW, s.file), 'utf8');
		if (!src.includes(s.want)) missing.push(`  ${s.file}: ${s.why}`);
	}
	if (missing.length) {
		console.error('the shared-folder seams are not in this tree, so this run would prove nothing:');
		for (const b of missing) console.error(b);
		process.exit(2);
	}
}

const PATCHED = new Map();
if (BREAK) {
	for (const spec of BREAKS[BREAK]) {
		const src = PATCHED.get(spec.file) ?? fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		const n = src.split(spec.find).length - 1;
		if (n !== 1) {
			console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
				+ 'so nothing was changed and the run below would prove nothing.');
			process.exit(2);
		}
		PATCHED.set(spec.file, src.replace(spec.find, spec.with));
	}
	console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***`);
}

// ═══════════════════════════════════════════════════════════════════════
// THE FIXTURE — read from the owner's book, never written to.
// ═══════════════════════════════════════════════════════════════════════

const BOOK = path.join(os.homedir(), 'usr/books/ontheism/TheOrder/Onthearche');
const SCOPE = 'TheOrder/Onthearche';		// where it is mounted, inside the folder

/// Walk the book FOLLOWING SYMLINKS, which is what the browser's file API does with
/// one and what makes `assets -> ../../assets` 26 MB of fonts rather than a link.
///
/// `dev` is left out and it is the only thing that is: it is a symlink to the owner's
/// build scripts, outside the book, and following it would put this run's fixture
/// somewhere nobody described.
///
/// The guard is the ANCESTOR CHAIN and not a set of everything seen, which is the
/// difference between refusing a loop and refusing a repeat. This book reaches one
/// `assets` tree from two places -- the top level and the archived snapshot -- and a
/// global seen-set drops whichever it meets second, which is 26 MB of fonts silently
/// absent from a fixture whose whole purpose is the budgets.
function walkBook(rel, out, chain) {
	const abs = rel ? path.join(BOOK, rel) : BOOK;
	let real;
	try { real = fs.realpathSync(abs); } catch (e) { return out; }
	if (chain.has(real)) return out;			// a link back up its own tree
	const here = new Set(chain);
	here.add(real);
	let ents;
	try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return out; }
	for (const e of ents) {
		const r = rel ? rel + '/' + e.name : e.name;
		if (!rel && e.name === 'dev') continue;
		// A DOTFILE IS NOT PART OF THE FIXTURE, and the reason is Syncthing: the book is
		// a replicated folder, so `.syncthing.<name>.tmp` appears and goes while this
		// runs. One of them was walked and had gone by the time the seeding fetched it,
		// which took a whole break run down as "the run itself". The app's own census
		// does not walk dotfiles either, and the `.gitignore` the ignore cell needs is
		// written in the browser rather than taken from here.
		if (e.name.charAt(0) === '.') continue;
		let st;
		try { st = fs.statSync(path.join(BOOK, r)); } catch (e2) { continue; }
		if (st.isDirectory()) { walkBook(r, out, here); continue; }
		if (!st.isFile()) continue;
		out.push({ p: r, size: st.size });
	}
	return out;
}
const FIXTURE = walkBook('', [], new Set()).sort((a, b) => (a.p < b.p ? -1 : 1));
const FIX_BYTES = FIXTURE.reduce((n, f) => n + f.size, 0);
if (FIXTURE.length < 100) {
	console.error(`the fixture at ${BOOK} has only ${FIXTURE.length} files; this run needs the `
		+ `owner's book to say anything about budgets.`);
	process.exit(2);
}
console.log(`\n— the folder: ${FIXTURE.length} files, ${(FIX_BYTES / 1048576).toFixed(1)} MiB `
	+ `(symlinks followed), ${BROWSER} —`);

// The files the assertions name. The chapter and the document are named by hand because
// they are what the book IS; the font is taken from the fixture, so the assertion about a
// file too big to ride inline cannot come to rest on one that is not.
const CHAPTER = SCOPE + '/chap_practice.typ';
const MAIN    = SCOPE + '/onthearche.typ';
const BIGGEST = FIXTURE
	.filter(f => f.p.indexOf('assets/fonts/') === 0 && /\.(otf|ttf)$/i.test(f.p))
	.sort((a, b) => b.size - a.size)[0];
if (!BIGGEST) {
	console.error('the fixture holds no font under assets/fonts; the symlink was not followed.');
	process.exit(2);
}
const FONT = SCOPE + '/' + BIGGEST.p;

// A PICTURE TOO BIG TO RIDE INLINE, which is what makes the compile cell a real red:
// the gatherer skips a path that is not there, and typst then refuses and names the
// file. A font it skips silently, which is the worse half and is asserted on residency
// rather than on a refusal that does not exist.
const PIC = FIXTURE
	.filter(f => /^assets\/png\//.test(f.p) && /\.png$/i.test(f.p) && f.size > 128 * 1024)
	.sort((a, b) => a.size - b.size)[0];
if (!PIC) {
	console.error('the fixture holds no picture over the inline ceiling under assets/png.');
	process.exit(2);
}
// Every font face of the book, so the compile cell can say whether the phone got them
// all rather than the handful small enough to ride inline.
const FACES = FIXTURE.filter(f => f.p.indexOf('assets/fonts/') === 0 && /\.(otf|ttf)$/i.test(f.p));

// ═══════════════════════════════════════════════════════════════════════
// THE CLOUD, in this process, shared by both contexts — the chassis of
// dev/verify_syncfixedpoint.mjs, with the gateway's own commit sweep.
// ═══════════════════════════════════════════════════════════════════════

const cloud = {
	mailbox: null, chunks: new Map(), live: new Set(),
	pushes: [], commits: [], puts: [], gets: 0, bodies: [],
};

function serve(dev, rawPath, method, bodyText) {
	const p = String(rawPath).split('?')[0];
	const body = bodyText ? JSON.parse(bodyText) : {};
	if (p === '/api/sync') {
		if (method === 'GET') {
			if (!cloud.mailbox) return { status: 200, json: { present: false, version: 0 } };
			return { status: 200, json: { present: true, version: cloud.mailbox.version,
				blob: cloud.mailbox.blob, device: cloud.mailbox.device } };
		}
		const cur = cloud.mailbox ? cloud.mailbox.version : 0;
		// THE WIRE, MEASURED WHERE IT IS REAL. This is the body Steel's 8 MiB front
		// door would see: base64 of the sealed parcel inside a JSON envelope, not the
		// parcel. A verifier that weighed the parcel would be under the door by a
		// third and would never see the push that is refused.
		cloud.bodies.push({ dev, bytes: (bodyText || '').length });
		if ((body.base_version | 0) !== cur) return { status: 409, json: { ok: false, version: cur } };
		cloud.mailbox = { version: cur + 1, blob: body.blob, device: body.device || dev };
		cloud.pushes.push({ dev, version: cur + 1 });
		return { status: 200, json: { ok: true, version: cur + 1 } };
	}
	if (p === '/api/chunk') {
		if (body.op === 'put') {
			(body.chunks || []).forEach(c => cloud.chunks.set(c.addr, c.blob));
			cloud.puts.push({ dev, n: (body.chunks || []).length });
			return { status: 200, json: { ok: true } };
		}
		if (body.op === 'have') {
			return { status: 200, json: { missing: (body.addrs || []).filter(a => !cloud.chunks.has(a)) } };
		}
		if (body.op === 'get') {
			cloud.gets++;
			const blob = cloud.chunks.get(body.addr);
			return { status: 200, json: blob ? { present: true, blob } : { present: false } };
		}
		if (body.op === 'commit') {
			const live = new Set((body.chunks || []).map(c => c.addr));
			let swept = 0;
			for (const a of [...cloud.chunks.keys()]) {
				if (!live.has(a)) { cloud.chunks.delete(a); swept++; }
			}
			cloud.live = live;
			cloud.commits.push({ dev, live: live.size, swept });
			return { status: 200, json: { ok: true, swept, free_allowance: 0, paid_bytes: 0 } };
		}
		return { status: 200, json: { ok: true } };
	}
	return { status: 200, json: { ok: true } };
}

// ═══════════════════════════════════════════════════════════════════════
// The two devices.
// ═══════════════════════════════════════════════════════════════════════

const PROFILE_A = scratch('pw', 'foldershare-a' + (BREAK ? '-' + BREAK : ''));
const PROFILE_B = scratch('pw', 'foldershare-b' + (BREAK ? '-' + BREAK : ''));
for (const d of [PROFILE_A, PROFILE_B]) fs.rmSync(d, { recursive: true, force: true });

/// Serve a break's edited file, and the fixture's bytes.
async function routeFor(withFixture) {
	return async (page) => {
		for (const [f, body] of PATCHED) {
			await page.route('**/' + f, r => r.fulfill({
				status: 200, contentType: 'application/javascript', body }));
		}
		if (!withFixture) {
			// `detectMobile` takes Chromium's own client hint as the fact and stops there
			// (js/mobile.js), so an iPhone user agent alone leaves B a desktop and the
			// tighter inline ceiling is never the one it spends to. This is the one
			// statement that settles it, made before the app reads it.
			await page.addInitScript(() => {
				try {
					Object.defineProperty(navigator, 'userAgentData', {
						configurable: true,
						get: () => ({ mobile: true, brands: [], platform: 'Android' }),
					});
				} catch (e) { /* an engine without it reads the user agent instead */ }
			});
			return;
		}
		// THE FIXTURE COMES OVER THE WIRE, NOT THROUGH `evaluate`. Ninety megabytes of
		// base64 through the debugging protocol is minutes; a fetch per file is seconds,
		// and it is bytes rather than a string, so a font arrives as a font.
		await page.route('**/__fx/**', (r) => {
			const rel = decodeURIComponent(new URL(r.request().url()).pathname.replace(/^\/__fx\//, ''));
			const abs = path.join(BOOK, rel);
			if (!abs.startsWith(BOOK)) return r.fulfill({ status: 403, body: 'no' });
			let buf;
			try { buf = fs.readFileSync(abs); } catch (e) { return r.fulfill({ status: 404, body: 'no' }); }
			return r.fulfill({ status: 200, contentType: 'application/octet-stream', body: buf });
		});
	};
}

async function wireCloud(s, dev) {
	await s.page.exposeFunction('__cloudCall', async (p, method, body) => serve(dev, p, method, body));
	await s.page.evaluate((dev) => {
		window.__dev = dev;
		window.__lines = [];
		const realDebug = console.debug;
		console.debug = function (...a) { window.__lines.push(a.join(' ')); realDebug.apply(console, a); };
		window.DaimondGateway.state = function () { return { authed: true, credits: 0, pro: false }; };
		window.DaimondGateway.gwFetch = async function (p, opts) {
			const method = (opts && opts.method) || 'GET';
			const body   = (opts && opts.body) || '';
			const r = await window.__cloudCall(String(p), method, String(body));
			return { status: r.status, json: async () => r.json };
		};
	}, dev);
}

const ready = (s) => s.page.waitForFunction(
	() => !!(window.DaimondCore && DaimondCore.collectSync && DaimondCore.applySync
		&& DaimondCore.syncFolderShare && window.DaimondSync && window.DaimondChunks
		&& window.DaimondCloud && DaimondCloud.fileUnderRoot && window.DaimondIgnore
		&& window.DaimondGateway && window.DaimondIdentity),
	null, { timeout: 30000 });

const push = async (s) => { await s.page.evaluate(() => window.DaimondSync.push()); await s.page.waitForTimeout(600); };
const pull = async (s) => { await s.page.evaluate(() => window.DaimondSync.pull()); await s.page.waitForTimeout(600); };
/// One full round: each side tells the other and hears it back.
const round = async (A_, B_) => { await push(A_); await pull(B_); await push(B_); await pull(A_); };

let A = null, B = null;

try {

A = await open({ name: 'fs-a', profile: PROFILE_A, signIn: false, connect: false,
	defaults: false, route: await routeFor(true) });
await ready(A);
await signInAs(A, 'foldershare');
await ready(A);

const bundle = await A.page.evaluate(() => window.DaimondIdentity.exportBundle());
// B HAS NO NATIVE ACCESS. It is the device the flag exists for -- the whole reason a
// folder has to travel at all -- and it is also given the tighter inline ceiling
// (`SYNC_INLINE_SOFT_MOBILE_MAX`, 256 KiB), so its own parcel is where that cap is
// asserted. The iPhone user agent below is the fixture for that cap and nothing more:
// nothing in this feature is about a phone, and the flag is worded about devices that
// cannot open a folder rather than about any kind of device.
B = await open({ name: 'fs-b', profile: PROFILE_B, signIn: false, connect: false,
	defaults: false, route: await routeFor(false),
	ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
		+ '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
await ready(B);
await B.page.evaluate((b) => window.DaimondIdentity.importBundle(b), bundle);
await B.page.reload({ waitUntil: 'domcontentloaded' });
await ready(B);
await signInAs(B, 'foldershare');
await ready(B);

await wireCloud(A, 'A');
await wireCloud(B, 'B');

const keys = {
	a: await A.page.evaluate(() => window.DaimondIdentity.publicKeyB64url()),
	b: await B.page.evaluate(() => window.DaimondIdentity.publicKeyB64url()),
};
check('two contexts hold ONE account — the same key, so one mailbox opens for both',
	!!keys.a && keys.a === keys.b);
const bMobile = await B.page.evaluate(() => !!(window.DaimondShell && DaimondShell.isMobileDevice()));
check('B answers as a phone, so the mobile inline ceiling is the one it spends to', bMobile === true);

// ── A mounts a real folder, by the door the user uses ────────────────
//
// The recipe dev/verify_dataloss.mjs and dev/verify_syncfixedpoint.mjs established: a
// directory handle out of OPFS, granted the way a user grants one, handed to the panel's
// Machine chip. A `showDirectoryPicker` grant cannot be answered under automation
// (dev/HATES.md, Lane G §1), and this is the same override by the door that also sets
// the panel's own handle -- which is what `Files.folder()` answers and what the census
// reads. `set_workspace_dir` alone sets only the engine's half.
await A.page.evaluate(async () => {
	const root = await navigator.storage.getDirectory();
	const dir  = await root.getDirectoryHandle('mounted', { create: true });
	dir.queryPermission   = async () => 'granted';
	dir.requestPermission = async () => 'granted';
	window.showDirectoryPicker = async () => dir;
});
await A.page.evaluate(() => window.DaimondPanels && DaimondPanels.open && DaimondPanels.open('work'));
await A.page.waitForTimeout(700);
await A.page.evaluate(() => {
	const chips = [...document.querySelectorAll('.files-mode-chip')];
	const machine = chips.find(c => /machine/.test(c.className)
		|| c.querySelector('[data-icon="machine"]')) || chips[1];
	if (machine) machine.click();
});
await A.page.waitForTimeout(1500);
const aMode = await A.page.evaluate(async () => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	return { mode: mod.workspace_mode(), handle: !!(window.DaimondFiles && DaimondFiles.folder()),
		mayCommit: window.DaimondCore.syncMayCommitChunks() };
});
check('A has a real folder open, and STILL commits nothing — the owner\'s desktop topology',
	aMode.mode === 'folder' && aMode.handle === true && aMode.mayCommit === false,
	`mode=${aMode.mode} mayCommit=${aMode.mayCommit}`);

// ── The book goes into the folder ────────────────────────────────────
const t0 = Date.now();
// A BOOK REPOSITORY STATES ITS OWN RULES, and they go in with the book rather than
// after it: the archive tree is a snapshot nobody edits and the font zips are the
// downloads the unpacked fonts came from, and on the owner's disk both rules were there
// before anything was ever shared. The built-in floor underneath them excludes the
// compiled PDFs. Guard 2 below is what asserts they bite.
const RULES = [
	['.gitignore', '# the snapshot, not the work\narchive/\n*.zip\n'],
	['.oreignore', 'revision/\n'],
];
const seeded = await A.page.evaluate(async (list) => {
	const root = window.DaimondFiles.folder();
	const dirs = new Map([['', root]]);
	async function dirFor(rel) {
		if (dirs.has(rel)) return dirs.get(rel);
		const cut = rel.lastIndexOf('/');
		const parent = await dirFor(cut < 0 ? '' : rel.slice(0, cut));
		const name = cut < 0 ? rel : rel.slice(cut + 1);
		const h = await parent.getDirectoryHandle(name, { create: true });
		dirs.set(rel, h);
		return h;
	}
	let n = 0, bytes = 0;
	const missing = [];
	for (const f of list) {
		const cut = f.p.lastIndexOf('/');
		const d = await dirFor(cut < 0 ? '' : f.p.slice(0, cut));
		const fh = await d.getFileHandle(cut < 0 ? f.p : f.p.slice(cut + 1), { create: true });
		const res = await fetch('/__fx/' + f.src.split('/').map(encodeURIComponent).join('/'));
		// GONE SINCE THE WALK IS NOT A BROKEN RUN. The book is a Syncthing folder and
		// this reads it live; a file that has moved under the fixture costs the fixture
		// that file, and the counts below are taken from what was actually written.
		if (res.status === 404) { missing.push(f.p); continue; }
		if (!res.ok) throw new Error('fixture ' + f.src + ': ' + res.status);
		const buf = await res.arrayBuffer();
		const w = await fh.createWritable();
		await w.write(buf);
		await w.close();
		n++; bytes += buf.byteLength;
	}
	return { n, bytes, missing };
}, FIXTURE.map(f => ({ p: SCOPE + '/' + f.p, src: f.p })));
await A.page.evaluate(async (a) => {
	const root = window.DaimondFiles.folder();
	let d = root;
	for (const seg of a.scope.split('/')) d = await d.getDirectoryHandle(seg, { create: true });
	for (const [name, text] of a.rules) {
		const fh = await d.getFileHandle(name, { create: true });
		const w  = await fh.createWritable();
		await w.write(new TextEncoder().encode(text));
		await w.close();
	}
}, { scope: SCOPE, rules: RULES });
note(`seeded ${seeded.n} files, ${(seeded.bytes / 1048576).toFixed(1)} MiB, in ${((Date.now() - t0) / 1000).toFixed(1)}s`
	+ (seeded.missing.length ? `; ${seeded.missing.length} had gone since the walk` : ''));

// ── One Diamond, scoped to the book ──────────────────────────────────
//
// THE MARK IS A READ GRANT AND NOT A COPY GRANT (owner's ruling, 2026-09-14). Marking a
// folder into a Diamond says its daimon may open it (dev/ATTACH_CONTRACT.md §2); it says
// nothing about replicating the folder to the account's other devices, and reading the
// two as one put twenty-six gigabytes of the owner's marks up for copying.
//
// THE REFERENCE NAMES THIS DEVICE (owner ruling, 2026-09-23): a mark is per-machine now,
// and a rootless reference -- `dir:TheOrder/Onthearche`, the grandfathered form every
// link made before roots were recorded carries -- is no longer in force on a mounted
// folder; it sits inactive until confirmed here.
// `DaimondAttach.ref` writes the rooted, device-tagged form
// (`dir:[machine:mounted@<device>]TheOrder/Onthearche`), which names where the mark
// was made but is no longer itself the grant (R2, 2026-09-24): a row is only a claim
// until this device's own record says it was pressed, exactly as the paperclip does,
// which is what `markHere` below presses -- the ADD alone, as this fixture asserted
// before R2, is no longer enough.
const marked = await A.page.evaluate(async (scope) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const id = await app.create_diamond('Onthearche');
	const ref = window.DaimondAttach.ref('dir', scope);
	const linkId = await app.add_link(id, 'diamond:' + id, ref, 'holds', '', 'user');
	await window.DaimondCore.loadDiamonds();
	return { id, linkId, ref };
}, SCOPE);
const did = marked.id;
await markHere(A, did, marked.ref, { linkId: marked.linkId });
note(`Diamond ${did.slice(0, 12)}… holds ${SCOPE}`);

// ═══════════════════════════════════════════════════════════════════════
// THE FLAG — a marked folder shares nothing until somebody says so
// ═══════════════════════════════════════════════════════════════════════
console.log('\n— a mark is a read grant: nothing travels until the attachment is flagged —');

// MEASURED AROUND THE WALK ITSELF, because the cost is the point as much as the silence.
// The owner's desktops paid ~22,500 `file_list` calls three times a round to conclude
// that his marks were too big to share; after this ruling a device with nothing flagged
// issues NONE, and that is the state of every device on the day this ships.
const unflagged = await A.page.evaluate(async () => {
	const mod  = await import('/pkg/oxedyne_daimond.js');
	const orig = mod.DaimondApp.prototype.run_tool_outcome;
	let calls  = 0;
	mod.DaimondApp.prototype.run_tool_outcome = function (name, argsJson) {
		if (name === 'file_list') calls++;
		return orig.call(this, name, argsJson);
	};
	let s;
	try { s = await window.DaimondCore.syncFolderShare(); }
	finally { mod.DaimondApp.prototype.run_tool_outcome = orig; }
	return { s, calls };
});
check('a folder MARKED into a Diamond and not flagged shares nothing at all',
	unflagged.s.roots.length === 0 && unflagged.s.flagged.length === 0,
	`roots [${unflagged.s.roots.join(', ')}], flagged [${unflagged.s.flagged.join(', ')}]`);
check('and NO WALK RUNS — the whole cost of this feature on a device that flagged nothing',
	unflagged.calls === 0,
	`${unflagged.calls} file_list call(s) for a ${FIXTURE.length}-file mark`);
const unflaggedCol = await A.page.evaluate(async () => {
	const col = await window.DaimondCore.collectSync();
	const row = document.querySelector('.left-banner-msg');
	return { files: Object.keys(col.files).length, complete: col.filesComplete,
		msg: row ? row.textContent : '' };
});
check('the census carries none of it, calls itself incomplete, and complains about nothing',
	unflaggedCol.files === 0 && unflaggedCol.complete === false && unflaggedCol.msg === '',
	`${unflaggedCol.files} inline file(s), complete=${unflaggedCol.complete}, `
	+ `banner ${unflaggedCol.msg ? JSON.stringify(unflaggedCol.msg.slice(0, 70)) : 'none'}`);

// ── and now the second grant, given explicitly ───────────────────────
// R2/O2: ⇄ writes the row's flag (`set_link_share`) AND this device's own entry
// (`DaimondMarksHere.setShare`), both at once -- `markHere`'s job, since the mark
// is already in force here (pressed above) and needs only the second grant.
await markHere(A, did, marked.ref, { linkId: marked.linkId, press: false, share: true });
await A.page.evaluate(async () => {
	await window.DaimondCore.loadDiamonds();
	window.DaimondCore.syncClearWalkCache();
});

const share = await A.page.evaluate(() => window.DaimondCore.syncFolderShare());
check('a FLAGGED folder shares exactly itself, and the ceiling is 200 MiB per folder',
	share.folder === true && share.roots.length === 1 && share.roots[0] === SCOPE
	&& share.flagged.length === 1 && share.max === 200 * 1024 * 1024 && share.left.length === 0,
	`roots ${share.roots.join(', ')}, ${(share.bytes / 1048576).toFixed(1)} MiB in `
	+ `${share.files} files, ${share.ignored} ignored, ${share.left.length} left out`);

// A FILE ITSELF marked into a Diamond, rather than a folder -- the shape
// `.daimond/skills/think/SKILL.md` takes on the owner's two desktops, and outside
// SCOPE so the directory root above does not already cover it and drop it as
// redundant. `file_list` opens directories; asked to list this path directly it
// used to answer "would not list" on every single census.
const DEEP_FILE = 'aside/notes/deep/skill.md';
await A.page.evaluate(async (p) => {
	const root = window.DaimondFiles.folder();
	let d = root;
	const parts = p.split('/');
	const name = parts.pop();
	for (const seg of parts) d = await d.getDirectoryHandle(seg, { create: true });
	const fh = await d.getFileHandle(name, { create: true });
	const w = await fh.createWritable();
	await w.write(new TextEncoder().encode('# a file attached on its own\n'));
	await w.close();
}, DEEP_FILE);
const deepLink = await A.page.evaluate(async ({ id, p }) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	// A lone file may be marked and flagged exactly as a folder may, and this one is
	// the second flagged root the per-root ceiling is measured on. The reference names
	// this device (see the note on `marked` above), but naming it is no longer the
	// grant (R2) -- `markHere` below presses it and ⇄'s it, in the two writes O2 asks
	// for, rather than in the one `add_link` this fixture asserted before R2.
	const ref = window.DaimondAttach.ref('file', p);
	const linkId = await app.add_link(id, 'diamond:' + id, ref, 'holds', '', 'user');
	return { linkId, ref };
}, { id: did, p: DEEP_FILE });
await markHere(A, did, deepLink.ref, { linkId: deepLink.linkId, share: true });
await A.page.evaluate(async () => {
	await window.DaimondCore.loadDiamonds();
	window.DaimondCore.syncClearWalkCache();
});

A.logs.length = 0;		// only the census the next line triggers is under test
const deepShare = await A.page.evaluate(() => window.DaimondCore.syncFolderShare());
const badLogs = A.logs.filter(l => l.indexOf('would not list') >= 0);
check('a file marked in on its own is walked as a file, never asked to list as a directory',
	badLogs.length === 0 && deepShare.complete === true && deepShare.roots.indexOf(DEEP_FILE) >= 0,
	badLogs.join(' | ') || `roots ${deepShare.roots.join(', ')}, complete=${deepShare.complete}`);

// A SHIPPED SKILL'S MANIFEST, `.daimond/skills/<name>/SKILL.md` -- the shape DEEP_FILE
// did not cover. On the owner's desktops this one's PARENT directory
// (`.daimond/skills/verifyskill/`) is refused by the read fence itself: a Diamond's own
// bounds deny `.daimond/` outright and `is_skills_disclosure` (src/tools.rs) opens back
// up only the skills index and the exact manifest path, never the folder around it --
// the case the owner's argonaut logged as "would not list" ~60 times/hour. This
// harness's own sync app runs unscoped (`tools()` in daimond.js builds a plain
// `DaimondApp` with no Diamond bound at all), so the fence itself never actually
// engages here -- proved by running this fixture with `fileEntryUnderParent`'s
// fallback disabled and confirming NOTHING goes red. So the one call the fence would
// have refused is refused here instead, on the exact prototype method every
// `DaimondApp.run_tool_outcome` call goes through, and put back the moment the
// census returns: `fileEntryUnderParent`'s parent-listing attempt is made to fail
// exactly as it does in production, and only its `file_read` fallback -- reading the
// one path `is_skills_disclosure` actually opens -- can answer it.
const SKILL_FILE = '.daimond/skills/verifyskill/SKILL.md';
const SKILL_PARENT = '.daimond/skills/verifyskill';
await A.page.evaluate(async (p) => {
	const root = window.DaimondFiles.folder();
	let d = root;
	const parts = p.split('/');
	const name = parts.pop();
	for (const seg of parts) d = await d.getDirectoryHandle(seg, { create: true });
	const fh = await d.getFileHandle(name, { create: true });
	const w = await fh.createWritable();
	await w.write(new TextEncoder().encode('# a shipped skill, marked in on its own\n'));
	await w.close();
}, SKILL_FILE);
const skillLink = await A.page.evaluate(async ({ id, p }) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	// MARKED AND FLAGGED, exactly as DEEP_FILE above is. This fixture was written when a
	// mark was itself the copy grant; it is not one any more (`Files.shareRoots` reads
	// `a.share`, not the mark), so a manifest marked and left unflagged is correctly
	// shared with nobody and this cell would be asserting the rule that was replaced
	// rather than the fallback it exists to test. Naming this device in the reference
	// is not the grant either, since R2 -- `markHere` below presses and ⇄'s it.
	const ref = window.DaimondAttach.ref('file', p);
	const linkId = await app.add_link(id, 'diamond:' + id, ref, 'holds', '', 'user');
	return { linkId, ref };
}, { id: did, p: SKILL_FILE });
const skillLinkId = skillLink.linkId;
await markHere(A, did, skillLink.ref, { linkId: skillLinkId, share: true });
await A.page.evaluate(async () => {
	await window.DaimondCore.loadDiamonds();
	// The memo is keyed on the flagged roots, but the walk this cell is about is the
	// one the NEXT line triggers -- so it is dropped outright rather than raced.
	window.DaimondCore.syncClearWalkCache();
});

A.logs.length = 0;		// only the census the next line triggers is under test
const skillShare = await A.page.evaluate(async (parent) => {
	const mod  = await import('/pkg/oxedyne_daimond.js');
	const orig = mod.DaimondApp.prototype.run_tool_outcome;
	mod.DaimondApp.prototype.run_tool_outcome = function (name, argsJson) {
		if (name === 'file_list') {
			try {
				if (JSON.parse(argsJson).path === parent) {
					return Promise.resolve({ outcome: 'refused', text:
						"file_list: '" + parent + "' is inside .daimond/, which a Diamond's own bounds deny." });
				}
			} catch (e) { /* fall through to the real call */ }
		}
		return orig.call(this, name, argsJson);
	};
	try { return await window.DaimondCore.syncFolderShare(); }
	finally { mod.DaimondApp.prototype.run_tool_outcome = orig; }
}, SKILL_PARENT);
const skillBadLogs = A.logs.filter(l => l.indexOf('would not list') >= 0);
check('a SKILL.md marked in on its own is walked as a file, even when its own folder listing is refused',
	skillBadLogs.length === 0 && skillShare.complete === true && skillShare.roots.indexOf(SKILL_FILE) >= 0,
	skillBadLogs.join(' | ') || `roots ${skillShare.roots.join(', ')}, complete=${skillShare.complete}`);

// UNMARKED AND REMOVED, rather than left to ride through every later guard: this
// fixture proves only the one narrow thing above, and a `.daimond/` path lingering
// in the Diamond's marks for the rest of the run is untested territory for every
// guard below it, not a property this file is set up to state anything about.
await A.page.evaluate(async ({ id, linkId, p }) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.remove_link(id, linkId);
	await window.DaimondCore.loadDiamonds();
	const root = window.DaimondFiles.folder();
	const d = await root.getDirectoryHandle('.daimond');
	const skills = await d.getDirectoryHandle('skills');
	await skills.removeEntry('verifyskill', { recursive: true });
}, { id: did, linkId: skillLinkId, p: SKILL_FILE });

// ═══════════════════════════════════════════════════════════════════════
// GUARD 2 — the ignore list
// ═══════════════════════════════════════════════════════════════════════
console.log('\n— guard 2: the folder\'s own rules, over a built-in floor —');

// A RAW OPFS WRITE is what put the rules there, same as an external editor's, and
// `daimond-file-written` never hears one -- so the memoised walk from the checks above
// would otherwise answer from a reading of the folder taken before them. See
// `syncClearWalkCache`.
await A.page.evaluate(() => window.DaimondCore.syncClearWalkCache());
const ignored = await A.page.evaluate(() => window.DaimondCore.syncFolderShare());
const ignSet = await A.page.evaluate(async (scope) => {
	const col = await window.DaimondCore.collectSync();
	const inline = Object.keys(col.files);
	const ix = window.DaimondCloud.index();
	const manifests = Object.keys(ix).filter(k => k.indexOf(scope) === 0);
	return { inline, manifests, complete: col.filesComplete };
}, SCOPE);
const all = ignSet.inline.concat(ignSet.manifests);
check('no compiled PDF travels — the built-in floor, and the reason a rebuild does not wake the fleet',
	!all.some(p => /\.pdf$/i.test(p)),
	all.filter(p => /\.pdf$/i.test(p)).slice(0, 3).join(', ') || '0 of 5 PDFs');
check('nor the archive tree the folder\'s own .gitignore names',
	!all.some(p => p.indexOf(SCOPE + '/archive') === 0),
	all.filter(p => p.indexOf(SCOPE + '/archive') === 0).length + ' paths');
check('nor the font zips it names by glob',
	!all.some(p => /\.zip$/i.test(p)), all.filter(p => /\.zip$/i.test(p)).slice(0, 2).join(', ') || 'none');
check('nor what .oreignore adds on top of it — a second ignore file refines the first',
	!all.some(p => p.indexOf(SCOPE + '/revision/') === 0));
check('and the chapters are all still there',
	all.indexOf(CHAPTER) >= 0 && all.indexOf(MAIN) >= 0,
	`${ignored.files} files shared, ${ignored.ignored} left out`);

// ═══════════════════════════════════════════════════════════════════════
// THE FIRST PARCEL — what it weighs, and where
// ═══════════════════════════════════════════════════════════════════════
console.log('\n— the first parcel —');

const bodiesBefore = cloud.bodies.length;
await round(A, B);
await round(A, B);
const firstBodies = cloud.bodies.slice(bodiesBefore).filter(b => b.dev === 'A');
const heaviest = firstBodies.reduce((m, b) => Math.max(m, b.bytes), 0);
const DOOR = 8 * 1024 * 1024;
note(`A's pushes: ${firstBodies.map(b => (b.bytes / 1048576).toFixed(2) + ' MiB').join(', ')}`);

// THE INLINE SECTION IS WHAT THE COLLECTOR SPENT, not what JSON makes of it. The soft
// cap is spent in characters of content; a quoted, escaped copy of the same text is
// several per cent larger, and measuring that against the cap fails a build that is
// inside it. Both numbers are reported -- the wire carries the second.
const weights = await A.page.evaluate(async () => {
	const col = await window.DaimondCore.collectSync();
	const content = Object.keys(col.files).reduce((n, k) => n + col.files[k].length, 0);
	return { content, inline: JSON.stringify(col.files).length,
		parcel: JSON.stringify(col).length,
		chunked: JSON.stringify(col.chunked).length,
		manifests: Object.keys(col.chunked).length,
		files: Object.keys(col.files).length };
});
note(`A's parcel: ${(weights.parcel / 1048576).toFixed(2)} MiB, of which `
	+ `${(weights.inline / 1024).toFixed(0)} kB is ${weights.files} inline files `
	+ `(${(weights.content / 1024).toFixed(0)} kB of content) and `
	+ `${(weights.chunked / 1024).toFixed(0)} kB is ${weights.manifests} chunk manifests`);
check('every push A made is under Steel\'s 8 MiB front door — measured on the BODY, not the parcel',
	firstBodies.length > 0 && heaviest < DOOR,
	`heaviest ${(heaviest / 1048576).toFixed(2)} MiB of ${(DOOR / 1048576).toFixed(0)} MiB`);
check('A\'s inline section is inside a desktop\'s soft ceiling — the rest offloaded',
	weights.content <= 1024 * 1024 && weights.manifests > 0,
	`${(weights.content / 1024).toFixed(0)} kB of 1024 kB, ${weights.manifests} manifests`);

const bWeights = await B.page.evaluate(async () => {
	const col = await window.DaimondCore.collectSync();
	return { content: Object.keys(col.files).reduce((n, k) => n + col.files[k].length, 0),
		files: Object.keys(col.files).length };
});
check('and B\'s — the phone\'s — is inside the tighter mobile ceiling it spends to',
	bWeights.content <= 256 * 1024, `${(bWeights.content / 1024).toFixed(0)} kB of 256 kB`);

// ═══════════════════════════════════════════════════════════════════════
// GUARD 0 — B holds the book
// ═══════════════════════════════════════════════════════════════════════
console.log('\n— B holds the book, in two rounds —');

// READ AS BYTES, not through `file_read`. The tool has a presentation layer on it -- a
// truncation ceiling and a note saying which filesystem answered -- and comparing its
// answer against the disk would be comparing a rendering with a file.
const held = await B.page.evaluate(async (a) => {
	const text = {}, miss = [];
	for (const p of a.want) {
		try { text[p] = await window.DaimondCloud.readText(p); } catch (e) { miss.push(p); }
	}
	const ix = window.DaimondCloud.index();
	return { text, miss, manifests: Object.keys(ix).filter(k => k.indexOf(a.scope + '/') === 0).length };
}, { want: [CHAPTER, MAIN], scope: SCOPE });
const aText = await A.page.evaluate(async (want) => {
	const out = {};
	const root = window.DaimondFiles.folder();
	for (const p of want) {
		const segs = p.split('/');
		let d = root;
		for (let i = 0; i < segs.length - 1; i++) d = await d.getDirectoryHandle(segs[i]);
		out[p] = await (await (await d.getFileHandle(segs[segs.length - 1])).getFile()).text();
	}
	return out;
}, [CHAPTER, MAIN]);
check('B holds the chapter\'s text, byte for byte as it is on A\'s disk',
	held.text[CHAPTER] === aText[CHAPTER] && (held.text[CHAPTER] || '').length > 1000,
	held.miss.length ? 'missing: ' + held.miss.join(', ') : (held.text[CHAPTER] || '').length + ' chars');
check('and the document it is a chapter of', held.text[MAIN] === aText[MAIN]);
check('and a manifest for every asset that was too big to ride inline',
	held.manifests > 50, `${held.manifests} manifests under ${SCOPE}`);

// ═══════════════════════════════════════════════════════════════════════
// THE FLAG IS A FACT ABOUT THE ATTACHMENT, so it travels and is drawn
// ═══════════════════════════════════════════════════════════════════════
//
// The flag rides in the link's own record, which rides inside the Diamond -- so a
// device that cannot open the folder at all still shows whether the folder is expected
// to reach it, and a person who turns the flag on at their desk sees it on everything
// else without touching anything there.
console.log('\n— the flag travels with its Diamond, and the far panel redraws —');

// A THIRD ATTACHMENT, made for this and left OFF at the end, so the two flagged roots
// the ceiling cells below measure are exactly the two they were. A folder rather than a
// file, because a folder is the ordinary case and the control is offered on both.
const FLAGTEST = 'aside/flagtest';
const flagLink = await A.page.evaluate(async (a) => {
	const root = window.DaimondFiles.folder();
	let dir = root;
	for (const seg of a.dir.split('/')) dir = await dir.getDirectoryHandle(seg, { create: true });
	const fh = await dir.getFileHandle('note.md', { create: true });
	const w  = await fh.createWritable();
	await w.write(new TextEncoder().encode('# marked now, flagged in a moment\n'));
	await w.close();
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	// The reference names this device, exactly as the marks above do, which since R2
	// is not itself the grant -- `markHere` below presses it on A.
	const ref = window.DaimondAttach.ref('dir', a.dir);
	const linkId = await app.add_link(a.id, 'diamond:' + a.id, ref, 'holds', '', 'user');
	return { linkId, ref };
}, { id: did, dir: FLAGTEST });
await markHere(A, did, flagLink.ref, { linkId: flagLink.linkId });
await A.page.evaluate(async () => {
	await window.DaimondCore.loadDiamonds();
	window.DaimondCore.syncClearWalkCache();
});

/// The attachment rows B is DRAWING, with the three things the flag shows on them.
///
/// `pressed` is `aria-pressed` on the ⇄ button, which since R2 is `a.share` -- the
/// ROW'S flag AND this device's OWN entry, together (O2). B has no native access to
/// the folder at all, so it can never hold an entry and its button can never read
/// pressed, whatever A's row says; `shared` (the badge, from `rowShare`) is what
/// still tells B the folder is shared FROM elsewhere, titled `dws.shared_there`.
const bRows = async () => B.page.evaluate(() => Array.from(
	document.querySelectorAll('#panel-work .files-row.attached')).map((e) => {
		const btn = e.querySelector('.files-share');
		return {
			path:     e.dataset.path || '',
			shared:   !!e.querySelector('.files-badge.files-shared'),
			pressed:  btn ? btn.getAttribute('aria-pressed') : '',
			disabled: btn ? !!btn.disabled : null,
		};
	}));
const said = (rs) => rs.map(r => `${r.path}=${r.pressed}${r.shared ? '+badge' : ''}`).join(' | ')
	|| 'no attached rows drawn';

// B HAS TO BE LOOKING AT IT for the redraw to be a claim about anything: the rows are
// drawn when the panel lists the Diamond's own tree, and what is under test below is
// whether a flag moved on A repaints them with nobody touching B.
await round(A, B);
await B.page.evaluate(() => window.DaimondCore.loadDiamonds());
await B.page.waitForTimeout(800);
await B.page.$$eval('.diamond-box', els => els[0] && els[0].click());
await B.page.waitForTimeout(1200);
await B.page.evaluate(() => window.DaimondPanels && DaimondPanels.show('work'));
await B.page.waitForTimeout(800);
await B.page.click('#panel-work [data-act="refresh"]', { force: true }).catch(() => {});
await B.page.waitForTimeout(900);
await B.page.click('.files-scope-chip[data-scope="diamond"]', { force: true }).catch(() => {});
await B.page.waitForTimeout(1500);

let rows = await bRows();
const rowFor = (rs, p) => rs.find(r => r.path === p) || {};
// R2/O2: B can never press ⇄ itself (it has no native folder to hold), so its own
// button reads NOT pressed and disabled whatever the row says -- this is the
// opposite of what this asserted before R2, when B's `pressed` read the row's flag
// directly. The badge (`shared`) is the property that carries "shared from A" now.
check("B draws the Diamond's attachments and says which are shared, though it can never press ⇄ itself",
	rowFor(rows, SCOPE).shared === true && rowFor(rows, SCOPE).pressed === 'false'
		&& rowFor(rows, SCOPE).disabled === true
	&& rowFor(rows, FLAGTEST).shared === false && rowFor(rows, FLAGTEST).pressed === 'false',
	said(rows));

// ── the flag goes on at A, and nobody touches B ──────────────────────
// R2/O2: the row's flag AND this device's (A's) own entry, both -- `markHere`'s job,
// on a mark already pressed here (above) and needing only the second grant.
await markHere(A, did, flagLink.ref, { linkId: flagLink.linkId, press: false, share: true });
await A.page.evaluate(async () => {
	await window.DaimondCore.loadDiamonds();
	window.DaimondCore.syncClearWalkCache();
});
const onA = await A.page.evaluate(() => window.DaimondCore.syncFolderShare());
check('flagging a second folder on A puts it in what A shares, beside the first',
	onA.roots.indexOf(FLAGTEST) >= 0 && onA.roots.indexOf(SCOPE) >= 0 && onA.left.length === 0,
	`roots [${onA.roots.join(', ')}]`);
await round(A, B);
await B.page.waitForTimeout(1200);
rows = await bRows();
check("and B's panel redraws on its own: the attachment nobody touched here now reads as shared FROM ANOTHER DEVICE, never as pressed here",
	rowFor(rows, FLAGTEST).pressed === 'false' && rowFor(rows, FLAGTEST).disabled === true
		&& rowFor(rows, FLAGTEST).shared === true,
	said(rows));

// ── and off again, which is the same journey backwards ───────────────
await A.page.evaluate(async (a) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.set_link_share(a.id, a.linkId, false);
	await window.DaimondCore.loadDiamonds();
	window.DaimondCore.syncClearWalkCache();
}, { id: did, linkId: flagLink.linkId });
const offA = await A.page.evaluate(() => window.DaimondCore.syncFolderShare());
check('taking the flag off stops A sharing that folder, and leaves the other flagged root alone',
	offA.roots.indexOf(FLAGTEST) < 0 && offA.roots.indexOf(SCOPE) >= 0,
	`roots [${offA.roots.join(', ')}]`);
await round(A, B);
await B.page.waitForTimeout(1200);
rows = await bRows();
check('and B hears that too — the flag is one fact, drawn wherever the attachment is drawn',
	rowFor(rows, FLAGTEST).pressed === 'false' && rowFor(rows, FLAGTEST).shared === false,
	said(rows));

// ═══════════════════════════════════════════════════════════════════════
// THE WRITE-BACK
// ═══════════════════════════════════════════════════════════════════════
console.log('\n— B edits, and A\'s folder gets the bytes —');

const EDIT = aText[CHAPTER] + '\n// edited on the phone\n';
await B.page.evaluate(async (a) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.run_tool_outcome('file_write', JSON.stringify({ path: a.p, content: a.text }));
}, { p: CHAPTER, text: EDIT });
await push(B); await pull(A);

const onDisk = await A.page.evaluate(async (p) => {
	const segs = p.split('/');
	let d = window.DaimondFiles.folder();
	for (let i = 0; i < segs.length - 1; i++) d = await d.getDirectoryHandle(segs[i]);
	return await (await (await d.getFileHandle(segs[segs.length - 1])).getFile()).text();
}, CHAPTER);
check('one round, and the file in the real folder has the phone\'s exact bytes',
	onDisk === EDIT, onDisk === EDIT ? `${onDisk.length} chars`
		: `disk ${onDisk.length} chars, phone ${EDIT.length}`);

// ── The conflict rule ────────────────────────────────────────────────
console.log('\n— both moved: the disk stands, and theirs lands beside it —');

await round(A, B);					// settle, so both sides agree on the base
const BASE = onDisk;
const FROM_DISK = BASE + '\n// and then edited on the desktop, on disk\n';
const FROM_PHONE = BASE + '\n// meanwhile, on the phone\n';
await A.page.evaluate(async (a) => {
	const segs = a.p.split('/');
	let d = window.DaimondFiles.folder();
	for (let i = 0; i < segs.length - 1; i++) d = await d.getDirectoryHandle(segs[i]);
	const fh = await d.getFileHandle(segs[segs.length - 1]);
	const w = await fh.createWritable();
	await w.write(new TextEncoder().encode(a.text));
	await w.close();
}, { p: CHAPTER, text: FROM_DISK });
await B.page.evaluate(async (a) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.run_tool_outcome('file_write', JSON.stringify({ path: a.p, content: a.text }));
}, { p: CHAPTER, text: FROM_PHONE });
await push(B); await pull(A);

const after = await A.page.evaluate(async (a) => {
	const segs = a.p.split('/');
	let d = window.DaimondFiles.folder();
	for (let i = 0; i < segs.length - 1; i++) d = await d.getDirectoryHandle(segs[i]);
	const disk = await (await (await d.getFileHandle(segs[segs.length - 1])).getFile()).text();
	const names = [];
	for await (const n of d.keys()) names.push(n);
	const copies = names.filter(n => n.indexOf('.conflict-') > 0);
	let copy = '';
	if (copies.length) { try { copy = await (await (await d.getFileHandle(copies[0])).getFile()).text(); }
		catch (e) { copy = ''; } }
	return { disk, copies, copy, noted: window.DaimondCore.syncLastConflicts() };
}, { p: CHAPTER });
check('the disk copy is untouched — never clobbered', after.disk === FROM_DISK,
	after.disk === FROM_DISK ? '' : 'the desktop\'s edit was overwritten');
check('the phone\'s version lands beside it, named for the device and the moment',
	after.copies.length === 1 && /\.conflict-[0-9a-f]{1,8}-\d{8}T\d{6}\.typ$/.test(after.copies[0]),
	after.copies.join(', ') || 'no conflict copy');
check('and it is the phone\'s bytes in it', after.copy === FROM_PHONE);
check('and the merge said so, rather than leaving it to be found',
	Array.isArray(after.noted) && after.noted.length === 1 && after.noted[0].path === CHAPTER,
	JSON.stringify(after.noted || []).slice(0, 120));

// ═══════════════════════════════════════════════════════════════════════
// PAST THE INLINE CEILING, AND STILL BOTH WAYS
// ═══════════════════════════════════════════════════════════════════════
console.log('\n— a file too big to ride inline crosses too —');

// `SYNC_FILE_MAX` is 128 kB, and past it a file NEVER rides inline: it travels as a
// chunk manifest and nothing else. `applyChunked` opened on `filesSyncable`, which is
// the answer to a DIFFERENT question -- may this device commit an index -- so a
// folder-mounted device merged no index at all. A phone's edit of anything this size
// therefore reached cloud storage and stopped: the desktop adopted no manifest, never
// learned the file had changed, and the folder the user actually works in never heard
// about it, while every small file crossed in one round.
const BIG = SCOPE + '/notes_from_the_phone.md';
const BIG_TEXT = '= Notes\n' + 'a line the phone wrote, past the inline ceiling\n'.repeat(4200);
await B.page.evaluate(async (a) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.run_tool_outcome('file_write', JSON.stringify({ path: a.p, content: a.text }));
}, { p: BIG, text: BIG_TEXT });
const bigOnB = await B.page.evaluate(async (p) => {
	const col = await window.DaimondCore.collectSync();
	// THE PARCEL, which is what actually crosses: `chunked` is the index it carries.
	// `large` is the collector's own working set and never leaves the device, so
	// asking the parcel for it reads undefined and says nothing.
	return { inline: !!(col.files && col.files[p] != null),
		carried: !!(col.chunked && col.chunked[p]),
		manifest: !!window.DaimondCloud.index()[p] };
}, BIG);
check('the phone cannot carry it inline at all, so the parcel carries a manifest or nothing',
	bigOnB.inline === false && bigOnB.carried === true && bigOnB.manifest === true,
	`inline=${bigOnB.inline} in the parcel's index=${bigOnB.carried} manifest=${bigOnB.manifest}`);

await push(B); await pull(A); await push(B); await pull(A);
const bigOnDisk = await A.page.evaluate(async (p) => {
	const f = await window.DaimondCloud.fileUnderRoot(window.DaimondFiles.folder(), p);
	return f ? await f.text() : null;
}, BIG);
check('and the real folder has its bytes — the merge wrote a chunked file onto the disk',
	bigOnDisk === BIG_TEXT,
	bigOnDisk === null ? 'it is not in the folder at all'
		: `${bigOnDisk.length} chars of ${BIG_TEXT.length}`);
const bigOutside = await A.page.evaluate(async () => {
	// NOTHING OUTSIDE THE SHARE, and the phone's own sandbox is full of paths that are
	// not this folder's to hold: `system/`, `diamonds/`, whatever the user made there.
	const names = [];
	for await (const n of window.DaimondFiles.folder().keys()) names.push(n);
	return names.sort();
}, null);
check('and nothing arrived outside the roots the user marked in',
	bigOutside.indexOf('system') < 0 && bigOutside.indexOf('diamonds') < 0,
	bigOutside.join(', ').slice(0, 90));

// THE OTHER DIRECTION, which is the one the phone lives in: a desktop file too big to
// ride inline is a ☁ row, named and sized, that the file tools report as being in cloud
// storage rather than missing.
const fontLeaf = FONT.slice(FONT.lastIndexOf('/') + 1);
const cloudRow = await B.page.evaluate(async (a) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const res = await app.run_tool_outcome('file_list',
		JSON.stringify({ path: a.font.slice(0, a.font.lastIndexOf('/')) }));
	return { away: window.DaimondCloud.awayPaths()[a.font] | 0,
		held: await window.DaimondCloud.isHeld(a.font),
		text: (res && res.text) || '' };
}, { font: FONT });
check('and a desktop file too big to ride inline is a ☁ row on the phone — named, sized, not held',
	cloudRow.away > 0 && cloudRow.held === false
	&& new RegExp(fontLeaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\n]*in cloud storage')
		.test(cloudRow.text),
	`${(cloudRow.away / 1024).toFixed(0)} kB away, held=${cloudRow.held}`);

// ═══════════════════════════════════════════════════════════════════════
// GUARD 4 — no deletion by absence
// ═══════════════════════════════════════════════════════════════════════
console.log('\n— guard 4: a tombstone deletes; absence never does —');

// THE WHOLE FOLDER, COUNTED BEFORE AND AFTER, and it is the check the named-file ones
// cannot make. A file rides inline for one round and becomes a chunk reference the round
// after its chunks are confirmed -- so on the far device it LEAVES the inline census
// while being perfectly safe, and a rule that read that gap as a deletion would empty
// somebody's disk one offloaded file at a time while every named assertion stayed green.
// MEASURED ON THE DISK, not on the census that reads it. The claim is about the
// user's files, and a census count moves for reasons a file never leaves the folder
// for -- so the folder's own handle is walked, and a red says which path went.
const diskList = (s) => s.page.evaluate(async () => {
	const out = [];
	async function walk(dir, at) {
		for await (const [name, h] of dir.entries()) {
			const p = at ? at + '/' + name : name;
			if (h.kind === 'directory') await walk(h, p); else out.push(p);
		}
	}
	await walk(window.DaimondFiles.folder(), '');
	return out.sort();
});
const diskBefore = await diskList(A);
const shareBefore = await A.page.evaluate(() => window.DaimondCore.syncFolderShare());
await round(A, B); await round(A, B); await round(A, B);
const diskAfter = await diskList(A);
const shareAfter = await A.page.evaluate(() => window.DaimondCore.syncFolderShare());
const wentMissing = diskBefore.filter(p => diskAfter.indexOf(p) < 0);
check('three settling rounds take NOT ONE FILE off the real folder — an offloaded file is not a deleted one',
	wentMissing.length === 0,
	wentMissing.length ? `gone from the disk: ${wentMissing.slice(0, 4).join(', ')}`
		: `${diskBefore.length} files on disk, all still there`);
check('and the census still sees the same folder it saw before them',
	shareAfter.files === shareBefore.files,
	`${shareBefore.files} → ${shareAfter.files} files in the census`);
// NAMED, NOT COUNTED. A tombstone is an instruction to delete a file off another
// device's disk, so a red here has to say which file and why this device stopped
// carrying it -- inline, offloaded, in cloud storage, or genuinely gone.
const bTombs = await B.page.evaluate(async () => {
	const t = Object.keys(window.DaimondCore.syncFileTombs());
	const col = await window.DaimondCore.collectSync();
	const why = {};
	for (const p of t) {
		why[p] = (col.files && col.files[p] != null ? 'inline'
			: (window.DaimondCloud.index()[p] ? 'a manifest in cloud storage' : 'nowhere'))
			+ (await window.DaimondCloud.isHeld(p) ? ', held here' : ', not held here');
	}
	return { n: t.length, why: why, complete: col.filesComplete };
});
check('and the phone has raised no tombstone for a file it merely stopped carrying inline',
	bTombs.n === 0, `${bTombs.n} tombstone(s) on B`
		+ (bTombs.n ? ', census complete ' + bTombs.complete + ': '
			+ Object.keys(bTombs.why).map(k => k + ' is ' + bTombs.why[k]).join('; ') : ''));

// AND THE CONDITION IS MADE, NOT WAITED FOR.
//
// The defect this section exists about -- a file this device FREED after uploading it,
// read at the far end as one the user deleted -- arose in the first run of this file
// from storage pressure happening to free something. That is not a condition an
// assertion may rest on: `--break awayisgone` ran GREEN on 2026-09-14, 50 ok, with the
// census's third half deliberately removed, because nothing that run freed a file. An
// assertion that pins nothing is worse than no assertion, so the phone is made to do
// it, by the door the panel's own Free button uses.
//
// A file small enough to ride inline first, so it enters the fork point; then rewritten
// past the inline ceiling, so it offloads; then freed. The path is then in the fork
// point, in NEITHER `files` nor `large`, and the census is complete -- which is exactly
// the shape of a deletion and exactly not one.
const FREED = SCOPE + '/freed_on_the_phone.md';
const FREED_BIG = '= Notes\n' + 'a line the phone wrote and then stopped holding\n'.repeat(4200);
const writeOnB = (path_, text) => B.page.evaluate(async (a) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.run_tool_outcome('file_write', JSON.stringify({ path: a.p, content: a.text }));
}, { p: path_, text: text });
await writeOnB(FREED, 'a note small enough to ride inline\n');
await round(A, B); await round(A, B);				// it enters both fork points
await writeOnB(FREED, FREED_BIG);					// and now it is too big to ride there
// COLLECTED, NOT PUSHED, and the difference is the whole of what this reproduces. A
// SUCCESSFUL PUSH rewrites the fork point to the inline files alone
// (`commitFileBaseline`), so a path that has just been offloaded leaves it -- and a
// path outside the fork point cannot be tombstoned whatever the census says. The state
// that cost a file is the one BETWEEN a push and the next: the fork point still holds
// the path from when it rode inline, the collect has offloaded it, and the copy is
// then freed. A `push` here made `--break awayisgone` pass, which is the same defect
// in the test as in the code.
const freed = await B.page.evaluate(async (p) => {
	await window.DaimondCore.collectSync();			// offloads it; the fork point keeps it
	const before = await window.DaimondCloud.isHeld(p);
	const res = await window.DaimondCloud.evict(p);
	const col = await window.DaimondCore.collectSync();
	return { before: before, res: String(res), held: await window.DaimondCloud.isHeld(p),
		away: window.DaimondCloud.awayPaths()[p] | 0,
		inline: !!(col.files && col.files[p] != null),
		complete: col.filesComplete,
		tombed: Object.prototype.hasOwnProperty.call(window.DaimondCore.syncFileTombs(), p) };
}, FREED);
check('the phone offloads a file and then frees its own copy, keeping only the reference',
	freed.before === true && freed.held === false && freed.away > 0 && freed.inline === false
	&& freed.complete === true,
	`${freed.res.slice(0, 70)}; held=${freed.held} away=${freed.away} B, census complete ${freed.complete}`);
check('and raises NO tombstone for it — a file in cloud storage is not a file that went',
	freed.tombed === false, freed.tombed ? 'a tombstone for a file it still has in the cloud' : '');
await push(B); await pull(A);
const freedOnDisk = await A.page.evaluate(async (p) => {
	const f = await window.DaimondCloud.fileUnderRoot(window.DaimondFiles.folder(), p);
	return f ? (await f.text()).length : null;
}, FREED);
check('and the desktop still holds it on disk — the deletion that used to travel',
	freedOnDisk === FREED_BIG.length,
	freedOnDisk === null ? 'it was deleted off the real folder'
		: `${freedOnDisk} chars of ${FREED_BIG.length}`);

// THE TWO FILES ARE CHOSEN FROM WHAT B ACTUALLY HOLDS, not named by hand. Which text
// files ride inline is a function of the budget, so a hand-picked path is a check that
// silently stops being about anything the day the budget moves.
const NEVER = FONT;								// far over the inline ceiling; B has a reference, never the bytes
const HAD = await B.page.evaluate(async (a) => {
	const col = await window.DaimondCore.collectSync();
	const mine = Object.keys(col.files)
		.filter(p => p.indexOf(a.scope + '/') === 0 && p !== a.chapter && p !== a.main).sort();
	return mine[0] || '';
}, { scope: SCOPE, chapter: CHAPTER, main: MAIN });
check('B holds inline text of its own to delete', !!HAD, HAD || 'none');
// A BREAK RUN MUST SHOW ALL ITS REDS. With nothing shared there is no file to delete and
// every read below would throw on an empty path, which ends the run and hides the checks
// after it -- so the section is skipped rather than allowed to take the process down.
if (!HAD) { check('guard 4 cannot be asked without a shared file', false, 'skipped'); }
else {

const bHas = await B.page.evaluate(async (a) => {
	let had = false;
	try { had = (await window.DaimondCloud.readText(a.had)).length > 0; } catch (e) { had = false; }
	return { had, neverManifest: !!(window.DaimondCloud.index()[a.never]),
		neverLocal: await window.DaimondCloud.isHeld(a.never) };
}, { had: HAD, never: NEVER });
check('B genuinely holds the file it is about to delete, and has never held the font',
	bHas.had === true && bHas.neverLocal === false,
	`chapter=${bHas.had} font on B: manifest=${bHas.neverManifest} bytes=${bHas.neverLocal}`);

await B.page.evaluate(async (p) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.run_tool_outcome('file_delete', JSON.stringify({ path: p }));
}, HAD);
const tombed = await B.page.evaluate(async (p) => {
	await window.DaimondCore.collectSync();
	const t = window.DaimondCore.syncFileTombs();
	return { has: Object.prototype.hasOwnProperty.call(t, p), n: Object.keys(t).length };
}, HAD);
check('B writes a tombstone for the file it held and deleted — a deletion is news, not a gap',
	tombed.has === true, `${tombed.n} tombstone(s)`);

await push(B); await pull(A);
const folderAfter = await A.page.evaluate(async (a) => {
	const at = async (p) => {
		const segs = p.split('/');
		let d = window.DaimondFiles.folder();
		try {
			for (let i = 0; i < segs.length - 1; i++) d = await d.getDirectoryHandle(segs[i]);
			await d.getFileHandle(segs[segs.length - 1]);
			return true;
		} catch (e) { return false; }
	};
	return { had: await at(a.had), never: await at(a.never), main: await at(a.main) };
}, { had: HAD, never: NEVER, main: MAIN });
check('the tombstoned file goes from the real folder — a deletion does travel',
	folderAfter.had === false);
check('the font B NEVER RECEIVED is still on the disk — absence is not an instruction',
	folderAfter.never === true);
check('and so is everything else', folderAfter.main === true);

// AND THE HASH IS THE WHOLE OF THE SAFETY: a tombstone for bytes the disk no longer
// holds is not honoured. B deletes a second file it holds; A edits the same file on disk
// before the tombstone lands.
const MOVED = await B.page.evaluate(async (a) => {
	const col = await window.DaimondCore.collectSync();
	const mine = Object.keys(col.files)
		.filter(p => p.indexOf(a.scope + '/') === 0 && p !== a.chapter && p !== a.main && p !== a.had).sort();
	return mine[0] || '';
}, { scope: SCOPE, chapter: CHAPTER, main: MAIN, had: HAD });
check('and another to delete while the disk moves under it', !!MOVED, MOVED || 'none');
if (!MOVED) throw new Error('no second inline file to test the hash guard with');
await round(A, B);
const movedBase = await A.page.evaluate(async (p) => {
	const segs = p.split('/');
	let d = window.DaimondFiles.folder();
	for (let i = 0; i < segs.length - 1; i++) d = await d.getDirectoryHandle(segs[i]);
	return await (await (await d.getFileHandle(segs[segs.length - 1])).getFile()).text();
}, MOVED);
await B.page.evaluate(async (p) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.run_tool_outcome('file_delete', JSON.stringify({ path: p }));
	await window.DaimondCore.collectSync();
}, MOVED);
await A.page.evaluate(async (a) => {
	const segs = a.p.split('/');
	let d = window.DaimondFiles.folder();
	for (let i = 0; i < segs.length - 1; i++) d = await d.getDirectoryHandle(segs[i]);
	const w = await (await d.getFileHandle(segs[segs.length - 1])).createWritable();
	await w.write(new TextEncoder().encode(a.text));
	await w.close();
}, { p: MOVED, text: movedBase + '\n// still being worked on here\n' });
await push(B); await pull(A);
const movedAfter = await A.page.evaluate(async (p) => {
	const segs = p.split('/');
	let d = window.DaimondFiles.folder();
	try {
		for (let i = 0; i < segs.length - 1; i++) d = await d.getDirectoryHandle(segs[i]);
		return await (await (await d.getFileHandle(segs[segs.length - 1])).getFile()).text();
	} catch (e) { return null; }
}, MOVED);
check('a tombstone for bytes the disk no longer holds is NOT honoured — an edit outlives a delete',
	movedAfter !== null && movedAfter.indexOf('still being worked on here') > 0,
	movedAfter === null ? 'the file was deleted despite the edit' : `${movedAfter.length} chars`);

}

// ═══════════════════════════════════════════════════════════════════════
// GUARD 3 — content, never time
// ═══════════════════════════════════════════════════════════════════════
console.log('\n— guard 3: nothing that travels carries a clock —');

const manifests = await A.page.evaluate((scope) => {
	const ix = window.DaimondCloud.index();
	const mine = Object.keys(ix).filter(k => k.indexOf(scope + '/') === 0);
	const stamped = mine.filter(k => (ix[k].mtime | 0) !== 0 || (ix[k].at | 0) !== 0);
	return { n: mine.length, stamped: stamped.slice(0, 3), keyed: mine.filter(k => !!ix[k].key).length };
}, SCOPE);
check('not one of the shared folder\'s manifests carries a modification time or an upload time',
	manifests.n > 0 && manifests.stamped.length === 0,
	manifests.stamped.length ? manifests.stamped.join(', ') : `${manifests.n} manifests, clean`);
check('and every one of them is keyed on its content', manifests.keyed === manifests.n,
	`${manifests.keyed} of ${manifests.n}`);

// SYNCTHING'S OWN CASE, which is what the guard is for: the file is rewritten with
// identical bytes and a new modification time, exactly as a replication would leave it.
// Nothing may be uploaded and the parcel must not move.
const putsBefore = cloud.puts.length;
const vBefore = cloud.mailbox.version;
const rewrote = await A.page.evaluate(async (paths) => {
	let n = 0;
	for (const p of paths) {
		const segs = p.split('/');
		let d = window.DaimondFiles.folder();
		try {
			for (let i = 0; i < segs.length - 1; i++) d = await d.getDirectoryHandle(segs[i]);
			const h = await d.getFileHandle(segs[segs.length - 1]);
			const bytes = await (await h.getFile()).arrayBuffer();
			const w = await h.createWritable();
			await w.write(bytes);						// the same bytes, a new modification time
			await w.close();
			n++;
		} catch (e) { /* named a file the fixture has not got */ }
	}
	return n;
}, [FONT, CHAPTER, MAIN]);
check('three files are rewritten with their own bytes, as a replication leaves them',
	rewrote === 3, `${rewrote} of 3`);
await push(A); await pull(B); await push(B); await pull(A);
check('a file rewritten with its own bytes at a new time uploads NOTHING',
	cloud.puts.length === putsBefore, `${cloud.puts.length - putsBefore} put batch(es)`);

// ── Two idle rounds push nothing ─────────────────────────────────────
await round(A, B);
const quietFrom = cloud.pushes.length;
await round(A, B);
await round(A, B);
check('two idle rounds push nothing at all — the pair is at rest over a shared folder',
	cloud.pushes.length === quietFrom,
	`${cloud.pushes.length - quietFrom} push(es), mailbox v${cloud.mailbox.version} (was v${vBefore})`);

const fixed = await A.page.evaluate(async () => {
	const one = JSON.stringify(await window.DaimondCore.collectSync());
	const two = JSON.stringify(await window.DaimondCore.collectSync());
	if (one === two) return { same: true, moved: [] };
	const a = JSON.parse(one), b = JSON.parse(two);
	return { same: false, moved: [...new Set([...Object.keys(a), ...Object.keys(b)])]
		.filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])) };
});
check('and A\'s parcel is a fixed point — two idle collects, byte-identical',
	fixed.same === true, fixed.same ? '' : 'moved: ' + fixed.moved.join(', '));

// ═══════════════════════════════════════════════════════════════════════
// THE PHONE TYPESETS THE BOOK IT ONLY HAS REFERENCES TO
// ═══════════════════════════════════════════════════════════════════════
console.log('\n— the phone holds the pictures and the fonts as ☁ rows, and still compiles —');

// WHAT THE FOLDER SHARE IS FOR, and the half that does not work by arriving. The phone
// now holds the book -- but the heavy half of it as references, which is exactly the
// half a compile needs: `gather` (src/wasm/typst.rs) reads the workspace, and a path
// that is not there is SKIPPED. A missing PICTURE is survivable, because typst then
// refuses and names the file. A missing FONT is not: phase 4 walks the font directories
// and finds only whatever was small enough to ride inline, and the book is typeset in
// the wrong faces with its line breaks and page count wrong and NOTHING on screen to
// say so. A wrong book is worse than a refused one, so the compile fetches first.
//
// DRIVEN THROUGH THE BUTTON. `dev/verify_typstbutton.mjs` makes the point this borrows:
// a check that calls `Wasm.typst_compile_project` itself passes whether or not anything
// a person can press is wired to it.
const PROBE = SCOPE + '/probe_phone.typ';
// Its own document, so `mainFor` answers the probe and not the 281-page book: the mark
// `dev` and the panel both read is `#show: doc.with(`, and a local `doc` is one.
const PROBE_SRC = '#let doc(body) = body\n#show: doc.with()\n'
	+ '#set page(width: 120mm, height: 90mm, margin: 8mm)\n'
	+ '#set text(font: "Cormorant Garamond", size: 11pt)\n'
	+ '= A page the phone drew\n\n'
	+ '#image("' + PIC.p + '", width: 40mm)\n';
await A.page.evaluate(async (a) => {
	const segs = a.p.split('/');
	let d = window.DaimondFiles.folder();
	for (let i = 0; i < segs.length - 1; i++) d = await d.getDirectoryHandle(segs[i], { create: true });
	const fh = await d.getFileHandle(segs[segs.length - 1], { create: true });
	const w = await fh.createWritable();
	await w.write(new TextEncoder().encode(a.text));
	await w.close();
}, { p: PROBE, text: PROBE_SRC });
// A raw OPFS write again -- see the same call in guard 2 -- so the push below must
// not build its parcel from a walk that predates this document.
await A.page.evaluate(() => window.DaimondCore.syncClearWalkCache());
await round(A, B); await round(A, B);

const before = await B.page.evaluate(async (a) => {
	const held = [];
	for (const f of a.faces) { if (await window.DaimondCloud.isHeld(f)) held.push(f); }
	return { faces: held.length, pic: await window.DaimondCloud.isHeld(a.pic),
		probe: await window.DaimondCloud.isHeld(a.probe),
		rows: (window.DaimondFiles.compileCloudRows(a.probe) || []).length };
}, { faces: FACES.map(f => SCOPE + '/' + f.p), pic: SCOPE + '/' + PIC.p, probe: PROBE });
check('the phone has the document but not the picture it needs — the state a compile meets',
	before.probe === true && before.pic === false && before.faces < FACES.length
	&& before.rows > 0,
	`${before.faces} of ${FACES.length} faces on the phone, the picture held: ${before.pic}, `
	+ `${before.rows} ☁ row(s) the compile would look for`);

// `DaimondDoc.show` is the door `file_show` in src/tools.rs calls, and it is the one
// that opens the Doc panel and routes the file to the editor. Then the button itself.
await B.page.evaluate(async (q) => { await window.DaimondDoc.show(q); }, PROBE);
await B.page.waitForTimeout(2500);
const hasBtn = await B.page.evaluate(() => !!document.querySelector('[data-act="compile"]'));
check('the document opens on the phone with a ⚙ Compile button on it', hasBtn === true);
if (!hasBtn) { check('the compile cannot be asked for without the button', false, 'skipped'); }
else {
await B.page.evaluate(() => document.querySelector('[data-act="compile"]').click());
// The 30 MB compiler is built on first use and the fonts come down before it runs, so
// this waits on the OUTCOME rather than on a timer.
let said = '', errored = false;
for (let i = 0; i < 300; i++) {
	await B.page.waitForTimeout(1000);
	const st = await B.page.evaluate(() => {
		const m = document.querySelector('.files-view-msg');
		return { t: m ? (m.textContent || '') : '', err: !!(m && m.classList.contains('err')) };
	});
	said = st.t; errored = st.err;
	if (said && !/compiling|fetching|récup|取得|가져오|获取|obten|Buscando|geholt/i.test(said)) break;
}
const after = await B.page.evaluate(async (a) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const held = [];
	for (const f of a.faces) { if (await window.DaimondCloud.isHeld(f)) held.push(f); }
	const cut = a.probe.lastIndexOf('/');
	const list = await app.run_tool_outcome('file_list', JSON.stringify({ path: a.probe.slice(0, cut) }));
	return { faces: held.length, pic: await window.DaimondCloud.isHeld(a.pic),
		listing: (list && list.text) || '' };
}, { faces: FACES.map(f => SCOPE + '/' + f.p), pic: SCOPE + '/' + PIC.p, probe: PROBE });
check('the compile brought the picture down rather than typesetting without it',
	after.pic === true, after.pic ? '' : 'still a ☁ row, so the page below cannot be right');
check('and EVERY face of the book, not the handful small enough to ride inline — the silent half',
	after.faces === FACES.length, `${before.faces} → ${after.faces} of ${FACES.length} faces`);
check('and the phone drew pages: a PDF beside the document, and no error on the row',
	/probe_phone-preview\.pdf/.test(after.listing) && errored === false,
	errored ? 'the panel says: ' + said.slice(0, 160) : said.slice(0, 120));
}

// ═══════════════════════════════════════════════════════════════════════
// GUARD 1a — the walk gives up AT the ceiling, not after walking past it
// ═══════════════════════════════════════════════════════════════════════
// Measured on the owner's own desktop after the folder share first shipped: a
// walk of the whole marked-in tree, ~22,500 `file_list` calls at ~5 ms each,
// THREE TIMES a round, only to conclude "over the ceiling, share nothing" -- a
// verdict the first few hundred listings already had. Hundreds of directories
// here, each with one file, so the tree's bytes cross the ceiling only after
// most of them are listed -- proving the walk stops AT that point rather than
// paying for the rest of the tree to reach the same answer.
console.log('\n— guard 1a: the walk stops at the ceiling instead of walking the whole tree —');

const MANYDIRS  = 300;
const DIR_BYTES = 1024 * 1024;			// 300 MiB of directories, over the 200 MiB ceiling
await A.page.evaluate(async (a) => {
	const root = window.DaimondFiles.folder();
	let scope = root;
	for (const seg of a.scope.split('/')) scope = await scope.getDirectoryHandle(seg, { create: true });
	const base = await scope.getDirectoryHandle('manydirs', { create: true });
	// Sparse (`truncate`, no bytes ever written): the walk reads the size the
	// listing reports, so what fills the ceiling costs nothing but directory
	// entries and file handles.
	for (let i = 0; i < a.n; i++) {
		const d  = await base.getDirectoryHandle('d' + String(i).padStart(4, '0'), { create: true });
		const fh = await d.getFileHandle('f.bin', { create: true });
		const w  = await fh.createWritable();
		await w.truncate(a.bytes);
		await w.close();
	}
}, { scope: SCOPE, n: MANYDIRS, bytes: DIR_BYTES });

// Raw OPFS again, so the memoised walk from whatever ran just above this must not
// answer for the tree as it stood before these 300 directories existed.
await A.page.evaluate(() => window.DaimondCore.syncClearWalkCache());
const walkCost = await A.page.evaluate(async () => {
	const mod  = await import('/pkg/oxedyne_daimond.js');
	const orig = mod.DaimondApp.prototype.run_tool_outcome;
	let calls  = 0;
	mod.DaimondApp.prototype.run_tool_outcome = function (name, argsJson) {
		if (name === 'file_list') calls++;
		return orig.call(this, name, argsJson);
	};
	const t0 = performance.now();
	let s;
	try { s = await window.DaimondCore.syncFolderShare(); }
	finally { mod.DaimondApp.prototype.run_tool_outcome = orig; }
	return { ms: performance.now() - t0, calls: calls, left: s.left };
});
check('the walk issues fewer file_list calls than the tree has directories',
	walkCost.calls > 0 && walkCost.calls < MANYDIRS,
	`${walkCost.calls} call(s) for ${MANYDIRS} directories`);
check('and gives its verdict in under 5s rather than walking the whole tree',
	walkCost.ms < 5000, `${walkCost.ms.toFixed(0)} ms`);
check('and the verdict is still "this folder is over the ceiling", not a partial share of it',
	walkCost.left.length === 1 && walkCost.left[0].root === SCOPE,
	walkCost.left.map(r => `${r.root} ${(r.bytes / 1048576).toFixed(0)} MiB`).join(', ') || 'no verdict');

// A SECOND CALLER, straight after the first and asking about the same roots --
// exactly what the parcel, the baseline commit and the pull merge do inside one
// round. The memoised walk answers from `_walkPlanCache` and lists nothing again.
const walkCost2 = await A.page.evaluate(async () => {
	const mod  = await import('/pkg/oxedyne_daimond.js');
	const orig = mod.DaimondApp.prototype.run_tool_outcome;
	let calls  = 0;
	mod.DaimondApp.prototype.run_tool_outcome = function (name, argsJson) {
		if (name === 'file_list') calls++;
		return orig.call(this, name, argsJson);
	};
	try { await window.DaimondCore.syncFolderShare(); }
	finally { mod.DaimondApp.prototype.run_tool_outcome = orig; }
	return { calls: calls };
});
check('and a second caller in the same round reuses the memoised walk — no file_list at all',
	walkCost2.calls === 0, `${walkCost2.calls} call(s) on the second caller`);

// ═══════════════════════════════════════════════════════════════════════
// GUARD 1 — the ceiling
// ═══════════════════════════════════════════════════════════════════════
console.log('\n— guard 1: the folder over the ceiling is left out by name; the other still goes —');

// A file past the ceiling, made by extending rather than writing: the walk reads the
// size the listing reports, and the refusal comes before a byte is read.
const grew = await A.page.evaluate(async (a) => {
	const root = window.DaimondFiles.folder();
	let d = root;
	for (const s of a.scope.split('/')) d = await d.getDirectoryHandle(s, { create: true });
	const fh = await d.getFileHandle('huge.bin', { create: true });
	const w = await fh.createWritable();
	await w.truncate(a.bytes);
	await w.close();
	return (await (await fh.getFile())).size;
}, { scope: SCOPE, bytes: 210 * 1024 * 1024 });
note(`a ${(grew / 1048576).toFixed(0)} MiB file appears in the folder`);

// Same raw write, same reason: the verdict below must count `huge.bin`, not answer
// from guard 1a's walk of the tree as it stood before it existed.
await A.page.evaluate(() => window.DaimondCore.syncClearWalkCache());
const over = await A.page.evaluate(async (a) => {
	const s = await window.DaimondCore.syncFolderShare();
	const col = await window.DaimondCore.collectSync();
	const row = document.querySelector('.left-banner-msg');
	const files = Object.keys(col.files);
	return { s, files: files.length, complete: col.filesComplete,
		underScope: files.filter(f => f === a.scope || f.indexOf(a.scope + '/') === 0).length,
		hasDeep: files.indexOf(a.deep) >= 0,
		msg: row ? row.textContent : '' };
}, { scope: SCOPE, deep: DEEP_FILE });
check('the folder over the ceiling shares no part of itself — not a prefix of it',
	over.underScope === 0 && over.s.roots.indexOf(SCOPE) < 0,
	`${over.underScope} inline file(s) under ${SCOPE}, roots [${over.s.roots.join(', ')}]`);
check('and the OTHER flagged root goes on travelling — the ceiling is per folder, not per share',
	over.s.roots.length === 1 && over.s.roots[0] === DEEP_FILE && over.hasDeep === true,
	`roots [${over.s.roots.join(', ')}], ${DEEP_FILE} carried: ${over.hasDeep}`);
check('and the verdict names the folder and its size, and the census calls itself incomplete',
	over.complete === false && over.s.left.length === 1 && over.s.left[0].root === SCOPE
	&& over.s.left[0].bytes > 200 * 1024 * 1024 && over.s.max === 200 * 1024 * 1024,
	`complete=${over.complete}, left `
	+ (over.s.left.map(r => `${r.root} ${(r.bytes / 1048576).toFixed(0)} MiB`).join(', ') || 'nothing'));
check('and the panel NAMES the folder, with the ceiling in the sentence',
	over.msg.indexOf(SCOPE) >= 0 && /\b\d[\d.]*\s?(MB|GB)\b/.test(over.msg)
	&& over.msg.indexOf('200') >= 0,
	over.msg.slice(0, 150) || 'no banner');

// AND THE FAR END DELETES NOTHING because of it: a census with a root left out is
// incomplete and carries no tombstones, so B keeps every file it was given.
const bBefore = await B.page.evaluate(async () => Object.keys((await window.DaimondCore.collectSync()).files).length);
await push(A); await pull(B);
const bAfter = await B.page.evaluate(async (p) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const r = await app.run_tool_outcome('file_read', JSON.stringify({ path: p }));
	return { n: Object.keys((await window.DaimondCore.collectSync()).files).length,
		chapter: !!(r && r.outcome === 'done') };
}, MAIN);
check('and B loses nothing when that folder goes over — a refusal is not a deletion',
	bAfter.chapter === true && bAfter.n >= bBefore,
	`${bBefore} → ${bAfter.n} inline files on B, the document still readable: ${bAfter.chapter}`);

} catch (e) {
	console.log('  FAIL the run itself — ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
	bad.push('the run itself');
} finally {
	if (A) await A.close().catch(() => {});
	if (B) await B.close().catch(() => {});
}

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) process.exit(1);
