// predeploy_guard.mjs -- DEPLOY FIRST, as a gate on the heavy suites (D-20261023-04).
//
// The owner's rule (D-20261006-24, D-20261008-07, D-20261017-09; rulings §9, §14): before a deploy only the failing-first
// arms (+ the one review on a data-write path, + the §14 two-context seeds) and `dk dry`; verify_consistency `all`/`varlen`,
// the browser verify_*.mjs suites, the shots runner and QA run AFTER the deploy. Advice alone broke it twice: 17 Oct
// (a handover said postgates ran before deploy; a live data-loss fix waited 3.5 h) and 23 Oct (U3a5 ran 8 consistency rounds
// pre-deploy, 4.5 h). dk postgates already refuses before a real deploy (exit 41); this is the same gate on the suites.
//
// Every heavy suite imports this module first (directly, or through harness.mjs), and on import it refuses, exit 41, when
// the code under test is not live: the tree's HEAD is not the live record or one of its ancestors, or www/ src/ gateway/
// carry uncommitted changes. Allowed:
//   (a) HEAD is the live record, or an ancestor of it, with those paths clean;
//   (b) DK_PREDEPLOY_GATE names the rulings §14 two-context class ('§14 <why>' / 'two-context <why>'), parsed as dk_postgates.sh;
//   (c) a targeted failing-first arm `dk arms` launched: the kit's dk_new_run exports DK_RUN=$DK_ROOT/runs/<NAME>-<stamp>-arms
//       (made, holding its release.env copy) and NAME; the arm's suite inherits both. Only a single verify_<x>.mjs that the
//       release env's ARMS names (<x> or gw:<x>) passes on this key; consistency all / varlen, run_all and shots_matrix are
//       refused even inside dk arms (owner, rc-a 23 Oct), bar (b);
//   (d) one targeted verify_consistency scenario (`verify_consistency.mjs <scenario>`, any mode but all/varlen);
//   (e) dk postgates' own run (DK_RUN ...-postgates): it refuses itself (41) before a real deploy of its HEAD; it alone may carry
//       DK_PREDEPLOY_GATE='fix-forward …' (it checks the parts against live's red gates), refused everywhere else.
// The live record is read as dk check reads it: the build id jarrah serves (build.json over one read-only ssh to DK_HOST,
// default jarrah; or the kit's stub DK_LIVE_FILE, its build_json= line), then the commit whose subject holds
// "record build <id>". Offline or unknown refuses, bar (b)/(c)/(e).
//
//   node dev/predeploy_guard.mjs <suite> [args...]   -- the shell entry (dev/predeploy_guard.sh): exit 0 allowed, 41 refused
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const REFUSED = 41;
const TREE = path.join(import.meta.dirname, '..');
const HOW = "run the failing-first arms through dk arms + dk dry, then dk deploy, then the heavy suites (or dk postgates)";
const S14 = "Only a rulings §14 two-context change (seat, hand-off tile, presence, runner) may gate first: set DK_PREDEPLOY_GATE='§14 <why>'.";
const RULE = 'deploy first (owner: minimal tests, deploy, then extensive tests; D-20261017-09, D-20261023-04)';

/// What heavy suite argv runs, or null when it is not one (a test file, a probe, shot.mjs, a single-feature shot).
/// argv is process.argv's shape: [node, script, ...args].
export function heavyKind(argv) {
	const b = path.basename(argv[1] || '');
	if (b === 'verify_consistency.mjs') {
		const m = argv[2] || 'all', w = argv[3] || 'all';
		if (m === 'all') return 'verify_consistency all';
		if (m === 'varlen' && w !== 'report') return `verify_consistency varlen ${w}`;
		return null;			// (d) one targeted scenario: a failing-first check
	}
	if (/^verify_.+\.mjs$/.test(b)) return b.replace(/\.mjs$/, '');
	if (b === 'shots_matrix.mjs') return 'shots_matrix';
	if (b === 'run_all.sh') return 'run_all';
	return null;
}

