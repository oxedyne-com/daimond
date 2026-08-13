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
// ── A CHAT HAS A WORKSPACE, and a command runs where the user marked ─
//
// Rewritten on 2026-08-13. From 5389864 a chat's commands run only in the folders
// the user marked into that chat's workspace, and this file drove a chat that had
// marked in nothing — so `Tool::Run` refused every command on the `default_cwd`
// path, in its own words, BEFORE the fence was ever consulted, and sixteen checks
// went red against the world as it used to be rather than against a defect. The
// refusal was right; the fixture was out of date.
//
// So the granted folder now holds a folder INSIDE it, `marked/`, and the chat is
// given that one. Three things follow, and each is asserted below:
//
//   * WITH NOTHING MARKED IN, a command is refused and the sentence says what to
//     do about it. (Half one, and worth nothing on its own — a refusal is also
//     what a wholly broken chain produces.)
//   * WITH THE FOLDER MARKED IN, a real process starts in it and its real output
//     and real exit code reach the daimon. (Half two, which is what makes half
//     one mean something.)
//   * AND THE MARK IS THE WHOLE OF THE REACH: a file sitting in the granted root
//     but OUTSIDE the marked folder is refused BY THE KERNEL, and its nonce never
//     reaches the model. The grant is not the fence; the mark is.
//
// The folder is marked in through the `+` in the chat footer's workspace group —
// the app's own control, driven as a person drives it. It has to exist in the
// PAGE's workspace as well as on the machine, because that picker lists what
// `Files.entries` lists, and in a harness the page's workspace is OPFS. So the
// folder is laid down in both, and the two halves are the same folder by name.
// A fixture that instead wrote the holding onto the chat record would be proving
// the fence against a world only this file ever built, which is the mistake
// `dev/verify_scope.mjs` made and had to be rewritten out of.
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
//  6. **Mark a folder into the chat's workspace, with the paperclip.** The grant
//     says what Daimond MAY reach on this computer; the mark says where THIS
//     conversation works. Both are the user's own press, and neither stands in
//     for the other — which is why step 5 being stood in for leaves step 6 to be
//     done for real, through the control that does it.
//
// ── Proving it can fail ─────────────────────────────────────────────
//
// `--break <name>` serves a damaged `www/js/daimond.js` to the real page through
// `page.route`; the run is then expected to FAIL, and a break whose anchor does
// not match aborts rather than passing quietly. Both damage THE SCOPE THE PAGE
// ASKS FOR and never the engine, the hand or the kernel, which are the things
// under test.
//
//	node dev/verify_handreal.mjs --break nomark       # the mark never reaches the engine
//	node dev/verify_handreal.mjs --break inventscope  # the page invents a workspace
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
//	  --break <n>  serve a damaged page and expect failures (see above)
//
// Needs nothing running: the dev server and the mock provider are started here
// if they are not already up. Headed, because Chromium loads an unpacked
// extension in no other mode.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { open as openApp, newChat, chat, transcript, mockLog, clearMockLog, scratch } from './harness.mjs';
import { whyStaleBinary, whyStaleWasm, refuse } from './staleguard.mjs';

