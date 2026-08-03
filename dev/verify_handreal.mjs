// verify_handreal.mjs — the whole chain, with nothing mocked.
//
// Every other test of the machine hand stops one link short of the join:
//
//   `hand/src/*` unit tests   drive the runner in-process, no browser at all.
//   `dev/verify_hand.mjs`     real Chrome + real extension + the MOCK host,
//                             which speaks the protocol and runs nothing.
//   `dev/verify_handrun.mjs`  real Chrome + real extension + real app + the
//                             MOCK host: it proves the pipeline carries output
//                             and status faithfully, and says so itself.
//
// So the one thing nobody had watched happen was a daimon asking for a command
// and a process actually starting on this computer. That is this file:
//
//   real Chrome + the real extension + the real `daimond-hand` binary +
//   a real command + the real Landlock fence.
//
// The assertions are made against what the MODEL was sent — the mock provider's
// log — and against the KERNEL's own answers, not against the screen. "Something
// appeared in the panel" is not the question; "did a process run, and did its
// true output and true exit code reach the daimon" is.
//
// ── The two things a reader should be suspicious of ─────────────────
//
// A test that runs `echo hello` and finds "hello" has proved nothing a mock
// could not have faked. So:
//
//  * Every command that must prove REAL execution reads a nonce this run
//    generated a moment earlier and wrote to disk. A stand-in cannot invent it.
//  * The fence is proved by what the KERNEL refuses: a second nonce is written
//    OUTSIDE the granted folder, and the test asserts both that the command was
//    denied and that the nonce never reached the model.
//
// ── What a user must do, and what this test therefore does ──────────
//
//  1. `cargo build --release --manifest-path hand/Cargo.toml`  (NOT `-p`: the
//     hand is its own workspace).
//  2. `hand/install/install.sh` — run here with `--dir`, pointed at this test's
//     throwaway profile, so the user's real browser profile is never touched.
//     The real installer, not a copy of its output.
//  3. **Name the granted folder.** The hand refuses to serve without one, and
//     Chrome hands a native messaging host its OWN environment — so a variable
//     set in some terminal is not there when the browser launches the host. The
//     root therefore comes from `root.txt` beside the journal, which is the only
//     mechanism that works for a browser started from a desktop launcher. This
//     test asserts `DAIMOND_HAND_ROOT` is UNSET, so the root it reads back can
//     only have come from the file.
//  4. Allow the hand in the window that opens on the first command.
//  5. **Open the folder the hand was granted, in Daimond.** `hand/REVIEW.md`
//     §1.14 refuses a command where the two ends cannot be shown to mean one
//     folder, and no automated browser can satisfy that — a page holds a real
//     folder only through a native dialog no harness can answer. The refusal is
//     asserted here against the real hand and then stood in for; the note beside
//     the stand-in says exactly what is substituted and what is not.
//
// `DAIMOND_HAND_JOURNAL_DIR` is set here, and only for test isolation: without
// it the journal — and `root.txt` with it — would be written into the user's own
// `~/.local/share/daimond/hand/journal`, which is their configuration and not
// this test's to edit. A real user does not set it.
//
// ── Running it ──────────────────────────────────────────────────────
//
//	xvfb-run -a -s "-screen 0 1400x900x24" node dev/verify_handreal.mjs
//
//	  --no-cargo   skip the `cargo test` case (it costs about ten seconds)
//	  --keep       leave the scratch tree behind for inspection
//	  --wasm       rebuild the wasm bundle first
//
// Needs nothing running: the dev server and the mock provider are started here
// if they are not already up. Headed, because Chromium loads an unpacked
// extension in no other mode.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { open as openApp, chat, transcript, mockLog, clearMockLog, scratch } from './harness.mjs';
import { whyStaleBinary, whyStaleWasm, refuse } from './staleguard.mjs';

const HERE	= path.dirname(fileURLToPath(import.meta.url));
const ROOT	= path.join(HERE, '..');
const SRC	= path.join(ROOT, 'ext');		// harness swaps in the dev build
const EXTID	= 'mpliijponglmmffjnonahhignkpkhmij';
const INSTALL	= path.join(ROOT, 'hand/install/install.sh');
const HAND	= path.join(ROOT, 'hand/target/release/daimond-hand');

