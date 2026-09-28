// gateway: live
// verify_stalecopy.mjs -- an older copy is never offered as the newer version (lane REV, 2026-09-27;
// specs/daimond_fixbrief_r522_rev_20260927.md). QCMG's probe of decision 2 (`verify_cmgqa_revert.mjs` on
// qa/r53-commitmerged @ a94d8d13), brought across whole: red on 45f7cf02 (5.2.1), green on the fix.
//
// Two paired devices of one account, through the world's real gateway.
//   H  B edits a large offloaded file A also holds; A's merge takes B's manifest; A's next push must not
//      put A's older bytes back as the account's version, and the account must settle on B's edit.
//   E  the same with B freeing its copy after pushing: V2's chunks must survive (A's commit must name them).
//   F  the owner's shape: the edit is made in argonaut's shared machine folder while the phone holds the
//      older copy; the phone's push must not revert it, and argonaut's folder must keep its edit.
//
//   node dev/verify_stalecopy.mjs [--arms=HEF]
//   node dev/verify_stalecopy.mjs --break nosettle     # the fix undone: H, E and F fail
import crypto from 'node:crypto';
import { open, signInAs, scratch, markHere } from './harness.mjs';
import { makePagePro, GW_URL } from './pro.mjs';
import { GWDIR } from './gwbin.mjs';

import fs from 'node:fs';
import path from 'node:path';

// ── --break: the fix undone, served to every page through `page.route` (Chromium) ──
const BREAK = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : ''; })();
const BREAKS = {
	// The merge's settle and the collect's placing of the bytes, both gone: 5.2.1's collect.
	nosettle: [
		{ file: 'js/daimond.js', find: '\t\tvar stand = await settleAdopted(plan, was, fromDevice);\n', with: '\t\tvar stand = {};\n' },
		{ file: 'js/daimond.js', find: 'if (known && known.key) {\n\t\t\t\tvar ls = ', with: 'if (false) {\n\t\t\t\tvar ls = ' },
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
const ONLY = (process.argv.find((a) => a.startsWith('--arms=')) || '--arms=HEF').slice(7);

// Incompressible content, so each file is its own set of chunks and one file's drop is a small fraction of the
// account: the gateway's more-than-half hold-back then does not stand between a bad commit and the sweep.
const BIG = (tag) => '# ' + tag + '\n\n' + crypto.randomBytes(650 * 1024).toString('hex') + '\n';
const F = 'big/f.txt';

const ready = (s) => s.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondCore && window.DaimondGateway
	&& window.DaimondCloud && window.DaimondChunks && DaimondGateway.state().authed), null, { timeout: 30000 }).catch(() => {});
const write = (s, path, content) => s.page.evaluate(async ([p, c]) => { await (await import('/pkg/oxedyne_daimond.js')).write_file(p, c); return true; }, [path, content]);
const held = (s, path) => s.page.evaluate((p) => DaimondCloud.isHeld(p), path);
const read = (s, path) => s.page.evaluate(async (p) => { try { return await DaimondCloud.readText(p); } catch (e) { return null; } }, path);
const man = (s, path) => s.page.evaluate((p) => { const m = DaimondCloud.index()[p]; return m ? { hash: m.hash, addrs: (m.chunks || []).map((c) => c.addr) } : null; }, path);
const push = (s) => s.page.evaluate(() => (window.DaimondSync.flush ? window.DaimondSync.flush() : window.DaimondSync.push())).catch(() => {});
const pull = (s) => s.page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
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
// The account's latest parcel, opened: which manifest of F it names, and whose parcel it is.
const mailboxF = (s, path = F) => s.page.evaluate(async (p) => {
	const r = await DaimondGateway.gwFetch('/api/sync', { method: 'GET', credentials: 'same-origin',
		headers: { 'x-daimond-api': String(DaimondGateway.clientApi()) } });
	const g = await r.json().catch(() => null);
	if (!g || !g.blob) return null;
	const st = JSON.parse(await DaimondIdentity.unwrap(g.blob));
	const m = (st.chunked || {})[p];
	return { v: g.version | 0, hash: m ? m.hash : null, full: st.chunkedFull };
}, path);
const presence = (s, addrs) => s.page.evaluate(async (a) => { const r = await DaimondChunks.presence(a); return r && r.ok ? r.missing.length : -1; }, addrs);
const instrument = (s) => s.page.evaluate(() => {
	window.__commits = [];
	const real = window.fetch;
	window.fetch = async function (u, o) {
		const r = await real.apply(this, arguments);
		try {
			const url = String(u && u.url || u);
			if (/\/api\/chunk/.test(url) && o && typeof o.body === 'string' && /"op":"commit"/.test(o.body)) {
				const b = JSON.parse(o.body), j = await r.clone().json().catch(() => ({}));
				window.__commits.push({ at: b.blob_version, addrs: (b.chunks || []).map((c) => c.addr), swept: j.swept | 0, held: j.sweep_held_back | 0 });
			}
		} catch (e) { /* never break a request */ }
		return r;
	};
});
const commits = (s) => s.page.evaluate(() => window.__commits.slice());

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

