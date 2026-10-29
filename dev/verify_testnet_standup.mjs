// gateway: none
// verify_testnet_standup.mjs — dev/testnet_standup.sh, the testnet host's stand-up, proven
// against stubs (D-20261006-24, tn-U1d; design
// ~/usr/code/ai/claude/specs/daimond_testnet_design_20261025.md §R4, §5 U1d).
//
// jarrah is a fixture home directory and /etc a fixture root. ssh, sudo, systemctl, curl and
// sleep are PATH shims: ssh decodes the one remote script it is handed, logs it and runs it
// with bash in the fixture home; sudo maps /etc/… into the fixture root; systemctl keeps unit
// state in files; curl plays Stripe and the two gateways. The two read-only probes that look
// at /proc and production (`__TN_PROBE_base__`, `__TN_PROBE_iso__`) are answered from canned
// files. NOTHING REACHES JARRAH, STRIPE OR ANY NETWORK.
//
//   0. The templates: the unit carries CPUQuota=50%, IOWeight=10, MemoryMax=512M (no
//      MemoryHigh), Restart=always and runs run.sh with NET_EXE; run.sh execs.
//   1. No step names a production path or unit, outside the three read-only names allowed.
//   2. `--dry-run` writes nothing, in either home or /etc, and calls no mutating tool.
//   3. A re-run is a no-op: every tree byte- and mtime-equal, no mutating call.
//   4. A forced production path in the test profile is refused before any remote call.
//   5. The isolation checks PASS on a clean environ and FAIL, non-zero, on one holding a
//      production path or the production process name.
//   6. No key or join-code value reaches stdout, stderr or any tool's argv.
//
//   node dev/verify_testnet_standup.mjs [--arm 0,1,…]
//
// The fixtures live under /tmp/tn-u1d-<slot> and are removed at the end.

import { readPage } from './pagesrc.mjs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE   = path.dirname(fileURLToPath(import.meta.url));
const REPO   = path.join(HERE, '..');
const SCRIPT = path.join(REPO, 'dev', 'testnet_standup.sh');
const ONLY   = (() => { const i = process.argv.indexOf('--arm'); return i >= 0 ? process.argv[i + 1].split(',') : null; })();
const ROOT   = path.join('/tmp', `tn-u1d-${process.env.RC_SLOT || 'solo'}`);

// The secret values the fixtures plant. None may ever be printed or put on an argv.
const SK     = 'sk_test_FIXTURESECRETKEY0123456789';	// allowlist secret: a fixture, not a key
const WHSEC  = 'whsec_FIXTUREWEBHOOKSECRET98765';	// allowlist secret: a fixture, not a key
const JOIN   = 'DMDJOIN-FIXTURECODE-4711';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  PASS  ${name}`); }
	else    { fail++; console.log(`  FAIL  ${name}`); if (detail) console.log(String(detail).split('\n').slice(0, 14).map(l => `        | ${l}`).join('\n')); }
};
const want = arm => !ONLY || ONLY.includes(String(arm));
const write = (p, s, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); if (mode) fs.chmodSync(p, mode); };
const allOut = [];					// every stdout and stderr, for arm 6
const rd = p => fs.existsSync(p) ? readPage(p, 'utf8') : '';

// ── The shims ──────────────────────────────────────────────────────────────
const LOGF = `log() { { printf '%s' "$(basename "$0")"; for a in "$@"; do printf ' «%s»' "$a"; done; printf '\\n'; } >> "$SHIM_LOG"; }\n`;
const SHIMS = {
ssh: `#!/bin/bash
${LOGF}log "$@"
[ "$1" = -n ] || { echo "ssh shim: called without -n" >&2; exit 90; }
cmd="\${@: -1}"
b64="$(printf '%s' "$cmd" | sed -nE 's/^printf %s ([A-Za-z0-9+\\/=]+) \\| base64 -d \\| bash$/\\1/p')"
[ -n "$b64" ] || { echo "ssh shim: not the helper's form: $cmd" >&2; exit 91; }
script="$(printf '%s' "$b64" | base64 -d)"
{ echo '<<<'; printf '%s\\n' "$script"; echo '>>>'; } >> "$SHIM_LOG"
for p in base iso; do
	case "$script" in *__TN_PROBE_\${p}__*) cat "$SHIM_STATE/probe_$p.txt"; exit 0 ;; esac
