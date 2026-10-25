// gateclock.mjs -- the one clock module a gate script reads time through (RIG-PROD P2, §3.7 rule 1).
//
//	node dev/rig/gateclock.mjs env <gate> [seed]	`export DAIMOND_CLOCK=… DAIMOND_TZ=… DAIMOND_SEED=…` (and DAIMOND_SW=allow for a gate
//						declaring `sw: true`) for a run by hand
//						(a node entry imports gateEnv(gate) instead)
//	node dev/rig/gateclock.mjs run <gate> <seed>	one JSON line: { cmd, env, base } the kit runs the gate from
//	node dev/rig/gateclock.mjs seeds			every gating `<gate> <seed>`, one a line, the quarantined ones left out
//	node dev/rig/gateclock.mjs quarantined <gate> <seed>	exit 0 and print the entry when the seed is quarantined, else 1
//	node dev/rig/gateclock.mjs list-quarantine	one line per quarantined seed, for every release's list
//
// No gate reads the wall clock: the page runs at its gate's declared instant and zone (harness open() refuses a
// context without both), and node-side code that needs "now" reads `gateNow()`, the same instant. Elapsed work is
// measured with `performance.now()`, which tells no date. clockscan.mjs --gates holds every other script to this.

import fs   from 'node:fs';
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

/// The gate's "now", as ms: the declared instant DAIMOND_CLOCK names, never the host's.
export function gateNow() {
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
		case 'list-quarantine':
			for (const e of quarantine(qf)) console.log(`quarantined ${e.gate} ${e.seed}: since ${e.since}, ${e.why} (FIRE ${e.fire || 'defect'})`);
			break;
		default:
			console.error('gateclock: env <gate> [seed] | run <gate> <seed> | seeds | quarantined <gate> <seed> | list-quarantine'); process.exit(2);
		}
	} catch (e) { console.error(e.message); process.exit(2); }
}
