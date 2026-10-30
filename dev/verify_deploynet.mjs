// gateway: none
// verify_deploynet.mjs — `DAIMOND_NET` in dev/deploy.sh: unset is production, byte for byte,
// and `test` names nothing of production's (D-20261006-24, tn-U1b; design
// ~/usr/code/ai/claude/specs/daimond_testnet_design_20261025.md §R1, §R3, §5 U1b).
//
// Every run of deploy.sh here is a whole release, dry and real, against a fixture tree that
// plays the repository, a fixture mirror and a fixture fe2o3. The tools that leave this
// machine -- ssh, scp, rsync, curl, sudo, systemctl -- are PATH shims that log their argv and
// the sha256 of their stdin and answer as jarrah would; the tools a release runs inside the
// tree (publish.mjs, manifest.mjs, repro-check.sh, …) are committed stubs that log the same
// way. NOTHING REACHES JARRAH OR ANY NETWORK. A real run happens inside a transient
// `dk-…-real` user unit, so trap 14's unit check passes as it does under `dk deploy`.
//
//   1. Unset means production. The base deploy.sh (git, at the release record BASE) and
//      this tree's, with DAIMOND_NET unset and `=live`, dry and real: after STAMP is
//      normalised every call log equals the base's.
//   2. The arm has teeth. NET_UNIT, then NET_PORT, mutated in a scratch copy of live.env:
//      each turns arm 1's real-mode comparison red.
//   3. Test is test. Under DAIMOND_NET=test, dry and real, the call logs name none of
//      production's dir, www, host name, port or unit, the gateway goes in as NET_EXE
//      (daimond_gw_test, never daimond_gateway on the host), and the four
//      `skipped (test net)` lines are printed; nothing appends the chain, carries into the
//      mirror or writes production's gate record (0h's gate_evidence landed / owe).
//   4. `--check-net` prints the frozen live profile for unset and `live`, the test one for
//      `test`; an unknown net, a missing key and an unknown key are refused; live.env keeps
//      `~` unexpanded; NET_SEAL=none is refused on live and on a profile sharing live's paths.
//   5. `verify/manifest.mjs --no-log` leaves transparency.jsonl byte-unchanged and writes a
//      manifest.json byte-equal to a chained run's on the same tree.
//   6. First ship (tn-U1d): a test www with no daimond/ ships with no backup and names its back-out;
//      a test www with daimond/ but no build.json, and live either way, still die at step 6, and
//      live's call log equals the base's.
//   7. Owed gates (tn-U1d): test never reads live's owed ledger; live carries its owed red (DRY-OWED,
//      31 Oct 2026) and completes, with the call log of the base whose live owes nothing red; a red
//      filed against the shipped www refuses on both.
//   8. Trap 6 (tn-U1d): with the mirror ahead of source and no served-builds log, a NET_SEAL=none
//      net passes 0c with its skip line; live still refuses, call log and refusal equal to base's.
//  10. No mirror on a NET_SEAL=none net (tn-U1d): the mirror pins another fe2o3 and is sealed off
//      (entries 000); a test run, dry and real, completes with no mirror path in its call log and no
//      lock left there; live with the same set-up refuses, output and call log equal to base's.
//   9. Trap 14 under a net (tn-U1d): the kit names a net's unit dk-<NAME>-<suffix>-<net>, so a
//      test run in dk-x-real-test (and -rollback-test) passes; live there refuses; live in dk-x-real passes.
//
//   node dev/verify_deploynet.mjs                  # this tree's deploy.sh
//   node dev/verify_deploynet.mjs --deploy PATH    # another deploy.sh as "new" (a red proof)
//
// The fixtures live under /tmp/tn-u1b-<slot> and are removed at the end.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
// The test profile's paths, read from test.env, so no testnet dir is a literal here (D-20261026-02).
const TESTNET = Object.fromEntries(fs.readFileSync(path.join(REPO, 'deploy', 'net', 'test.env'), 'utf8').split('\n')
	.map(l => l.match(/^(NET_[A-Z_]+)='([^']*)'$/)).filter(Boolean).map(m => [m[1], m[2]]));
// The base is the newest release record this branch is on, so a rebase moves the comparison with it.
const BASE = spawnSync('git', ['-C', REPO, 'log', '-1', '--format=%h', '--grep=^release: record build'], { encoding: 'utf8' }).stdout.trim();
if (!BASE) { console.error('verify_deploynet: no release record in this branch\'s history'); process.exit(2); }
const di   = process.argv.indexOf('--deploy');
const NEW  = di >= 0 ? path.resolve(process.argv[di + 1]) : path.join(REPO, 'dev', 'deploy.sh');
const ONLY = (() => { const i = process.argv.indexOf('--arm'); return i >= 0 ? process.argv[i + 1].split(',') : null; })();
// Under /tmp: the fixture repositories commit with the global hooks off, which is allowed only
// for scratch repositories there, and the whole of it is a few kilobytes.
const ROOT = path.join('/tmp', `tn-u1b-${process.env.RC_SLOT || 'solo'}`);
const FX   = path.join(ROOT, 'fx');			// one fixed path, so two runs' logs can be equal
const FP   = 'f'.repeat(64);				// the engine source every run names
const NOTE = 'Testnet profile proof: a fixture release that ships nothing';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  PASS  ${name}`); }
	else    { fail++; console.log(`  FAIL  ${name}`); if (detail) console.log(String(detail).split('\n').slice(0, 14).map(l => `        | ${l}`).join('\n')); }
};
const want = arm => !ONLY || ONLY.includes(String(arm));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const write = (p, s, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); if (mode) fs.chmodSync(p, mode); };

const GIT_ENV = {
	GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
	GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
	GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
	GIT_CONFIG_KEY_1: 'init.defaultBranch', GIT_CONFIG_VALUE_1: 'main',
};
const git = (cwd, ...a) => {
	const r = sh('git', a, { cwd, env: { ...process.env, ...GIT_ENV } });
	if (r.status !== 0) throw new Error(`git ${a.join(' ')} in ${cwd}: ${r.stderr}`);
	return r.stdout.trim();
};

// ── The shims: jarrah, played by a state directory ─────────────────────────
//
// One script under six names. It logs `name argv… | stdin <sha>` with any YYYYMMDD_HHMMSS
// stamp normalised, then answers by what the remote command asks. The gateway's record is
// kept across calls, so the swap, the confirm and the served-builds append all see what a
// real jarrah would.
const SHIM = String.raw`#!/bin/bash
me="$(basename "$0")"
norm() { sed -E 's/[0-9]{8}_[0-9]{6}/STAMP/g'; }
in="$(cat)"
sum="$(printf '%s' "$in" | norm | sha256sum | cut -c1-16)"
{ printf '%s' "$me"; for a in "$@"; do printf ' «%s»' "$a"; done; printf ' | stdin %s\n' "$sum"; } | norm >> "$SHIM_LOG"
S="$SHIM_STATE"; last="${'$'}{!#}"
# The gateway's name on the host is the net's NET_EXE: read it off the command that asks.
gw="$(printf '%s' "$last" | sed -nE 's/.*sha256sum ([A-Za-z0-9_]+) daimond_ctl.*/\1/p')"
sums() { if [ -f "$S/prov" ]; then for n in $gw daimond_ctl app.jdat; do
		printf '%s  %s\n' "$(sed -n "s/^sha256.$n=//p" "$S/prov")" "$n"; done
	else for n in $gw daimond_ctl app.jdat; do printf '%064d  %s\n' 0 "$n"; done; fi; }
case "$me" in
ssh)
	case "$last" in
	*__GW_PROVENANCE__*) sums; echo __GW_PROVENANCE__; if [ -f "$S/prov" ]; then cat "$S/prov"; else echo __GW_PROVENANCE_ABSENT__; fi ;;
	*'sha256sum '*' daimond_ctl'*) sums ;;
	*'cat > '*'gateway.provenance.new && mv '*) printf '%s\n' "$in" > "$S/prov" ;;
	*'cat > '*'gateway.provenance.new'*) printf '%s\n' "$in" > "$S/prov.new" ;;
	*'mv '*'.new '*' && mv daimond_ctl.new daimond_ctl'*) [ ! -f "$S/prov.new" ] || mv "$S/prov.new" "$S/prov" ;;
	*'if [ -f '*'served-builds.log'*) if [ -f "$S/served" ]; then cat "$S/served"; else printf %s __TRAP6_LOG_ABSENT__; fi ;;
	*'served-builds.log || cat > '*) [ -f "$S/served" ] || printf '%s\n' "$in" > "$S/served" ;;
	*'cat >> '*'served-builds.log'*) printf '%s\n' "$in" >> "$S/served" ;;
	*'test -f '*'app.jdat'*) exit 0 ;;
	# The net's www, as arm 6 sets it: no daimond/ at all, or a daimond/ without build.json.
	*__WWW_FIRST_SHIP__*) [ ! -f "$S/www_absent" ] || echo __WWW_ABSENT__ ;;
	*'test -f daimond/build.json'*) [ ! -f "$S/www_absent" ] && [ ! -f "$S/www_nobuild" ] || exit 1 ;;
	*'cat '*'app.jdat'*) cat "$SHIM_JDAT" ;;
	*'curl '*'/api/health'*) printf '{"ok":true,"store_write_ok":true}' ;;
	*'curl '*'/build.json'*|*'cat '*'build.json'*) printf '{"build":"0123456789ab"}' ;;
	esac ;;
