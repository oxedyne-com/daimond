// verify_kitfence.mjs — the toolchain clamp, end to end, through the relay.
//
// The two clamps on a fence disagreed with each other, and the disagreement was
// invisible because the toolkit path had only ever been driven over a direct
// pipe. Over a pipe there is no relay, and the relay is the end that refused.
//
//   `ext/hand.js`    refused every fence root outside the granted folder.
//                    A toolchain is outside the granted folder by construction
//                    -- cargo lives under ~/.cargo -- so a granted Rust toolkit
//                    made every command fail, while `prompts::machine_note` had
//                    already told the daimon that cargo was on its PATH.
//   `hand/src/exec.rs` `vet_roots` allowed EVERY toolchain folder, to every
//                    fence, at either level, whether or not any toolkit had been
//                    granted. ~/.local/bin is first on PATH and is a READ grant
//                    in the app's own table; the clamp accepted it as writable.
//                    A file called `ls` written there is unfenced execution as
//                    the user on the next shell command.
//
// The second was unreachable through Chrome only because the first sat in front
// of it, so fixing either alone was dangerous. This drives both, in one browser,
// against the real binary.
//
// ── What is proved, and what could fake it ──────────────────────────
//
// Every check names a REAL directory on this machine and asks a REAL kernel. The
// two ends are told apart by their sentences, which is the whole point: a
// refusal from the relay and a refusal from the hand are different failures with
// different fixes, and a test that only asserted "it was refused" would have
// passed against the broken code for the wrong reason.
//
//   the relay's:  "outside ... which is the folder this machine's hand was granted"
//   the hand's:   "asks to WRITE ..." / "is not a folder one of the toolkits this request named"
//
// The shim case is the exploit itself, not a model of it: the file is written to
// a real path on PATH, and its absence afterwards is checked on disk.
//
// ── Running it ──────────────────────────────────────────────────────
//
//	xvfb-run -a -s "-screen 0 1400x900x24" node dev/verify_kitfence.mjs
//
//	  --keep   leave the scratch tree behind for inspection
//
// Headed, because Chromium loads an unpacked extension in no other mode.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { open as openApp, scratch } from './harness.mjs';

const HERE	= path.dirname(fileURLToPath(import.meta.url));
const ROOT	= path.join(HERE, '..');
const SRC	= path.join(ROOT, 'ext');
const EXTID	= 'mpliijponglmmffjnonahhignkpkhmij';
const INSTALL	= path.join(ROOT, 'hand/install/install.sh');
const HAND	= path.join(ROOT, 'hand/target/release/daimond-hand');

const KEEP	= process.argv.slice(2).includes('--keep');

const BASE	= scratch('kitfence');
const PROFILE	= path.join(BASE, 'profile');
const JOURNAL	= path.join(BASE, 'journal');
const GRANT	= path.join(BASE, 'work');
const HOSTS	= path.join(PROFILE, 'NativeMessagingHosts');

const HOME	= os.homedir();
/// A name nothing on this machine has, in the directory the exploit targets.
const SHIM	= path.join(HOME, '.local/bin', 'zzz_daimond_kitfence_probe');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const note = (s) => console.log('  ·    ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listening(port) {
	return new Promise((resolve) => {
		const s = net.connect(port, '127.0.0.1');
		s.once('connect', () => { s.destroy(); resolve(true); });
		s.once('error', () => resolve(false));
	});
}

const started = [];
async function serve(name, args, port) {
	if (await listening(port)) { note(`${name} already up on ${port}`); return; }
	const p = spawn('node', args, { cwd: ROOT, stdio: 'ignore' });
	started.push(p);
	for (let i = 0; i < 100; i++) {
		if (await listening(port)) { note(`started ${name} on ${port}`); return; }
		await sleep(100);
	}
	throw new Error(`${name} did not come up on ${port}`);
}

// ── Build and install ───────────────────────────────────────────────

fs.rmSync(BASE, { recursive: true, force: true });
for (const d of [PROFILE, JOURNAL, GRANT, HOSTS]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(JOURNAL, 0o700);
fs.writeFileSync(path.join(GRANT, 'inside.txt'), 'a file inside the grant\n');

// `CARGO_TARGET_DIR` is REMOVED from the build's environment, and it is not a
// tidying: an agent working in this tree usually has one set, cargo would then
// write the new binary there, and `hand/target/release/daimond-hand` — the path
// the installer registers and this test runs — would be whatever was built last
// week. Measured: with one inherited, this file passed its relay checks and
// wrote a real shim into ~/.local/bin, because the binary under test was the one
// from before the clamp existed. A stale artefact is the second finding of the
// 2026-08-02 audit and this is exactly how it happens.
const buildEnv = { ...process.env };
delete buildEnv.CARGO_TARGET_DIR;
const built = spawnSync('cargo', ['build', '--release', '--manifest-path', 'hand/Cargo.toml'],
	{ cwd: ROOT, encoding: 'utf8', env: buildEnv });
check('the hand builds from source', built.status === 0 && fs.existsSync(HAND),
	(built.stderr || '').split('\n').filter((l) => /^error/.test(l)).slice(0, 3).join(' | '));
if (built.status !== 0) { console.log('\n0 ok, 1 failed'); process.exit(1); }
// And the artefact is newer than the source it was supposedly built from, or
// this test is measuring a binary somebody else's build left behind.
const handAt = fs.statSync(HAND).mtimeMs;
const srcAt = ['hand/src/exec.rs', 'hand/src/main.rs', 'hand/src/wire.rs', 'hand/src/codec.rs']
	.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f))
	.reduce((a, f) => Math.max(a, fs.statSync(f).mtimeMs), 0);
