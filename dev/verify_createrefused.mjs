// gateway: live
// verify_createrefused.mjs -- a file made again on another device after a delete here arrives here, and this
// device's next push never takes it off the account (lane CRF, 2026-09-28; specs/daimond_release_r522_20260927.md,
// ## LOSTW2 and ## CRF).
//
// THE FAULT (new in 5.2.2, RD2). The pull's create went through `writeSyncFile` with no read first. The tools app's
// stale-read guard still remembered its own sync write of the path, because another app had carried out the
// delete, so it refused the write as "was deleted since you read it". The refusal was passed over, the version
// adopted as merged, and this device's next push replaced the account's head without the file. The soak's road
// was a second tab; these are the two one-tab roads LOSTW2 named from the code:
//   D  a daimon deletes the file in its own chat app (a DaimondApp of its own, with its own view); the other
//      device makes the file again.
//   X  a file in a shared machine folder is deleted outside Daimond; the other device makes it again.
// Each arm asks: does the file arrive, does the merge go through, and does the account still hold the file after
// this device's next push, and after the other device's pull of it?
//
//   node dev/verify_createrefused.mjs [--arms=DX]
//   node dev/verify_createrefused.mjs --break nocreate    # the fix undone: D and X fail
import { open, signInAs, scratch, markHere } from './harness.mjs';
import { makePagePro, GW_URL } from './pro.mjs';
import { GWDIR } from './gwbin.mjs';

import fs from 'node:fs';
import path from 'node:path';

