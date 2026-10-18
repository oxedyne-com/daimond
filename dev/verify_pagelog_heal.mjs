// gateway: none
// verify_pagelog_heal.mjs — the one-time page-log heal (PLE), real devices over one shared cloud.
//
// THE LOSS. Before the page-log guard (PLD), a two-sided import replaced a Diamond wholesale, so a row only this
// device had appended went into a "kept before sync" version and out of the live log. r547 devices still do it
// during the mixed-version window. `heal_pagelogs(id)` puts those rows back, only ever adding, from the kept
// versions alone (never a restore the person chose), marked by kept-manifest hash and record digest so it adds
// nothing twice. The app runs it under `holdDiamond` once per Diamond at start-up and after each import, stamps
// the Diamond where rows went back, and leaves the trail counts only: no toast (O3), its one trace in History
// is the Restore version the heal writes.
//
// Devices A and B run this www, O the r547 one until it is upgraded in place (the same profile reopened on this
// www). The rows are synthetic, never the owner's bytes. Arms: 1 owner shape, 2 mixed-version window,
// 3 arriving below the mark, 4 late registration, 5 version gone.
//
//   eval "$(bash dev/world.sh 107 --up)"
//   node dev/verify_pagelog_heal.mjs --old <r547 www>                    # the gate
//   node dev/verify_pagelog_heal.mjs --old <r547 www> --base <plguard www>  # the RED run (no heal wiring)
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
const OLD  = arg('--old', '');		// the r547 www: device O before its upgrade
const BASE = arg('--base', '');		// a www for every new-version device (the RED run)
if (!OLD) { console.error('--old <r547 www> is required: the loss is made by an r547 device'); process.exit(2); }
if (BROWSER !== 'chromium') { console.error('Chromium only: a Diamond needs OPFS, and an old www rides page.route.'); process.exit(2); }
for (const d of [OLD, BASE]) {
	if (d && !fs.existsSync(path.join(d, 'pkg', 'oxedyne_daimond_bg.wasm'))) { console.error(`no www with a wasm at ${d}`); process.exit(2); }
}
if (!BASE) {
	const src = fs.readFileSync(path.join(WWW, 'js', 'daimond.js'), 'utf8');
	for (const want of ['await healLogsHeld(app, r.id);', 'return healPageLogsAll()', "trail('sync log healed'"]) {
		if (!src.includes(want)) { console.error(`seam missing in js/daimond.js: ${want}`); process.exit(2); }
	}
}
const HEAL_NOTE = 'rows an earlier sync dropped, put back';
// A synthetic row of the one known real candidate's shape: 132 ASCII bytes, no CR (as the engine's own arm).
const SYNTH = '{"id":"zq0synthrow1","at":"2026-01-02T08:30:00+08:00","day":"2026-01-02","src":"scale","f":{"food":"rye","qty":3},"w":1767313800000}';
if (SYNTH.length !== 132 || /[^\x20-\x7e]/.test(SYNTH)) { console.error('SYNTH is not the candidate shape'); process.exit(2); }

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
const row = (tag) => JSON.stringify({ t: '2026-10-10T08:14:00', what: 'synthetic heal ' + tag });

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

// The mounted page of Diamond `id`: several Diamonds hold the page here, and a save goes through whichever is
// mounted, so the Diamond is selected first and the frame that mounts after the selection is the one used.
const OPEN_KEY = 'daimond-open-diamond';
const capp = async (f) => { try { return await f.evaluate(() => !!(window.__capp && window.__capp.save)); } catch (e) { return false; } };
const blobs = (s) => s.page.frames().filter(fr => fr.url().indexOf('blob:') === 0);
async function frameOf(s, id, tries = 32) {
	const openNow = () => s.page.evaluate((k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }, OPEN_KEY);
	if ((await openNow()) === id) {
		for (const f of blobs(s)) if (await capp(f)) return f;
	}
	const before = new Set(blobs(s));
	for (let i = 0; i < tries; i++) {
		if (i % 10 === 0) {
			try {
				await s.page.evaluate(() => DaimondPanels.show('ai'));
				await s.page.click(`.diamond-box[data-id="${id}"]`, { force: true, timeout: 3000 });
			} catch (e) {}
		}
		if ((await openNow()) === id) {
			for (const f of blobs(s)) if ((i > 20 || !before.has(f)) && await capp(f)) return f;	// late: it was mounted already
		}
		await s.page.waitForTimeout(250);
	}
	throw new Error(s.name + ': the crystal frame of ' + id.slice(0, 8) + ' is not mounted');
}
const save = async (s, id, rel, text) => {
	const f = await frameOf(s, id);
	const r = await f.evaluate((a) => window.__capp.save(a.rel, a.text, 'append'), { rel, text });
	return !!(r && r.ok);
};

