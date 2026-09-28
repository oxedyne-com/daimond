// gateway: none
// verify_diamondfork.mjs -- lane DIA (2026-09-27): a Diamond edit is replaced by another device's copy only when that
// copy was built on it; otherwise it is kept ("kept before sync"), its tags unioned. Promoted from lane CHK's probe
// `chk_forkflight.mjs` (qa/split-checks @ 01a5acf8, specs/daimond_split_checks_20260927.md Q1).
//
// THE BUG (5.2.1). `applyDiamonds` read an arrival as one-sided when this device's stamp equalled its fork point, and
// the fork point moved on every landed push, read from the live store:
//   D1  an edit made while a push flies is recorded as agreed although it never travelled; the other device's later
//       copy replaces it, nothing kept, its tag lost.
//   D2  with no flight: A's edit lands first; B, which had also moved, skips A's older copy; B's copy lands; A reads
//       it as one-sided. A landed push says "the mailbox took my copy", not "the other device holds it".
// THE FIX. Each parcel entry carries its copy's lineage (`anc`, the stamps it descends from, at most 16); each device
// records its copy's lineage and what it last RECEIVED (`daimond-diamond-recv`); an arrival is two-sided when this
// device moved since its receipt and the arrival's lineage holds no copy this device is holding. An entry with no
// `anc` (5.2.1) takes the fork point's rule, the fork now committed from the parcel that landed (unit DAF). A
// two-sided merge settles tags, marks, name and grants THREE-WAY against the newest copy in the arrival's lineage
// this device recorded (`daimond-diamond-seen`), so a removal made on either side stands (lane DIA2, QDIA F1-F6).
//
// Arms, two Chromium devices over an in-process cloud (the mailbox with the gateway's version guard, a sweeping chunk
// store), the real wasm:
//   D1  A's POST held after collect; A edits X (page + tag); lands; B pulls, edits later, pushes; A pulls.
//   D2  A edits Y, lands; B (not pulled) edits later, pushes (409, pull, retry); A pulls.
//   C   control (verify_diamondconflict's shape): A edits Z offline, B later, A pulls first.
//   R   the ordinary relay, both ways, twice: nothing kept on either device.
//   M   a device that misses a run of the other's pushes: nothing kept.
//   R3  (QDIA relay3 (b)) three devices: A edits with a tag and a mark; B takes both off and edits; C edits; A pulls
//       C's. Clean: no kept copy, the tag and mark stay off, the mark is in force nowhere (F1).
//   M3  (QDIA miss3) A made the Diamond and is idle; B drops a tag and edits; C edits; A pulls. Clean (F1).
//   RM  (QDIA rmconf) a mark agreed; A edits the page, B takes the mark off; each order. A's page kept, the mark off
//       on both and in force nowhere (F2).
//   CB  (QDIA combo) A renames, tags and edits; B's later page edit wins: A's name and tag live (F4).
//   MX  a 5.2.1 page (O, served 45f7cf02's daimond.js) beside this one: D1 with O as the other device (must keep);
//       then the stated bounds, reported, not asserted: D2 against O, and O's own in-flight edit.
//
//   node dev/verify_diamondfork.mjs                 # must be green
//   node dev/verify_diamondfork.mjs --break legacy  # 5.2.1's rule: D1, D2 and MX-D1 must redden
//   node dev/verify_diamondfork.mjs --break onehop  # round 1's one-copy lineage: R3 and M3 must redden
//   node dev/verify_diamondfork.mjs --break union   # no common copy, the conflict unions: RM and CB must redden
//   node dev/verify_diamondfork.mjs --base          # on a tree without the fix (5.2.1): the arms as it stands
//
// --break legacy serves a daimond.js whose two-sided test is the fork point's alone and whose landing reads the live
// store, i.e. 5.2.1's Diamond merge, without touching the shipped code. Chromium only (a Diamond needs OPFS; the
// break and the old page ride `page.route`). Needs dev/serve.mjs only.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
const BREAK   = arg('--break', '');
const BASE    = process.argv.includes('--base');		// a tree without the fix: no seam, no break
const OLD_REF = arg('--old', '45f7cf02');		// the 5.2.1 page the MX arm runs beside this one
if (BREAK && !['legacy', 'onehop', 'union'].includes(BREAK)) { console.error(`unknown break '${BREAK}'; only: legacy, onehop, union`); process.exit(2); }
if (BROWSER !== 'chromium') { console.error('Chromium only: a Diamond needs OPFS, and the old page rides page.route.'); process.exit(2); }