curl)
	case " $* " in *' -w '*) printf 200 ;; *build.json*) printf '{"build":"0123456789ab"}' ;; *) printf '{"ok":true}' ;; esac ;;
esac
exit 0
`;

// The tools a release runs from the tree, as committed stubs: each logs as the shims do.
const STUB_NODE = `import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const a = process.argv.slice(2), me = process.argv[1].split('/').slice(-2).join('/');
fs.appendFileSync(process.env.SHIM_LOG, 'tool ' + me + a.map(x => ' «' + x.replace(/[0-9]{8}_[0-9]{6}/g, 'STAMP').replace(/\\/daimond-hand-stage\\.\\w+/, '/STAGE') + '»').join('') + '\\n');
if (me === 'dev/publish.mjs' && a[0] === '--resolve-pin') {
	const dir = process.env.FX_FE2O3;
	const rev = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	process.stdout.write('rev=' + rev + '\\nurl=' + dir + '.git\\ndir=' + dir + '\\ncrates=fe2o3_core\\n');
}
if (me === 'dev/staleguard.mjs') process.stdout.write('${FP}\\n');
if (me === 'dev/gate_evidence.mjs' && a[0] === 'check') {
	// Arm 7: FX_GATE=owed has this tree's by-role owed and the live tree's owed red; =pending the same with nothing red on
	// live; =red has this tree's own red filed.
	const g = process.env.FX_GATE || '';
	if (g === 'owed' || g === 'pending' || g === 'red') {
		process.stdout.write('gate by-role www ' + (a[1] || '').slice(0, 12) + ': REFUSED. ' + (g === 'red' ? '3 bad parts' : 'no byrole.json') + '\\n');
		process.exit(20);
	}
	process.stdout.write('gate by-role: ok\\n');
}
if (me === 'dev/gate_evidence.mjs' && a[0] === 'check-owed' && process.env.FX_GATE === 'owed') {
	process.stdout.write('gate evidence: gates owed for live www d7c2167f53d7 are RED\\ncarried owed red: by-role from live www d7c2167f53d7 (head 0a1b2c3d4e5f, run /cons/run7)\\n');
	process.exit(20);
}
`;
const STUB_SH = `#!/bin/bash
{ printf 'tool %s' "dev/$(basename "$0")"; for a in "$@"; do printf ' «%s»' "$a"; done; printf '\\n'; } >> "$SHIM_LOG"
exit 0
`;

// ── The fixture: tree, mirror and fe2o3, built fresh for every run ─────────
//
// Committed with fixed names and dates, so HEAD is the same sha in every run. deploy.sh and
// deploy/net/ are left UNTRACKED: they are not under a shipped path, the dirty check passes
// over them, and the base and the new script then run on one commit.
function fixture(deploySrc, liveEnv) {
	fs.rmSync(FX, { recursive: true, force: true });
	const T = path.join(FX, 'tree'), M = path.join(FX, 'mirror'), F = path.join(FX, 'fe2o3');
	const B = path.join(FX, 'bin'), S = path.join(FX, 'state');
	for (const d of [B, S, path.join(FX, 'tmp'), path.join(FX, 'runs')]) fs.mkdirSync(d, { recursive: true });
	for (const n of ['ssh', 'scp', 'rsync', 'curl', 'sudo', 'systemctl']) write(path.join(B, n), SHIM, 0o755);
	write(path.join(B, 'cargo'), STUB_SH.replace('dev/$(basename "$0")', 'cargo'), 0o755);
	write(path.join(B, 'rustc'), '#!/bin/bash\necho "rustc 1.90.0 (fixture)"\n', 0o755);

	// fe2o3, pushed to a bare origin so 0f's ls-remote finds the pin.
	write(path.join(F, 'fe2o3_core', 'Cargo.toml'), '[package]\nname = "oxedyne_fe2o3_core"\n');
	write(path.join(F, 'fe2o3_core', 'src', 'lib.rs'), '// fixture\n');
	git(FX, 'init', '-q', '--bare', 'fe2o3.git');
	git(F, 'init', '-q'); git(F, 'add', '-A'); git(F, 'commit', '-q', '-m', 'fe2o3 fixture');
	git(F, 'remote', 'add', 'origin', path.join(FX, 'fe2o3.git')); git(F, 'push', '-q', 'origin', 'HEAD:main');

	// The tree.
	const nodeStubs = ['dev/publish.mjs', 'dev/stamp-build.mjs', 'dev/staleguard.mjs', 'dev/gate_evidence.mjs',
		'dev/wasm-fastpath.mjs', 'verify/hand.mjs', 'verify/manifest.mjs'];
	for (const s of nodeStubs) write(path.join(T, s), STUB_NODE);
	for (const s of ['dev/breakproof_devshm.sh', 'dev/runner_n1_check.sh', 'dev/repro-check.sh', 'dev/vendor_austenite.sh'])
		write(path.join(T, s), STUB_SH, 0o755);
	write(path.join(T, 'package.json'), '{"type":"module"}\n');
	write(path.join(T, '.gitignore'), 'target/\n');
	const chain = JSON.stringify({ seq: 0, build: '0123456789aa', bundle: 'a'.repeat(64) }) + '\n';
	write(path.join(T, 'verify', 'transparency.jsonl'), chain);
	write(path.join(T, 'www', 'index.html'), '<!doctype html>\n');
	write(path.join(T, 'www', 'manifest.json'), '{"build":"0123456789ab"}\n');
	write(path.join(T, 'gateway', 'Cargo.toml'), '[package]\nname = "daimond_gateway"\n[dependencies]\noxedyne_fe2o3_core = { path = "../../fe2o3/fe2o3_core" }\n');
	write(path.join(T, 'gateway', 'Cargo.lock'), '# fixture lock\n');
	write(path.join(T, 'gateway', 'src', 'main.rs'), 'fn main() {}\n');
	write(path.join(T, 'gateway', 'app.jdat'), '{ "listen_port": "9002" }\n');
	git(T, 'init', '-q'); git(T, 'add', '-A'); git(T, 'commit', '-q', '-m', 'tree fixture');
	// Built binaries, newer than every source their dep-info names (trap 2's freshness).
	const old = new Date('2026-01-01T00:00:00Z');
	for (const p of ['gateway/Cargo.toml', 'gateway/Cargo.lock', 'gateway/src/main.rs']) fs.utimesSync(path.join(T, p), old, old);
	for (const p of ['fe2o3_core/Cargo.toml', 'fe2o3_core/src/lib.rs']) fs.utimesSync(path.join(F, p), old, old);
	for (const b of ['daimond_gateway', 'daimond_ctl']) {
		const bin = path.join(T, 'gateway', 'target', 'release', b);
		write(bin, `fixture ${b}\n`, 0o755);
		write(bin + '.d', `${bin}: ${path.join(T, 'gateway', 'src', 'main.rs')} ${path.join(F, 'fe2o3_core', 'src', 'lib.rs')}\n`);
		fs.utimesSync(bin + '.d', old, old);
	}
	// What is under test, untracked.
	write(path.join(T, 'dev', 'deploy.sh'), deploySrc, 0o755);
	for (const n of ['live.env', 'test.env']) {
		const src = path.join(REPO, 'deploy', 'net', n);
		if (fs.existsSync(src)) write(path.join(T, 'deploy', 'net', n), fs.readFileSync(src, 'utf8'));
	}
	if (liveEnv) write(path.join(T, 'deploy', 'net', 'live.env'), liveEnv);

	// The mirror, a clone of a bare remote, so 3b's commit and push have somewhere to go.
	write(path.join(FX, 'mseed', 'verify', 'transparency.jsonl'), chain);
	write(path.join(FX, 'mseed', 'dev', 'build-wasm.sh'), STUB_SH, 0o755);
	git(path.join(FX, 'mseed'), 'init', '-q'); git(path.join(FX, 'mseed'), 'add', '-A'); git(path.join(FX, 'mseed'), 'commit', '-q', '-m', 'mirror');
	git(FX, 'clone', '-q', '--bare', path.join(FX, 'mseed'), 'mirror.git');
	git(FX, 'clone', '-q', path.join(FX, 'mirror.git'), M);
	return { T, M, F, B, S };
}

// One whole release. `mode` is `dry` or `real`; `net` is undefined (unset) or a name.
let unitN = 0;
function release(deploySrc, mode, net, liveEnv, www = '', extra = {}) {
	const { T, M, F, B, S } = fixture(deploySrc, liveEnv);
	if (www) fs.writeFileSync(path.join(S, www), '');
	// Arm 8: the mirror carries a seq source has not, committed as a ship would leave it.
	if (extra.FX_MIRROR_AHEAD) {
		fs.appendFileSync(path.join(M, 'verify', 'transparency.jsonl'),
			JSON.stringify({ seq: 1, build: '0123456789ac', bundle: 'c'.repeat(64) }) + '\n');
		git(M, 'commit', '-q', '-am', 'mirror ahead'); git(M, 'push', '-q', 'origin', 'HEAD');
	}
	// Arm 10: the mirror pins another fe2o3 (a later public ship), then is sealed off, so any
	// read or write of it at any step fails.
	if (extra.FX_MIRROR_OFF) {
		write(path.join(M, 'hand', 'Cargo.toml'), '[dependencies]\noxedyne_fe2o3_core = { git = "x", rev = "' + 'd'.repeat(40) + '" }\n');
		git(M, 'add', '-A'); git(M, 'commit', '-q', '-m', 'mirror pins another fe2o3'); git(M, 'push', '-q', 'origin', 'HEAD');
		// Every entry 000 and the mirror itself search-only: its path still resolves (deploy.sh
		// takes the realpath before it knows the net), and nothing in it can be read, listed or written.
		for (const e of fs.readdirSync(M)) fs.chmodSync(path.join(M, e), 0o000);
		fs.chmodSync(M, 0o100);
	}
	const log = path.join(FX, 'calls.log');
	fs.writeFileSync(log, '');
	const env = {
		HOME: os.homedir(), LANG: 'C.UTF-8', TMPDIR: path.join(FX, 'tmp'),
		PATH: `${B}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
		MIRROR: M, DAIMOND_DEPLOY_RUN_ROOT: path.join(FX, 'runs'), DAIMOND_WASM_TARGET_DIR: path.join(FX, 'wasm'),
		SHIM_LOG: log, SHIM_STATE: S, SHIM_JDAT: path.join(T, 'gateway', 'app.jdat'), FX_FE2O3: F,
		...GIT_ENV, ...extra,
	};
	if (net !== undefined) env.DAIMOND_NET = net;
	const args = [path.join(T, 'dev', 'deploy.sh'), ...(mode === 'dry' ? ['--dry-run'] : ['--yes']), '--note', NOTE, '--engine-source', FP];
	let r;
	if (mode === 'dry') {
		r = sh('bash', args, { cwd: T, env, input: '', timeout: 240000 });
	} else {
		// Trap 14: a real run only inside dk-<NAME>-real.service, or -real-<net> under a net as the
		// kit names it. The unit is transient and collected.
		const unit = `dk-tnu1b${process.pid}x${++unitN}-real${net && net !== 'live' ? '-' + net : ''}`;
		const sr = ['--user', '--quiet', '--wait', '--pipe', '--collect', `--unit=${unit}`, `--working-directory=${T}`];
		for (const [k, v] of Object.entries(env)) sr.push('-E', `${k}=${v}`);
		const parent = { ...process.env }; delete parent.DBUS_SESSION_BUS_ADDRESS;
		r = sh('systemd-run', [...sr, 'bash', ...args], { env: parent, input: '', timeout: 240000 });
	}
	if (extra.FX_MIRROR_OFF) { fs.chmodSync(M, 0o755); for (const e of fs.readdirSync(M)) fs.chmodSync(path.join(M, e), 0o755); }
	const out = (r.stdout || '') + (r.stderr || '');
	return { rc: r.status, out, calls: fs.readFileSync(log, 'utf8'), M };
}

