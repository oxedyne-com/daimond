// verify_appstate_sync.mjs — the app's own state under `system/` is not a workspace file.
//
// The three-device soak of 2026-09-25 (R2, `specs/daimond_diag_r52_20260925.md`): every device's
// usage digest rode the parcel's `files` section. The digest says "Counted on this device ... not
// sent anywhere", and it is made from the `daimond-signals` counters, which are `local` and never
// travel; so each device rewrote a synced file with its own numbers and the devices never agreed.
// The guide mirror (made from the build) and the agents' transcripts (made from the tab's run list)
// are the same kind of thing, under the same `system/` directories the engine pins to the browser
// store (`APP_STATE_DIRS`, src/tools.rs).
//
// One page, the sandbox workspace, no gateway: the collect and the merge are called directly, as
// `verify_offlinedelete` does.
//
//   1. The census leaves the three directories out and still carries a workspace file.
//   2. A fork point an older build wrote, naming them, tombs none of them.
//   3. An older build's parcel carrying ITS digest, guide page and transcript does not go over
//      this device's own copies.
//   4. A complete census without them, against that fork point, deletes none of them here.
//   5. A landed push leaves them out of the fork point.

import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

const PROFILE = scratch('pw', 'appstatesync');
fs.rmSync(PROFILE, { recursive: true, force: true });

let bad = 0, good = 0;
const check = (pass, name, detail) => {
	if (pass) good++; else bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'appstatesync', profile: PROFILE, connect: false });
const { page } = s;

const DIGEST = 'system/usage/digest.md';
const GUIDE  = 'system/guide/appstate-probe.md';
const AGENT  = 'system/agents/appstate-probe.md';
const WORK   = 'notes/appstate-probe.md';
const OWN    = [DIGEST, GUIDE, AGENT];

