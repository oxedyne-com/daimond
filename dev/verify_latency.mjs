// verify_latency.mjs -- how long a tile, a rename and a finished turn take to reach another device
// (U0 of the sync re-plan, 2026-10-08). The BASELINE instrument: it is EXPECTED red until the
// sync re-plan's later units land, and it says by how much.
//
// Three real Chromium contexts on one account and one world, as `dev/soak_sync.mjs` builds them:
//
//   A  desktop, the account's first device, the RUNNER (the only one that beats presence);
//   G  desktop, paired to A, a VIEWER;
//   P  an iPhone to the app (its UA, touch), a VIEWER, and in S2 the DISPATCHER.
//
// Two scenarios, each repeated `--reps` times (default 3), each turn `@rounds 9/1500 file_list`,
// nine tool rounds paced 1.5 s apart, so the turn takes about fourteen seconds and its rows are made
// one by one:
//
//   S1  A runs the turn in a new chat and does not wait for it; while it runs A renames the chat
//       five times, 2.5 s apart. G and P are viewers: the rows reach them by the account parcel.
//   S2  P dispatches the turn from a new chat on the phone; A runs it. P receives the progress
//       frames, G the parcel.
//
// WHAT IS MEASURED is read off each viewer's `DEBUG_SHARE._arrivals()` (www/js/debugshare.js), the
// ring the app's arrive hooks fill: `ms` = the viewer's clock at arrival - the origin's `made` stamp
// on the row. All three contexts share one host clock, so there is no skew to speak of; a negative
// figure is counted apart as skew. The origin's own transcript (mids and `ts`) is read from A, to say
// how many rows a viewer never logged (the instrument's gap) and how many it never held (a sync fault).
//
//   L1 tile    P50 <= 2 s, P90 <= 4 s   every row of the turn, per viewer
//   L2 edit    P50 <= 2 s, P90 <= 5 s   each rename (S1 only), per viewer
//   L3 commit  P90 <= 5 s               the turn's LAST row, from its `ts` on A to the viewer holding
//                                       it saved-real (a `commit` arrival whose `made` covers it)
//   L5 409     = 0                      `/api/sync` answers of 409, per device, over the whole run
//
// ── RUNNING ──────────────────────────────────────────────────
//
//   eval "$(bash dev/world.sh 78 --env)"
//   node dev/verify_latency.mjs --gw <daimond_gateway> [--reps 3] [--json <file>] [--settle 25] [--keep]
//
// It starts the gateway (fresh store), the mock provider and the app server on the world's ports and
// stops them on the way out; it serves the working tree's www/ and does not check the build stamp.
// No world is started between 01:05 and 04:00 (the nightly's window), unless --any-hour.
// Exit 0: every target met. 1: a target missed (the expected baseline). 2: it could not run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CHROME, SCRATCH, signInAs, connectMock, newChat } from './harness.mjs';
import { cleanDisplayEnv } from './display.mjs';
import { makePagePro } from './pro.mjs';
import { TARGETS, summarise, judge, fmtMs } from './latencylib.mjs';

import { chromium } from './pw.mjs';
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TREE = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const GW_BIN   = arg('--gw', path.join(os.homedir(), '.cache/cargo-targets/claude-rc-11/daimond-r539-e6/release/daimond_gateway'));
const REPS     = Math.max(1, Number(arg('--reps', '3')));
const SETTLE   = Number(arg('--settle', '25')) * 1000;			// how long a viewer is given to hold the turn
const JSON_OUT = arg('--json', '');
const KEEP     = argv.includes('--keep');
const PORT     = Number(process.env.DAIMOND_PORT || 0);
const GW_PORT  = Number(process.env.DAIMOND_GW_PORT || 0);
const MOCK_PORT = Number(process.env.DAIMOND_MOCK_PORT || 0);
const MOCK_LOG = process.env.DAIMOND_MOCK_LOG || '';
const APP      = process.env.DAIMOND_APP || '';
const WORLD    = PORT - 8777;
const RUN      = Date.now().toString(36);
const ROOT     = path.join(SCRATCH, 'latency', RUN);
const ACCOUNT  = 'lat-' + RUN;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const TURN = '@rounds 9/1500 file_list {"path":"."}';
const DONE_RE = /Called 9 time\(s\); done\./;
const RENAMES = 5, RENAME_GAP = 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
const T0 = Date.now();
const at = () => ((Date.now() - T0) / 1000).toFixed(0).padStart(4) + 's';