check('and the binary under test is newer than the hand\'s source', handAt >= srcAt,
	`binary ${new Date(handAt).toISOString()} vs source ${new Date(srcAt).toISOString()}`);

fs.writeFileSync(path.join(JOURNAL, 'root.txt'),
	`# The one folder Daimond's machine hand may work in.\n${GRANT}\n`);

const inst = spawnSync('bash', [INSTALL, '--dir', HOSTS, HAND], { cwd: ROOT, encoding: 'utf8' });
check('install.sh registers the real binary in the test profile', inst.status === 0,
	(inst.stderr || inst.stdout || '').trim().split('\n').slice(-1)[0]);

process.env.DAIMOND_HAND_JOURNAL_DIR = JOURNAL;
delete process.env.DAIMOND_HAND_ROOT;

await serve('dev server', ['dev/serve.mjs'], 8777);
await serve('mock provider', ['dev/mockllm.mjs'], 9099);

// The one toolchain folder this machine is asked about. Read only, never
// written: the point is that a fence may NAME it, not that anything changes.
const CARGO_BIN = path.join(HOME, '.cargo/bin');
const haveCargo = fs.existsSync(CARGO_BIN);
if (!haveCargo) note(`~/.cargo/bin is absent, so the "it runs" half is skipped`);

// The shim must not exist before this starts, or its absence afterwards proves
// nothing and its presence would be somebody else's file.
if (fs.existsSync(SHIM)) {
	console.log(`  refusing to run: ${SHIM} already exists, and this test would delete it.`);
	process.exit(2);
}
fs.mkdirSync(path.dirname(SHIM), { recursive: true });

// ── The browser ─────────────────────────────────────────────────────

const s = await openApp({ headed: true, name: 'kitfence', extension: SRC, profile: PROFILE });
const b = s.browser;
const page = s.page;

/// Click Allow in the extension's grant window, in the background.
async function allowHand(ms = 30000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		for (const p of b.pages()) {
			if (/grant\.html/.test(p.url())) {
				await p.waitForLoadState('domcontentloaded').catch(() => {});
				await sleep(300);
				await p.click('#allow').catch(() => {});
				return true;
			}
		}
		await sleep(150);
	}
	return false;
}

/// Send one exec down the relay, exactly as `Tool::run` composes it, and return
/// what came back — the answer, or the sentence that refused it.
///
/// # Arguments
/// * `spec` - The `exec` request, fence and toolkits included.
async function send(spec) {
	const raw = await page.evaluate((sp) =>
		window.DaimondHand.run(JSON.stringify(sp))
			.then((v) => ({ ok: v }), (e) => ({ err: (e && e.message) || String(e) })), spec);
	if (raw.err) return { refused: raw.err, from: 'link' };
	let v = {};
	try { v = JSON.parse(raw.ok); } catch (e) { return { refused: raw.ok, from: 'unreadable' }; }
	if (v.refused) {
		// Which end refused it. The relay screens before anything is forwarded;
		// the hand refuses in its own voice, and the two are different failures.
		const relay = /is the folder this machine's hand was granted|no root at all|working directory/.test(v.refused);
		return { refused: v.refused, from: relay ? 'relay' : 'hand' };
	}
	return { out: v };
}

let seq = 0;
const exec = (argv, fence, toolkits) => ({
	t: 'exec', id: 'kf-' + (++seq), argv, cwd: GRANT, env: [], stdin: null,
	timeout_ms: 30000, capture: 'both', fence, toolkits,
});
const F = (rw, ro) => ({ rw: [GRANT].concat(rw || []), ro: ro || [], deny: [], net: false });