const HERE	= path.dirname(fileURLToPath(import.meta.url));
const ROOT	= path.join(HERE, '..');
const WWW	= path.join(ROOT, 'www');
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
//   base/work      THE GRANTED ROOT. What Daimond may reach on this computer at
//                  all — which is NOT the same as what any one chat may run in.
//   base/work/marked
//                  THE MARKED FOLDER: the one the user puts into this chat's
//                  workspace, and therefore the only place a command runs. It is
//                  mirrored in the page's own workspace so the app's own picker
//                  can offer it (see the header).
//   base/outside   deliberately NOT granted: the fence's job is to make this
//                  unreachable, and the secret in it is how that is proved.
const BASE	= scratch('handreal');
const PROFILE	= path.join(BASE, 'profile');
const JOURNAL	= path.join(BASE, 'journal');
const GRANT	= path.join(BASE, 'work');
const MARKED	= 'marked';
const MARKED_ABS = path.join(GRANT, MARKED);
const OUTSIDE	= path.join(BASE, 'outside');
const HOSTS	= path.join(PROFILE, 'NativeMessagingHosts');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// Both damage the page's answer to "what did the user mark into this chat?", and
// neither touches the engine, the hand or the kernel.
const BREAKS = {
	// The mark is made, the footer draws it, and the engine is handed nothing —
	// which is what the app did for every chat before the mark existed, and what a
	// caller does who forgets that `ws` is the field the fence is built from. This
	// is the exact state this file was red in from 5389864 until 2026-08-13.
	nomark: {
		file: 'js/daimond.js',
		find: `			.filter(function (a) { return !!a.ws; })`,
		with: `			.filter(function (a) { return false && !!a.ws; })`,
	},
	// The other direction, and the dangerous one: the page hands over a folder
	// nobody marked in, so a chat whose workspace is empty runs commands anyway.
	inventscope: {
		file: 'js/daimond.js',
		find: `		if (trashed(chatId)) return [];`,
		with: `		if (trashed(chatId)) return [];\n\t\treturn ['${MARKED}'];`,
	},
};

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

