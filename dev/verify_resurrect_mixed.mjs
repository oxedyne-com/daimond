// gateway: live
// verify_resurrect_mixed.mjs -- the deleted-file-comes-back law (fix/sync-resurrect) on a fleet
// that runs two builds at once, and back again.
//
// ONE ACCOUNT, ONE GATEWAY, TWO BUILDS. A device is `f4` (this tree, whose `www/js` carries the
// law: `at` and `vs` on a deletion record, `daimond-file-agreed-at`) or `live` (`<liveTree>`, the
// release the law is to land on). Each build is served by its own `dev/serve.mjs` on its own origin,
// both proxying `/api` to the one gateway this script starts. A device is a persistent Chromium
// profile, so its storage survives a stop, and a rollback is the same origin served from the other
// tree.
//
// The shape every case takes: an editor writes T0 and every device agrees it; the STALE holder goes
// offline; the deleter writes T1 (landed), then deletes (landed); the holder returns. Without the
// law that holder's older agreed copy reads as a write made since and comes back. Cases:
//
//   base  live deleter, live stale holder: the fault as it stands today. Every other case is
//         read against it, and none may be worse.
//   ff    f4 deleter, f4 stale holder: the law's own case, which must not resurrect.
//   a     f4 deletes a file a live device edited earlier (nobody stale): no resurrect on either.
//   a2    f4 deletes, the live holder is stale: no worse than base.
//   b     live deletes, the f4 holder is stale: no worse than base.
//   b2    live deletes, the f4 holder agreed the very bytes: deleted, by the bytes rule.
//   c     f4 deletes, a live device relays (its push carries the record without `at`), the f4 holder
//         is stale: the record's tie-break, and whether the stripped form brings the file back.
//   c2    the same with an f4 relay: the law holds through an f4 relay.
//   d     rollback: f4 devices run `ff`, then every device is served the live build; no resurrect,
//         no lost file, the stored `at`/`vs`/`daimond-file-agreed-at` harmless.
//   d2    rollback before the stale holder returns: the holder is live when it pulls.
//
// Usage (from the f4 tree; the live tree needs www/pkg and nothing else of its own):
//   node dev/verify_resurrect_mixed.mjs <case|all> <liveTree> [--worlds 92,94] [--gw <binary>]
// Ports: the f4 app on 8777+W1, the live app on 8777+W2, the gateway on 9700+W1. Headless.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const F4T = process.cwd();
const [, , WHICH = 'all', LIVET] = process.argv;
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
if (!LIVET || !fs.existsSync(path.join(LIVET, 'www/js/cloud.js'))) {
	console.log('usage: node dev/verify_resurrect_mixed.mjs <case|all> <liveTree> [--worlds 92,94] [--gw <binary>]');
	process.exit(2);
}
const [W1, W2] = arg('--worlds', '92,94').split(',').map(Number);
const GW_BIN = arg('--gw', path.join(os.homedir(), '.cache/daimond/claude-rc-1/gwcand-67b156c5/daimond_gateway'));
const PORT = { f4: 8777 + W1, live: 8777 + W2 }, GW_PORT = 9700 + W1;
const TREE = { f4: F4T, live: path.resolve(LIVET) };
const ROOT = path.join(os.homedir(), '.cache/daimond/claude-rc-5/f4b/mix' + W1);

const H = await import(pathToFileURL(path.join(F4T, 'dev/harness.mjs')).href);
const { cleanDisplayEnv } = await import(pathToFileURL(path.join(F4T, 'dev/display.mjs')).href);
const { makePagePro } = await import(pathToFileURL(path.join(F4T, 'dev/pro.mjs')).href);
const { chromium } = await import('./pw.mjs');
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
	if (ok) pass++; else fail++;
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' -- ' + detail : ''));
};
const note = (s) => console.log('  note ' + s);

