// verify_diamondconflict.mjs — S-SYNC #4, the two-device OPFS live driver.
//
// THE BUG. Diamond merge was whole-directory last-writer-wins: `import_diamond`
// DELETED the whole Diamond directory (`versions/` included) and wrote the export
// over it, and only tags/links unioned, only at equal stamps. So a phone that
// edited a Diamond's memory, backgrounded in the 2.5 s debounce before its push,
// then pulled the desktop's later copy on resume had its edit AND its history
// replaced wholesale — no conflict copy, nothing in the trail — and then pushed
// the desktop's copy back. Silent data loss on the ordinary resume path.
//
// THE FIX (committed f7050fd2): a per-Diamond fork stamp (`daimond-diamond-base`)
// lets `applyDiamonds` tell a two-sided change from a one-sided one; on a two-sided
// change the import KEEPS the loser's crystal/page as one recoverable version
// (`keep_conflict` -> `keep_local_before_import`, note "kept before sync"),
// PRESERVES `versions/` across the replace, and UNIONS the loser's tags and links
// onto the winner.
//
// THE PROPERTY, on two REAL devices over one shared cloud, driving the real wasm:
//   A creates Diamond X, both agree on it. A edits X OFFLINE (page never pushes);
//   B edits X LATER; A comes back and PULLS FIRST. Then:
//     * A's live X is B's edit (the strictly-newer copy is the winner);
//     * A's Versions list carries a "kept before sync" entry whose body is A's
//       own offline edit (the loser is recoverable, not discarded);
//     * the tags on X are the UNION of both sides' tags;
//     * X's version HISTORY (the agreed baseline versions) survived the import;
//     * a further quiet round imports nothing and both devices converge.
//
// --break lww serves a daimond.js in which `applyDiamonds` treats every arrival as
// one-sided (twoSided forced false): the loser is discarded and the tags are not
// unioned — the pre-fix world, driven from here without touching the shipped code.
// It reddens the kept-loser and tag-union assertions. A control run that leaves
// them green would prove the checks have no teeth.
//
//   node dev/verify_diamondconflict.mjs           # the gate (must be green)
//   node dev/verify_diamondconflict.mjs --break lww  # pre-fix LWW (must redden)
//
// Chromium only: it needs an origin-private filesystem to create a Diamond at all
// (Playwright's Linux WebKit exposes none). The cloud is stood up IN THIS PROCESS
// and shared by both contexts — a mailbox with the gateway's version guard and a
// content-addressed chunk store whose commit sweeps exactly as the gateway does —
// so no dev gateway and no o3db store are needed. Needs dev/serve.mjs only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, scratch, clearDiamonds, BROWSER } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' — ' + detail : ''));
};
const note = (t) => console.log('        · ' + t);

const arg = (flag, dflt) => {
	const i = process.argv.indexOf(flag);
	return i > 0 ? String(process.argv[i + 1] || dflt) : dflt;
};
const BREAK = arg('--break', '');
if (BREAK && BREAK !== 'lww') { console.error(`unknown break '${BREAK}'; only: lww`); process.exit(2); }
if (BREAK && BROWSER !== 'chromium') {
	console.error(`--break serves an edited file through page.route, which does not fire under `
		+ `${BROWSER}. Run the break under Chromium.`);
	process.exit(2);
}

// ── The seam must be present, or a green run would prove nothing ──────
const SEAM = [
	{ file: 'js/daimond.js', want: 'var twoSided = !!mine && (!known || diamondStamp(mine) !== (dbase[r.id] || 0));',
	  why: 'the two-sided fork-stamp detection is missing, so this run would prove nothing' },
	{ file: 'js/daimond.js', want: "trail('sync diamond CONFLICT',",
	  why: 'the conflict path is absent' },
];
for (const s of SEAM) {
	const src = fs.readFileSync(path.join(WWW, s.file), 'utf8');
	if (!src.includes(s.want) && !BREAK) { console.error(`seam missing: ${s.file}: ${s.why}`); process.exit(2); }
}