// ── --break: the fix undone, served to every page through `page.route` (Chromium) ──
const BREAK = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : ''; })();
const BREAKS = {
	// 5.2.2's create before CRF: no read first, and a refusal passed over.
	nocreate: [
		{ file: 'js/daimond.js',
			find: '\t\t\t\tif (await writeSyncFile(app, p, r, null, plan)) { agreed[p] = rh; wrote[p] = rh; if (isDead) returned.push(p); }\n\t\t\t\telse unwritten.push(p);\n',
			with: '\t\t\t\tif (await writeSyncFile(app, p, r)) { agreed[p] = rh; wrote[p] = rh; if (isDead) returned.push(p); }\n' },
	],
};
if (BREAK && !BREAKS[BREAK]) { console.error(`unknown break '${BREAK}'; known: ${Object.keys(BREAKS).join(', ')}`); process.exit(2); }
const WWW = new URL('../www', import.meta.url).pathname;
const PATCHED = new Map();
for (const spec of (BREAKS[BREAK] || [])) {
	const src0 = PATCHED.get(spec.file) ?? fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src0.split(spec.find).length - 1;
	if (n !== 1) { console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}; nothing proved`); process.exit(2); }
	PATCHED.set(spec.file, src0.replace(spec.find, spec.with));
}
const route = PATCHED.size ? async (page) => {
	for (const [f, body] of PATCHED) await page.route('**/' + f, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
} : null;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

const ok = [], bad = [];
const check = (name, pass, detail, kind = 'route') => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + (kind === 'control' ? '[ctl] ' : '') + name
		+ (detail ? ' -- ' + String(detail).slice(0, 500) : ''));
};
const control = (name, pass, detail) => check(name, pass, detail, 'control');
const note = (s) => console.log('  note ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
const ONLY = (process.argv.find((a) => a.startsWith('--arms=')) || '--arms=DX').slice(7);

const ready = (s) => s.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondCore && window.DaimondGateway
	&& window.DaimondCloud && DaimondGateway.state().authed), null, { timeout: 30000 }).catch(() => {});
const write = (s, p, content) => s.page.evaluate(async ([p, c]) => { await (await import('/pkg/oxedyne_daimond.js')).write_file(p, c); return true; }, [p, content]);
const sandbox = (s, p) => s.page.evaluate(async (p) => { try { return await DaimondCloud.readText(p); } catch (e) { return null; } }, p);
const push = (s) => s.page.evaluate(() => (window.DaimondSync.flush ? window.DaimondSync.flush() : window.DaimondSync.push())).catch(() => {});
const pull = (s) => s.page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
const failed = (s) => s.page.evaluate(() => { try { return DaimondSync.state().failedParts || []; } catch (e) { return ['?']; } });
const quiet = async (s, ms = 20000) => {
	const until = Date.now() + ms; let calm = 0;
	while (Date.now() < until) {
		const q = await s.page.evaluate(() => { try { return DaimondSync.state().quiet; } catch (e) { return false; } });
		calm = q ? calm + 1 : 0;
		if (calm >= 3) return true;
		await sleep(400);
	}
	return false;
};
// The account's latest parcel, opened: the inline text it carries at `p`, and its version.
const head = (s, p) => s.page.evaluate(async (p) => {
	const r = await DaimondGateway.gwFetch('/api/sync', { method: 'GET', credentials: 'same-origin',
		headers: { 'x-daimond-api': String(DaimondGateway.clientApi()) } });
	const g = await r.json().catch(() => null);
	if (!g || !g.blob) return null;
	const st = JSON.parse(await DaimondIdentity.unwrap(g.blob));
	const f = (st.files || {})[p];
	return { v: g.version | 0, text: typeof f === 'string' ? f : null, chunked: !!(st.chunked || {})[p] };
}, p);
// A daimon's delete: its chat runs its own DaimondApp, whose view of the file is its own.
const daimonDelete = (s, p) => s.page.evaluate(async (p) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.run_tool_outcome('file_read', JSON.stringify({ path: p }));
	const r = await app.run_tool_outcome('file_delete', JSON.stringify({ path: p }));
	return r && r.outcome;
}, p);

async function pairedDevice(lead, name, label, profile) {
	const d = await open({ name: name + '-' + label, signIn: false, connect: false, defaults: false, profile, route });
	await d.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 30000 }).catch(() => {});
	const code = await lead.page.evaluate(() => DaimondPairing.create());
	await d.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await d.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(d, name);
	await ready(d);
	await sleep(2500);
	return d;
}
const settle = async (X, Y, n = 2) => {
	for (let i = 0; i < n; i++) { await push(X); await pull(Y); await push(Y); await pull(X); await quiet(X); await quiet(Y); }
};

// ── D: a daimon on B deletes the file in its own chat; A makes it again ──
async function armDaimon() {
	const tag = 'D';
	console.log(`\n── ${tag}: a daimon deletes the file in its own chat; the other device makes it again ──`);
	const NAME = 'crfd';
	const PROFILE = (x) => scratch('pw', NAME + '-' + x + '-' + process.pid);
	const P = 'crf/log.md', L1 = 'the first log, made on A\n', L2 = 'made again on A, after the delete\n';
	let A = null, B = null;
	try {
		A = await open({ name: NAME, connect: false, defaults: false, profile: PROFILE('a'), route });
		await ready(A);
		const pro = await makePagePro(A.page, GWDIR, GW_URL);
		control(`${tag}: the account holds Pro`, pro.pro === true, J(pro));
		B = await pairedDevice(A, NAME, 'b', PROFILE('b'));
		await write(A, P, L1);
		for (let i = 0; i < 6 && (await sandbox(B, P)) !== L1; i++) await settle(A, B, 1);
		control(`${tag}: the file reached B through its sync (B's tools app wrote it)`, (await sandbox(B, P)) === L1, String(await sandbox(B, P)));

		const del = await daimonDelete(B, P);
		control(`${tag}: B's daimon deletes it in its own chat app`, del === 'done' && (await sandbox(B, P)) === null, J({ del }));
		for (let i = 0; i < 4 && (await sandbox(A, P)) !== null; i++) await settle(B, A, 1);
		control(`${tag}: the delete travels, and A no longer holds the file`, (await sandbox(A, P)) === null, String(await sandbox(A, P)));

		await write(A, P, L2);
		await push(A); await quiet(A);
		const h0 = await head(A, P);
		control(`${tag}: A's copy made again is on the account's head`, h0 && h0.text === L2, J(h0));

		await pull(B); await quiet(B);
		const b1 = await sandbox(B, P), f1 = await failed(B);
		note(`${tag}: B after its pull: disk ${b1 === L2 ? 'L2' : J(b1)}, failed sections ${J(f1)}`);
		check(`${tag}: the file made again arrives on B`, b1 === L2, J(b1));
		check(`${tag}: and B's merge goes through (no failed files section)`, !f1.includes('files'), J(f1));

		await push(B); await quiet(B);
		const h1 = await head(B, P);
		check(`${tag}: B's next push leaves the file on the account's head`, h1 && h1.text === L2, J(h1));
		await settle(A, B, 2);
		const a2 = await sandbox(A, P), b2 = await sandbox(B, P), h2 = await head(A, P);
		check(`${tag}: after two more rounds both devices and the head hold it`, a2 === L2 && b2 === L2 && h2 && h2.text === L2,
			J({ a: a2 === L2 ? 'L2' : a2, b: b2 === L2 ? 'L2' : b2, head: h2 && (h2.text === L2 ? 'L2' : h2) }));
	} catch (e) {
		check(`${tag}: the run completes`, false, (e && e.stack) || e);
	} finally {
		if (B) await B.close().catch(() => {});
		if (A) await A.close().catch(() => {});
	}
}