// ── The world: one gateway, two app servers ─────────────────────────────
const KIDS = new Set();
function child(cmd, args, opts, label) {
	const out = fs.openSync(path.join(ROOT, label + '.out'), 'a');
	const c = spawn(cmd, args, Object.assign({ stdio: ['ignore', out, out] }, opts));
	KIDS.add(c); c.on('exit', () => KIDS.delete(c));
	return c;
}
const killAll = () => { for (const c of KIDS) { try { c.kill('SIGTERM'); } catch (e) { /* gone */ } } };
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(130); });
const listening = (port) => new Promise((res) => {
	const s = net.connect(port, '127.0.0.1');
	s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false));
});
async function waitPort(port, up = true, ms = 30000) {
	for (const t0 = Date.now(); Date.now() - t0 < ms; ) { if ((await listening(port)) === up) return true; await sleep(200); }
	return false;
}
const serve = (kind, port) => child('node', ['dev/serve.mjs'], { cwd: TREE[kind],
	env: Object.assign({}, process.env, { DAIMOND_PORT: String(port), DAIMOND_GW_PORT: String(GW_PORT) }) }, 'serve-' + kind + '-' + port + '-' + Date.now().toString(36).slice(-3));
const SERVERS = {};		// port -> { kind, proc }
async function startServer(kind, port) {
	SERVERS[port] = { kind, proc: serve(kind, port) };
	if (!(await waitPort(port))) throw new Error('the ' + kind + ' app server did not come up on ' + port);
}
async function stopServer(port) {
	const s = SERVERS[port]; if (!s) return;
	try { s.proc.kill('SIGTERM'); } catch (e) { /* gone */ }
	await waitPort(port, false);
}
async function startWorld() {
	for (const p of [PORT.f4, PORT.live, GW_PORT]) if (await listening(p)) throw new Error('port ' + p + ' is already answering: another run holds this world');
	fs.rmSync(ROOT, { recursive: true, force: true });
	const cwd = path.join(ROOT, 'gwcwd');
	fs.mkdirSync(cwd, { recursive: true });
	execFileSync('bash', ['dev/devgw.sh'], { cwd: F4T, env: Object.assign({}, process.env, { DAIMOND_GW_PORT: String(GW_PORT) }) });
	fs.copyFileSync(path.join(F4T, 'dev/devgw/app.jdat'), path.join(cwd, 'app.jdat'));
	fs.symlinkSync(fs.realpathSync(path.join(F4T, 'gateway/keys')), path.join(cwd, 'keys'));
	child(GW_BIN, [], { cwd, env: Object.assign({}, process.env, { APP_MODE: 'sandbox' }) }, 'gateway');
	await startServer('f4', PORT.f4);
	await startServer('live', PORT.live);
	let up = false;
	for (let i = 0; i < 60 && !up; i++) {
		try { up = (await fetch(`http://127.0.0.1:${GW_PORT}/api/health`)).ok; } catch (e) { /* not yet */ }
		if (!up) await sleep(500);
	}
	if (!up) throw new Error('the gateway did not come up on ' + GW_PORT);
	// Each origin must serve its own tree's code, byte for byte.
	for (const k of ['f4', 'live']) for (const f of ['sync.js', 'daimond.js', 'cloud.js']) {
		const web = Buffer.from(await (await fetch(`http://127.0.0.1:${PORT[k]}/js/${f}`, { cache: 'no-store' })).arrayBuffer());
		const loc = fs.readFileSync(path.join(TREE[k], 'www/js', f));
		check('the ' + k + ' origin serves its tree\'s js/' + f, crypto.createHash('sha256').update(web).digest('hex') === crypto.createHash('sha256').update(loc).digest('hex'));
	}
}