if (!PORT || !GW_PORT || !MOCK_PORT || !MOCK_LOG || !APP) { console.log('refusing to run: eval "$(bash dev/world.sh <N> --env)" first'); process.exit(2); }
{
	const now = new Date(), hm = now.getHours() * 60 + now.getMinutes();
	if (!argv.includes('--any-hour') && hm >= 65 && hm < 240) { console.log('refusing to run: no world between 01:05 and 04:00 (the nightly\'s window)'); process.exit(2); }
}
if (!fs.existsSync(GW_BIN)) { console.log('refusing to run: no gateway binary at ' + GW_BIN); process.exit(2); }
fs.mkdirSync(ROOT, { recursive: true });

// ── The world: gateway, mock, app server (as the soak starts them) ──
const CHILDREN = new Set();
function child(cmd, args, opts, label) {
	const out = fs.openSync(path.join(ROOT, label + '.out'), 'a');
	const c = spawn(cmd, args, Object.assign({ stdio: ['ignore', out, out] }, opts));
	CHILDREN.add(c);
	c.on('exit', () => CHILDREN.delete(c));
	return c;
}
function killAll() { for (const c of CHILDREN) { try { c.kill('SIGTERM'); } catch (e) { /* gone */ } } }
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(130); });
const listening = (port) => new Promise((resolve) => {
	const s = net.connect(port, '127.0.0.1');
	s.once('connect', () => { s.destroy(); resolve(true); });
	s.once('error', () => resolve(false));
});
async function waitPort(port, ms = 30000) {
	for (const t0 = Date.now(); Date.now() - t0 < ms; ) { if (await listening(port)) return true; await sleep(200); }
	return false;
}
async function startWorld() {
	for (const [what, p] of [['app', PORT], ['gateway', GW_PORT], ['mock', MOCK_PORT]]) {
		if (await listening(p)) throw new Error(`world ${WORLD}'s ${what} port ${p} is already answering: another run holds this world`);
	}
	const cwd = path.join(ROOT, 'gwcwd');
	fs.mkdirSync(cwd, { recursive: true });
	execFileSync('bash', ['dev/devgw.sh'], { cwd: TREE, env: Object.assign({}, process.env, { DAIMOND_GW_PORT: String(GW_PORT) }) });
	fs.copyFileSync(path.join(TREE, 'dev/devgw/app.jdat'), path.join(cwd, 'app.jdat'));
	if (!fs.readFileSync(path.join(cwd, 'app.jdat'), 'utf8').includes(`(u16|${GW_PORT})`)) throw new Error('gateway config is not on ' + GW_PORT);
	fs.symlinkSync(fs.realpathSync(path.join(TREE, 'gateway/keys')), path.join(cwd, 'keys'));
	child(GW_BIN, [], { cwd, env: Object.assign({}, process.env, { APP_MODE: 'sandbox' }) }, 'gateway');
	fs.writeFileSync(MOCK_LOG, '');
	child('node', ['dev/mockllm.mjs', String(MOCK_PORT)], { cwd: TREE, env: Object.assign({}, process.env, { DAIMOND_MOCK_LOG: MOCK_LOG }) }, 'mock');
	child('node', ['dev/serve.mjs'], { cwd: TREE, env: Object.assign({}, process.env, { DAIMOND_PORT: String(PORT), DAIMOND_GW_PORT: String(GW_PORT) }) }, 'serve');
	let gwUp = false;
	for (let i = 0; i < 60 && !gwUp; i++) {
		try { gwUp = (await fetch(`http://127.0.0.1:${GW_PORT}/api/health`)).ok; } catch (e) { /* not yet */ }
		if (!gwUp) await sleep(500);
	}
	if (!gwUp) throw new Error('the gateway did not come up on ' + GW_PORT);
	if (!(await waitPort(MOCK_PORT)) || !(await waitPort(PORT))) throw new Error('the mock or the app server did not come up');
	const b = await (await fetch(APP + '/build.json', { cache: 'no-store' })).json().catch(() => ({}));
	return b.build || '';
}

