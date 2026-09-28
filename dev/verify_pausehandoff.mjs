// gateway: own
// verify_pausehandoff.mjs -- a typed turn under a pause, and the press that lifts it (R53-U8, U8b).
//
// THE INVARIANT. A turn a person sends is answered for exactly once in the transcript: run, handed on,
// or refused in words for a hold the account holds when the refusal is made -- never dropped with no
// row, never refused for a hold one bounded read would have shown lifted, never run under a hold. And
// nothing a person typed is cleared from the composer unless it was sent or they cleared it.
//
// A phone (A) and a desktop (B), paired, on a fresh gateway (the tree's binary). Sections, each on its
// own fresh chat, each leaving the account playing:
//
//   A  play landed, the phone's hold stale, the confirming read lands: the turn runs once.
//   E  the same with the read slower than its cap: refused in words, bounded, nothing run later.
//   C  really paused: refused in words, no model, no errand.
//   F  words typed into the box during the confirming read are kept, not cleared unsent (QU8 Q1).
//   G  Send twice during the confirming read (G1) and during the nominee's refresh (G2): one run (Q2).
//   B  a pause lands between the send's first question and its commit: refused in words at the commit.
//   K  a hand-off turned away before its mark (a throw) is said in words; one refused at the post is
//      recovered here with no extra line.
//   H  the runner refuses the errand for a pause: the phone's tile says paused, not "couldn't finish" (Q3).
//   R  Retry on the phone with its hold stale: confirmed, and run (Q4).
//   L  every press lets the Send control go: Edit & resend on the phone of a question's answer (which
//      opens the question again and runs nothing) and of an ordinary turn (which runs once) (U8c).
//   X  another door into the one send (the phone sheet's Ask) while a press waits in the nominee's refresh:
//      it waits its turn and goes, and it never writes the box, where the person's own words stay (QU8b QB1).
//   Y  a press whose conversation is left in its confirming read goes on to that conversation (QU8b QB2).
//   D  a press on the desktop reaches the phone well inside the old 2.5 s debounce.
//
// Each mechanism has a break that reddens its section and no other:
//   --break noconfirm   the composer's confirming read skipped              A
//   --break clearsall   the composer cleared whole at the commit            F
//   --break nosendguard a second press is not turned away                    G
//   --break noreask     the commit's second question removed               B
//   --break nosay       a hand-off refused before its mark is not said      K
//   --break runnerpause the runner's report names no pause                  H
//   --break staledoor   Retry's refusal is not confirmed                    R
//   --break debounce    a press waits for the push debounce                  D
//   --break letgo       a press that runs nothing is held as if a turn would  L
//   --break doorwait    another door is turned away while a press is in flight X
//   --break doorbox     another door writes its words into the box            X
//   --break leftcancel  a press whose conversation was left is dropped         Y
//
//   eval "$(bash dev/world.sh <N> --env)"
//   node dev/verify_pausehandoff.mjs [--only A,F,...] [--break <name>]
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { open, chat, signInAs, newChat, connectMock, mockLog, SCRATCH } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import { GWBIN, requireFreshGateway } from './gwbin.mjs';
import { checker, storedMsgs, placeholders, send, freshChat, settle, until } from './handoffpair.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TREE = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BREAK = arg('--break', '');
const ONLY = arg('--only', 'A,E,C,F,G,B,K,H,R,L,X,Y,D').split(',').map((s) => s.trim()).filter(Boolean);
const PORT = Number(process.env.DAIMOND_PORT || 0), GW_PORT = Number(process.env.DAIMOND_GW_PORT || 0);
const MOCK_PORT = Number(process.env.DAIMOND_MOCK_PORT || 0), MOCK_LOG = process.env.DAIMOND_MOCK_LOG || '';
if (!PORT || !GW_PORT || !MOCK_PORT || !MOCK_LOG) {
	console.log('refusing to run: eval "$(bash dev/world.sh <N> --env)" first.');
	process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
const RUN = Date.now().toString(36);
const ROOT = path.join(SCRATCH, 'verify_pausehandoff', RUN);
fs.mkdirSync(ROOT, { recursive: true });

// ── The stack: a fresh gateway (the tree's own binary, checked fresh), the mock, the app ──
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
	s.once('connect', () => { s.destroy(); res(true); });
	s.once('error', () => res(false));
});
async function waitPort(port, ms = 30000) {
	for (const t0 = Date.now(); Date.now() - t0 < ms; ) { if (await listening(port)) return true; await sleep(200); }
	return false;
}
// A `gateway: own` verifier starts only the gateway: `dev/run_all.sh` runs it in phase 1 with the world's app
// server and mock up and the gateway port clear, as every other `own` verifier expects (`verify_noopfs`). Until
// U8c this one refused a world that was up, so under the suite it failed in its first second. Run alone, with
// the world down, it starts the app and the mock itself. A server that is up must be serving THIS tree.
async function stack() {
	if (await listening(GW_PORT)) throw new Error('port ' + GW_PORT + ' is taken: this verifier starts its own gateway there');
	const appUp = await listening(PORT), mockUp = await listening(MOCK_PORT);
	if (appUp) {
		const served = await fetch(`http://127.0.0.1:${PORT}/js/daimond.js`).then((r) => r.text()).catch(() => '');
		if (served !== fs.readFileSync(path.join(TREE, 'www/js/daimond.js'), 'utf8')) {
			throw new Error('the app server on ' + PORT + ' is not serving this tree (' + TREE + ')');
		}
	}
	const cwd = path.join(ROOT, 'gwcwd');
	fs.mkdirSync(cwd, { recursive: true });
	execFileSync('bash', ['dev/devgw.sh'], { cwd: TREE, env: Object.assign({}, process.env, { DAIMOND_GW_PORT: String(GW_PORT) }) });
	fs.copyFileSync(path.join(TREE, 'dev/devgw/app.jdat'), path.join(cwd, 'app.jdat'));
	fs.symlinkSync(fs.realpathSync(path.join(TREE, 'gateway/keys')), path.join(cwd, 'keys'));
	child(GWBIN, [], { cwd, env: Object.assign({}, process.env, { APP_MODE: 'sandbox' }) }, 'gateway');
	// The world's mock writes the same file (`connectMock` asks it), so the log starts empty either way.
	fs.writeFileSync(MOCK_LOG, '');
	if (!mockUp) child('node', ['dev/mockllm.mjs', String(MOCK_PORT)], { cwd: TREE, env: Object.assign({}, process.env, { DAIMOND_MOCK_LOG: MOCK_LOG }) }, 'mock');
	if (!appUp) child('node', ['dev/serve.mjs'], { cwd: TREE, env: Object.assign({}, process.env, { DAIMOND_PORT: String(PORT), DAIMOND_GW_PORT: String(GW_PORT) }) }, 'serve');
	for (let i = 0; i < 60; i++) {
		try { const r = await fetch(`http://127.0.0.1:${GW_PORT}/api/health`); if (r.ok) break; } catch (e) { /* not yet */ }
		await sleep(500);
	}
	if (!(await waitPort(MOCK_PORT)) || !(await waitPort(PORT))) throw new Error('the stack did not come up');
}