const firstDiff = (a, b) => {
	const x = a.split('\n'), y = b.split('\n');
	for (let i = 0; i < Math.max(x.length, y.length); i++)
		if (x[i] !== y[i]) return `line ${i + 1}\n  base: ${x[i] ?? '<none>'}\n  new:  ${y[i] ?? '<none>'}`;
	return 'identical';
};

const baseSrc = sh('git', ['-C', REPO, 'show', `${BASE}:dev/deploy.sh`]).stdout;
const newSrc  = fs.readFileSync(NEW, 'utf8');
if (!baseSrc) { console.log(`cannot read dev/deploy.sh at ${BASE}`); process.exit(2); }
console.log(`base deploy.sh ${BASE}; new ${NEW}; fixtures under ${FX}`);

// Live-path changes made on purpose since BASE, each named with its finding. Arm 1 drops the
// base's lines `was` matches and the new lines `now` matches before comparing, so every OTHER
// difference is still red. A release records a new BASE, and this list is emptied with it.
const SINCE_BASE = [
	{ why: 'QA gwmain M1: daimond_ctl is backed up with the gateway',
	  was: /^ssh «jarrah» «cd ~\/usr\/daimond-gateway && cp daimond_gateway daimond_gateway\.bak-STAMP && cp app\.jdat /,
	  now: /^ssh «jarrah» «cd ~\/usr\/daimond-gateway && cp daimond_gateway daimond_gateway\.bak-STAMP && cp daimond_ctl daimond_ctl\.bak-STAMP && cp app\.jdat / },
	{ why: 'QA gwmain M1: its three backups are pruned with the gateway\'s',
	  was: /^ssh «jarrah» «cd ~\/usr\/daimond-gateway && ls -1t daimond_gateway\.bak-\* 2>\/dev\/null \| tail -n \+4 \| xargs -r rm -f; ls -1t app\.jdat\.bak-/,
	  now: /^ssh «jarrah» «cd ~\/usr\/daimond-gateway && ls -1t daimond_gateway\.bak-\* 2>\/dev\/null \| tail -n \+4 \| xargs -r rm -f; ls -1t daimond_ctl\.bak-\* 2>\/dev\/null \| tail -n \+4 \| xargs -r rm -f; ls -1t app\.jdat\.bak-/ },
	{ why: 'QA gwmain P2-2: step 7 reads gateway.env\'s names before the backup',
	  was: null,
	  now: /^ssh «-o» «ConnectTimeout=10» «jarrah» «cd ~\/usr\/daimond-gateway && for n in DAIMOND_NETWORK [A-Z0-9_ ]*; do grep -qE "\^\(export \)\?\$n=\." gateway\.env 2>\/dev\/null \|\| echo \$n; done» \| stdin [0-9a-f]*$/ },
	{ why: 'QA gwmain P3-1: step 7 runs the new gateway\'s --check-config before the swap',
	  was: null,
	  now: /^ssh «-o» «ConnectTimeout=10» «jarrah» «cd ~\/usr\/daimond-gateway && bash -s -- \.\/daimond_gateway\.new» \| stdin [0-9a-f]*$/ },
];
const settle = (calls, side) => calls.split('\n').filter(l => !SINCE_BASE.some(d => d[side] && d[side].test(l))).join('\n');