const argv	= process.argv.slice(2);
const NO_CARGO	= argv.includes('--no-cargo');
const KEEP	= argv.includes('--keep');
const WASM	= argv.includes('--wasm');

// One tree, so cleanup is one `rm -rf` and nothing of this test survives it.
//
//   base/profile   the browser's user-data-dir, and therefore the ONLY place a
//                  host manifest is written. The user's own browser is untouched.
//   base/journal   the hand's journal, and `root.txt` beside it.
//   base/work      THE GRANTED ROOT. Everything a command may touch.
//   base/outside   deliberately NOT granted: the fence's job is to make this
//                  unreachable, and the secret in it is how that is proved.
const BASE	= scratch('handreal');
const PROFILE	= path.join(BASE, 'profile');
const JOURNAL	= path.join(BASE, 'journal');
const GRANT	= path.join(BASE, 'work');
const OUTSIDE	= path.join(BASE, 'outside');
const HOSTS	= path.join(PROFILE, 'NativeMessagingHosts');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const note = (s) => console.log('  ·    ' + s);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// A value no stand-in could have invented, so finding it in what the model was
/// sent proves a real process read a real file.
const nonce = (tag) => `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

// ── The servers ─────────────────────────────────────────────────────
//
// Both, or nothing works and the reason is invisible: without the mock provider
// every model turn fails and the transcript says only that Daimond could not
// answer, which reads as a broken app rather than a missing server.

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

// ── What the model was shown ────────────────────────────────────────

/// The last tool result the model was sent, which is the whole point: a run that
/// draws output on the screen and hands the model nothing has achieved nothing.
function toolResult() {
	const reqs = mockLog();
	for (let i = reqs.length - 1; i >= 0; i--) {
		const msgs = reqs[i].messages || [];
		for (let j = msgs.length - 1; j >= 0; j--) {
			if (msgs[j].role === 'tool') return String(msgs[j].content || '');
		}
	}
	return '';
}

/// Run one command as a daimon would, and return what the model was handed.
///
/// # Arguments
/// * `s` - The session.
/// * `spec` - The `run` arguments, as the model would compose them.
/// * `timeout` - How long to wait for the turn.
async function run(s, spec, timeout = 120000) {
	clearMockLog();
	await chat(s, '@tool run ' + JSON.stringify(spec), { timeout });
	return toolResult();
}

// ── Build, install, configure ───────────────────────────────────────

fs.rmSync(BASE, { recursive: true, force: true });
for (const d of [PROFILE, JOURNAL, GRANT, OUTSIDE]) fs.mkdirSync(d, { recursive: true });
// 0700, and it is load-bearing. `root.txt` has to sit in the journal directory,
// which makes `journal::is_ours` answer no — the directory now holds something
// that is not the journal's own furniture — so the hand will NOT tighten it, and
// a directory anyone else can read is a refusal to start. The hand creates its
// own directory at 0700 on first run, so a user who lets it do that is fine; one
// who runs `mkdir -p` with the usual umask gets 0755 and a startup failure whose
// message names only the variable. Recorded here because the installer's README
// now has to say it.
fs.chmodSync(JOURNAL, 0o700);

// The release binary, into `hand/target` — the path `install.sh` looks in by
// default and the one `hand/install/README.md` names, so what is verified is
// what a reader of that file will have. Three other agents share this tree, so a
// build that fails because somebody is mid-edit is retried rather than fatal.
//
// `CARGO_TARGET_DIR` is REMOVED from the build's environment, and that is not
// tidying: an agent working in this tree usually has one set, cargo would write
// the new binary there, and `HAND` — the path `install.sh` registers and this
// test therefore runs — would still be whatever was built last. See the same
// note in `verify_kitfence.mjs`, where an inherited one made a security test
// pass against a binary from before the fix.
const buildEnv = { ...process.env };
delete buildEnv.CARGO_TARGET_DIR;
//
// `DAIMOND_NO_BUILD` skips the build and NOTHING else: the staleness guard below
// runs either way, so it cannot make this file report success against code it
// did not test — only refuse. It exists because cargo relinks an output it finds
// backdated, so with the build in the way the guard can never be watched
// refusing. Same hatch as `PTYEDGE_NO_BUILD` in verify_ptyedge.mjs.
let built = process.env.DAIMOND_NO_BUILD ? true : null;
for (let i = 1; i <= 3 && !built; i++) {
	const r = spawnSync('cargo', ['build', '--release', '--manifest-path', 'hand/Cargo.toml'],
		{ cwd: ROOT, encoding: 'utf8', env: buildEnv });
	if (r.status === 0) { built = true; break; }
	console.log((r.stderr || '').split('\n').filter((l) => /^error/.test(l)).slice(0, 5).join('\n'));
	if (i < 3) { note(`the hand did not build (attempt ${i}); waiting 30 s in case somebody is mid-edit`); await sleep(30000); }
}
check('the hand builds from source', !!built && fs.existsSync(HAND),
	built ? HAND : 'cargo build --release --manifest-path hand/Cargo.toml failed three times');
if (!built) { console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed'); process.exit(1); }

// A build that exits 0 is not the same claim as an artefact built from this
// tree. Cargo's own dep-info file is the oracle — it names every source that
// went into the link, this crate's and every fe2o3 crate's — so nothing is
// hardcoded and an upstream change counts as staleness.
refuse(whyStaleBinary(HAND, {
	subject: 'The hand, and therefore every fence below it,',
	what:    'hand',
	rebuild: 'cargo build --release --manifest-path hand/Cargo.toml',
}));

// ── And the app's half of it ────────────────────────────────────────
//
// The wasm the browser loads composes every request the hand is sent, so it is
// as much the code under test as the binary is. This used to WARN and carry on
// to a green summary, against a list of three hand-picked sources — which is two
// failures in one: `src/prompts.rs`, `src/skills.rs`, `src/wasm/opfs.rs` and
// `src/wasm/diamond.rs` all changed on 2026-08-03 and none of them was on the
// list, and a warning inside a run that then reports success is not a guard.
// Now it refuses, against every `.rs` there is.
const wasmFile = path.join(ROOT, 'www/pkg/oxedyne_daimond_bg.wasm');
if (WASM) {
	note('rebuilding the wasm bundle');
	spawnSync('bash', ['dev/build-wasm.sh'], { cwd: ROOT, stdio: 'inherit' });
}
refuse(whyStaleWasm(wasmFile, path.join(ROOT, 'src'), {
	subject: 'What the app asks the hand for',
	holds:   'every tool call this file makes',
}));

// The nonces. One inside the fence, which a real command must be able to read;
// one outside it, which the kernel must refuse and which must therefore never
// appear in anything the model is shown.
const INSIDE_NONCE  = nonce('inside');
const OUTSIDE_NONCE = nonce('secret');
fs.writeFileSync(path.join(GRANT, 'inside.txt'), INSIDE_NONCE + '\n');
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), OUTSIDE_NONCE + '\n');

// The granted root, named the way a browser-launched hand will actually read it:
// a line in `root.txt` beside the journal. The comment is not decoration — it is
// the first line of the file, and the hand is expected to skip it.
fs.writeFileSync(path.join(JOURNAL, 'root.txt'),
	`# The one folder Daimond's machine hand may work in.\n${GRANT}\n`);