// ── The seam must be present, or a green run would prove nothing ──────
const FILE = 'js/daimond.js';
const SRC  = fs.readFileSync(path.join(WWW, FILE), 'utf8');
const SEAM = [
	'var twoSided = diamondTwoSided(r, mine, recv, dbase);',
	'try { await commitDiamondBaseline(fork); } catch (e) { /* best effort */ }',
	'anc:     anc,',
	'plan = diamondMergePlan(wf, lf, wfOk ? seenAncestor(seen[r.id], rAnc) : null);',
	'if (stamp === rv.c) return rv.anc.slice();',
	'var a = rv.c > 0 ? rv.anc.concat([rv.c]) : rv.anc.slice();',
];
for (const s of SEAM) {
	const n = SRC.split(s).length - 1;
	if (n < 1 && !BASE) { console.error(`seam missing in ${FILE}: ${s}`); process.exit(2); }
}
if (BASE && BREAK) { console.error('--base runs the tree as it stands; it takes no break'); process.exit(2); }

// ── The break: 5.2.1's rule, in this tree's file ──────────────────────
let SERVED = null;
if (BREAK === 'legacy') {
	let s = SRC;
	const swap = (a, b) => {
		const n = s.split(a).length - 1;
		if (n < 1) { console.error(`break anchor missing: ${a}`); process.exit(2); }
		s = s.split(a).join(b);
	};
	swap('var twoSided = diamondTwoSided(r, mine, recv, dbase);',
		'var twoSided = !!mine && (!Object.prototype.hasOwnProperty.call(dbase, r.id) || diamondStamp(mine) !== (dbase[r.id] || 0));');
	swap('try { await commitDiamondBaseline(fork); } catch (e) { /* best effort */ }',
		'try { await commitDiamondBaseline(); } catch (e) { /* best effort */ }');
	SERVED = s;
}
if (BREAK === 'onehop' || BREAK === 'union') {
	let s = SRC;
	const swap = (a, b) => {
		const n = s.split(a).length - 1;
		if (n !== 1) { console.error(`break anchor appears ${n} times: ${a}`); process.exit(2); }
		s = s.split(a).join(b);
	};
	if (BREAK === 'onehop') {
		swap('if (stamp === rv.c) return rv.anc.slice();', 'if (stamp === rv.c) return rv.anc.slice(-1);');
		swap('var a = rv.c > 0 ? rv.anc.concat([rv.c]) : rv.anc.slice();', 'var a = rv.c > 0 ? [rv.c] : [];');
	} else {
		swap('plan = diamondMergePlan(wf, lf, wfOk ? seenAncestor(seen[r.id], rAnc) : null);', 'plan = diamondMergePlan(wf, lf, null);');
	}
	SERVED = s;
}
const serveAs = (body) => async (page) => {
	if (body === null) return;
	await page.route('**/' + FILE, r => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
};
// The 5.2.1 page: the old daimond.js, everything else this tree's (the release changes no other file).
let OLD_SRC = null;
try { OLD_SRC = execFileSync('git', ['show', OLD_REF + ':www/' + FILE], { cwd: path.join(HERE, '..'), maxBuffer: 64 << 20 }).toString(); }
catch (e) { console.error(`cannot read ${OLD_REF}:www/${FILE} for the old page: ${e.message}`); process.exit(2); }
if (OLD_SRC.indexOf('diamondTwoSided') !== -1) { console.error(`${OLD_REF} already carries the fix; it is not an old page`); process.exit(2); }

// ── The cloud, in this process, shared by every context ──────────────
const cloud = { mailbox: null, chunks: new Map(), hold: null, held: null, block: null };
async function serve(dev, rawPath, method, bodyText) {
	const p = String(rawPath).split('?')[0];
	const body = bodyText ? JSON.parse(bodyText) : {};
	if (p === '/api/sync') {
		// THE BLOCK: the device's own sync timers must not reach the mailbox in a window an
		// arm has to order (D2: B must not pull A's copy, nor land first).
		if (cloud.block === dev) return { status: 503, json: { ok: false } };
		if (method === 'GET') {
			if (!cloud.mailbox) return { status: 200, json: { present: false, version: 0 } };
			return { status: 200, json: { present: true, version: cloud.mailbox.version,
				blob: cloud.mailbox.blob, device: cloud.mailbox.device } };
		}
		// THE HOLD: a POST from the held device waits here, after its parcel was collected.
		if (cloud.hold === dev) await new Promise((r) => { cloud.held = r; });
		const cur = cloud.mailbox ? cloud.mailbox.version : 0;
		if ((body.base_version | 0) !== cur) return { status: 409, json: { ok: false, version: cur } };
		cloud.mailbox = { version: cur + 1, blob: body.blob, device: body.device || dev };
		return { status: 200, json: { ok: true, version: cur + 1 } };
	}
	if (p === '/api/chunk') {
		if (body.op === 'put') { (body.chunks || []).forEach(c => cloud.chunks.set(c.addr, c.blob)); return { status: 200, json: { ok: true } }; }
		if (body.op === 'have') return { status: 200, json: { missing: (body.addrs || []).filter(a => !cloud.chunks.has(a)) } };
		if (body.op === 'get') { const blob = cloud.chunks.get(body.addr); return { status: 200, json: blob ? { present: true, blob } : { present: false } }; }
		// No sweep: three devices commit here and this is not a test of the gateway's floor.
		if (body.op === 'commit') return { status: 200, json: { ok: true, swept: 0, free_allowance: 0, paid_bytes: 0 } };
		return { status: 200, json: { ok: true } };
	}
	return { status: 200, json: { ok: true } };
}
async function wireCloud(s, dev) {
	await s.page.exposeFunction('__cloudCall', async (p, method, body) => serve(dev, p, method, body));
	await s.page.evaluate((dev) => {
		window.__dev = dev;
		window.DEBUG_SHARE = { event: () => {} };
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
const push = async (s) => { await s.page.evaluate(() => window.DaimondSync.push()); await s.page.waitForTimeout(300); };
const pull = async (s) => { await s.page.evaluate(() => window.DaimondSync.pull()); await s.page.waitForTimeout(300); };

const edit = (s, id, html, tags) => s.page.evaluate(async ({ id, html, tags }) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.write_crystal_page(id, html);
	if (tags) await app.set_tags(id, JSON.stringify(tags));
	return true;
}, { id, html, tags });
const create = (s, name, html) => s.page.evaluate(async ({ name, html }) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const id = await app.create_diamond(name);
	await app.write_crystal_page(id, html);
	await app.set_tags(id, JSON.stringify(['common']));
	return id;
}, { name, html });
const stampFork = (s, id) => s.page.evaluate(async (did) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const d = JSON.parse(await app.list_diamonds()).find(x => x.id === did);
	const base = JSON.parse(localStorage.getItem('daimond-diamond-base') || '{}');
	return { stamp: d ? (d.touched || d.updated || 0) : 0, fork: base[did] };
}, id);
const state = (s, id) => s.page.evaluate(async (did) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	let page = '', tags = [], versions = [];
	try { page = await app.read_crystal_page(did); } catch (e) { page = 'ERR:' + (e && e.message); }
	try { const d = JSON.parse(await app.list_diamonds()).find(x => x.id === did); tags = d && Array.isArray(d.tags) ? d.tags.slice() : []; } catch (e) {}
	try { versions = JSON.parse(await app.versions_list(did)); } catch (e) { versions = []; }
	const bodies = [];
	for (const v of versions) {
		for (const e of ((v && v.files) || [])) {
			if (!e || !e.hash || String(e.hash).length < 8) continue;
			try { const raw = await app.versions_body(did, e.hash); if (raw) bodies.push({ note: (v && v.note) || '', body: String(raw) }); } catch (e2) {}
		}
	}
	return { page, tags: tags.map(t => String(t).toLowerCase()), notes: versions.map(v => (v.note || '')), bodies };
}, id);
/// This device's receipt of one Diamond (`daimond-diamond-recv`), or null.
const recvAt = (s, id) => s.page.evaluate((did) => {
	try { const m = JSON.parse(localStorage.getItem('daimond-diamond-recv') || '{}'); return m[did] || null; } catch (e) { return null; }
}, id);
const keptWith = (st, mark) => st.bodies.some(b => /kept before sync/i.test(b.note) && b.body.indexOf(mark) !== -1);
const keptCount = (st) => st.notes.filter(n => /kept before sync/i.test(n)).length;
/// One change as the person makes it (QDIA's `edit`): the page, the name, a tag added or taken off, a mark pressed
/// (the row, then the press recorded here) or taken off.
const change = (s, id, o) => s.page.evaluate(async ({ id, o }) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	if (o.page != null) await app.write_crystal_page(id, o.page);
	if (o.name != null) await app.rename_diamond(id, o.name);
	if (o.addTag || o.dropTag) {
		const d = JSON.parse(await app.list_diamonds()).find((x) => x.id === id);
		let t = (d && d.tags) || [];
		if (o.addTag) t = t.concat([o.addTag]);
		if (o.dropTag) t = t.filter((x) => String(x).toLowerCase() !== String(o.dropTag).toLowerCase());
		await app.set_tags(id, JSON.stringify(t));
	}
	if (o.mark) {
		const ref = DaimondAttach.ref('dir', o.mark);
		await DaimondCore.diamondApp().add_link(id, 'diamond:' + id, ref, 'holds', '', 'user');
		try { await DaimondCore.loadDiamonds(); } catch (e) {}
		await DaimondAttach.confirmHere(id, ref);
	}
	if (o.unmark) {
		const rows = JSON.parse(await DaimondCore.diamondApp().links_touching('diamond:' + id) || '[]')
			.filter((l) => l.owner === id && String(l.other || l.to || '').endsWith(o.unmark));
		for (const r of rows) await DaimondCore.diamondApp().remove_link(id, r.id);
	}
	return true;
}, { id, o });
/// The name, the marks the Diamond's own sidecar holds, and whether mark `path` is in force here.
const marks = (s, id, path) => s.page.evaluate(async ({ id, path }) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const d = JSON.parse(await app.list_diamonds()).find((x) => x.id === id);
	let links = [];
	try { links = JSON.parse(await DaimondCore.diamondApp().links_touching('diamond:' + id) || '[]').filter((l) => l.owner === id)
		.map((l) => String(l.other || l.to || '')); } catch (e) {}
	let force = null;
	if (path) { try { force = await DaimondAttach.inForce(id, DaimondAttach.ref('dir', path)); } catch (e) { force = 'ERR'; } }
	return { name: d ? d.name : null, stamp: d ? (d.touched || d.updated || 0) : 0, links, force };
}, { id, path });
/// Collect the device's parcel, hold its POST, run `during`, then let it land -- and keep
/// the device off the mailbox from then on (`cloud.block`, lifted by the arm), so its own
/// sync timers cannot send the in-flight edit before the other device has built on the
/// copy that landed. The held POST is already past the block, so it lands.
async function flight(s, dev, during) {
	cloud.hold = dev;
	await s.page.evaluate(() => { window.__p = window.DaimondSync.push(); });
	for (let i = 0; i < 100 && !cloud.held; i++) await s.page.waitForTimeout(100);
	const wasHeld = !!cloud.held;
	await during();
	cloud.block = dev;
	cloud.hold = null; const rel = cloud.held; cloud.held = null; if (rel) rel();
	await s.page.evaluate(() => window.__p); await s.page.waitForTimeout(300);
	return wasHeld;
}
const PAGE = (n, t) => `<h1>${n}</h1><p>${t}</p>`;

