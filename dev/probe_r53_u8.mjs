// probe_r53_u8.mjs -- a turn typed on the phone around a Pause all pressed on the desktop is
// run, or refused in words, and never left (R53-U8, 2026-09-25).
//
// The reopen rehearsal's U8 failed 2 runs in 3 on live 5.1.1: the iPhone's typed turn neither
// ran nor was handed off. U7 before it presses Pause all on argonaut and then play, and U8
// types on the phone about five seconds later. A press leaves its device on the ordinary
// push debounce (2.5 s) and reaches the others by sync, so the phone could still read the
// account paused: it refused the turn for a pause that argonaut had already ended.
//
//   A  THE RESUME RACE. The desktop presses play and the phone types at once, as a person
//      holding both would. The phone must run the turn -- here, handed to the desktop -- and
//      not refuse it for the pause just ended. Red where the phone refuses on the hold it
//      happens to hold (`confirmHold` is the fix: one bounded read of the mailbox first).
//   B  A PAUSE THAT LANDS DURING THE SEND. The pause arrives after `maybeAutoDispatch`'s
//      first question and before its commit (here: injected in the election, the widest
//      window, which in the app is the nominee's presence refresh, up to 4 s). The turn must
//      be refused in words, never left with no row: red where the prompt stands with no
//      placeholder, no note and no run.
//   C  A PAUSE STILL HELD IS STILL REFUSED. The control for A: the account paused on the
//      desktop, the phone types; no model request, no errand, and a note that says paused.
//   D  How long a press takes to reach the other device (reported, for the brief).
//
// Starts its own gateway (fresh store, the live binary), mock and app server, on the world
// the environment names:
//
//   eval "$(bash dev/world.sh 46 --env)"
//   node dev/probe_r53_u8.mjs [--tree <app tree to serve, default this one>] [--gw <binary>]
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { newChat, mockLog, SCRATCH } from './harness.mjs';
import { pair, checker, storedMsgs, placeholders, send, freshChat, settle, until } from './handoffpair.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TREE = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SERVE = path.resolve(arg('--tree', TREE));
const GW_BIN = arg('--gw', path.join(os.homedir(), '.cache/cargo-targets/claude-rc-2/lane-gw6-mr5/release/daimond_gateway'));
const PORT = Number(process.env.DAIMOND_PORT || 0), GW_PORT = Number(process.env.DAIMOND_GW_PORT || 0);
const MOCK_PORT = Number(process.env.DAIMOND_MOCK_PORT || 0), MOCK_LOG = process.env.DAIMOND_MOCK_LOG || '';
if (!PORT || !GW_PORT || !MOCK_PORT || !MOCK_LOG) {
	console.log('refusing to run: eval "$(bash dev/world.sh <N> --env)" first.');
	process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
const RUN = Date.now().toString(36);
const ROOT = path.join(SCRATCH, 'probe_r53_u8', RUN);
fs.mkdirSync(ROOT, { recursive: true });

// ── The stack ──────────────────────────────────────────────────────────────
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
async function stack() {
	for (const p of [PORT, GW_PORT, MOCK_PORT]) if (await listening(p)) throw new Error('port ' + p + ' is taken: this world is in use');
	const cwd = path.join(ROOT, 'gwcwd');
	fs.mkdirSync(cwd, { recursive: true });
	execFileSync('bash', ['dev/devgw.sh'], { cwd: TREE, env: Object.assign({}, process.env, { DAIMOND_GW_PORT: String(GW_PORT) }) });
	fs.copyFileSync(path.join(TREE, 'dev/devgw/app.jdat'), path.join(cwd, 'app.jdat'));
	fs.symlinkSync(fs.realpathSync(path.join(TREE, 'gateway/keys')), path.join(cwd, 'keys'));
	child(GW_BIN, [], { cwd, env: Object.assign({}, process.env, { APP_MODE: 'sandbox' }) }, 'gateway');
	fs.writeFileSync(MOCK_LOG, '');
	child('node', ['dev/mockllm.mjs', String(MOCK_PORT)], { cwd: TREE, env: Object.assign({}, process.env, { DAIMOND_MOCK_LOG: MOCK_LOG }) }, 'mock');
	child('node', ['dev/serve.mjs'], { cwd: SERVE, env: Object.assign({}, process.env, { DAIMOND_PORT: String(PORT), DAIMOND_GW_PORT: String(GW_PORT) }) }, 'serve');
	for (let i = 0; i < 60; i++) {
		try { const r = await fetch(`http://127.0.0.1:${GW_PORT}/api/health`); if (r.ok) break; } catch (e) { /* not yet */ }
		await sleep(500);
	}
	if (!(await waitPort(MOCK_PORT)) || !(await waitPort(PORT))) throw new Error('the stack did not come up');
}

// ── Reading the two devices ────────────────────────────────────────────────
const paused = (pg) => pg.evaluate(() => DaimondPause.isPaused(DaimondPause.ROOT)).catch((e) => 'err ' + e);
/// Press the global control on a desktop, as he does: the widget's own button.
async function press(pg, play) {
	const sel = '#pptw-global .pptw-' + (play ? 'play' : 'pause');
	const t = Date.now();
	await pg.click(sel, { timeout: 8000 }).catch(() => pg.evaluate((p) => DaimondPause.set(DaimondPause.ROOT, p), play));
	return t;
}
/// Wait until `pg` reads the account as `want`; answers the ms it took, or -1.
async function reads(pg, want, from, ms = 30000) {
	for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
		if ((await paused(pg)) === want) return Date.now() - from;
		await sleep(100);
	}
	return -1;
}
/// What the phone holds for the turn whose prompt carries `tag`: the rows after it.
async function turnRows(s, tag) {
	const ms = await storedMsgs(s);
	const i = ms.findIndex((m) => m.role === 'user' && String(m.content || '').includes(tag));
	if (i < 0) return { prompt: false, rows: [] };
	const it = String(ms[i].iturn || ms[i].mid || '');
	const rows = ms.filter((m, j) => j > i && (String(m.iturn || '') === it || ['note_log', 'error_log'].includes(m.role) || m.role === 'assistant'))
		.map((m) => ({ role: m.role, why: m.why || '', c: String(m.content || '').slice(0, 120) }));
	return { prompt: true, rows };
}
const ran = (tag) => mockLog().filter((r) => {
	const ms = r.messages || [];
	const last = ms[ms.length - 1];
	return last && last.role === 'user' && JSON.stringify(last.content).includes(tag);
}).length;
const posted = (s) => s.page.evaluate(() => (window.__probePosts || 0)).catch(() => -1);
async function countPosts(s) {
	await s.page.evaluate(() => { window.__probePosts = 0; });
	await s.page.route('**/api/post', (route) => {
		if (route.request().method() === 'POST') s.page.evaluate(() => { window.__probePosts = (window.__probePosts || 0) + 1; }).catch(() => {});
		return route.continue();
	});
}