const base = {};
const baseRun = mode => base[mode] ??= release(baseSrc, mode);
const ran = r => r.rc === 0 && /== Done/.test(r.out);

// ── 1. Unset means production, byte for byte ───────────────────────────────
if (want(1) || want(2)) {
	console.log('\n1. DAIMOND_NET unset and =live: every call log equals the base\'s, dry and real');
	for (const mode of ['dry', 'real']) {
		const b = baseRun(mode);
		check(`1 base ${mode} run completes (${b.calls.split('\n').length - 1} calls)`, ran(b), b.out.slice(-1500));
		if (!want(1)) continue;
		for (const net of [undefined, 'live']) {
			const n = release(newSrc, mode, net);
			const tag = `1 new ${mode}, DAIMOND_NET ${net === undefined ? 'unset' : '=' + net}`;
			check(`${tag}: completes`, ran(n), n.out.slice(-1500));
			const [bs, ns] = [settle(b.calls, 'was'), settle(n.calls, 'now')];
			check(`${tag}: call log identical to base, but for SINCE_BASE`, bs === ns, firstDiff(bs, ns));
		}
	}
}

// ── 2. Teeth: one live value moved turns arm 1 red ─────────────────────────
if (want(2)) {
	console.log('\n2. A mutated live.env (NET_UNIT, then NET_PORT) turns the real-mode comparison red');
	const live = fs.readFileSync(path.join(REPO, 'deploy', 'net', 'live.env'), 'utf8');
	for (const [k, from, to] of [['NET_UNIT', "NET_UNIT='daimond-gateway'", "NET_UNIT='daimond-gatewayX'"],
	                             ['NET_PORT', "NET_PORT='9002'", "NET_PORT='9012'"]]) {
		const mut = live.replace(from, to);
		if (mut === live) { check(`2 ${k}: mutation applies`, false, `no ${from} in live.env`); continue; }
		const n = release(newSrc, 'real', undefined, mut);
		check(`2 ${k} mutated: the call log differs from base`, n.calls !== baseRun('real').calls,
			'identical: arm 1 cannot see this value');
	}
}