try {
	await page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.collectSync && DaimondCore.toolsApp
		&& window.DaimondDiamond && DaimondDiamond.usageDigest), null, { timeout: 15000 });
	await page.waitForTimeout(900);

	// Through the doors the app itself uses: the digest's own writer, and the engine's store write
	// for the other two (both pinned to the browser store whatever workspace is open).
	const put = (path, content) => page.evaluate(async (a) => {
		const W = await import('/pkg/oxedyne_daimond.js');
		await W.store_write(a.path, a.content);
		return true;
	}, { path, content });
	const read = (path) => page.evaluate(async (p) => {
		const W = await import('/pkg/oxedyne_daimond.js');
		try { return await W.store_read(p); } catch (e) { return null; }
	}, path);
	const write = (path, content) => page.evaluate(async (a) => {
		const r = await DaimondCore.toolsApp().run_tool_outcome('file_write', JSON.stringify(a));
		return r ? r.outcome : 'none';
	}, { path, content });
	const collect = () => page.evaluate(async () => {
		const st = await DaimondCore.collectSync();
		return { files: st.files, complete: st.filesComplete, tombs: st.fileTombs || {} };
	});
	const baseline = () => page.evaluate(() => {
		try { return JSON.parse(localStorage.getItem('daimond-sync-filebase') || '{}'); }
		catch (e) { return {}; }
	});
	const apply = (files) => page.evaluate(async (files) => {
		const r = await DaimondCore.applySync({
			v: 3, chats: [], tombs: {}, msgTombs: {}, files, filesComplete: true, fileTombs: {},
			diamonds: [], diamondTombs: {}, chunked: {},
		});
		return r && r.failed ? r.failed : ['no report'];
	}, files);

	await page.evaluate(() => DaimondDiamond.usageDigest());
	check(await put(GUIDE, '# A guide page\n\nmirrored from this build\n'), 'setup: a guide page in the store');
	check(await put(AGENT, '# An agent\n\n- Status: done\n'), 'setup: an agent transcript in the store');
	check(await write(WORK, '# A workspace file\n') === 'done', 'setup: a workspace file');
	const mine = {};
	for (const p of OWN) mine[p] = await read(p);
	check(OWN.every((p) => typeof mine[p] === 'string' && mine[p].length > 0), 'setup: all three are held here',
		OWN.map((p) => p + '=' + (mine[p] || '').length).join(' '));

	// ── 1. The census ───────────────────────────────────────────────
	const c1 = await collect();
	check(c1.complete === true && typeof c1.files[WORK] === 'string', '1. the census is complete and carries the workspace file');
	const rode = OWN.filter((p) => p in c1.files);
	check(rode.length === 0, '1. and none of the app’s own state rides it', rode.join(', ') || 'none');

	// ── 2. A fork point an older build wrote ────────────────────────
	// An older build agreed on all three at its last landed push; this is what it left behind.
	await page.evaluate((a) => {
		const b = JSON.parse(localStorage.getItem('daimond-sync-filebase') || '{}');
		for (const p of a.own) b[p] = 'olderbuild:' + a.mine[p].length;
		localStorage.setItem('daimond-sync-filebase', JSON.stringify(b));
	}, { own: OWN, mine });
	const c2 = await collect();
	const tombed = OWN.filter((p) => p in c2.tombs);
	check(tombed.length === 0, '2. a fork point naming them tombs none of them', tombed.join(', ') || 'none');

	// ── 3. An older build's parcel, carrying its own copies ─────────
	const theirs = {};
	for (const p of OWN) theirs[p] = '# ANOTHER DEVICE\n\n' + p + ' as another device made it\n';
	const f3 = await apply(Object.assign({}, c1.files, theirs));
	check(f3.length === 0, '3. the older build’s parcel merges cleanly', f3.join(','));
	const over = [];
	for (const p of OWN) if ((await read(p)) !== mine[p]) over.push(p);
	check(over.length === 0, '3. and this device keeps its own digest, guide page and transcript',
		over.join(', ') || 'all kept');
	const side = [];
	for (const p of OWN) if ((await read(p + '.synced')) !== null) side.push(p + '.synced');
	check(side.length === 0, '3. with no conflict copy beside any of them', side.join(', ') || 'none');

	// ── 4. A complete census without them, against that fork point ──
	await page.evaluate((a) => {
		const b = JSON.parse(localStorage.getItem('daimond-sync-filebase') || '{}');
		for (const p of a.own) b[p] = a.hash[p];
		localStorage.setItem('daimond-sync-filebase', JSON.stringify(b));
	}, { own: OWN, hash: await page.evaluate((a) => {
		// The fork point's own fingerprint of each, so "unchanged since the fork" holds and only
		// the rule under test stands between the census and a deletion.
		const h = (s) => { let x = 5381; for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0; return (x >>> 0).toString(36) + ':' + s.length; };
		const out = {};
		for (const p of a.own) out[p] = h(a.mine[p]);
		return out;
	}, { own: OWN, mine }) });
	// What a 5.2 device sends: its workspace, without any of the three (on an older build the
	// census above carried them, so they are taken out here to put the same question to both).
	const bare = Object.assign({}, c1.files);
	for (const p of OWN) delete bare[p];
	const f4 = await apply(bare);
	check(f4.length === 0, '4. a census without them merges cleanly', f4.join(','));
	const lost = [];
	for (const p of OWN) if ((await read(p)) !== mine[p]) lost.push(p);
	check(lost.length === 0, '4. and deletes none of them here', lost.join(', ') || 'all kept');

	// ── 5. A landed push ────────────────────────────────────────────
	await page.evaluate(() => DaimondCore.syncCommitBaseline());
	const b5 = await baseline();
	const held = OWN.filter((p) => p in b5);
	check(held.length === 0 && WORK in b5, '5. the landed push leaves them out of the fork point',
		held.join(', ') || 'none held');
} catch (e) {
	check(false, 'verify_appstate_sync ran without throwing', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : String(e));
} finally {
	await s.close().catch(() => {});
}

console.log(bad === 0 ? `\nall ${good} checks passed` : `\n${bad} check(s) FAILED, ${good} passed`);
process.exit(bad === 0 ? 0 : 1);