try {
	await sleep(500);
	check('the extension announced itself to the app',
		await page.evaluate(() => !!document.documentElement.dataset.daimondHands));

	await page.evaluate(() => window.DaimondHand._setWaitsForTest({ grace: 30000, slack: 60000, hello: 20000 }));

	// The first command opens the grant window; everything after it is quiet.
	const grant = allowHand();
	const first = await send(exec(['/bin/cat', 'inside.txt'], F(), []));
	await grant;
	check('a real hand paired and ran a command inside the grant',
		!!first.out && /a file inside the grant/.test(JSON.stringify(first.out)),
		JSON.stringify(first).slice(0, 240));

	const st = JSON.parse(await page.evaluate(() => window.DaimondHand.status()));
	check('the hand reports the home directory the clamp resolves against',
		(st.caps || []).some((c) => c.indexOf('home:') === 0), (st.caps || []).join(' '));

	// ── 0b: a granted toolchain reaches the relay at all ────────────
	//
	// This is the check that fails against the code before today: the relay
	// refused the root and forwarded NOTHING, so the daimon met a refusal about
	// a folder it could do nothing about.
	if (haveCargo) {
		const r = await send(exec(['/bin/ls', CARGO_BIN], F([], [CARGO_BIN]), ['rust']));
		check('a granted toolchain folder is forwarded by the relay and read by the command',
			!!r.out, JSON.stringify(r).slice(0, 300));
		check('and the relay did not refuse it for being outside the grant',
			r.from !== 'relay', String(r.refused || '').slice(0, 200));
	}

	// ── The relay still holds the line where nothing was granted ────
	if (haveCargo) {
		const r = await send(exec(['/bin/ls', CARGO_BIN], F([], [CARGO_BIN]), []));
		check('the same fence with NO toolkit granted is refused by the relay',
			r.from === 'relay', `${r.from}: ${String(r.refused || '').slice(0, 200)}`);
		check('and the relay says which of the two things was missing',
			/granted no toolchain/.test(String(r.refused || '')), String(r.refused || '').slice(0, 240));
	}

	// ── The hand's exact clamp: the toolkit has to be the right one ─
	if (haveCargo) {
		const r = await send(exec(['/bin/ls', CARGO_BIN], F([], [CARGO_BIN]), ['node']));
		check('a Rust folder named by a request that granted only Node is refused by the HAND',
			r.from === 'hand' && /toolkits this request named/.test(String(r.refused || '')),
			`${r.from}: ${String(r.refused || '').slice(0, 240)}`);
	}

	// ── 0c: the shim. The exploit, on the real path, at the real level ─
	//
	// `~/.local/bin` is a READ grant in the app's table and first on PATH. The
	// request names python, so the relay forwards it — which is exactly the
	// interaction that made 0c dangerous once 0b was fixed — and the hand has to
	// be the thing that refuses it.
	const LOCALBIN = path.join(HOME, '.local/bin');
	const shimSpec = exec(
		['/bin/sh', '-c', `printf '#!/bin/sh\\necho OWNED\\n' > ${SHIM} && chmod 755 ${SHIM}`],
		F([LOCALBIN], []), ['python']);
	const shim = await send(shimSpec);
	check('writing a shim into ~/.local/bin is refused',
		!shim.out, JSON.stringify(shim).slice(0, 300));
	check('and it is the HAND that refuses it, on the level and not on the folder',
		shim.from === 'hand' && /asks to WRITE/.test(String(shim.refused || '')),
		`${shim.from}: ${String(shim.refused || '').slice(0, 260)}`);
	check('and no shim was written to the real directory on PATH',
		!fs.existsSync(SHIM), SHIM);

	// The control, without which the absence above proves nothing: the same file
	// is perfectly writable with nothing fencing it.
	fs.writeFileSync(SHIM, '#!/bin/sh\necho control\n');
	const controlWrote = fs.existsSync(SHIM);
	fs.rmSync(SHIM, { force: true });
	check('while that same path is writable with nothing fencing it', controlWrote, SHIM);

	// ── And the cache a build genuinely writes is still allowed ─────
	//
	// A clamp that refuses `~/.cargo/registry` is a clamp that stops cargo, and a
	// security check that breaks the build is one somebody switches off.
	const REG = path.join(HOME, '.cargo/registry');
	if (fs.existsSync(REG)) {
		const r = await send(exec(['/bin/ls', REG], F([REG], []), ['rust']));
		check('the writable cache a granted Rust toolkit needs is accepted at rw',
			!!r.out, JSON.stringify(r).slice(0, 240));
	}

	// ── What the review could not break must stay unbroken ──────────
	for (const bad of ['/etc', '/', path.join(HOME, '.ssh'), HOME]) {
		const r = await send(exec(['/bin/ls', bad], F([bad], []), ['rust', 'node', 'python', 'go']));
		check(`rw:["${bad}"] is refused even with every toolkit named`, !r.out,
			JSON.stringify(r).slice(0, 200));
	}

	const noise = s.errs.filter((e) => !/favicon|ERR_ABORTED|502|Bad Gateway/i.test(e));
	check('the page threw nothing along the way', noise.length === 0, noise.slice(0, 3).join(' | '));
} finally {
	fs.rmSync(SHIM, { force: true });
	await b.close().catch(() => {});
	for (const p of started) { try { p.kill(); } catch (e) { /* already gone */ } }
	if (!KEEP) fs.rmSync(BASE, { recursive: true, force: true });
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