/// Serve one deliberately damaged file in place of the real one, before the app
/// is ever loaded. An anchor that does not match exactly once aborts the run: a
/// break that broke nothing would leave a green summary meaning the opposite of
/// what it says.
async function installBreak(page) {
	if (!BREAK) return;
	const spec = BREAKS[BREAK];
	if (!spec) {
		console.error(`--break ${BREAK}: no such break. One of: ${Object.keys(BREAKS).join(', ')}`);
		process.exit(2);
	}
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	const body = src.replace(spec.find, spec.with);
	await page.route('**/' + spec.file,
		(r) => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
}

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
for (const d of [PROFILE, JOURNAL, GRANT, MARKED_ABS, OUTSIDE]) fs.mkdirSync(d, { recursive: true });
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

// The nonces. THREE of them, because there are three places and only two used to
// be told apart:
//
//   INSIDE   in the marked folder, which a real command must be able to read.
//   UNMARKED in the granted root but NOT in the marked folder. The grant reaches
//            it and this chat does not, so the kernel must refuse it exactly as
//            it refuses the one outside the grant altogether. Without this file
//            the run cannot tell "fenced to the mark" from "fenced to the grant",
//            which since 5389864 is the difference the whole design turns on.
//   OUTSIDE  outside the grant entirely.
const INSIDE_NONCE   = nonce('inside');
const UNMARKED_NONCE = nonce('unmarked');
const OUTSIDE_NONCE  = nonce('secret');
fs.writeFileSync(path.join(MARKED_ABS, 'inside.txt'), INSIDE_NONCE + '\n');
fs.writeFileSync(path.join(GRANT, 'unmarked.txt'), UNMARKED_NONCE + '\n');
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

// What the children will bind: `serve.mjs` reads DAIMOND_PORT and `mockllm.mjs`
// DAIMOND_MOCK_PORT, so the wait below is asking about the port they chose.
const APP_PORT  = Number(process.env.DAIMOND_PORT || 8777);
const MOCK_PORT = Number(process.env.DAIMOND_MOCK_PORT || 9099);
await serve('dev server', ['dev/serve.mjs'], APP_PORT);
await serve('mock provider', ['dev/mockllm.mjs'], MOCK_PORT);

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
// And since 5389864 it is a stronger finding than it was: the toolchain must be
// inside the MARKED folder, not merely inside the grant, because the fence is
// built from the mark. `<grant>/toolchain` beside a marked `<grant>/project` is
// refused by the kernel like anything else the chat was not given.
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
	const farm = path.join(MARKED_ABS, 'toolchain');
	const cp = spawnSync('cp', ['-al', tc, farm], { encoding: 'utf8' });
	if (cp.status !== 0) return null;
	const proj = path.join(MARKED_ABS, 'proj');
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

const s = await openApp({
	headed: true, name: 'handreal', extension: SRC, profile: PROFILE, route: installBreak,
});
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

	// The chat every turn below is sent to, and therefore the chat whose workspace
	// decides where its commands may run. Opened before anything is asked of it,
	// because the folder is marked into THIS chat and a second one would have an
	// empty workspace of its own.
	await newChat(s);
	await sleep(400);
	const focus = await page.evaluate(() => window.DaimondAttach.focus());
	const chatId = focus && focus.id;
	check('a chat is in focus, so there is a workspace to mark a folder into',
		!!chatId && focus.kind === 'chat', JSON.stringify(focus));

	// The other half of the marked folder. `MARKED_ABS` is the directory on the
	// machine that the commands below actually run in; this is the same folder in
	// the workspace the PAGE holds, which in a harness is OPFS — no browser can be
	// made to answer `showDirectoryPicker()`, which is the same limitation the
	// pairing stand-in below exists for. It is laid down through the tool door,
	// which is how a turn would have made it, and it is what puts the folder in
	// front of the picker: `Files.entries` is the panel's own listing and lists
	// nothing that is not there.
	await page.evaluate(async (dir) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.run_tool('dir_create', JSON.stringify({ path: dir }));
	}, MARKED);

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

	// ── Half one: nothing marked in, and the model is told why ──────
	//
	// The hand is paired now, the fence is expressible, and there is still nowhere
	// for a command to go: the grant says what Daimond may reach on this computer,
	// and this chat has been given none of it. `Tool::Run` answers on the
	// `default_cwd` path, above the fence and above the hand — so nothing below is
	// reached and no process starts.
	const bare = await run(s, { argv: ['/bin/cat', 'inside.txt'], timeout_ms: 30000 });
	check('WITH NOTHING MARKED IN, a command is refused rather than run',
		/^Refused: /.test(bare) && /holds nothing on this computer/.test(bare), bare.slice(0, 200));
	check('and the sentence says what to do about it, and where',
		/paperclip/.test(bare) && /add it to this chat's workspace/.test(bare), bare.slice(0, 400));
	// The refusal a chat gets and the refusal a Diamond gets are different
	// sentences on purpose (`ToolContext::is_chat_scoped`), and a model handed the
	// wrong one is sent to a panel that is not where a chat's workspace is changed.
	// Asserted as a property OF THE REFUSAL — `!/Diamond/` is also true of a
	// command's output, so a check that only looked for the absence of the word
	// would pass in exactly the case where there is no refusal to describe.
	check('and it is the CHAT\'s words: no Diamond, no Workspace panel',
		/^Refused: /.test(bare) && !/Diamond/.test(bare), bare.slice(0, 300));
	check('and nothing ran: the nonce in the folder never reached the model',
		!bare.includes(INSIDE_NONCE) && !/exit code/.test(bare), bare.slice(0, 200));

	// ── The user marks the folder in, with the control that does it ─
	//
	// The `+` in the footer's workspace group: the one control whose whole job is
	// to put a folder into this chat's workspace, driven through its dialog as a
	// person drives it. Not `DaimondAttach.chatWs`, which would set the field and
	// prove only that the field exists — the press is the permission, and a press
	// that reached nothing is one of the two defects this surface was rebuilt over.
	await page.click('#chat-attachments .ws-group [data-act="attach-add"]', { force: true });
	await page.waitForSelector('.attach-pick-row', { timeout: 10000 });
	const ticked = await page.evaluate((name) => {
		const row = [...document.querySelectorAll('.attach-pick-row')]
			.find((x) => ((x.querySelector('.attach-pick-name') || {}).textContent || '').indexOf(name) >= 0);
		if (!row) return [...document.querySelectorAll('.attach-pick-name')]
			.map((x) => x.textContent).join(', ') || 'the picker listed nothing';
		row.querySelector('input').click();
		return 'ticked';
	}, MARKED);
	check('the folder is in the page\'s own workspace, for the picker to offer',
		ticked === 'ticked', ticked);
	await page.click('.dlg-ok', { force: true });
	await sleep(1000);
	const scope = await page.evaluate((id) => window.DaimondAttach.chatScope(id), chatId);
	check('MARKING IT IN is what the engine is handed as this chat\'s workspace',
		Array.isArray(scope) && scope.indexOf(MARKED) >= 0, JSON.stringify(scope));

	// ── Half two: a real process, and its real output ───────────────
	//
	// The same command as the refusal above, in the same chat, with one thing
	// changed: the folder is in the workspace now. That is the whole of the
	// difference, and it is what makes the refusal above evidence of a live
	// mechanism rather than of a chain that could not run anything either way.
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
	const allowed = await run(s, { argv: ['/bin/cat', path.join(MARKED_ABS, 'inside.txt')], timeout_ms: 30000 });
	check('while the same command on a file inside the fence succeeds',
		allowed.includes(INSIDE_NONCE) && /\[exit code: 0\]/.test(allowed), allowed.slice(0, 200));

	// ── THE MARK IS THE FENCE, NOT THE GRANT ───────────────────────
	//
	// `unmarked.txt` sits in the folder the user granted the hand — the same folder
	// `root.txt` names, the one every fence path is built from — and it is not in
	// the folder they marked into this chat. So the kernel must refuse it exactly
	// as it refuses the file outside the grant altogether.
	//
	// Without this the run cannot tell the two designs apart: a fence drawn round
	// the whole grant passes every other check in this file, which is what the
	// fixture was written against before 5389864 and what it would silently drift
	// back to. The control beside it is the check above, which reads a file inside
	// the mark with the same `cat` in the same chat.
	const grantedNotMarked = await run(s,
		{ argv: ['/bin/cat', path.join(GRANT, 'unmarked.txt')], timeout_ms: 30000 });
	check('a file in the GRANT but outside the MARK is refused by the kernel too',
		/Permission denied/i.test(grantedNotMarked), grantedNotMarked.slice(0, 300));
	check('and that nonce never reached the model either',
		!grantedNotMarked.includes(UNMARKED_NONCE), grantedNotMarked.slice(0, 200));
	const unfenced2 = spawnSync('/bin/cat', [path.join(GRANT, 'unmarked.txt')], { encoding: 'utf8' });
	check('and it too is perfectly readable with nothing fencing it',
		unfenced2.status === 0 && (unfenced2.stdout || '').includes(UNMARKED_NONCE),
		`exit ${unfenced2.status}`);

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
	// The hand's own record of WHERE it was told to work, which is the one account
	// of the working directory that the app did not write. Every exec it was sent
	// names the marked folder or something under it, and none names the granted
	// root itself — a fence round the grant would have started them all there.
	const cwds = lines
		.map((l) => (/"cwd"\s*:\s*"([^"]*)"/.exec(l) || [])[1])
		.filter((c) => !!c);
	// Composed from the root the HAND reported, not from this file's idea of where
	// the scratch tree is: the two differ the moment anything in the path is a
	// symlink, which is why `st.root` is compared against a realpath above.
	const wantCwd = `${st.root}/${MARKED}`;
	check('and the hand\'s own journal says every command ran in the marked folder',
		cwds.length > 0 && cwds.every((c) => c === wantCwd || c.indexOf(wantCwd + '/') === 0),
		JSON.stringify(cwds));
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
				cwd: `${MARKED}/proj`, timeout_ms: 600000,
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
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must.`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
	process.exit(bad.length ? 0 : 1);
}
process.exit(bad.length ? 1 : 0);
