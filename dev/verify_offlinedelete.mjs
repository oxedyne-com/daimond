// verify_offlinedelete.mjs — a file deleted on a device whose push has not landed stays deleted.
//
// The three-device soak of 2026-09-25 (seed t1, `specs/daimond_sync_soak_20260925.md`, R1): the
// phone went offline, deleted a synced file, and came back after another device had pushed. Its
// push came back 409; the pull that answers a 409 merged the account's parcel, which still held
// the file, and `applyFiles` read "only the remote has it" as a new file and wrote it back. The
// retried push then carried it, and the deletion was lost on every device.
//
// Two faults made that: `noteFileTombs` took the path out of the fork point the moment the
// deletion was noticed, so the merge no longer knew both devices had once agreed on it; and the
// merge never asked the fork point when the file was missing here, only when it was missing
// there. The fork point is what both devices last AGREED on, and a local deletion is not an
// agreement: it leaves the fork point on the next landed push, like every other local change.
//
// Driven through `DaimondCore.applySync` with a fabricated parcel standing in for the pull that
// answers the 409, as `verify_sharedbaseline.mjs` does, and the fork point advanced through the
// push hook itself (`syncCommitBaseline`). No gateway.
//
//   1. A deletion whose push has not landed survives a pull of a parcel still holding the file
//      as it was deleted, and the next parcel carries it (no file, a tombstone, complete).
//   2. Edit beats delete: a parcel holding the file CHANGED since the fork point is adopted.
//   3. A file new to the account is adopted, deletion or no deletion elsewhere.
//   4. Once the deletion has landed, the same bytes arriving again are a restore made
//      elsewhere, and are adopted: nothing this device remembers can refuse them.
//   5. The parcel is still a fixed point after the deletion: two collects agree.
//
//   node dev/verify_offlinedelete.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777).
import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

const PROFILE = scratch('pw', 'offlinedelete');
fs.rmSync(PROFILE, { recursive: true, force: true });

let bad = 0, good = 0;
const check = (pass, name, detail) => {
	if (pass) good++; else bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'offlinedelete', profile: PROFILE, connect: false });
const { page } = s;

