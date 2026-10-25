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
//      `~` unexpanded.
//   5. `verify/manifest.mjs --no-log` leaves transparency.jsonl byte-unchanged and writes a
//      manifest.json byte-equal to a chained run's on the same tree.
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
if (me === 'dev/gate_evidence.mjs' && a[0] === 'check') process.stdout.write('gate by-role: ok\\n');
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
function release(deploySrc, mode, net, liveEnv) {
	const { T, M, F, B, S } = fixture(deploySrc, liveEnv);
	const log = path.join(FX, 'calls.log');
	fs.writeFileSync(log, '');
	const env = {
		HOME: os.homedir(), LANG: 'C.UTF-8', TMPDIR: path.join(FX, 'tmp'),
		PATH: `${B}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
		MIRROR: M, DAIMOND_DEPLOY_RUN_ROOT: path.join(FX, 'runs'), DAIMOND_WASM_TARGET_DIR: path.join(FX, 'wasm'),
		SHIM_LOG: log, SHIM_STATE: S, SHIM_JDAT: path.join(T, 'gateway', 'app.jdat'), FX_FE2O3: F,
		...GIT_ENV,
	};
	if (net !== undefined) env.DAIMOND_NET = net;
	const args = [path.join(T, 'dev', 'deploy.sh'), ...(mode === 'dry' ? ['--dry-run'] : ['--yes']), '--note', NOTE, '--engine-source', FP];
	let r;
	if (mode === 'dry') {
		r = sh('bash', args, { cwd: T, env, input: '', timeout: 240000 });
	} else {
		// Trap 14: a real run only inside dk-<NAME>-real.service. The unit is transient and collected.
		const unit = `dk-tnu1b${process.pid}x${++unitN}-real`;
		const sr = ['--user', '--quiet', '--wait', '--pipe', '--collect', `--unit=${unit}`, `--working-directory=${T}`];
		for (const [k, v] of Object.entries(env)) sr.push('-E', `${k}=${v}`);
		const parent = { ...process.env }; delete parent.DBUS_SESSION_BUS_ADDRESS;
		r = sh('systemd-run', [...sr, 'bash', ...args], { env: parent, input: '', timeout: 240000 });
	}
	const out = (r.stdout || '') + (r.stderr || '');
	return { rc: r.status, out, calls: fs.readFileSync(log, 'utf8') };
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
			check(`${tag}: call log identical to base`, n.calls === b.calls, firstDiff(b.calls, n.calls));
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
		const names = ['~/usr/daimond-testnet', 'steel-prod/www-test/daimond', 'daimond-testnet'];
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
NET_GW_DIR=~/usr/daimond-testnet
NET_UNIT=daimond-testnet
NET_PORT=9003
NET_WWW_PARENT=~/usr/steel-prod/www-test
NET_SERVED_LOG=~/usr/daimond-testnet/served-builds.log
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

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