// ── 3. Test is test ────────────────────────────────────────────────────────
if (want(3)) {
	console.log('\n3. DAIMOND_NET=test names nothing of production\'s, and skips the public chain');
	const FORBID = [['~/usr/daimond-gateway', /~\/usr\/daimond-gateway/], ['steel-prod/www/daimond', /steel-prod\/www\/daimond/],
		['daimond.oxedyne.com', /(?<![\w.-])daimond\.oxedyne\.com/], ['127.0.0.1:9002', /127\.0\.0\.1:9002/],
		['restart daimond-gateway', /restart daimond-gateway\b/]];
	const SKIPS = ['1. Carve the mirror', '3. Carve again', '3b. Commit and push the mirror', '4. repro-check'];
	for (const mode of ['dry', 'real']) {
		const n = release(newSrc, mode, 'test');
		check(`3 test ${mode}: completes`, ran(n), n.out.slice(-1500));
		const hits = FORBID.filter(([, re]) => re.test(n.calls)).map(([s]) => s);
		check(`3 test ${mode}: call log names none of production's`, hits.length === 0,
			hits.join(', ') + '\n' + n.calls.split('\n').filter(l => FORBID.some(([, re]) => re.test(l))).slice(0, 6).join('\n'));
		const missing = SKIPS.filter(s => !n.out.includes(`${s} skipped (test net)`));
		check(`3 test ${mode}: the four skipped (test net) lines`, missing.length === 0, 'missing: ' + missing.join('; '));
		const names = [TESTNET.NET_GW_DIR, `${TESTNET.NET_WWW_PARENT.replace(/^~\/usr\//, '')}/daimond`, TESTNET.NET_UNIT];
		const named = names.filter(s => n.calls.includes(s));
		check(`3 test ${mode}: names the testnet's dir, www and unit`, mode === 'dry' ? named.length >= 2 : named.length === 3,
			'named only: ' + named.join(', '));
		check(`3 test ${mode}: the chain is not appended (manifest --no-log, no carve)`,
			!/tool dev\/publish\.mjs(?! «--(resolve-pin|land-check|stage-hand)»)/.test(n.calls)
			&& (mode === 'dry' || /tool verify\/manifest\.mjs «--no-log»/.test(n.calls)),
			n.calls.split('\n').filter(l => /publish|manifest/.test(l)).join('\n'));
		// NET_EXE: Steel's health_residents sums every process whose comm is daimond_gateway, so the
		// test gateway goes in under its own name. The build's local path keeps the cargo name.
		const remoteGw = n.calls.split('\n').filter(l => /(?<!release\/)\bdaimond_gateway\b/.test(l));
		check(`3 test ${mode}: never installs, backs up or prunes a daimond_gateway on the host`, remoteGw.length === 0,
			remoteGw.slice(0, 6).join('\n'));
		const sees = mode === 'dry' ? n.out : n.calls;
		const exe = ['daimond_gw_test.new', 'mv daimond_gw_test.new daimond_gw_test', 'cp daimond_gw_test daimond_gw_test.bak-',
			'daimond_gw_test.bak-*'].filter(s => !sees.includes(s));
		check(`3 test ${mode}: ships, swaps, backs up and prunes the gateway as daimond_gw_test`, exe.length === 0, 'missing: ' + exe.join('; '));
		// 0h's record is the live www tree's: a test deploy that wrote it would tell production's gates it landed.
		check(`3 test ${mode}: production's gate record is not written (no gate_evidence landed or owe)`,
			!/tool dev\/gate_evidence\.mjs «(landed|owe)»/.test(n.calls),
			n.calls.split('\n').filter(l => /gate_evidence/.test(l)).join('\n'));
	}
}

