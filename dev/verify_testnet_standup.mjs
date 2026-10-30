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
//      Production's keys are a link out of ~/usr (SC30), stubbed so in every world.
//   6. No key or join-code value reaches stdout, stderr or any tool's argv, daimond_ctl's
//      included; bootstrap mints with the unit left up, through the ctl door.
//   7. `owner <account-id>` sets DAIMOND_OWNER_ACCOUNTS once, restarts the unit, survives a
//      re-run of the unit step, and refuses a malformed id.
//   8. testnet_down.sh: --dry-run writes nothing and lists the key root; a production path is
//      refused before any remote call; a symlinked test dir is refused; a real run lists, then
//      deletes, only the test endpoint and removes the unit, the test dir, the key root and
//      www-test, and nothing of production.
//   9. The key root (CLAUDE.md credentials rule, SC27): `dirs` makes it 700 outside ~/usr and
//      links keys/ to it, idempotently; it refuses a real keys/ directory and a keys/ link to
//      anywhere else. Isolation check (vi) FAILs on a key root under ~/usr, not 700, or sharing
//      a path with production's keys, comparing canonical paths by whole segments, so
//      production's ~/.config/oxedyne/daimond is no match for …/daimond-testnet (SC30).
//  10. The working dir is NET_GW_DIR, named once, in test.env (~/var/daimond-testnet, where
//      jarrah's user writes without sudo): `dirs --dry-run` says, for every dir it would make,
//      whether its parent is writable, and names an unwritable one, non-zero; `dirs` then
//      exits non-zero with nothing made. The lens dry-run says `would change`. gateway.env's
//      DAIMOND_RELEASES_FILE renders absolute, under NET_WWW_PARENT. No literal of the old
//      dir under ~/usr is left in the tree.
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

// The test profile, read as the stand-up reads it (KEY='value' lines), so no fixture path is a
// literal: GW is the test gateway's dir and WWWP www-test's parent, each relative to the home.
const PROFILE = Object.fromEntries(fs.readFileSync(path.join(REPO, 'deploy/net/test.env'), 'utf8').split('\n')
	.map(l => l.match(/^(NET_[A-Z_]+)='([^']*)'$/)).filter(Boolean).map(m => [m[1], m[2]]));
const GW = PROFILE.NET_GW_DIR.replace(/^~\//, ''), WWWP = PROFILE.NET_WWW_PARENT.replace(/^~\//, '');

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
daemon-reload|restart) ;;
start)		touch "$D/active_\${a[1]}" ;;
stop)		rm -f "$D/active_\${a[1]}" ;;
enable)		touch "$D/\${u}enabled_\${a[1]}" ;;
disable)	rm -f "$D/\${u}enabled_\${a[1]}" ;;
is-enabled)	[ -e "$D/\${u}enabled_\${a[1]}" ] || exit 1 ;;
is-active)
	if [ "\${a[1]}" = daimond-testnet ] && grep -q '^APP_MODE=live' "$SHIM_JARRAH/${GW}/gateway.env" 2>/dev/null; then
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
	grep -q '^APP_MODE=live' "$SHIM_JARRAH/${GW}/gateway.env" 2>/dev/null && exit 7
	printf '{"ok":true}' ;;
*)	printf '{"ok":true}' ;;
esac
`,
sleep: `#!/bin/bash\nexit 0\n`,
};