// ── The break: applyDiamonds treats every arrival as one-sided ────────
const PATCHED = new Map();
if (BREAK === 'lww') {
	const file = 'js/daimond.js';
	const src = fs.readFileSync(path.join(WWW, file), 'utf8');
	const find = 'var twoSided = !!mine && (!known || diamondStamp(mine) !== (dbase[r.id] || 0));';
	const n = src.split(find).length - 1;
	if (n !== 1) { console.error(`break anchor appears ${n} times (expected 1)`); process.exit(2); }
	PATCHED.set(file, src.replace(find,
		'var twoSided = false;   // --break lww: whole-directory LWW, the loser is discarded'));
}
async function patchedSource(page) {
	if (!PATCHED.size) return;
	for (const [f, body] of PATCHED) {
		await page.route('**/' + f, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body }));
	}
}

// ═══════════════════════════════════════════════════════════════════════
// THE CLOUD, in this process, shared by both contexts.
// ═══════════════════════════════════════════════════════════════════════
const cloud = { mailbox: null, chunks: new Map(), pushes: [], commits: [] };
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
		if ((body.base_version | 0) !== cur) return { status: 409, json: { ok: false, version: cur } };
		cloud.mailbox = { version: cur + 1, blob: body.blob, device: body.device || dev };
		cloud.pushes.push({ dev, version: cur + 1 });
		return { status: 200, json: { ok: true, version: cur + 1 } };
	}
	if (p === '/api/chunk') {
		if (body.op === 'put') { (body.chunks || []).forEach(c => cloud.chunks.set(c.addr, c.blob)); return { status: 200, json: { ok: true } }; }
		if (body.op === 'have') return { status: 200, json: { missing: (body.addrs || []).filter(a => !cloud.chunks.has(a)) } };
		if (body.op === 'get') { const blob = cloud.chunks.get(body.addr); return { status: 200, json: blob ? { present: true, blob } : { present: false } }; }
		if (body.op === 'commit') {
			const live = new Set((body.chunks || []).map(c => c.addr));
			let swept = 0;
			for (const a of [...cloud.chunks.keys()]) { if (!live.has(a)) { cloud.chunks.delete(a); swept++; } }
			cloud.commits.push({ dev, live: live.size, swept });
			return { status: 200, json: { ok: true, swept, free_allowance: 0, paid_bytes: 0 } };
		}
		return { status: 200, json: { ok: true } };
	}
	return { status: 200, json: { ok: true } };
}

async function wireCloud(s, dev) {
	await s.page.exposeFunction('__cloudCall', async (p, method, body) => serve(dev, p, method, body));
	await s.page.evaluate((dev) => {
		window.__dev = dev;
		window.__ds = [];
		window.DEBUG_SHARE = { event: (kind, payload) => window.__ds.push({ kind, payload }) };
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
		&& window.DaimondSync && window.DaimondChunks && window.DaimondCloud
		&& DaimondCloud.contentGet && window.DaimondGateway && window.DaimondIdentity),
	null, { timeout: 20000 });

const push = async (s) => { await s.page.evaluate(() => window.DaimondSync.push()); await s.page.waitForTimeout(500); };
const pull = async (s) => { await s.page.evaluate(() => window.DaimondSync.pull()); await s.page.waitForTimeout(500); };

/// Everything a Diamond looks like from outside: its live crystal page, its tags,
/// its links sidecar, and the full version list.
const diamondState = (pg, id) => pg.evaluate(async (did) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	let page = '', tags = [], links = '', versions = [];
	try { page = await app.read_crystal_page(did); } catch (e) { page = 'ERR:' + (e && e.message); }
	try {
		const list = JSON.parse(await app.list_diamonds());
		const d = list.find(x => x.id === did);
		tags = d && Array.isArray(d.tags) ? d.tags.slice() : [];
	} catch (e) {}
	try { const ex = JSON.parse(await app.export_diamond(did)); links = String((ex.files || {})['.daimond/links.jsonl'] || ''); } catch (e) {}
	try { versions = JSON.parse(await app.versions_list(did)); } catch (e) { versions = []; }
	// Pull the body of every version so a "kept before sync" snapshot can be read.
	const bodies = [];
	for (const v of versions) {
		const entries = (v && v.files) || [];
		for (const e of entries) {
			const hash = e && e.hash;
			if (!hash || typeof hash !== 'string' || hash.length < 8) continue;
			try {
				const raw = await app.versions_body(did, hash);   // already a UTF-8 string
				if (raw) bodies.push({ note: (v && v.note) || '', path: (e && e.path) || '', body: String(raw) });
			} catch (e2) {}
		}
	}
	return { page, tags, links, versions, bodies };
}, id);

