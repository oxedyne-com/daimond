// verify_sharedbaseline.mjs — the sync fork point records only what was SHARED.
//
// The baseline is the state both devices agreed on, and `applyFiles` reads it as
// exactly that: a path in the baseline that a COMPLETE remote census does not
// carry has been deleted there, so it is deleted here.
//
// It was written on the way out of a PULL, from everything this device happened
// to be holding. A file created locally and never yet sent anywhere was
// therefore entered as "agreed" by a pull that carried no news of it — and the
// other device's next complete census, which had never heard of the file,
// deleted it. Nothing was wrong on either side; the record of agreement was a
// record of a conversation that never happened.
//
// A file cannot be agreed until it has been sent, and the moment it has is a
// successful push. That is what `commitFileBaseline` is for and where sync.js
// already calls it.
//
// The second check is the cloud index's fork point, which had the same shape of
// fault for a different reason: `applyFiles` runs before `applyChunked` in
// `applySync` and rewrites the cloud baseline on its way out, so the chunk merge
// compared local against ITSELF. `localChanged` was false for every path, the
// remote won unconditionally, and cloud.js's both-sides-diverged branch could
// never run.
//
//   node dev/verify_sharedbaseline.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway: applySync is driven
// directly, which is what lets a "remote" parcel be fabricated with a known census.
import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

const PROFILE = scratch('pw', 'sharedbaseline');
fs.rmSync(PROFILE, { recursive: true, force: true });

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'sharedbaseline', profile: PROFILE, connect: false });
const { page } = s;

try {
	await page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.collectSync),
		null, { timeout: 15000 });
	await page.waitForTimeout(900);

	const write = (path, content) => page.evaluate(async (a) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		await app.run_tool('file_write', JSON.stringify({ path: a.path, content: a.content }));
	}, { path, content });

	const exists = (path) => page.evaluate(async (p) => {
		try {
			const dir = await DaimondCloud.opfsRoot();
			await dir.getFileHandle(p);
			return true;
		} catch (e) { return false; }
	}, path);

	const baseline = () => page.evaluate(() => {
		try { return JSON.parse(localStorage.getItem('daimond-sync-filebase') || '{}'); }
		catch (e) { return {}; }
	});

	// ── The setup: one file both devices know, one only this device has ──
	await write('shared.md', 'both devices have this\n');
	await write('mine-only.md', 'made here, never sent anywhere\n');
	await page.waitForTimeout(400);

	// A parcel from the other device that carries the shared file and, truthfully,
	// has never heard of the local one. `filesComplete` is what entitles the
	// receiver to delete by absence, so it is the whole point of the fixture.
	const report = await page.evaluate(async () => {
		const mine = await DaimondCore.collectSync();
		const remote = {
			v: 2, chats: [], tombs: {}, msgTombs: {},
			files: { 'shared.md': mine.files['shared.md'] },
			filesComplete: true,
			diamonds: [], diamondTombs: {}, chunked: {},
		};
		const r = await DaimondCore.applySync(remote);
		return r && r.failed ? r.failed : [];
	});
	check(report.length === 0, 'the fabricated parcel merges cleanly', report.join(','));

	// ── 1. A file that never left must survive ──────────────────────
	check(await exists('mine-only.md'),
		'a file this device has never sent survives a complete census that lacks it');
	check(await exists('shared.md'), 'and the file both devices hold is still here');

	const base1 = await baseline();
	check(!Object.prototype.hasOwnProperty.call(base1, 'mine-only.md'),
		'and it is NOT recorded as agreed, having never been sent',
		JSON.stringify(Object.keys(base1)));
	check(Object.prototype.hasOwnProperty.call(base1, 'shared.md'),
		'while the shared file IS', JSON.stringify(Object.keys(base1)));

	// ── 2. A second round must not change its mind ──────────────────
	// The bug deleted on the round AFTER the one that recorded the agreement, so
	// one pull is not enough to prove anything.
	await page.evaluate(async () => {
		const mine = await DaimondCore.collectSync();
		await DaimondCore.applySync({
			v: 2, chats: [], tombs: {}, msgTombs: {},
			files: { 'shared.md': mine.files['shared.md'] },
			filesComplete: true, diamonds: [], diamondTombs: {}, chunked: {},
		});
	});
	await page.waitForTimeout(400);
	check(await exists('mine-only.md'),
		'and it survives a SECOND complete census, which is when it used to go');

	// ── 3. A real deletion is still honoured ────────────────────────
	// The fix must not turn the delete-by-absence rule off: a file that WAS
	// shared, and that a complete census no longer carries, is still gone.
	await page.evaluate(async () => {
		await DaimondCore.applySync({
			v: 2, chats: [], tombs: {}, msgTombs: {},
			files: {}, filesComplete: true, diamonds: [], diamondTombs: {}, chunked: {},
		});
	});
	await page.waitForTimeout(400);
	check(!(await exists('shared.md')),
		'a file that WAS shared and is now absent from a complete census is deleted');
	check(await exists('mine-only.md'),
		'and the never-sent file is still not collateral');
	const base2 = await baseline();
	check(!Object.prototype.hasOwnProperty.call(base2, 'shared.md'),
		'the deleted path leaves the fork point with it', JSON.stringify(Object.keys(base2)));

	// ── 4. The cloud fork point is not moved by a pull ──────────────
	// `applyFiles` used to commit it on its way out, and `applyChunked` runs
	// after it in `applySync` -- so the chunk merge compared this device's index
	// against a copy of itself taken moments earlier. Every path read as
	// "unchanged locally", the remote won unconditionally, and the branch that
	// preserves a doubly-diverged file as `.synced` was unreachable. A pull must
	// leave the fork point where the last successful PUSH put it.
	//
	// The key is `daimond-cloud-base`. This check first named it
	// `daimond-sync-cloudbase`, which nothing in the app writes -- so it wrote a
	// sentinel nobody could disturb and passed without testing anything.
	await page.evaluate(() => {
		localStorage.setItem('daimond-cloud-base', JSON.stringify({ 'sentinel.bin': 'from-the-last-push' }));
	});
	await page.evaluate(async () => {
		await DaimondCore.applySync({
			v: 2, chats: [], tombs: {}, msgTombs: {},
			files: {}, filesComplete: false, diamonds: [], diamondTombs: {}, chunked: {},
		});
	});
	await page.waitForTimeout(400);
	const cloudBase = await page.evaluate(() => {
		try { return JSON.parse(localStorage.getItem('daimond-cloud-base') || '{}'); }
		catch (e) { return {}; }
	});
	check(cloudBase['sentinel.bin'] === 'from-the-last-push',
		'a pull leaves the cloud fork point where the last push put it',
		JSON.stringify(cloudBase));

} finally {
	await s.close();
}

console.log(bad === 0 ? '\nall checks passed' : `\n${bad} check(s) FAILED`);
process.exit(bad === 0 ? 0 : 1);