// Register the REAL binary, with the REAL installer, into the test profile's own
// NativeMessagingHosts directory. `--dir` is the documented way to do exactly
// this, so running it here verifies the instruction as well as the outcome.
const inst = spawnSync('bash', [INSTALL, '--dir', HOSTS, HAND], { cwd: ROOT, encoding: 'utf8' });
const manifestPath = path.join(HOSTS, 'com.oxedyne.daimond.hand.json');
check('install.sh registers the real binary in the profile it was pointed at',
	inst.status === 0 && fs.existsSync(manifestPath),
	(inst.stderr || inst.stdout || '').trim().split('\n').slice(-2).join(' '));
let manifest = {};
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { /* checked below */ }
check('the manifest names the built hand and this extension',
	manifest.path === HAND && (manifest.allowed_origins || []).includes(`chrome-extension://${EXTID}/`),
	JSON.stringify(manifest.path) + ' ' + JSON.stringify(manifest.allowed_origins));

// Chrome hands the host its own environment, which is this process's. The
// journal is redirected so the user's own is not written to; the ROOT variable is
// removed so that the root the hand reports can only have come from `root.txt`.
process.env.DAIMOND_HAND_JOURNAL_DIR = JOURNAL;
delete process.env.DAIMOND_HAND_ROOT;