// ── X: A is a desktop in a machine folder sharing `work`; B is a phone in the sandbox. A file B made reaches A's
// folder through A's sync, is deleted there outside Daimond, and B makes it again. ──
async function armOutside() {
	const tag = 'X';
	console.log(`\n── ${tag}: a shared folder's file deleted outside Daimond; the other device makes it again ──`);
	const NAME = 'crfx';
	const PROFILE = (x) => scratch('pw', NAME + '-' + x + '-' + process.pid);
	const P = 'work/log.md', L1 = 'the first log, made on the phone\n', L2 = 'made again on the phone, after the delete\n';
	let A = null, B = null;
	const disk = () => A.page.evaluate(async (p) => {
		try {
			const root = await navigator.storage.getDirectory();
			let d = await root.getDirectoryHandle('picked');
			const parts = p.split('/');
			for (let i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i]);
			return await (await (await d.getFileHandle(parts[parts.length - 1])).getFile()).text();
		} catch (e) { return null; }
	}, P);
	// `rm` in a terminal: straight to the folder, no Daimond door, so no app's view moves.
	const outsideDelete = () => A.page.evaluate(async (p) => {
		const root = await navigator.storage.getDirectory();
		let d = await root.getDirectoryHandle('picked');
		const parts = p.split('/');
		for (let i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i]);
		await d.removeEntry(parts[parts.length - 1]);
		DaimondCore.syncClearWalkCache();
		return true;
	}, P);
	try {
		A = await open({ name: NAME, connect: false, defaults: false, profile: PROFILE('a'), route });
		await ready(A);
		const pro = await makePagePro(A.page, GWDIR, GW_URL);
		control(`${tag}: the account holds Pro`, pro.pro === true, J(pro));
		B = await pairedDevice(A, NAME, 'b', PROFILE('b'));
		const pa = A.page;
		await pa.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const dir  = await root.getDirectoryHandle('picked', { create: true });
			dir.queryPermission   = async () => 'granted';
			dir.requestPermission = async () => 'granted';
			window.showDirectoryPicker = async () => dir;
		});
		await pa.evaluate(() => window.DaimondPanels && DaimondPanels.open && DaimondPanels.open('work'));
		await sleep(600);
		await pa.evaluate(() => {
			const chips = [...document.querySelectorAll('.files-mode-chip')];
			const machine = chips.find((c) => /machine/.test(c.className) || c.querySelector('[data-icon="machine"]')) || chips[1];
			if (machine) machine.click();
		});
		await sleep(1500);
		const m = await pa.evaluate(async () => {
			const mod = await import('/pkg/oxedyne_daimond.js');
			const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
			await app.run_tool_outcome('dir_create', JSON.stringify({ path: 'work' }));
			await app.run_tool_outcome('file_write', JSON.stringify({ path: 'work/note.md', content: 'in the folder\n' }));
			const id = await app.create_diamond('Shared');
			const ref = window.DaimondAttach.ref('dir', 'work');
			const linkId = await app.add_link(id, 'diamond:' + id, ref, 'holds', '', 'user');
			return { id, ref, linkId };
		});
		await markHere(A, m.id, m.ref, { linkId: m.linkId, share: true });
		await pa.evaluate(async () => { await DaimondCore.loadDiamonds(); DaimondCore.syncClearWalkCache(); });
		const mode = await pa.evaluate(async () => (await import('/pkg/oxedyne_daimond.js')).workspace_mode());
		control(`${tag}: A is in its machine folder`, mode === 'folder', mode);

		await write(B, P, L1);
		for (let i = 0; i < 6 && (await disk()) !== L1; i++) await settle(B, A, 1);
		control(`${tag}: the phone's file reached A's folder through A's sync`, (await disk()) === L1, String(await disk()));

		await outsideDelete();
		control(`${tag}: the file is deleted from A's folder outside Daimond`, (await disk()) === null);
		await settle(A, B, 2);
		note(`${tag}: after the delete settled: phone ${J(await sandbox(B, P))}, A's folder ${J(await disk())}`);

		await write(B, P, L2);
		await push(B); await quiet(B);
		const h0 = await head(B, P);
		control(`${tag}: the phone's copy made again is on the account's head`, h0 && h0.text === L2, J(h0));

		await pull(A); await quiet(A);
		const a1 = await disk(), f1 = await failed(A);
		note(`${tag}: A after its pull: folder ${a1 === L2 ? 'L2' : J(a1)}, failed sections ${J(f1)}`);
		check(`${tag}: the file made again arrives in A's folder`, a1 === L2, J(a1));
		check(`${tag}: and A's merge goes through (no failed files section)`, !f1.includes('files'), J(f1));

		await push(A); await quiet(A);
		const h1 = await head(A, P);
		check(`${tag}: A's next push leaves the file on the account's head`, h1 && h1.text === L2, J(h1));
		await settle(A, B, 2);
		const a2 = await disk(), b2 = await sandbox(B, P), h2 = await head(A, P);
		check(`${tag}: after two more rounds both devices and the head hold it`, a2 === L2 && b2 === L2 && h2 && h2.text === L2,
			J({ a: a2 === L2 ? 'L2' : a2, b: b2 === L2 ? 'L2' : b2, head: h2 && (h2.text === L2 ? 'L2' : h2) }));
	} catch (e) {
		check(`${tag}: the run completes`, false, (e && e.stack) || e);
	} finally {
		if (B) await B.close().catch(() => {});
		if (A) await A.close().catch(() => {});
	}
}

if (ONLY.includes('D')) await armDaimon();
if (ONLY.includes('X')) await armOutside();
console.log(bad.length === 0 ? `\nall ${ok.length} checks passed` : `\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length === 0 ? 0 : 1);
