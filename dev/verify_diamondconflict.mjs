// gateway: none
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
// ROUND F (5.3.2, QA pair 2: Fable F1, Opus B F1): the Diamond's note file `.daimond/steering.md` is not a
// versioned file either, so the import replaced it whole: a note added on the losing side vanished and a Remove
// flipped back to active. The last section drives both on the same two devices: an Add on each side, and a Remove
// made on the side that loses the import. `--break nonotes` serves a daimond.js that never joins the files.
//
//   node dev/verify_diamondconflict.mjs           # the gate (must be green)
//   node dev/verify_diamondconflict.mjs --break lww  # pre-fix LWW (must redden)
//   node dev/verify_diamondconflict.mjs --break nonotes  # the import's whole replacement of the note file (must redden the notes section)
//   node dev/verify_diamondconflict.mjs --break nolock   # no lock between a press and the import (must redden G5b and G5d only)
//   node dev/verify_diamondconflict.mjs --break stale     # the decision from the pull's first list (must redden G5a and G5c only)
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
if (BREAK && !['lww', 'nonotes', 'nolock', 'stale'].includes(BREAK)) { console.error(`unknown break '${BREAK}'; only: lww, nonotes, nolock, stale`); process.exit(2); }
if (BREAK && BROWSER !== 'chromium') {
	console.error(`--break serves an edited file through page.route, which does not fire under `
		+ `${BROWSER}. Run the break under Chromium.`);
	process.exit(2);
}