await serve('dev server', ['dev/serve.mjs'], 8777);
await serve('mock provider', ['dev/mockllm.mjs'], 9099);

// ── The toolchain, inside the granted folder ────────────────────────
//
// `cargo test` needs cargo, rustc and the sysroot, and the fence cannot reach
// them where they live. `fence_spec` in `src/tools.rs` builds every allowed path
// by joining a workspace-RELATIVE name onto the granted root, so no rule it can
// produce ever names `~/.cargo` or `~/.rustup`. The toolchain therefore has to be
// inside the granted folder, and it is put there with `cp -al` — a hard-link
// farm, which costs directory entries and no data.
//
// That is a real finding and not a convenience: as things stand, a user who
// wants a daimon to run `cargo test` must keep a toolchain inside the folder
// they granted, or `src/tools.rs` must learn to carve the toolchain in read-only.
//
// Nothing else is smuggled in. The environment is EMPTY — `src/tools.rs` sends
// `"env":[]` and `exec.rs` clears what is left — so cargo is told where rustc is
// through `.cargo/config.toml`, which cargo reads from the working directory
// upward. Nothing is said about `TMPDIR`: the hand gives every run a private
// scratch directory inside its fence and points `TMPDIR`, `TMP` and `TEMP` at
// it, which is what lets a build that writes temporary files finish at all. That
// is asserted below rather than assumed, because it is the difference between a
// linker that works and one that fails half way through.
function plantCargoProject() {
	const sysroot = spawnSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' });
	if (sysroot.status !== 0) return null;
	const tc = sysroot.stdout.trim();
	const farm = path.join(GRANT, 'toolchain');
	const cp = spawnSync('cp', ['-al', tc, farm], { encoding: 'utf8' });
	if (cp.status !== 0) return null;
	const proj = path.join(GRANT, 'proj');
	fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
	fs.mkdirSync(path.join(proj, '.cargo'), { recursive: true });
	fs.writeFileSync(path.join(proj, 'Cargo.toml'),
		'[package]\nname = "handreal"\nversion = "0.1.0"\nedition = "2021"\n');
	// The test asserts on a nonce, so a pass cannot come from a cached artefact
	// or from anybody's imagination: this source did not exist a second ago.
	fs.writeFileSync(path.join(proj, 'src/lib.rs'),
		`pub fn tag() -> &'static str { "${INSIDE_NONCE}" }\n`
		+ '#[cfg(test)]\nmod t {\n'
		+ `\t#[test] fn the_nonce_survives_a_real_compile() { assert_eq!(super::tag(), "${INSIDE_NONCE}"); }\n`
		+ '}\n');
	fs.writeFileSync(path.join(proj, '.cargo/config.toml'),
		`[build]\nrustc = "${farm}/bin/rustc"\nrustdoc = "${farm}/bin/rustdoc"\n\n`
		+ `[target.${process.arch === 'x64' ? 'x86_64' : process.arch}-unknown-linux-gnu]\n`
		+ 'linker = "/usr/bin/cc"\n');
	return { farm, proj };
}

// ── The browser ─────────────────────────────────────────────────────

const s = await openApp({ headed: true, name: 'handreal', extension: SRC, profile: PROFILE });
const b = s.browser;
const page = s.page;