const { ok, bad, check } = checker();
let exitCode = 0;
try {
	await stack();
	console.log(`probe_r53_u8: serving ${SERVE} (${J(JSON.parse(fs.readFileSync(path.join(SERVE, 'www/build.json'), 'utf8')))}), gateway ${GW_BIN}, run ${RUN}`);
	const acct = 'u8p' + RUN;
	const { a, b } = await pair(check, acct, acct + 'desk');
	await countPosts(a);
	await b.page.setViewportSize({ width: 1500, height: 950 });
	for (const s of [a, b]) await s.page.evaluate(() => { try { DaimondDiag.set(true, 'probe'); } catch (e) { /* none */ } });

	// ── A: the resume race ──────────────────────────────────────────────────
	// The phone's wake channel is shut for the race, so the play the desktop has already
	// landed on the mailbox is not pulled by the phone on its own: the moment a person
	// types in, between the play reaching the mailbox and the phone hearing of it, is made
	// to last rather than hoped for. Everything else is the app's own.
	console.log('\n── A  play pressed on the desktop and landed; the phone, not yet told, types');
	await freshChat(a);
	const tP = await press(b.page, false);
	const pzA = await reads(a.page, true, tP);
	check('A ctl: the phone reads the Pause all pressed on the desktop', pzA >= 0, pzA + ' ms after the press');
	await settle(b.page);
	await a.page.evaluate(() => DaimondSync.wakeVia('off'));
	const vB = await b.page.evaluate(() => DaimondSync.version());
	await press(b.page, true);
	const landedA = await until(b.page, (v) => DaimondSync.version() > v && DaimondSync.state().quiet, vB, 20000);
	check('A ctl: the desktop\'s play reached the mailbox', landedA);
	const nowPaused = await paused(a.page);
	check('A ctl: the phone still reads paused as it types (the race is on)', nowPaused === true, J(nowPaused));
	await send(a.page, '@text U8P-A typed after play was pressed');
	let runsA = 0;
	for (let i = 0; i < 60 && !runsA; i++) { await sleep(1000); runsA = ran('U8P-A'); }
	const rowsA = await turnRows(a, 'U8P-A');
	check('A: a turn typed after play was pressed elsewhere runs, once', runsA === 1, 'runs ' + runsA + '; rows ' + J(rowsA.rows));
	check('A: and it was not refused for the pause already ended', !rowsA.rows.some((r) => /paused/i.test(r.c)), J(rowsA.rows));
	await a.page.evaluate(() => DaimondSync.wakeVia(''));
	await sleep(2000);

	// ── A2: typed 1.5 s after play is pressed, faster than a person moves between devices.
	// Red while the press waits out the push debounce (2.5 s) before it leaves the desktop.
	console.log('\n── A2  the phone types 1.5 s after play is pressed on the desktop');
	await freshChat(a);
	const tP2 = await press(b.page, false);
	await reads(a.page, true, tP2);
	await sleep(1000);
	await press(b.page, true);
	await sleep(1500);
	await send(a.page, '@text U8P-A2 typed after play was pressed');
	let runsA2 = 0;
	for (let i = 0; i < 60 && !runsA2; i++) { await sleep(1000); runsA2 = ran('U8P-A2'); }
	const rowsA2 = await turnRows(a, 'U8P-A2');
	check('A2: a turn typed 1.5 s after play was pressed on the desktop runs, once', runsA2 === 1, 'runs ' + runsA2 + '; rows ' + J(rowsA2.rows));

	// ── B: a pause that lands during the send ───────────────────────────────
	console.log('\n── B  a pause lands between the send\'s first question and its commit');
	await settle(a.page); await settle(b.page);
	await freshChat(a);
	const postsB0 = await posted(a);
	// The pause arrives inside the election, as it would inside the presence refresh.
	await a.page.evaluate(() => {
		const real = DaimondPeer.autoDispatchDecision;
		DaimondPeer.autoDispatchDecision = function () {
			const d = real.apply(this, arguments);
			DaimondPeer.autoDispatchDecision = real;
			try { DaimondPause.set(DaimondPause.ROOT, false); } catch (e) { /* none */ }
			return d;
		};
	});
	await send(a.page, '@text U8P-B typed as a pause landed');
	await sleep(8000);
	const rowsB = await turnRows(a, 'U8P-B');
	const phB = placeholders(await storedMsgs(a)).filter((m) => String(m.itext || '').includes('U8P-B'));
	check('B ctl: the prompt was sent', rowsB.prompt, J(rowsB));
	check('B: the model was not reached', ran('U8P-B') === 0, 'runs ' + ran('U8P-B'));
	check('B: no errand was posted for it', (await posted(a)) === postsB0, 'posts ' + ((await posted(a)) - postsB0));
	check('B: the turn is answered for in words -- a row says it is paused, never nothing',
		rowsB.rows.some((r) => /paused/i.test(r.c)) || phB.length > 0, J({ rows: rowsB.rows, placeholders: phB.length }));
	await press(a.page, true).catch(() => {});
	await reads(b.page, false, Date.now(), 20000);

	// ── C: a pause still held is still refused ──────────────────────────────
	console.log('\n── C  the account paused on the desktop, the phone types well after');
	await freshChat(a);
	const tC = await press(b.page, false);
	check('C ctl: the phone reads the pause', (await reads(a.page, true, tC)) >= 0);
	await sleep(1500);
	const postsC0 = await posted(a);
	await send(a.page, '@text U8P-C typed while paused');
	await sleep(8000);
	const rowsC = await turnRows(a, 'U8P-C');
	check('C: a turn typed while the account is paused reaches no model', ran('U8P-C') === 0, 'runs ' + ran('U8P-C'));
	check('C: and no errand', (await posted(a)) === postsC0);
	check('C: and the refusal says paused', rowsC.rows.some((r) => /paused/i.test(r.c)), J(rowsC.rows));
	await press(b.page, true);
	await reads(a.page, false, Date.now(), 20000);

	// ── D: how long a press takes to reach the other device ─────────────────
	console.log('\n── D  a press, from the desktop to the phone');
	const lat = [];
	for (const want of [false, true, false, true]) {
		await sleep(3000);
		const t = await press(b.page, want);
		lat.push([want ? 'play' : 'pause', await reads(a.page, !want, t)]);
	}
	console.log('  note press -> the phone reads it: ' + J(lat));
	const ms = lat.map((x) => x[1]).filter((x) => x >= 0).sort((x, y) => x - y);
	const med = ms.length ? ms[Math.floor(ms.length / 2)] : -1;
	check('D: a press on the desktop reaches the phone in under 2.5 s (median of four)', med >= 0 && med < 2500, 'median ' + med + ' ms');
	const diagA = await a.page.evaluate(() => { try { return DaimondDiag.rows().filter((r) => /hold confirm|dispatch (refused|unhanded|start)/.test(r.tag)).map((r) => r.tag + ' | ' + (r.data || '')); } catch (e) { return []; } });
	console.log('  note phone diag: ' + J(diagA.slice(-8)));
	for (const s of [a, b]) { try { await s.browser.close(); } catch (e) { /* gone */ } }
} catch (e) {
	check('the probe ran to its end', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | '));
	exitCode = 1;
} finally {
	killAll();
}
console.log(`\nprobe_r53_u8: ${ok.length} ok, ${bad.length} FAIL`);
process.exit(exitCode || (bad.length ? 1 : 0));
