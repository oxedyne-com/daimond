// gateway: own
// verify_gwdl1_mixed.mjs — QGW-DL1 (2026-09-27): the sweep floor through the
// HTTP API, with real gateway binaries and the real client's chunks.js.
//
// Two halves, both driven against binaries named on the command line:
//
// (M) MIXED VERSIONS AND ROLLBACK. One store, the binaries in turn: A writes an
//     account in every state the floor can leave (declared, held back with a
//     token, a sweep done), stops; B opens the same store and must read, sweep,
//     hold back and confirm; then A again over what B wrote. `--pair OLD NEW`
//     runs OLD -> NEW -> OLD -> NEW.
//
// (C) THE CLIENT COMPOSING WITH THE FLOOR. `www/js/chunks.js` from a named git
//     revision is loaded in a simulated tab whose gwFetch goes to the running
//     gateway, with `syncMayCommitChunks` true and a `confirm` that refuses (no
//     person says yes). Each case asks one question: does a declared chunk go
//     with nobody asked? `--client REV` names the revision; `--client tree` (the
//     default) is this worktree's own file.
//
// Needs no browser. It starts its own gateway (`procLog`) on DAIMOND_GW_PORT
// unless QGW_PORT is set, in a scratch directory of its own, and refuses a port
// that already answers rather than measure another gateway. With no binary
// named it runs `--single` over the tree's gateway and the tree's chunks.js,
// which is what a suite run measures (GW-DL1d).
//
// (R) QGW2 (2026-09-27), THE 7-DAY KEEP ACROSS A ROLLBACK, ON A MOVED CLOCK. The
//     new binary releases and holds, the OLD binary runs its collector with the
//     wall clock moved a day on (an LD_PRELOAD shim, `--shim`, that shifts
//     CLOCK_REALTIME by the seconds in a file and shortens the sweeper's sleeps),
//     then the new binary again, a week on. Asks: does the old binary delete early,
//     and how much; and does the new one come back to a store it can read.
//
// Since the 7-day keep (QGW2) a commit deletes nothing, so "does a declared chunk
// go" is asked of the gateway's replies (`released`, summed over the tab's
// commits) as well as of the store: a release is on the week's clock.
//
//   node dev/verify_gwdl1_mixed.mjs --pair <old-bin> <new-bin> [--client REV]... [--m-only]
//   node dev/verify_gwdl1_mixed.mjs --single <bin> [--client REV]...
//   node dev/verify_gwdl1_mixed.mjs --rollback-clock <old-bin> <new-bin> --shim <qgwclock.so>
//   node dev/verify_gwdl1_mixed.mjs
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { GWBIN, procLog, requireFreshGateway } from './gwbin.mjs';
import { GW_PORT } from './ports.mjs';
import { grantPro } from './pro.mjs';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const ROOT  = path.join(HERE, '..');
const PORT  = Number(process.env.QGW_PORT || GW_PORT);
const URL0  = `http://127.0.0.1:${PORT}`;
const WORK  = process.env.QGW_DIR || path.join(process.env.DAIMOND_SCRATCH
	|| path.join(os.homedir(), '.cache/daimond'), 'gwdl1mixed', `gw${PORT}`);
const LOG   = procLog('verify_gwdl1_mixed').path;

const argv = process.argv.slice(2);
const pairAt = argv.indexOf('--pair'), singleAt = argv.indexOf('--single');
const clockAt = argv.indexOf('--rollback-clock'), shimAt = argv.indexOf('--shim');
const SHIM = shimAt >= 0 ? argv[shimAt + 1] : '';
if (pairAt < 0 && clockAt < 0 && singleAt < 0) requireFreshGateway();
const BINS = pairAt >= 0 ? [argv[pairAt + 1], argv[pairAt + 2]]
	: clockAt >= 0 ? [argv[clockAt + 1], argv[clockAt + 2]]
	: singleAt >= 0 ? [argv[singleAt + 1]] : [GWBIN];
