// verify_worldports.mjs — two worlds at once, and neither one can answer for the
// other.
//
// WHAT THIS IS FOR. `dev/world.sh` numbers a world's app server and mock provider
// off the world number, and until 2026-08-25 it did not number the third thing a
// world reaches. Every world's `/api` was reverse-proxied to one fixed port, so
// which account state a verifier read was decided by which OTHER lane happened to
// be running something on it at that moment. `verify_attachfocus` and `verify_chatworkspace` went red
// four runs out of six on a tree nobody had changed; `dev/pro.mjs` posted a signed
// Pro licence event at a stranger's gateway; and `dev/reflux_brief.mjs` lost five
// consecutive runs to a foreign 403 that left the model list empty. Three separate
// symptoms, one cause, and each was answered where it was seen.
//
// A wrong answer with nothing saying it is wrong is the failure this file exists
// against, so what it asserts is not "the ports differ". It is:
//
//   1. Two worlds ask for two different ports, and no world asks for the one a
//      hand-started server lands on when it was given no world at all.
//   2. A world that HAS a gateway reaches its own and reads its own answer.
//   3. A world that has NOT started one is REFUSED, in a sentence that names its
//      own port, and never reaches the neighbour that does have one.
//   4. The refusal a caller reads says whose port it is, not merely that
//      something is absent.
//   5. No two rows of the port register collide for any world 0..9.
//   6. AND `world.sh --up` HANDS THE PORT TO THE SERVER IT STARTS. This one is
//      here because the fix shipped without it: the row was added, `--env`
//      exported it, and the `node dev/serve.mjs` line still passed only
//      DAIMOND_PORT -- so two worlds came up on 9711 and 9712 and both proxied to
//      9002, exactly as before. An env block is what a caller reads; it is not
//      what the server was told. So this asks the server, through `/__world`.
//
// It starts its own stand-in on a port of its own. No gateway binary, no browser
// and no mock provider: about ten seconds, and nothing to build.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST:
//
//   node dev/verify_worldports.mjs --break register  # 1 fails: one port for all worlds
//   node dev/verify_worldports.mjs --break shared    # 2,3 fail: one shared port
//   node dev/verify_worldports.mjs --break quiet     # 4 fails: the old sentence
//   node dev/verify_worldports.mjs --break collide   # 5 fails: a duplicated row
//   node dev/verify_worldports.mjs --break handoff   # 6 fails: --up drops the port
//   node dev/verify_worldports.mjs                   # and then, clean
//
// The register rows are 8480 + 2N (two app servers) and 9480 + 2N (their two
// gateways); see dev/world.sh, which is where a port is claimed. Check 6 borrows
// a whole spare WORLD instead -- the first of 21..30 whose ports are free -- so
// that it drives the real `world.sh --up` rather than a second copy of it.

import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const ROOT  = path.join(HERE, '..');
const WORLD = Math.max(0, Number(process.env.DAIMOND_PORT || 8777) - 8777);
// Both spellings are in the tree -- `--break name` and `--break=name` -- and a
// parser that quietly took the next argv entry read node's own path as a break
// name on the very first run of this file.
const BREAK = (() => {
	const eq = process.argv.find(a => a.startsWith('--break='));
	if (eq) return eq.slice(8);
	const i = process.argv.indexOf('--break');
	if (i < 0) return '';
	const next = process.argv[i + 1];
	return next && !next.startsWith('-') ? next : '';
})();

const APP_A = 8480 + 2 * WORLD, APP_B = 8481 + 2 * WORLD;
const GW_A  = 9480 + 2 * WORLD, GW_B  = 9481 + 2 * WORLD;

// The stand-in's own word for itself. A 401 alone would not distinguish "the
// neighbour refused me" from "my own gateway refused me", and that ambiguity is
// the whole fault -- so the body carries a name only this process writes.
const MARK = `world-A-standin-${process.pid}`;

const SCRATCH = process.env.DAIMOND_SCRATCH || path.join(process.env.HOME, '.cache/daimond');
const OUT = path.join(SCRATCH, 'worldports');
fs.mkdirSync(OUT, { recursive: true });

let ok = 0, bad = 0;
const check = (name, cond, detail = '') => {
	if (cond) { ok++; console.log(`  ok   ${name}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`); }
};

