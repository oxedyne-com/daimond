// gateway: live
// verify_locmerge.mjs -- a storage location that has not merged the version its device is at never pushes
// its files as that version (lane REV, 2026-09-27; specs/daimond_fixbrief_r522_rev_20260927.md). QFB4's
// `qfb4relay.mjs` (qa/r53-faultb3 @ c0696854), arms E1, E2 and N5, brought across; QFB4-1 in
// specs/daimond_fixqa_r53_faultb_20260925.md. Red on 45f7cf02 (5.2.1). A is a phone, B and C desktops; B
// moves between its Browser storage and a machine folder.
//
//   N5  Browser -> folder -> Browser, with a deletion and an edit made elsewhere meanwhile: the deletion lands and
//       stays, the edit is taken, nothing lands on B's disk; B's later restore ends on all three.
//   E1  A edits a Browser file while B is on its folder (whose parcel carries no Browser files); B returns to the
//       Browser. A's edit must survive on A and end on every device.
//   E2  B takes A's edit of a shared file in the Browser, then returns to its folder, whose disk still has the old
//       bytes. A's edit must survive and end on every device and on B's disk.
//
//   node dev/verify_locmerge.mjs [only=N5,E1,E2]
//   node dev/verify_locmerge.mjs --break noloc     # one merge note per device again: E1/E2 fail
//   node dev/verify_locmerge.mjs --break nowrite   # a refused adoption write counts as merged again: E2 fails
//
// E2b (B's folder takes the edit) stays red while the file tools' stale-read guard keeps a read made in one
// storage against the same path in another (src/tools.rs `stale_write`, keyed by path alone): B's write of the
// edit into its folder is refused, and B holds the version back (not merged) rather than reverting it.
import { open, signInAs, scratch, markHere } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : ''; })();
const BREAKS = {
	// The version merged, noted per device and not per storage location, as 5.2.1 notes it.
	// A merge whose write of a changed file was refused still counts as merged (5.2.1's applyFiles).
	nowrite: [
		{ file: 'js/daimond.js', find: 'if (unwritten.length) {', with: 'if (false) {' },
	],
	noloc: [
		{ file: 'js/sync.js', find: '&& !remergeOwed && locMerged(mergeLoc)) {', with: '&& !remergeOwed) {' },
		{ file: 'js/sync.js', find: 'if (serverVersion > 0 && !locMerged(pushLoc)) {', with: 'if (false) {' },
		{ file: 'js/sync.js', find: 'if (serverVersion > 0 && !locMerged(progLoc)) { schedule(); return; }', with: '' },
	],
};
if (BREAK && !BREAKS[BREAK]) { console.error(`unknown break '${BREAK}'`); process.exit(2); }
const WWW = new URL('../www', import.meta.url).pathname;
const PATCHED = new Map();
for (const spec of (BREAKS[BREAK] || [])) {
	const s0 = PATCHED.get(spec.file) ?? fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	if (s0.split(spec.find).length !== 2) { console.error(`break '${BREAK}': anchor not unique in ${spec.file}`); process.exit(2); }
	PATCHED.set(spec.file, s0.replace(spec.find, spec.with));
}
const route = PATCHED.size ? async (page) => {
	for (const [f, body] of PATCHED) await page.route('**/' + f, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
} : null;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

const ONLY = ((process.argv.find((a) => a.startsWith('only=')) || 'only=').slice(5) || 'N5,E1,E2').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const NAME = 'locm-' + process.pid;
const GWDIR = new URL('../gateway', import.meta.url).pathname;
const PROFILE = (x) => scratch('pw', NAME + '-' + x);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = { defect: [], clean: [], ok: 0, bad: [] };
const say = (arm, defect, what, detail) => { (defect ? tally.defect : tally.clean).push(arm);
	console.log(`  ${defect ? 'DEFECT' : 'clean '} ${arm}  ${what}${detail ? ' -- ' + String(detail).slice(0, 700) : ''}`); };
const ctl = (arm, pass, what, detail) => { if (pass) tally.ok++; else tally.bad.push(arm);
	console.log(`  ${pass ? 'ok  ' : 'FAIL'} [ctl] ${arm}  ${what}${detail ? ' -- ' + String(detail).slice(0, 700) : ''}`); };
const note = (t) => console.log('  note ' + String(t).slice(0, 6000));

const ready = (s) => s.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondCore && window.DaimondGateway
	&& DaimondGateway.state().authed), null, { timeout: 30000 }).catch(() => {});
