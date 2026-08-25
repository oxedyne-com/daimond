// verify_scope.mjs — a worker is confined to its own Diamond, proved by running a command.
//
// `DaimondApp::set_diamond_scope` existed for a day with no caller anywhere in
// the repository. It is the only thing that ever assigns `ToolContext::no_write`
// in the browser build, so while it had none:
//
//   * `fence_spec` took its `scoped == false` branch and pushed the whole
//     granted root into `rw`. Every command a dispatched agent ran was fenced to
//     the entire folder the user gave the machine hand, not to one Diamond.
//   * `Bound::Toolkit` could not arrive at all, so `Kit::resolve` always
//     resolved to nothing and a granted toolchain was inert.
//
// This file is the acceptance test for the caller, and it is BEHAVIOURAL: it
// does not assert that a function was called or that a JSON string has a shape.
// It creates two Diamonds with a real secret in each, dispatches a worker into
// one, and asks the KERNEL whether that worker's command can read the other.
//
// ── What a scope fences, since 2026-08-13 ───────────────────────────
//
// A scope fences WRITING and RUNNING and leaves READING free inside whatever the
// user already opened (`Bound::OnlyWriteUnder` in src/tools.rs). That changes the
// shape of the scope this file reads back — it arrives in `write_allow`, not in
// `allow` — and changes NOTHING about the fence below, which is the point: a
// command is an opaque program, so `fence_spec` does not split its verbs, and the
// compartment the kernel proves here is the same compartment it proved before.
// If a later change makes a Diamond's command read the granted root, the three
// `cat` checks below go red, and they are meant to.
//
// ── Why it is written the way it is ─────────────────────────────────
//
// The fence is captured from `fence_spec` rather than composed here. A test that
// wrote out the expected fence by hand would be asserting that this file agrees
// with itself; what matters is what the engine actually sends, so the request is
// read back off the wire and the paths in it are compared with the Diamonds on
// disk.
//
// The secret in the other Diamond is a nonce generated a moment earlier. Finding
// it would be proof of a leak that nothing could have faked; not finding it is
// only worth something because the SAME command finds the nonce in its own
// Diamond, which is the control that runs beside it every time.
//
// ── The fixture that made this file prove the wrong world ───────────
//
// Until 2026-08-13 the two Diamonds were fenced to their OWN directories, and
// this file made those directories: `fs.mkdirSync(<grant>/diamonds/<id>)`. With
// that fixture on disk the fence resolved, the kernel duly proved the
// compartment, and the file was green throughout the fortnight in which every
// `run` in every chat and every Diamond terminal was refused in the field.
//
// A Diamond's own directory is in the BROWSER'S storage whatever folder is open
// (`is_store_path` in src/tools.rs), so nothing on the user's machine ever
// creates it. `fence_spec` mapped it under the granted root anyway, the hand
// could not canonicalise the path, and it refused the WHOLE fence — taking the
// user's real, attached, perfectly good folder down with it. The one directory
// this file created was the one whose absence was the bug.
//
// So the fixture is now what the app actually produces: two folders the user
// ATTACHED, `work-a` and `work-b`, one to each Diamond. Nothing under
// `<grant>/diamonds/` is created here, and a check below asserts that no path
// under it ever reaches the fence. The kernel is still the oracle and the
// compartment is still proved through it; only the world it is proved in is now
// the world the app inhabits.
//
// ── Running it ──────────────────────────────────────────────────────
//
//	xvfb-run -a -s "-screen 0 1400x900x24" node dev/verify_scope.mjs
//
//	  --keep            leave the scratch tree behind
//	  --engine <dir>    load the engine from `www/<dir>` instead of `www/pkg`,
//	                    which is how `dev/breakproof_storefence.sh` runs this
//	                    file against a bundle built with the fence break put
//	                    back. An ARGUMENT and never an environment variable: an
//	                    env var set once leaks into every later run in that
//	                    shell, and a verifier quietly measuring a package nobody
//	                    meant to test is the exact failure this file exists to
//	                    catch.
//
// Headed, because Chromium loads an unpacked extension in no other mode.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { open as openApp, scratch, MOCK } from './harness.mjs';
import { whyStaleBinary, whyStaleWasm, refuse } from './staleguard.mjs';

const HERE	= path.dirname(fileURLToPath(import.meta.url));
const ROOT	= path.join(HERE, '..');
const SRC	= path.join(ROOT, 'ext');
const INSTALL	= path.join(ROOT, 'hand/install/install.sh');
const HAND	= path.join(ROOT, 'hand/target/release/daimond-hand');

const KEEP	= process.argv.slice(2).includes('--keep');
/// Which directory under `www/` the page imports the engine from.
const ENGINE	= (() => {
	const i = process.argv.indexOf('--engine');
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'pkg';
})();

