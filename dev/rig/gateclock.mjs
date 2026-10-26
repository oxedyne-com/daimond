// gateclock.mjs -- the one clock module a gate script reads time through (RIG-PROD P2, §3.7 rule 1).
//
//	node dev/rig/gateclock.mjs env <gate> [seed]	`export DAIMOND_CLOCK=… DAIMOND_TZ=… DAIMOND_SEED=…` (and DAIMOND_SW=allow for a gate
//						declaring `sw: true`) for a run by hand
//						(a node entry imports gateEnv(gate) instead)
//	node dev/rig/gateclock.mjs run <gate> <seed>	one JSON line: { cmd, env, base } the kit runs the gate from
//	node dev/rig/gateclock.mjs seeds			every gating `<gate> <seed>`, one a line, the quarantined ones left out
//	node dev/rig/gateclock.mjs quarantined <gate> <seed>	exit 0 and print the entry when the seed is quarantined, else 1
//	node dev/rig/gateclock.mjs list-quarantine	one line per quarantined seed, for every release's list
//	node dev/rig/gateclock.mjs tick <file> <pid>	the run clock: <file> ticked from DAIMOND_CLOCK's instant until <pid> ends
//	node dev/rig/gateclock.mjs driven <url>	exit 0 when the gateway at <url> runs on a driven clock, else 1, saying why
//
// No gate reads the wall clock: the page runs at its gate's declared instant and zone (harness open() refuses a
// context without both), and node-side code that needs "now" reads `gateNow()`, the same instant. Elapsed work is
// measured with `performance.now()`, which tells no date. clockscan.mjs --gates holds every other script to this.
//
// ONE CLOCK PER RUN (rc-b, 26 Oct, from four false reds). The pages, node and the gateway read one run clock: a file of 8
// bytes, the run's "now" in ms (little-endian), rewritten every 100 ms from the gate's instant, named by DAIMOND_RUN_CLOCK.
// The gateway reads it as `driven:<file>` (gwbin gatewayEnv), harness open() installs each page at its current value and
// gateNow() returns it, so a stamp a page makes is the gateway's "now" too however long the run has gone. The kit starts it
// once for a run (dk_gate, postgates, arms), and a hand run gets one from its first startRunClock(); no verifier starts its
// own. Before, each page restarted at the bare instant on every open() while a gateway ran on the host's clock, and a
// pairing stamp 5 days old was refused 401 (turn_parity --two, ccp7 by-role WebKit).

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import url  from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
export const GATES_FILE = path.join(HERE, 'gates.json');
export const QUAR_FILE  = path.join(HERE, 'quarantine.json');

const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/// The instant and zone a gate's seed runs at: the gate's own, else the file's default.
export function declared(gate, seed = null, file = GATES_FILE) {
	const j = load(file), g = (j.gates || {})[gate] || {}, d = j.default || {};
	const instant = g.clock === 'seed' && seed ? seed : (g.instant || d.instant);
	const tz = g.tz || d.tz;
	if (!instant || !tz) throw new Error(`gateclock: ${gate} declares no ${instant ? 'tz' : 'instant'} (and ${file} no default)`);
	if (Number.isNaN(Date.parse(instant))) throw new Error(`gateclock: ${gate}'s instant '${instant}' is not a date`);
	return { instant, tz, sw: g.sw === true };	// sw: the app's service worker allowed (harness open() blocks it by default)
}

export const RUN_CLOCK = 'DAIMOND_RUN_CLOCK';
const TICK_MS = 100;	// the run clock file's period, ms; the gateway's driven clock rereads it as it needs

/// The run clock's value in `file`, as ms.
export function readRunClock(file) {
	const b = fs.readFileSync(file);
	if (b.length !== 8) throw new Error(`gateclock: run clock ${file} is ${b.length} bytes, not 8`);
	return Number(b.readBigUInt64LE(0));
}