try {
	await page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.collectSync && DaimondCore.toolsApp),
		null, { timeout: 15000 });
	await page.waitForTimeout(900);

	// The editor's own door, as the soak drives it.
	const tool = (name, args) => page.evaluate(async (a) => {
		const r = await DaimondCore.toolsApp().run_tool_outcome(a.name, JSON.stringify(a.args));
		return r ? r.outcome : 'none';
	}, { name, args });
	const write = (path, content) => tool('file_write', { path, content });
	const del = (path) => tool('file_delete', { path });
	const read = (path) => page.evaluate(async (p) => {
		try {
			const dir = await DaimondCloud.opfsRoot();
			let h = dir;
			const parts = p.split('/');
			for (let i = 0; i < parts.length - 1; i++) h = await h.getDirectoryHandle(parts[i]);
			return await (await (await h.getFileHandle(parts[parts.length - 1])).getFile()).text();
		} catch (e) { return null; }
	}, path);
	const baseline = () => page.evaluate(() => {
		try { return JSON.parse(localStorage.getItem('daimond-sync-filebase') || '{}'); }
		catch (e) { return {}; }
	});
	// What this device would push now: its files, its word on completeness, its tombstones.
	const collect = () => page.evaluate(async () => {
		const st = await DaimondCore.collectSync();
		return { files: st.files, complete: st.filesComplete, tombs: st.fileTombs };
	});
	// The pull that answers a 409: the account's parcel, from another device, merged here.
	// `extra` is what that parcel holds beyond this device's own files.
	const pullWith = (extra) => page.evaluate(async (extra) => {
		const mine = await DaimondCore.collectSync();
		const files = Object.assign({}, mine.files, extra);
		const r = await DaimondCore.applySync({
			v: 3, chats: [], tombs: {}, msgTombs: {}, files, filesComplete: true, fileTombs: {},
			diamonds: [], diamondTombs: {}, chunked: {},
		});
		return r && r.failed ? r.failed : ['no report'];
	}, extra);
	// A landed push: the push hook advances the fork point to what was just sent.
	const landed = () => page.evaluate(() => DaimondCore.syncCommitBaseline());

	const GONE = '# gone.md\n\nwritten on this device, then deleted while offline\n';
	const EDIT = '# edited.md\n\nwritten on this device, then deleted while offline\n';
	const EDIT2 = '# edited.md\n\nCHANGED on the other device after the fork point\n';
	const FRESH = '# fresh.md\n\nmade on the other device while this one was offline\n';

	// ── The fork point: both devices hold both files ────────────────
	check(await write('offl/gone.md', GONE) === 'done', 'setup: gone.md written');
	check(await write('offl/edited.md', EDIT) === 'done', 'setup: edited.md written');
	await landed();
	const base0 = await baseline();
	check(!!base0['offl/gone.md'] && !!base0['offl/edited.md'], 'setup: both are in the fork point after a landed push',
		JSON.stringify(Object.keys(base0)));

	// ── Offline: both deleted here; the push that would carry it cannot land ──
	check(await del('offl/gone.md') === 'done', 'offline: gone.md deleted through the editor’s door');
	check(await del('offl/edited.md') === 'done', 'offline: edited.md deleted through the editor’s door');
	const offline = await collect();			// what the failed push collected
	check(!('offl/gone.md' in offline.files) && offline.complete === true && !!offline.tombs['offl/gone.md'],
		'the parcel that could not land carries the deletion: no file, complete, a tombstone',
		JSON.stringify({ complete: offline.complete, tomb: offline.tombs['offl/gone.md'] || null }));
	const base1 = await baseline();
	check(base1['offl/gone.md'] === base0['offl/gone.md'],
		'and the fork point still says what both devices last agreed on: a deletion is not an agreement',
		JSON.stringify({ was: base0['offl/gone.md'], now: base1['offl/gone.md'] || null }));

	// ── Back online: the push 409s, and the pull brings the account's parcel ──
	const failed = await pullWith({ 'offl/gone.md': GONE, 'offl/edited.md': EDIT2, 'offl/fresh.md': FRESH });
	check(failed.length === 0, 'the pull that answers the 409 merges cleanly', failed.join(','));

	// 1. The deletion survives.
	check(await read('offl/gone.md') === null,
		'1. a file deleted here, arriving unchanged since the fork point, is NOT written back',
		String(await read('offl/gone.md')).slice(0, 60));
	const after = await collect();
	check(!('offl/gone.md' in after.files) && after.complete === true && !!after.tombs['offl/gone.md'],
		'1. and the retried push carries the deletion: no file, complete, the tombstone',
		JSON.stringify({ has: 'offl/gone.md' in after.files, complete: after.complete }));

	// 2. Edit beats delete.
	check(await read('offl/edited.md') === EDIT2,
		'2. a file deleted here but CHANGED there since the fork point is adopted (an edit beats a delete)',
		String(await read('offl/edited.md')).slice(0, 60));

	// 3. A new file is a new file.
	check(await read('offl/fresh.md') === FRESH, '3. a file new to the account is adopted');

	// 5. Fixed point.
	const c1 = await collect(), c2 = await collect();
	check(JSON.stringify(c1) === JSON.stringify(c2), '5. two collects after the merge agree (the parcel is a fixed point)');

	// ── The deletion lands ──────────────────────────────────────────
	await landed();
	const base2 = await baseline();
	check(!('offl/gone.md' in base2), 'the landed push takes the deleted path out of the fork point',
		JSON.stringify(Object.keys(base2)));
	check(base2['offl/edited.md'] !== undefined && base2['offl/fresh.md'] !== undefined,
		'and records the adopted files as agreed', JSON.stringify(Object.keys(base2)));

	// 4. A restore made elsewhere, byte for byte what was deleted, is adopted.
	const failed2 = await pullWith({ 'offl/gone.md': GONE });
	check(failed2.length === 0, 'the later pull merges cleanly', failed2.join(','));
	check(await read('offl/gone.md') === GONE,
		'4. once the deletion has landed, the same bytes arriving again (a restore elsewhere) are adopted',
		String(await read('offl/gone.md')).slice(0, 60));
} finally {
	await s.close();
}

console.log(bad === 0 ? `\nall ${good} checks passed` : `\n${bad} check(s) FAILED, ${good} passed`);
process.exit(bad === 0 ? 0 : 1);