// ── 4. --check-net ─────────────────────────────────────────────────────────
if (want(4)) {
	console.log('\n4. --check-net prints the resolved profile; a bad net or profile is refused');
	const LIVE = `NET=live
NET_HOST=jarrah
NET_GW_DIR=~/usr/daimond-gateway
NET_UNIT=daimond-gateway
NET_PORT=9002
NET_WWW_PARENT=~/usr/steel-prod/www
NET_SERVED_LOG=~/usr/daimond-gateway/served-builds.log
NET_URL=https://daimond.oxedyne.com
NET_HEALTH=public
NET_SEAL=full
NET_EXE=daimond_gateway
`;
	const TEST = `NET=test
NET_HOST=jarrah
NET_GW_DIR=${TESTNET.NET_GW_DIR}
NET_UNIT=daimond-testnet
NET_PORT=9003
NET_WWW_PARENT=~/usr/steel-prod/www-test
NET_SERVED_LOG=${TESTNET.NET_SERVED_LOG}
NET_URL=https://test.daimond.oxedyne.com
NET_HEALTH=loopback:9003
NET_SEAL=none
NET_EXE=daimond_gw_test
`;
	const { T } = fixture(newSrc);
	const cn = (net, extra = {}) => {
		const env = { ...process.env, ...extra }; delete env.DAIMOND_NET;
		if (net !== undefined) env.DAIMOND_NET = net;
		return sh('bash', [path.join(T, 'dev', 'deploy.sh'), '--check-net'], { cwd: T, env });
	};
	for (const [net, exp] of [[undefined, LIVE], ['live', LIVE], ['test', TEST]]) {
		const r = cn(net);
		check(`4 --check-net, DAIMOND_NET ${net ?? 'unset'}`, r.status === 0 && r.stdout === exp, `rc ${r.status}\n${r.stdout}${r.stderr}`);
	}
	const bogus = cn('bogus');
	check('4 DAIMOND_NET=bogus is refused, naming it', bogus.status !== 0 && /bogus/.test(bogus.stderr), `rc ${bogus.status} ${bogus.stderr}`);
	const liveP = path.join(T, 'deploy', 'net', 'live.env'), liveText = fs.readFileSync(liveP, 'utf8');
	fs.writeFileSync(liveP, liveText.replace(/^NET_UNIT=.*\n/m, ''));
	const miss = cn(undefined);
	check('4 a profile missing a key is refused, naming it', miss.status !== 0 && /NET_UNIT/.test(miss.stderr), `rc ${miss.status} ${miss.stderr}`);
	fs.writeFileSync(liveP, liveText + "NET_EXTRA='x'\n");
	const unk = cn(undefined);
	check('4 a profile with an unknown key is refused, naming it', unk.status !== 0 && /NET_EXTRA/.test(unk.stderr), `rc ${unk.status} ${unk.stderr}`);
	fs.writeFileSync(liveP, liveText.replace("NET_PORT='9002'", 'NET_PORT=$(touch pwned)'));
	const inj = cn(undefined);
	check('4 a line that is not KEY=\'value\' is refused, and nothing it says runs', inj.status !== 0 && !fs.existsSync(path.join(T, 'pwned')),
		`rc ${inj.status} ${inj.stderr}`);
	// The kernel cuts comm to 15 bytes: daimond_gateway_test would be daimond_gateway to Steel's residents.
	fs.writeFileSync(liveP, liveText.replace("NET_EXE='daimond_gateway'", "NET_EXE='daimond_gateway_test'"));
	const longExe = cn(undefined);
	check('4 a NET_EXE over 15 bytes (its comm would be cut) is refused, naming it', longExe.status !== 0 && /NET_EXE/.test(longExe.stderr),
		`rc ${longExe.status} ${longExe.stderr}`);
	// NET_SEAL=none skips the mirror lock, trap 6 and the seals: refused on live, and on a
	// profile that shares any of live's paths, its unit or its URL (QA gwmain P3-2).
	fs.writeFileSync(liveP, liveText.replace("NET_SEAL='full'", "NET_SEAL='none'"));
	const liveNone = cn(undefined);
	check('4 live with NET_SEAL=none is refused, naming it', liveNone.status !== 0 && /NET_SEAL/.test(liveNone.stderr),
		`rc ${liveNone.status} ${liveNone.stderr}`);
	fs.writeFileSync(liveP, liveText);
	const testP = path.join(T, 'deploy', 'net', 'test.env'), testText = fs.readFileSync(testP, 'utf8');
	for (const k of ['NET_GW_DIR', 'NET_WWW_PARENT', 'NET_SERVED_LOG', 'NET_UNIT', 'NET_URL']) {
		const lv = liveText.match(new RegExp(`^${k}='([^']*)'$`, 'm'))[1];
		fs.writeFileSync(testP, testText.replace(new RegExp(`^${k}='[^']*'$`, 'm'), `${k}='${lv}'`));
		const shared = cn('test');
		check(`4 a NET_SEAL=none net sharing live's ${k} is refused, naming it`, shared.status !== 0 && shared.stderr.includes(k),
			`rc ${shared.status} ${shared.stderr}`);
	}
	fs.writeFileSync(testP, testText);
	const real = fs.readFileSync(path.join(REPO, 'deploy', 'net', 'live.env'), 'utf8');
	const tilde = ["NET_GW_DIR='~/usr/daimond-gateway'", "NET_WWW_PARENT='~/usr/steel-prod/www'",
		"NET_SERVED_LOG='~/usr/daimond-gateway/served-builds.log'"].filter(l => !real.split('\n').includes(l));
	check('4 live.env keeps ~ unexpanded, as today\'s literals', tilde.length === 0, 'not found verbatim: ' + tilde.join(', '));
}