async function arm(tag, evictB) {
	console.log(`\n── ${tag}: B's newer edit, A's older held copy${evictB ? ' (B frees its copy after pushing)' : ''} ──`);
	const NAME = 'cmgqarev' + tag.toLowerCase();
	const PROFILE = (x) => scratch('pw', NAME + '-' + x + '-' + process.pid);
	let A = null, B = null;
	try {
		A = await open({ name: NAME, connect: false, defaults: false, profile: PROFILE('a'), route });
		await ready(A);
		const pro = await makePagePro(A.page, GWDIR, GW_URL);
		control(`${tag}: the account holds Pro`, pro.pro === true, J(pro));
		B = await pairedDevice(A, NAME, 'b', PROFILE('b'));
		await instrument(A); await instrument(B);
		// Ballast, so a sweep of one file's chunks is under the gateway's 50% hold-back floor.
		for (let i = 0; i < 4; i++) await write(A, 'big/ballast' + i + '.txt', BIG('ballast' + i));
		const V1 = BIG('version-one'), V2 = BIG('version-two-newer');
		await write(A, F, V1);
		for (let i = 0; i < 6; i++) { await push(A); await pull(B); await sleep(500); if ((await man(B, F))) break; }
		await quiet(A); await quiet(B);
		const h1 = (await man(A, F) || {}).hash;
		control(`${tag}: V1 is offloaded on A and named in B's index`, !!h1 && (await man(B, F) || {}).hash === h1, J({ a: await man(A, F), b: await man(B, F) }));
		if (!(await held(B, F))) await B.page.evaluate((p) => DaimondCloud.fetch(p), F);
		await push(B); await pull(A); await push(A); await pull(B); await quiet(A); await quiet(B);
		control(`${tag}: both devices hold V1`, (await read(A, F)) === V1 && (await read(B, F)) === V1,
			J({ a: String(await read(A, F)).slice(0, 24), b: String(await read(B, F)).slice(0, 24) }));

		// 2. B edits and pushes.
		await write(B, F, V2);
		for (let i = 0; i < 4; i++) { await pull(B); await push(B); await sleep(500); const m = await man(B, F); if (m && m.hash !== h1) break; }
		await quiet(B);
		const mB = await man(B, F), h2 = mB && mB.hash, v2addrs = (mB && mB.addrs) || [];
		const mb2 = await mailboxF(B);
		control(`${tag}: B's edit (V2) is offloaded and is the account's latest parcel`, !!h2 && h2 !== h1 && mb2 && mb2.hash === h2, J({ h1, h2, mb2 }));
		if (evictB) {
			const ev = await B.page.evaluate((p) => DaimondCloud.evict(p), F);
			control(`${tag}: B frees its copy of V2 (it is in cloud storage)`, /^OK/.test(String(ev)) && !(await held(B, F)), ev);
		}

		// 3. A pulls: the merge adopts V2's manifest; A still holds V1.
		await pull(A); await quiet(A);
		const a3 = await man(A, F);
		note(`A after the pull: index ${a3 && a3.hash === h2 ? 'V2' : a3 && a3.hash === h1 ? 'V1' : J(a3)}, disk ${String(await read(A, F)).slice(0, 22)}`);

		// 4. A pushes.
		const nA = (await commits(A)).length;
		await push(A); await quiet(A);
		const a4 = await man(A, F);
		const aC = (await commits(A)).slice(nA);
		note(`A after its push: index ${a4 && a4.hash === h2 ? 'V2' : a4 && a4.hash === h1 ? 'V1' : J(a4)}; commits ${aC.map((c) => 'v' + c.at + ':' + c.addrs.length + (v2addrs.every((x) => c.addrs.includes(x)) ? '+V2' : '-V2') + (c.swept ? ' swept ' + c.swept : '') + (c.held ? ' held ' + c.held : '')).join(', ') || 'none'}`);
		const mb4 = await mailboxF(A);
		check(`${tag}: A's push does not put V1 back as the account's version of f.txt`, mb4 && mb4.hash === h2,
			J({ mailbox: mb4 && (mb4.hash === h1 ? 'V1' : mb4.hash === h2 ? 'V2' : mb4.hash), v: mb4 && mb4.v }));
		check(`${tag}: no commit of A's declares a live set without V2's chunks`, aC.every((c) => v2addrs.every((x) => c.addrs.includes(x))), aC.length + ' commits');

		// 5. B pulls A's parcel.
		await pull(B); await quiet(B);
		const b5 = await man(B, F);
		check(`${tag}: B's index still names V2 after merging A's parcel`, b5 && b5.hash === h2,
			J({ b: b5 && (b5.hash === h1 ? 'V1' : b5.hash === h2 ? 'V2' : b5.hash) }));

		// Then ordinary rounds, as the app runs them: where does the account settle?
		const seq = [];
		for (let i = 0; i < 4; i++) {
			await push(B); await pull(A); await push(A); await pull(B); await quiet(A); await quiet(B);
			const mb = await mailboxF(A);
			seq.push(mb ? (mb.hash === h1 ? 'V1' : mb.hash === h2 ? 'V2' : '?') + '@v' + mb.v : 'none');
		}
		note('mailbox after each later round: ' + seq.join(' '));
		const mbEnd = await mailboxF(A);
		check(`${tag}: after four more rounds the account names V2`, mbEnd && mbEnd.hash === h2, seq.join(' '));
		const gone = await presence(A, v2addrs);
		const bText = await read(B, F), aText = await read(A, F);
		note(`V2's chunks missing: ${gone} of ${v2addrs.length}; B's disk ${bText === null ? 'none' : bText === V2 ? 'V2' : bText === V1 ? 'V1' : '?'}; A's disk ${aText === V2 ? 'V2' : aText === V1 ? 'V1' : aText === null ? 'none' : '?'}`);
		check(`${tag}: V2 survives somewhere (its chunks held, or a device holds it)`, gone === 0 || bText === V2 || aText === V2, 'missing ' + gone);
		if (evictB) {
			const bC = await commits(B), allC = (await commits(A)).concat(bC);
			note('every commit: ' + allC.map((c) => 'v' + c.at + (v2addrs.every((x) => c.addrs.includes(x)) ? '+V2' : '-V2') + (c.swept ? '/swept ' + c.swept : '') + (c.held ? '/held ' + c.held : '')).join(', '));
		}
	} catch (e) {
		check(`${tag}: the run completes`, false, (e && e.stack) || e);
	} finally {
		if (B) await B.close().catch(() => {});
		if (A) await A.close().catch(() => {});
	}
}