/// DK_PREDEPLOY_GATE as dk_postgates.sh parses it: '' none; *§14* or *two-context* the exception; 'fix-forward <part>[, <part>…]'
/// (each 'by-role' or '<engine> <vp>') postgates' own form, admitted only inside a dk postgates run; anything else is refused.
export function parseGate(v) {
	v = v || '';
	if (!v) return { kind: 'none' };
	if (v.includes('§14') || v.includes('two-context')) return { kind: 's14', why: v };
	if (v.startsWith('fix-forward ')) {
		const parts = v.slice(12).split(',').map((p) => p.trim().replace(/\s+/g, ' ')).filter(Boolean);
		const bad = parts.find((p) => p !== 'by-role' && !/^\S+ \S+$/.test(p));
		if (!parts.length || bad !== undefined) return { kind: 'bad', msg: `DK_PREDEPLOY_GATE='${v}' is not a legal fix-forward form (${parts.length ? `'${bad}' is neither 'by-role' nor '<engine> <vp>'` : 'it names no part'}). ${S14}` };
		return { kind: 'ff', why: v, msg: `DK_PREDEPLOY_GATE='${v}' is dk postgates' fix-forward form, which runs only inside dk postgates (it parses and checks the parts against live's red gates); a suite run by hand takes only the §14 class. ${S14}` };
	}
	return { kind: 'bad', msg: `DK_PREDEPLOY_GATE='${v}' names neither the rulings §14 two-context class nor anything else this guard admits. ${S14}` };
}

/// The kit run this process is inside, keyed on what dk_new_run exports: 'arms', 'postgates', or null.
export function kitRun(env) {
	const r = env.DK_RUN || '', n = env.NAME || '';
	if (!r || !n) return null;
	const m = /^(.+)-(\d{8}_\d{6}_\d+)-(arms|postgates)$/.exec(path.basename(r));
	if (!m || m[1] !== n || path.basename(path.dirname(r)) !== 'runs') return null;
	try { if (!fs.statSync(path.join(r, 'release.env')).isFile()) return null; } catch { return null; }
	return m[3];
}