// ── Devices ──────────────────────────────────────────────────────────────
const E = (d, fn, a) => d.page.evaluate(fn, a);
async function launch(d) {
	const env = cleanDisplayEnv(process.env); delete env.DISPLAY;
	fs.mkdirSync(d.profile, { recursive: true });
	d.ctx = await chromium.launchPersistentContext(d.profile, {
		executablePath: H.CHROME, headless: false, env, viewport: { width: 1200, height: 800 },
		args: ['--no-sandbox', '--headless=new'],
	});
	await d.ctx.addInitScript(() => {
		try { localStorage.setItem('daimond-policy', JSON.stringify({ v: 1, expire: 3650, retain: 30, high: 30 })); } catch (e) { /* private */ }
	});
	d.page = d.ctx.pages()[0] || await d.ctx.newPage();
	d.errs = [];
	d.page.on('pageerror', (e) => d.errs.push('pageerror: ' + e.message));
	d.page.on('console', (m) => { if (m.type() === 'error') d.errs.push(m.text().slice(0, 200)); });
	d.page.on('dialog', (dl) => dl.dismiss().catch(() => {}));
	d.page.setDefaultTimeout(30000); d.page.setDefaultNavigationTimeout(90000);
	d.s = { page: d.page, errs: d.errs, logs: [], net: [], name: d.acct };
	await d.page.goto(d.origin, { waitUntil: 'domcontentloaded' });
}
const ready = (d, ms = 90000) => d.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondCore
	&& window.DaimondGateway && DaimondGateway.state().authed), null, { timeout: ms }).then(() => true).catch(() => false);
const codeIs = (d) => E(d, () => (window.DaimondCloud && typeof DaimondCloud.deadCovers === 'function') ? 'f4' : 'live').catch(() => '?');
async function addDevice(acct, name, kind, first, port) {
	const d = { name, kind, acct, origin: 'http://localhost:' + (port || PORT[kind]), profile: path.join(ROOT, 'pw-' + acct + '-' + name), online: true };
	await launch(d);
	if (first) {
		check(name + ' (' + kind + ') signed in', (await H.signInAs(d.s, acct), await ready(d)));
		const pro = await makePagePro(d.page, path.join(F4T, 'gateway'), `http://127.0.0.1:${GW_PORT}`);
		check(name + ' holds Pro', pro.pro === true, JSON.stringify(pro));
	} else {
		await d.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 120000 }).catch(() => {});
		const code = await E(first_of(d), () => DaimondPairing.create());
		const red = await E(d, (c) => DaimondPairing.redeem(c).then(() => 'ok', (e) => 'err: ' + e.message), code && code.code);
		check(name + ' (' + kind + ') paired', red === 'ok', red);
		await d.page.reload({ waitUntil: 'domcontentloaded' });
		await H.signInAs(d.s, acct);
		check(name + ' reached the gateway', await ready(d));
	}
	check(name + ' runs the ' + kind + ' build', (await codeIs(d)) === kind, await codeIs(d));
	return d;
}
let FIRST = null;
const first_of = () => FIRST;

// ── The account's head and the sync rounds ───────────────────────────────
async function head(d, wantParcel) {
	const ck = (await d.ctx.cookies()).find((c) => c.name === 'daimond_gw_sess');
	const r = await fetch(d.origin + '/api/sync', { headers: { cookie: 'daimond_gw_sess=' + (ck ? ck.value : ''), 'x-daimond-api': '2' } });
	const j = await r.json();
	if (!wantParcel || !j || !j.present) return { version: j ? j.version : -1 };
	const parcel = await E(d, async (b64) => {
		let sealed = b64;
		try {
			const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
			if (bytes.length >= 8 && bytes[0] === 68 && bytes[1] === 82 && bytes[2] === 75 && bytes[3] === 49) {
				const len = ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0;
				let s = ''; const rest = bytes.slice(8 + len);
				for (let i = 0; i < rest.length; i += 0x8000) s += String.fromCharCode.apply(null, rest.subarray(i, i + 0x8000));
				sealed = btoa(s);
			}
		} catch (e) { /* not an envelope */ }
		return JSON.parse(await DaimondIdentity.unwrap(sealed));
	}, j.blob);
	return { version: j.version, parcel };
}
async function comeBack(d) {
	await E(d, async () => {
		const set = (v) => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
		set('hidden'); document.dispatchEvent(new Event('visibilitychange'));
		await new Promise((r) => setTimeout(r, 200));
		set('visible'); document.dispatchEvent(new Event('visibilitychange'));
		window.dispatchEvent(new Event('focus'));
		try { DaimondSync.nudge(); } catch (e) { /* not up */ }
	}).catch(() => {});
}
async function setOnline(d, on) {
	await d.ctx.setOffline(!on);
	d.online = on;
	if (on) await comeBack(d);
}
/// Rounds until every online device holds the account's head and rests, twice running.
async function settle(devs, tag, ms = 90000) {
	const t0 = Date.now(); let ok2 = 0, ver = -1, last = 0;
	while (Date.now() - t0 < ms) {
		const live = devs.filter((d) => d.online);
		// A nudge starts a round, so one per ten seconds: a nudge per poll would never let a device rest.
		if (Date.now() - last > 10000) {
			last = Date.now();
			for (const d of live) await E(d, () => { try { DaimondSync.nudge(); } catch (e) { /* not up */ } }).catch(() => {});
		}
		await sleep(1500);
		const gw = await head(live[0]);
		let all = true;
		for (const d of live) {
			const f = await E(d, () => ({ v: DaimondSync.version(), q: DaimondSync.state().quiet, st: DaimondSync.state().stalled })).catch(() => null);
			if (!f || f.v !== gw.version || !f.q || f.st) all = false;
		}
		ver = gw.version;
		ok2 = all ? ok2 + 1 : 0;
		if (ok2 >= 2) return ver;
	}
	note('settle (' + tag + ') did not rest in ' + ms + ' ms at version ' + ver);
	return ver;
}