const CLIENTS = [];
argv.forEach((a, i) => { if (a === '--client') CLIENTS.push(argv[i + 1]); });
if (!CLIENTS.length) CLIENTS.push('tree');
if (BINS.some(b => !b || !fs.existsSync(b))) {
	console.log('usage: [--pair OLD NEW | --single BIN | --rollback-clock OLD NEW --shim SO]  [--client REV|tree]...');
	process.exit(2);
}

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const short = b => path.basename(path.dirname(b)) + '/' + path.basename(b);

// ── The gateway's directory: the dev config on this world's port, a fresh store ──
function prepare() {
	const r = execFileSync('bash', [path.join(ROOT, 'dev/devgw.sh')],
		{ cwd: ROOT, encoding: 'utf8', env: { ...process.env, DAIMOND_GW_PORT: String(PORT) } });
	const devgw = r.trim().split('\n').pop();
	fs.mkdirSync(WORK, { recursive: true });
	const store = path.join(WORK, 'o3db');
	if (fs.existsSync(store)) fs.rmSync(store, { recursive: true, force: true });
	fs.copyFileSync(path.join(devgw, 'app.jdat'), path.join(WORK, 'app.jdat'));
	const keys = path.join(WORK, 'keys');
	if (!fs.existsSync(keys)) fs.symlinkSync(path.join(ROOT, 'gateway/keys'), keys);
	const txt = fs.readFileSync(path.join(WORK, 'app.jdat'), 'utf8');
	if (!txt.includes(`(u16|${PORT})`) || !/"beta_only":\s*"false"/.test(txt)) {
		console.log('  FAIL the gateway directory is not on port ' + PORT + ' and open'); process.exit(1);
	}
}

let gw = null;
async function start(bin, extra) {
	// A gateway already answering on the port would be measured in place of `bin`,
	// whose own start then fails to bind: refuse rather than read the wrong one.
	try {
		await fetch(URL0 + '/api/health');
		console.log(`  FAIL :${PORT} already answers; this run starts its own gateway there`);
		return false;
	} catch (e) { /* free, as it must be */ }
	fs.mkdirSync(path.dirname(LOG), { recursive: true });
	const out = fs.openSync(LOG, 'a');
	fs.writeSync(out, `\n===== ${new Date().toISOString()} start ${bin}\n`);
	gw = spawn(bin, [], { cwd: WORK, env: { ...process.env, APP_MODE: 'sandbox', ...(extra || {}) },
		stdio: ['ignore', out, out] });
	const t0 = Date.now();
	while (Date.now() - t0 < 60000) {
		try { const r = await fetch(URL0 + '/api/health'); if (r.status < 500) return true; }
		catch (e) { /* not up yet */ }
		if (gw.exitCode !== null) return false;
		await sleep(300);
	}
	return false;
}
async function stop() {
	if (!gw || gw.exitCode !== null) { gw = null; return; }
	const p = new Promise(r => gw.once('exit', r));
	gw.kill('SIGTERM');
	const t = setTimeout(() => { try { gw.kill('SIGKILL'); } catch (e) {} }, 20000);
	await p; clearTimeout(t); gw = null;
	await sleep(500);
}

// ── An account, the way the app makes one: an Ed25519 device key ──
const b64 = buf => Buffer.from(buf).toString('base64');
const b64url = buf => Buffer.from(buf).toString('base64')
	.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function post(pathname, body, cookie) {
	const headers = { 'content-type': 'application/json', 'x-daimond-api': '2' };
	if (cookie) headers.cookie = cookie;
	const r = await fetch(URL0 + pathname, { method: 'POST', headers, body: JSON.stringify(body) });
	let j = null; try { j = await r.json(); } catch (e) {}
	return { status: r.status, json: j, setCookie: r.headers.get('set-cookie') };
}