// ── 5. manifest --no-log: the chain untouched, the manifest the same bytes ──
if (want(5)) {
	console.log('\n5. verify/manifest.mjs --no-log: transparency.jsonl unchanged, manifest.json byte-equal to a chained run\'s');
	const one = tag => {
		const d = path.join(ROOT, 'm5', tag);
		fs.rmSync(d, { recursive: true, force: true });
		for (const f of ['manifest.mjs', 'lib.mjs']) write(path.join(d, 'verify', f), fs.readFileSync(path.join(REPO, 'verify', f), 'utf8'));
		write(path.join(d, 'verify', 'transparency.jsonl'), fs.readFileSync(path.join(REPO, 'verify', 'transparency.jsonl'), 'utf8'));
		write(path.join(d, 'www', 'index.html'), '<!doctype html><p>m5</p>\n');
		write(path.join(d, 'www', 'build.json'), '{"build":"0123456789ab","note":"m5 fixture"}\n');
		return d;
	};
	const a = one('chained'), b = one('nolog');
	const before = fs.readFileSync(path.join(b, 'verify', 'transparency.jsonl'));
	const ra = sh('node', [path.join(a, 'verify', 'manifest.mjs')]);
	const rb = sh('node', [path.join(b, 'verify', 'manifest.mjs'), '--no-log']);
	check('5 both runs succeed', ra.status === 0 && rb.status === 0, ra.stderr + rb.stderr);
	check('5 the chained run appended (the control)', fs.readFileSync(path.join(a, 'verify', 'transparency.jsonl')).length > before.length, ra.stdout);
	check('5 --no-log leaves transparency.jsonl byte-unchanged', before.equals(fs.readFileSync(path.join(b, 'verify', 'transparency.jsonl'))), rb.stdout);
	check('5 manifest.json byte-equal to the chained run\'s', fs.readFileSync(path.join(a, 'www', 'manifest.json'))
		.equals(fs.readFileSync(path.join(b, 'www', 'manifest.json'))), 'differs');
}