/// The arms a kit run's release.env names in ARMS (the copy dk_new_run made), as a list; [] when unreadable.
export function envArms(run) {
	let t = '';
	try { t = fs.readFileSync(path.join(run, 'release.env'), 'utf8'); } catch { return []; }
	const l = t.split('\n').filter((x) => /^\s*(export\s+)?ARMS=/.test(x)).pop() || '';
	return l.replace(/^\s*(export\s+)?ARMS=/, '').trim().replace(/^(['"])(.*)\1$/, '$2').split(/\s+/).filter(Boolean);
}

/// The build id live serves, as dk_live reads it: { build } or { err }.
export function liveBuild(env) {
	let text;
	if (env.DK_LIVE_FILE) {
		try { text = (fs.readFileSync(env.DK_LIVE_FILE, 'utf8').split('\n').find((l) => l.startsWith('build_json=')) || '').slice(11); }
		catch (e) { return { err: `cannot read DK_LIVE_FILE ${env.DK_LIVE_FILE}: ${e.code || e.message}` }; }
	} else {
		const host = env.DK_HOST || 'jarrah';
		const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, "tr -d '\\n' < ~/usr/steel-prod/www/daimond/build.json"],
			{ encoding: 'utf8', timeout: 25000 });
		if (r.status !== 0) return { err: `cannot read the live build from ${host} (ssh ${r.error ? r.error.code : 'exit ' + r.status}: ${(r.stderr || '').trim().split('\n').pop() || 'no output'})` };
		text = r.stdout;
	}
	const m = /"build"\s*:\s*"([0-9a-f]{12})"/.exec(text || '');
	return m ? { build: m[1] } : { err: `the live build.json names no 12-hex build: ${(text || '').slice(0, 120) || 'empty'}` };
}

const git = (tree, ...a) => spawnSync('git', ['-C', tree, ...a], { encoding: 'utf8' });

/// Whether the code under test in tree is live. { ok, why } or { ok: false, msg }.
export function liveCheck(tree, env) {
	const head = git(tree, 'rev-parse', '-q', '--verify', 'HEAD^{commit}').stdout.trim();
	if (!head) return { ok: false, msg: `cannot read HEAD in ${tree}` };
	const lb = liveBuild(env);
	if (lb.err) return { ok: false, msg: `the live record is unknown: ${lb.err}` };
	const rec = git(tree, 'log', '--all', '-F', `--grep=record build ${lb.build}`, '--format=%H', '-n', '1').stdout.trim();
	if (!rec) return { ok: false, msg: `live serves ${lb.build}, and no commit "record build ${lb.build}" is in this repo (fetch it, or dk post records it)` };
	if (git(tree, 'merge-base', '--is-ancestor', head, rec).status !== 0)
		return { ok: false, msg: `HEAD ${head.slice(0, 12)} is not live: it is neither the live record ${rec.slice(0, 12)} (build ${lb.build}) nor one of its ancestors` };
	const dirty = git(tree, 'status', '--porcelain', '--untracked-files=no', '--', 'www', 'src', 'gateway').stdout.trim();
	if (dirty) return { ok: false, msg: `HEAD ${head.slice(0, 12)} is live, but www/ src/ gateway/ carry uncommitted changes, so the code under test is not (${dirty.split('\n').length} file(s), first: ${dirty.split('\n')[0].trim()})` };
	return { ok: true, why: `HEAD ${head.slice(0, 12)} is live (record ${rec.slice(0, 12)}, build ${lb.build})` };
}

/// The decision for one run: { allow: true, why } or { allow: false, msg }.
export function decide({ argv = process.argv, env = process.env, tree = TREE } = {}) {
	const kind = heavyKind(argv);
	if (!kind) return { allow: true, why: 'not a heavy suite' };
	const g = parseGate(env.DK_PREDEPLOY_GATE);
	if (g.kind === 'bad') return { allow: false, msg: `${kind}: ${g.msg}` };
	if (g.kind === 's14') return { allow: true, why: `${kind} BEFORE deploy, on the rulings §14 two-context exception: ${g.why}` };
	const k = kitRun(env);
	// Fix-forward: dk postgates checked the parts against live's red gates before it ran this suite; nowhere else may use it.
	if (g.kind === 'ff') return k === 'postgates' ? { allow: true, why: `${kind}: dk postgates' fix-forward (${path.basename(env.DK_RUN)}): ${g.why}` } : { allow: false, msg: `${kind}: ${g.msg}` };
	let armWhy = '';
	if (k === 'arms') {
		const x = /^verify_(.+)$/.exec(kind), arms = envArms(env.DK_RUN);
		if (x && x[1] !== 'consistency' && arms.some((a) => a.replace(/^gw:/, '') === x[1]))
			return { allow: true, why: `${kind}: a targeted failing-first arm of dk arms, named in ARMS (${path.basename(env.DK_RUN)})` };
		armWhy = ` dk arms runs only a targeted arm before the deploy: one verify_consistency scenario, or one verify_<x>.mjs its release env's ARMS names (ARMS='${arms.join(' ')}'); ${kind} is neither.`;
	}
	if (k === 'postgates') return { allow: true, why: `${kind}: inside dk postgates (${path.basename(env.DK_RUN)}), which gates itself` };
	const c = liveCheck(tree, env);
	if (c.ok) return { allow: true, why: `${kind}: ${c.why}` };
	return { allow: false, msg: `${kind} runs AFTER the real deploy, ${RULE}. ${c.msg}.${armWhy} Instead: ${HOW}; a single scenario (verify_consistency.mjs <scenario>) stays allowed as a failing-first check. ${S14}` };
}

/// Refuses (exit 41) or returns. log and exit are seams for the tests.
export function predeployGuard(opts = {}, { log = (s) => console.error(s), exit = (c) => process.exit(c) } = {}) {
	const d = decide(opts);
	if (d.allow) { if (d.why !== 'not a heavy suite') log(`predeploy guard: ${d.why}`); return d; }
	log(`dk REFUSED(${REFUSED}): ${d.msg}`);
	exit(REFUSED);
	return d;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
	// The shell entry: argv after the script is the suite and its args.
	const [suite, ...rest] = process.argv.slice(2);
	if (!suite) { console.error('usage: node dev/predeploy_guard.mjs <suite> [args...]'); process.exit(2); }
	predeployGuard({ argv: [process.argv[0], suite, ...rest] });
} else {
	predeployGuard();	// imported by a suite: decides on the suite's own argv
}