async function paired(lead, label, extra = {}) {
	const d = await open({ name: NAME + '-' + label, signIn: false, connect: false, defaults: false, profile: PROFILE(label), route, ...extra });
	await d.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 30000 }).catch(() => {});
	const code = await lead.page.evaluate(() => DaimondPairing.create());
	await d.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await d.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(d, NAME);
	await ready(d);
	await sleep(2000);
	return d;
}
const tool = (s, name, args) => s.page.evaluate(async (a) => {
	const r = await DaimondCore.toolsApp().run_tool_outcome(a.name, JSON.stringify(a.args));
	return r ? r.outcome : 'none';
}, { name, args });
const write = async (s, p, text) => { const cut = p.lastIndexOf('/'); if (cut > 0) await tool(s, 'dir_create', { path: p.slice(0, cut) }); return tool(s, 'file_write', { path: p, content: text }); };
const readHere = (s, p) => s.page.evaluate(async (p) => {
	try { const f = await DaimondCloud.fileAt(p); return f ? await f.text() : null; } catch (e) { return null; }
}, p);
const has = async (s, p) => (await readHere(s, p)) !== null;
const recOf = (s, p) => s.page.evaluate((p) => { const t = DaimondCloud.tombs()[p]; return t ? { d: t.d, s: t.s } : null; }, p);
const forkOf = (s, p) => s.page.evaluate((p) => {
	const out = {};
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i);
		if (!/^daimond-sync-filebase(@|$)/.test(k)) continue;
		try { const m = JSON.parse(localStorage.getItem(k) || '{}'); if (m && m[p] !== undefined) out[k] = m[p]; } catch (e) { /* skip */ }
	}
	return out;
}, p);
const push = (s) => s.page.evaluate(async () => {
	try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older build */ }
	const r = window.DaimondSync.flush ? await DaimondSync.flush() : await DaimondSync.push();
	return r && typeof r === 'object' ? { ok: r.ok, version: r.version, why: r.why } : r;
}).then(async (r) => { await sleep(400); return r; }).catch((e) => 'threw ' + e);
const pull = (s) => s.page.evaluate(async () => {
	try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older build */ }
	return DaimondSync.pull();
}).then(() => sleep(400)).catch(() => {});
const offline = (s, on) => s.page.context().setOffline(!!on);
// The device's next `file_delete` answers `refused` without deleting (a delete that failed).
const failNextDelete = (s) => s.page.evaluate(() => {
	const app = DaimondCore.toolsApp();
	const orig = app.run_tool_outcome;
	window.__qfb4failed = 0;
	app.run_tool_outcome = async function (n) {
		if (n === 'file_delete') { app.run_tool_outcome = orig; window.__qfb4failed++; return { outcome: 'refused' }; }
		return orig.apply(this, arguments);
	};
});
const armPicker = (s, dir) => s.page.evaluate(async (dir) => {
	const root = await navigator.storage.getDirectory();
	const h = await root.getDirectoryHandle(dir, { create: true });
	h.queryPermission = async () => 'granted';
	h.requestPermission = async () => 'granted';
	window.showDirectoryPicker = async () => h;
}, dir);
const folderNow = (s) => s.page.evaluate(() => (window.DaimondFiles && DaimondFiles.folder()) ? DaimondFiles.folder().name : null);
async function chipTo(s, i, want) {
	await s.page.evaluate(() => window.DaimondPanels && DaimondPanels.open && DaimondPanels.open('work')); await sleep(500);
	await s.page.evaluate((i) => { const c = [...document.querySelectorAll('.files-mode-chip')]; if (c[i]) c[i].click(); }, i);
	const t0 = Date.now();
	while (Date.now() - t0 < 15000) { if ((await folderNow(s)) === want) return true; await sleep(200); }
	return false;
}
const toMachine = async (s, dir) => { await armPicker(s, dir); return chipTo(s, 1, dir); };
const toBrowser = (s) => chipTo(s, 0, null);
async function flagShare(s, root) {
	const m = await s.page.evaluate(async (root) => {
		const app = DaimondCore.diamondApp();
		const id = await app.create_diamond('Share ' + root);
		const ref = window.DaimondAttach.ref('dir', root);
		const linkId = await app.add_link(id, 'diamond:' + id, ref, 'holds', '', 'user');
		return { id, linkId, ref };
	}, root);
	await markHere(s, m.id, m.ref, { linkId: m.linkId, share: true });
	return s.page.evaluate(async () => { await DaimondCore.loadDiamonds(); DaimondCore.syncClearWalkCache(); const sh = await DaimondCore.syncFolderShare(); return sh ? sh.roots : null; });
}
const diskRead = (s, dir, p) => s.page.evaluate(async ({ dir, p }) => {
	try {
		const root = await navigator.storage.getDirectory();
		let d = await root.getDirectoryHandle(dir);
		const parts = p.split('/'); const name = parts.pop();
		for (const part of parts) d = await d.getDirectoryHandle(part);
		return await (await (await d.getFileHandle(name)).getFile()).text();
	} catch (e) { return null; }
}, { dir, p });
const diskWrite = (s, dir, p, text) => s.page.evaluate(async ({ dir, p, text }) => {
	const root = await navigator.storage.getDirectory();
	let d = await root.getDirectoryHandle(dir, { create: true });
	const parts = p.split('/'); const name = parts.pop();
	for (const part of parts) d = await d.getDirectoryHandle(part, { create: true });
	const w = await (await d.getFileHandle(name, { create: true })).createWritable(); await w.write(text); await w.close();
}, { dir, p, text });
let DEV = [];
async function settle(n = 3) { for (let i = 0; i < n; i++) for (const d of DEV) { await pull(d); await push(d); } for (const d of DEV) await pull(d); }
const TXT = (t) => `# ${t}\n\n${t}: written by qfb4relay, ${NAME}\n`;
let A = null, B = null, C = null;
const where = async (p) => ({ A: await has(A, p), B: await has(B, p), C: await has(C, p) });
const allGone = (w) => !w.A && !w.B && !w.C;
const allHere = (w) => w.A && w.B && w.C;

