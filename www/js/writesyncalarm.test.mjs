/* ============================================================
   Test — a synced file lost to a full OPFS raises the standing files alarm,
   and a landed write clears it (reopen rehearsal, "Left" item 1, 2026-09-25).

   THE BUG. `writeSyncFile` (www/js/daimond.js) answered `false` on a refused
   OPFS write and `applyFiles` moved on to the next path; nothing told the
   person a file from their other device never arrived, and the chip went on
   reading "Synced".

   THE FIX. `writeSyncFile` tells `QuotaExceededError` apart from every other
   `file_write` failure by reading it out of `run_tool_outcome`'s `text` (the
   tool layer's own `Error: … QuotaExceededError: …`, `src/wasm/opfs.rs`
   `js_err`), and raises `storageAlarm` under source `'files'`; a write that
   then lands clears it. A failure that is NOT a quota refusal (a folder lost,
   a name the store refuses) raises nothing here — that is a different fault
   with its own path.

   `writeSyncFile` is lifted out of daimond.js by source (`dev/syncprobe.mjs`
   `sliceDaimond`, the pattern `stampfloor.test.mjs` and `synclaws.test.mjs`
   use), with `storageAlarm`/`storageAlarmClear`/`tOr` stubbed so this runs
   without a browser.

   Run:  node www/js/writesyncalarm.test.mjs
         node www/js/writesyncalarm.test.mjs --break noquotacheck
   ============================================================ */
import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 ? process.argv[i + 1] : '';
})();

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

function makeWriteSyncFile() {
	const w = makeWindow({});
	const alarms = [];		// { why, src }, in call order
	const clears = [];		// src, in call order
	const stub = {
		storageAlarm:      (why, src) => { alarms.push({ why: String(why || ''), src: src || 'store' }); },
		storageAlarmClear: (src) => { clears.push(src || 'store'); },
		tOr:               (key, fallback) => fallback,
	};
	// `--break noquotacheck` reverts to the release 5.1.1 body: answer `!!r && r.outcome ===
	// 'done'` and nothing else, which is the silent drop this file is about.
	if (BREAK === 'noquotacheck') {
		w.writeSyncFile = async function (app, path, content) {
			try {
				var cut = String(path).lastIndexOf('/');
				if (cut > 0) { try { await app.run_tool_outcome('dir_create', JSON.stringify({ path: path.slice(0, cut) })); } catch (e) {} }
				var r = await app.run_tool_outcome('file_write', JSON.stringify({ path: path, content: content }));
				return !!r && r.outcome === 'done';
			} catch (e) { return false; }
		};
	} else {
		const sliced = sliceDaimond(w, ['writeSyncFile'], stub);
		w.writeSyncFile = sliced.fns.writeSyncFile;
	}
	return { writeSyncFile: w.writeSyncFile, alarms, clears };
}

/// A fake `app.run_tool_outcome`: 'dir_create' always lands; 'file_write' answers the
/// outcome this case is testing.
function fakeApp(fileWriteOutcome) {
	return {
		run_tool_outcome: async (name, argsJson) => {
			if (name === 'dir_create') return { text: '', outcome: 'done' };
			if (name === 'file_write') return fileWriteOutcome;
			throw new Error('unexpected tool ' + name);
		},
	};
}

console.log('writesyncalarm: a refused OPFS write raises the standing files alarm, a landed write clears it\n');

// ── QUOTA: a QuotaExceededError refusal raises storageAlarm under source 'files' ──
{
	const { writeSyncFile, alarms, clears } = makeWriteSyncFile();
	const app = fakeApp({
		text: "Error: file_write: OPFS: write 'notes/small.txt' failed: "
			+ "QuotaExceededError: The quota has been exceeded..",
		outcome: 'failed',
	});
	const done = await writeSyncFile(app, 'notes/small.txt', 'from the other device');
	check('QUOTA: writeSyncFile answers false (the write did not land)', done === false, String(done));
	if (BREAK === 'noquotacheck') {
		check('QUOTA (broken): no alarm is raised — the bug this file is about', alarms.length === 0, JSON.stringify(alarms));
	} else {
		check('QUOTA: the files alarm is raised, source \'files\'',
			alarms.length === 1 && alarms[0].src === 'files', JSON.stringify(alarms));
		// Round 2 (lane K, 2026-09-25): the owner ruled the files alarm shows the app's
		// EXISTING storage-full wording, not lane H's bespoke `store.files_full` prose --
		// one message for one condition. `store.full` (2026-08-02, `storeReason`'s own
		// fallback) is that existing string, so the check matches it rather than "full".
		check('QUOTA: the alarm names the browser\'s storage, out of room',
			alarms.length === 1 && /storage/i.test(alarms[0].why) && /no room left/i.test(alarms[0].why),
			JSON.stringify(alarms));
	}
	check('QUOTA: nothing is cleared on a failed write', clears.length === 0, JSON.stringify(clears));
}

// ── LANDS: a write that lands clears the files alarm ──────────────────────
{
	const { writeSyncFile, alarms, clears } = makeWriteSyncFile();
	const app = fakeApp({ text: '', outcome: 'done' });
	const done = await writeSyncFile(app, 'notes/small.txt', 'from the other device');
	check('LANDS: writeSyncFile answers true', done === true, String(done));
	check('LANDS: nothing is alarmed on a write that lands', alarms.length === 0, JSON.stringify(alarms));
	if (BREAK === 'noquotacheck') {
		check('LANDS (unpatched body still clears nothing — it never alarmed): skip', true, '');
	} else {
		check('LANDS: the files alarm clears, source \'files\'', clears.length === 1 && clears[0] === 'files', JSON.stringify(clears));
	}
}

// ── RAISED THEN CLEARED: the same path, refused then retried and landed ───
if (BREAK !== 'noquotacheck') {
	const { writeSyncFile, alarms, clears } = makeWriteSyncFile();
	const app1 = fakeApp({
		text: "Error: file_write: OPFS: write 'notes/small.txt' failed: QuotaExceededError: full.",
		outcome: 'failed',
	});
	await writeSyncFile(app1, 'notes/small.txt', 'from the other device');
	const app2 = fakeApp({ text: '', outcome: 'done' });
	await writeSyncFile(app2, 'notes/small.txt', 'from the other device');
	check('RAISED THEN CLEARED: exactly one alarm and one clear, both source \'files\'',
		alarms.length === 1 && alarms[0].src === 'files' && clears.length === 1 && clears[0] === 'files',
		JSON.stringify({ alarms, clears }));
}

// ── OTHER FAILURE: a non-quota refusal raises nothing here (a different fault, own path) ──
if (BREAK !== 'noquotacheck') {
	const { writeSyncFile, alarms, clears } = makeWriteSyncFile();
	const app = fakeApp({ text: "Error: file_write: refused — a folder outside the fence.", outcome: 'refused' });
	const done = await writeSyncFile(app, 'notes/small.txt', 'from the other device');
	check('OTHER FAILURE: writeSyncFile still answers false', done === false, String(done));
	check('OTHER FAILURE: no files alarm — QuotaExceededError is the one thing this raises on',
		alarms.length === 0, JSON.stringify(alarms));
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures ? 1 : 0);