const BASE	= scratch('scope');
const PROFILE	= path.join(BASE, 'profile');
const JOURNAL	= path.join(BASE, 'journal');
const GRANT	= path.join(BASE, 'work');
const HOSTS	= path.join(PROFILE, 'NativeMessagingHosts');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const note = (s) => console.log('  ·    ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nonce = (tag) => `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

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

// CARGO_TARGET_DIR is removed, or the binary this registers is whatever was
// built last: see the same note in `verify_kitfence.mjs`, where an inherited one
// made a security test pass against a binary from before the fix.
const buildEnv = { ...process.env };
delete buildEnv.CARGO_TARGET_DIR;
// `DAIMOND_NO_BUILD` skips the build and NOTHING else: the staleness guard below
// runs either way, so it cannot make this file report success against code it did
// not test — only refuse. It exists because cargo relinks an output it finds
// backdated, so with the build in the way the guard can never be watched
// refusing. Same hatch as `PTYEDGE_NO_BUILD` in verify_ptyedge.mjs.
const built = process.env.DAIMOND_NO_BUILD ? { status: 0, stderr: '' }
	: spawnSync('cargo', ['build', '--release', '--manifest-path', 'hand/Cargo.toml'],
		{ cwd: ROOT, encoding: 'utf8', env: buildEnv });
check('the hand builds from source', built.status === 0 && fs.existsSync(HAND),
	(built.stderr || '').split('\n').filter((l) => /^error/.test(l)).slice(0, 3).join(' | '));
if (built.status !== 0) { console.log('\n0 ok, 1 failed'); process.exit(1); }

// A build that exits 0 says the compiler was happy, not that `HAND` is what it
// produced. Cargo's own dep-info file is the oracle — every source that went
// into the link, this crate's and every fe2o3 crate's.
refuse(whyStaleBinary(HAND, {
	subject: 'The fence this file measures',
	what:    'hand',
	rebuild: 'cargo build --release --manifest-path hand/Cargo.toml',
}));

// ── The engine's half ───────────────────────────────────────────────
//
// The wasm composes the fence the hand is handed, so it is the half under test
// here. This compared it against `src/tools.rs` and `src/wasm/app.rs` alone,
// which on 2026-08-03 missed `src/wasm/opfs.rs`, `src/wasm/diamond.rs`,
// `src/prompts.rs` and `src/skills.rs` — all changed that day — and misses every
// fe2o3 crate always. There is no dep-info to be had for a wasm bundle (see
// `dev/staleguard.mjs`), so the oracle is every `.rs` under `src/`: coarse, and
// a superset of anything hand-picked.
refuse(whyStaleWasm(path.join(ROOT, `www/${ENGINE}/oxedyne_daimond_bg.wasm`), path.join(ROOT, 'src'), {
	subject: 'The scope the engine composes',
	holds:   '`diamond_bounds` and the fence it builds',
}));
if (ENGINE !== 'pkg') {
	console.log(`\n  !!!! THIS RUN IS NOT A RESULT. The engine under test is www/${ENGINE}, which is`);
	console.log( '       not the app\'s bundle. It is here to be watched FAILING; a green run against');
	console.log( '       it would mean the checks below cannot tell the two worlds apart.\n');
}

fs.writeFileSync(path.join(JOURNAL, 'root.txt'),
	`# The one folder Daimond's machine hand may work in.\n${GRANT}\n`);
const inst = spawnSync('bash', [INSTALL, '--dir', HOSTS, HAND], { cwd: ROOT, encoding: 'utf8' });
check('install.sh registers the real binary in the test profile', inst.status === 0,
	(inst.stderr || inst.stdout || '').trim().split('\n').slice(-1)[0]);

process.env.DAIMOND_HAND_JOURNAL_DIR = JOURNAL;
delete process.env.DAIMOND_HAND_ROOT;

// What the children will bind: `serve.mjs` reads DAIMOND_PORT and `mockllm.mjs`
// DAIMOND_MOCK_PORT, so the wait below is asking about the port they chose.
const APP_PORT  = Number(process.env.DAIMOND_PORT || 8777);
const MOCK_PORT = Number(process.env.DAIMOND_MOCK_PORT || 9099);
await serve('dev server', ['dev/serve.mjs'], APP_PORT);
await serve('mock provider', ['dev/mockllm.mjs'], MOCK_PORT);

// ── The browser ─────────────────────────────────────────────────────

const s = await openApp({ headed: true, name: 'scope', extension: SRC, profile: PROFILE });
const b = s.browser;
const page = s.page;

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

const MINE  = nonce('mine');
const THEIRS = nonce('theirs');

try {
	await sleep(500);
	check('the extension announced itself to the app',
		await page.evaluate(() => !!document.documentElement.dataset.daimondHands));

	await page.evaluate(() => window.DaimondHand._setWaitsForTest({ grace: 30000, slack: 60000, hello: 20000 }));

	// The engine module, whichever package it comes from. `www/pkg` is the one
	// the app booted, so it is already initialised; ANY other package has never
	// been, and wasm-bindgen's exports are inert until it is — every call comes
	// back "Cannot read properties of undefined (reading '__wbindgen_malloc')".
	// Once per package, because a second `init()` instantiates a second module
	// and the store the first one opened would be left behind it.
	await page.evaluate(() => {
		const done = {};
		window.__mod = async (name) => {
			const mod = await import(`../${name}/oxedyne_daimond.js`);
			if (name !== 'pkg' && !done[name]) { await mod.default(); done[name] = true; }
			return mod;
		};
	});

	// Two Diamonds, made through the app's own edge so they are real store entries.
	const ids = await page.evaluate(async ([mock, engine]) => {
		const mod = await window.__mod(engine);
		const app = new mod.DaimondApp(mock, 'k', 'mock', 256, '', true);
		const a = await app.create_diamond('Alpha');
		const c = await app.create_diamond('Beta');
		return { a, c };
	}, [MOCK, ENGINE]);
	check('two Diamonds exist', !!ids.a && !!ids.c, JSON.stringify(ids));

	// A folder each, ATTACHED — the only kind of place a Diamond has on this
	// machine. The user makes these with a directory picker and the app never
	// creates them; `<grant>/diamonds/<id>` is deliberately NOT created, because
	// nothing in the field creates it either (see the note at the head of this
	// file). The granted folder is also the workspace the file tools resolve
	// against, so a workspace-relative bound and an absolute fence path name the
	// same place.
	const dirA  = path.join(GRANT, 'work-a');
	const dirB  = path.join(GRANT, 'work-b');
	const store = path.join(GRANT, 'diamonds');
	fs.mkdirSync(dirA);
	fs.mkdirSync(dirB);
	fs.writeFileSync(path.join(dirA, 'own.txt'), MINE + '\n');
	fs.writeFileSync(path.join(dirB, 'secret.txt'), THEIRS + '\n');
	// A THIRD folder, on the disk and marked into nothing. `walk_reach` sends a start under no
	// mark to browser storage, which has never heard of this name, so it is the exact case
	// `dev/BLOCKERS.md` B1 measures: a walk over a folder on this computer, answered by the
	// other filesystem. Nothing in browser storage is ever made to match it.
	const dirC = path.join(GRANT, 'work-c');
	fs.mkdirSync(dirC);
	fs.writeFileSync(path.join(dirC, 'unmarked.txt'), nonce('unmarked') + '\n');

	// ── The fence the engine actually composes ──────────────────────
	//
	// Captured from `fence_spec` through the same edge `Tool::run` uses, rather
	// than written out here: what matters is what the ENGINE sends.
	//
	// `pty_request` asks the relay where the hand's grant is, and the relay now refuses to
	// answer for a page whose workspace is not that folder (`hand/REVIEW.md` §1.14). This
	// browser's workspace is the OPFS sandbox — no automated one can be anything else, because
	// a real folder needs a native dialog — so `status` is stood in for here with what the real
	// hand actually reported a moment ago. The COMPOSER is the real one, and the fence it
	// returns is what is then sent down the real relay to the real hand.
	await page.evaluate((root) => {
		const real = window.DaimondHand.status;
		window.DaimondHand._realStatus = real;
		window.DaimondHand.status = () => Promise.resolve(JSON.stringify({
			paired: true, transport: 'machine', machine: 'test', os: 'linux',
			root: root, caps: ['fence:linux', 'landlock:abi-8'],
		}));
	}, GRANT);

	const fenced = await page.evaluate(async ({ id, root, mock, engine }) => {
		const mod = await window.__mod(engine);
		const app = new mod.DaimondApp(mock, 'k', 'mock', 256, '', true);
		const before = JSON.parse(app.diamond_scope());
		app.set_diamond_scope('diamonds/' + id, '["work-a"]', '[]', '[]');
		const after = JSON.parse(app.diamond_scope());
		// The pty composer is the one edge that hands a fence back as text, and it
		// is the SAME `fence_spec` a command goes through.
		//
		// `cwd` is the Diamond's own directory because that is what the Terminal
		// panel sends — `cwd: b.own_dir` in `Files.bounds`'s caller — and a fence
		// question answered against a tidier request than the app makes is a
		// question about a different app.
		const req = JSON.parse(await mod.pty_request(JSON.stringify({
			own_dir: 'diamonds/' + id, attached: ['work-a'], read_only: [], toolkits: [],
			cwd: 'diamonds/' + id, cols: 80, rows: 24,
		})));
		// And the same Diamond with nothing attached to it, which is what a fresh
		// one is: no folder on this machine, so nothing to fence and nothing to
		// open. The sentence matters as much as the refusal — see the check.
		const bare = JSON.parse(await mod.pty_request(JSON.stringify({
			own_dir: 'diamonds/' + id, attached: [], read_only: [], toolkits: [],
			cwd: 'diamonds/' + id, cols: 80, rows: 24,
		})));
		return { before, after, req, bare, root };
	}, { id: ids.a, root: GRANT, mock: MOCK, engine: ENGINE });

	check('an unscoped agent declares no allow-list at all',
		Array.isArray(fenced.before.allow) && fenced.before.allow.length === 0
			&& (fenced.before.write_allow || []).length === 0
			&& fenced.before.nowhere === false,
		JSON.stringify(fenced.before));
	// Read back off `write_allow`, which is where a scope lands. `allow` is the
	// both-verb list and is empty for every scope this build composes; a check
	// written against it would pass only in a world where a daimon could not read
	// its user's files, and `scopeAgentTo` in daimond.js reads the same field.
	check('a scoped agent reads back the Diamond it was confined to',
		(fenced.after.write_allow || []).indexOf('diamonds/' + ids.a) >= 0
			&& (fenced.after.write_allow || []).indexOf('work-a') >= 0
			&& (fenced.after.allow || []).length === 0,
		JSON.stringify(fenced.after));
	const fence = fenced.req.fence || {};
	const rw = fence.rw || [];
	check('and the fence the engine composed names the folder attached to it, not the whole grant',
		rw.indexOf(dirA) >= 0 && rw.indexOf(GRANT) < 0,
		JSON.stringify(fenced.req).slice(0, 300));
	// THE REGRESSION. A Diamond's own directory is in the browser's storage, so
	// `<grant>/diamonds/<id>` is a directory nobody makes; a fence naming it is a
	// fence the hand cannot resolve, and it refuses the whole spec — the real
	// folder beside it included. Asserted over every list at once, because the
	// path was equally fatal in `rw`, in `ro` and in a read carve-out.
	check('and no part of it names a place inside Daimond\'s own storage, which is not on the disk',
		JSON.stringify(fence).indexOf(store) < 0, JSON.stringify(fence).slice(0, 300));
	check('and it does not name the other Diamond, or the folder attached to it, in any list',
		!JSON.stringify(fence).includes(ids.c) && !JSON.stringify(fence).includes(dirB),
		JSON.stringify(fence));
	// The panel asks for a terminal in the Diamond's own directory, because that
	// is what a Diamond is to it. The session has to start somewhere real, and
	// `tools::start_dir` says where: the first folder the user attached.
	check('and the session starts in that folder, though the panel asked for the Diamond itself',
		fenced.req.cwd === dirA, JSON.stringify(fenced.req.cwd));
	// A wall a person can get through. The refusal is shown to the USER, in the
	// Terminal panel, verbatim: it has to name the thing they can do about it.
	check('a Diamond with nothing attached is refused a terminal, and told to attach a folder',
		!!fenced.bare.refused && fenced.bare.t === undefined
			&& /attach/i.test(fenced.bare.refused) && /Workspace panel/.test(fenced.bare.refused),
		JSON.stringify(fenced.bare).slice(0, 300));

	// ── The command, and the kernel ─────────────────────────────────
	//
	// The fence just captured, sent down the real relay to the real hand. Not a
	// fence this file composed: the object came out of `fence_spec`.
	const grant = allowHand();
	// `cwd` defaults to the fence's first writable root and can be named, so that
	// a fence under test is the only thing under test: a working directory that
	// does not exist is refused for its own reasons, and would stand in for the
	// refusal being asked about.
	const send = async (argv, fence, cwd) => {
		const raw = await page.evaluate(({ argv, fence, cwd }) =>
			window.DaimondHand.run(JSON.stringify({
				t: 'exec', id: 'sc-' + Math.random().toString(36).slice(2, 8),
				argv, cwd: cwd || fence.rw[0], env: [], stdin: null,
				timeout_ms: 30000, capture: 'both', fence, toolkits: [],
			})).then((v) => ({ ok: v }), (e) => ({ err: (e && e.message) || String(e) })),
			{ argv, fence, cwd: cwd || null });
		if (raw.err) return { refused: raw.err };
		try { return { out: JSON.parse(raw.ok) }; } catch (e) { return { refused: raw.ok }; }
	};

	const own = await send(['/bin/cat', path.join(dirA, 'own.txt')], fenced.req.fence);
	await grant;
	check('a command in Diamond A reads the folder attached to Diamond A',
		!!own.out && String(own.out.stdout || '').includes(MINE),
		JSON.stringify(own).slice(0, 300));

	const theirs = await send(['/bin/cat', path.join(dirB, 'secret.txt')], fenced.req.fence);
	check('and the same command cannot read the folder attached to Diamond B',
		!own.refused && !(theirs.out && String(theirs.out.stdout || '').includes(THEIRS)),
		JSON.stringify(theirs).slice(0, 300));
	check('and it is the KERNEL that refuses it, not a string check',
		!!theirs.out && /Permission denied/i.test(String(theirs.out.stderr || '')),
		JSON.stringify(theirs).slice(0, 300));
	check('and Diamond B\'s secret never came back at all',
		!JSON.stringify(theirs).includes(THEIRS), JSON.stringify(theirs).slice(0, 200));

	const wrote = await send(
		['/bin/sh', '-c', `echo x > ${path.join(dirB, 'planted.txt')}`], fenced.req.fence);
	check('nor write into Diamond B\'s folder', !fs.existsSync(path.join(dirB, 'planted.txt')),
		JSON.stringify(wrote).slice(0, 200));

	// ── The other door, on the same scope ───────────────────────────
	//
	// The kernel has just refused a COMMAND the other Diamond. The file tools are
	// the other half of the same bound list, and they answer differently on
	// purpose: reading is free, writing is not. Asserted here rather than left to
	// the unit tests, because "the scope took" is a claim about the engine the page
	// actually loaded, and because a refusal with no permission beside it would
	// pass just as well on a scope that had failed shut.
	//
	// In the browser's own storage, which is where a file tool works: this browser
	// has no real folder open (no automated one can — a real folder needs a native
	// dialog), so the paths below are OPFS paths and never the disk fixtures above.
	const doors = await page.evaluate(async ({ id, mock, engine }) => {
		const mod = await window.__mod(engine);
		const free = new mod.DaimondApp(mock, 'k', 'mock', 256, '', true);
		// The folders first: a hand is paired and no folder is open, so a write that would
		// INVENT one in browser storage is refused rather than landed in the filesystem
		// nobody meant (`write_place`, src/tools.rs, 2026-08-24).
		await free.run_tool('dir_create', JSON.stringify({ path: 'work-b' }));
		await free.run_tool('dir_create', JSON.stringify({ path: '.daimond' }));
		await free.run_tool('file_write', JSON.stringify({
			path: 'work-b/secret.txt', content: 'THE OTHER DIAMONDS FILE\n' }));
		await free.run_tool('file_write', JSON.stringify({
			path: '.daimond/config.json', content: '{"seeded":true}\n' }));
		const app = new mod.DaimondApp(mock, 'k', 'mock', 256, '', true);
		app.set_diamond_scope('diamonds/' + id, '["work-a"]', '[]', '[]');
		const t = (n, a) => app.run_tool(n, JSON.stringify(a)).then(String);
		return {
			read:  await t('file_read',  { path: 'work-b/secret.txt' }),
			write: await t('file_write', { path: 'work-b/secret.txt', content: 'clobbered\n' }),
			own:   await t('file_read',  { path: '.daimond/config.json' }),
			after: await free.run_tool('file_read',
				JSON.stringify({ path: 'work-b/secret.txt' })).then(String),
		};
	}, { id: ids.a, mock: MOCK, engine: ENGINE });
	check('the same scope reads a file nobody attached, through the file tools',
		/THE OTHER DIAMONDS FILE/.test(doors.read), doors.read.slice(0, 120));
	check('and cannot write it — which is the half that must never widen',
		/Refused/.test(doors.write), doors.write.slice(0, 120));
	check('and that refusal is real: the file is untouched',
		/THE OTHER DIAMONDS FILE/.test(doors.after) && !/clobbered/.test(doors.after),
		doors.after.slice(0, 120));
	check('while Daimond\'s own directory is refused BOTH ways, seeded so it is a denial and not an absence',
		/Refused/.test(doors.own), doors.own.slice(0, 120));

	// ── The FILE tools reaching this machine, and stopping where a command stops ──
	//
	// Since 2026-08-25 a file tool whose path is under a folder the user marked in
	// changes the real file on this computer, through the hand, behind the fence
	// `fence_spec` builds (`dev/BLOCKERS.md` B2). That is a second road to the disk
	// and it has to be fenced like the first, so it is proved here, through the
	// kernel, in the same world and against the same two nonces.
	//
	// The decoy is what makes the second check worth something. `work-b/secret.txt`
	// exists TWICE — on disk holding Diamond B's nonce, and in browser storage
	// holding "THE OTHER DIAMONDS FILE", written by the free app a moment ago. A
	// door that leaked would answer with the nonce, which nothing could have faked;
	// answering with the decoy is the door correctly reading the other filesystem.
	const filedoor = await page.evaluate(async ({ id, mock, engine, mine }) => {
		const mod = await window.__mod(engine);
		const app = new mod.DaimondApp(mock, 'k', 'mock', 256, '', true);
		app.set_diamond_scope('diamonds/' + id, '["work-a"]', '[]', '[]');
		const t = (n, a) => app.run_tool(n, JSON.stringify(a)).then(String);
		return {
			read:   await t('file_read', { path: 'work-a/own.txt' }),
			edit:   await t('file_edit', {
				path: 'work-a/own.txt', old_string: mine, new_string: mine + '-EDITED' }),
			// A second file, so the ambiguous edit below cannot disturb the one just checked.
			seed:   await t('file_write', { path: 'work-a/twice.txt', content: 'x\nx\n' }),
			twice:  await t('file_edit', {
				path: 'work-a/twice.txt', old_string: 'x', new_string: 'y' }),
			theirs: await t('file_read', { path: 'work-b/secret.txt' }),
			plant:  await t('file_write', {
				path: 'work-b/planted.txt', content: 'planted by a file tool\n' }),
		};
	}, { id: ids.a, mock: MOCK, engine: ENGINE, mine: MINE });
	check('a file tool in Diamond A reads the folder attached to Diamond A, off the disk',
		filedoor.read.includes(MINE), filedoor.read.slice(0, 160));
	check('and EDITS the real file on this computer, with no command anywhere',
		fs.readFileSync(path.join(dirA, 'own.txt'), 'utf8').includes(MINE + '-EDITED'),
		filedoor.edit.slice(0, 200));
	check('and a file_write of a new file lands on the disk too',
		fs.existsSync(path.join(dirA, 'twice.txt')), filedoor.seed.slice(0, 200));
	check('and an old_string that is not unique is refused WITH ITS COUNT, changing nothing',
		/appears 2 times/.test(filedoor.twice)
			&& fs.readFileSync(path.join(dirA, 'twice.txt'), 'utf8') === 'x\nx\n',
		filedoor.twice.slice(0, 200));
	check('and the same file tool cannot see the folder attached to Diamond B',
		!filedoor.theirs.includes(THEIRS), filedoor.theirs.slice(0, 200));
	check('nor write into it: the disk is untouched and nothing was planted',
		!fs.existsSync(path.join(dirB, 'planted.txt')), filedoor.plant.slice(0, 200));
	// ── A relay that cannot carry a file operation SAYS SO, and does not hang ──
	//
	// Found by `dev/verify_chatfence.mjs` hanging for eight minutes on 2026-08-25. A
	// `#[wasm_bindgen(method)]` import that is not on the object throws when it is
	// called, and a throw out of a declared-infallible import does not become an
	// `Err`: the promise is never made and the tool call waits for ever. Every relay
	// older than the file door is that case, and so is every test stub written before
	// the verb existed.
	//
	// The race is the check. A hang cannot be asserted by waiting for it, so the call
	// is given eight seconds and losing the race IS the failure.
	const stale = await page.evaluate(async ({ id, mock, engine }) => {
		const keep = window.DaimondHand.file;
		delete window.DaimondHand.file;
		try {
			const mod = await window.__mod(engine);
			const app = new mod.DaimondApp(mock, 'k', 'mock', 256, '', true);
			app.set_diamond_scope('diamonds/' + id, '["work-a"]', '[]', '[]');
			return await Promise.race([
				app.run_tool('file_edit', JSON.stringify({
					path: 'work-a/own.txt', old_string: 'x', new_string: 'y' })).then(String),
				new Promise((r) => setTimeout(() => r('__HUNG__'), 8000)),
			]);
		} finally {
			window.DaimondHand.file = keep;
		}
	}, { id: ids.a, mock: MOCK, engine: ENGINE });
	check('a relay too old to carry a file operation answers a sentence rather than hanging',
		stale !== '__HUNG__' && /older than this version/.test(stale), stale.slice(0, 200));
	check('and it does NOT quietly write into browser storage instead',
		!/Wrote|Edited/.test(stale), stale.slice(0, 160));

	// ── The SEARCH door, which walks rather than opens one path ────────────
	//
	// A search is the one file operation whose reach is decided by a walk, so a
	// fence that holds for `file_read` says nothing about it: the walk chooses its
	// own paths as it goes. Diamond B's folder holds a nonce and Diamond A's holds
	// another, and the same pattern is asked for in one call from a scope that has
	// only A. Finding B's would be proof of a leak that nothing could have faked.
	const searched = await page.evaluate(async ({ id, mock, engine }) => {
		const mod = await window.__mod(engine);
		const app = new mod.DaimondApp(mock, 'k', 'mock', 256, '', true);
		app.set_diamond_scope('diamonds/' + id, '["work-a"]', '[]', '[]');
		const t = (n, a) => app.run_tool(n, JSON.stringify(a)).then(String);
		// One file in the Diamond's OWN directory, which is browser storage by construction and
		// is what a split walk has to report beside the disk.
		await t('file_write', {
			path: 'diamonds/' + id + '/own-note.txt', content: 'the Diamond\'s own side\n' });
		return {
			// No `path`: the walk starts at the turn's own marks, which is the
			// default a daimon actually gets and the one that decides its reach.
			mine:  await t('file_search', { query: 'mine-' }),
			// And aimed straight at the other Diamond, which is the real claim.
			far:   await t('file_search', { query: 'theirs-', path: 'work-b' }),
			glob:  await t('file_glob',   { pattern: '**/*.txt' }),
		};
	}, { id: ids.a, mock: MOCK, engine: ENGINE });
	check('a file_search from Diamond A finds the nonce in the folder attached to it',
		searched.mine.includes(MINE), searched.mine.slice(0, 220));
	check('and it reports a real path on the disk, not one in browser storage',
		/own\.txt/.test(searched.mine), searched.mine.slice(0, 220));
	check('and the same search never returns Diamond B\'s nonce',
		!searched.mine.includes(THEIRS), searched.mine.slice(0, 300));
	check('and a search AIMED at Diamond B comes back without it',
		!searched.far.includes(THEIRS), searched.far.slice(0, 300));
	check('and file_glob lists Diamond A\'s file and not Diamond B\'s',
		/own\.txt/.test(searched.glob) && !/secret\.txt/.test(searched.glob),
		searched.glob.slice(0, 300));
	// A DEFAULT WALK SPANS BOTH FILESYSTEMS AND MUST REPORT BOTH. A scoped Diamond's marks
	// always include its own directory, which is browser storage by construction, so every
	// default `file_glob` in a Diamond with a folder attached is a split walk. `file_glob`'s
	// machine arm composed its report and RETURNED, dropping the browser half on the floor;
	// `file_search`'s falls through and merges. This is the check that tells the two apart.
	check('and a default file_glob reports the Diamond\'s own storage as well as the disk',
		/own\.txt/.test(searched.glob) && /own-note\.txt/.test(searched.glob),
		searched.glob.slice(0, 400));

	// ── AND WHEN A WALK FINDS NOTHING, WHICH WORLD IS THAT ABOUT? ──────────
	//
	// `dev/BLOCKERS.md` B1's open half. Both walking tools matched their directory read with a
	// bare `continue`, so a start browser storage does not hold was walked as an empty tree and
	// the answer came back `No matches for '<query>'.` -- true of browser storage, read as a
	// statement about this computer, and said by the two tools a daimon reaches for FIRST.
	//
	// `work-c` is on the disk and under no mark, so the walk stays in browser storage, which has
	// no such folder. The answer may still be empty; what it may not be is silent about where it
	// looked.
	const nowhere = await page.evaluate(async ({ id, mock, engine }) => {
		const mod = await window.__mod(engine);
		const app = new mod.DaimondApp(mock, 'k', 'mock', 256, '', true);
		app.set_diamond_scope('diamonds/' + id, '["work-a"]', '[]', '[]');
		const t = (n, a) => app.run_tool(n, JSON.stringify(a)).then(String);
		return {
			search: await t('file_search', { query: 'unmarked-', path: 'work-c' }),
			glob:   await t('file_glob',   { pattern: '*.txt', path: 'work-c' }),
		};
	}, { id: ids.a, mock: MOCK, engine: ENGINE });
	check('a file_search over a folder browser storage does not hold says which filesystem answered',
		/this browser's own storage/.test(nowhere.search), nowhere.search.slice(0, 400));
	check('and it says the directory would not open rather than walking past it in silence',
		/would not open/.test(nowhere.search), nowhere.search.slice(0, 400));
	check('and it names the other filesystem and the tool that reaches it',
		/on this computer/.test(nowhere.search) && /Reach it with run/.test(nowhere.search),
		nowhere.search.slice(0, 400));
	check('and file_glob answers the same way, being the other tool a daimon reaches for first',
		/this browser's own storage/.test(nowhere.glob) && /would not open/.test(nowhere.glob),
		nowhere.glob.slice(0, 400));
	// THE CONTROL, without which every check above would pass on a note printed unconditionally.
	// The same tools, over the folder that IS marked in, answer off the disk and say none of it.
	check('while a search that really did reach this computer says none of that',
		searched.mine.includes(MINE) && !/this browser's own storage/.test(searched.mine)
			&& !/would not open/.test(searched.mine),
		searched.mine.slice(0, 400));
	check('nor does a glob that found something',
		!/this browser's own storage/.test(searched.glob), searched.glob.slice(0, 400));

	// ── And the KERNEL, not the app, is what makes that last one true ──────
	//
	// Every refusal above came from the engine deciding the path was not a machine
	// path at all, which is the right first answer and is not the guarantee. The
	// guarantee is one process further on: the fence `fence_spec` composed, sent
	// down the real relay as a real `file` request naming Diamond B's file, with
	// the engine's own decision taken out of the way. It reaches the same launcher
	// a command reaches, applies the same Landlock ruleset, and the refusal comes
	// back in the kernel's words.
	const fsend = async (op, target, extra) => {
		const raw = await page.evaluate(({ op, target, fence, extra }) =>
			window.DaimondHand.file(JSON.stringify(Object.assign({
				t: 'file', id: 'sf-' + Math.random().toString(36).slice(2, 8),
				op, path: target, cwd: fence.rw[0], fence, toolkits: [],
			}, extra || {}))).then((v) => ({ ok: v }), (e) => ({ err: (e && e.message) || String(e) })),
			{ op, target, fence: fenced.req.fence, extra: extra || null });
		if (raw.err) return { refused: raw.err };
		try { return { out: JSON.parse(raw.ok) }; } catch (e) { return { refused: raw.ok }; }
	};
	const kread  = await fsend('read', path.join(dirB, 'secret.txt'), { offset: 1, limit: 0 });
	const kwrite = await fsend('write', path.join(dirB, 'planted.txt'), { text: 'planted\n' });
	const kmine  = await fsend('read', path.join(dirA, 'own.txt'), { offset: 1, limit: 0 });
	check('the same file request, sent past the engine, is refused by the kernel for Diamond B',
		!!kread.out && kread.out.ok === false && /fence/i.test(String(kread.out.text || '')),
		JSON.stringify(kread).slice(0, 300));
	check('and Diamond B\'s secret never came back at all, by that road either',
		!JSON.stringify(kread).includes(THEIRS), JSON.stringify(kread).slice(0, 200));
	check('nor could it write there, and nothing was planted',
		!fs.existsSync(path.join(dirB, 'planted.txt')), JSON.stringify(kwrite).slice(0, 200));
	// The permission beside the refusal, without which every refusal above would be
	// satisfied by a door that had failed shut.
	check('while the same road reads Diamond A\'s own file freely',
		!!kmine.out && kmine.out.ok === true && String(kmine.out.text || '').includes(MINE),
		JSON.stringify(kmine).slice(0, 200));

	// The kernel, again, and by the same road as the read: past the engine's own
	// decision, with the fence `fence_spec` composed, walking straight at Diamond B.
	const kwalk = await fsend('search', path.join(dirB, 'x'), {
		paths: [dirB], query: 'theirs-', ci: false, glob: '', skip: [],
		budget: 5000, cap: 1000000,
	});
	check('the same walk, sent past the engine, brings nothing back from Diamond B',
		!JSON.stringify(kwalk).includes(THEIRS), JSON.stringify(kwalk).slice(0, 260));
	check('and it RECORDS that a directory could not be opened, so an empty answer is not read as an empty folder',
		!!kwalk.out && String(kwalk.out.text || '').split('\n')[0].split('\t')[9] === '1',
		JSON.stringify(kwalk).slice(0, 260));
	const kmine2 = await fsend('search', path.join(dirA, 'x'), {
		paths: [dirA], query: 'mine-', ci: false, glob: '', skip: [],
		budget: 5000, cap: 1000000,
	});
	check('while the same road searches Diamond A\'s own folder freely',
		!!kmine2.out && kmine2.out.ok === true && String(kmine2.out.text || '').includes(MINE),
		JSON.stringify(kmine2).slice(0, 220));


	// Put back, so the checks below read the fixture they were written against.
	fs.writeFileSync(path.join(dirA, 'own.txt'), MINE + '\n');

	// The control, without which every refusal above proves nothing: the same
	// file, with the fence the code used to compose — the whole granted root.
	const unscoped = await send(['/bin/cat', path.join(dirB, 'secret.txt')],
		{ rw: [GRANT], ro: [], deny: [], net: false });
	check('while the UNSCOPED fence — the one every agent had until today — reads it freely',
		!!unscoped.out && String(unscoped.out.stdout || '').includes(THEIRS),
		JSON.stringify(unscoped).slice(0, 200));

	// ── The other control: the fence as it was composed until tonight ──
	//
	// Not a fence the engine can produce any more, so it is written out here and
	// sent to the REAL hand, which is the end that decides. It is the good fence
	// above with one path added: the Diamond's own directory, mapped under the
	// granted root as `fence_spec` used to map it. Nothing creates that
	// directory, the hand cannot canonicalise it, and it refuses the SPEC —
	// which is why a Diamond with a perfectly good folder attached could not run
	// a command either. The user's real folder is in this fence and reachable in
	// principle; the hand still says no, and that is the whole shape of the
	// outage.
	const preFix = {
		rw: [path.join(store, ids.a)].concat(fenced.req.fence.rw),
		ro: fenced.req.fence.ro, deny: fenced.req.fence.deny, net: false,
	};
	const old = await send(['/bin/cat', path.join(dirA, 'own.txt')], preFix, dirA);
	// The relay resolves with the hand's own sentence rather than rejecting, so
	// the refusal arrives INSIDE the answer. Read both shapes: a check that knew
	// only about a rejection would call a refusal that came back as data a pass.
	const oldWhy = String((old.out && old.out.refused) || old.refused || '');
	check('and the fence composed BEFORE tonight is refused outright by the hand, real folder and all',
		/cannot be resolved/i.test(oldWhy) && oldWhy.includes(path.join(store, ids.a))
			&& !(old.out && String(old.out.stdout || '').includes(MINE)),
		JSON.stringify(old).slice(0, 300));

	// ── The toolkit grant, which only exists through this same call ──
	const kits = await page.evaluate(async ({ id, mock, engine }) => {
		const mod = await window.__mod(engine);
		const app = new mod.DaimondApp(mock, 'k', 'mock', 256, '', true);
		await app.set_toolkits(id, JSON.stringify(['rust', 'nonsense']));
		const list = JSON.parse(await app.list_diamonds());
		const row = list.find((d) => d.id === id) || {};
		app.set_diamond_scope('diamonds/' + id, '["work-a"]', '[]', JSON.stringify(row.toolkits || []));
		return { stored: row.toolkits || [], scope: JSON.parse(app.diamond_scope()) };
	}, { id: ids.a, mock: MOCK, engine: ENGINE });
	check('a toolkit grant is stored, and an unknown name is dropped rather than kept',
		JSON.stringify(kits.stored) === '["rust"]', JSON.stringify(kits.stored));
	check('and it reaches the turn\'s bounds, which is the only way a fence ever sees one',
		JSON.stringify(kits.scope.toolkits) === '["rust"]', JSON.stringify(kits.scope));

	// 502 is a dev server with no gateway behind it; 401 is a gateway that IS
	// there and has nobody signed in, which is this file exactly — it holds no
	// account and asks the gateway for nothing. The two are the same absence
	// seen from either side, and which one the page meets depends on whether
	// somebody else on this machine happens to have a gateway up.
	//
	// 402 and 403 are the same absence at other endpoints, and they are named rather than
	// left to make this file red on a machine where a lane happens to have a gateway up.
	// Traced on 2026-08-25 rather than assumed: one conversation answers 401 for
	// `/api/tools` and `/api/admin?view=whoami`, **402 for `/api/sync`** and **403 for
	// `/api/account`**, each a poll that lands only in a run long enough to reach it.
	// Nothing in this file signs in, so all four are the page correctly being told it is
	// nobody -- and the detail line prints the URLs beside the statuses, which is what
	// made tracing them possible rather than guessing.
	const noise = s.errs.filter((e) =>
		!/favicon|ERR_ABORTED|502|Bad Gateway|401 \(Unauthorized\)|402 \(Payment Required\)|403 \(Forbidden\)/i.test(e));
	check('the page threw nothing along the way', noise.length === 0,
		JSON.stringify((s.net || []).filter((n) => n.status >= 400)).slice(0, 300));
} finally {
	await b.close().catch(() => {});
	for (const p of started) { try { p.kill(); } catch (e) { /* already gone */ } }
	if (!KEEP) fs.rmSync(BASE, { recursive: true, force: true });
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