// ── Files ────────────────────────────────────────────────────────────────
const tool = (d, name, args) => E(d, async ({ name, args }) => {
	const r = await DaimondCore.toolsApp().run_tool_outcome(name, JSON.stringify(args));
	if (r && r.outcome === 'done') { try { DaimondSync.nudge(); } catch (e) { /* not up */ } }
	return r ? r.outcome + (r.outcome === 'done' ? '' : ' ' + String(r.text || '').slice(0, 160)) : 'none';
}, { name, args });
const wr = (d, p, content) => tool(d, 'file_write', { path: p, content });
const rm = (d, p) => tool(d, 'file_delete', { path: p });
const rd = (d, p) => E(d, async (p) => { try { return String(await DaimondCore.readFile(p)); } catch (e) { return null; } }, p);
const rec = (d, p) => E(d, (p) => { try { return DaimondCloud.recordOf(p); } catch (e) { return 'err ' + e.message; } }, p);
const agreedAt = (d) => E(d, () => { try { return localStorage.getItem('daimond-file-agreed-at') ? 'present' : 'absent'; } catch (e) { return '?'; } });
const T = (p, n) => `# ${p}\n\nversion ${n}\n`;
const short = (s) => s === null ? 'ABSENT' : /version (\d)/.test(s) ? 'T' + RegExp.$1 : JSON.stringify(s.slice(0, 20));
const post = async (devs, p) => {
	const out = {};
	for (const d of devs) out[d.name + ':' + d.kind] = short(await rd(d, p));
	return out;
};