/// Writes the run clock from `base` (ms) every TICK_MS, whole or not at all (the gateway refuses a file not 8 bytes long).
function ticker(file, base) {
	const t0 = performance.now(), tmp = `${file}.${process.pid}.tmp`;
	const tick = () => {
		const b = Buffer.alloc(8);
		b.writeBigUInt64LE(BigInt(Math.floor(base + performance.now() - t0)));
		fs.writeFileSync(tmp, b);
		fs.renameSync(tmp, file);
	};
	tick();
	return setInterval(tick, TICK_MS);
}

/// The run clock this process and its children read: DAIMOND_RUN_CLOCK when the kit (or an earlier call) started one, else one
/// started here from the gate's instant, ticked while the process lives and removed at its exit. Returns its file.
export function startRunClock() {
	const e = process.env;
	if (e[RUN_CLOCK] && fs.existsSync(e[RUN_CLOCK])) return e[RUN_CLOCK];
	const base = gateNow();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclock-')), file = path.join(dir, 'clock');
	ticker(file, base).unref();
	process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* gone already */ } });
	e[RUN_CLOCK] = file;
	return file;
}

/// Does the gateway at `url` run on a driven clock? `/__rig/report` exists only on one (gateway rigreport.rs), so a 404 is a
/// gateway on the host's clock, which would refuse every page-dated stamp of a pinned run.
export async function gatewayDriven(url) {
	let r;
	try { r = await fetch(`${url}/__rig/report?since=0`, { signal: AbortSignal.timeout(5000) }); }
	catch (e) { return { ok: false, why: `gateway clock not driven: ${url} did not answer /__rig/report (${e.cause?.code || e.message})` }; }
	if (r.status === 404) return { ok: false, why: `gateway clock not driven: ${url} answers /__rig/report 404, so it runs on the host's clock; a gate's gateway runs on the run clock (DAIMOND_CLOCK=driven:<${RUN_CLOCK}>, DAIMOND_GW_DEV=1)` };
	return { ok: r.ok, why: r.ok ? `gateway clock driven: ${url}` : `gateway clock not driven: ${url} answers /__rig/report ${r.status}` };
}

/// Throws at start-up when the gateway at `url` is not on a driven clock, rather than letting a pairing 401 say so later.
export async function requireDrivenGateway(url) {
	const d = await gatewayDriven(url);
	if (!d.ok) throw new Error(d.why);
}

/// The gate's "now", as ms: the run clock when one runs (DAIMOND_RUN_CLOCK), else the declared instant DAIMOND_CLOCK names;
/// never the host's.
export function gateNow() {
	const f = process.env[RUN_CLOCK];
	if (f && fs.existsSync(f)) return readRunClock(f);
	const c = process.env.DAIMOND_CLOCK;
	if (!c) throw new Error('gateclock: DAIMOND_CLOCK is unset: run under the gate’s declared instant (gateclock.mjs env <gate>)');
	const t = /^\d+$/.test(c) ? Number(c) : Date.parse(c);
	if (Number.isNaN(t)) throw new Error(`gateclock: DAIMOND_CLOCK '${c}' is not a date`);
	return t;
}

/// The instant and zone a hand-run entry opens its pages at, as open()'s `{ clock, timezoneId }`: what the kit (or
/// `gateclock.mjs env`) already exported, else `gate`'s declared pair, written into process.env so every open() of the run
/// and anything it spawns reads the same. The one door for an entry run outside dk (driver.mjs, turn_smoke, an arm wrapper).
export function gateEnv(gate, seed = null, file = GATES_FILE) {
	const e = process.env;
	if (!e.DAIMOND_CLOCK || !e.DAIMOND_TZ) {
		const { instant, tz } = declared(gate, seed, file);
		e.DAIMOND_CLOCK ||= instant;
		e.DAIMOND_TZ    ||= tz;
	}
	if (declared(gate, seed, file).sw) e.DAIMOND_SW ||= 'allow';
	return { clock: e.DAIMOND_CLOCK, timezoneId: e.DAIMOND_TZ };
}