const free = (port) => new Promise((res) => {
	const s = net.createServer();
	s.once('error', () => res(false));
	s.once('listening', () => s.close(() => res(true)));
	s.listen(port, '127.0.0.1');
});

const waitFor = async (fn, ms = 15000) => {
	const end = Date.now() + ms;
	for (;;) {
		try { if (await fn()) return true; } catch (e) { /* not up yet */ }
		if (Date.now() > end) return false;
		await new Promise(r => setTimeout(r, 150));
	}
};

/// One world's environment, straight out of `dev/world.sh` rather than derived
/// here a second time -- deriving it twice is the staleness the register exists
/// against.
///
/// The three variables cleared below are the ones `world.sh` HONOURS when a
/// caller has already set them, and clearing them is the whole point of this
/// helper. `dev/run_all.sh:62` exports `DAIMOND_GW_PORT` for the entire suite,
/// so inside a suite run every world answered with the suite's own port: checks
/// 1 and 2 read 9709 twice and could not have read anything else. Check 2 passed
/// on that -- 9709 is not 9002 -- which is worse than the failure beside it. A
/// caller that means to pre-empt the register passes the variable in `extra`,
/// where the check that asks for it can be read.
function worldEnv(n, extra = {}, reg = path.join(HERE, 'world.sh')) {
	const env = { ...process.env, ...extra };
	for (const k of ['DAIMOND_GW_PORT', 'DAIMOND_IMAP_PORT', 'SMTPD_PORT']) {
		if (!(k in extra)) delete env[k];
	}
	const txt = execFileSync('bash', [reg, String(n), '--env'],
		{ encoding: 'utf8', env });
	const out = {};
	for (const line of txt.split('\n')) {
		const m = /^export ([A-Z_0-9]+)=(.*)$/.exec(line.trim());
		if (m) out[m[1]] = m[2];
	}
	return out;
}

const procs = [];
let standin = null;
let spare = null;

