// gateway: none
// verify_pagelog_merge.mjs — the page-log guard (PLD), three real devices over one shared cloud.
//
// THE BUG (7 Oct 2026). A crystal page that keeps a log appends a row on each device. `applyDiamonds`
// replaced a Diamond wholesale from the fresher copy, so two devices that both appended between syncs
// kept only the fresher side's rows: the other side's were in a "kept before sync" version at best, and
// in no version at all once the log was over the 512 KB a kept version takes.
//
// THE FIX. The engine joins every RECORDED page log row by row (`import_diamond` on a two-sided import,
// `union_logs` where neither copy is fresher), answering `{held, files, here, arriving}`; the app stamps
// where this side added rows, so the joined copy travels back, and holds the Diamond back for the round,
// naming it in the standing "left" banner, where a local log is over 16 MB or cannot be read.
//
// Contexts A, B and C hold one account. The cloud is stood up IN THIS PROCESS (as in
// verify_diamondconflict.mjs). Rows are written through the page's own door (a mounted crystal page's
// `save`, mode append); the rows are synthetic, never the owner's bytes.
//
//   eval "$(bash dev/world.sh 103 --up)"
//   node dev/verify_pagelog_merge.mjs --old <r547 www>   # the gate, with the mixed-version arm
//   node dev/verify_pagelog_merge.mjs --base <r547 www>  # every device on the base (the RED run)
//   node dev/verify_pagelog_merge.mjs --break jsonl      # .jsonl recorded as a log (reddens the daimon arm)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, scratch, clearDiamonds, BROWSER, APP } from './harness.mjs';

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
const OLD   = arg('--old', '');		// an r547 www for the mixed-version device
const BASE  = arg('--base', '');		// an r547 www for every device
if (BREAK && BREAK !== 'jsonl') { console.error(`unknown break '${BREAK}'; only: jsonl`); process.exit(2); }
if (BROWSER !== 'chromium') { console.error('Chromium only: a Diamond needs OPFS, and an old www rides page.route.'); process.exit(2); }
for (const d of [OLD, BASE]) {
	if (d && !fs.existsSync(path.join(d, 'pkg', 'oxedyne_daimond_bg.wasm'))) { console.error(`no www with a wasm at ${d}`); process.exit(2); }
}

// The seam, unless the whole run is the base.
if (!BASE) {
	const src = fs.readFileSync(path.join(WWW, 'js', 'daimond.js'), 'utf8');
	for (const want of ['imp = joinCounts(await app.import_diamond(idata, twoSided));', 'app.union_logs(r.id, udata)', "noteLeft('logs',"]) {
		if (!src.includes(want)) { console.error(`seam missing in js/daimond.js: ${want}`); process.exit(2); }
	}
}

// ── An old www, served whole through page.route (pages, scripts and the wasm) ──
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
	'.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
	'.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
	'.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