// ── The seam must be present, or a green run would prove nothing ──────
const SEAM = [
	{ file: 'js/daimond.js', want: 'var twoSided = diamondTwoSided(r, mine, recv, dbase);',
	  why: 'the two-sided fork-stamp detection is missing, so this run would prove nothing' },
	{ file: 'js/daimond.js', want: "trail('sync diamond CONFLICT',",
	  why: 'the conflict path is absent' },
	{ file: 'js/daimond.js', want: 'function diamondTwoSided(r, mine, recv, dbase) {',
	  why: 'the two-sided rule (descent, lane DIA) is missing' },
	{ file: 'js/daimond.js', want: 'await window.DaimondNotes.uniteHeld(r.id, loserNotes);',
	  why: 'the join of the note file is missing (round F), so the notes section would prove nothing' },
	{ file: 'js/daimond.js', want: 'var storedAt = await holdDiamond(r.id, async function () {',
	  why: 'the apply does not take the Diamond\'s lock (round F, R1), so the R1 section would prove nothing' },
	{ file: 'js/daimond.js', want: 'function holdDiamond(id, fn, wait) {',
	  why: 'the one lock per Diamond is missing (round F, R1)' },
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
	const find = 'var twoSided = diamondTwoSided(r, mine, recv, dbase);';
	const n = src.split(find).length - 1;
	if (n !== 1) { console.error(`break anchor appears ${n} times (expected 1)`); process.exit(2); }
	PATCHED.set(file, src.replace(find,
		'var twoSided = false;   // --break lww: whole-directory LWW, the loser is discarded'));
}
if (BREAK === 'nonotes') {
	const file = 'js/daimond.js';
	const src = fs.readFileSync(path.join(WWW, file), 'utf8');
	const find = 'await window.DaimondNotes.uniteHeld(r.id, loserNotes);';
	const n = src.split(find).length - 1;
	if (n !== 1) { console.error(`break anchor appears ${n} times (expected 1)`); process.exit(2); }
	PATCHED.set(file, src.replace(find, 'await 0; /* --break nonotes: the note file is replaced whole, as the import leaves it */'));
}
// --break nolock: the lock admits everyone at once (a shared Web Lock), so a press made as the import starts runs beside it (G5b, and G5d for a second tab).
// --break stale: the apply decides from the list read at the top of the pull and not from the Diamond under the lock (G5a, G5c).
function patchOnce(file, find, to) {
	const src = PATCHED.get(file) || fs.readFileSync(path.join(WWW, file), 'utf8');
	const n = src.split(find).length - 1;
	if (n !== 1) { console.error(`break anchor appears ${n} times (expected 1): ${find}`); process.exit(2); }
	PATCHED.set(file, src.replace(find, to));
}
if (BREAK === 'nolock') patchOnce('js/daimond.js', "{ mode: 'exclusive', signal: ctl.signal }", "{ mode: 'shared', signal: ctl.signal }");
if (BREAK === 'stale') {
	patchOnce('js/daimond.js', 'mine = cur; local[r.id] = cur;', 'void cur; /* --break stale */');
	patchOnce('js/daimond.js', 'if (!(diamondStamp(r) > diamondStamp(cur))) return 0;', '/* --break stale: the arrival is still taken as the newer */');
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

let A = null, B = null, A2 = null;
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

	// ═══ ROUND F: THE NOTE FILE ═══
	// The notes are one file in the Diamond's own store, outside the versioned files, so a two-sided import used to
	// replace this device's file with the arriving one: the Add made here vanished, and a Remove made here came back.
	console.log('\n— round F: the note file on a two-sided change —');
	const NOTE_COMMON = 'Name the source of every figure, note-common-4d21.';
	const NOTE_A      = 'Say plainly when you are unsure, note-phone-9e17.';
	const NOTE_B      = 'Keep every answer under about 200 words, note-desk-6b30.';
	const notesReady = (s) => s.page.waitForFunction(() => !!(window.DaimondNotes && window.DaimondCore && DaimondCore.loadDiamonds), null, { timeout: 20000 });
	await notesReady(A); await notesReady(B);
	// One tag each: a Diamond's note displaces another of the same tag, and the arms tell what a turn is told.
	const noteAdd = (s, line, tag) => s.page.evaluate(async ({ did, line, tag }) => {
		await DaimondCore.loadDiamonds();
		const e = await DaimondNotes.add({ level: 2, scope: did, cm: 'all', tag, line, at: { t: 0, n: 0 } });
		return e ? e.id : '';
	}, { did: X, line, tag });
	const noteRemove = (s, id) => s.page.evaluate(async ({ did, id }) => {
		await DaimondCore.loadDiamonds();
		const e = await DaimondNotes.retire({ level: 2, scope: did, id }, { t: 0, n: 1 });
		return e ? e.status : '';
	}, { did: X, id });
	const noteView = (s) => s.page.evaluate(async (did) => {
		await DaimondCore.loadDiamonds();
		await DaimondNotes.reload(true);
		return { all: DaimondNotes.all().filter((e) => e.scope === did).map((e) => ((/note-(common|phone|desk)-/.exec(e.line) || [])[1] || '?') + ':' + e.status).sort(), told: DaimondNotes.steerFor('any-model', did) };
	}, X);
	const round = async () => { await push(A); await pull(B); await push(B); await pull(A); };

	// The note both devices hold before either moves.
	const commonId = await noteAdd(A, NOTE_COMMON, 'wrong');
	await round();
	const b0 = await noteView(B);
	check('F0 the common note reached B one-sided (a control for the two-sided arms)', b0.told.indexOf('note-common-4d21') !== -1, JSON.stringify(b0.all));

	// F1: both Add between syncs; the arrival is the later copy and wins the import.
	await noteAdd(A, NOTE_A, 'ignored');
	await B.page.waitForTimeout(80);
	await noteAdd(B, NOTE_B, 'long');
	await push(B);
	await pull(A);
	const a1 = await noteView(A);
	check('F1 the note A Added survives the import of B\'s later copy', a1.told.indexOf('note-phone-9e17') !== -1, JSON.stringify(a1.all));
	check('F1 the note B Added stands, and the common one', a1.told.indexOf('note-desk-6b30') !== -1 && a1.told.indexOf('note-common-4d21') !== -1, JSON.stringify(a1.all));
	await push(A); await pull(B);
	const b1 = await noteView(B);
	check('F1 the join travels back: B holds all three, one-sided', b1.all.length === 3 && b1.told.indexOf('note-phone-9e17') !== -1, JSON.stringify(b1.all));
	await round();
	const a1b = await noteView(A), b1b = await noteView(B);
	check('F1 a further round changes nothing (the join settles)', JSON.stringify(a1b.all) === JSON.stringify(a1.all) && JSON.stringify(b1b.all) === JSON.stringify(b1.all), JSON.stringify([a1b.all, b1b.all]));

	// F2: A Removes the common note; B edits the Diamond later (still holding the note active) and its copy wins.
	const st = await noteRemove(A, commonId);
	await B.page.waitForTimeout(80);
	await B.page.evaluate(async ({ did, html }) => {
		const mod = await import('/pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.write_crystal_page(did, html);
	}, { did: X, html: B_EDIT.replace('desktop-only-marker-7ac3', 'desktop-only-marker-7ac3-second') });
	await push(B);
	await pull(A);
	const a2 = await noteView(A);
	check('F2 the Remove A made stands after the import of B\'s later copy', st === 'retired' && a2.told.indexOf('note-common-4d21') === -1, JSON.stringify(a2.all));
	check('F2 and A\'s other notes are still told', a2.told.indexOf('note-phone-9e17') !== -1 && a2.told.indexOf('note-desk-6b30') !== -1, JSON.stringify(a2.told));
	await push(A); await pull(B);
	const b2 = await noteView(B);
	check('F2 B takes the Remove: it is no longer told the removed note', b2.told.indexOf('note-common-4d21') === -1 && b2.all.indexOf('common:retired') !== -1, JSON.stringify(b2.all));

	// ═══ R1 (5.3.2 round F re-check): A PRESS WHILE A PULL APPLIES THE SAME DIAMOND ═══
	// `applyDiamonds` listed this device's Diamonds once, at its top, and decided "two-sided" from that list; the import sat
	// outside the queue the note writes share. So a note pressed after the list read as one-sided and the import replaced the file
	// whole: an Add was gone from both devices, a Remove came back to active and was told again, and the trail said nothing. The
	// account's notes live in the Optimiser, which every other device's timer moves, so most pulls carry a one-sided copy of it.
	//   G5a  the press completes after the pull listed this device's Diamonds, before the import (the chunk-fetch window)
	//   G5b  the press lands while import_diamond runs
	//   G5c  a Remove pressed in the G5a window
	console.log('\n— R1: a note pressed while a pull applies the Optimiser —');
	const OPT = '0da1000000f2';
	const optSeed = (s) => s.page.evaluate(async (OPT) => {
		const app = DaimondCore.diamondApp();
		await DaimondCore.loadDiamonds();
		if (!JSON.parse(await app.list_diamonds()).some((d) => d.id === OPT)) await app.create_diamond_at('Daimond Optimiser', OPT);
		await DaimondCore.loadDiamonds();
	}, OPT);
	const optTick = (s) => s.page.evaluate(async (OPT) => { const m = await import('/pkg/oxedyne_daimond.js'); await m.touch_diamond(OPT); try { await DaimondCore.loadDiamonds(); } catch (e) {} }, OPT);
	const acctAdd = (s, line, tag) => s.page.evaluate(async ({ line, tag }) => { await DaimondCore.loadDiamonds();
		const e = await DaimondNotes.add({ level: 3, scope: '', cm: 'all', tag, line, at: { t: 0, n: 0 } }); return e ? e.id : ''; }, { line, tag });
	const acctView = (s) => s.page.evaluate(async () => { await DaimondCore.loadDiamonds(); await DaimondNotes.reload(true);
		return { all: DaimondNotes.all().filter((e) => e.level === 3).map((e) => ((/r1-([a-z0-9]+)/.exec(e.line) || [])[1] || '?') + ':' + e.status).sort(),
			told: DaimondNotes.steerFor('any-model', '') }; });
	const hasN = (v, k, st) => v.all.indexOf(k + ':' + st) !== -1;
	for (const s of [A, B]) await optSeed(s);
	// Each device seeded the Optimiser at its fixed id, so the first meeting is two-sided; the note made before it is on both after.
	await acctAdd(A, 'Name the source of each figure, r1-common.', 'wrong');
	await optTick(B);
	await round(); await round();
	let ra = await acctView(A), rb = await acctView(B);
	check('R0 the account note made before the first meeting is on both devices (the control for G5)', hasN(ra, 'common', 'active') && hasN(rb, 'common', 'active'), JSON.stringify([ra.all, rb.all]));
	const R1_TAG = { G5a: ['r1a', 'scope'], G5b: ['r1b', 'long'], G5c: ['common', ''] };
	for (const arm of ['G5a', 'G5b', 'G5c']) {
		// B's Optimiser timer moves the Diamond and pushes; A has not moved it, so A's pull applies a one-sided copy.
		await round();
		await optTick(B); await push(B);
		const [key, tag] = R1_TAG[arm];
		const g = await A.page.evaluate(async ({ arm, key, tag }) => {
			const app = DaimondCore.diamondApp(), oi = app.import_diamond, ol = app.list_diamonds;
			let fired = null, answered = false, imports = 0, two = null, listed = 0, armed = true;
			const cid = (DaimondNotes.all().find((e) => e.level === 3 && /r1-common/.test(e.line)) || {}).id;
			const press = () => (arm === 'G5c'
				? DaimondNotes.retire({ level: 3, scope: '', id: cid }, { t: 0, n: 2 })
				: DaimondNotes.add({ level: 3, scope: '', cm: 'all', tag, line: 'Pressed mid-pull, r1-' + key + '.', at: { t: 0, n: 0 } })
			).then((x) => { answered = true; return x; }, () => { answered = true; return null; });
			// G5a, G5c: the press completes right after applyDiamonds' own list, which is the one it then decides from.
			app.list_diamonds = async function () {
				const mine = /applyDiamonds/.test(new Error().stack || '');
				const r = await ol.apply(this, arguments);
				if (mine && arm !== 'G5b' && armed) { armed = false; listed++; fired = press(); await fired; }
				return r;
			};
			// G5b: the press is made as the import starts and not waited for there; it is the page's to queue.
			app.import_diamond = async function (data, tw) {
				imports++; two = tw;
				if (arm === 'G5b' && !fired) fired = press();
				return oi.apply(this, arguments);
			};
			try {
				await DaimondSync.pull();
				if (fired) await Promise.race([fired, new Promise((r) => setTimeout(r, 15000))]);
			} finally { app.import_diamond = oi; app.list_diamonds = ol; }
			return { pressed: !!fired, answered, imports, two, listed };
		}, { arm, key, tag });
		note(`${arm}: pressed=${g.pressed}, answered=${g.answered}, imports=${g.imports}, twoSided=${g.two}`);
		const aNow = await acctView(A);
		await round(); await round();
		ra = await acctView(A); rb = await acctView(B);
		if (arm === 'G5c') {
			check('G5c an account Remove pressed during a pull stays removed (A right after, then both) and is not told again',
				g.pressed && g.answered && hasN(aNow, key, 'retired') && hasN(ra, key, 'retired') && hasN(rb, key, 'retired') && ra.told.indexOf('r1-common') === -1 && rb.told.indexOf('r1-common') === -1,
				`A right after ${JSON.stringify(aNow.all)}, A ${JSON.stringify(ra.all)}, B ${JSON.stringify(rb.all)}, A told it ${ra.told.indexOf('r1-common') !== -1}`);
			continue;
		}
		check(`${arm} an account Add pressed during a pull stands (A right after, then both)`,
			g.pressed && g.answered && hasN(aNow, key, 'active') && hasN(ra, key, 'active') && hasN(rb, key, 'active'),
			`answered=${g.answered}, A right after ${hasN(aNow, key, 'active')}, A ${hasN(ra, key, 'active')}, B ${hasN(rb, key, 'active')}`);
	}

	// ═══ G5d (L7): THE PRESS IS MADE IN A SECOND TAB OF THE SAME DEVICE ═══
	// The lock was this page's alone. A press in another tab of the device (same origin, same storage, so the same Diamond files) ran
	// beside the first tab's import: it read and wrote the note file while the import replaced it, and the Add was gone from both
	// devices. The lock is now the browser's (Web Locks), so the second tab waits for the first tab's apply and lands after it.
	//   G5d  tab A1 pulls a one-sided copy of the Optimiser; as its import is about to start, tab A2 presses an Add and the import is held
	//        until A2's press has completed (or 2.5 s have passed, which is what happens when the press is held off by the lock).
	console.log('\n— R1 L7: a note pressed in a SECOND TAB while the first tab applies the Optimiser —');
	{
		const pg2 = await A.browser.newPage();
		A2 = { page: pg2, browser: A.browser, name: 'dconf-a2', errs: [], logs: [], net: [], foreign: [] };
		await patchedSource(pg2);
		await pg2.goto(A.page.url(), { waitUntil: 'domcontentloaded' });
		await signInAs(A2, 'dconf'); await ready(A2); await notesReady(A2);
		const lockHeld = await A.page.evaluate(() => !!(navigator.locks && navigator.locks.request));
		note(`Web Locks in the page: ${lockHeld}`);
		await round();
		await optTick(B); await push(B);
		let pressP = null, pressed = false;
		await A.page.exposeFunction('__tabB', async () => {
			if (pressed) return 'again';
			pressed = true;
			pressP = pg2.evaluate(async () => {
				await DaimondCore.loadDiamonds();
				const e = await DaimondNotes.add({ level: 3, scope: '', cm: 'all', tag: 'r1d', line: 'Pressed in the second tab, r1-tabb.', at: { t: 0, n: 0 } });
				return e ? e.id : '';
			}).then((x) => ({ ok: true, id: x }), (e) => ({ ok: false, why: String((e && e.message) || e) }));
			return Promise.race([pressP.then(() => 'done'), new Promise((r) => setTimeout(() => r('waiting'), 2500))]);
		});
		const g = await A.page.evaluate(async () => {
			const app = DaimondCore.diamondApp(), oi = app.import_diamond;
			let imports = 0, two = null, told = '';
			app.import_diamond = async function (data, tw) {
				imports++; two = tw;
				if (imports === 1) told = await window.__tabB();
				return oi.apply(this, arguments);
			};
			try { await DaimondSync.pull(); } finally { app.import_diamond = oi; }
			return { imports, two, told };
		});
		const pr = pressP ? await Promise.race([pressP, new Promise((r) => setTimeout(() => r({ ok: false, why: 'not answered in 15 s' }), 15000))]) : { ok: false, why: 'never pressed' };
		note(`G5d: imports=${g.imports}, twoSided=${g.two}, A2's press was ${g.told} when the import was let go; answered ok=${pr.ok}${pr.ok ? '' : ' (' + pr.why + ')'}`);
		const a1 = await acctView(A);
		const a2 = await pg2.evaluate(async () => { await DaimondCore.loadDiamonds(); await DaimondNotes.reload(true);
			return { all: DaimondNotes.all().filter((e) => e.level === 3).map((e) => ((/r1-([a-z0-9]+)/.exec(e.line) || [])[1] || '?') + ':' + e.status).sort() }; });
		await round(); await round();
		ra = await acctView(A); rb = await acctView(B);
		check('G5d an account Add pressed in a second tab during the first tab\'s pull stands (tab A1 and tab A2 right after, then both devices)',
			g.imports >= 1 && pr.ok && hasN(a1, 'tabb', 'active') && hasN(a2, 'tabb', 'active') && hasN(ra, 'tabb', 'active') && hasN(rb, 'tabb', 'active'),
			`A2 answered=${pr.ok}, A1 right after ${hasN(a1, 'tabb', 'active')}, A2 right after ${hasN(a2, 'tabb', 'active')}, A ${hasN(ra, 'tabb', 'active')}, B ${hasN(rb, 'tabb', 'active')}`);
	}

} catch (e) {
	console.log('VERIFY THREW:', e && (e.stack || e.message || e));
	bad.push('verify threw: ' + (e && e.message));
} finally {
	try { await A2?.page?.close?.(); } catch (e) {}
	try { await A?.close?.(); } catch (e) {}
	try { await B?.close?.(); } catch (e) {}
	console.log('\n=== SUMMARY ' + ok.length + ' ok, ' + bad.length + ' FAIL ' + (BREAK ? '(--break: FAILs are expected)' : '') + ' ===');
	if (bad.length) { bad.forEach((x) => console.log('  FAIL ' + x)); process.exitCode = 1; }
}