async function rewire(s) {
	await s.page.evaluate(async () => {
		window.DaimondGateway.state = function () { return { authed: true, credits: 0, pro: false }; };
		window.DaimondGateway.gwFetch = async function (p, opts) {
			const r = await window.__cloudCall(String(p), (opts && opts.method) || 'GET', String((opts && opts.body) || ''));
			return { status: r.status, json: async () => r.json };
		};
		window.__m = await import('/pkg/oxedyne_daimond.js');
		window.__free = new window.__m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	});
}
// Toasts, watched from the first script of every load.
const TOASTS = () => {
	window.__toasts = [];
	new MutationObserver((ms) => ms.forEach(m => m.addedNodes.forEach(n => {
		if (n && n.classList && n.classList.contains('daimond-toast')) window.__toasts.push(n.textContent);
	}))).observe(document.documentElement, { childList: true, subtree: true });
};
const toasts = (s) => s.page.evaluate(() => (window.__toasts || []).slice());
const SAYS_HEAL = /log|row|heal|put back|dropped/i;

async function device(name, profile, bundle, www) {
	const s = await open({ name, profile, signIn: false, connect: false, defaults: false,
		route: www ? routeFrom(www) : null, serviceWorkers: www ? 'block' : 'allow' });
	await ready(s);
	if (bundle) {
		await s.page.evaluate((b) => window.DaimondIdentity.importBundle(b), bundle);
		await s.page.reload({ waitUntil: 'domcontentloaded' });
		await ready(s);
	}
	await signInAs(s, 'plheal'); await ready(s);
	await clearDiamonds(s); await ready(s);
	await wireCloud(s, name);
	return s;
}
// The same profile opened again, store and identity as they were: the upgrade, or a plain start-up.
async function reopen(name, profile, www) {
	const s = await open({ name, profile, signIn: false, connect: false, defaults: false,
		route: www ? routeFrom(www) : null, serviceWorkers: www ? 'block' : 'allow' });
	await s.page.addInitScript(TOASTS);
	await ready(s);
	await signInAs(s, 'plheal'); await ready(s);
	await wireCloud(s, name);
	return s;
}
async function restart(s) {
	await s.page.reload({ waitUntil: 'domcontentloaded' });
	await ready(s);
	await signInAs(s, 'plheal'); await ready(s);
	await rewire(s);
}
const PROF = (k) => {
	const d = scratch('pw', 'plheal-' + k + '-' + BROWSER + (BASE ? '-base' : ''));
	fs.rmSync(d, { recursive: true, force: true });
	return d;
};
// A row's arrival, waited for: a start-up heal runs behind the rail.
async function waitRow(s, id, rel, r, ms = 9000) {
	const t0 = Date.now();
	for (;;) {
		if (lines(await rd(s, id, rel)).indexOf(r) !== -1) return true;
		if (Date.now() - t0 > ms) return false;
		await s.page.waitForTimeout(300);
	}
}
const healVersions = (s, id) => s.page.evaluate(async (a) => {
	try { return JSON.parse(await window.__free.versions_list(a.id)).filter(v => v && v.note === a.n).length; }
	catch (e) { return -1; }
}, { id, n: HEAL_NOTE });
const keptNums = (s, id) => s.page.evaluate(async (did) => {
	try {
		return JSON.parse(await window.__free.versions_list(did)).filter(v => /kept before sync/i.test((v && v.note) || ''))
			.map(v => +(v.version ?? v.v ?? v.n ?? -1));
	} catch (e) { return []; }
}, id);
const markText = (s, id) => rd(s, id, 'versions/heal/pagelogs');
const healTrail = (s, id) => s.page.evaluate((did) => {
	let rows = [];
	try { rows = (window.DaimondTrail && DaimondTrail.rows && DaimondTrail.rows()) || []; } catch (e) {}
	return rows.map(r => JSON.stringify(r)).filter(t => t.indexOf('sync log healed') !== -1 && t.indexOf(did) !== -1);
}, id);
// A Diamond with the logging page, made on `s`; with `seed` rows appended through the page's door.
async function makeDiamond(s, name, seeds) {
	const id = await s.page.evaluate(async (a) => {
		const id = await window.__free.create_diamond(a.name);
		await window.__free.run_tool('file_write', JSON.stringify({ path: 'diamonds/' + id + '/crystal.json', content: JSON.stringify({ title: a.name, summary: 'a page that logs' }) }));
		await window.__free.run_tool('file_write', JSON.stringify({ path: 'diamonds/' + id + '/crystal.html', content: a.pg }));
		try { await DaimondCore.loadDiamonds(); } catch (e) {}
		return id;
	}, { name, pg: PAGE });
	for (const [rel, r] of seeds) {
		if (!(await save(s, id, rel, r))) throw new Error(s.name + ': the seed row of ' + name + ' did not save');
	}
	return id;
}
// An edit on `s` that touches no log, so its copy is the fresher without a row of its own.
const editNote = (s, id, t) => s.page.evaluate(async (a) => {
	await window.__free.run_tool('file_write', JSON.stringify({ path: 'diamonds/' + a.id + '/notes.md', content: a.t }));
	await window.__m.touch_diamond(a.id);
}, { id, t });