// ── F: the owner's shape. A is argonaut, in a machine folder with a share; B is the phone, in the sandbox. The edit is
// made on the DESKTOP, in the shared folder; the phone holds the older copy. Does the phone's re-offload write the older
// version back into argonaut's real folder? (`materialiseShared` writes an adopted manifest's bytes into the folder.)
async function armFolder() {
	const tag = 'F';
	console.log(`\n── ${tag}: an edit made in argonaut's shared folder; the phone holds the older copy ──`);
	const NAME = 'cmgqarevf';
	const PROFILE = (x) => scratch('pw', NAME + '-' + x + '-' + process.pid);
	const P = 'work/big.txt';
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
	try {
		A = await open({ name: NAME, connect: false, defaults: false, profile: PROFILE('a'), route });
		await ready(A);
		const pro = await makePagePro(A.page, GWDIR, GW_URL);
		control(`${tag}: the account holds Pro`, pro.pro === true, J(pro));
		B = await pairedDevice(A, NAME, 'b', PROFILE('b'));
		await instrument(A); await instrument(B);
		// A opens a machine folder (an OPFS directory standing in) and shares `work`.
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
		for (let i = 0; i < 4; i++) await write(B, 'big/ballast' + i + '.txt', BIG('ballast' + i));
		const V1 = BIG('version-one'), V2 = BIG('version-two-made-on-the-desktop');
		await write(A, P, V1);
		control(`${tag}: V1 is on A's disk, in the shared folder`, (await disk()) === V1, String(await disk()).slice(0, 20));
		for (let i = 0; i < 6; i++) { await push(A); await pull(B); await push(B); await pull(A); await sleep(500); if (await man(B, P)) break; }
		await quiet(A); await quiet(B);
		const h1 = (await man(A, P) || {}).hash;
		control(`${tag}: V1 is offloaded from the folder and named in B's index`, !!h1 && (await man(B, P) || {}).hash === h1, J({ a: await man(A, P), b: await man(B, P) }));
		if (!(await held(B, P))) await B.page.evaluate((p) => DaimondCloud.fetch(p), P);
		await push(B); await pull(A); await push(A); await pull(B); await quiet(A); await quiet(B);
		control(`${tag}: the phone holds V1`, (await read(B, P)) === V1, String(await read(B, P)).slice(0, 20));

		// The edit, made on the desktop in the folder, pushed.
		await write(A, P, V2);
		for (let i = 0; i < 4; i++) { await pull(A); await push(A); await sleep(500); const x = await man(A, P); if (x && x.hash !== h1) break; }
		await quiet(A);
		const mA = await man(A, P), h2 = mA && mA.hash, v2addrs = (mA && mA.addrs) || [];
		const mb2 = await mailboxF(A, P);
		control(`${tag}: A's edit (V2) is on its disk and is the account's latest parcel`, (await disk()) === V2 && !!h2 && h2 !== h1 && mb2 && mb2.hash === h2,
			J({ disk: String(await disk()).slice(0, 20), mb2 }));

		// The phone wakes: pulls, pushes (and commits: it is whole).
		const nB = (await commits(B)).length;
		await pull(B); await quiet(B);
		await push(B); await quiet(B);
		const bC = (await commits(B)).slice(nB);
		const mb4 = await mailboxF(B, P);
		note(`${tag}: after the phone's round: mailbox ${mb4 && (mb4.hash === h1 ? 'V1' : mb4.hash === h2 ? 'V2' : mb4.hash)}@v${mb4 && mb4.v}; the phone's commits ${bC.map((c) => 'v' + c.at + (v2addrs.every((x) => c.addrs.includes(x)) ? '+V2' : '-V2') + (c.swept ? ' swept ' + c.swept : '') + (c.held ? ' held ' + c.held : '')).join(', ') || 'none'}`);
		check(`${tag}: the phone's push does not put V1 back as the account's version`, mb4 && mb4.hash === h2, J({ mb: mb4 && (mb4.hash === h1 ? 'V1' : 'V2') }));

		// argonaut pulls: does V1 land in its real folder over the edit?
		await pull(A); await quiet(A);
		await sleep(1500);
		const d5 = await disk();
		note(`${tag}: argonaut's folder after it pulls: ${d5 === V2 ? 'V2 (its edit)' : d5 === V1 ? 'V1 (REVERTED on disk)' : String(d5).slice(0, 30)}`);
		check(`${tag}: argonaut's own edit stays on its disk, in the shared folder`, d5 === V2, d5 === V1 ? 'V1 written over it' : String(d5).slice(0, 30));
		const gone = await presence(A, v2addrs);
		note(`${tag}: V2's chunks missing: ${gone} of ${v2addrs.length}`);
	} catch (e) {
		check(`${tag}: the run completes`, false, (e && e.stack) || e);
	} finally {
		if (B) await B.close().catch(() => {});
		if (A) await A.close().catch(() => {});
	}
}

if (ONLY.includes('H')) await arm('H', false);
if (ONLY.includes('E')) await arm('E', true);
if (ONLY.includes('F')) await armFolder();
console.log(bad.length === 0 ? `\nall ${ok.length} checks passed` : `\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length === 0 ? 0 : 1);