async function account() {
	const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
	const pub  = publicKey.export({ format: 'jwk' }).x;
	const sign = s => b64(crypto.sign(null, Buffer.from(s, 'utf8'), privateKey));
	const ts   = Math.floor(Date.now() / 1000);
	const a = await post('/api/account', { pubkey: pub, alg: 'Ed25519', ts,
		sig: sign('daimond-gw-account:v1:' + pub + ':' + ts) });
	if (a.status !== 200) throw new Error('account ' + a.status + ' ' + JSON.stringify(a.json));
	const who = { id: a.json.account_id, pub, sign, cookie: null };
	await login(who);
	const pro = await grantPro(who.id, path.join(ROOT, 'gateway'), URL0);
	if (pro !== 200) throw new Error('pro webhook ' + pro);
	return who;
}
async function login(who) {
	const ch = await post('/api/auth/challenge', { pubkey: who.pub, alg: 'Ed25519' });
	const v  = await post('/api/auth/verify', { challenge_id: ch.json.challenge_id, sig: who.sign(ch.json.challenge) });
	if (v.status !== 200 || !v.setCookie) throw new Error('verify ' + v.status);
	who.cookie = v.setCookie.split(';')[0];
}

// ── Chunks ──
let seq = 0;
function mk(n, tag) {
	const out = [];
	for (let i = 0; i < n; i++) {
		const bytes = Buffer.from(`qgwdl1-${tag}-${process.pid}-${seq++}-${crypto.randomBytes(8).toString('hex')}`);
		out.push({ addr: crypto.createHash('sha256').update(bytes).digest('hex'), bytes });
	}
	return out;
}
async function put(who, cs) {
	const r = await post('/api/chunk', { op: 'put',
		chunks: cs.map(c => ({ addr: c.addr, blob: b64url(c.bytes) })) }, who.cookie);
	if (r.status !== 200) throw new Error('put ' + r.status + ' ' + JSON.stringify(r.json));
}
async function commit(who, cs, token) {
	const body = { op: 'commit', blob_version: 0,
		chunks: cs.map(c => ({ addr: c.addr, size: c.bytes.length, tier: 'f' })) };
	if (token) body.sweep_token = token;
	return post('/api/chunk', body, who.cookie);
}
async function held(who, cs) {
	const r = await post('/api/chunk', { op: 'have', addrs: cs.map(c => c.addr) }, who.cookie);
	if (r.status !== 200) throw new Error('have ' + r.status);
	return cs.length - r.json.missing.length;
}
async function declare(who, n) {
	const cs = mk(n, 'decl');
	await put(who, cs);
	const r = await commit(who, cs);
	if (r.status !== 200 || r.json.swept !== 0) throw new Error('declare ' + JSON.stringify(r.json));
	return cs;
}