async function main() {
	// ── 1. The register answers, and it answers differently per world ─────
	//
	// `--break register` is the fault this row is against: one gateway port for
	// every world, written in the register rather than arrived at by accident.
	let numbered = path.join(HERE, 'world.sh');
	if (BREAK === 'register') {
		numbered = path.join(OUT, 'world-register.sh');
		const txt = fs.readFileSync(path.join(HERE, 'world.sh'), 'utf8');
		const damaged = txt.replace('GW_PORT=${DAIMOND_GW_PORT:-$((9700 + N))}',
			'GW_PORT=${DAIMOND_GW_PORT:-9700}');
		if (damaged === txt) {
			console.log('  break register: the GW_PORT line did not match, so this run would '
				+ 'prove nothing. Has world.sh\'s gateway row moved?');
			process.exit(2);
		}
		fs.writeFileSync(numbered, damaged);
	}
	const w3 = worldEnv(3, {}, numbered), w4 = worldEnv(4, {}, numbered);
	check('two worlds are given two different gateway ports',
		!!w3.DAIMOND_GW_PORT && w3.DAIMOND_GW_PORT !== w4.DAIMOND_GW_PORT,
		`${w3.DAIMOND_GW_PORT} / ${w4.DAIMOND_GW_PORT}`);

	// 9002 is where a gateway started by hand with no world lands: it is the
	// deployed `gateway/app.jdat` listen port and `dev/devgw.sh`'s own default. A
	// world reaching it is a world reaching whatever got there first.
	const nines = [];
	for (let n = 0; n <= 12; n++) {
		const p = worldEnv(n, {}, numbered).DAIMOND_GW_PORT;
		if (String(p) === '9002') nines.push(n);
	}
	check('no world 0..12 is given :9002, the port a stray gateway lands on',
		nines.length === 0, nines.length ? 'worlds ' + nines.join(', ') : '');

	// A caller that has already chosen one has asked for a gateway and must keep it.
	check('a caller that sets DAIMOND_GW_PORT itself keeps it',
		worldEnv(3, { DAIMOND_GW_PORT: '9911' }).DAIMOND_GW_PORT === '9911',
		worldEnv(3, { DAIMOND_GW_PORT: '9911' }).DAIMOND_GW_PORT);

	// ── 2. The register does not collide with itself ──────────────────────
	//
	// Read out of `dev/world.sh`'s own table rather than restated here. A second
	// copy of the register would be a second thing to keep in step, which is the
	// failure the table was written to end.
	let regPath = path.join(HERE, 'world.sh');
	if (BREAK === 'collide') {
		regPath = path.join(OUT, 'world-collide.sh');
		const txt = fs.readFileSync(path.join(HERE, 'world.sh'), 'utf8');
		fs.writeFileSync(regPath, txt.replace(
			'#   9099 + N   mock provider           dev/world.sh',
			'#   9099 + N   mock provider           dev/world.sh\n'
			+ '#   9100 + N   a deliberately colliding row  --break collide'));
	}
	const rows = [];
	for (const line of fs.readFileSync(regPath, 'utf8').split('\n')) {
		const m = /^#\s+(\d{4})(?:\s*\+\s*(\d*)N)?\s{2,}(\S.*?)\s*$/.exec(line);
		if (!m) continue;
		rows.push({ base: Number(m[1]), step: m[2] === undefined ? 0 : Number(m[2] || 1),
			what: m[3].slice(0, 46) });
	}
	check('the port register is machine-readable at all', rows.length >= 12, `${rows.length} row(s)`);
	const seen = new Map(); const clashes = [];
	for (const r of rows) {
		for (let n = 0; n <= 9; n++) {
			const p = r.base + r.step * n;
			const prev = seen.get(p);
			if (prev && prev !== r.what) clashes.push(`:${p} ${prev} / ${r.what}`);
			else seen.set(p, r.what);
		}
	}
	// 0..9 because that is the band of world numbers the register's own rows are
	// written for -- `dev/gate.sh` defaults to 9 and the lanes take 0..9. Higher
	// numbers are borrowed rather than assigned, and the borrower checks the ports
	// are free before it takes one.
	check('no two register rows claim one port for any world 0..9',
		clashes.length === 0, clashes.slice(0, 3).join(' | '));

	// ── 3. Two worlds, side by side ───────────────────────────────────────
	for (const [name, p] of [['A app', APP_A], ['B app', APP_B], ['A gw', GW_A], ['B gw', GW_B]]) {
		if (!await free(p)) {
			console.log(`SKIP verify_worldports — :${p} (${name}) is held by something else. `
				+ 'This file needs four ports of its own; see the 8480 + 2N and 9480 + 2N rows '
				+ 'in dev/world.sh, or run it in a world of its own.');
			process.exit(0);
		}
	}

	// World A's gateway. Nothing else on this machine answers with MARK, so an
	// answer carrying it is proof of WHICH gateway was reached, not merely that
	// one was.
	standin = http.createServer((req, res) => {
		res.writeHead(401, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'no session', standin: MARK, port: GW_A }));
	});
	await new Promise(r => standin.listen(GW_A, '127.0.0.1', r));

	// `--break quiet` runs a COPY of dev/serve.mjs whose refusal is the sentence
	// this file replaced: true, useless, and naming a port the run was never on.
	let serveJs = 'dev/serve.mjs';
	if (BREAK === 'quiet') {
		const txt = fs.readFileSync(path.join(HERE, 'serve.mjs'), 'utf8');
		const damaged = txt.replace(/res\.end\(JSON\.stringify\(\{ error: `No gateway[\s\S]*?\}\)\);/,
			"res.end(JSON.stringify({ error: 'The gateway is not running on :9002. "
			+ "Start it, or use the browser-only features.' }));");
		if (damaged === txt) {
			console.log('  break quiet: the refusal anchor did not match, so this run would '
				+ 'prove nothing. Has serve.mjs\'s 502 body moved?');
			process.exit(2);
		}
		const p = path.join(ROOT, 'dev/serve-quiet-break.mjs');
		fs.writeFileSync(p, damaged);
		procs.push({ path: p });
		serveJs = 'dev/serve-quiet-break.mjs';
	}

	// `--break shared` is the tree as it stood: one gateway port for every world.
	const gwForB = BREAK === 'shared' ? GW_A : GW_B;
	for (const [port, gw, log] of [[APP_A, GW_A, 'a'], [APP_B, gwForB, 'b']]) {
		const out = fs.openSync(path.join(OUT, `serve-${log}.log`), 'w');
		const rec = { proc: spawn('node', [serveJs], {
			cwd: ROOT, stdio: ['ignore', out, out],
			env: { ...process.env, DAIMOND_PORT: String(port), DAIMOND_GW_PORT: String(gw) },
		}) };
		// `exitCode` is null until node has reaped the child, so a teardown reading
		// it 400 ms after SIGTERM reports every ordinary stop as a process that
		// would not die. The event is the fact.
		rec.proc.on('exit', () => { rec.gone = true; });
		procs.push(rec);
	}
	const up = await waitFor(async () =>
		(await fetch(`http://localhost:${APP_A}/index.html`)).status < 500
		&& (await fetch(`http://localhost:${APP_B}/index.html`)).status < 500);
	check('two dev servers are up at once', up, `:${APP_A} and :${APP_B}`);

	const ask = async (port) => {
		const r = await fetch(`http://localhost:${port}/api/account`, { method: 'POST' });
		return { status: r.status, body: await r.text() };
	};
	const a = await ask(APP_A);
	const b = await ask(APP_B);

	check('world A reaches the gateway world A started',
		a.status === 401 && a.body.includes(MARK), `${a.status} ${a.body.slice(0, 90)}`);

	check('world B, which started none, is REFUSED rather than answered',
		b.status === 502, `${b.status} ${b.body.slice(0, 90)}`);

	// THE CHECK THIS FILE IS FOR. Before 2026-08-25 this is the line that went the
	// other way, silently, four runs out of six.
	check('and world B never reaches world A\'s gateway',
		!b.body.includes(MARK) && !b.body.includes(String(GW_A)),
		`${b.status} ${b.body.slice(0, 120)}`);

	check('world B\'s refusal names world B\'s OWN port',
		b.body.includes(String(GW_B)), b.body.slice(0, 120));

	// The sentence a caller reads. A refusal that says only "not running" leaves a
	// reader unable to tell an absent gateway from one they were never entitled to.
	check('and says whose port it is, not merely that something is absent',
		/this world's own/.test(b.body), b.body.slice(0, 160));

	console.log(`\n  the sentence a caller reads: ${JSON.parse(b.body).error}`);

	// ── 4. The real `world.sh --up`, asked what it actually started ───────
	//
	// Everything above drives servers this file spawned itself with the right
	// environment, which is why it could not have caught the handoff bug: the
	// fault was in the one line this file was not exercising. So a whole spare
	// world, brought up the way every lane brings one up.
	let spareN = 21;
	for (; spareN <= 30; spareN++) {
		if (await free(8777 + spareN) && await free(9099 + spareN) && await free(9700 + spareN)) break;
	}
	if (spareN > 30) {
		check('a spare world 21..30 was free for the handoff check', false,
			'every one of worlds 21..30 has a port held; nothing was measured');
		return;
	}
	let worldSh = path.join(HERE, 'world.sh');
	if (BREAK === 'handoff') {
		// IN dev/, not in the scratch root: world.sh resolves the app root from its
		// own location, so a copy anywhere else serves the wrong tree and refuses
		// before it can demonstrate anything. Removed in teardown.
		worldSh = path.join(HERE, 'world-handoff-break.sh');
		const txt = fs.readFileSync(path.join(HERE, 'world.sh'), 'utf8');
		const damaged = txt.replace('DAIMOND_PORT=$PORT DAIMOND_GW_PORT=$GW_PORT \\\n\t\t\texec node dev/serve.mjs',
			'DAIMOND_PORT=$PORT exec node dev/serve.mjs');
		if (damaged === txt) {
			console.log('  break handoff: the --up anchor did not match, so this run would '
				+ 'prove nothing. Has world.sh\'s serve.mjs line moved?');
			process.exit(2);
		}
		// The identity check would catch the damage before the browser could, which
		// is the point of it -- but then nothing downstream runs, and the check
		// being proved is the one below. So the copy keeps the fault and drops the
		// guard, and the guard has a check of its own further down.
		fs.writeFileSync(worldSh, damaged.replace('\tgot_gw=$(identify', '\tgot_gw=$GW_PORT #$(identify'));
		procs.push({ path: worldSh });
	}
	spare = { n: spareN, sh: worldSh };
	const upRes = spawnSync('bash', [worldSh, String(spareN), '--up'], { encoding: 'utf8' });
	if (upRes.status !== 0) {
		check('world.sh --up brought a spare world up at all', false,
			`world ${spareN}: ` + String(upRes.stderr || upRes.stdout || '').trim().split('\n').pop());
		return;
	}
	const upOut = upRes.stdout;
	const spareEnv = {};
	for (const line of upOut.split('\n')) {
		const m = /^export ([A-Z_0-9]+)=(.*)$/.exec(line.trim());
		if (m) spareEnv[m[1]] = m[2];
	}
	const world = await (await fetch(`http://localhost:${spareEnv.DAIMOND_PORT}/__world`)).json();
	check('world.sh --up hands the gateway port to the server it starts',
		String(world.gateway) === String(spareEnv.DAIMOND_GW_PORT),
		`world ${spareN}: the server proxies /api to :${world.gateway}, `
		+ `the env block says :${spareEnv.DAIMOND_GW_PORT}`);

	// And the guard that would have caught it. `--break handoff` disables this one
	// deliberately, so it is asserted on the REAL script, where the fault is absent
	// and the guard must therefore be present.
	check('and world.sh asks the server where it proxies rather than assuming',
		/got_gw=\$\(identify/.test(fs.readFileSync(path.join(HERE, 'world.sh'), 'utf8')),
		'verify_identity does not read /__world\'s gateway field');
}

// STOP WHAT WAS STARTED, AND SAY WHEN A KILL FAILED. An orphan holding a port for
// hours is how this whole class of fault gets a second afternoon; a teardown that
// swallows its own failure is how nobody finds out.
async function teardown() {
	// The world FIRST, and through the real `dev/world.sh` rather than through the
	// copy a break may have made: `--down` reads pid files under the world's own
	// scratch, which both copies compute identically, and the copy is about to be
	// deleted. Deleting it first left world 21 running once.
	if (spare) {
		// `--down` promises not to report success while a port is held, and its
		// exit status is the promise. Swallowing it is how a world outlives the run
		// that started it.
		const r = spawnSync('bash', [path.join(HERE, 'world.sh'), String(spare.n), '--down'],
			{ encoding: 'utf8' });
		if (r.status !== 0) {
			console.log(`  note  world ${spare.n} did NOT shut down cleanly: `
				+ String(r.stderr || r.stdout || '').trim());
		}
	}
	for (const p of procs) {
		if (p.path) { try { fs.unlinkSync(p.path); } catch (e) {
			console.log(`  note  could not remove ${p.path}: ${e.message}`); } continue; }
		if (!p.proc || p.gone) continue;
		try { p.proc.kill('SIGTERM'); } catch (e) {
			console.log(`  note  could not signal pid ${p.proc.pid}: ${e.message}`);
		}
	}
	if (standin) await new Promise(r => standin.close(r));
	await new Promise(r => setTimeout(r, 400));
	for (const p of procs) {
		if (!p.proc || p.gone) continue;
		try { p.proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
		console.log(`  note  pid ${p.proc.pid} did not stop on SIGTERM and was killed`);
	}
	const held = [];
	for (const port of [APP_A, APP_B, GW_A, GW_B]) if (!await free(port)) held.push(port);
	if (held.length) {
		console.log(`  note  STILL HELD after teardown: ${held.map(p => ':' + p).join(' ')}. `
			+ `Find the owner with  ss -ltnp | grep -E ':(${held.join('|')}) '`);
	}
}

try {
	await main();
} catch (e) {
	check('the run completed', false, String((e && e.stack) || e));
} finally {
	await teardown();
}

console.log(`\n${ok} ok, ${bad} failed`);
if (BREAK) {
	console.log(bad ? `break '${BREAK}' correctly failed ${bad} check(s)`
		: `break '${BREAK}': NOTHING FAILED, so the checks above prove nothing`);
	process.exit(bad ? 0 : 1);              // a break MUST fail something
}
process.exit(bad ? 1 : 0);