/// What the kit runs for `<gate> <seed>`: argv with {seed} replaced, the env, and the base worktree's key.
export function runOf(gate, seed, file = GATES_FILE) {
	const g = (load(file).gates || {})[gate];
	if (!g || !Array.isArray(g.cmd)) throw new Error(`gateclock: no gate '${gate}' with a cmd in ${file}`);
	const { instant, tz, sw } = declared(gate, seed, file);
	return {
		cmd:  g.cmd.map((a) => a.split('{seed}').join(seed)),
		env:  { DAIMOND_CLOCK: instant, DAIMOND_TZ: tz, DAIMOND_SEED: seed, ...(sw ? { DAIMOND_SW: 'allow' } : {}) },
		base: g.base || 'www',
	};
}

export function quarantine(file = QUAR_FILE) {
	try { return load(file).entries || []; } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
export const isQuarantined = (gate, seed, file = QUAR_FILE) => quarantine(file).find((e) => e.gate === gate && e.seed === seed) || null;

/// Every gating pair, quarantined seeds left out (they stop gating until fixed).
export function gatingSeeds(gf = GATES_FILE, qf = QUAR_FILE) {
	const out = [];
	for (const [gate, g] of Object.entries(load(gf).gates || {}))
		for (const seed of g.seeds || []) if (!isQuarantined(gate, seed, qf)) out.push([gate, seed]);
	return out;
}

const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
	const [verb, gate, seed] = process.argv.slice(2);
	const gf = process.env.DK_GATES_FILE || GATES_FILE, qf = process.env.DK_QUAR_FILE || QUAR_FILE;
	try {
		switch (verb) {
		case 'env': {
			const { instant, tz, sw } = declared(gate, seed || null, gf);
			console.log(`export DAIMOND_CLOCK=${q(instant)} DAIMOND_TZ=${q(tz)}${seed ? ` DAIMOND_SEED=${q(seed)}` : ''}${sw ? ' DAIMOND_SW=allow' : ''}`);
			break;
		}
		case 'run':		console.log(JSON.stringify(runOf(gate, seed, gf))); break;
		case 'seeds':		for (const [g, s] of gatingSeeds(gf, qf)) console.log(`${g} ${s}`); break;
		case 'quarantined': {
			const e = isQuarantined(gate, seed, qf);
			if (!e) process.exit(1);
			console.log(JSON.stringify(e));
			break;
		}
		case 'tick': {	// <file> <pid>: the kit's run clock, from DAIMOND_CLOCK's instant, until <pid> (the run) ends
			const [file, pid] = [gate, Number(seed)];
			if (!file || !pid) throw new Error('gateclock: tick <file> <pid>');
			delete process.env[RUN_CLOCK];	// a new run's clock starts at the instant, never at an inherited run's
			const h = ticker(file, gateNow());
			const alive = () => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
			const end = () => { clearInterval(h); try { fs.rmSync(file, { force: true }); } catch (_) { /* gone already */ } process.exit(0); };
			setInterval(() => { if (!alive()) end(); }, TICK_MS);
			for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, end);
			break;
		}
		case 'driven': {
			const d = await gatewayDriven(gate);
			(d.ok ? console.log : console.error)(d.why);
			process.exit(d.ok ? 0 : 1);
			break;
		}
		case 'list-quarantine':
			for (const e of quarantine(qf)) console.log(`quarantined ${e.gate} ${e.seed}: since ${e.since}, ${e.why} (FIRE ${e.fire || 'defect'})`);
			break;
		default:
			console.error('gateclock: env <gate> [seed] | run <gate> <seed> | seeds | quarantined <gate> <seed> | list-quarantine | tick <file> <pid> | driven <url>'); process.exit(2);
		}
	} catch (e) { console.error(e.message); process.exit(2); }
}