done
cd "$SHIM_JARRAH" && HOME="$SHIM_JARRAH" bash -c "$cmd"
`,
sudo: `#!/bin/bash
${LOGF}log "$@"
[ "$1" = -n ] || { echo "sudo shim: called without -n" >&2; exit 90; }
shift; a=()
for x in "$@"; do case "$x" in /etc/*) a+=("$SHIM_ROOT$x") ;; *) a+=("$x") ;; esac; done
exec "\${a[@]}"
`,
systemctl: `#!/bin/bash
${LOGF}log "$@"
D="$SHIM_STATE/sysd"; mkdir -p "$D"; u=; a=()
for x in "$@"; do case "$x" in --user) u=user_ ;; --quiet|--now) ;; *) a+=("$x") ;; esac; done
case "\${a[0]}" in
daemon-reload|restart|start|stop) ;;
enable)		touch "$D/\${u}enabled_\${a[1]}" ;;
is-enabled)	[ -e "$D/\${u}enabled_\${a[1]}" ] || exit 1 ;;
is-active)
	if [ "\${a[1]}" = daimond-testnet ] && grep -q '^APP_MODE=live' "$SHIM_JARRAH/usr/daimond-testnet/gateway.env" 2>/dev/null; then
		echo activating; exit 3; fi
	[ -e "$D/active_\${a[1]}" ] && echo active || { echo inactive; exit 3; } ;;
*)	echo "systemctl shim: unplayed \${a[*]}" >&2; exit 92 ;;
esac
`,
curl: `#!/bin/bash
${LOGF}log "$@"
url=; m=GET; k=; d=(); prev=
for x in "$@"; do
	case "$prev" in -X) m="$x" ;; -K) k="$x" ;; -d) d+=("$x") ;; esac
	case "$x" in http*|127.0.0.1*) url="$x" ;; esac
	prev="$x"
done
E="$SHIM_STATE/endpoints.json"
case "$url" in
*api.stripe.com/v1/webhook_endpoints*)
	[ -n "$k" ] && grep -q '^user = "sk_test_' "$k" || { echo '{"error":{"message":"no key"}}'; exit 0; }
	case "$m" in
	GET)	jq '{object:"list",has_more:false,data:.}' "$E" ;;
	DELETE)	id="\${url##*/}"; jq --arg id "$id" 'map(select(.id != $id))' "$E" > "$E.t" && mv "$E.t" "$E"; echo "{\\"id\\":\\"$id\\",\\"deleted\\":true}" ;;
	POST)	u=; ev=(); for x in "\${d[@]}"; do case "$x" in url=*) u="\${x#url=}" ;; 'enabled_events[]='*) ev+=("\${x#*=}") ;; esac; done
		id="we_fixture$(jq length "$E")"
		jq --arg id "$id" --arg u "$u" --args '. + [{id:$id,url:$u,status:"enabled",livemode:false,enabled_events:$ARGS.positional}]' "\${ev[@]}" < "$E" > "$E.t" && mv "$E.t" "$E"
		printf '{\\n  "id": "%s",\\n  "object": "webhook_endpoint",\\n  "secret": "%s",\\n  "url": "%s"\\n}\\n' "$id" "${WHSEC}" "$u" ;;
	esac ;;
*127.0.0.1:9003/api/health*)
	grep -q '^APP_MODE=live' "$SHIM_JARRAH/usr/daimond-testnet/gateway.env" 2>/dev/null && exit 7
	printf '{"ok":true}' ;;
*)	printf '{"ok":true}' ;;
esac
`,
sleep: `#!/bin/bash\nexit 0\n`,
};

const PROBE_BASE = '__TN_PROBE_base__\nMainPID=100\nNRestarts=0\nActiveState=active\nMemoryCurrent=300000000\n';
const probeIso = (over = {}) => {
	const p = {
		pid: '4242', comm: 'daimond_gw_test', cwd: '/home/jason/usr/daimond-testnet',
		fd: ['/home/jason/usr/daimond-testnet/o3db/0.dat', 'socket:[77]', '/home/jason/usr/daimond-testnet/log/gateway-202610.log'],
		env: ['DAIMOND_NETWORK=test', 'APP_MODE=sandbox', 'DAIMOND_RELEASES_FILE=../steel-prod/www-test/daimond/releases.json', 'HOME=/home/jason'],
		prod: 'MainPID=100 NRestarts=0 ActiveState=active MemoryCurrent=310000000',
		h9002: '{"ok":true,"store_write_ok":true}', h9003: '{"ok":true}', p9003: '{"pro_price_minor":900,"currency":"usd"}',
		...over,
	};
	return ['__TN_PROBE_iso__', `__PID__ ${p.pid}`, `__COMM__ ${p.comm}`, `__CWD__ ${p.cwd}`,
		...p.fd.map(f => `__FD__ ${f}`), ...p.env.map(e => `__ENV__ ${e}`),
		`__PROD__ ${p.prod}`, `__H9002__ ${p.h9002}`, `__H9003__ ${p.h9003}`, `__P9003__ ${p.p9003}`].join('\n') + '\n';
};

