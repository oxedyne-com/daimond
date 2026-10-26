// gateway: own
// probe_agentsacross.mjs -- UNBLOCK-28: a worker on one device is in every device's Agents grid.
//
// Two pages of ONE account (A and B, paired), one local gateway. A worker run is put on A's
// list and saved, which is the funnel every real status change passes; B, which never ran it,
// must draw it in #agents-grid with A's state within 10 s, as a read-only square, then its
// ending once A's run ends. RED before UNBLOCK-28: B's grid reads `agents.none_yet` throughout.
//
// Run: eval "$(node dev/rig/gateclock.mjs env probe_agentsacross)"; DAIMOND_LEASE_BAND=66-80 node dev/probe_agentsacross.mjs
//
// Standalone: with no world in the environment it claims a free one (`dev/world.sh --free`),
// stands it up, and downs, cleans and releases it at the end. Under a world already up (run_all
// phase 1) it uses that one. Either way it starts the world's own gateway, in a fresh directory
// under the world's scratch, and stops it cleanly (`gateway: own`).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TREE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const world = (...args) => execFileSync('bash', ['dev/world.sh', ...args], { cwd: TREE, encoding: 'utf8' }).trim();
let ownWorld = null;	// the world number this run claimed, to give back
if (!process.env.DAIMOND_WORLD) {
	try { ownWorld = world('--free', 'probe_agentsacross'); } catch (e) { console.log('no free world'); process.exit(2); }
	try { world(ownWorld, '--up'); } catch (e) { world(ownWorld, '--release'); console.log('world ' + ownWorld + ' would not come up'); process.exit(2); }
}
const giveBack = () => {
	if (ownWorld === null) return;
	for (const v of ['--down', '--clean', '--release']) { try { world(ownWorld, v); } catch (e) { /* say it below */ } }
	ownWorld = null;
};
if (ownWorld !== null) {
	for (const line of world(ownWorld, '--env').split('\n')) {
		const m = /^export ([A-Z_]+)=(.*)$/.exec(line);
		if (m) process.env[m[1]] = m[2];
	}
}
const { open, signInAs, connectMock, shot } = await import('./harness.mjs');
const { makePagePro } = await import('./pro.mjs');
const { GW_URL } = await import('./ports.mjs');
const G = await import('./gwbin.mjs');

const health = GW_URL + '/api/health';
const gwUp = async () => { try { return (await fetch(health)).ok; } catch (e) { return false; } };
if (await gwUp()) { console.log('a gateway is already up at ' + GW_URL + ': this probe starts its own there'); giveBack(); process.exit(2); }
G.requireFreshGateway();
const gwcwd = path.join(process.env.DAIMOND_SCRATCH, 'probe_agentsacross-gw-' + Date.now().toString(36));
fs.mkdirSync(gwcwd, { recursive: true });
fs.copyFileSync(path.join(G.GWCWD, 'app.jdat'), path.join(gwcwd, 'app.jdat'));
fs.symlinkSync(fs.realpathSync(path.join(G.GWDIR, 'keys')), path.join(gwcwd, 'keys'));
const gwLog = G.procLog('probe_agentsacross');
const gw = spawn(G.GWBIN, [], { cwd: gwcwd, stdio: gwLog.stdio, env: G.gatewayEnv({ APP_MODE: 'sandbox' }, gwcwd) });
process.on('exit', () => { try { gw.kill('SIGKILL'); } catch (e) { /* gone */ } });
for (let i = 0; i < 60 && !(await gwUp()); i++) await new Promise((r) => setTimeout(r, 500));
if (!(await gwUp())) { console.log('the gateway did not come up (' + gwLog.path + ')'); console.log(gwLog.tail()); giveBack(); process.exit(2); }

const bad = [];
const check = (name, pass, detail) => {
	if (!pass) bad.push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' -- ' + detail : ''));
};
const settle = (pg) => pg.waitForFunction(() => {
	try { return window.DaimondSync && window.DaimondSync.state().quiet; } catch (e) { return true; }
}, null, { timeout: 20000 }).catch(() => {});
const ready = (pg) => pg.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer && window.DaimondGateway
	&& DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