const PROBE_BASE = '__TN_PROBE_base__\nMainPID=100\nNRestarts=0\nActiveState=active\nMemoryCurrent=300000000\n';
const probeIso = (over = {}) => {
	const p = {
		pid: '4242', comm: 'daimond_gw_test', cwd: `/home/jason/${GW}`,
		fd: [`/home/jason/${GW}/o3db/0.dat`, 'socket:[77]', `/home/jason/${GW}/log/gateway-202610.log`],
		env: ['DAIMOND_NETWORK=test', 'APP_MODE=sandbox', `DAIMOND_RELEASES_FILE=/home/jason/${WWWP}/daimond/releases.json`, 'HOME=/home/jason'],
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
	// Production's keys moved out of ~/usr (SC30): keys/ is a link, and the keys step's copy
	// of its sandbox key reads through it.
	write(path.join(J, '.config/oxedyne/daimond/gateway-keys/stripe/sandbox/sk'), SK, 0o600);
	fs.chmodSync(path.join(J, '.config/oxedyne/daimond/gateway-keys'), 0o700);
	fs.mkdirSync(path.join(J, 'usr/daimond-gateway'), { recursive: true });
	fs.symlinkSync(path.join(J, '.config/oxedyne/daimond/gateway-keys'), path.join(J, 'usr/daimond-gateway/keys'));
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
		const G = path.join(J, GW);
		write(path.join(G, 'daimond_gw_test'), 'test binary', 0o755);
		// The real ctl's contract (gateway tests/ctl_passcode_mint.rs, ctl_through_the_door.rs):
		// the code to the file named and never to stdout, nothing minted twice, the unit up or
		// down (through the ctl door when up).
		write(path.join(G, 'daimond_ctl'), ctl
			? `#!/bin/bash\n${LOGF}case "$1" in help) echo 'commands: health accounts passcode-mint' ;;\n`
			+ `passcode-mint) log "$@"; [ $# = 3 ] || { echo "passcode-mint takes <label> <file>." >&2; exit 1; }\n`
			+ `  echo mint >> "$SHIM_STATE/ctl_mints"; (umask 077; printf '%s\\n' '${JOIN}' > "$3"); echo "Minted a join code for '$2' into $3 (600)." ;; esac\n`
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

// The test key root on the fixture jarrah, and gateway.env as the unit step renders it there.
const KR = J => path.join(J, '.config/oxedyne/daimond-testnet/gateway-keys');
const TPL = fs.readFileSync(path.join(REPO, 'deploy/net/test.gateway.env'), 'utf8');
const rendered = J => TPL.split('@HOME@').join(J).split('@NET_WWW_PARENT@').join(path.join(J, WWWP));

// The calls that change something: any sudo but a cmp, a mutating systemctl, a Stripe write.
const MUTATING = /^sudo (?!«-n» «cmp»)|^systemctl(?: «--user»)? «(?:daemon-reload|enable|disable|restart|start|stop)»|^curl .*«(?:POST|DELETE)»|^daimond_ctl /m;
const PROD = ['daimond-gateway', 'daimond_gateway', 'steel-prod/www/', ':9002'];
// The three production names a step may hold, each read-only: the sandbox key it copies, and
// the two probes isolation check (ii)/(iv) and the unit step's baseline read.
const PROD_READS = [
	'$HOME/usr/daimond-gateway/keys/stripe/sandbox/sk',
	'systemctl show -p MainPID -p NRestarts -p ActiveState -p MemoryCurrent daimond-gateway',
	'http://127.0.0.1:9002/api/health',
	'readlink -f "$HOME/usr/daimond-gateway/keys"',
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
	// Each step's summary says once what it did: `${did:-present}` expanded to the list again
	// when the list was not empty, so every line printed it twice (tn-U1d).
	const summaries = pre.out.split('\n').filter(l => /^(dirs|keys|unit|lens): (made|changed)/.test(l));
	check('each summary line names each thing it did once', summaries.length === 4
		&& summaries.every(l => { const x = l.split(' ').slice(2); return new Set(x).size === x.length; }), summaries.join('\n'));
	const unitF = path.join(w.E, 'etc/systemd/system/daimond-testnet.service');
	const unit = fs.existsSync(unitF) ? fs.readFileSync(unitF, 'utf8') : '';
	check('the unit is rendered into /etc', unit.split('\n').includes(`ExecStart=${path.join(w.J, GW)}/run.sh daimond_gw_test`) && !/@[A-Z_]+@/.test(unit), unit);
	check('the unit is enabled, not started', fs.existsSync(path.join(w.S, 'sysd/enabled_daimond-testnet')) && !/«(?:start|restart)» «daimond-testnet»/.test(pre.log), pre.log);
	const G = path.join(w.J, GW);
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
	check('gateway.env is test.gateway.env with jarrah\'s home, 600', mode(path.join(G, 'gateway.env')) === '600'
		&& rd(path.join(G, 'gateway.env')) === rendered(w.J) && rd(path.join(G, 'gateway.env')).includes(`DAIMOND_KEY_ROOT=${KR(w.J)}\n`), rd(path.join(G, 'gateway.env')));
	check('run.sh installed, 755', mode(path.join(G, 'run.sh')) === '755');
	check('lens-pull@test.timer enabled, test.env names the test mirror and remote',
		fs.existsSync(path.join(w.S, 'sysd/user_enabled_lens-pull@test.timer'))
		&& rd(path.join(w.A, '.config/daimond-lens/test.env')).includes(`DAIMOND_LENS_REMOTE=jarrah:${PROFILE.NET_GW_DIR}/debug-traces/\n`));
	check('no db/at_rest written: the gateway makes its own', !fs.existsSync(path.join(G, 'keys/db/at_rest')));

	w.deploy();
	const post = w.run(['all']);
	check('all, after step 5: exit 0', post.code === 0, post.out);
	check('all, after step 5: six isolation PASS lines', (post.out.match(/^PASS \((?:i|ii|iii|iv|v|vi)\)/gm) || []).length === 6, post.out);
	check('gateway.env put back after check (v)', rd(path.join(G, 'gateway.env')) === rendered(w.J));
	const jc = path.join(G, 'keys/owner_join_code');
	check('one join code, in a 600 file', fs.existsSync(jc) && rd(jc).trim() === JOIN && mode(jc) === '600');
	const at = re => post.log.split('\n').findIndex(l => re.test(l));
	const [iStop, iMint] = [/^systemctl «stop» «daimond-testnet»/, /^daimond_ctl «passcode-mint»/].map(at);
	check('bootstrap: the mint runs with the unit left up (the ctl door)', iMint >= 0 && iStop < 0, post.log.split('\n').filter(l => /stop|start|daimond_ctl/.test(l)).join('\n'));
	check('bootstrap: the mint names the label and the file', /^daimond_ctl «passcode-mint» «owner \(testnet\)» «keys\/owner_join_code»$/m.test(post.log), post.log);
	check('bootstrap: the unit is still up', fs.existsSync(path.join(w.S, 'sysd/active_daimond-testnet')));
	check('bootstrap: one mint', rd(path.join(w.S, 'ctl_mints')) === 'mint\n');
	check('bootstrap: the ctl\'s own output holds no code', !rd(path.join(G, 'log/bootstrap.out')).includes(JOIN), rd(path.join(G, 'log/bootstrap.out')));

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
		for (const f of ['testnet_standup.sh', 'testnet_down.sh', 'lens-pull@.service', 'lens-pull@.timer']) fs.copyFileSync(path.join(REPO, 'dev', f), path.join(C, 'dev', f));
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
			(code ? r.code !== 0 : r.code === 0) && (!re || re.test(r.out)) && (code || (r.out.match(/^PASS /gm) || []).length === 6), r.out);
	}
	// (vi) reads the real fixture, not a canned probe: relink keys/, or production's, and judge.
	const relink = (l, t) => { fs.rmSync(l, { recursive: true, force: true }); fs.symlinkSync(t, l); };
	const krCases = [
		['production\'s keys at ~/.config/oxedyne/daimond, a string prefix of the test root (SC30)', w => {
			fs.mkdirSync(path.join(w.J, '.config/oxedyne/daimond'), { recursive: true });
			relink(path.join(w.J, 'usr/daimond-gateway/keys'), path.join(w.J, '.config/oxedyne/daimond'));
		}, 0, null],
		['the key root under ~/usr', w => {
			fs.mkdirSync(path.join(w.J, 'usr/tn-keys'), { recursive: true, mode: 0o700 });
			relink(path.join(w.J, GW + '/keys'), path.join(w.J, 'usr/tn-keys'));
		}, 1, /^FAIL \(vi\).*under ~\/usr/m],
		['the key root is production\'s', w => {
			relink(path.join(w.J, GW + '/keys'), path.join(w.J, '.config/oxedyne/daimond/gateway-keys'));
		}, 1, /^FAIL \(vi\).*shares a path/m],
		['the key root inside production\'s', w => {
			fs.mkdirSync(path.join(w.J, '.config/oxedyne/daimond/gateway-keys/tn'), { recursive: true, mode: 0o700 });
			relink(path.join(w.J, GW + '/keys'), path.join(w.J, '.config/oxedyne/daimond/gateway-keys/tn'));
		}, 1, /^FAIL \(vi\).*shares a path/m],
		['the key root not 700', w => { if (fs.existsSync(KR(w.J))) fs.chmodSync(KR(w.J), 0o755); }, 1, /^FAIL \(vi\).*not 700/m],
	];
	for (const [name, setup, code, re] of krCases) {
		const w = world('iso-kr');
		w.run(['all']);
		w.deploy();
		setup(w);
		const r = w.run(['isolate']);
		check(`${name}: exit ${code ? 'non-zero' : '0'}${re ? ', ' + re.source : ''}`,
			(code ? r.code !== 0 : r.code === 0) && (!re || re.test(r.out)) && (code || (r.out.match(/^PASS /gm) || []).length === 6), r.out);
	}

	const w = world('noctl');
	w.run(['all']);
	w.deploy(false);
	const r = w.run(['bootstrap']);
	check('bootstrap refuses, non-zero, when daimond_ctl has no passcode-mint', r.code !== 0 && /passcode-mint/.test(r.out)
		&& !fs.existsSync(path.join(w.J, GW + '/keys/owner_join_code')), r.out);
}

// A host stood up as far as the bootstrap: pre, step 5, post.
const stoodUp = name => {
	const w = world(name);
	w.run(['all']);
	w.deploy();
	const r = w.run(['post']);
	if (r.code !== 0) console.log(r.out);
	return w;
};
const DOWN = path.join(REPO, 'dev', 'testnet_down.sh');

// ── Arm 7: the owner step ──────────────────────────────────────────────────
if (want(7)) {
	console.log('arm 7: owner <account-id>');
	const w = stoodUp('owner');
	const E = path.join(w.J, GW + '/gateway.env');
	const tpl = rendered(w.J);
	const r = w.run(['owner', 'acct_Fix-01']);
	check('owner: exit 0', r.code === 0, r.out);
	check('owner: the template plus one owner line', rd(E) === tpl + 'DAIMOND_OWNER_ACCOUNTS=acct_Fix-01\n', rd(E));
	check('owner: gateway.env still 600', (fs.statSync(E).mode & 0o777) === 0o600);
	check('owner: the unit restarted', /^systemctl «restart» «daimond-testnet»/m.test(r.log), r.log);
	const before = snap(w.J, w.E);
	for (const s of [['owner', 'acct_Fix-01'], ['unit']]) {
		const a = w.run(s);
		check(`${s[0]} again: exit 0, nothing mutating`, a.code === 0 && !MUTATING.test(a.log), a.out + (a.log.match(MUTATING) || [''])[0]);
	}
	const d = diff(before, snap(w.J, w.E));
	check('owner, then unit, again: the owner line kept, every tree equal', d === '', d);
	const c = w.run(['owner', 'acct_Two']);
	check('a second owner replaces the first', c.code === 0 && rd(E) === tpl + 'DAIMOND_OWNER_ACCOUNTS=acct_Two\n', rd(E));
	for (const bad of [[], ["acct;rm -rf ~"], ['a'.repeat(65)]]) {
		const b4 = snap(w.J, w.E);
		const b = w.run(['owner', ...bad]);
		check(`owner ${bad.length ? JSON.stringify(bad[0].slice(0, 16)) : '(none)'}: refused before any remote call`, b.code !== 0 && b.log === '' && diff(b4, snap(w.J, w.E)) === '', b.out);
	}
}

// ── Arm 8: the tear-down ───────────────────────────────────────────────────
if (want(8)) {
	console.log('arm 8: testnet_down.sh');
	const prodOf = w => snap(path.join(w.J, 'usr/daimond-gateway'), path.join(w.J, '.config/oxedyne/daimond'), path.join(w.J, 'usr/steel-prod/www'));
	{
		const w = stoodUp('down-dry');
		const before = snap(w.J, w.E, w.A, path.join(w.S, 'sysd')) + rd(path.join(w.S, 'endpoints.json'));
		const r = w.run(['--dry-run'], DOWN);
		check('dry-run: exit 0', r.code === 0, r.out);
		check('dry-run: the test endpoint is listed', /^down: sandbox webhook endpoint we_fixture1 for https:\/\/test\.daimond\.oxedyne\.com\/webhook\/stripe$/m.test(r.out), r.out);
		check('dry-run: the plan is printed', /\[dry-run\] down: stop and disable/.test(r.out) && /rm -rf/.test(r.out), r.out);
		check('dry-run: the key root is listed for removal', /^\[dry-run\] down: .*the key root \$HOME\/\.config\/oxedyne\/daimond-testnet\/gateway-keys/m.test(r.out), r.out);
		check('dry-run: no mutating call', !MUTATING.test(r.log), (r.log.match(MUTATING) || [''])[0]);
		const d = diff(before, snap(w.J, w.E, w.A, path.join(w.S, 'sysd')) + rd(path.join(w.S, 'endpoints.json')));
		check('dry-run: no file written, no endpoint deleted', d === '', d);
	}
	for (const [k, v] of [['NET_GW_DIR', "'~/usr/daimond-gateway'"], ['NET_WWW_PARENT', "'~/usr/steel-prod/www'"], ['NET_UNIT', "'daimond-gateway'"]]) {
		const w = stoodUp(`down-forced-${k}`);
		const C = path.join(w.W, 'repo');
		fs.mkdirSync(path.join(C, 'dev'), { recursive: true });
		fs.cpSync(path.join(REPO, 'deploy'), path.join(C, 'deploy'), { recursive: true });
		for (const f of ['testnet_standup.sh', 'testnet_down.sh']) fs.copyFileSync(path.join(REPO, 'dev', f), path.join(C, 'dev', f));
		const tf = path.join(C, 'deploy/net/test.env');
		fs.writeFileSync(tf, fs.readFileSync(tf, 'utf8').replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`));
		const before = snap(w.J, w.E);
		for (const dry of [[], ['--dry-run']]) {
			const r = w.run(dry, path.join(C, 'dev/testnet_down.sh'));
			check(`down${dry.length ? ' --dry-run' : ''}, ${k}=${v}: refused before any remote call`, r.code !== 0 && /refuse/i.test(r.out) && r.log === '', r.out + r.log);
		}
		check(`down, ${k}: nothing removed`, diff(before, snap(w.J, w.E)) === '');
	}
	{
		const w = stoodUp('down-link');
		const G = path.join(w.J, GW);
		fs.rmSync(G, { recursive: true, force: true });
		fs.symlinkSync(path.join(w.J, 'usr/daimond-gateway'), G);
		const before = prodOf(w);
		const r = w.run([], DOWN);
		check('down: a symlinked test dir is refused, non-zero', r.code !== 0 && /symlink/.test(r.out), r.out);
		check('down: and production\'s dir is whole', diff(before, prodOf(w)) === '' && fs.existsSync(path.join(w.J, 'usr/daimond-gateway/keys/stripe/sandbox/sk')));
	}
	{
		const w = stoodUp('down');
		const before = prodOf(w);
		const r = w.run([], DOWN);
		check('down: exit 0', r.code === 0, r.out);
		const iList = r.log.indexOf('«https://api.stripe.com/v1/webhook_endpoints?limit=100»'), iDel = r.log.indexOf('«DELETE»');
		check('down: listed, then deleted', iList >= 0 && iList < iDel && /^down: sandbox webhook endpoint we_fixture1 /m.test(r.out), r.out);
		const eps = JSON.parse(rd(path.join(w.S, 'endpoints.json')));
		check('down: only the test endpoint is gone', eps.length === 1 && eps[0].id === 'we_prod1', JSON.stringify(eps));
		check('down: unit stopped, disabled, its file removed',
			!fs.existsSync(path.join(w.S, 'sysd/active_daimond-testnet')) && !fs.existsSync(path.join(w.S, 'sysd/enabled_daimond-testnet'))
			&& !fs.existsSync(path.join(w.E, 'etc/systemd/system/daimond-testnet.service')), r.log);
		check('down: the test dir and www-test removed', !fs.existsSync(path.join(w.J, GW)) && !fs.existsSync(path.join(w.J, WWWP)));
		check('down: the key root removed', !fs.existsSync(KR(w.J)) && fs.existsSync(path.join(w.J, '.config/oxedyne/daimond/gateway-keys/stripe/sandbox/sk')));
		check('down: production untouched', diff(before, prodOf(w)) === '');
		let l = r.log; for (const a of PROD_READS) l = l.split(a).join('');
		const hits = l.split('\n').filter(x => PROD.some(t => x.includes(t)));
		check('down: production names only in the read-only set', hits.length === 0, hits.join('\n'));
		const again = w.run([], DOWN);
		check('down again: exit 0, nothing left to do', again.code === 0 && !/«DELETE»|«stop»|«disable»/.test(again.log), again.out);
	}
}

// ── Arm 9: the key root ────────────────────────────────────────────────────
if (want(9)) {
	console.log('arm 9: the key root, outside ~/usr, and keys/ a link to it');
	{
		const w = world('kr');
		const r = w.run(['dirs']);
		const G = path.join(w.J, GW), K = path.join(G, 'keys');
		const isLink = fs.existsSync(K) && fs.lstatSync(K).isSymbolicLink();
		check('dirs: exit 0', r.code === 0, r.out);
		check('dirs: keys/ is a link to the key root', isLink && fs.readlinkSync(K) === KR(w.J), isLink ? fs.readlinkSync(K) : 'not a link');
		const m = p => fs.existsSync(p) ? (fs.statSync(p).mode & 0o777).toString(8) : 'absent';
		check('dirs: the key root and every key dir are 700', ['', 'stripe', 'stripe/sandbox', 'openrouter', 'openrouter/sandbox', 'licence', 'db']
			.every(d => m(path.join(KR(w.J), d)) === '700'), m(KR(w.J)));
		check('dirs: the key root is outside ~/usr', !KR(w.J).startsWith(path.join(w.J, 'usr') + '/'));
		const before = snap(w.J);
		const again = w.run(['dirs']);
		check('dirs again: exit 0, every tree equal', again.code === 0 && diff(before, snap(w.J)) === '', again.out + diff(before, snap(w.J)));
	}
	for (const [name, make, re] of [
		['a real keys/ directory', K => fs.mkdirSync(K, { recursive: true, mode: 0o700 }), /real directory/],
		['a keys/ link to elsewhere', K => { fs.mkdirSync(path.dirname(K), { recursive: true }); fs.symlinkSync('/tmp', K); }, /links to/],
	]) {
		const w = world('kr-refuse');
		const K = path.join(w.J, GW + '/keys');
		make(K);
		const before = snap(w.J);
		const r = w.run(['dirs']);
		check(`dirs over ${name}: refused, non-zero`, r.code !== 0 && /refused/.test(r.out) && re.test(r.out), r.out);
		check(`dirs over ${name}: nothing made`, diff(before, snap(w.J)) === '' && !fs.existsSync(KR(w.J)), diff(before, snap(w.J)));
	}
}

// ── Arm 10: the working dir, from NET_GW_DIR ───────────────────────────────
if (want(10)) {
	console.log('arm 10: the working dir is NET_GW_DIR, and the dry-run hides no failing step');
	{
		const w = world('wd-dry');
		const r = w.run(['dirs', '--dry-run']);
		check('dirs --dry-run, writable parents: exit 0', r.code === 0, r.out);
		check('dirs --dry-run: each dir it would make, with its parent writable',
			[`$HOME/${GW}`, `$HOME/${WWWP}`].every(d => r.out.split('\n').some(l => l.includes(`would make ${d} `) && / writable/.test(l) && !/NOT writable/.test(l))), r.out);
	}
	{
		const w = world('wd-ro');
		const P = path.dirname(path.join(w.J, GW));
		fs.mkdirSync(P, { recursive: true });
		fs.chmodSync(P, 0o555);
		const before = snap(w.J);
		const d = w.run(['dirs', '--dry-run']);
		const rel = '$HOME/' + path.relative(w.J, P);
		check('dirs --dry-run, an unwritable parent: named, non-zero', d.code !== 0
			&& d.out.split('\n').some(l => l.includes(`would make $HOME/${GW} `) && l.includes(`${rel} NOT writable`)), d.out);
		const r = w.run(['dirs']);
		check('dirs, an unwritable parent: non-zero, names it', r.code !== 0 && r.out.includes(`${rel} is not writable`), r.out);
		check('dirs, an unwritable parent: nothing made', diff(before, snap(w.J)) === '' && !fs.existsSync(KR(w.J)), diff(before, snap(w.J)));
		fs.chmodSync(P, 0o755);
	}
	{
		const w = world('wd-lens');
		const r = w.run(['lens', '--dry-run']);
		check('lens --dry-run says would change, not changed', /^lens: would change /m.test(r.out) && !/^lens: changed/m.test(r.out), r.out);
	}
	{
		const w = world('wd-env');
		w.run(['all']);
		const v = (rd(path.join(w.J, GW, 'gateway.env')).match(/^DAIMOND_RELEASES_FILE=(.*)$/m) || [])[1] || '';
		check('DAIMOND_RELEASES_FILE renders absolute, under NET_WWW_PARENT', path.isAbsolute(v) && v.startsWith(path.join(w.J, WWWP) + '/'), v);
	}
	{
		const old = 'usr/' + 'daimond-testnet';
		const g = spawnSync('git', ['grep', '-n', '-F', old], { cwd: REPO, encoding: 'utf8' });
		check(`no literal ${old} left in the tree`, g.status === 1 && g.stdout === '', g.stdout);
	}
}

// ── Arm 6: no secret in any output or argv ─────────────────────────────────
if (want(6)) {
	console.log('arm 6: no key or join-code value reaches stdout, stderr or an argv');
	const kps = [];
	for (const d of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []) {
		const f = path.join(ROOT, d, 'jarrah', GW, 'keys/licence/ed25519_kp_b64url');
		if (fs.existsSync(f)) kps.push(fs.readFileSync(f, 'utf8').trim());
	}
	check('at least one licence keypair to look for', kps.length > 0);
	const outs = allOut.join('\n');
	const logs = fs.readdirSync(ROOT).map(d => path.join(ROOT, d, 'state/calls.log')).filter(fs.existsSync).map(f => readPage(f, 'utf8')).join('\n');
	for (const [n, v] of [['sandbox sk', SK], ['whsec', WHSEC], ['join code', JOIN], ...kps.map((k, i) => [`licence keypair ${i}`, k])]) {
		check(`${n}: not in stdout or stderr`, !outs.includes(v));
		check(`${n}: not in any tool's argv`, !logs.split('\n').filter(l => !l.startsWith(' ')).some(l => /^(ssh|sudo|systemctl|curl|daimond_ctl) /.test(l) && l.includes(v)));
	}
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