// ── The breaks: the page is served edited copies of its own files ──────────
const BREAKS = {
	noconfirm: [{ file: 'js/daimond.js', find: '\t\t\tawait confirmHold(target);\n', with: '' }],
	clearsall: [{ file: 'js/daimond.js',
		find: "\t\t\tif (!w || s.indexOf(w) !== 0) return String(v || '');\t\t// edited since: all of it stays\n",
		with: "\t\t\treturn '';\n" }],
	nosendguard: [{ file: 'js/daimond.js',
		find: '\t\t\tif (!own) return;\n', with: '' }],
	noreask: [{ file: 'js/daimond.js',
		find: '\t\t\tif (turnHold(chat)) return false;\n\t\t\t// Prepared exactly as the explicit path',
		with: '\t\t\t// Prepared exactly as the explicit path' }],
	nosay: [{ file: 'js/daimond.js',
		find: '.then(function (r) { if (!r || !r.ok) sayIfUnhanded(chat, umid, r); },',
		with: '.then(function (r) { },' }, { file: 'js/daimond.js',
		find: "function (e) { sayIfUnhanded(chat, umid, { ok: false, why: String((e && e.message) || e) }); });",
		with: 'function (e) { });' }],
	runnerpause: [{ file: 'js/peer.js',
		find: "\t\t\t\t\tpaused: String(ph.node || 'root') }));", with: '\t\t\t\t\t}));' }],
	staledoor: [{ file: 'js/daimond.js',
		find: '\t\t\t\tif (hold && opts.person && !opts.holdRead) {', with: '\t\t\t\tif (false) {' }],
	letgo: [{ file: 'js/daimond.js',
		find: '\t\t\tif (went !== true) { press.handed = true; Promise.resolve(went).then(press.release, press.release); }\n',
		with: '\t\t\tpress.handed = true; if (went !== true) Promise.resolve(went).then(press.release, press.release);\n' }],
	doorwait: [{ file: 'js/daimond.js',
		find: '\t\t\twhile (target._sending) await target._sent;\n', with: '\t\t\treturn;\n' }],
	doorbox: [{ file: 'js/daimond.js',
		find: "\t\t\tsendUserMessage(String(text || ''));\n", with: '\t\t\tchatInput.value = text;\n\t\t\tsendUserMessage();\n' }],
	leftcancel: [{ file: 'js/daimond.js',
		find: '\t\t\tawait confirmHold(target);\n\t\t\tholdRead = true;\n',
		with: '\t\t\tawait confirmHold(target);\n\t\t\tholdRead = true;\n\t\t\tif (current !== target) return;\n' }],
	debounce: [{ file: 'js/sync.js',
		find: '\t\tif (inFlight) { pressOwed = true; schedule(); return; }\n\t\tpush();\n',
		with: '\t\tschedule();\n' }],
};
if (BREAK && !BREAKS[BREAK]) {
	console.log(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}
/// A route serving the break's edited files to a page, or null with no break.
function breakRoute() {
	if (!BREAK) return null;
	const files = new Map();
	for (const b of BREAKS[BREAK]) {
		const src = files.get(b.file) ?? fs.readFileSync(path.join(TREE, 'www', b.file), 'utf8');
		const n = src.split(b.find).length - 1;
		if (n !== 1) {
			console.log(`break '${BREAK}': its anchor appears ${n} times in ${b.file}, so nothing was changed and this run would prove nothing`);
			process.exit(2);
		}
		files.set(b.file, src.replace(b.find, b.with));
	}
	return async (page) => {
		for (const [f, body] of files) {
			await page.route((u) => u.pathname.endsWith('/' + f), (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
		}
	};
}

async function gateUp(s) {
	await s.page.waitForFunction(() => {
		const btn = document.getElementById('id-primary');
		if (btn && btn.offsetParent !== null) return true;
		try { return !!window.__DAIMOND_READY && window.DaimondIdentity.isUnlocked(); } catch (e) { return false; }
	}, null, { timeout: 90000 }).catch(() => {});
}

/// handoffpair's `pair`, with a route for either device before its first navigation (the break's files).
async function pairWith(check, lead, mate, routeA, routeB) {
	const a = await open({ name: lead, touch: true, signIn: false, connect: false, route: routeA || null });
	a.account = lead; a.name = lead; a.touch = true;
	await gateUp(a);
	await signInAs(a, lead);
	await a.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
		&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	const pro = await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('A holds Pro', pro.pro === true, J(pro));
	await connectMock(a);
	await newChat(a);
	await chat(a, 'seed turn so the account has a chat and a parcel');
	await settle(a.page);
	const b = await open({ name: mate, signIn: false, connect: false, route: routeB || null });
	b.account = lead; b.name = mate;
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 90000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await gateUp(b);
	await signInAs(b, lead);
	await b.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
		&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await makePagePro(b.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(b);
	await b.page.waitForTimeout(2000);
	await settle(b.page);
	await until(b.page, () => { try { return window.DaimondPost.state().parks > 0; } catch (e) { return false; } }, null, 8000);
	await b.page.evaluate((n) => window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), n), mate);
	await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(1500);
	const idA = await a.page.evaluate(() => window.DaimondIdentity.deviceId());
	const idB = await b.page.evaluate(() => window.DaimondIdentity.deviceId());
	const aSeesB = await a.page.evaluate((self) => (window.DaimondPresence.awake(self, Date.now()) || []).length, idA);
	check('A sees B as an awake peer', aSeesB >= 1, 'awake peers: ' + aSeesB);
	return { a, b, idA, idB };
}

// ── Reading and pressing ───────────────────────────────────────────────────
const paused = (pg) => pg.evaluate(() => DaimondPause.isPaused(DaimondPause.ROOT)).catch((e) => 'err ' + e);
/// Press the global control: the desktop's widget button; the phone (whose widget sits in a drawer) through
/// the same door the widget calls, `DaimondPause.set`.
async function press(pg, play, viaWidget = true) {
	const t = Date.now();
	if (viaWidget) {
		const sel = '#pptw-global .pptw-' + (play ? 'play' : 'pause');
		const okClick = await pg.click(sel, { timeout: 3000 }).then(() => true).catch(() => false);
		if (okClick) return t;
	}
	await pg.evaluate((p) => DaimondPause.set(DaimondPause.ROOT, p), play);
	return t;
}
async function reads(pg, want, from, ms = 30000) {
	for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
		if ((await paused(pg)) === want) return Date.now() - from;
		await sleep(100);
	}
	return -1;
}
async function turnRows(s, tag) {
	const ms = await storedMsgs(s);
	const i = ms.findIndex((m) => m.role === 'user' && String(m.content || '').includes(tag));
	if (i < 0) return { prompt: false, rows: [] };
	const it = String(ms[i].iturn || ms[i].mid || '');
	// The turn's own rows (its iturn), and a refusal line written after the prompt and before the next
	// prompt: `runTurn`'s refusal row carries no iturn (daimond.js `failRole` rows).
	let nextUser = ms.findIndex((m, j) => j > i && m.role === 'user');
	if (nextUser < 0) nextUser = ms.length;
	const rows = ms.filter((m, j) => j > i && (String(m.iturn || '') === it
		|| (j < nextUser && !m.iturn && (m.role === 'note_log' || m.role === 'error_log'))))
		.map((m) => ({ role: m.role, why: m.why || '', refused: m.refused ? String(m.refused.why || '').slice(0, 60) : '',
			report: m.report ? String(m.report.status || m.report.why || J(m.report)).slice(0, 60) : '',
			keys: m.why === 'dispatched' ? Object.keys(m).filter((k) => !['content', 'itext', 'mid', 'iturn', 'ts', 'role'].includes(k)).join(',') : '',
			c: String(m.content || '').slice(0, 100) }));
	const prompts = ms.filter((m) => m.role === 'user' && String(m.content || '').includes(tag)).length;
	return { prompt: true, prompts, rows };
}
const ran = (tag) => mockLog().filter((r) => {
	const ms = r.messages || [];
	const last = ms[ms.length - 1];
	return last && last.role === 'user' && JSON.stringify(last.content).includes(tag);
}).length;
const ranText = (tag) => mockLog().map((r) => { const ms = r.messages || []; const l = ms[ms.length - 1]; return l && l.role === 'user' ? JSON.stringify(l.content) : ''; })
	.filter((x) => x.includes(tag));
/// Count a page's requests of `method` to a path, from now.
function counter(page, method, pathRe) {
	let n = 0;
	const h = (req) => { try { const u = new URL(req.url()); if (req.method() === method && pathRe.test(u.pathname) && !u.search.includes('presence')) n++; } catch (e) { /* none */ } };
	page.on('request', h);
	return { n: () => n, stop: () => page.off('request', h) };
}
/// The phone's mailbox reads (GET /api/sync, not the presence reads) made to do `mode`: 'delay' ms, 'abort', '503'.
async function syncGet(page, mode, ms) {
	const match = (u) => u.pathname === '/api/sync' && !u.search.includes('presence');
	const h = async (route) => {
		const req = route.request();
		if (req.method() !== 'GET') return route.continue();
		if (mode === 'delay') { await sleep(ms); return route.continue().catch(() => {}); }
		if (mode === 'abort') return route.abort('connectionrefused').catch(() => {});
		return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }).catch(() => {});
	};
	await page.route(match, h);
	return () => page.unroute(match, h).catch(() => {});
}
async function waitRows(a, tag, pred, ms = 20000) {
	const t0 = Date.now();
	let r = await turnRows(a, tag);
	while (Date.now() - t0 < ms && !pred(r)) { await sleep(250); r = await turnRows(a, tag); }
	return r;
}
const saysPaused = (r) => r.rows.some((x) => /paused/i.test(x.c) || /paused/i.test(x.refused));
/// Wait until the model has been reached `n` times for `tag`.
async function waitRuns2(tag, n, ms = 30000) {
	let got = ran(tag);
	for (const t0 = Date.now(); Date.now() - t0 < ms && got < n; ) { await sleep(500); got = ran(tag); }
	return got;
}
async function waitRuns(tag, ms = 30000) {
	let n = 0;
	for (const t0 = Date.now(); Date.now() - t0 < ms && !n; ) { await sleep(500); n = ran(tag); }
	return n;
}