// ── The devices ──
const DEV = {
	A: { key: 'A', label: 'desktop A', viewport: { width: 1400, height: 900 } },
	G: { key: 'G', label: 'desktop G', viewport: { width: 1400, height: 900 } },
	P: { key: 'P', label: 'phone P', viewport: { width: 390, height: 844 }, mobile: true, ua: IPHONE },
};
for (const d of Object.values(DEV)) Object.assign(d, { profile: path.join(ROOT, 'pw-' + d.key), ctx: null, tab: null, resps: [] });
const ALL = () => Object.values(DEV);

function wire(d, page) {
	const t = { page, errs: [] };
	page.on('pageerror', (e) => t.errs.push('pageerror: ' + e.message));
	page.on('console', (m) => { if (m.type() === 'error') t.errs.push(m.text()); });
	page.on('crash', () => t.errs.push('PAGE CRASHED'));
	page.on('dialog', (dl) => { dl.dismiss().catch(() => {}); });
	page.setDefaultTimeout(30000);
	page.setDefaultNavigationTimeout(90000);
	t.s = { page, errs: t.errs, logs: [], net: [], name: ACCOUNT };
	d.tab = t;
	return t;
}
async function launch(d) {
	const env = cleanDisplayEnv(process.env);
	delete env.DISPLAY;
	fs.mkdirSync(d.profile, { recursive: true });
	d.ctx = await chromium.launchPersistentContext(d.profile, {
		executablePath: CHROME, headless: false, env, viewport: d.viewport, hasTouch: !!d.mobile,
		args: ['--no-sandbox', '--headless=new'],
		...(d.ua ? { userAgent: d.ua, isMobile: true } : {}),
	});
	d.ctx.on('response', (r) => {
		let u; try { u = new URL(r.url()); } catch (e) { return; }
		if (!u.pathname.startsWith('/api')) return;
		d.resps.push({ t: Date.now(), k: r.request().method() + ' ' + u.pathname + ' ' + r.status() });
	});
	await d.ctx.addInitScript(() => {
		try { localStorage.setItem('daimond-policy', JSON.stringify({ v: 1, expire: 3650, retain: 30, high: 30 })); }
		catch (e) { /* private mode */ }
	});
	const page = d.ctx.pages()[0] || await d.ctx.newPage();
	wire(d, page);
	await page.goto(APP, { waitUntil: 'domcontentloaded' });
	return d.tab;
}
const E = (t, fn, a) => t.page.evaluate(fn, a);
const ready = (t, ms = 90000) => t.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondCore
	&& window.DaimondGateway && DaimondGateway.state().authed), null, { timeout: ms }).then(() => true).catch(() => false);
async function signIn(t) { await signInAs(t.s, ACCOUNT); return ready(t); }

async function closeOverlays(t) {
	await E(t, () => {
		const shown = (e) => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
		const x = document.getElementById('admin-close');
		if (shown(x)) x.click();
		const m = document.querySelector('.modal.dlg:not([hidden]) .dlg-cancel, .tile-dlg .tile-dlg-x');
		if (m && shown(m)) m.click();
	}).catch(() => {});
	await t.page.keyboard.press('Escape').catch(() => {});
	await sleep(200);
}
const focusChat = (t) => E(t, () => { try { const f = DaimondAttach.focus(); return f && f.kind === 'chat' ? String(f.id) : ''; } catch (e) { return ''; } });
async function phoneChat(t) {
	await closeOverlays(t);
	const before = await focusChat(t);
	await E(t, () => document.getElementById('new-session-btn').click());
	await sleep(700);
	await E(t, () => { const s = document.querySelector('.tile-start') || document.querySelector('.pending-centre .empty-new-session'); if (s) s.click(); });
	await t.page.waitForSelector('#chat-input', { state: 'visible', timeout: 15000 });
	await sleep(300);
	const after = await focusChat(t);
	if (!after || after === before) throw new Error('the phone made no new chat');
	return after;
}
/// Send the composer's text without waiting for the turn.
async function sendTurn(t, text) {
	await closeOverlays(t);
	await t.page.waitForSelector('#chat-input', { timeout: 20000 });
	await t.page.fill('#chat-input', text);
	await E(t, () => document.getElementById('chat-send').click());
	await sleep(500);
}
async function rename(t, cid, name) {
	await closeOverlays(t);
	await E(t, (id) => document.querySelector('.chat-box[data-id="' + id + '"] .tile-cog').click(), cid);
	await t.page.waitForSelector('.tile-dlg-name-input', { timeout: 8000 });
	await t.page.fill('.tile-dlg-name-input', name);
	await E(t, () => { const i = document.querySelector('.tile-dlg-name-input'); i.dispatchEvent(new Event('change')); });
	await sleep(200);
	const made = Date.now();
	await t.page.keyboard.press('Escape').catch(() => {});
	return made;
}