async function device(label, prof, bundle, served) {
	const s = await open({ name: 'dfork-' + label, profile: prof, signIn: false, connect: false, defaults: false, route: serveAs(served) });
	await ready(s);
	if (bundle) {
		await s.page.evaluate((b) => window.DaimondIdentity.importBundle(b), bundle);
		await s.page.reload({ waitUntil: 'domcontentloaded' });
		await ready(s);
	}
	await signInAs(s, 'dfork'); await ready(s);
	return s;
}

const PROF = (x) => scratch('pw', 'dfork-' + x + '-' + BROWSER + (BREAK ? '-' + BREAK : '') + (BASE ? '-base' : ''));
for (const x of ['a', 'b', 'c', 'o']) fs.rmSync(PROF(x), { recursive: true, force: true });

let A = null, B = null, C = null, O = null;
try {
	console.log(`\n— a Diamond edit is replaced only by a copy built on it${BREAK ? '  [--break ' + BREAK + ']' : ''}${BASE ? '  [--base: the tree as it stands]' : ''} —`);
	A = await device('a', PROF('a'), null, SERVED);
	const OPFS = await A.page.evaluate(() => !!(navigator.storage && navigator.storage.getDirectory));
	if (!OPFS) throw new Error('this engine has no OPFS; a Diamond cannot be created');
	const bundle = await A.page.evaluate(() => window.DaimondIdentity.exportBundle());
	B = await device('b', PROF('b'), bundle, SERVED);
	await clearDiamonds(A); await clearDiamonds(B); await ready(A); await ready(B);
	await wireCloud(A, 'A'); await wireCloud(B, 'B');

	const X = await create(A, 'Flight', PAGE('Flight', 'agreed'));
	const Y = await create(A, 'Concurrent', PAGE('Concurrent', 'agreed'));
	const Z = await create(A, 'Control', PAGE('Control', 'agreed'));
	const R = await create(A, 'Relay', PAGE('Relay', 'agreed'));
	const M = await create(A, 'Missed', PAGE('Missed', 'agreed'));
	const L2 = await create(A, 'Literal', PAGE('Literal', 'agreed'));
	await push(A); await pull(B); await push(B); await pull(A);
	const agreedAll = [];
	for (const id of [X, Y, Z, R, M, L2]) { const a = await stampFork(A, id), b = await stampFork(B, id); agreedAll.push(a.stamp === b.stamp && a.stamp > 0); }
	check('setup: both devices hold the six Diamonds at one copy', agreedAll.every(Boolean), JSON.stringify(agreedAll));

	// ── D1 ────────────────────────────────────────────────────────────
	console.log('\nD1: an edit made while the push flies');
	await edit(A, X, PAGE('Flight', 'A pre-push'), ['common']);
	let inflight = null;
	const held = await flight(A, 'A', async () => {
		await edit(A, X, PAGE('Flight', 'A in flight flight-marker-4e2'), ['common', 'flightTag']);
		inflight = await stampFork(A, X);
	});
	const after = await stampFork(A, X);
	check('D1: the POST was held after collect', held);
	check('D1: the landed fork point is not the unsent edit\'s stamp', after.fork !== inflight.stamp,
		`fork ${after.fork}, in-flight stamp ${inflight.stamp}`);
	await pull(B); await B.page.waitForTimeout(60);
	const d1b0 = await stampFork(B, X);
	await edit(B, X, PAGE('Flight', 'B later desk-marker-8b1'), ['common', 'deskTag']);
	await push(B);
	cloud.block = null;
	check('D1: B built on the copy that landed, not on the unsent edit', d1b0.stamp !== inflight.stamp && d1b0.stamp > 0,
		`B held ${d1b0.stamp}, in-flight ${inflight.stamp}`);
	await pull(A);
	const d1 = await state(A, X);
	note(`A: live ${d1.page.replace(/<[^>]+>/g, ' ').trim().slice(0, 50)} | tags ${JSON.stringify(d1.tags)} | versions ${JSON.stringify(d1.notes.map(n => n.slice(0, 20)))}`);
	check('D1: the other device\'s later copy is live on A', d1.page.indexOf('desk-marker-8b1') !== -1);
	check('D1: A\'s in-flight edit is kept before sync', keptWith(d1, 'flight-marker-4e2'));
	check('D1: A\'s in-flight tag survives on the live copy', d1.tags.indexOf('flighttag') !== -1, JSON.stringify(d1.tags));
	await push(A); await pull(B);
	const d1b = await state(B, X);
	// A's kept version travels in the Diamond's history; none on B may hold B's own edit.
	check('D1: B converges on the union and keeps no copy of its own', d1b.tags.indexOf('flighttag') !== -1 && !keptWith(d1b, 'desk-marker-8b1'),
		`tags ${JSON.stringify(d1b.tags)}, kept ${keptCount(d1b)}`);

	// ── D2 ────────────────────────────────────────────────────────────
	// B is kept off the mailbox until A's copy has landed, so B's own sync timers can neither
	// pull A's copy before B edits (B would then be building on it, and one-sided would be
	// right: D2L below) nor land B's copy first (the control's shape).
	console.log('\nD2: both edit between syncs; the earlier edit lands first');
	cloud.block = 'B';
	await edit(A, Y, PAGE('Concurrent', 'A edit phone-marker-2c9'), ['common', 'aTag']);
	await B.page.waitForTimeout(60);
	await edit(B, Y, PAGE('Concurrent', 'B edit desk-marker-5f0'), ['common', 'bTag']);
	const d2a = await stampFork(A, Y);
	await push(A);					// lands first
	const d2land = await stampFork(A, Y);
	cloud.block = null;
	await push(B);					// 409 -> pull (A's older Y, skipped) -> retry
	note(`A's push landed: fork ${d2land.fork} = A's edit ${d2a.stamp}: ${d2land.fork === d2a.stamp}`);
	const d2br = await recvAt(B, Y);
	note(`A's stamp ${d2a.stamp}; B's receipt of Y after its push ${JSON.stringify(d2br)} (B built on A's copy: ${!!d2br && d2br[0] === d2a.stamp})`);
	await pull(A);
	const d2 = await state(A, Y);
	note(`A: tags ${JSON.stringify(d2.tags)} | versions ${JSON.stringify(d2.notes.map(n => n.slice(0, 20)))}`);
	check('D2: B\'s later copy is live on A', d2.page.indexOf('desk-marker-5f0') !== -1);
	check('D2: A\'s edit is kept before sync', keptWith(d2, 'phone-marker-2c9'));
	check('D2: A\'s tag survives on the live copy', d2.tags.indexOf('atag') !== -1, JSON.stringify(d2.tags));
	await push(A); await pull(B); await push(B); await pull(A);

	// D2L, CHK's order as written: A's push lands BEFORE B edits. B's page may pull A's copy
	// in between on its own (an import schedules a push, whose 409 pulls); the arm reads
	// what B held when it edited to say which happened, and holds the merge to the right
	// answer for each.
	console.log('\nD2L: A\'s edit lands, then B edits (CHK\'s order)');
	await edit(A, L2, PAGE('Literal', 'A edit lit-a-4b8'), ['common', 'litA']);
	const d2la = await stampFork(A, L2);
	await push(A);
	await B.page.waitForTimeout(60);
	const d2lpre = await stampFork(B, L2);			// what B holds when it edits
	await edit(B, L2, PAGE('Literal', 'B edit lit-b-6c0'), ['common', 'litB']);
	await push(B);
	const builtOnA = d2lpre.stamp === d2la.stamp;
	note(`B held L at ${d2lpre.stamp} when it edited; A's edit ${d2la.stamp}: B ${builtOnA ? 'had taken A\'s copy (one-sided is right)' : 'had not (two-sided)'}`);
	await pull(A);
	const d2l = await state(A, L2);
	check('D2L: B\'s later copy is live on A', d2l.page.indexOf('lit-b-6c0') !== -1);
	check('D2L: A\'s edit is kept unless B built on it', builtOnA ? keptCount(d2l) === 0 : keptWith(d2l, 'lit-a-4b8'),
		`built on A's: ${builtOnA}; versions ${JSON.stringify(d2l.notes.map(n => n.slice(0, 20)))}`);
	await push(A); await pull(B); await push(B); await pull(A);

	// ── C ─────────────────────────────────────────────────────────────
	console.log('\nC (control): A edits offline; B edits later and pushes; A pulls first');
	await edit(A, Z, PAGE('Control', 'A offline ctl-marker-a11'), ['common', 'ctlTag']);
	await B.page.waitForTimeout(60);
	await edit(B, Z, PAGE('Control', 'B later ctl-desk-b22'), ['common', 'ctlDesk']);
	await push(B); await pull(A);
	const c = await state(A, Z);
	check('C: the offline edit is kept before sync', keptWith(c, 'ctl-marker-a11'));
	check('C: the tags are the union', ['ctltag', 'ctldesk'].every(t => c.tags.indexOf(t) !== -1), JSON.stringify(c.tags));
	await push(A); await pull(B); await push(B); await pull(A);

	// ── R ─────────────────────────────────────────────────────────────
	console.log('\nR: the ordinary relay, both ways, twice');
	for (let i = 0; i < 2; i++) {
		await edit(A, R, PAGE('Relay', 'A turn ' + i), ['common', 'ra' + i]); await push(A); await pull(B);
		await edit(B, R, PAGE('Relay', 'B turn ' + i), ['common', 'ra' + i, 'rb' + i]); await push(B); await pull(A);
	}
	const ra = await state(A, R), rb = await state(B, R);
	check('R: both hold the last edit', ra.page.indexOf('B turn 1') !== -1 && rb.page.indexOf('B turn 1') !== -1);
	check('R: no copy kept on either device', keptCount(ra) === 0 && keptCount(rb) === 0, `A ${keptCount(ra)}, B ${keptCount(rb)}`);

	// ── M ─────────────────────────────────────────────────────────────
	console.log('\nM: B misses a run of A\'s pushes');
	for (let i = 0; i < 3; i++) { await edit(A, M, PAGE('Missed', 'A run ' + i), null); await push(A); }
	await pull(B);
	await edit(B, M, PAGE('Missed', 'B after the run'), null); await push(B); await pull(A);
	const ma = await state(A, M), mb = await state(B, M);
	check('M: both hold B\'s edit', ma.page.indexOf('B after the run') !== -1 && mb.page.indexOf('B after the run') !== -1);
	check('M: no copy kept on either device', keptCount(ma) === 0 && keptCount(mb) === 0, `A ${keptCount(ma)}, B ${keptCount(mb)}`);

	// ── R3, M3: three devices (QDIA F1) ───────────────────────────────
	console.log('\nR3: three devices, two hops down from A\'s edit (QDIA relay3 (b))');
	C = await device('c', PROF('c'), bundle, SERVED);
	await clearDiamonds(C); await ready(C); await wireCloud(C, 'C');
	const all3 = [A, B, C];
	const settle3 = async (n) => { for (let k = 0; k < (n || 2); k++) { for (const d of all3) await push(d); for (const d of all3) await pull(d); } };
	const has = (xs, end) => xs.some((x) => String(x).endsWith(end));
	const inForce = (m) => !!m.force && m.force !== 'ERR';
	const R3 = await create(A, 'Relay3', PAGE('Relay3', 'agreed'));
	await settle3();
	await change(A, R3, { page: PAGE('Relay3', 'A r3-a'), addTag: 'r3a', mark: 'r3-mark' }); await push(A);
	await pull(B); await B.page.waitForTimeout(60);
	await change(B, R3, { page: PAGE('Relay3', 'B r3-b'), dropTag: 'r3a', unmark: 'r3-mark' }); await push(B);
	await pull(C); await C.page.waitForTimeout(60);
	await change(C, R3, { page: PAGE('Relay3', 'C r3-c'), addTag: 'r3c' }); await push(C);
	await pull(A);
	const r3a = await state(A, R3);
	check('R3: A takes C\'s copy with nothing kept (it descends from A\'s edit through B)', r3a.page.indexOf('r3-c') !== -1 && keptCount(r3a) === 0,
		`kept ${keptCount(r3a)}, tags ${JSON.stringify(r3a.tags)}`);
	await settle3();
	for (const [d, n] of [[A, 'A'], [B, 'B'], [C, 'C']]) {
		const st = await state(d, R3), m = await marks(d, R3, 'r3-mark');
		check(`R3: on ${n} no kept copy, the tag and the mark B took off stay off`, keptCount(st) === 0 && st.tags.indexOf('r3a') === -1
			&& st.tags.indexOf('r3c') !== -1 && !has(m.links, 'r3-mark'), `kept ${keptCount(st)} tags ${JSON.stringify(st.tags)} marks ${JSON.stringify(m.links)}`);
		if (d === A) check('R3: the mark taken off on B is in force nowhere, not on A where it was pressed', !inForce(m), JSON.stringify(m.force));
	}
	console.log('\nM3: the idle creator meets two hops of edits (QDIA miss3)');
	const M3 = await create(A, 'Miss3', PAGE('Miss3', 'agreed'));
	await settle3();
	await change(B, M3, { page: PAGE('Miss3', 'B m3-b'), dropTag: 'common', addTag: 'm3b' }); await push(B);
	await pull(C); await C.page.waitForTimeout(60);
	await change(C, M3, { page: PAGE('Miss3', 'C m3-c'), addTag: 'm3c' }); await push(C);
	await pull(A);
	const m3a = await state(A, M3);
	check('M3: A takes the copy with nothing kept and no tag brought back', m3a.page.indexOf('m3-c') !== -1 && keptCount(m3a) === 0
		&& m3a.tags.indexOf('common') === -1, `kept ${keptCount(m3a)} tags ${JSON.stringify(m3a.tags)}`);
	await settle3();
	const m3s = [];
	for (const d of all3) { const st = await state(d, M3); m3s.push(`${keptCount(st)}:${st.tags.join('+')}`); }
	check('M3: all three hold no kept copy and the same tags, "common" off', m3s.every((x) => x === '0:m3b+m3c' || x === '0:m3c+m3b'), JSON.stringify(m3s));
	await C.close(); C = null;

	// ── RM, CB: the conflict settles tags, marks and the name three-way (QDIA F2, F4) ──
	for (const first of ['A', 'B']) {
		console.log(`\nRM ${first}-first: a page edit against a mark taken off (QDIA rmconf)`);
		const D = await create(A, 'RM' + first, PAGE('RM', 'agreed'));
		const mk = 'rm-mark-' + first;
		await push(A); await pull(B); await push(B); await pull(A);
		await change(A, D, { mark: mk });
		await push(A); await pull(B); await push(B); await pull(A);
		const pre = await marks(B, D, mk);
		const doA = async () => { await change(A, D, { page: PAGE('RM', 'A rm-a-' + first) }); await push(A); };
		const doB = async () => { await change(B, D, { unmark: mk }); await push(B); };
		if (first === 'A') { await doA(); await B.page.waitForTimeout(60); await doB(); }
		else { await doB(); await A.page.waitForTimeout(60); await doA(); }
		await pull(A); await pull(B);
		for (let k = 0; k < 3; k++) { await push(A); await pull(B); await push(B); await pull(A); }
		const sa = await state(A, D), ma = await marks(A, D, mk), mb = await marks(B, D, mk);
		check(`RM ${first}-first: setup, the mark agreed on B`, has(pre.links, mk), JSON.stringify(pre.links));
		check(`RM ${first}-first: A's page edit survives on A (live or kept)`, sa.page.indexOf('rm-a-' + first) !== -1 || keptWith(sa, 'rm-a-' + first),
			`versions ${JSON.stringify(sa.notes.map((n) => n.slice(0, 20)))}`);
		check(`RM ${first}-first: the mark taken off on B is off on both`, !has(ma.links, mk) && !has(mb.links, mk),
			`A ${JSON.stringify(ma.links)} B ${JSON.stringify(mb.links)}`);
		check(`RM ${first}-first: and in force on neither, not on A where it was pressed`, !inForce(ma) && !inForce(mb),
			`A ${JSON.stringify(ma.force)} B ${JSON.stringify(mb.force)}`);
	}
	console.log('\nCB: a rename, a tag and a page in the losing edit (QDIA combo)');
	const K = await create(A, 'Combo', PAGE('Combo', 'agreed'));
	await push(A); await pull(B); await push(B); await pull(A);
	await change(A, K, { page: PAGE('Combo', 'A cb-a'), name: 'Combo renamed on A', addTag: 'cba' }); await push(A);
	await B.page.waitForTimeout(60);
	await change(B, K, { page: PAGE('Combo', 'B cb-b') }); await push(B);
	await pull(A);
	for (let k = 0; k < 2; k++) { await push(A); await pull(B); await push(B); await pull(A); }
	const ka = await state(A, K), kna = await marks(A, K, ''), knb = await marks(B, K, ''), kb = await state(B, K);
	check('CB: A\'s rename is live on both', kna.name === 'Combo renamed on A' && knb.name === 'Combo renamed on A', `${kna.name} / ${knb.name}`);
	check('CB: A\'s tag is live on both, and both edits survive on their devices', ka.tags.indexOf('cba') !== -1 && kb.tags.indexOf('cba') !== -1
		&& (ka.page.indexOf('cb-a') !== -1 || keptWith(ka, 'cb-a')) && (kb.page.indexOf('cb-b') !== -1 || keptWith(kb, 'cb-b') || ka.page.indexOf('cb-b') !== -1),
		`A ${JSON.stringify(ka.tags)} B ${JSON.stringify(kb.tags)}`);

	// ── MX: a 5.2.1 page beside this one ──────────────────────────────
	console.log(`\nMX: a 5.2.1 page (O, ${OLD_REF}'s daimond.js) beside this one`);
	await B.close(); B = null;
	O = await device('o', PROF('o'), bundle, BREAK ? SERVED : OLD_SRC);
	const oldPage = await O.page.evaluate(() => !(window.DaimondCore && DaimondCore.syncForkPoint && DaimondCore.syncForkPoint({ diamonds: [] }).diamonds));
	check('MX: O runs the old Diamond merge', (BREAK || BASE) ? true : oldPage);
	await clearDiamonds(O); await ready(O); await wireCloud(O, 'O');
	await pull(O); await push(O); await pull(A);
	const V = await create(A, 'Mixed', PAGE('Mixed', 'agreed'));
	const W = await create(A, 'MixedConcurrent', PAGE('MixedConcurrent', 'agreed'));
	const U = await create(A, 'MixedOld', PAGE('MixedOld', 'agreed'));
	await push(A); await pull(O); await push(O); await pull(A);
	// D1 with the old page as the other device: the fork from the parcel keeps A's edit.
	await edit(A, V, PAGE('Mixed', 'A pre-push'), ['common']);
	let mxin = null;
	await flight(A, 'A', async () => {
		await edit(A, V, PAGE('Mixed', 'A in flight mx-flight-6a1'), ['common', 'mxTag']);
		mxin = await stampFork(A, V);
	});
	await pull(O); await O.page.waitForTimeout(60);
	const mxo0 = await stampFork(O, V);
	await edit(O, V, PAGE('Mixed', 'O later mx-old-3c4'), ['common', 'oTag']);
	await push(O);
	cloud.block = null;
	check('MX-D1: O built on the copy that landed, not on the unsent edit', mxo0.stamp !== mxin.stamp && mxo0.stamp > 0,
		`O held ${mxo0.stamp}, in-flight ${mxin.stamp}`);
	await pull(A);
	const mx1 = await state(A, V);
	check('MX-D1: A\'s in-flight edit is kept against a 5.2.1 sender', keptWith(mx1, 'mx-flight-6a1'),
		`versions ${JSON.stringify(mx1.notes.map(n => n.slice(0, 20)))}`);
	await push(A); await pull(O); await push(O); await pull(A);
	// The stated bounds, reported: D2 against the old page (its entry cannot say what it was built on).
	await edit(A, W, PAGE('MixedConcurrent', 'A edit mx-a-7d2'), ['common', 'mxa']);
	await push(A); await O.page.waitForTimeout(60);
	await edit(O, W, PAGE('MixedConcurrent', 'O edit mx-o-8e3'), ['common', 'mxo']);
	await push(O); await pull(A);
	const mx2 = await state(A, W);
	note(`bound, D2 against a 5.2.1 sender: A's edit kept=${keptWith(mx2, 'mx-a-7d2')} (5.2.1's behaviour for an old sender's entry)`);
	await push(A); await pull(O); await push(O); await pull(A);
	// And the old page's own in-flight edit, which only its own update fixes.
	await edit(O, U, PAGE('MixedOld', 'O pre-push'), ['common']);
	await flight(O, 'O', async () => { await edit(O, U, PAGE('MixedOld', 'O in flight mx-oflight-9f5'), ['common', 'oflight']); });
	await pull(A); await A.page.waitForTimeout(60);
	await edit(A, U, PAGE('MixedOld', 'A later mx-new-1a6'), ['common', 'anew']);
	await push(A);
	cloud.block = null;
	await pull(O);
	const mx3 = await state(O, U);
	note(`bound, the old page's own in-flight edit: kept=${keptWith(mx3, 'mx-oflight-9f5')} (the old page's fault, fixed by its update)`);
} catch (e) {
	console.log('VERIFY THREW:', e && (e.stack || e.message || e));
	bad.push('verify threw: ' + (e && e.message));
} finally {
	try { await A?.close?.(); } catch (e) {}
	try { await B?.close?.(); } catch (e) {}
	try { await C?.close?.(); } catch (e) {}
	try { await O?.close?.(); } catch (e) {}
	console.log('\n=== SUMMARY ' + ok.length + ' ok, ' + bad.length + ' FAIL ' + (BREAK ? '(--break: FAILs are expected)' : '') + ' ===');
	if (bad.length) { bad.forEach((x) => console.log('  FAIL ' + x)); process.exitCode = 1; }
	if (BREAK) {
		const want = { legacy: ['D1: A\'s in-flight edit', 'D2: A\'s edit is kept', 'MX-D1'], onehop: ['R3', 'M3'], union: ['RM'] }[BREAK];
		const red = want.filter((k) => bad.some((b) => b.indexOf(k) === 0));
		console.log(red.length === want.length ? 'CAUGHT: --break ' + BREAK + ' reddens ' + want.join(', ') + '.'
			: 'NOT CAUGHT: the break left ' + want.filter((k) => red.indexOf(k) === -1).join(', ') + ' green.');
		process.exitCode = red.length === want.length ? 0 : 1;
	}
}