/// Everyone playing, wakes on, nothing routed.
async function allPlay(a, b) {
	await a.page.evaluate(() => DaimondSync.wakeVia('')).catch(() => {});
	if ((await paused(b.page)) !== false) await press(b.page, true);
	if ((await paused(a.page)) !== false) await press(a.page, true, false);
	await reads(a.page, false, Date.now(), 20000);
	await reads(b.page, false, Date.now(), 20000);
	await settle(a.page); await settle(b.page);
	await sleep(1500);
}
/// The phone's hold made stale: Pause all on the desktop, read by the phone; the phone's wake shut; play on the
/// desktop landed on the mailbox; the phone still reads paused.
async function staleHold(check, a, b, label) {
	const tP = await press(b.page, false);
	const r = await reads(a.page, true, tP);
	await settle(b.page);
	await a.page.evaluate(() => DaimondSync.wakeVia('off'));
	const v0 = await b.page.evaluate(() => DaimondSync.version());
	await press(b.page, true);
	const landed = await until(b.page, (v) => DaimondSync.version() > v && DaimondSync.state().quiet, v0, 20000);
	const still = await paused(a.page);
	const set = r >= 0 && landed && still === true;
	check(label + ' ctl: the race is set (the play landed, the phone still reads paused)', set, J({ read: r, landed, still }));
	return set;
}
/// Really paused: Pause all on the desktop, read by the phone.
async function reallyPaused(check, a, b, label) {
	const t = await press(b.page, false);
	const r = await reads(a.page, true, t);
	await settle(b.page);
	check(label + ' ctl: the phone reads the pause', r >= 0, r + ' ms');
	await sleep(1000);
}