// ── What a device holds and has logged ──
const rowsOf = (t, cid) => E(t, async (cid) => {
	const got = await DaimondCore.chatStore().loadMessages(cid).catch(() => null);
	return ((got && got.messages) || []).filter((m) => m && m.mid && !m.why).map((m) => ({
		mid: String(m.mid), ts: +m.ts || 0, role: m.role, prov: !!m.provisional,
		text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
	}));
}, cid).catch(() => []);
const nameOf = (t, cid) => E(t, (cid) => { const c = DaimondCore.chatStore().stored().find((x) => x && x.id === cid); return c ? c.name || '' : null; }, cid).catch(() => null);
const arrivals = (t) => E(t, () => (window.DEBUG_SHARE && DEBUG_SHARE._arrivals) ? DEBUG_SHARE._arrivals() : null).catch(() => null);
const clearRings = (d) => E(d.tab, () => { if (window.DEBUG_SHARE && DEBUG_SHARE._arrivalsClear) DEBUG_SHARE._arrivalsClear(); }).catch(() => {});
const quiet = (t) => E(t, () => DaimondSync.state().quiet).catch(() => false);

/// Wait until A holds the finished turn: the mock's last words, then no new row for three seconds.
async function turnDone(cid, ms = 90000) {
	let last = -1, since = Date.now();
	for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
		const rows = await rowsOf(DEV.A.tab, cid);
		const done = rows.some((r) => r.role === 'assistant' && !r.prov && DONE_RE.test(r.text));
		if (rows.length !== last) { last = rows.length; since = Date.now(); }
		if (done && Date.now() - since > 3000) return rows;
		await sleep(500);
	}
	return null;
}

/// One rep of a scenario: the origin's rows, the renames made, and what each viewer logged and held.
async function rep(scn, n) {
	const A = DEV.A, P = DEV.P;
	for (const d of ALL()) await clearRings(d);
	for (const d of ALL()) for (let i = 0; i < 20 && !(await quiet(d.tab)); i++) await sleep(500);
	const t0 = Date.now();
	let cid = '';
	const renames = [];
	if (scn === 'S1') {
		cid = await newChat(A.tab.s);
		await sendTurn(A.tab, TURN);
		for (let i = 0; i < RENAMES; i++) {
			const name = `lat-${n}-${i}`;
			const made = await rename(A.tab, cid, name);
			renames.push({ name, made });
			if (i < RENAMES - 1) await sleep(RENAME_GAP);
		}
	} else {
		for (const x of [A]) await E(x.tab, () => { try { DaimondSync.beatPresence(DaimondIdentity.deviceId(), ''); } catch (e) { /* none */ } }).catch(() => {});
		await E(P.tab, () => DaimondSync.refreshPresence && DaimondSync.refreshPresence()).catch(() => {});
		await sleep(1200);
		cid = await phoneChat(P.tab);
		await sendTurn(P.tab, TURN);
	}
	const origin = await turnDone(cid);
	if (!origin) console.log(`${at()} ${scn} rep ${n}: the turn did not finish on A`);
	// Give each viewer time to hold the last row (and, in S1, the last name).
	const final = origin ? Math.max(0, ...origin.filter((r) => r.role !== 'user').map((r) => r.ts)) : 0;
	const lastName = renames.length ? renames[renames.length - 1].name : '';
	const viewers = {};
	for (const k of ['G', 'P']) {
		const v = DEV[k];
		// Waited for on the viewer's RING, not its store: reading a transcript (`loadMessages`) can itself
		// pull the rows out of the chunk store ahead of the parcel merge, which would hide the arrival
		// being measured. The store is read once, below, after the wait.
		const need = origin ? origin.filter((r) => r.role !== 'user').map((r) => r.mid) : [];
		for (const t1 = Date.now(); Date.now() - t1 < SETTLE; ) {
			const ring = ((await arrivals(v.tab)) || []).filter((r) => r.at >= t0 && (!r.cid || r.cid === cid));
			const seen = new Set(ring.filter((r) => r.k === 'tile').map((r) => String(r.mid)));
			const has = !!origin && need.every((m) => seen.has(m)) && ring.some((r) => r.k === 'commit' && r.made >= final);
			const named = !lastName || (await nameOf(v.tab, cid)) === lastName;
			if (has && named) break;
			await sleep(500);
		}
		const held = await rowsOf(v.tab, cid);
		const ring = ((await arrivals(v.tab)) || []).filter((r) => r.at >= t0 && (!r.cid || r.cid === cid));
		const want = (origin || []).filter((r) => !(scn === 'S2' && r.role === 'user' && k === 'P'));
		const inRing = new Set(ring.filter((r) => r.k === 'tile').map((r) => String(r.mid)));
		const heldMids = new Set(held.filter((r) => !r.prov).map((r) => r.mid));
		const edits = ring.filter((r) => r.k === 'edit');
		const commits = ring.filter((r) => r.k === 'commit' && r.made >= final);
		viewers[k] = {
			tiles: ring.filter((r) => r.k === 'tile'),
			edits,
			commit: commits.length ? Math.min(...commits.map((r) => r.at)) - final : null,
			commitVia: commits.length ? commits.sort((a, b) => a.at - b.at)[0].via : null,
			rows: want.length,
			gap: want.filter((r) => !inRing.has(r.mid) && heldMids.has(r.mid)).length,		// held, never logged
			lost: want.filter((r) => !heldMids.has(r.mid)).length,							// never held at all
			editsDistinct: new Set(edits.map((r) => r.made)).size,
			named: (await nameOf(v.tab, cid)) === lastName || !lastName,
		};
	}
	console.log(`${at()} ${scn} rep ${n}: chat ${cid.slice(0, 8)}, ${origin ? origin.length : 0} rows on A, `
		+ ['G', 'P'].map((k) => `${k}: tiles ${viewers[k].tiles.length}, edits ${viewers[k].edits.length}/${renames.length}, commit ${fmtMs(viewers[k].commit)}, gap ${viewers[k].gap}, lost ${viewers[k].lost}`).join('; '));
	return { scn, n, cid, renames, ranOnA: !!origin, final, viewers };
}