// A fresh world: jarrah's home with production's gateway beside it, an empty /etc, argonaut's
// home with lens installed, and the shims. `script` is the stand-up to run (a scratch copy
// for arm 4).
function world(name) {
	const W = path.join(ROOT, name);
	fs.rmSync(W, { recursive: true, force: true });
	const J = path.join(W, 'jarrah'), E = path.join(W, 'root'), A = path.join(W, 'argonaut'), S = path.join(W, 'state'), B = path.join(W, 'bin');
	write(path.join(J, 'usr/daimond-gateway/keys/stripe/sandbox/sk'), SK, 0o600);
	write(path.join(J, 'usr/daimond-gateway/daimond_gateway'), 'production binary', 0o755);
	fs.mkdirSync(path.join(J, 'usr/steel-prod/www/daimond'), { recursive: true });
	fs.mkdirSync(path.join(E, 'etc/systemd/system'), { recursive: true });
	fs.mkdirSync(path.join(S, 'sysd'), { recursive: true });
	write(path.join(A, '.local/lib/daimond-lens/lens.mjs'), '// lens\n');
	write(path.join(S, 'endpoints.json'), JSON.stringify([{ id: 'we_prod1', url: 'https://daimond.oxedyne.com/webhook/stripe',
		status: 'enabled', livemode: false, enabled_events: ['checkout.session.completed'] }]));
	write(path.join(S, 'probe_base.txt'), PROBE_BASE);
	write(path.join(S, 'probe_iso.txt'), probeIso());
	for (const [n, s] of Object.entries(SHIMS)) write(path.join(B, n), s, 0o755);
	const log = path.join(S, 'calls.log');
	write(log, '');
	const env = { ...process.env, PATH: `${B}:${process.env.PATH}`, HOME: A, SHIM_LOG: log, SHIM_STATE: S, SHIM_JARRAH: J, SHIM_ROOT: E };
	const run = (args, script = SCRIPT) => {
		fs.writeFileSync(log, '');
		const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env, timeout: 120000 });
		const out = (r.stdout || '') + (r.stderr || '') + (r.error ? String(r.error) : '');
		allOut.push(out);
		return { code: r.status, out, log: readPage(log, 'utf8') };
	};
	// Step 5, the lead's `dk deploy`, as far as the later steps can see it.
	const deploy = (ctl = true) => {
		const G = path.join(J, 'usr/daimond-testnet');
		write(path.join(G, 'daimond_gw_test'), 'test binary', 0o755);
		write(path.join(G, 'daimond_ctl'), ctl
			? `#!/bin/bash\ncase "$1" in help) echo 'commands: health accounts passcode-mint' ;; passcode-mint) echo '${JOIN}' ;; esac\n`
			: `#!/bin/bash\ncase "$1" in help) echo 'commands: health accounts' ;; esac\n`, 0o755);
		write(path.join(S, 'sysd/active_daimond-testnet'), '');
	};
	return { W, J, E, A, S, run, deploy };
}

// Every file and directory under the given roots: mode, size, mtime and content hash.
function snap(...roots) {
	const out = [];
	const walk = d => {
		for (const n of fs.readdirSync(d).sort()) {
			const p = path.join(d, n), st = fs.lstatSync(p);
			const h = st.isFile() ? crypto.createHash('sha256').update(readPage(p)).digest('hex').slice(0, 16) : '-';
			out.push(`${p} ${st.mode.toString(8)} ${st.size} ${st.mtimeMs} ${h}`);
			if (st.isDirectory()) walk(p);
		}
	};
	roots.forEach(walk);
	return out.join('\n');
}
const diff = (a, b) => { const x = a.split('\n'), y = new Set(b.split('\n')); return x.filter(l => !y.has(l)).concat(b.split('\n').filter(l => !new Set(x).has(l))).join('\n'); };