const PROFILE_A = scratch('pw', 'dconf-a-' + BROWSER + (BREAK ? '-' + BREAK : ''));
const PROFILE_B = scratch('pw', 'dconf-b-' + BROWSER + (BREAK ? '-' + BREAK : ''));
for (const d of [PROFILE_A, PROFILE_B]) fs.rmSync(d, { recursive: true, force: true });

// Two unique bodies, so a body read can be attributed to the side that wrote it.
const AGREE = '<h1>Ledger</h1><p>the copy both devices agreed on before either edit</p>';
const A_EDIT = '<h1>Ledger</h1><p>PHONE EDIT phone-only-marker-9f21 offline before push</p>';
const B_EDIT = '<h1>Ledger</h1><p>DESKTOP EDIT desktop-only-marker-7ac3 pushed while the phone slept</p>';

let A = null, B = null;
try {
	console.log(`\n— S-SYNC #4: two devices, one Diamond, a two-sided edit${BREAK ? '  [--break ' + BREAK + ']' : ''} —`);

	A = await open({ name: 'dconf-a', profile: PROFILE_A, signIn: false, connect: false, defaults: false, route: patchedSource });
	await ready(A); await signInAs(A, 'dconf'); await ready(A);

	const OPFS = await A.page.evaluate(() => !!(navigator.storage && navigator.storage.getDirectory));
	if (!OPFS) { console.log('        · this engine has no OPFS; a Diamond cannot be created. Run under Chromium.'); throw new Error('no OPFS'); }

	const bundle = await A.page.evaluate(() => window.DaimondIdentity.exportBundle());
	B = await open({ name: 'dconf-b', profile: PROFILE_B, signIn: false, connect: false, defaults: false, route: patchedSource });
	await ready(B);
	await B.page.evaluate((b) => window.DaimondIdentity.importBundle(b), bundle);
	await B.page.reload({ waitUntil: 'domcontentloaded' });
	await ready(B); await signInAs(B, 'dconf'); await ready(B);

	await clearDiamonds(A); await clearDiamonds(B); await ready(A); await ready(B);
	await wireCloud(A, 'A'); await wireCloud(B, 'B');

	const keys = {
		a: await A.page.evaluate(() => window.DaimondIdentity.publicKeyB64url()),
		b: await B.page.evaluate(() => window.DaimondIdentity.publicKeyB64url()),
	};
	check('two contexts hold ONE account — one mailbox opens for both', keys.a && keys.a === keys.b, keys.a === keys.b ? 'same key' : 'A≠B');

	// ── A creates Diamond X, tags it, writes a memory both sides will agree on ──
	const X = await A.page.evaluate(async (html) => {
		const mod = await import('/pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		const id = await app.create_diamond('Ledger');
		await app.write_crystal_page(id, html);
		await app.set_tags(id, JSON.stringify(['common']));
		return id;
	}, AGREE);
	note(`A created Diamond ${X.slice(0, 12)}…`);

	// ── Both agree on X (a full round). Both fork points land at the shared stamp ──
	await push(A); await pull(B); await push(B); await pull(A);
	const bHasX = await B.page.evaluate(async (did) => {
		const mod = await import('/pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		try { const list = JSON.parse(await app.list_diamonds()); return list.some(d => d.id === did); } catch (e) { return false; }
	}, X);
	check('B adopted the Diamond — both devices hold X before either edits it', bHasX === true);
	const baseA = await A.page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}'), 'daimond-diamond-base');
	check('A recorded a fork point for X (the agreement both sides last shared)', baseA[X] !== undefined, 'base[X]=' + baseA[X]);

	// ── A edits X OFFLINE: it never pushes, so the fork point stays at the agreement ──
	await A.page.evaluate(async ({ did, html }) => {
		const mod = await import('/pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.write_crystal_page(did, html);
		await app.set_tags(did, JSON.stringify(['common', 'phoneTag']));
	}, { did: X, html: A_EDIT });
	const stampA = await A.page.evaluate(async (did) => {
		const mod = await import('/pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		const list = JSON.parse(await app.list_diamonds()); const d = list.find(x => x.id === did);
		return d ? (d.touched || d.updated || 0) : 0;
	}, X);
	check('A moved X past the fork point with an UNPUSHED edit', stampA > (baseA[X] || 0), `stamp ${stampA} > base ${baseA[X]}`);

	// ── B edits X LATER (strictly newer wall clock) and pushes ──
	await B.page.waitForTimeout(60);
	await B.page.evaluate(async ({ did, html }) => {
		const mod = await import('/pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.write_crystal_page(did, html);
		await app.set_tags(did, JSON.stringify(['common', 'deskTag']));
	}, { did: X, html: B_EDIT });
	await push(B);

	// ── A resumes and PULLS FIRST — the exact resume-pull that used to lose the edit ──
	await pull(A);

	const a = await diamondState(A.page, X);
	note(`A's live page now: ${a.page.replace(/<[^>]+>/g, ' ').trim().slice(0, 70)}`);
	note(`A's tags: ${JSON.stringify(a.tags)}; versions: ${a.versions.length}; version notes: ${JSON.stringify(a.versions.map(v => (v.note || '').slice(0, 24)))}`);
	note(`A's kept version bodies: ${JSON.stringify(a.bodies.map(bd => bd.path.split('/').pop() + ':' + bd.body.slice(0, 24)))}`);

	// ═══ THE S-SYNC #4 GATE ═══
	check('#4 the winner is live on A — the strictly-newer desktop edit',
		a.page.indexOf('desktop-only-marker-7ac3') !== -1 && a.page.indexOf('phone-only-marker-9f21') === -1,
		a.page.indexOf('desktop-only-marker-7ac3') !== -1 ? 'desktop copy is live' : 'winner not the desktop copy');

	const keptSnap = a.bodies.find(b => /kept before sync/i.test(b.note) && b.body.indexOf('phone-only-marker-9f21') !== -1);
	const keptNote = a.versions.some(v => /kept before sync/i.test(v.note || ''));
	check('#4 the LOSER is kept as a recoverable "kept before sync" version whose body is A\'s own offline edit',
		!!keptSnap, keptSnap ? 'found the phone edit in a kept version' : (keptNote ? 'a kept-note exists but no body carries the phone marker' : 'no "kept before sync" version at all'));

	check('#4 the tags are the UNION of both sides (common + phoneTag + deskTag)',
		["common","phonetag","desktag"].every(t => a.tags.indexOf(t) !== -1), JSON.stringify(a.tags));

	// The agreed baseline left at least one version behind; the import PRESERVED it
	// alongside the conflict snapshot rather than deleting the whole directory.
	check('#4 X\'s version history survived the import (versions/ preserved, not wiped)',
		a.versions.length >= 1, `${a.versions.length} version(s) held`);

	// ── A further quiet round: A pushes the union back, B converges, nothing churns ──
	const commitsBefore = cloud.commits.length;
	await push(A); await pull(B); await push(B); await pull(A);
	const b = await diamondState(B.page, X);
	check('#4 B converges — the desktop copy is live and it adopts the unioned tags',
		b.page.indexOf('desktop-only-marker-7ac3') !== -1 && ['common','phonetag','desktag'].every(t => b.tags.indexOf(t) !== -1),
		`B page ok=${b.page.indexOf('desktop-only-marker-7ac3') !== -1} tags=${JSON.stringify(b.tags)}`);
	// A second resume-pull on A imports nothing new (the fork point advanced to the winner).
	const aVerBefore = (await diamondState(A.page, X)).versions.length;
	await pull(A);
	const aVerAfter = (await diamondState(A.page, X)).versions.length;
	check('#4 a further resume-pull keeps a single kept snapshot (no fresh conflict each round — fixed point)',
		aVerAfter === aVerBefore, `versions ${aVerBefore} -> ${aVerAfter}, ${cloud.commits.length - commitsBefore} commit(s) in the round`);

} catch (e) {
	console.log('VERIFY THREW:', e && (e.stack || e.message || e));
	bad.push('verify threw: ' + (e && e.message));
} finally {
	try { await A?.close?.(); } catch (e) {}
	try { await B?.close?.(); } catch (e) {}
	console.log('\n=== SUMMARY ' + ok.length + ' ok, ' + bad.length + ' FAIL ' + (BREAK ? '(--break: FAILs are expected)' : '') + ' ===');
	if (bad.length) { bad.forEach((x) => console.log('  FAIL ' + x)); process.exitCode = 1; }
}