async function until(pg, fn, arg, ms) {
	const t0 = performance.now();
	while (performance.now() - t0 < ms) {
		let v = null; try { v = await pg.evaluate(fn, arg); } catch (e) { v = null; }
		if (v) return { v, ms: Math.round(performance.now() - t0) };
		await pg.waitForTimeout(250);
	}
	return { v: null, ms: Math.round(performance.now() - t0) };
}
// B's square for the run, as drawn: its element, its state class and its words.
const square = (id) => {
	const el = document.querySelector('#agents-grid .agsq[data-run="' + id + '"]');
	return el ? { tag: el.tagName, cls: el.className, title: el.title } : null;
};

const NAME = 'xdev_' + performance.now().toString(36).replace('.', '');
let a, b;
try {
	a = await open({ name: NAME });
	await ready(a.page);
	await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(a);
	await settle(a.page);

	b = await open({ name: 'xdevmate', signIn: false, connect: false });
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, NAME);
	await ready(b.page);
	await makePagePro(b.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(b);
	await settle(b.page);
	await b.page.setViewportSize({ width: 1500, height: 950 });

	const idA = await a.page.evaluate(() => DaimondIdentity.deviceId());
	// B follows A's key once A is on its roster (the pairing put it there).
	const known = await until(b.page, (id) => {
		try { DaimondSync.pull && DaimondSync.pull(); } catch (e) { /* the next one */ }
		if (!window.DaimondPeerAgents) return null;
		DaimondPeerAgents.tick();
		return DaimondSync.progressWatched().indexOf('agents.' + id) >= 0 ? true : null;
	}, idA, 20000);
	check('B follows A\'s agents frame', !!known.v, known.ms + ' ms');

	// A's worker: a run on A's list, through both funnels every status change takes: the save
	// (what B reads) and the draw (`touch`, what A's own grid shows).
	const RUN = 'xdevrun1';
	await a.page.evaluate((id) => {
		DaimondWorkers.runs.unshift({ id, name: 'probe worker', status: 'running', diamondId: 'dprobe', diamondName: 'Probe',
			deviceId: DaimondIdentity.deviceId(), costUsd: 0.01, capUsd: 1, parentId: 'tprobe', turnId: 'tprobe' });
		DaimondWorkers.persist();
		DaimondWorkers.touch(null);
	}, RUN);
	const live = await until(b.page, (id) => {
		const el = document.querySelector('#agents-grid .agsq[data-run="' + id + '"]');
		return el && el.classList.contains('run') ? true : null;
	}, RUN, 10000);
	const sq = await b.page.evaluate(square, RUN);
	check('B draws A\'s running worker within 10 s', !!live.v, live.ms + ' ms, ' + JSON.stringify(sq));
	check('B\'s square for it is read-only', !!sq && sq.tag === 'SPAN');
	try { await shot(b, 'agentsacross_B_live'); } catch (e) { /* a picture is not the check */ }

	await a.page.evaluate((id) => {
		const r = DaimondWorkers.runs.find((x) => x.id === id);
		r.status = 'done';
		DaimondWorkers.persist();
		DaimondWorkers.touch(r);
	}, RUN);
	const ended = await until(b.page, (id) => {
		const el = document.querySelector('#agents-grid .agsq[data-run="' + id + '"]');
		return el && el.classList.contains('done') ? true : null;
	}, RUN, 10000);
	check('B draws A\'s worker\'s ending within 10 s', !!ended.v, ended.ms + ' ms, ' + JSON.stringify(await b.page.evaluate(square, RUN)));
	const own = (await until(a.page, square, RUN, 5000)).v;
	check('A\'s own square stays a button', !!own && own.tag === 'BUTTON', JSON.stringify(own));
} catch (e) {
	bad.push('threw');
	console.log('PROBE THREW:', e && (e.stack || e.message || e));
} finally {
	try { await a.close(); } catch (e) { /* gone */ }
	try { await b.close(); } catch (e) { /* gone */ }
	const note = await G.stopGatewayCleanly(gw, health);
	if (note) console.log(note);
	try { fs.rmSync(gwcwd, { recursive: true, force: true }); } catch (e) { /* the world's clean takes it */ }
	giveBack();
}
console.log(bad.length ? '\nFAIL probe_agentsacross: ' + bad.join('; ') : '\nPASS probe_agentsacross');
process.exit(bad.length ? 1 : 0);