// ── The real client, in a simulated tab ──
function clientSource(rev) {
	if (rev === 'tree') return fs.readFileSync(path.join(ROOT, 'www/js/chunks.js'), 'utf8');
	return execFileSync('git', ['show', `${rev}:www/js/chunks.js`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
}
function tab(src, who) {
	const store = new Map();
	const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
	const noEl = { addEventListener() {}, appendChild() {}, setAttribute() {}, querySelector: () => null,
		querySelectorAll: () => [], remove() {}, style: {}, classList: { add() {}, remove() {}, toggle() {} } };
	const document = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null, createElement: () => Object.assign({}, noEl), body: noEl };
	const win = { addEventListener() {}, dispatchEvent: () => true };
	let asked = 0;
	win.DaimondCore = { syncMayCommitChunks: () => true, confirm: async () => { asked++; return false; } };
	const replies = [];
	win.DaimondGateway = { clientApi: () => 2, gwFetch: async (p, init) => {
		const r = await fetch(URL0 + p, { ...init, headers: { ...(init.headers || {}), cookie: who.cookie } });
		try { const j = await r.clone().json(); if (j && ('swept' in j || 'released' in j || 'sweep_token' in j)) replies.push(j); }
		catch (e) { /* not JSON */ }
		return r;
	} };
	function CE(t, o) { this.type = t; this.detail = o && o.detail; }
	const quiet = { debug() {}, log() {}, warn() {}, error() {} };
	const fn = new Function('window', 'document', 'crypto', 'localStorage', 'TextEncoder', 'TextDecoder',
		'CustomEvent', 'Blob', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console',
		'globalThis', 'navigator', 'AbortController', 'with (window) {\n' + src + '\n}');
	fn(win, document, webcrypto, localStorage, TextEncoder, TextDecoder, CE, Blob, setTimeout, clearTimeout,
		setInterval, clearInterval, quiet, globalThis, { storage: {} }, AbortController);
	// What the gateway said to this tab's commits: released (the week's clock
	// started) and swept (deleted; 0 since the 7-day keep), summed.
	const sum = k => replies.reduce((a, j) => a + ((j && j[k]) | 0), 0);
	return { C: win.DaimondChunks, asked: () => asked, released: () => sum('released'), swept: () => sum('swept') };
}
const manifests = cs => ({ 'f.bin': { chunks: cs.map(c => ({ addr: c.addr, size: c.bytes.length })) } });

// ── (C) the client cases ──
async function clientCases(bin, rev) {
	const src = clientSource(rev);
	const tag = `${short(bin)} + chunks.js@${rev}`;
	// What the page lets a person confirm. 5.1.x-5.2.1 never mark a confirmation
	// (the gateway ignores their token); 5.3 before F8 confirms any standing
	// shape; the F8 page (5.2.2, `heldAsks`) confirms only a shape standing as
	// 'ask' -- every address it named was declared -- and refuses the rest.
	const marks   = /sweep_confirm\s*=\s*'person'/.test(src);	// not the i18n keys named sweep_confirm_*
	const asksOnly = /function heldAsks\(/.test(src);
	console.log(`\n— C: ${tag} —`);

	{	// C1: a narrow commit beside another device's upload in flight.
		const who = await account(), decl = await declare(who, 4);
		await put(who, mk(1, 'inflight'));
		const t = tab(src, who);
		await t.C.commit(manifests([decl[0]]), 0);
		const s = t.C.state();
		check(`C1 ${tag}: naming 1 of 4 beside an upload in flight, nobody asked, the 3 others stay`,
			await held(who, decl) === 4 && t.released() === 0 && t.swept() === 0,
			`held ${await held(who, decl)}/4, released ${t.released()}, swept ${t.swept()}, confirmed alone ${s.confirmed}, standing ${s.why || '-'}`);
	}
	{	// C2: an index naming one of ten declared chunks.
		const who = await account(), decl = await declare(who, 10);
		const t = tab(src, who);
		await t.C.commit(manifests([decl[0]]), 0);
		const s = t.C.state();
		check(`C2 ${tag}: naming 1 of 10, nobody asked, the 9 others stay`,
			await held(who, decl) === 10 && t.released() === 0 && t.swept() === 0,
			`held ${await held(who, decl)}/10, released ${t.released()}, swept ${t.swept()}, confirmed alone ${s.confirmed}`);
	}
	{	// C3: the 09-13 shape over two sync rounds.
		const who = await account(), decl = await declare(who, 4);
		const fresh = mk(3, 'reoffload'); await put(who, fresh);
		const t = tab(src, who);
		await t.C.commit(manifests(fresh), 0);
		const after1 = await held(who, decl);
		await t.C.commit(manifests(fresh), 0);
		const after2 = await held(who, decl);
		check(`C3 ${tag}: the 09-13 shape (4 declared, 3 own) over two rounds keeps the 4`,
			after1 === 4 && after2 === 4 && t.released() === 0 && t.swept() === 0,
			`${after1} then ${after2} of 4, released ${t.released()}, swept ${t.swept()}, confirmed alone ${t.C.state().confirmed}`);
	}
	{	// C4: the 09-13 shape with a gateway restart between the offload and the commit.
		const who = await account(), decl = await declare(who, 4);
		const fresh = mk(3, 'reoffload'); await put(who, fresh);
		await stop(); await start(bin);
		await login(who);	// a session does not outlive the process
		const t = tab(src, who);
		await t.C.commit(manifests(fresh), 0);
		check(`C4 ${tag}: the 09-13 shape across a gateway restart keeps the 4`,
			await held(who, decl) === 4 && t.released() === 0 && t.swept() === 0,
			`held ${await held(who, decl)}/4, released ${t.released()}, swept ${t.swept()}, confirmed alone ${t.C.state().confirmed}`);
	}
	{	// C6: a wholesale rewrite (4 new addresses, none declared) stands as
		// 'unaccounted' on the F8 page: no Remove, all kept. On a 5.3 page before F8
		// the chip's confirm carries it out -- deleted on a gateway before the 7-day
		// keep, released (still stored) on one after. A 5.1.x-5.2.1 page cannot confirm.
		const who = await account(), old = await declare(who, 4);
		const neu = mk(4, 'rewrite'); await put(who, neu);
		const t = tab(src, who);
		await t.C.commit(manifests(neu), 0);
		const s0 = t.C.state();
		const r = await t.C.confirmHeldSweep();
		const s = t.C.state();
		const oldLeft = await held(who, old);
		const done = asksOnly ? (r === null && t.released() === 0 && t.swept() === 0 && oldLeft === 4 && s.standing)
			: !marks ? (t.released() === 0 && t.swept() === 0 && oldLeft === 4)
			: t.swept() === 4 ? oldLeft === 0 : (t.released() === 4 && oldLeft === 4);
		check(`C6 ${tag}: a held-back rewrite (${s0.why || '-'}) ` + (asksOnly ? 'offers no Remove and keeps all'
			: marks ? 'is carried out on the person\'s confirm' : 'cannot be confirmed by this page'),
			s0.standing && done && await held(who, neu) === 4,
			`stood ${s0.standing} (${s0.why || '-'}), confirm ${r === null ? 'null' : 'sent'}, released ${t.released()}, ` +
			`swept ${t.swept()}, old ${oldLeft}/4 stored, new ${await held(who, neu)}/4, still standing ${s.standing} ` +
			`(${s.why || '-'}), refused '${s.refused}'`);
	}
	{	// C8 (QGW2): the confirm path on a shape that stands as 'ask': 1 of 10
		// declared named, nothing new. A page that marks the confirmation releases
		// the 9 (still stored, the week's clock); a 5.1.x-5.2.1 page cannot confirm.
		const who = await account(), decl = await declare(who, 10);
		const t = tab(src, who);
		await t.C.commit(manifests([decl[0]]), 0);
		const s0 = t.C.state();
		const r = await t.C.confirmHeldSweep();
		const s = t.C.state();
		const ok8 = marks ? (t.released() === 9 && !s.standing) : (t.released() === 0 && s.standing);
		check(`C8 ${tag}: a held-back narrow commit (${s0.why || '-'}) ` + (marks ? 'is released on the person\'s confirm, all still stored'
			: 'cannot be confirmed by this page, all kept'),
			s0.standing && ok8 && t.swept() === 0 && await held(who, decl) === 10,
			`stood ${s0.standing} (${s0.why || '-'}), confirm ${r === null ? 'null' : 'sent'}, released ${t.released()}, ` +
			`swept ${t.swept()}, stored ${await held(who, decl)}/10, still standing ${s.standing} (${s.why || '-'})`);
	}
	{	// C7 (QGW2): an account emptied on purpose. The index names nothing, so the
		// client cannot vouch for its list (why 'names_nothing'); record what the
		// person's confirm does. E2 (lead): no Remove for names_nothing -- Forget is its path.
		const who = await account(), decl = await declare(who, 4);
		const t = tab(src, who);
		await t.C.commit({}, 0);
		const s0 = t.C.state();
		const r = await t.C.confirmHeldSweep();
		check(`C7 ${tag}: an account emptied on purpose stands (${s0.why || '-'})` + (asksOnly ? ', offers no Remove' : ''),
			s0.standing && await held(who, decl) === 4 && t.swept() === 0
				&& (!asksOnly || (r === null && t.released() === 0)),
			`stood ${s0.standing} (${s0.why || '-'}), confirm returned ${r === null ? 'null' : 'a reply'}, ` +
			`released ${t.released()}, stored ${await held(who, decl)}/4`);
	}
	{	// C5: DL-1 as the client sends it: an index naming nothing, 5 young beside 4 declared.
		const who = await account(), decl = await declare(who, 4);
		await put(who, mk(5, 'inflight'));
		const t = tab(src, who);
		await t.C.commit({}, 0);
		check(`C5 ${tag}: an empty index beside 5 young uploads keeps the 4`,
			await held(who, decl) === 4 && t.released() === 0 && t.swept() === 0,
			`held ${await held(who, decl)}/4, released ${t.released()}, swept ${t.swept()}, standing ${t.C.state().why || '-'}`);
	}
}

// ── (M) the rollback walk ──
async function writeStates(label) {
	const s = {};
	s.plain = await account(); s.plainDecl = await declare(s.plain, 4);
	s.hb = await account(); s.hbDecl = await declare(s.hb, 4);
	const r = await commit(s.hb, [s.hbDecl[0]]);
	s.hbToken = r.json && r.json.sweep_token;
	check(`M ${label}: a narrow commit is held back with a token`, !!s.hbToken, JSON.stringify(r.json));
	s.sw = await account(); s.swDecl = await declare(s.sw, 8);
	const r2 = await commit(s.sw, s.swDecl.slice(0, 7));
	check(`M ${label}: an ordinary commit sweeps (or, since the 7-day keep, releases) its one chunk`,
		r2.json && (r2.json.swept === 1 || (r2.json.swept === 0 && r2.json.released === 1)), JSON.stringify(r2.json));
	s.swDecl = s.swDecl.slice(0, 7);
	return s;
}
async function readStates(s, label, isNew) {
	await login(s.plain); await login(s.hb); await login(s.sw);
	const n = s.plainDecl.length;
	check(`M ${label}: the declared account's ${n} chunks read back`, await held(s.plain, s.plainDecl) === n);
	check(`M ${label}: the held-back account's 4 chunks read back`, await held(s.hb, s.hbDecl) === 4);
	check(`M ${label}: the swept account holds its ${s.swDecl.length}`, await held(s.sw, s.swDecl) === s.swDecl.length);
	// The held-back account: the same narrow commit again, with no token, deletes nothing;
	// on the new binary the hold (chold:) is still in force across the swap.
	const again = await commit(s.hb, [s.hbDecl[0]]);
	check(`M ${label}: the held-back narrow commit sent again deletes nothing` + (isNew ? ' and is still held back' : ''),
		await held(s.hb, s.hbDecl) === 4 && ((again.json && again.json.released) | 0) === 0
			&& (!isNew || (again.json && again.json.sweep_held_back > 0)),
		JSON.stringify(again.json));
	if (n > 1) {
		const e = await commit(s.plain, s.plainDecl.slice(0, n - 1));
		check(`M ${label}: an edit (${n - 1} of ${n}) still sweeps (or releases)`,
			e.json && (e.json.swept === 1 || (e.json.swept === 0 && e.json.released === 1)), JSON.stringify(e.json));
		s.plainDecl = s.plainDecl.slice(0, n - 1);
	}
	const x = await commit(s.sw, []);
	check(`M ${label}: an empty commit on ${s.swDecl.length} declared is held back`,
		x.json && x.json.sweep_held_back > 0 && (x.json.released | 0) === 0, JSON.stringify(x.json));
	check(`M ${label}: ... and all ${s.swDecl.length} stay`, await held(s.sw, s.swDecl) === s.swDecl.length);
	await commit(s.sw, s.swDecl);	// restore the whole index for the next leg
}

/// The person's confirmation, as the 5.3 chip sends it, over a hold that has crossed swaps.
async function personConfirms(s, label) {
	const r = await commit(s.hb, [s.hbDecl[0]]);
	const tok = r.json && r.json.sweep_token;
	const body = { op: 'commit', blob_version: 0, sweep_token: tok, sweep_confirm: 'person',
		chunks: [{ addr: s.hbDecl[0].addr, size: s.hbDecl[0].bytes.length, tier: 'f' }] };
	const c = await post('/api/chunk', body, s.hb.cookie);
	check(`M ${label}: a person's confirmation releases the held-back set (stored for the week)`,
		!!tok && c.json && c.json.swept === 0 && c.json.released === 3 && await held(s.hb, s.hbDecl) === 4,
		JSON.stringify(c.json));
}

// ── (R) the 7-day keep across a rollback, on a moved clock (QGW2) ──
const collectorLines = () => fs.readFileSync(LOG, 'utf8').split('\n').filter(l => l.includes('Chunk collector:'));
async function nextCollectorLine(after, secs) {
	const t0 = Date.now();
	while (Date.now() - t0 < secs * 1000) {
		const ls = collectorLines();
		if (ls.length > after) return ls[ls.length - 1];
		if (!gw || gw.exitCode !== null) return null;
		await sleep(500);
	}
	return null;
}
async function rollbackClock(OLD, NEW) {
	if (!SHIM || !fs.existsSync(SHIM)) { check('R the clock shim exists (--shim)', false, SHIM); return; }
	const off = path.join(WORK, 'clock_offset.txt');
	const setOff = secs => fs.writeFileSync(off, String(secs));
	const H = 3600;
	setOff(0);
	const clock = { LD_PRELOAD: SHIM, QGW_OFFSET_FILE: off, QGW_SLEEP_DIV: '300' };
	console.log(`\n— R: the 7-day keep across a rollback: ${short(NEW)} -> ${short(OLD)} (+23 h, +29 h) -> ${short(NEW)} (+29 h, +8 d) —`);

	check('R the new binary starts on a fresh store', await start(NEW));
	const A = await account(), aD = await declare(A, 8);
	const a1 = await commit(A, aD.slice(0, 6));
	check('R new: an edit releases 2 of 8', a1.json && a1.json.released === 2 && a1.json.swept === 0, JSON.stringify(a1.json));
	const B = await account(), bD = await declare(B, 4);
	const b1 = await commit(B, [bD[0]]);
	check('R new: a narrow commit is held back (3 held)', !!(b1.json && b1.json.sweep_token), JSON.stringify(b1.json));
	const C = await account(), cD = await declare(C, 4);
	const c1 = await commit(C, [cD[0]]);
	const c2 = await post('/api/chunk', { op: 'commit', blob_version: 0, sweep_token: c1.json && c1.json.sweep_token,
		sweep_confirm: 'person', chunks: [{ addr: cD[0].addr, size: cD[0].bytes.length, tier: 'f' }] }, C.cookie);
	check('R new: a person releases 3', c2.json && c2.json.released === 3, JSON.stringify(c2.json));
	const D = await account(), dD = await declare(D, 4);
	const E = await account(), eD = await declare(E, 2), eS = mk(1, 'stray'); await put(E, eS);
	const F = await account(), fD = await declare(F, 4);
	const f1 = await commit(F, fD.slice(0, 2));
	check('R new: an edit releases 2 of 4 (to be named again under the old binary)', f1.json && f1.json.released === 2, JSON.stringify(f1.json));
	const all = async () => ({ A: await held(A, aD), B: await held(B, bD), C: await held(C, cD),
		D: await held(D, dD), E: await held(E, eD.concat(eS)), F: await held(F, fD) });
	const stored0 = await all();
	check('R new: nothing deleted by any commit', JSON.stringify(stored0) === JSON.stringify({ A: 8, B: 4, C: 4, D: 4, E: 3, F: 4 }), JSON.stringify(stored0));
	await stop();

	// The old binary, its clock at first unmoved, then 23 h and 29 h on.
	check('R the old binary starts on a store holding crel: and chold:', await start(OLD, clock));
	for (const w of [A, B, C, D, E, F]) await login(w);
	const f2 = await commit(F, fD);
	check('R old: a commit naming the released pair again deletes nothing', f2.json && f2.json.swept === 0, JSON.stringify(f2.json));
	const firstPass = await nextCollectorLine(0, 120);
	check('R old: its collector runs (the first pass marks)', !!firstPass, firstPass || 'no pass in 120 s');
	setOff(23 * H);
	const at23 = await nextCollectorLine(collectorLines().length, 120);
	for (const w of [A, B, C, D, E, F]) await login(w);
	const stored23 = await all();
	setOff(29 * H + 60);
	const at29 = await nextCollectorLine(collectorLines().length, 120);
	for (const w of [A, B, C, D, E, F]) await login(w);
	const stored29 = await all();
	console.log(`    old +23 h: ${at23 || 'no pass'}\n      stored ${JSON.stringify(stored23)}`);
	console.log(`    old +29 h: ${at29 || 'no pass'}\n      stored ${JSON.stringify(stored29)}`);
	check('R old +23 h: nothing deleted before a day', JSON.stringify(stored23) === JSON.stringify(stored0), JSON.stringify(stored23));
	// The design note's statement: the old collector takes every released and held
	// piece of an account with an index about a day into the rollback, whatever
	// was left of its week, and nothing an index names.
	check('R old +29 h: it took the released and held pieces, and nothing named',
		JSON.stringify(stored29) === JSON.stringify({ A: 6, B: 1, C: 1, D: 4, E: 2, F: 4 }), JSON.stringify(stored29));
	await stop();

	// Forward again, the clock still 29 h on; then a week on.
	check('R the new binary starts again on the old binary\'s store', await start(NEW, clock));
	for (const w of [A, B, C, D, E, F]) await login(w);
	const a2 = await commit(A, aD);
	check('R new again: a commit naming the pair the old collector took gets it back as missing',
		a2.json && a2.json.released === 0 && Array.isArray(a2.json.missing) && a2.json.missing.length === 2, JSON.stringify(a2.json));
	const b2 = await commit(B, [bD[0]]);
	check('R new again: the stale hold (its pieces gone) holds back nothing', b2.json && !b2.json.sweep_token && b2.json.released === 0,
		JSON.stringify(b2.json));
	const f3 = await commit(F, fD);
	check('R new again: the pair the old index named again stays', f3.json && f3.json.released === 0 && await held(F, fD) === 4,
		JSON.stringify(f3.json));
	const before8 = collectorLines().length;
	setOff(8 * 24 * H);
	const at8d = await nextCollectorLine(before8, 180);
	console.log(`    new +8 d: ${at8d || 'no pass'}`);
	for (const w of [A, B, C, D, E, F]) await login(w);
	const stored8 = await all();
	check('R new +8 d: the new collector ran and deleted nothing still named',
		!!at8d && stored8.A === 6 && stored8.D === 4 && stored8.F === 4 && stored8.B === 1 && stored8.C === 1, `${at8d} ${JSON.stringify(stored8)}`);
	const errs = fs.readFileSync(LOG, 'utf8').split('\n').filter(l => /ERROR/.test(l));
	console.log(`    gateway log ERROR lines over the walk: ${errs.length}`);
	errs.slice(0, 6).forEach(l => console.log('      ' + l.slice(0, 220)));
	await stop();
}

async function main() {
	prepare();
	fs.writeFileSync(LOG, '');
	if (clockAt >= 0) {
		await rollbackClock(BINS[0], BINS[1]);
		console.log(`\n${ok.length} ok, ${bad.length} failed`);
		process.exit(bad.length ? 1 : 0);
	}
	if (BINS.length === 2) {
		const [OLD, NEW] = BINS;
		console.log(`\n— M: rollback walk ${short(OLD)} -> ${short(NEW)} -> ${short(OLD)} -> ${short(NEW)} on one store —`);
		check('M the old binary starts on a fresh store', await start(OLD));
		const a = await writeStates('old wrote');
		await stop();
		check('M the new binary starts on the old binary\'s store', await start(NEW));
		await readStates(a, 'new reads old', false);	// the old binary's hold was in memory: it does not cross the upgrade
		const b = await writeStates('new wrote');
		await stop();
		check('M the old binary starts again on the new binary\'s store', await start(OLD));
		await readStates(a, 'old reads old, after new', false);
		await readStates(b, 'old reads new', false);
		await stop();
		check('M the new binary starts again', await start(NEW));
		await readStates(b, 'new reads new, after old', true);
		await personConfirms(b, 'new, after old');
		await stop();
	}
	for (const bin of (argv.includes('--m-only') ? [] : BINS)) {
		for (const rev of CLIENTS) {
			const s = path.join(WORK, 'o3db');
			if (fs.existsSync(s)) fs.rmSync(s, { recursive: true, force: true });
			check(`C ${short(bin)} starts on a fresh store`, await start(bin));
			try { await clientCases(bin, rev); }
			catch (e) { check(`C ${short(bin)} + ${rev} ran to the end`, false, String(e && e.stack || e)); }
			await stop();
		}
	}
	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	process.exit(bad.length ? 1 : 0);
}
main().catch(async e => { console.log('  FAIL crashed: ' + (e && e.stack || e)); await stop(); process.exit(1); });