let A = null, B = null, O = null;
try {
	console.log(`\n— page-log heal${BASE ? '  [BASE ' + BASE + ']' : ''} —`);
	const profO = PROF('o');
	A = await device('ph-a', PROF('a'), null, BASE);
	const bundle = await A.page.evaluate(() => window.DaimondIdentity.exportBundle());
	B = await device('ph-b', PROF('b'), bundle, BASE);
	O = await device('ph-o', profO, bundle, OLD);

	// ── The Diamonds. Y, W and V are made on A, so their logs are recorded and the record travels; Z on O
	// (r547 records nothing), so its log is not recorded anywhere until a page on this www appends to it. ──
	const SEED = row('seed');
	const Y = await makeDiamond(A, 'Heal Y', [['log/diet.jsonl', SEED]]);
	const W = await makeDiamond(A, 'Heal W', [['log.txt', SEED]]);
	const V = await makeDiamond(A, 'Heal V', [['small.txt', SEED], ['big.txt', SEED]]);
	const Z = await makeDiamond(O, 'Heal Z', [['log.txt', SEED]]);
	note(`Y ${Y.slice(-8)} W ${W.slice(-8)} V ${V.slice(-8)} Z ${Z.slice(-8)}`);
	await push(A); await round(O, A, B); await round(A, B, O);
	const held = [];
	for (const d of [A, B, O]) for (const [id, rel] of [[Y, 'log/diet.jsonl'], [W, 'log.txt'], [V, 'small.txt'], [Z, 'log.txt']]) {
		held.push(lines(await rd(d, id, rel)).indexOf(SEED) !== -1);
	}
	check('setup: A, B and O hold Y, W, V and Z with the seed row', held.every(Boolean), JSON.stringify(held.map(Number)));
	const recZ = await rd(A, Z, '.daimond/pagelogs');
	check('setup: Z\'s log is recorded nowhere (made on r547)', !recZ || lines(recZ).indexOf('log.txt') === -1, JSON.stringify(recZ));
	for (const id of [Y, W, V, Z]) await frameOf(O, id);

	// ═══ The r547 loss on O, for arms 1, 4 and 5: O appends offline, A's later edit is the fresher, and O's
	// two-sided import replaces O's copy, keeping it before sync. ═══
	const L4 = row('late-o'), S5 = row('gone-small'), G5 = row('gone-big');
	check('loss setup: O appends to Y, Z and V offline',
		(await save(O, Y, 'log/diet.jsonl', SYNTH)) && (await save(O, Z, 'log.txt', L4))
		&& (await save(O, V, 'small.txt', S5)) && (await save(O, V, 'big.txt', G5)));
	await O.page.waitForTimeout(80);
	for (const id of [Y, Z, V]) await editNote(A, id, 'later on A ' + id);
	await push(A); await pull(O);
	note('loss: stamps A/O ' + JSON.stringify([await stamp(A, Y), await stamp(O, Y)]) + ', kept on O ' + (await kept(O, Y)).n);
	const lost = [
		lines(await rd(O, Y, 'log/diet.jsonl')).indexOf(SYNTH) === -1,
		lines(await rd(O, Z, 'log.txt')).indexOf(L4) === -1,
		lines(await rd(O, V, 'small.txt')).indexOf(S5) === -1,
	];
	const kY = await kept(O, Y);
	check('loss setup: O\'s rows are out of its live logs (the r547 replace)', lost.every(Boolean), JSON.stringify(lost.map(Number)));
	check('loss setup: O holds the candidate row only in a kept version', kY.bodies.some(b => lines(b).indexOf(SYNTH) !== -1), 'kept ' + kY.n);
	// Arm 5: the kept copy of big.txt is pruned from the store, so the heal cannot read it.
	const pruned = await O.page.evaluate(async (did) => {
		const vs = JSON.parse(await window.__free.versions_list(did)).filter(v => /kept before sync/i.test((v && v.note) || ''));
		const out = [];
		for (const v of vs) for (const e of ((v && v.files) || [])) {
			if (!e || !/big\.txt$/.test(String(e.path || '')) || !e.hash) continue;
			const p = window.__free.versions_body_path(did, e.hash);
			let how = 'deleted';
			try { await window.__free.run_tool('file_delete', JSON.stringify({ path: p })); } catch (x) { how = 'refused'; }
			try { if (await window.__m.store_read(p)) { await window.__m.store_write(p, 'pruned\n'); how = 'overwritten'; } } catch (x) { /* gone */ }
			out.push(how);
		}
		return out;
	}, V);
	check('5 setup: the kept copy of V\'s big.txt is no longer held', pruned.length > 0, JSON.stringify(pruned));
	await round(A, B, O);

	// ═══ 2. mixed-version window: the r547 device drops a row, then its fresher copy reaches A one-sided,
	// its kept version with it. A heals from that version at the import. ═══
	await A.page.evaluate(TOASTS);
	const O2 = row('mix-o1'), A2 = row('mix-a1'), O2b = row('mix-o2');
	check('2 setup: O then A append to W offline', (await save(O, W, 'log.txt', O2)) && (await A.page.waitForTimeout(80), await save(A, W, 'log.txt', A2)));
	await push(A); await pull(O);
	check('2 setup: O\'s row is out of its live log, kept before sync', lines(await rd(O, W, 'log.txt')).indexOf(O2) === -1
		&& (await kept(O, W)).bodies.some(b => lines(b).indexOf(O2) !== -1));
	check('2 setup: O appends again, its copy now the fresher', await save(O, W, 'log.txt', O2b));
	await O.page.waitForTimeout(200);
	await push(O); await pull(A);
	note('2: the cloud\'s copy from ' + (cloud.mailbox && cloud.mailbox.device) + ', A holds o2: ' + (lines(await rd(A, W, 'log.txt')).indexOf(O2b) !== -1));
	const w2 = await rd(A, W, 'log.txt');
	check('2 mixed-version window: A puts back the row the r547 device dropped', hasAll(w2, [SEED, A2, O2, O2b]), JSON.stringify(lines(w2).map(l => l.slice(-14))));
	check('2 mixed-version window: one History row on A, counts only in the trail',
		(await healVersions(A, W)) === 1 && (await healTrail(A, W)).length === 1, (await healTrail(A, W)).join(' | ').slice(0, 160));
	await round(A, O);
	const w2o = await rd(O, W, 'log.txt');
	check('2 mixed-version window: the healed copy travels, and the old device takes it whole', hasAll(w2o, [O2]) && w2o === (await rd(A, W, 'log.txt')));
	await round(A, B, O);

	// ═══ 3. arriving below the mark: O's kept version is minted first, at O's number; A then climbs (saves of
	// its own), joins a kept version of its own above that number in a two-sided import with B, and marks it.
	// Only then does O's kept version reach A, with a second O kept. A mark by number would pass it over;
	// the mark is by hash, so it is read. ═══
	const O3 = row('below-o1'), A3 = row('below-a1'), O4 = row('below-o2'), A4 = row('below-a2'), B4 = row('below-b2'), O5 = row('below-o3');
	check('3 setup: O then A append to W offline', (await save(O, W, 'log.txt', O3)) && (await A.page.waitForTimeout(80), await save(A, W, 'log.txt', A3)));
	await push(A); await pull(O); await pull(B);
	check('3 setup: O\'s row is out of its live log, kept before sync', lines(await rd(O, W, 'log.txt')).indexOf(O3) === -1
		&& (await kept(O, W)).bodies.some(b => lines(b).indexOf(O3) !== -1));
	const climbed = await A.page.evaluate(async (did) => {
		let n = 0;
		for (let i = 0; i < 6; i++) {
			await window.__free.run_tool('file_write', JSON.stringify({ path: 'diamonds/' + did + '/notes.md', content: 'A climbs ' + i }));
			const r = JSON.parse(await window.__free.versions_save_user(did, 'a save of A\'s own ' + i));
			if (r && r.version) n++;
		}
		return n;
	}, W);
	check('3 setup: A then B append to W offline', (await save(A, W, 'log.txt', A4)) && (await B.page.waitForTimeout(80), await save(B, W, 'log.txt', B4)));
	await push(B); await pull(A); await push(A);
	const m3 = await markText(A, W);
	const nA = Math.max(-1, ...(await keptNums(A, W)));
	check('3 setup: A holds a heal mark naming its own kept versions', /^record /.test(m3 || '') && lines(m3).filter(l => /^kept /.test(l)).length >= 2,
		`climbed ${climbed}, highest kept ${nA}, mark ${JSON.stringify(lines(m3).map(l => l.slice(0, 12)))}`);
	// O moved, and takes A's joined copy two-sidedly: a second O kept, then O's copy is the fresher.
	check('3 setup: O appends to W offline', await save(O, W, 'log.txt', O4));
	await pull(O);
	check('3 setup: O appends again, its copy now the fresher', await save(O, W, 'log.txt', O5));
	await O.page.waitForTimeout(200);
	await push(O); await pull(A);
	const nums = await A.page.evaluate(async (did) => {
		const vs = JSON.parse(await window.__free.versions_list(did)).filter(v => /kept before sync/i.test((v && v.note) || ''));
		const o = [];
		for (const v of vs) for (const e of ((v && v.files) || [])) {
			if (!e || !/log\.txt$/.test(String(e.path || '')) || !e.hash) continue;
			let t = '';
			try { t = String(await window.__free.versions_body(did, e.hash)); } catch (x) {}
			if (t.indexOf('below-o1') !== -1) o.push(+(v.version ?? v.v ?? v.n ?? -1));
		}
		return o;
	}, W);
	const w3 = await rd(A, W, 'log.txt');
	check('3 arriving below the mark: O\'s first kept version reaches A numbered below A\'s marked one',
		nums.length > 0 && Math.min(...nums) < nA, `O's at ${JSON.stringify(nums)}, A marked up to ${nA}`);
	check('3 arriving below the mark: A puts back the rows only O\'s kept versions hold', hasAll(w3, [O3, O4, O5, A4, B4]), JSON.stringify(lines(w3).map(l => l.slice(-12))));
	const w3s = lines(w3);
	check('3 arriving below the mark: nothing put back twice', w3s.length === new Set(w3s).size, w3s.length + ' rows');
	const t2 = (await toasts(A)).filter(t => SAYS_HEAL.test(t));
	check('2, 3 the import-time heal is silent: no toast', t2.length === 0, JSON.stringify(t2));
	await round(A, B, O);

	// ═══ The upgrade: O's own profile, opened again on this www. Its start-up heal runs once per Diamond. ═══
	await O.close(); O = null;
	O = await reopen('ph-o', profO, BASE);
	// 1. owner shape: the record is here (it came with A's copy), so the start-up heal puts the row back.
	const y1 = await waitRow(O, Y, 'log/diet.jsonl', SYNTH);
	const yl = lines(await rd(O, Y, 'log/diet.jsonl'));
	check('1 owner shape: the start-up heal puts back the 132-byte row, exactly once', y1 && yl.filter(l => l === SYNTH).length === 1, yl.length + ' rows');
	check('1 owner shape: one History row ("' + HEAL_NOTE + '"), counts only in the trail',
		(await healVersions(O, Y)) === 1 && (await healTrail(O, Y)).some(t => /files 1 rows \+1/.test(t) && t.indexOf('zq0synthrow1') === -1),
		(await healTrail(O, Y)).join(' | ').slice(0, 160));
	// 5. version gone: small.txt's row is put back, big.txt's copy is reported gone, and nothing fails.
	const v5 = await waitRow(O, V, 'small.txt', S5);
	check('5 version gone: the readable kept copy is still put back', v5);
	check('5 version gone: the pruned copy is counted gone, its row not invented', lines(await rd(O, V, 'big.txt')).indexOf(G5) === -1
		&& (await healTrail(O, V)).some(t => / gone 1/.test(t)), (await healTrail(O, V)).join(' | ').slice(0, 160));
	// 4. late registration, first half: Z's log is not recorded, so nothing is a log yet and nothing is put back.
	check('4 late registration: before the log is recorded, the heal leaves it alone', lines(await rd(O, Z, 'log.txt')).indexOf(L4) === -1);
	const L4b = row('late-o2');
	check('4 setup: the page on this www appends to Z, recording its log', await save(O, Z, 'log.txt', L4b));
	const recZ2 = await rd(O, Z, '.daimond/pagelogs');
	note('4: Z record after the append: ' + JSON.stringify(recZ2));
	// The second start-up: Z rescans every kept version against the new record; Y and V add nothing.
	const yN = yl.length, hY = await healVersions(O, Y), hV = await healVersions(O, V);
	await restart(O);
	const z4 = await waitRow(O, Z, 'log.txt', L4);
	check('4 late registration: once recorded, the next start-up puts the row back', z4 && hasAll(await rd(O, Z, 'log.txt'), [SEED, L4, L4b]));
	await O.page.waitForTimeout(1500);
	check('1 owner shape: a second start-up writes nothing', lines(await rd(O, Y, 'log/diet.jsonl')).length === yN
		&& (await healVersions(O, Y)) === hY && (await healVersions(O, V)) === hV, `rows ${yN}, heal versions Y ${hY} V ${hV}`);
	const t1 = (await toasts(O)).filter(t => SAYS_HEAL.test(t));
	check('1, 4, 5 the start-up heal is silent: no toast', t1.length === 0, JSON.stringify(t1));
	// The healed copies travel: A takes them one-sided.
	await round(O, A);
	check('1 owner shape: the healed row reaches the other device', lines(await rd(A, Y, 'log/diet.jsonl')).indexOf(SYNTH) !== -1);
	check('4 late registration: the healed row reaches the other device', lines(await rd(A, Z, 'log.txt')).indexOf(L4) !== -1);
} catch (e) {
	console.log('VERIFY THREW:', e && (e.stack || e.message || e));
	bad.push('verify threw: ' + (e && e.message));
} finally {
	for (const s of [A, B, O]) { try { await s?.close?.(); } catch (e) {} }
	console.log('\n=== SUMMARY ' + ok.length + ' ok, ' + bad.length + ' FAIL ' + (BASE ? '(a --base run: FAILs are expected)' : '') + ' ===');
	if (bad.length) { bad.forEach((x) => console.log('  FAIL ' + x)); process.exitCode = 1; }
}