const { ok, bad, check } = checker();
let exitCode = 0;
const S = (x) => ONLY.includes(x);
const diagRows = (pg, re) => pg.evaluate((src) => {
	try { const r = new RegExp(src); return DaimondDiag.rows().filter((x) => r.test(x.tag)).map((x) => x.tag + ' | ' + String(x.data || '').slice(0, 140)); }
	catch (e) { return []; }
}, re.source);
try {
	requireFreshGateway();
	await stack();
	const route = breakRoute();
	console.log(`verify_pausehandoff: tree ${TREE}, run ${RUN}, break=${BREAK || 'none'}, sections=${ONLY.join('')}`);
	const acct = 'vph' + RUN;
	const { a, b, idB } = await pairWith(check, acct, acct + 'desk', route, route);
	const postsA = counter(a.page, 'POST', /^\/api\/post$/);
	await b.page.setViewportSize({ width: 1500, height: 950 });
	for (const s of [a, b]) await s.page.evaluate(() => { try { DaimondDiag.set(true, 'verify'); } catch (e) { /* none */ } });

	// ── A and E: the confirming read ──────────────────────────────────────────
	// Named `cases`, not `reads`: that name is the helper D and the controls call.
	const cases = [];
	if (S('A')) cases.push({ id: 'A', stale: true, mode: 'delay', ms: 2500, want: 'run' });
	if (S('E')) cases.push({ id: 'E', stale: true, mode: 'delay', ms: 7000, want: 'refuse' });
	if (S('C')) cases.push({ id: 'C', stale: false, mode: 'delay', ms: 0, want: 'refuse' });
	for (const c of cases) {
		console.log(`\n── ${c.id}  ${c.stale ? 'play landed, the phone\'s hold stale, the read ' + c.mode + ' ' + c.ms + ' ms' : 'really paused'}`);
		try {
			await freshChat(a);
			const set = c.stale ? await staleHold(check, a, b, c.id) : (await reallyPaused(check, a, b, c.id), true);
			if (!set) { await allPlay(a, b); continue; }
			const un = c.ms ? await syncGet(a.page, c.mode, c.ms) : async () => {};
			const tag = 'VPH-' + c.id;
			const p0 = postsA.n();
			const t0 = Date.now();
			await send(a.page, '@text ' + tag + ' typed under a pause');
			await waitRows(a, tag, (x) => x.rows.length > 0 || ran(tag) > 0, 15000);
			const tSaid = Date.now() - t0;
			await sleep(c.want === 'run' ? 12000 : 3000);
			await un();
			if (c.want === 'refuse') { await a.page.evaluate(() => DaimondSync.wakeVia('')); await sleep(8000); }
			const runs = ran(tag), r = await turnRows(a, tag), errands = postsA.n() - p0;
			console.log(`  note ${c.id}: answered in ${tSaid} ms; runs ${runs}; errands ${errands}; rows ${J(r.rows)}`);
			if (c.want === 'run') {
				check(`${c.id}: the read brings the play in, so the turn runs once`, runs === 1, J({ runs, rows: r.rows }));
				check(`${c.id}: and is not refused for the pause already ended`, !saysPaused(r), J(r.rows));
			} else {
				check(`${c.id}: no model is reached, then or later`, runs === 0, 'runs ' + runs);
				check(`${c.id}: and no errand`, errands === 0, 'errands ' + errands);
				check(`${c.id}: and the turn is refused in words`, saysPaused(r), J(r.rows));
				check(`${c.id}: and the send waited at most about the read's 4 s cap`, tSaid <= 6500, tSaid + ' ms');
			}
		} catch (e) { check(c.id + ' ran', false, String(e).slice(0, 200)); }
		await allPlay(a, b);
	}

	// ── F: words typed while the read is out ─────────────────────────────────
	if (S('F')) {
		console.log('\n── F  words added to the box while the confirming read is out');
		try {
			await freshChat(a);
			if (await staleHold(check, a, b, 'F')) {
				const un = await syncGet(a.page, 'delay', 3000);
				await send(a.page, '@text VPH-F first words');
				await sleep(1000);
				// The person goes on typing, after the words already sent.
				await a.page.fill('#chat-input', '@text VPH-F first words and then VPH-FMORE');
				await sleep(12000);
				await un();
				const sent = ranText('VPH-F');
				const box = await a.page.evaluate(() => document.getElementById('chat-input').value);
				console.log('  note F: the model got ' + J(sent) + '; the box holds ' + J(box));
				check('F: the words pressed are the words sent, once', sent.length === 1 && !sent[0].includes('VPH-FMORE'), J(sent));
				check('F: the words typed during the read stay in the box, and only they', box.trim() === 'and then VPH-FMORE', J(box));
			}
		} catch (e) { check('F ran', false, String(e).slice(0, 200)); }
		await allPlay(a, b);
	}

	// ── G: a second press ────────────────────────────────────────────────────
	if (S('G')) {
		console.log('\n── G  a second press of Send while the first waits');
		try {
			await freshChat(a);
			if (await staleHold(check, a, b, 'G1')) {
				const un = await syncGet(a.page, 'delay', 3000);
				await a.page.setViewportSize({ width: 420, height: 860 });
				await a.page.fill('#chat-input', '@text VPH-G1 pressed twice');
				await a.page.click('#chat-send', { force: true });
				await sleep(700);
				const pending = await a.page.evaluate(() => { const s = document.getElementById('chat-send'); return { disabled: s.disabled, label: s.getAttribute('aria-label') }; });
				// The keyboard's door, which a disabled button does not close.
				await a.page.press('#chat-input', 'Enter');
				await sleep(15000);
				await un();
				const r = await turnRows(a, 'VPH-G1');
				check('G1: while the read is out the Send control reads as sending', pending.disabled === true, J(pending));
				check('G1: a second press during the confirming read runs the turn once', ran('VPH-G1') === 1 && r.prompts === 1, J({ runs: ran('VPH-G1'), prompts: r.prompts }));
			}
		} catch (e) { check('G1 ran', false, String(e).slice(0, 200)); }
		await allPlay(a, b);
		try {
			// The nominee's presence refresh, which held the send before U8.
			await freshChat(a);
			await a.page.evaluate((id) => {
				DaimondCore.roster.nominate(id);
				window.__vphReal = { sd: DaimondPeer.nominationStandDown, rp: DaimondSync.refreshPresence };
				DaimondPeer.nominationStandDown = function () { return false; };
				DaimondSync.refreshPresence = function () {
					return new Promise((r) => setTimeout(r, 3000)).then(() => window.__vphReal.rp());
				};
			}, idB);
			await a.page.setViewportSize({ width: 420, height: 860 });
			await a.page.fill('#chat-input', '@text VPH-G2 pressed twice');
			await a.page.click('#chat-send', { force: true });
			await sleep(700);
			await a.page.press('#chat-input', 'Enter');
			await sleep(15000);
			await a.page.evaluate(() => {
				DaimondPeer.nominationStandDown = window.__vphReal.sd;
				DaimondSync.refreshPresence = window.__vphReal.rp;
				DaimondCore.roster.nominate('');
			});
			const r = await turnRows(a, 'VPH-G2');
			check('G2: a second press during the nominee\'s refresh runs the turn once, one prompt', ran('VPH-G2') === 1 && r.prompts === 1, J({ runs: ran('VPH-G2'), prompts: r.prompts }));
		} catch (e) { check('G2 ran', false, String(e).slice(0, 200)); }
		await allPlay(a, b);
	}

	// ── B: a pause lands between the first question and the commit ───────────
	if (S('B')) {
		console.log('\n── B  a pause lands inside the election');
		try {
			await freshChat(a);
			await a.page.evaluate(() => {
				const real = DaimondPeer.autoDispatchDecision;
				DaimondPeer.autoDispatchDecision = function () {
					const d = real.apply(this, arguments);
					DaimondPeer.autoDispatchDecision = real;
					try { DaimondPause.set(DaimondPause.ROOT, false); } catch (e) { /* none */ }
					return d;
				};
			});
			const p0 = postsA.n();
			await send(a.page, '@text VPH-B typed as a pause landed');
			await sleep(9000);
			const r = await turnRows(a, 'VPH-B');
			const repairs = await diagRows(a.page, /dispatch unhanded/);
			console.log('  note B rows ' + J(r.rows) + ' runs ' + ran('VPH-B') + ' errands ' + (postsA.n() - p0) + ' repairs ' + J(repairs));
			check('B: no model, no errand', ran('VPH-B') === 0 && postsA.n() === p0, J({ runs: ran('VPH-B'), errands: postsA.n() - p0 }));
			check('B: refused in words', saysPaused(r), J(r.rows));
			check('B: refused at the commit\'s own question, with no hand-off begun to repair', repairs.length === 0, J(repairs));
		} catch (e) { check('B ran', false, String(e).slice(0, 200)); }
		await allPlay(a, b);
	}

	// ── K: a hand-off turned away ────────────────────────────────────────────
	if (S('K')) {
		console.log('\n── K  a hand-off turned away before its mark, and at the post');
		const K3H = { h: null };
		const stages = [
			{ id: 'K1', what: 'before the mark (a throw)', arm: () => a.page.evaluate(() => {
				const real = DaimondPeer.buildDispatch;
				DaimondPeer.buildDispatch = function () { DaimondPeer.buildDispatch = real; throw new Error('verify: buildDispatch refused'); };
			}), runs: 0 },
			{ id: 'K3', what: 'at the post (a 403), recovered here', arm: async () => {
				let n = 0;
				K3H.h = (rt) => {
					const req = rt.request();
					if (req.method() === 'POST' && /\/api\/post$/.test(req.url()) && !n) {
						n++; return rt.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"forbidden"}' });
					}
					return rt.continue();
				};
				await a.page.route('**/api/post*', K3H.h);
			}, runs: 1 },
		];
		for (const k of stages) {
			try {
				await freshChat(a);
				await k.arm();
				const tag = 'VPH-' + k.id;
				await send(a.page, '@text ' + tag + ' turned away');
				await sleep(20000);
				if (K3H.h) { await a.page.unroute('**/api/post*', K3H.h).catch(() => {}); K3H.h = null; }
				const r = await turnRows(a, tag);
				const lines = r.rows.filter((x) => x.role === 'error_log' || x.role === 'note_log');
				console.log(`  note ${k.id}: runs ${ran(tag)}; rows ${J(r.rows)}`);
				check(`${k.id}: ${k.what}: the model is reached ${k.runs} time(s), the prompt stands once`, ran(tag) === k.runs && r.prompts === 1, J({ runs: ran(tag), prompts: r.prompts }));
				if (k.id === 'K1') check('K1: and the turn is answered for in words, one line', lines.length === 1, J(r.rows));
				else check('K3: and no line is added where the hand-off\'s own row stands', lines.length === 0, J(r.rows));
			} catch (e) { check(k.id + ' ran', false, String(e).slice(0, 200)); }
			await allPlay(a, b);
		}
	}

	// ── H: the runner refuses the errand for a pause ─────────────────────────
	if (S('H')) {
		console.log('\n── H  Pause all pressed on the runner as the errand leaves');
		try {
			await freshChat(a);
			let pressed = false;
			const h = async (rt) => {
				const req = rt.request();
				if (req.method() === 'POST' && /\/api\/post$/.test(req.url()) && !pressed) {
					pressed = true;
					await press(b.page, false).catch(() => {});
					await sleep(800);
				}
				return rt.continue().catch(() => {});
			};
			await a.page.route('**/api/post*', h);
			await send(a.page, '@text VPH-H typed as the errand left');
			let face = '';
			for (let i = 0; i < 40 && !/paused/i.test(face); i++) {
				await sleep(1000);
				// The hand-off tile's words are its footer's (`renderDispatchedFooter`), not a `.chat-msg`'s.
				face = await a.page.evaluate(() => { const t = document.querySelectorAll('#chat-output .turn-interrupted'); const l = t[t.length - 1]; return l ? l.innerText.slice(0, 240) : ''; }).catch(() => '');
			}
			await a.page.unroute('**/api/post*', h).catch(() => {});
			console.log('  note H: the phone shows ' + J(face));
			check('H: the model is not reached', ran('VPH-H') === 0, 'runs ' + ran('VPH-H'));
			check('H: the phone\'s tile says the turn was paused, not that the other device failed', /paused/i.test(face) && !/couldn.t finish/i.test(face), J(face));
		} catch (e) { check('H ran', false, String(e).slice(0, 200)); }
		await allPlay(a, b);
	}

	// ── R: Retry on a stale hold ─────────────────────────────────────────────
	if (S('R')) {
		console.log('\n── R  Retry pressed on the phone with its hold stale');
		try {
			await freshChat(a);
			await send(a.page, '@text VPH-R asked once');
			const first = await waitRuns('VPH-R', 30000);
			await settle(a.page);
			await sleep(3000);
			check('R ctl: the turn ran once to begin with', first === 1, 'runs ' + first);
			if (first === 1 && await staleHold(check, a, b, 'R')) {
				await a.page.setViewportSize({ width: 1280, height: 900 });
				await sleep(500);
				const clicked = await a.page.evaluate(() => {
					const bs = document.querySelectorAll('#chat-output .ctile-retry');
					const bt = bs[bs.length - 1];
					if (!bt) return false;
					bt.click();
					return true;
				});
				check('R ctl: the Retry control is on the last turn', clicked);
				const again = await waitRuns2('VPH-R', 2, 25000);
				const r = await turnRows(a, 'VPH-R');
				console.log('  note R: runs ' + ran('VPH-R') + ' rows ' + J(r.rows));
				check('R: Retry with the phone\'s hold stale is confirmed and runs', again === 2, 'runs ' + ran('VPH-R'));
				check('R: and is not refused for the pause already ended', !saysPaused(r), J(r.rows));
			}
		} catch (e) { check('R ran', false, String(e).slice(0, 200)); }
		await allPlay(a, b);
	}

	// ── L: every press lets the Send control go ─────────────────────────────
	// On the phone, whose turns are hand-offs: Retry and Edit & resend are drawn on a turn with an id
	// (`mountTurnActions`), which a hand-off's prompt carries and a completed local turn does not.
	if (S('L')) {
		console.log('\n── L  Edit & resend on the phone: every press lets the Send control go');
		try {
			await freshChat(a);
			const sendState = () => a.page.evaluate(() => {
				const s = document.getElementById('chat-send');
				return { disabled: s.disabled, busy: s.getAttribute('aria-busy'), label: s.getAttribute('aria-label') };
			});
			const editLast = async () => {
				await a.page.setViewportSize({ width: 1280, height: 900 });
				await sleep(500);
				return a.page.evaluate(() => {
					const bs = document.querySelectorAll('#chat-output .ctile-edit');
					const bt = bs[bs.length - 1];
					if (!bt) return { edit: false, users: document.querySelectorAll('#chat-output .chat-msg-user').length };
					bt.click();
					return { edit: true, box: document.getElementById('chat-input').value };
				});
			};
			// L1: a question's answer ("Chose: ..."), which Edit & resend opens again rather than runs again.
			await send(a.page, 'Chose: VPH-L1 the first option');
			const first = await waitRuns('VPH-L1', 30000);
			await settle(a.page);
			await sleep(3000);
			check('L1 ctl: the answer ran once', first === 1, 'runs ' + first);
			const e1 = await editLast();
			check('L1 ctl: Edit & resend is on the last turn, and puts the answer in the box', e1.edit && /VPH-L1/.test(e1.box), J(e1));
			await a.page.setViewportSize({ width: 420, height: 860 });
			await sleep(300);
			await a.page.click('#chat-send', { force: true });
			await sleep(3000);
			const s1 = await sendState();
			console.log('  note L1: the Send control after the press ' + J(s1) + '; runs ' + ran('VPH-L1'));
			check('L1: Edit & resend of a question\'s answer runs nothing', ran('VPH-L1') === 1, 'runs ' + ran('VPH-L1'));
			check('L1: and gives the Send control back', !s1.disabled && s1.busy !== 'true', J(s1));
			await send(a.page, '@text VPH-L1N the next press');
			check('L1: and the next press is sent', await waitRuns('VPH-L1N', 30000) === 1, 'runs ' + ran('VPH-L1N'));
			await settle(a.page);
			await sleep(3000);
			// L2: an ordinary turn, rewritten: it runs once, in the new words, and the control comes back.
			const e2 = await editLast();
			check('L2 ctl: Edit & resend is on the last turn', e2.edit && /VPH-L1N/.test(e2.box), J(e2));
			await send(a.page, '@text VPH-L2 the rewritten words');
			const runs2 = await waitRuns('VPH-L2', 30000);
			await settle(a.page);
			await sleep(1500);
			const s2 = await sendState();
			console.log('  note L2: runs ' + runs2 + '; the Send control ' + J(s2));
			check('L2: Edit & resend of an ordinary turn runs it once, in the new words', runs2 === 1, 'runs ' + runs2);
			check('L2: and gives the Send control back once it is under way', !s2.disabled && s2.busy !== 'true', J(s2));
		} catch (e) { check('L ran', false, String(e).slice(0, 200)); }
		await allPlay(a, b);
	}

	// ── X: another door into the one send ─────────────────────────────────────
	if (S('X')) {
		console.log('\n── X  the phone sheet\'s Ask while a typed press waits in the nominee\'s refresh');
		try {
			await freshChat(a);
			await a.page.evaluate((id) => {
				DaimondCore.roster.nominate(id);
				window.__vphReal = { sd: DaimondPeer.nominationStandDown, rp: DaimondSync.refreshPresence };
				DaimondPeer.nominationStandDown = function () { return false; };
				DaimondSync.refreshPresence = function () {
					return new Promise((r) => setTimeout(r, 3000)).then(() => window.__vphReal.rp());
				};
			}, idB);
			await send(a.page, '@text VPH-X1 typed and sent');
			await sleep(700);
			// The sheet's door, as `mobile.js` `ask()` calls it.
			await a.page.evaluate(() => DaimondCore.ask('@text VPH-X2 asked from the sheet'));
			const r1 = await waitRuns2('VPH-X1', 1, 30000), r2 = await waitRuns2('VPH-X2', 1, 30000);
			await sleep(3000);
			const t1 = await turnRows(a, 'VPH-X1'), t2 = await turnRows(a, 'VPH-X2');
			const box1 = await a.page.evaluate(() => document.getElementById('chat-input').value);
			console.log(`  note X1/X2: runs ${ran('VPH-X1')}/${ran('VPH-X2')}; prompts ${t1.prompts}/${t2.prompts}; the box ${J(box1)}`);
			check('X: the typed press runs once', r1 === 1 && ran('VPH-X1') === 1 && t1.prompts === 1, J({ runs: ran('VPH-X1'), prompts: t1.prompts }));
			check('X: the sheet\'s Ask, made while it waited, waits its turn and runs once', r2 === 1 && ran('VPH-X2') === 1 && t2.prompts === 1, J({ runs: ran('VPH-X2'), prompts: t2.prompts }));
			check('X: and the Ask\'s words never sat in the box', !/VPH-X2/.test(box1), J(box1));
			await a.page.evaluate(() => {
				DaimondPeer.nominationStandDown = window.__vphReal.sd;
				DaimondSync.refreshPresence = window.__vphReal.rp;
				DaimondCore.roster.nominate('');
			});
			await settle(a.page);
			await sleep(2000);
			// The person's own words in the box, unsent, while another door sends.
			await a.page.setViewportSize({ width: 420, height: 860 });
			await a.page.fill('#chat-input', 'VPH-X3 my own words, not yet sent');
			await a.page.evaluate(() => DaimondCore.ask('@text VPH-X4 asked from the sheet'));
			const r4 = await waitRuns2('VPH-X4', 1, 30000);
			await sleep(3000);
			const box2 = await a.page.evaluate(() => document.getElementById('chat-input').value);
			console.log(`  note X3/X4: runs ${ran('VPH-X4')}; X3 sent ${ran('VPH-X3')}; the box ${J(box2)}`);
			check('X: an Ask with words in the box runs once', r4 === 1 && ran('VPH-X4') === 1, 'runs ' + ran('VPH-X4'));
			check('X: and the words in the box are the person\'s still, unsent', box2 === 'VPH-X3 my own words, not yet sent' && ran('VPH-X3') === 0, J({ box: box2, sent: ran('VPH-X3') }));
			await a.page.fill('#chat-input', '');
		} catch (e) { check('X ran', false, String(e).slice(0, 200)); }
		await allPlay(a, b);
	}

	// ── Y: the conversation left in the wait ─────────────────────────────────
	if (S('Y')) {
		console.log('\n── Y  a press whose conversation is left while its confirming read is out');
		try {
			await freshChat(a);
			if (await staleHold(check, a, b, 'Y')) {
				const un = await syncGet(a.page, 'delay', 3500);
				const t0 = Date.now();
				await send(a.page, '@text VPH-Y1 pressed, then another chat opened');
				await sleep(300);
				await freshChat(a);
				await a.page.setViewportSize({ width: 420, height: 860 });	// still a phone to the election
				const tLeft = Date.now() - t0;
				check('Y ctl: the other chat was open while the read was still out', tLeft < 3200, tLeft + ' ms');
				const runs = await waitRuns('VPH-Y1', 30000);
				await sleep(3000);
				await un();
				const r = await turnRows(a, 'VPH-Y1');
				const here = await a.page.evaluate(() => document.getElementById('chat-output').innerText);
				console.log(`  note Y: runs ${runs}; prompts ${r.prompts}; rows ${J(r.rows)}; drawn in the chat on screen ${/VPH-Y1/.test(here)}`);
				check('Y: the press goes on to the conversation it was made in, and runs once', runs === 1 && r.prompts === 1, J({ runs, prompts: r.prompts }));
				check('Y: and is not drawn into the conversation now on screen', !/VPH-Y1/.test(here), '');
			}
		} catch (e) { check('Y ran', false, String(e).slice(0, 200)); }
		await allPlay(a, b);
		try {
			// Y2: the same, with the turn to run here (the election answered "local" once): it waits on its own
			// conversation's queue, badged on its tile, and runs when the person comes back to it.
			await freshChat(a);
			if (await staleHold(check, a, b, 'Y2')) {
				const un = await syncGet(a.page, 'delay', 3500);
				await a.page.evaluate(() => {
					const real = DaimondPeer.autoDispatchDecision;
					DaimondPeer.autoDispatchDecision = function () {
						const d = real.apply(this, arguments);
						DaimondPeer.autoDispatchDecision = real;
						return Object.assign({}, d, { dispatch: false });
					};
				});
				const t0 = Date.now();
				await send(a.page, '@text VPH-Y2 pressed, then another chat opened');
				await sleep(300);
				await freshChat(a);
				await a.page.setViewportSize({ width: 420, height: 860 });
				const tLeft = Date.now() - t0;
				check('Y2 ctl: the other chat was open while the read was still out', tLeft < 3200, tLeft + ' ms');
				await sleep(6000);
				await un();
				const away = ran('VPH-Y2');
				await a.page.setViewportSize({ width: 1280, height: 900 });
				await sleep(500);
				const badged = await a.page.evaluate(() => {
					const q = document.querySelector('.session-box .queue-badge');
					if (!q) return false;
					q.closest('.session-box').click();
					return true;
				});
				const back = await waitRuns('VPH-Y2', 30000);
				console.log(`  note Y2: runs while away ${away}; badged ${badged}; runs on return ${back}`);
				check('Y2: a turn to run here waits on its own conversation, badged, and runs nothing meanwhile', away === 0 && badged, J({ away, badged }));
				check('Y2: and runs once when the person comes back to it', back === 1, 'runs ' + back);
			}
		} catch (e) { check('Y2 ran', false, String(e).slice(0, 200)); }
		await allPlay(a, b);
	}

	// ── D: the press reaches the other device ────────────────────────────────
	if (S('D')) {
		console.log('\n── D  a press on the desktop, read by the phone');
		try {
			const lat = [];
			for (const want of [false, true, false, true]) {
				await sleep(3000);
				const t = await press(b.page, want, false);
				lat.push(await reads(a.page, !want, t, 15000));
			}
			const sorted = lat.slice().sort((x, y) => x - y);
			const med = sorted[Math.floor(sorted.length / 2)];
			console.log('  note D: press -> the phone reads it, ms: ' + J(lat));
			check('D: every press reaches the phone', lat.every((x) => x >= 0), J(lat));
			check('D: in a median well inside the old 2.5 s debounce (< 1500 ms)', med >= 0 && med < 1500, 'median ' + med + ' ms');
		} catch (e) { check('D ran', false, String(e).slice(0, 200)); }
		await allPlay(a, b);
	}

	for (const s of [a, b]) { try { await s.browser.close(); } catch (e) { /* gone */ } }
} catch (e) {
	check('the verifier ran to its end', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | '));
	exitCode = 1;
} finally {
	killAll();
}
if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed` + (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);
}
console.log(`\nverify_pausehandoff: ${ok.length} ok, ${bad.length} FAIL`);
process.exit(exitCode || (bad.length ? 1 : 0));