// ═════════════════════════════════════════════════════════════════
const CHECKS = [];
const check = (kind, name, pass, detail) => {
	CHECKS.push({ kind, name, pass: !!pass, detail: detail || '' });
	console.log(`  ${pass ? 'ok  ' : 'RED '} [${kind}] ${name}${detail ? ' -- ' + detail : ''}`);
};
let exitCode = 0, served = '';
const REPS_OUT = [];
try {
	served = await startWorld();
	console.log(`latency run ${RUN}: world ${WORLD}, build ${served}, gateway ${GW_BIN}, ${REPS} rep(s) of each scenario`);
	const A = DEV.A;
	await launch(A);
	if (!(await signIn(A.tab))) throw new Error('A did not sign in');
	const pro = await makePagePro(A.tab.page, path.join(TREE, 'gateway'), `http://127.0.0.1:${GW_PORT}`);
	if (pro.pro !== true) throw new Error('the account does not hold Pro: ' + J(pro));
	await connectMock(A.tab.s);
	for (const k of ['G', 'P']) {
		const d = DEV[k];
		await launch(d);
		await d.tab.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 120000 }).catch(() => {});
		const code = await E(A.tab, () => DaimondPairing.create());
		const red = await E(d.tab, (c) => DaimondPairing.redeem(c).then(() => 'ok', (e) => 'err: ' + e.message), code && code.code);
		if (red !== 'ok') throw new Error(`${d.label} did not pair: ${red}`);
		await d.tab.page.reload({ waitUntil: 'domcontentloaded' });
		if (!(await signIn(d.tab))) throw new Error(`${d.label} did not sign in`);
		await connectMock(d.tab.s);
	}
	for (const d of ALL()) {
		const has = await arrivals(d.tab);
		if (has === null) throw new Error(`${d.label} has no DEBUG_SHARE._arrivals: this tree's arrive seam is not served`);
	}
	await sleep(3000);
	for (const scn of ['S1', 'S2']) for (let n = 1; n <= REPS; n++) REPS_OUT.push(await rep(scn, n));
} catch (e) {
	console.log('the run failed: ' + String(e && e.stack || e).split('\n').slice(0, 4).join(' | '));
	exitCode = 2;
} finally {
	for (const d of ALL()) { try { await d.ctx?.close(); } catch (e) { /* gone */ } }
	killAll();
	if (!KEEP) {
		await sleep(1500);
		for (const d of ALL()) fs.rmSync(d.profile, { recursive: true, force: true });
		fs.rmSync(path.join(ROOT, 'gwcwd'), { recursive: true, force: true });
	}
}