// ── A case ───────────────────────────────────────────────────────────────
let N = 0;
/// X deletes, H holds a copy, R (optional) relays. `stale`: H is offline from T0 to the end.
async function scenario(id, { x, h, r, editor = 'X', stale = true, rollback = '' }) {
	console.log('\n== case ' + id + ': deleter ' + x + ', holder ' + h + (r ? ', relay ' + r : '') + (stale ? ' (stale)' : ' (current)')
		+ (editor === 'H' ? ', the holder edits' : '') + (rollback ? ', rollback ' + rollback : ''));
	const acct = 'mix-' + id + '-' + (++N) + '-' + Date.now().toString(36).slice(-4);
	const p = 'mix/' + id + '.md', keep = 'mix/keep-' + id + '.md';
	const devs = [];
	const X = await addDevice(acct, 'X', x, true); devs.push(X); FIRST = X;
	const Hd = await addDevice(acct, 'H', h); devs.push(Hd);
	const R = r ? await addDevice(acct, 'R', r) : null; if (R) devs.push(R);
	const ed = editor === 'H' ? Hd : X;
	await settle(devs, 'paired');
	check('T0 written', (await wr(ed, p, T(p, 0))) === 'done');
	await wr(Hd, keep, T(keep, 0));
	await settle(devs, 'T0');
	const seen0 = await post(devs, p);
	check('every device agrees T0', Object.values(seen0).every((v) => v === 'T0'), JSON.stringify(seen0));
	if (stale) await setOnline(Hd, false);
	const online = () => devs.filter((d) => d.online);
	if (editor === 'H') { check('T1 written by the holder', (await wr(ed, p, T(p, 1))) === 'done'); await settle(online(), 'T1'); }
	else { check('T1 written by the deleter', (await wr(X, p, T(p, 1))) === 'done'); await settle(online(), 'T1'); }
	check('deleted by ' + x, (await rm(X, p)) === 'done');
	const vDel = await settle(online(), 'delete');
	if (R) {
		check('relay wrote an unrelated file', (await wr(R, 'mix/relay-' + id + '.md', T('relay', 0))) === 'done');
		await settle(online(), 'relay');
	}
	const g1 = await head(X, true);
	const hr1 = g1.parcel && g1.parcel.chunkedTombs ? g1.parcel.chunkedTombs[p] : undefined;
	note('head v' + g1.version + ' record before the holder returns: ' + JSON.stringify(hr1));
	if (rollback === 'before') await rollBack(devs, Hd);
	if (stale) await setOnline(Hd, true);
	if (rollback === 'before') await reloadLive(Hd);
	await settle(devs, 'return');
	if (rollback === 'after') await rollBack(devs);
	if (rollback) await settle(devs, 'rolled back');
	const end = await post(devs, p), keeps = await post(devs, keep);
	const g2 = await head(X, true);
	const hr2 = g2.parcel && g2.parcel.chunkedTombs ? g2.parcel.chunkedTombs[p] : undefined;
	const recs = {};
	for (const d of devs) recs[d.name + ':' + d.kind] = JSON.stringify(await rec(d, p));
	console.log('  RESULT ' + id + ' file: ' + JSON.stringify(end) + ' | keep: ' + JSON.stringify(keeps));
	console.log('  RESULT ' + id + ' head record: ' + JSON.stringify(hr2) + ' | local records: ' + JSON.stringify(recs) + ' | agreed-at: ' + JSON.stringify(await Promise.all(devs.map(agreedAt))));
	const bad = [];
	for (const d of devs) if (d.errs.length) bad.push(d.name + ': ' + d.errs.slice(0, 3).join(' / '));
	if (bad.length) note('page errors: ' + bad.join(' ## '));
	const out = { id, end, keeps, rec1: hr1, rec2: hr2, devs };
	return out;
}
/// Serve the live tree on the f4 origin. A device is brought up on it by a reload, online.
async function swapToLive() {
	await stopServer(PORT.f4);
	await startServer('live', PORT.f4);
}
async function reloadLive(d) {
	await d.page.reload({ waitUntil: 'domcontentloaded' });
	await ready(d);
	const c = await codeIs(d);
	check(d.name + ' now runs the live build after the rollback', c === 'live', c);
	d.kind = 'f4>live';
}
async function rollBack(devs, except) {
	await swapToLive();
	for (const d of devs) if (d !== except && d.kind === 'f4') await reloadLive(d);
}
async function afterRollbackRoundTrip(res, extra) {
	const { devs } = res;
	const [X, Hd] = devs;
	const q = 'mix/after-' + res.id + '.md';
	check('after the rollback, a new file is written', (await wr(X, q, T(q, 0))) === 'done');
	await settle(devs, 'after-new');
	check('after the rollback, the other device edits it', (await wr(Hd, q, T(q, 1))) === 'done');
	await settle(devs, 'after-edit');
	const e1 = await post(devs, q);
	check('after the rollback, the new file reached every device, edited', Object.values(e1).every((v) => v === 'T1'), JSON.stringify(e1));
	check('after the rollback, it is deleted and stays deleted', (await rm(X, q)) === 'done');
	await settle(devs, 'after-del');
	const e2 = await post(devs, q);
	check('after the rollback, the deletion reached every device', Object.values(e2).every((v) => v === 'ABSENT'), JSON.stringify(e2));
	const e3 = await post(devs, extra);
	console.log('  RESULT ' + res.id + ' after round trip: new ' + JSON.stringify(e2) + ' | the earlier file ' + JSON.stringify(e3));
}