// ── 6. First ship: an empty net's www takes it; a non-empty one or live never does ──
if (want(6)) {
	console.log('\n6. Step 6 onto a www with no daimond/: a first ship on test only; a missing build.json still dies elsewhere');
	const first = release(newSrc, 'real', 'test', undefined, 'www_absent');
	check('6 empty test www: the run completes', ran(first), first.out.slice(-1500));
	check('6 empty test www: says first ship and backs up nothing', /first ship/.test(first.out)
		&& !/test -f daimond\/build\.json/.test(first.calls), first.out.split('\n').filter(l => /front end|first/.test(l)).join('\n'));
	check('6 empty test www: the back-out removes what it shipped', /rm -rf -- [^ ]*www-test\/daimond/.test(first.out),
		first.out.split('\n').filter(l => /rollback|back-out|rm -rf/.test(l)).join('\n'));
	const dryFirst = release(newSrc, 'dry', 'test', undefined, 'www_absent');
	check('6 empty test www, dry: says it would ship first, backing up nothing', ran(dryFirst) && /first ship/.test(dryFirst.out),
		dryFirst.out.slice(-1500));
	const nob = release(newSrc, 'real', 'test', undefined, 'www_nobuild');
	check('6 non-empty test www without build.json: dies at 6, nothing shipped', nob.rc !== 0 && /could not back up/.test(nob.out)
		&& !/rsync «-a» «-c» «--delete»[^\n]*daimond\//.test(nob.calls), `rc ${nob.rc}\n${nob.out.slice(-800)}`);
	for (const st of ['www_absent', 'www_nobuild']) {
		const lv = release(newSrc, 'real', undefined, undefined, st);
		check(`6 live, ${st}: dies at 6, never a first ship`, lv.rc !== 0 && /could not back up/.test(lv.out) && !/first ship/.test(lv.out),
			`rc ${lv.rc}\n${lv.out.slice(-800)}`);
		const lb = release(baseSrc, 'real', undefined, undefined, st);
		check(`6 live, ${st}: call log identical to base`, lv.calls === lb.calls, firstDiff(lb.calls, lv.calls));
	}
}

// ── 7. 0h on a non-live net reads only its own owed ledger ─────────────────
if (want(7)) {
	console.log('\n7. Owed gates: test does not read the live owed red; live carries it; a red of its own refuses everywhere');
	const t = release(newSrc, 'dry', 'test', undefined, '', { FX_GATE: 'owed' });
	check('7 test, live owed red: not consulted, the run completes', ran(t) && !/«check-owed»/.test(t.calls), `rc ${t.rc}\n${t.out.slice(-1200)}`);
	for (const mode of ['dry', 'real']) {
		const lv = release(newSrc, mode, undefined, undefined, '', { FX_GATE: 'owed' });
		check(`7 live ${mode}, owed red: carried (named in the log), and the run completes`,
			ran(lv) && /«check-owed»/.test(lv.calls) && /carried owed red: by-role from live www d7c2167f53d7/.test(lv.out) && /owed red carried \(exit 20\)/.test(lv.out),
			`rc ${lv.rc}\n${lv.out.slice(-800)}`);
		const lb = release(baseSrc, mode, undefined, undefined, '', { FX_GATE: 'pending' });
		const [bs, ns] = [settle(lb.calls, 'was'), settle(lv.calls, 'now')];
		check(`7 live ${mode}, owed red carried: call log identical to base's with nothing red on live, but for SINCE_BASE`, ran(lb) && bs === ns,
			firstDiff(bs, ns));
	}
	for (const net of ['test', undefined]) {
		const r = release(newSrc, 'dry', net, undefined, '', { FX_GATE: 'red' });
		check(`7 ${net ?? 'live'}, a red filed against the shipped www: refuses, exit 20`, r.rc === 20 && /RED gate evidence filed/.test(r.out),
			`rc ${r.rc}\n${r.out.slice(-800)}`);
	}
}

// ── 8. Trap 6 guards the public mirror, so a net that writes none skips it ──
if (want(8)) {
	console.log('\n8. Trap 6: mirror ahead, no served log: test skips 0c with a line; live still refuses as base does');
	const ahead = { FX_MIRROR_AHEAD: '1' };
	const t = release(newSrc, 'dry', 'test', undefined, '', ahead);
	check('8 test, mirror ahead: 0c skipped with its line, the run completes',
		ran(t) && /trap 6 skipped/.test(t.out) && !/deploy FAILED/.test(t.out), `rc ${t.rc}\n${t.out.slice(-1200)}`);
	const failed = r => r.out.split('\n').filter(l => /deploy FAILED/.test(l)).join('\n');
	for (const mode of ['dry', 'real']) {
		const lv = release(newSrc, mode, undefined, undefined, '', ahead);
		check(`8 live ${mode}, mirror ahead: refuses at trap 6`, lv.rc !== 0 && /mirror is ahead of source/.test(failed(lv)) && !/trap 6 skipped/.test(lv.out),
			`rc ${lv.rc}\n${lv.out.slice(-800)}`);
		const lb = release(baseSrc, mode, undefined, undefined, '', ahead);
		const o = r => r.out.replace(/pid \d+/g, 'pid N').replace(/\d{8}_\d{6}/g, 'STAMP') + r.calls;
		check(`8 live ${mode}, mirror ahead: output, call log and refusal identical to base`,
			lv.rc === lb.rc && o(lv) === o(lb), firstDiff(o(lb), o(lv)));
	}
}

// ── 9. Trap 14: a net's dk unit carries the net's name ─────────────────────
if (want(9)) {
	console.log('\n9. Trap 14: test runs in dk-<NAME>-<suffix>-test; live only in dk-<NAME>-<suffix>, never the -test one');
	const unit = (net, cg, sfx) => {
		const proc = path.join(ROOT, 'proc9');
		fs.rmSync(proc, { recursive: true, force: true });
		write(path.join(proc, '100', 'cgroup'), `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${cg}\n`);
		write(path.join(proc, '100', 'status'), 'Name:\tbash\nPPid:\t1\n');
		const env = { ...process.env }; delete env.DAIMOND_NET;
		if (net) env.DAIMOND_NET = net;
		return sh('bash', [NEW, '--check-unit', proc, '100', sfx], { env }).stdout.trim();
	};
	for (const sfx of ['real', 'rollback']) {
		check(`9 test in dk-x-${sfx}-test.service: in unit`, unit('test', `dk-x-${sfx}-test.service`, sfx) === 'IN-UNIT');
		check(`9 test in dk-x-${sfx}.service: refused`, unit('test', `dk-x-${sfx}.service`, sfx) === 'NOT-IN-UNIT');
		check(`9 live in dk-x-${sfx}-test.service: refused`, unit(undefined, `dk-x-${sfx}-test.service`, sfx) === 'NOT-IN-UNIT');
		check(`9 live in dk-x-${sfx}.service: in unit`, unit(undefined, `dk-x-${sfx}.service`, sfx) === 'IN-UNIT');
	}
}

// ── 10. A net that seals nothing never touches the mirror, at any step ─────
if (want(10)) {
	console.log('\n10. NET_SEAL=none: mirror pinned elsewhere and sealed off; test never touches it, live refuses as base');
	const off = { FX_MIRROR_OFF: '1' };
	for (const mode of ['dry', 'real']) {
		const t = release(newSrc, mode, 'test', undefined, '', off);
		check(`10 test ${mode}: every step passes`, ran(t), `rc ${t.rc}\n${t.out.slice(-1500)}`);
		const hits = t.calls.split('\n').filter(l => l.includes(t.M) || l.includes('daimond-oss'));
		check(`10 test ${mode}: 0 mirror paths in the call log`, hits.length === 0, hits.slice(0, 3).join('\n'));
		check(`10 test ${mode}: no mirror lock taken`, !fs.existsSync(path.join(t.M, '.git', 'deploy.lock')) && /mirror lock not taken/.test(t.out));
		check(`10 test ${mode}: hand seal skipped, land check on this tree only`,
			/hand seal skipped/.test(t.out) && !/tool verify\/hand\.mjs/.test(t.calls) && /«--land-check» «www\/pkg» «f+» «--no-mirror»/.test(t.calls), t.out.split('\n').filter(l => /hand|land/.test(l)).join('\n'));
		const lv = release(newSrc, mode, undefined, undefined, '', off);
		const lb = release(baseSrc, mode, undefined, undefined, '', off);
		// Bash's own diagnostics carry the script's line number, which moves with any edit above it.
		const o = r => r.out.replace(/pid \d+/g, 'pid N').replace(/\d{8}_\d{6}/g, 'STAMP').replace(/deploy\.sh: line \d+:/g, 'deploy.sh: line N:') + r.calls;
		check(`10 live ${mode}: refuses`, lv.rc !== 0 && /deploy FAILED/.test(lv.out), `rc ${lv.rc}\n${lv.out.slice(-600)}`);
		check(`10 live ${mode}: output and call log identical to base`, lv.rc === lb.rc && o(lv) === o(lb), firstDiff(o(lb), o(lv)));
	}
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