/// Find the grant window and click Allow, in the background, while the turn that
/// provoked it is still running. It is the extension's own page, so the click is
/// a real one — and there is no second Chrome prompt behind it: that window IS
/// the approval.
async function allowHand(ms = 30000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		for (const p of b.pages()) {
			if (/grant\.html/.test(p.url())) {
				await p.waitForLoadState('domcontentloaded').catch(() => {});
				await sleep(300);
				const head = await p.evaluate(() =>
					(document.getElementById('head') || {}).textContent || '').catch(() => '');
				await p.click('#allow').catch(() => {});
				return head;
			}
		}
		await sleep(150);
	}
	return null;
}

let handPid = '';
try {
	await sleep(500);

	check('the extension announced itself to the app',
		await page.evaluate(() => !!document.documentElement.dataset.daimondHands));
	check('the page relay is loaded and wired',
		await page.evaluate(() => !!(window.DaimondHand && window.DaimondHand.run)));

	// A real compile is slower than a mock's scripted chatter, and the page's
	// own waits are what decide whether a quiet command is a dead one.
	await page.evaluate(() => window.DaimondHand._setWaitsForTest({
		grace: 60000, slack: 180000, hello: 30000,
	}));

	// ── The hand answers, and says what it can enforce ──────────────
	//
	// The FIRST command is not a command that runs. `hand/REVIEW.md` §1.14 is
	// armed: the hand was granted a folder on this machine, this page's workspace
	// is the browser's own sandbox, and the two cannot be shown to be the same
	// folder — so the daimon is handed a refusal instead of output. Asserted here,
	// on the real chain, because this is the only place in the repository where
	// that refusal meets a real hand.
	const grant = allowHand();
	const refused = await run(s, { argv: ['/bin/cat', 'inside.txt'], timeout_ms: 30000 });
	const head = await grant;
	check('running a command asks the user first, in the extension\'s own window',
		!!head && /computer/i.test(head), String(head));
	check('a command is REFUSED while the page cannot show it holds the hand\'s folder',
		/^Refused:/.test(refused)
		&& /lives in the browser and not in a folder on this machine/.test(refused),
		refused.slice(0, 240));
	check('and nothing ran: the model was given a sentence, not a result',
		!refused.includes(INSIDE_NONCE) && !/exit code/.test(refused), refused.slice(0, 200));

	const st = JSON.parse(await page.evaluate(() => window.DaimondHand.status()));
	check('a real hand answered, on the machine transport',
		st.transport === 'machine' && !!st.version, JSON.stringify(st).slice(0, 200));
	check('and the relay refuses the pairing over the folder, in so many words',
		st.paired === false && st.workspace === 'mismatch' && st.reason === st.workspace_reason,
		JSON.stringify(st).slice(0, 240));
	check('the granted root came from root.txt, with DAIMOND_HAND_ROOT unset',
		st.root === fs.realpathSync(GRANT), `${st.root} vs ${GRANT}`);
	check('the hand reports a kernel fence, not a claim of one',
		(st.caps || []).includes('fence:linux') && (st.caps || []).some((c) => /^landlock:abi-\d+$/.test(c)),
		(st.caps || []).join(' '));
	const wsCap = (st.caps || []).find((c) => c.indexOf('ws:') === 0) || '';
	check('and it published an identity for the folder it was granted, which is on disk',
		/^ws:[0-9a-f]{32}$/.test(wsCap) && fs.existsSync(path.join(GRANT, '.daimond/workspace.id'))
		&& fs.readFileSync(path.join(GRANT, '.daimond/workspace.id'), 'utf8').includes(wsCap.slice(3)),
		wsCap);
	note(`hand ${st.version} on ${st.os}: ${(st.caps || []).join(' ')}`);

	// ── Standing in for the folder verdict, and only for that ───────
	//
	// Every check below runs a command, and every one of them meets the refusal
	// just asserted. It cannot be arranged away: a page holds a real folder only
	// through `showDirectoryPicker()`, a native dialog no automated browser can
	// answer, so a headless run necessarily has an OPFS workspace and is
	// necessarily refused. There is no configuration in which this check passes by
	// accident, which is what makes standing in for it honest rather than a
	// weakening — `dev/verify_scope.mjs` stands in for the whole of `status` for
	// the same reason, and `dev/verify_wsident.mjs` tests the refusal itself,
	// against two real directory handles.
	//
	// Only the folder VERDICT is stood in for. What the hand said about itself —
	// its root, its caps, its os — passes through untouched, because the fence
	// every command below runs under is composed from it.
	await page.evaluate(() => {
		var real = window.DaimondHand.status;
		window.__realStatus = function () { return real.call(window.DaimondHand); };
		window.DaimondHand.status = function () {
			return real.call(window.DaimondHand).then(function (raw) {
				var out = JSON.parse(raw);
				if (out.workspace && out.workspace !== 'ok') {
					out.paired = true;
					delete out.reason;
					out.workspace = 'stood in for by verify_handreal.mjs';
				}
				return JSON.stringify(out);
			});
		};
	});
	const stood = JSON.parse(await page.evaluate(() => window.DaimondHand.status()));
	check('the stand-in changes the folder verdict and nothing else',
		stood.paired === true && stood.root === st.root && stood.os === st.os
		&& JSON.stringify(stood.caps) === JSON.stringify(st.caps),
		JSON.stringify(stood).slice(0, 200));

	// ── A real process, and its real output ─────────────────────────
	const first = await run(s, { argv: ['/bin/cat', 'inside.txt'], timeout_ms: 30000 });
	check('a real command\'s stdout reaches the model, nonce and all',
		first.includes(INSIDE_NONCE), first.slice(0, 240));
	check('and it is marked as a stranger\'s words, naming the command',
		/untrusted content begins — run: \/bin\/cat inside\.txt/.test(first), first.slice(0, 160));
	check('and carries a zero exit', /\[exit code: 0\]/.test(first), first.slice(-120));
	check('the person watching saw it too',
		(await transcript(s)).includes(INSIDE_NONCE), '');

	// The process really was fenced: something started, and the fence it started
	// under is the one the hand planned. Read from the hand's own journal below.

	// ── A real non-zero exit is reported as non-zero ────────────────
	//
	// This was a live defect: `extract_json_number` parses a u64, so the -1 that
	// means "no status" failed to parse and defaulted to ZERO, and a crashed
	// build was handed to the model as a green one.
	let r = await run(s, { argv: ['/bin/false'], timeout_ms: 30000 });
	check('a real non-zero exit reaches the model as itself',
		/\[exit code: 1\]/.test(r) && !/exit code: 0/.test(r), r.slice(-200));

	r = await run(s, { argv: ['/bin/cat', 'no-such-file-here.txt'], timeout_ms: 30000 });
	check('a command that fails hands the model its real stderr',
		/\[stderr\]/.test(r) && /No such file/i.test(r), r.slice(0, 240));
	check('and a non-zero code with it', /\[exit code: [1-9]/.test(r), r.slice(-120));

	// ── The kernel refuses, and the refusal reaches the model ───────
	//
	// Not a path check in the app, and not a string match in the hand: the file
	// exists, `cat` is a real `cat`, and the only thing between them is Landlock.
	const denied = await run(s, { argv: ['/bin/cat', path.join(OUTSIDE, 'secret.txt')], timeout_ms: 30000 });
	check('a file outside the fence is refused BY THE KERNEL',
		/Permission denied/i.test(denied), denied.slice(0, 300));
	check('and the secret outside the fence never reached the model',
		!denied.includes(OUTSIDE_NONCE), denied.slice(0, 200));
	check('the refusal arrives as a refusal, not as a Daimond error',
		/untrusted content begins/.test(denied) && /\[exit code: [1-9]/.test(denied)
			&& !/^Refused: the machine hand/.test(denied), denied.slice(0, 300));
	// Two controls, without which the denial above proves nothing at all. A
	// denial is only evidence of a fence if the same command succeeds when the
	// fence is the only thing that changed — so: the same `cat` on the same file
	// with NOTHING fencing it, and the same `cat` on a file inside the fence.
	const unfenced = spawnSync('/bin/cat', [path.join(OUTSIDE, 'secret.txt')], { encoding: 'utf8' });
	check('while that same file is perfectly readable with nothing fencing it',
		unfenced.status === 0 && (unfenced.stdout || '').includes(OUTSIDE_NONCE),
		`exit ${unfenced.status}`);
	const allowed = await run(s, { argv: ['/bin/cat', path.join(GRANT, 'inside.txt')], timeout_ms: 30000 });
	check('while the same command on a file inside the fence succeeds',
		allowed.includes(INSIDE_NONCE) && /\[exit code: 0\]/.test(allowed), allowed.slice(0, 200));

	// ── A program outside the fence is refused before it runs ───────
	//
	// The other flavour of refusal, and the one that should NOT look like output:
	// the hand vets `argv[0]` against the plan and says so in its own words.
	const outsideProg = await run(s, { argv: [HAND, '--version'], timeout_ms: 30000 });
	check('a program outside the fence is refused in the hand\'s own words',
		/^Refused:/.test(outsideProg) && /fence/i.test(outsideProg), outsideProg.slice(0, 300));
	check('and nothing of it ran', !/exit code/.test(outsideProg), outsideProg.slice(0, 200));

	// ── The journal on disk ─────────────────────────────────────────
	const files = fs.readdirSync(JOURNAL).filter((f) => /^hand-\d+\.jsonl$/.test(f));
	const lines = files.flatMap((f) =>
		fs.readFileSync(path.join(JOURNAL, f), 'utf8').split('\n').filter(Boolean));
	check('the hand wrote a journal beside root.txt', files.length > 0, files.join(' '));
	check('and it names the command that was run',
		lines.some((l) => l.includes('/bin/cat') && l.includes('inside.txt')),
		`${lines.length} entries`);
	check('and records the refusal as well as the runs',
		lines.some((l) => /refus/i.test(l)), `${lines.length} entries`);
	note(`${lines.length} journal entries in ${files.join(', ')}`);

	// ── The headline: a real cargo test ─────────────────────────────
	if (NO_CARGO) {
		note('skipping the cargo case (--no-cargo)');
	} else {
		const planted = plantCargoProject();
		if (!planted) {
			check('a real cargo test runs to completion and reaches the daimon', false,
				'the toolchain could not be hard-linked into the granted folder');
		} else {
			const c = await run(s, {
				argv: ['../toolchain/bin/cargo', 'test', '--offline'],
				cwd: 'proj', timeout_ms: 600000,
			}, 660000);
			check('a real cargo test compiled and ran inside the fence',
				/test result: ok\. 1 passed/.test(c), c.slice(0, 600));
			check('and the daimon was handed the test it actually ran',
				c.includes('the_nonce_survives_a_real_compile'), c.slice(0, 600));
			check('and a zero exit', /\[exit code: 0\]/.test(c), c.slice(-160));
			if (!/test result: ok/.test(c)) note('cargo said: ' + c.slice(0, 900));
		}
	}

	// 502s are the gateway proxy answering for a gateway nobody started; the
	// browser-only tiers carry on without it, which is what dev/serve.mjs says.
	const noise = s.errs.filter((e) => !/favicon|ERR_ABORTED|502|Bad Gateway/i.test(e));
	check('the page threw nothing along the way', noise.length === 0, noise.slice(0, 3).join(' | '));
} finally {
	await b.close().catch(() => {});
	for (const p of started) { try { p.kill(); } catch (e) { /* already gone */ } }
	// Chrome kills the host when the port dies; say so if one is still standing.
	const stray = spawnSync('pgrep', ['-fa', 'daimond-hand'], { encoding: 'utf8' });
	if (stray.status === 0 && (stray.stdout || '').trim()) {
		console.log('  ·    a hand process outlived the browser:\n' + stray.stdout.trim());
	}
	if (KEEP) {
		console.log('  ·    scratch kept at ' + BASE);
	} else {
		// The toolchain here is a hard-link farm: removing it removes links and
		// no data. Nothing under BASE is anybody's but this test's.
		fs.rmSync(BASE, { recursive: true, force: true });
	}
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