// ── The cases ────────────────────────────────────────────────────────────
const gone = (res, who) => Object.entries(res.end).filter(([k]) => !who || who.some((w) => k.startsWith(w + ':'))).every(([, v]) => v === 'ABSENT');
const back = (res) => Object.entries(res.end).filter(([, v]) => v !== 'ABSENT').map(([k, v]) => k + '=' + v);
const kept = (res) => Object.values(res.keeps).every((v) => v === 'T0');
const CASES = {
	base: { x: 'live', h: 'live' }, ff: { x: 'f4', h: 'f4' },
	a: { x: 'f4', h: 'live', editor: 'H', stale: false }, a2: { x: 'f4', h: 'live' },
	b: { x: 'live', h: 'f4' }, b2: { x: 'live', h: 'f4', stale: false },
	c: { x: 'f4', h: 'f4', r: 'live' }, c2: { x: 'f4', h: 'f4', r: 'f4' },
	d: { x: 'f4', h: 'f4', rollback: 'after' }, d2: { x: 'f4', h: 'f4', rollback: 'before' },
};
const ORDER = ['base', 'ff', 'a', 'a2', 'b', 'b2', 'c', 'c2', 'd', 'd2'];
const RES = {};
const todo = WHICH === 'all' ? ORDER : WHICH.split(',');
try {
	await startWorld();
	for (const id of todo) {
		if (!CASES[id]) { note('no case ' + id); continue; }
		if (id !== 'base' && !RES.base && todo.includes('base') === false) note('no base run in this call: the comparison is by the stated expectation');
		let res;
		try { res = RES[id] = await scenario(id, CASES[id]); }
		catch (e) { check('case ' + id + ' ran', false, e && e.message); continue; }
		const b = RES.base;
		const sameAsBase = (d, who) => b ? (gone(b, who) ? gone(res, who) : true) : true;
		switch (id) {
		case 'base': note('live-only outcome: ' + (gone(res) ? 'deleted everywhere (no fault on this seed)' : 'file stands on ' + back(res).join(', ') + ' (the fault)')); break;
		case 'ff': check('ff: deleted on every device', gone(res), back(res).join(', ')); break;
		case 'a': check('a: no resurrect on either device', gone(res), back(res).join(', ')); break;
		case 'a2': check('a2: no worse than live-only', sameAsBase(res), back(res).join(', ')); note('a2 outcome: ' + (gone(res) ? 'deleted everywhere' : 'stands on ' + back(res).join(', '))); break;
		case 'b': check('b: no worse than live-only', sameAsBase(res), back(res).join(', ')); note('b outcome: ' + (gone(res) ? 'deleted everywhere' : 'stands on ' + back(res).join(', '))); break;
		case 'b2': check('b2: deleted everywhere (the bytes rule)', gone(res), back(res).join(', ')); break;
		case 'c': check('c: no worse than live-only', sameAsBase(res), back(res).join(', '));
			note('c outcome: ' + (gone(res) ? 'deleted everywhere' : 'stands on ' + back(res).join(', ')) + '; the record the relay left: ' + JSON.stringify(res.rec1)); break;
		case 'c2': check('c2: deleted on every device through an f4 relay', gone(res), back(res).join(', ') + ' | ' + JSON.stringify(res.rec1)); break;
		case 'd': check('d: nothing came back through the rollback', gone(res), back(res).join(', ')); check('d: the unrelated file is kept everywhere', kept(res), JSON.stringify(res.keeps));
			await afterRollbackRoundTrip(res, 'mix/keep-d.md'); break;
		case 'd2': check('d2: no worse than live-only', sameAsBase(res), back(res).join(', ')); note('d2 outcome: ' + (gone(res) ? 'deleted everywhere' : 'stands on ' + back(res).join(', '))); check('d2: the unrelated file is kept', kept(res), JSON.stringify(res.keeps)); break;
		default: break;
		}
		for (const d of res.devs) await d.ctx.close().catch(() => {});
		if (SERVERS[PORT.f4].kind === 'live') { await stopServer(PORT.f4); await startServer('f4', PORT.f4); }
	}
} catch (e) {
	console.log('ABORT ' + (e && e.stack || e));
	fail++;
} finally {
	killAll();
}
console.log('\n' + (fail ? 'FAILED' : 'PASSED') + ': ' + pass + ' ok, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