try {
	A = await open({ name: NAME, connect: false, defaults: false, profile: PROFILE('a'), ua: IPHONE, isMobile: true, touch: true, route });
	await ready(A);
	ctl('W', (await makePagePro(A.page, GWDIR, GW_URL)).pro === true, 'the account holds Pro');
	B = await paired(A, 'b');
	C = await paired(A, 'c');
	DEV = [A, B, C];
	const files = ['r/t1.md', 'r/t5.md', 'r/n2.md', 'r/n5.md', 'r/n7.md', 'r/e1.md', 'r/keep.md'];
	for (const p of files) await write(A, p, TXT(p));
	for (let i = 0; i < 8; i++) {
		await settle(1);
		const ok = [];
		for (const p of files) ok.push(allHere(await where(p)));
		if (ok.every(Boolean)) break;
	}
	const set = {}; for (const p of files) set[p] = await where(p);
	ctl('W', Object.values(set).every(allHere), 'setup: every r/ file on A, B and C', J(set));

	// ═══ T1: the owed copy carried beside the record; then a restore ═══════════
	if (want('T1') || want('T3')) {
		const P = 'r/t1.md', Y = await readHere(A, P);
		// B and C away, so neither's own sync engine reads A's push before C's delete is set to fail.
		await offline(B, true); await offline(C, true);
		ctl('T1', (await tool(A, 'file_delete', { path: P })) === 'done', 'A deletes r/t1.md');
		note('T1: A\'s push ' + J(await push(A)));
		await offline(A, true);
		await failNextDelete(C);
		await offline(C, false);
		await pull(C);
		const cOwes = { here: await has(C, P), failed: await C.page.evaluate(() => window.__qfb4failed), rec: await recOf(C, P) };
		ctl('T1', cOwes.here && cOwes.failed === 1 && cOwes.rec && cOwes.rec.d === 1, 'C\'s delete failed: it holds the copy and the record', J(cOwes));
		note('T1: C\'s push (carrying the owed copy and the record) ' + J(await push(C)));
		await offline(C, true);
		await offline(B, false);
		await pull(B);
		const bAfter = { here: await has(B, P), fork: await forkOf(B, P), rec: await recOf(B, P) };
		note('T1: B after reading C\'s parcel ' + J(bAfter));
		ctl('T1', !bAfter.here, 'B carries the deletion out on its agreed copy');
		// B's own push does not land before it reads the restore (it is away again, or its push meets a 409 and
		// pulls first): its landing would clear the path from its fork point and hide the fault.
		await offline(B, true);
		await offline(A, false);
		await pull(A);
		ctl('T1', (await write(A, P, Y)) === 'done', 'A restores r/t1.md byte for byte');
		note('T1: A\'s push (the restore) ' + J(await push(A)) + '; A\'s record ' + J(await recOf(A, P)));
		await offline(B, false);
		await pull(B);
		const bBack = { here: await has(B, P), fork: await forkOf(B, P), rec: await recOf(B, P) };
		note('T1: B after reading the restore ' + J(bBack));
		await push(B);
		await offline(C, false);
		await settle(3);
		const fin = await where(P);
		say('T1', !bBack.here || !allHere(fin), 'a byte-for-byte restore is refused by a device that deleted an owed copy, and deleted again everywhere',
			J({ B_takes_restore: bBack.here, end: fin, recs: { A: await recOf(A, P), B: await recOf(B, P), C: await recOf(C, P) } }));

		// ═══ T3: the second deletion ═════════════════════════════════════════
		if (want('T3')) {
			if (!allHere(fin)) note('T3: skipped (T1 left the file on ' + J(fin) + ')');
			else {
				ctl('T3', (await tool(B, 'file_delete', { path: P })) === 'done', 'B deletes r/t1.md on purpose');
				await push(B);
				await settle(3);
				const g = await where(P);
				say('T3', !allGone(g), 'the second deletion, after the restore, does not reach every device or does not stay',
					J({ end: g, recs: { A: await recOf(A, P), B: await recOf(B, P), C: await recOf(C, P) } }));
			}
		}
	}

	// ═══ T5: a plain restore after every device carried the deletion out ══════
	if (want('T5')) {
		const P = 'r/t5.md', Y = await readHere(A, P);
		ctl('T5', (await tool(A, 'file_delete', { path: P })) === 'done', 'A deletes r/t5.md');
		await push(A);
		await settle(2);
		ctl('T5', allGone(await where(P)), 'every device carried it out', J(await where(P)));
		ctl('T5', (await write(C, P, Y)) === 'done', 'C writes it back byte for byte');
		await push(C);
		await settle(3);
		const fin = await where(P);
		say('T5', !allHere(fin), 'a byte-for-byte restore does not end on every device, or does not stay',
			J({ end: fin, recs: { A: await recOf(A, P), B: await recOf(B, P), C: await recOf(C, P) } }));
	}
	// ═══ N2: a restore inside the deleter's own push window ═════════════════════
	if (want('N2')) {
		const P = 'r/n2.md', Y = await readHere(A, P);
		await offline(A, true);
		ctl('N2', (await tool(A, 'file_delete', { path: P })) === 'done', 'A deletes r/n2.md, away');
		note('N2: A\'s push, away ' + J(await push(A)) + '; A\'s record ' + J(await recOf(A, P)));
		ctl('N2', (await write(A, P, Y)) === 'done', 'A writes it back byte for byte before any push lands');
		await offline(A, false);
		note('N2: A\'s push ' + J(await push(A)) + '; A\'s record ' + J(await recOf(A, P)));
		await settle(3);
		const fin = await where(P);
		say('N2', !allHere(fin), 'a restore made inside the deleter\'s own push window does not end on every device',
			J({ end: fin, recs: { A: await recOf(A, P), B: await recOf(B, P), C: await recOf(C, P) } }));
	}

	// ═══ N5: Browser, then a machine folder, then back ═════════════════════════
	if (want('N5')) {
		const P5 = 'r/n5.md', P7 = 'r/n7.md', Y5 = await readHere(A, P5);
		await diskWrite(B, '.n5f', 'dshare/b.md', TXT('dshare/b.md'));
		ctl('N5', await toMachine(B, '.n5f'), 'B opens its machine folder');
		ctl('N5', J(await flagShare(B, 'dshare')) === J(['dshare']), 'B shares dshare/ alone');
		await push(B);
		await settle(1);
		ctl('N5', (await tool(A, 'file_delete', { path: P5 })) === 'done', 'A deletes r/n5.md');
		const E7 = TXT(P7) + 'edited on A while B is on its folder\n';
		await write(A, P7, E7);
		await push(A);
		await offline(A, true);
		await pull(B); await push(B);
		const bRec = await recOf(B, P5);
		ctl('N5', !!bRec && bRec.d === 1, 'B, on its folder, holds and relays the record', J(bRec));
		await offline(B, true);
		await pull(C);
		const c5 = await has(C, P5);
		ctl('N5', !c5, 'C, reading B\'s parcel, deletes its copy');
		await push(C);
		await offline(B, false);
		ctl('N5', await toBrowser(B), 'B goes back to the Browser');
		await offline(A, false);
		await settle(3);
		const fin5 = await where(P5), b7 = await readHere(B, P7);
		const disk = { n5: await diskRead(B, '.n5f', P5), n7: await diskRead(B, '.n5f', P7) };
		say('N5', !allGone(fin5) || b7 !== E7 || disk.n5 !== null || disk.n7 !== null,
			'after a trip through a folder, the deletion does not land or stay on B, the edit is not taken, or a Browser file lands on the disk',
			J({ n5: fin5, bTakesEdit: b7 === E7, disk: { n5: disk.n5 !== null, n7: disk.n7 !== null }, recB: await recOf(B, P5) }));
		ctl('N5', (await write(B, P5, Y5)) === 'done', 'B restores r/n5.md byte for byte');
		await push(B);
		await settle(3);
		const back = await where(P5);
		say('N5r', !allHere(back), 'B\'s restore after the trip does not end on every device',
			J({ end: back, recs: { A: await recOf(A, P5), B: await recOf(B, P5), C: await recOf(C, P5) } }));
	}
	// ═══ E1: an edit, and a device that does not carry the file ═════════════════
	if (want('E1')) {
		const P = 'r/e1.md', E = TXT(P) + 'edited on A while B is on its folder\n';
		if ((await folderNow(B)) !== '.n5f') {
			await diskWrite(B, '.n5f', 'dshare/b.md', TXT('dshare/b.md'));
			ctl('E1', await toMachine(B, '.n5f'), 'B opens its machine folder');
			if (!(await B.page.evaluate(async () => { DaimondCore.syncClearWalkCache(); const sh = await DaimondCore.syncFolderShare(); return sh && sh.roots && sh.roots.length; }))) {
				ctl('E1', J(await flagShare(B, 'dshare')) === J(['dshare']), 'B shares dshare/ alone');
			}
			await push(B); await settle(1);
		}
		const e0 = await where(P);
		ctl('E1', allHere(e0), 'setup: r/e1.md on A, B (its Browser storage) and C', J(e0));
		ctl('E1', (await write(A, P, E)) === 'done', 'A edits r/e1.md');
		note('E1: A\'s push ' + J(await push(A)));
		await offline(A, true);
		await pull(B); note('E1: B\'s push (on its folder) ' + J(await push(B)));
		await offline(B, true);
		await pull(C);
		const cSaw = (await readHere(C, P)) === E;
		note('E1: C after reading B\'s parcel holds the edit: ' + cSaw + '; C\'s push ' + J(await push(C)));
		await offline(C, true);
		await offline(A, false);
		await pull(A);
		const aAfter = await readHere(A, P);
		const tag = async () => { const o = {}; for (const [k, d] of [['A', A], ['B', B], ['C', C]]) { const t = await readHere(d, P); const v = await d.page.evaluate(() => { try { return DaimondSync.state().version; } catch (e) { return null; } }); o[k] = (t === E ? 'E' : t === null ? '-' : 'old') + '@v' + v; } return J(o); };
		for (const d of [B, C]) await offline(d, false);
		note('E1 trace: all back online ' + await tag() + '; B on ' + J(await folderNow(B)) + ', B\'s fork ' + J(await forkOf(B, P)));
		if ((await folderNow(B)) !== null) await toBrowser(B);
		note('E1 trace: B back in the Browser ' + await tag() + ', B\'s fork ' + J(await forkOf(B, P)));
		for (let i = 0; i < 3; i++) for (const [k, d] of [['A', A], ['B', B], ['C', C]]) {
			await pull(d); const a = await tag(); const r = await push(d);
			note('E1 trace: round ' + i + ' ' + k + ' pulled ' + a + ', pushed ' + J(r) + ' ' + await tag());
		}
		for (const d of [A, B, C]) await pull(d);
		const end = { A: (await readHere(A, P)) === E, B: (await readHere(B, P)) === E, C: (await readHere(C, P)) === E };
		say('E1', aAfter !== E || !(end.A && end.B && end.C), 'A\'s edit is reverted by a stale copy from a device that never saw it (relayed by nobody)',
			J({ A_after_reading_C: aAfter === E ? 'edit' : aAfter === null ? 'GONE' : 'OLD', endHasEdit: end }));
	}
	// ═══ E2: back to the folder, whose disk missed an edit taken in the Browser ═══
	// B's machine folder is the one the Machine chip goes back to (`.n5f`), with eshare/ shared there as well.
	if (want('E2')) {
		const P = 'eshare/x.md', X0 = TXT(P), E = X0 + 'edited on A while B works in the Browser\n', FD = '.n5f';
		const ver = (d) => d.page.evaluate(() => { try { return DaimondSync.state ? DaimondSync.state().version : null; } catch (e) { return null; } });
		if ((await folderNow(B)) !== FD) {
			if ((await folderNow(B)) !== null) await toBrowser(B);
			await diskWrite(B, FD, 'dshare/b.md', TXT('dshare/b.md'));
			ctl('E2', await toMachine(B, FD), 'B opens its machine folder');
		}
		const roots = await flagShare(B, 'eshare');
		ctl('E2', Array.isArray(roots) && roots.includes('eshare'), 'B shares eshare/ there', J(roots));
		await write(A, P, X0);
		await push(A);
		for (let i = 0; i < 4; i++) { await settle(1); if ((await diskRead(B, FD, P)) === X0 && (await has(C, P))) break; }
		ctl('E2', (await diskRead(B, FD, P)) === X0, 'setup: eshare/x.md on B\'s disk');
		ctl('E2', await toBrowser(B), 'B goes to the Browser');
		await settle(2);
		// A new version, so the Browser merges eshare/x.md in at all (the version B adopted on its folder is skipped
		// here: QFB4-1 itself, E1's road).
		if ((await readHere(B, P)) === null) { await write(A, 'eshare/nudge.md', TXT('nudge')); await push(A); await settle(1); }
		ctl('E2', (await readHere(B, P)) === X0, 'setup: and in B\'s Browser storage', J(await readHere(B, P)));
		ctl('E2', (await write(A, P, E)) === 'done', 'A edits eshare/x.md');
		note('E2: A\'s push ' + J(await push(A)));
		await pull(B);
		note('E2: B (Browser) took the edit: ' + ((await readHere(B, P)) === E) + ', B at version ' + J(await ver(B)));
		// The trace (REV2): what B's location, merge notes and fork points say around the return and its push.
		const bTrace = () => B.page.evaluate(async (P) => {
			const o = { loc: null, ver: null, keys: {} };
			try { o.loc = await DaimondCore.syncLoc(); } catch (e) { o.loc = 'threw ' + e; }
			try { o.ver = DaimondSync.state().version; } catch (e) { /* older build */ }
			for (let i = 0; i < localStorage.length; i++) {
				const k = localStorage.key(i);
				if (!/daimond-sync-(merged-at|filebase)/.test(k)) continue;
				let v = localStorage.getItem(k);
				try { const m = JSON.parse(v); v = (m && m.map) ? { loc: m.loc, x: m.map[P] } : (m && typeof m === 'object' && P in m) ? { x: m[P] } : m; } catch (e) { /* as stored */ }
				o.keys[k] = v;
			}
			return o;
		}, P);
		const logFrom = B.logs.length;
		note('E2 trace: B in the Browser before the return ' + J(await bTrace()));
		ctl('E2', await toMachine(B, FD), 'B goes back to its folder');
		const dk = await diskRead(B, FD, P);
		note('E2 trace: B on its folder, before its push ' + J(await bTrace()));
		note('E2: B\'s disk holds ' + (dk === E ? 'the edit' : dk === X0 ? 'the OLD bytes' : J(dk)) + ', B at version ' + J(await ver(B)) + '; B\'s push ' + J(await push(B)));
		note('E2 trace: B after its push ' + J(await bTrace()) + '; disk ' + J((await diskRead(B, FD, P)) === E ? 'edit' : 'old'));
		note('E2 trace: B\'s console since the return ' + J(B.logs.slice(logFrom).filter((t) => /sync|merge|conflict|cloud/i.test(t)).slice(-30)));
		await pull(A);
		const aAfter = await readHere(A, P);
		await settle(3);
		const end = { A: (await readHere(A, P)) === E, C: (await readHere(C, P)) === E, Bdisk: (await diskRead(B, FD, P)) === E };
		say('E2', aAfter !== E || !(end.A && end.C), 'A\'s edit is reverted when B returns to a folder whose disk missed it',
			J({ A_after_B_push: aAfter === E ? 'edit' : aAfter === null ? 'GONE' : 'OLD', endHasEdit: end }));
		say('E2b', !end.Bdisk, 'B\'s folder never takes the edit (its write is refused by the stale-read guard)', J(end));
		if ((await folderNow(B)) !== null) await toBrowser(B);
	}
	ctl('W', allHere(await where('r/keep.md')), 'nothing standing lost (r/keep.md on all three)', J(await where('r/keep.md')));
} catch (e) {
	ctl('run', false, 'the run completes', (e && e.stack) || e);
} finally {
	for (const d of [A, B, C]) if (d) await d.close().catch(() => {});
}
const failed = tally.defect.length + tally.bad.length;
console.log(failed ? `\n${tally.clean.length + tally.ok} passed, ${failed} failed (defects ${tally.defect.join(',') || 'none'}; controls ${tally.bad.join(',') || 'ok'})`
	: `\nall ${tally.clean.length + tally.ok} checks passed`);
process.exit(failed ? 1 : 0);