// The calls that change something: any sudo but a cmp, a mutating systemctl, a Stripe write.
const MUTATING = /^sudo (?!«-n» «cmp»)|^systemctl(?: «--user»)? «(?:daemon-reload|enable|restart|start|stop)»|^curl .*«(?:POST|DELETE)»/m;
const PROD = ['daimond-gateway', 'daimond_gateway', 'steel-prod/www/', ':9002'];
// The three production names a step may hold, each read-only: the sandbox key it copies, and
// the two probes isolation check (ii)/(iv) and the unit step's baseline read.
const PROD_READS = [
	'$HOME/usr/daimond-gateway/keys/stripe/sandbox/sk',
	'systemctl show -p MainPID -p NRestarts -p ActiveState -p MemoryCurrent daimond-gateway',
	'http://127.0.0.1:9002/api/health',
];

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

// ── Arm 0: the templates ───────────────────────────────────────────────────
if (want(0)) {
	console.log('arm 0: the unit template and run.sh');
	const u = readPage(path.join(REPO, 'deploy/net/daimond-testnet.service'), 'utf8');
	const body = u.split('\n').filter(l => !l.startsWith('#')).join('\n');
	for (const l of ['CPUQuota=50%', 'IOWeight=10', 'MemoryMax=512M', 'Restart=always', 'ExecStart=@GW_DIR@/run.sh @NET_EXE@',
		'EnvironmentFile=@GW_DIR@/gateway.env', 'WorkingDirectory=@GW_DIR@'])
		check(`unit holds ${l}`, body.split('\n').includes(l));
	check('unit holds no MemoryHigh', !/MemoryHigh/.test(body));
	const r = readPage(path.join(REPO, 'deploy/net/testnet-run.sh'), 'utf8');
	check('run.sh execs the gateway', /^exec "\.\/\$exe"/m.test(r));
	check('run.sh sources no env file', !/^\s*(\.|source) /m.test(r));
}