// ── The judgement ──
const RESULT = { run: RUN, world: WORLD, build: served, gateway: GW_BIN, reps: REPS, targets: TARGETS, pairs: [], f409: {}, checks: CHECKS };
if (REPS_OUT.length) {
	console.log('\n══ latency, per scenario and viewer (origin A; one host clock)');
	for (const scn of ['S1', 'S2']) {
		for (const k of ['G', 'P']) {
			const rs = REPS_OUT.filter((r) => r.scn === scn);
			if (!rs.length) continue;
			const tile = summarise(rs.flatMap((r) => r.viewers[k].tiles));
			const edit = summarise(rs.flatMap((r) => r.viewers[k].edits));
			const cm = rs.map((r) => r.viewers[k].commit);
			const commit = summarise(cm.filter((x) => x !== null).map((ms) => ({ ms })));
			const miss = cm.filter((x) => x === null).length;
			const gap = rs.reduce((a, r) => a + r.viewers[k].gap, 0), lost = rs.reduce((a, r) => a + r.viewers[k].lost, 0);
			const rows = rs.reduce((a, r) => a + r.viewers[k].rows, 0);
			const renames = rs.reduce((a, r) => a + r.renames.length, 0);
			const via = scn === 'S2' && k === 'P' ? 'frame' : 'parcel';
			const pair = { scn, pair: `A->${k}`, via, tile, edit: scn === 'S1' ? edit : null, commit: { ...commit, missing: miss, of: cm.length },
				rows, gap, lost, renames: scn === 'S1' ? renames : 0, editsDistinct: rs.reduce((a, r) => a + r.viewers[k].editsDistinct, 0) };
			RESULT.pairs.push(pair);
			const tag = `${scn} A->${k} (${via})`;
			const jt = judge('tile', tile);
			check('L1 tile', `${tag}: P50 ${fmtMs(tile.p50)} (<= 2 s), P90 ${fmtMs(tile.p90)} (<= 4 s), n=${tile.n}`, jt.pass, jt.why.join('; '));
			if (scn === 'S1') {
				const je = judge('edit', edit);
				check('L2 edit', `${tag}: P50 ${fmtMs(edit.p50)} (<= 2 s), P90 ${fmtMs(edit.p90)} (<= 5 s), ${pair.editsDistinct} of ${renames} renames seen`, je.pass, je.why.join('; '));
			}
			const jc = judge('commit', commit);
			check('L3 commit', `${tag}: P90 ${fmtMs(commit.p90)} (<= 5 s) over ${cm.length} turn(s)`, jc.pass && !miss, [...jc.why, miss ? `${miss} turn(s) never committed on the viewer` : ''].filter(Boolean).join('; '));
			console.log(`       ${tag}: ${rows} origin rows; never logged by the viewer (instrument gap) ${gap}; never held ${lost}; skew ${tile.skew + edit.skew}`);
			check('lost', `${tag}: every row of the turn is held on the viewer at the end`, lost === 0, lost ? `${lost} of ${rows} never held` : '');
		}
	}
	for (const d of ALL()) {
		const n = d.resps.filter((r) => /\/api\/sync /.test(r.k) && / 409$/.test(r.k)).length;
		RESULT.f409[d.key] = n;
		check('L5 409', `${d.label}: 409s from /api/sync over the run`, n === TARGETS.f409, `${n}`);
	}
}
const red = CHECKS.filter((c) => !c.pass);
RESULT.summary = `latency ${RUN}: ${CHECKS.length} checks, ${red.length} red`;
const outFile = JSON_OUT || path.join(ROOT, 'latency.json');
fs.writeFileSync(outFile, JSON.stringify(RESULT, null, 1));
console.log(`\n══ ${RESULT.summary}${exitCode === 2 ? ' (the run did not complete)' : ''}\nrecord: ${outFile}`);
process.exit(exitCode || (red.length ? 1 : 0));