const routeFrom = (dir) => async (page) => {
	const origin = new URL(APP).origin, root = path.resolve(dir);
	await page.route((u) => u.origin === origin && !u.pathname.startsWith('/api'), async (r) => {
		const u = new URL(r.request().url());
		let f = path.normalize(path.join(root, decodeURIComponent(u.pathname)));
		if (!f.startsWith(root)) return r.fulfill({ status: 403, body: 'no' });
		try {
			if (fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
			return r.fulfill({ status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream',
				headers: { 'cache-control': 'no-cache' }, body: fs.readFileSync(f) });
		} catch (e) { return r.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' }); }
	});
};

// ═══ THE CLOUD, in this process, shared by every context ═══
const cloud = { mailbox: null, chunks: new Map() };
function serve(dev, rawPath, method, bodyText) {
	const p = String(rawPath).split('?')[0];
	const body = bodyText ? JSON.parse(bodyText) : {};
	if (p === '/api/sync') {
		if (method === 'GET') {
			if (!cloud.mailbox) return { status: 200, json: { present: false, version: 0 } };
			return { status: 200, json: { present: true, version: cloud.mailbox.version, blob: cloud.mailbox.blob, device: cloud.mailbox.device } };
		}
		const cur = cloud.mailbox ? cloud.mailbox.version : 0;
		if ((body.base_version | 0) !== cur) return { status: 409, json: { ok: false, version: cur } };
		cloud.mailbox = { version: cur + 1, blob: body.blob, device: body.device || dev };
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
			return { status: 200, json: { ok: true, swept, free_allowance: 0, paid_bytes: 0 } };
		}
		return { status: 200, json: { ok: true } };
	}
	return { status: 200, json: { ok: true } };
}
async function wireCloud(s, dev) {
	await s.page.exposeFunction('__cloudCall', async (p, method, body) => serve(dev, p, method, body));
	await s.page.evaluate(async (dev) => {
		window.__dev = dev;
		window.DaimondGateway.state = function () { return { authed: true, credits: 0, pro: false }; };
		window.DaimondGateway.gwFetch = async function (p, opts) {
			const r = await window.__cloudCall(String(p), (opts && opts.method) || 'GET', String((opts && opts.body) || ''));
			return { status: r.status, json: async () => r.json };
		};
		window.__m = await import('/pkg/oxedyne_daimond.js');
		window.__free = new window.__m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	}, dev);
}
const ready = (s) => s.page.waitForFunction(
	() => !!(window.DaimondCore && DaimondCore.collectSync && DaimondCore.applySync && window.DaimondSync
		&& window.DaimondCloud && window.DaimondGateway && window.DaimondIdentity),
	null, { timeout: 30000 });
const push = async (s) => { await s.page.evaluate(() => window.DaimondSync.push()); await s.page.waitForTimeout(400); };
const pull = async (s) => { await s.page.evaluate(() => window.DaimondSync.pull()); await s.page.waitForTimeout(400); };
const round = async (...devs) => { for (const d of devs) { await pull(d); await push(d); } for (const d of devs) await pull(d); };

// ── Reads, from outside the app ──
const rd = (s, id, rel) => s.page.evaluate(async (a) => {
	try { return await window.__m.store_read('diamonds/' + a.id + '/' + a.rel); } catch (e) { return null; }
}, { id, rel });
const wr = (s, id, rel, text) => s.page.evaluate(async (a) => { await window.__m.store_write('diamonds/' + a.id + '/' + a.rel, a.text); }, { id, rel, text });
const stamp = (s, id) => s.page.evaluate(async (did) => {
	try { const d = JSON.parse(await window.__free.list_diamonds()).find(x => x.id === did); return d ? (d.touched || d.updated || 0) : 0; }
	catch (e) { return 0; }
}, id);
const kept = (s, id) => s.page.evaluate(async (did) => {
	let vs = [];
	try { vs = JSON.parse(await window.__free.versions_list(did)); } catch (e) { return { n: 0, bodies: [] }; }
	const ks = vs.filter(v => /kept before sync/i.test((v && v.note) || ''));
	const bodies = [];
	for (const v of ks) for (const e of ((v && v.files) || [])) {
		if (!e || typeof e.hash !== 'string' || e.hash.length < 8) continue;
		try { const raw = await window.__free.versions_body(did, e.hash); if (raw) bodies.push(String(raw)); } catch (e2) {}
	}
	return { n: ks.length, bodies };
}, id);
const trailHas = (s, w) => s.page.evaluate((w) => {
	let rows = [];
	try { rows = (window.DaimondTrail && DaimondTrail.rows && DaimondTrail.rows()) || []; } catch (e) {}
	return rows.filter(r => JSON.stringify(r).indexOf(w) !== -1).length;
}, w);
const banner = (s) => s.page.evaluate(() => {
	const b = document.querySelector('.left-banner');
	return b && !b.hidden ? b.textContent : '';
});
const lines = (t) => String(t || '').split('\n').filter(Boolean);
const hasAll = (t, rows) => rows.every(r => lines(t).indexOf(r) !== -1);
const row = (tag) => JSON.stringify({ t: '2026-10-07T08:14:00', what: 'synthetic ' + tag });

// ── The page: a crystal that saves through the frame's door, as a logging capp does ──
const PAGE = `<!doctype html><meta charset="utf-8"><body><div id="out">idle</div><script>
var P = 1, seq = 0, waiting = {};
function send(cmd, extra) {
	var id = 'r' + (++seq);
	var msg = Object.assign({ dc: 1, v: P, cmd: cmd, id: id }, extra || {});
	return new Promise(function (res) { waiting[id] = res; parent.postMessage(msg, '*'); });
}
window.addEventListener('message', function (e) {
	var m = e.data;
	if (!m || m.dc !== 1) return;
	if (m.id && waiting[m.id]) { waiting[m.id](m); delete waiting[m.id]; return; }
	if (m.cmd === 'data') parent.postMessage({ dc: 1, v: P, cmd: 'rendered', keys: [] }, '*');
});
window.__capp = { save: function (p, t, mode) { return send('save', { path: p, text: t, mode: mode }); } };
parent.postMessage({ dc: 1, v: P, cmd: 'ready' }, '*');
<\/script></body>`;

async function frameOf(s, id, tries = 24) {
	for (let i = 0; i < tries; i++) {
		const f = s.page.frames().find(fr => fr.url().indexOf('blob:') === 0);
		if (f) { try { if (await f.evaluate(() => !!(window.__capp && window.__capp.save))) return f; } catch (e) {} }
		if (i === 8 || i === 16) {
			try {
				await s.page.evaluate(() => DaimondPanels.show('ai'));
				await s.page.click(`.diamond-box[data-id="${id}"]`, { force: true, timeout: 3000 });
			} catch (e) {}
		}
		await s.page.waitForTimeout(250);
	}
	throw new Error(s.name + ': the crystal frame is not mounted');
}
const save = async (s, id, rel, text) => {
	const f = await frameOf(s, id);
	const r = await f.evaluate((a) => window.__capp.save(a.rel, a.text, 'append'), { rel, text });
	return !!(r && r.ok);
};

async function device(name, profile, bundle, www) {
	const s = await open({ name, profile, signIn: false, connect: false, defaults: false,
		route: www ? routeFrom(www) : null, serviceWorkers: www ? 'block' : 'allow' });
	await ready(s);
	if (bundle) {
		await s.page.evaluate((b) => window.DaimondIdentity.importBundle(b), bundle);
		await s.page.reload({ waitUntil: 'domcontentloaded' });
		await ready(s);
	}
	await signInAs(s, 'plmerge'); await ready(s);
	await clearDiamonds(s); await ready(s);
	await wireCloud(s, name);
	return s;
}
const PROF = (k) => {
	const d = scratch('pw', 'plmerge-' + k + '-' + BROWSER + (BASE ? '-base' : '') + (BREAK ? '-' + BREAK : ''));
	fs.rmSync(d, { recursive: true, force: true });
	return d;
};

const SEED = row('seed');
let A = null, B = null, C = null, O = null;
try {
	console.log(`\n— page-log guard: three devices${BASE ? '  [BASE ' + BASE + ']' : ''}${BREAK ? '  [--break ' + BREAK + ']' : ''} —`);
	A = await device('pl-a', PROF('a'), null, BASE);
	const bundle = await A.page.evaluate(() => window.DaimondIdentity.exportBundle());
	B = await device('pl-b', PROF('b'), bundle, BASE);
	C = await device('pl-c', PROF('c'), bundle, BASE);

	// ── A makes Diamond X, a page that logs, and one seed row through the door ──
	const X = await A.page.evaluate(async (pg) => {
		const id = await window.__free.create_diamond('Pagelog');
		await window.__free.run_tool('file_write', JSON.stringify({ path: 'diamonds/' + id + '/crystal.json', content: JSON.stringify({ title: 'Pagelog', summary: 'a page that logs' }) }));
		await window.__free.run_tool('file_write', JSON.stringify({ path: 'diamonds/' + id + '/crystal.html', content: pg }));
		try { await DaimondCore.loadDiamonds(); } catch (e) {}
		return id;
	}, PAGE);
	note('X = ' + X.slice(0, 12) + '…');
	check('setup: the seed row is saved through the page', await save(A, X, 'log.txt', SEED));
	await push(A); await pull(B); await pull(C);
	await round(A, B, C);
	const s0 = [await rd(A, X, 'log.txt'), await rd(B, X, 'log.txt'), await rd(C, X, 'log.txt')];
	check('setup: A, B and C hold X with the seed row', s0.every(t => hasAll(t, [SEED])), JSON.stringify(s0.map(t => lines(t).length)));
	for (const d of [B, C]) await frameOf(d, X);
	if (BREAK === 'jsonl') {
		// The extension rule: a `.jsonl` taken for a page log without the page's door having recorded it.
		for (const d of [A, B]) await wr(d, X, '.daimond/pagelogs', lines(await rd(d, X, '.daimond/pagelogs')).concat(['meals.jsonl']).join('\n') + '\n');
	}

	// ═══ 1. both append in one window (the 7 Oct shape), and 10. a daimon's .jsonl ═══
	const A1 = row('a1'), B1 = row('b1');
	const MA = '{"meal":"oats","by":"daimon on A"}\n', MB = '{"meal":"eggs","by":"daimon on B"}\n';
	const kA0 = (await kept(A, X)).n;
	check('1 setup: A appends offline', await save(A, X, 'log.txt', A1));
	await A.page.evaluate(async (a) => { await window.__free.run_tool('file_write', JSON.stringify({ path: 'diamonds/' + a.id + '/meals.jsonl', content: a.t })); }, { id: X, t: MA });
	await B.page.waitForTimeout(60);
	check('1 setup: B appends offline, later', await save(B, X, 'log.txt', B1));
	await B.page.evaluate(async (a) => { await window.__free.run_tool('file_write', JSON.stringify({ path: 'diamonds/' + a.id + '/meals.jsonl', content: a.t })); }, { id: X, t: MB });
	await push(A); await pull(B); await push(B); await pull(A);
	await round(A, B);
	const la = await rd(A, X, 'log.txt'), lb = await rd(B, X, 'log.txt');
	check('1 both append in one window: A holds both rows', hasAll(la, [SEED, A1, B1]), JSON.stringify(lines(la).map(l => l.slice(-12))));
	check('1 both append in one window: B holds both rows', hasAll(lb, [SEED, A1, B1]), JSON.stringify(lines(lb).map(l => l.slice(-12))));
	check('1 both append in one window: the two logs are byte-equal', la === lb, (la || '').length + ' / ' + (lb || '').length);
	// 5. The kept version is still written on the side that lost the import.
	const kA1 = await kept(A, X);
	check('5 kept version still written: A keeps its own copy as a version', kA1.n > kA0 && kA1.bodies.some(b => b.indexOf('synthetic a1') !== -1), `kept ${kA0} -> ${kA1.n}`);
	// 10. The daimon's file is replaced as today: one side's content, whole.
	const ma = await rd(A, X, 'meals.jsonl'), mb = await rd(B, X, 'meals.jsonl');
	check('10 daimon-written .jsonl stays out of the join: replaced whole, the same on both',
		ma === mb && (ma === MA || ma === MB), JSON.stringify([ma, mb]));

	// ═══ 2. settles ═══
	const st = [await stamp(A, X), await stamp(B, X)], kn = [(await kept(A, X)).n, (await kept(B, X)).n];
	await round(A, B); await round(A, B);
	const st2 = [await stamp(A, X), await stamp(B, X)], kn2 = [(await kept(A, X)).n, (await kept(B, X)).n];
	check('2 settles: stamps unchanged over two quiet rounds', st[0] === st2[0] && st[1] === st2[1] && st2[0] === st2[1], JSON.stringify([st, st2]));
	check('2 settles: no further kept version', kn[0] === kn2[0] && kn[1] === kn2[1], JSON.stringify([kn, kn2]));

	// ═══ 3. one-sided writes nothing ═══
	const kC0 = (await kept(C, X)).n, jC0 = await trailHas(C, 'sync log joined');
	await pull(C);
	const lc = await rd(C, X, 'log.txt');
	check('3 one-sided writes nothing: C takes A\'s log whole', lc === la, (lc || '').length + ' vs ' + (la || '').length);
	// Versions travel with the copy, so C's kept count follows A's on a one-sided take; what must not
	// happen is a version minted on C, or a join run there.
	const kC1 = (await kept(C, X)).n, kA3 = (await kept(A, X)).n, jC1 = await trailHas(C, 'sync log joined');
	check('3 one-sided writes nothing: C keeps no version of its own (its kept count is A\'s)', kC1 === kA3, `C ${kC0} -> ${kC1}, A ${kA3}`);
	check('3 one-sided writes nothing: no join on C', jC1 === jC0, jC0 + ' -> ' + jC1);

	// ═══ 4. equal-stamp divergence joins ═══
	const EA = row('eq-a'), EB = row('eq-b');
	const T = Math.max(await stamp(A, X), await stamp(B, X)) + 5000;
	for (const [d, r] of [[A, EA], [B, EB]]) {
		const cur = await rd(d, X, 'log.txt');
		await wr(d, X, 'log.txt', (cur && !cur.endsWith('\n') ? cur + '\n' : cur || '') + r);
		const meta = await rd(d, X, '.daimond/meta.json');
		await wr(d, X, '.daimond/meta.json', String(meta).replace(/"touched":\d+/, '"touched":' + T));
	}
	check('4 setup: A and B hold one stamp with different rows', (await stamp(A, X)) === T && (await stamp(B, X)) === T);
	await push(A); await pull(B); await push(B); await pull(A);
	await round(A, B);
	const ea = await rd(A, X, 'log.txt'), eb = await rd(B, X, 'log.txt');
	check('4 equal-stamp divergence joins: A holds both rows', hasAll(ea, [EA, EB]), JSON.stringify(lines(ea).slice(-3).map(l => l.slice(-10))));
	check('4 equal-stamp divergence joins: B holds both rows', hasAll(eb, [EA, EB]), JSON.stringify(lines(eb).slice(-3).map(l => l.slice(-10))));
	check('4 equal-stamp divergence joins: byte-equal', ea === eb);

	// ═══ 6. three devices converge ═══
	await round(A, B, C);
	const R6 = [row('c3-a'), row('c3-b'), row('c3-c')];
	const sv6 = [];
	for (const [i, d] of [A, B, C].entries()) { sv6.push(await save(d, X, 'log.txt', R6[i])); await d.page.waitForTimeout(40); }
	check('6 setup: each of A, B and C appends offline', sv6.every(Boolean), JSON.stringify(sv6));
	await push(A); await pull(B); await push(B); await pull(C); await push(C); await pull(A); await push(A); await pull(B);
	await round(A, B, C); await round(A, B, C);
	const l6 = [await rd(A, X, 'log.txt'), await rd(B, X, 'log.txt'), await rd(C, X, 'log.txt')];
	check('6 three devices converge: every device holds every row', l6.every(t => hasAll(t, R6)), JSON.stringify(l6.map(t => R6.map(r => lines(t).indexOf(r) !== -1 ? 1 : 0).join(''))));
	check('6 three devices converge: byte-equal', l6[0] === l6[1] && l6[1] === l6[2], JSON.stringify(l6.map(t => (t || '').length)));

	// ═══ 7. import between write and stamp: A appends through the door while its pull imports ═══
	const R7B = row('r7-b');
	check('7 setup: B appends and pushes', await save(B, X, 'log.txt', R7B));
	await push(B);
	const fA = await frameOf(A, X);
	const pullP = A.page.evaluate(() => window.DaimondSync.pull());
	const R7A = [];
	for (let i = 0; i < 12; i++) {
		const r = row('r7-a' + i);
		let okd = false;
		try { okd = await Promise.race([fA.evaluate((a) => window.__capp.save('log.txt', a, 'append').then(m => !!(m && m.ok)), r), new Promise(res => setTimeout(() => res(false), 25000))]); } catch (e) { okd = false; }
		if (okd) R7A.push(r);
		await A.page.waitForTimeout(5);
	}
	await pullP;
	await round(A, B); await round(A, B);
	const l7 = [await rd(A, X, 'log.txt'), await rd(B, X, 'log.txt')];
	note(`7: ${R7A.length} of 12 appends answered ok during A's pull`);
	check('7 import between write and stamp: every row answered ok, and B\'s, is on both', R7A.length > 0 && l7.every(t => hasAll(t, R7A.concat([R7B]))),
		JSON.stringify(l7.map(t => R7A.filter(r => lines(t).indexOf(r) === -1).length + ' missing')));

	// ═══ 8. a log over 512 KB joins ═══
	// Built from six appends of about 100 KB: the door takes one save of at most SAVE_MAX (crystal.js,
	// 512 * 1024 UTF-16 units) and 400 saves a mounting, so a log over 512 KB is only ever grown by appends.
	const BIGS = Array.from({ length: 6 }, (_, k) => Array.from({ length: 1000 }, (_, i) => JSON.stringify({ n: k * 1000 + i, pad: 'x'.repeat(80) })).join('\n') + '\n');
	const sv8 = [];
	for (const part of BIGS) sv8.push(await save(A, X, 'big.txt', part));
	const big0 = await rd(A, X, 'big.txt');
	check('8 setup: a log over 512 KB grown through the door in six appends', sv8.every(Boolean) && (big0 || '').length > 512 * 1024 && lines(big0).length === 6000,
		JSON.stringify([sv8, (big0 || '').length, lines(big0).length]));
	await push(A); await pull(B); await round(A, B);
	const j8 = [await trailHas(A, 'sync log joined'), await trailHas(B, 'sync log joined')];
	const G_A = row('big-a'), G_B = row('big-b');
	check('8 setup: A and B append to it offline', (await save(A, X, 'big.txt', G_A)) && (await B.page.waitForTimeout(60), await save(B, X, 'big.txt', G_B)));
	await push(A); await pull(B); await push(B); await pull(A);
	await round(A, B);
	const g = [await rd(A, X, 'big.txt'), await rd(B, X, 'big.txt')];
	check('8 log over 512 KB joins: both rows on both', g.every(t => hasAll(t, [G_A, G_B])), JSON.stringify(g.map(t => lines(t).length)));
	check('8 log over 512 KB joins: byte-equal, every line kept', g[0] === g[1] && lines(g[0]).length === 6002, JSON.stringify(g.map(t => (t || '').length)));
	const j8b = [await trailHas(A, 'sync log joined'), await trailHas(B, 'sync log joined')];
	// Per device: the trail is a rolling window, so a sum can lose a row that scrolled out on the other.
	check('8 log over 512 KB joins: it merged (a join ran), not a one-sided take', j8b[0] > j8[0] || j8b[1] > j8[1], JSON.stringify([j8, j8b]));

	// ═══ 9. an over-cap local log holds the import ═══
	await round(A, B, C);
	const pre9 = await rd(A, X, 'log.txt');
	const filler = '\n' + Array.from({ length: 17 * 1024 }, (_, i) => 'f' + String(i).padStart(6, '0') + '-'.repeat(1016)).join('\n');
	await wr(A, X, 'log.txt', pre9 + filler);
	await A.page.evaluate((did) => window.__m.touch_diamond(did), X);
	const big9 = await rd(A, X, 'log.txt');
	note('9: A\'s local log.txt is ' + Math.round(big9.length / 1048576) + ' MB');
	const R9B = row('r9-b');
	await B.page.waitForTimeout(60);
	check('9 setup: B appends and pushes', await save(B, X, 'log.txt', R9B));
	await push(B);
	const h0 = await trailHas(A, 'PAGELOG HELD');
	await pull(A);
	const a9 = await rd(A, X, 'log.txt'), bn1 = await banner(A), h1 = await trailHas(A, 'PAGELOG HELD');
	check('9 over-cap log holds the import: A\'s log untouched, B\'s row not in', a9 === big9 && lines(a9).indexOf(R9B) === -1, (a9 || '').length + ' vs ' + big9.length);
	check('9 over-cap log holds the import: the banner names the Diamond', bn1.indexOf('Pagelog') !== -1, JSON.stringify(bn1.slice(0, 120)));
	check('9 over-cap log holds the import: a PAGELOG HELD line in the trail', h1 > h0, h0 + ' -> ' + h1);
	await pull(A);
	const h2 = await trailHas(A, 'PAGELOG HELD');
	check('9 over-cap log holds the import: the next round retries (held again)', h2 > h1 && (await banner(A)).indexOf('Pagelog') !== -1, h1 + ' -> ' + h2);
	await wr(A, X, 'log.txt', pre9);
	await A.page.evaluate((did) => window.__m.touch_diamond(did), X);
	// The shrink is an edit on A, so A's copy is now the fresher: A sends it, B joins B's row into it,
	// and A takes the joined copy back. One round, not one pull.
	await round(A, B);
	const a9b = await rd(A, X, 'log.txt'), bn2 = await banner(A);
	check('9 over-cap log holds the import: on shrink the join goes through within a round and the banner clears',
		lines(a9b).indexOf(R9B) !== -1 && bn2.indexOf('Pagelog') === -1, JSON.stringify([lines(a9b).length, bn2.slice(0, 60)]));
	await round(A, B, C);

	// ═══ 11. mixed versions: O on the r547 www beside A on this one ═══
	if (OLD && !BASE) {
		O = await device('pl-o', PROF('o'), bundle, OLD);
		await pull(O); await push(O); await round(A, O);
		check('11 setup: the old device holds X', !!(await rd(O, X, 'log.txt')));
		await frameOf(O, X);
		// Order 1: the old device's copy is the fresher; the new device joins.
		const M1A = row('mx1-a'), M1O = row('mx1-o');
		check('11 setup: A then O append offline', (await save(A, X, 'log.txt', M1A)) && (await O.page.waitForTimeout(60), await save(O, X, 'log.txt', M1O)));
		await push(A); await pull(O); await push(O); await pull(A);
		const m1a = await rd(A, X, 'log.txt');
		check('11 mixed versions, old copy fresher: no row lost on the new device', hasAll(m1a, [M1A, M1O]));
		await round(A, O);
		const m1o = await rd(O, X, 'log.txt');
		check('11 mixed versions, old copy fresher: the old device takes the joined copy', hasAll(m1o, [M1A, M1O]) && m1o === (await rd(A, X, 'log.txt')));
		// Order 2: the new device's copy is the fresher; the old device replaces and keeps its own as a version.
		const M2O = row('mx2-o'), M2A = row('mx2-a');
		const kO0 = (await kept(O, X)).n;
		check('11 setup: O then A append offline', (await save(O, X, 'log.txt', M2O)) && (await A.page.waitForTimeout(60), await save(A, X, 'log.txt', M2A)));
		await push(O); await pull(A); await push(A); await pull(O);
		const m2a = await rd(A, X, 'log.txt'), kO = await kept(O, X);
		check('11 mixed versions, new copy fresher: no row lost on the new device', hasAll(m2a, [M2A]));
		check('11 mixed versions, new copy fresher: the old device keeps its own row in its kept version',
			kO.n > kO0 && kO.bodies.some(b => b.indexOf('synthetic mx2-o') !== -1), `kept ${kO0} -> ${kO.n}`);
		note(`11: O's live log holds its own row: ${lines(await rd(O, X, 'log.txt')).indexOf(M2O) !== -1}; kept ${kO0} -> ${kO.n}`);
		await round(A, O);
		const m2o = await rd(O, X, 'log.txt');
		check('11 mixed versions, new copy fresher: the devices agree and the new device\'s row is on the old one',
			hasAll(m2o, [M2A]) && m2o === (await rd(A, X, 'log.txt')));
	} else note('11: mixed versions skipped (no --old, or a --base run)');

} catch (e) {
	console.log('VERIFY THREW:', e && (e.stack || e.message || e));
	bad.push('verify threw: ' + (e && e.message));
} finally {
	for (const s of [A, B, C, O]) { try { await s?.close?.(); } catch (e) {} }
	console.log('\n=== SUMMARY ' + ok.length + ' ok, ' + bad.length + ' FAIL ' + (BASE || BREAK ? '(a base or --break run: FAILs are expected)' : '') + ' ===');
	if (bad.length) { bad.forEach((x) => console.log('  FAIL ' + x)); process.exitCode = 1; }
}