// ── Arms 1, 3, 6: a full stand-up, then again ─────────────────────────────
if (want(1) || want(3) || want(6)) {
	const w = world('full');
	const pre = w.run(['all']);
	check('all, before step 5: exit 0', pre.code === 0, pre.out);
	check('all, before step 5: stops and names step 5', /step 5/.test(pre.out), pre.out);
	const unitF = path.join(w.E, 'etc/systemd/system/daimond-testnet.service');
	const unit = fs.existsSync(unitF) ? readPage(unitF, 'utf8') : '';
	check('the unit is rendered into /etc', /ExecStart=\/.*\/usr\/daimond-testnet\/run\.sh daimond_gw_test$/m.test(unit) && !/@[A-Z_]+@/.test(unit), unit);
	check('the unit is enabled, not started', fs.existsSync(path.join(w.S, 'sysd/enabled_daimond-testnet')) && !/«(?:start|restart)» «daimond-testnet»/.test(pre.log), pre.log);
	const G = path.join(w.J, 'usr/daimond-testnet');
	const mode = p => fs.existsSync(p) ? (fs.statSync(p).mode & 0o777).toString(8) : 'absent';
	check('keys and every key dir are 700', ['keys', 'keys/stripe', 'keys/stripe/sandbox', 'keys/openrouter', 'keys/openrouter/sandbox', 'keys/licence', 'keys/db']
		.every(d => mode(path.join(G, d)) === '700'), ['keys', 'keys/licence', 'keys/db'].map(d => `${d} ${mode(path.join(G, d))}`).join('\n'));
	check('sk copied, 600', mode(path.join(G, 'keys/stripe/sandbox/sk')) === '600' && rd(path.join(G, 'keys/stripe/sandbox/sk'), 'utf8') === SK);
	const kpF = path.join(G, 'keys/licence/ed25519_kp_b64url');
	const kp = fs.existsSync(kpF) ? readPage(kpF, 'utf8') : '';
	check('licence keypair: 64 bytes base64url, 600', /^[A-Za-z0-9_-]{86}$/.test(kp) && mode(kpF) === '600', `${kp.length} chars, ${mode(kpF)}`);
	check('whsec written, 600', mode(path.join(G, 'keys/stripe/sandbox/whsec')) === '600'
		&& rd(path.join(G, 'keys/stripe/sandbox/whsec'), 'utf8') === WHSEC);
	const eps = JSON.parse(readPage(path.join(w.S, 'endpoints.json'), 'utf8'));
	const te = eps.filter(e => e.url === 'https://test.daimond.oxedyne.com/webhook/stripe');
	check('one test endpoint, production\'s events', te.length === 1 && JSON.stringify(te[0].enabled_events) === '["checkout.session.completed"]'
		&& eps.some(e => e.id === 'we_prod1'), JSON.stringify(eps));
	check('gateway.env is test.gateway.env, 600', mode(path.join(G, 'gateway.env')) === '600'
		&& rd(path.join(G, 'gateway.env'), 'utf8') === readPage(path.join(REPO, 'deploy/net/test.gateway.env'), 'utf8'));
	check('run.sh installed, 755', mode(path.join(G, 'run.sh')) === '755');
	check('lens-pull@test.timer enabled, test.env names the test mirror and remote',
		fs.existsSync(path.join(w.S, 'sysd/user_enabled_lens-pull@test.timer'))
		&& /DAIMOND_LENS_REMOTE=jarrah:~\/usr\/daimond-testnet\/debug-traces\//.test(fs.existsSync(path.join(w.A, '.config/daimond-lens/test.env')) ? readPage(path.join(w.A, '.config/daimond-lens/test.env'), 'utf8') : ''));
	check('no db/at_rest written: the gateway makes its own', !fs.existsSync(path.join(G, 'keys/db/at_rest')));

	w.deploy();
	const post = w.run(['all']);
	check('all, after step 5: exit 0', post.code === 0, post.out);
	check('all, after step 5: five isolation PASS lines', (post.out.match(/^PASS \((?:i|ii|iii|iv|v)\)/gm) || []).length === 5, post.out);
	check('gateway.env put back after check (v)', rd(path.join(G, 'gateway.env'), 'utf8') === readPage(path.join(REPO, 'deploy/net/test.gateway.env'), 'utf8'));
	const jc = path.join(G, 'keys/owner_join_code');
	check('one join code, in a 600 file', fs.existsSync(jc) && rd(jc).trim() === JOIN && mode(jc) === '600');

	if (want(1)) {
		console.log('arm 1: no step names a production path or unit');
		for (const [n, r] of [['pre', pre], ['post', post]]) {
			let l = r.log;
			for (const a of PROD_READS) l = l.split(a).join('');
			const hits = l.split('\n').filter(x => PROD.some(t => x.includes(t)));
			check(`${n}: production names only in the read-only set`, hits.length === 0, hits.join('\n'));
		}
		check('every remote call is ssh -n', !/^ssh (?!«-n»)/m.test(pre.log + post.log));
	}

	if (want(3)) {
		console.log('arm 3: a re-run is a no-op');
		const before = snap(w.J, w.E, w.A);
		for (const s of ['dirs', 'keys', 'stripe', 'unit', 'lens', 'bootstrap']) {
			const r = w.run([s]);
			check(`${s} again: exit 0, nothing mutating`, r.code === 0 && !MUTATING.test(r.log), r.out + '\n' + (r.log.match(MUTATING) || [''])[0]);
		}
		const d = diff(before, snap(w.J, w.E, w.A));
		check('re-run: every tree byte- and mtime-equal', d === '', d);
	}
}

// ── Arm 2: --dry-run writes nothing ────────────────────────────────────────
if (want(2)) {
	console.log('arm 2: --dry-run writes nothing');
	for (const deployed of [false, true]) {
		const w = world(deployed ? 'dry-post' : 'dry');
		if (deployed) w.deploy();
		const before = snap(w.J, w.E, w.A, path.join(w.S, 'sysd'));
		const r = w.run(['all', '--dry-run']);
		const tag = deployed ? 'after step 5' : 'fresh host';
		check(`${tag}: exit 0`, r.code === 0, r.out);
		check(`${tag}: no mutating call`, !MUTATING.test(r.log), (r.log.match(MUTATING) || [''])[0]);
		const d = diff(before, snap(w.J, w.E, w.A, path.join(w.S, 'sysd')));
		check(`${tag}: no file written`, d === '', d);
		check(`${tag}: the plan is printed`, /\[dry-run\]/.test(r.out), r.out);
	}
}

// ── Arm 4: a forced production path is refused ─────────────────────────────
if (want(4)) {
	console.log('arm 4: a forced production path is refused');
	const forced = {
		NET_GW_DIR: "'~/usr/daimond-gateway'", NET_UNIT: "'daimond-gateway'", NET_PORT: "'9002'",
		NET_WWW_PARENT: "'~/usr/steel-prod/www'", NET_EXE: "'daimond_gateway'", NET_SERVED_LOG: "'~/usr/daimond-gateway/served-builds.log'",
	};
	for (const [k, v] of Object.entries(forced)) {
		const w = world(`forced-${k}`);
		const C = path.join(w.W, 'repo');
		fs.mkdirSync(path.join(C, 'dev'), { recursive: true });
		fs.cpSync(path.join(REPO, 'deploy'), path.join(C, 'deploy'), { recursive: true });
		for (const f of ['testnet_standup.sh', 'lens-pull@.service', 'lens-pull@.timer']) fs.copyFileSync(path.join(REPO, 'dev', f), path.join(C, 'dev', f));
		const tf = path.join(C, 'deploy/net/test.env');
		fs.writeFileSync(tf, readPage(tf, 'utf8').replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`));
		const before = snap(w.J, w.E, w.A);
		const r = w.run(['all'], path.join(C, 'dev/testnet_standup.sh'));
		check(`${k}=${v}: refused, non-zero, before any remote call`, r.code !== 0 && /refuse/i.test(r.out) && r.log === '', r.out + r.log);
		check(`${k}: nothing written`, diff(before, snap(w.J, w.E, w.A)) === '');
	}
}

// ── Arm 5: the isolation checks have teeth ─────────────────────────────────
if (want(5)) {
	console.log('arm 5: the isolation checks FAIL on a production path');
	const cases = [
		['clean environ', {}, 0, null],
		['environ names production\'s releases file', { env: ['DAIMOND_NETWORK=test', 'APP_MODE=sandbox', 'DAIMOND_RELEASES_FILE=../steel-prod/www/daimond/releases.json'] }, 1, /^FAIL \(i\)/m],
		['an fd under production\'s dir', { fd: ['/home/jason/usr/daimond-gateway/o3db/0.dat'] }, 1, /^FAIL \(i\)/m],
		['cwd is production\'s', { cwd: '/home/jason/usr/daimond-gateway' }, 1, /^FAIL \(i\)/m],
		['comm is production\'s name', { comm: 'daimond_gateway' }, 1, /^FAIL \(i\)/m],
		['APP_MODE=live in the environ', { env: ['DAIMOND_NETWORK=test', 'APP_MODE=live'] }, 1, /^FAIL \(iii\)/m],
		['production restarted', { prod: 'MainPID=101 NRestarts=1 ActiveState=active MemoryCurrent=300000000' }, 1, /^FAIL \(ii\)/m],
		['production health changed', { h9002: '' }, 1, /^FAIL \(iv\)/m],
	];
	for (const [name, over, code, re] of cases) {
		const w = world('iso');
		w.run(['all']);
		w.deploy();
		write(path.join(w.S, 'probe_iso.txt'), probeIso(over));
		const r = w.run(['isolate']);
		check(`${name}: exit ${code ? 'non-zero' : '0'}${re ? ', ' + re.source : ''}`,
			(code ? r.code !== 0 : r.code === 0) && (!re || re.test(r.out)) && (code || (r.out.match(/^PASS /gm) || []).length === 5), r.out);
	}
	const w = world('noctl');
	w.run(['all']);
	w.deploy(false);
	const r = w.run(['bootstrap']);
	check('bootstrap refuses, non-zero, when daimond_ctl has no passcode-mint', r.code !== 0 && /passcode-mint/.test(r.out)
		&& !fs.existsSync(path.join(w.J, 'usr/daimond-testnet/keys/owner_join_code')), r.out);
}

// ── Arm 6: no secret in any output or argv ─────────────────────────────────
if (want(6)) {
	console.log('arm 6: no key or join-code value reaches stdout, stderr or an argv');
	const kps = [];
	for (const d of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []) {
		const f = path.join(ROOT, d, 'jarrah/usr/daimond-testnet/keys/licence/ed25519_kp_b64url');
		if (fs.existsSync(f)) kps.push(readPage(f, 'utf8').trim());
	}
	check('at least one licence keypair to look for', kps.length > 0);
	const outs = allOut.join('\n');
	const logs = fs.readdirSync(ROOT).map(d => path.join(ROOT, d, 'state/calls.log')).filter(fs.existsSync).map(f => readPage(f, 'utf8')).join('\n');
	for (const [n, v] of [['sandbox sk', SK], ['whsec', WHSEC], ['join code', JOIN], ...kps.map((k, i) => [`licence keypair ${i}`, k])]) {
		check(`${n}: not in stdout or stderr`, !outs.includes(v));
		check(`${n}: not in any tool's argv`, !logs.split('\n').filter(l => !l.startsWith(' ')).some(l => /^(ssh|sudo|systemctl|curl) /.test(l) && l.includes(v)));
	}
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
