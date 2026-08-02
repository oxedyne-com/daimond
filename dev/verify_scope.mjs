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
// ── Running it ──────────────────────────────────────────────────────
//
//	xvfb-run -a -s "-screen 0 1400x900x24" node dev/verify_scope.mjs
//
//	  --keep   leave the scratch tree behind
//
// Headed, because Chromium loads an unpacked extension in no other mode.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { open as openApp, scratch } from './harness.mjs';

const HERE	= path.dirname(fileURLToPath(import.meta.url));
const ROOT	= path.join(HERE, '..');
const SRC	= path.join(ROOT, 'ext');
const INSTALL	= path.join(ROOT, 'hand/install/install.sh');
const HAND	= path.join(ROOT, 'hand/target/release/daimond-hand');

const KEEP	= process.argv.slice(2).includes('--keep');

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
const built = spawnSync('cargo', ['build', '--release', '--manifest-path', 'hand/Cargo.toml'],
	{ cwd: ROOT, encoding: 'utf8', env: buildEnv });
check('the hand builds from source', built.status === 0 && fs.existsSync(HAND),
	(built.stderr || '').split('\n').filter((l) => /^error/.test(l)).slice(0, 3).join(' | '));
if (built.status !== 0) { console.log('\n0 ok, 1 failed'); process.exit(1); }

// The wasm the browser loads is the half under test here; a stale bundle would
// be measuring yesterday's engine.
const wasmFile = path.join(ROOT, 'www/pkg/oxedyne_daimond_bg.wasm');
const wasmAt = fs.existsSync(wasmFile) ? fs.statSync(wasmFile).mtimeMs : 0;
const srcAt = ['src/tools.rs', 'src/wasm/app.rs']
	.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f))
	.reduce((a, f) => Math.max(a, fs.statSync(f).mtimeMs), 0);
check('the wasm bundle is newer than the engine source it was built from', wasmAt >= srcAt,
	'run dev/build-wasm.sh');

fs.writeFileSync(path.join(JOURNAL, 'root.txt'),
	`# The one folder Daimond's machine hand may work in.\n${GRANT}\n`);
const inst = spawnSync('bash', [INSTALL, '--dir', HOSTS, HAND], { cwd: ROOT, encoding: 'utf8' });
check('install.sh registers the real binary in the test profile', inst.status === 0,
	(inst.stderr || inst.stdout || '').trim().split('\n').slice(-1)[0]);

process.env.DAIMOND_HAND_JOURNAL_DIR = JOURNAL;
delete process.env.DAIMOND_HAND_ROOT;

await serve('dev server', ['dev/serve.mjs'], 8777);
await serve('mock provider', ['dev/mockllm.mjs'], 9099);

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

	// Two Diamonds, made through the app's own edge so they are real store entries.
	const ids = await page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1:9099/v1/chat/completions', 'k', 'mock', 256, '', true);
		const a = await app.create_diamond('Alpha');
		const c = await app.create_diamond('Beta');
		return { a, c };
	});
	check('two Diamonds exist', !!ids.a && !!ids.c, JSON.stringify(ids));

	// Their workspace directories, on the granted folder — which is the workspace
	// the file tools resolve against and the folder the hand was given, so a
	// workspace-relative bound and an absolute fence path name the same place.
	const dirA = path.join(GRANT, 'diamonds', ids.a);
	const dirB = path.join(GRANT, 'diamonds', ids.c);
	fs.mkdirSync(dirA, { recursive: true });
	fs.mkdirSync(dirB, { recursive: true });
	fs.writeFileSync(path.join(dirA, 'own.txt'), MINE + '\n');
	fs.writeFileSync(path.join(dirB, 'secret.txt'), THEIRS + '\n');

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

	const fenced = await page.evaluate(async ({ id, root }) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1:9099/v1/chat/completions', 'k', 'mock', 256, '', true);
		const before = JSON.parse(app.diamond_scope());
		app.set_diamond_scope('diamonds/' + id, '[]', '[]', '[]');
		const after = JSON.parse(app.diamond_scope());
		// The pty composer is the one edge that hands a fence back as text, and it
		// is the SAME `fence_spec` a command goes through.
		const req = JSON.parse(await mod.pty_request(JSON.stringify({
			own_dir: 'diamonds/' + id, attached: [], read_only: [], toolkits: [],
			cwd: 'diamonds/' + id, cols: 80, rows: 24,
		})));
		return { before, after, req, root };
	}, { id: ids.a, root: GRANT });

	check('an unscoped agent declares no allow-list at all',
		Array.isArray(fenced.before.allow) && fenced.before.allow.length === 0
			&& fenced.before.nowhere === false,
		JSON.stringify(fenced.before));
	check('a scoped agent reads back the Diamond it was confined to',
		(fenced.after.allow || []).indexOf('diamonds/' + ids.a) >= 0,
		JSON.stringify(fenced.after));
	const rw = (fenced.req.fence && fenced.req.fence.rw) || [];
	check('and the fence the engine composed names that Diamond and not the whole grant',
		rw.indexOf(dirA) >= 0 && rw.indexOf(GRANT) < 0, JSON.stringify(rw));
	check('and it does not name the other Diamond in any list',
		!JSON.stringify(fenced.req.fence || {}).includes(ids.c),
		JSON.stringify(fenced.req.fence));

	// ── The command, and the kernel ─────────────────────────────────
	//
	// The fence just captured, sent down the real relay to the real hand. Not a
	// fence this file composed: the object came out of `fence_spec`.
	const grant = allowHand();
	const send = async (argv, fence) => {
		const raw = await page.evaluate(({ argv, fence }) =>
			window.DaimondHand.run(JSON.stringify({
				t: 'exec', id: 'sc-' + Math.random().toString(36).slice(2, 8),
				argv, cwd: fence.rw[0], env: [], stdin: null,
				timeout_ms: 30000, capture: 'both', fence, toolkits: [],
			})).then((v) => ({ ok: v }), (e) => ({ err: (e && e.message) || String(e) })),
			{ argv, fence });
		if (raw.err) return { refused: raw.err };
		try { return { out: JSON.parse(raw.ok) }; } catch (e) { return { refused: raw.ok }; }
	};

	const own = await send(['/bin/cat', path.join(dirA, 'own.txt')], fenced.req.fence);
	await grant;
	check('a command in Diamond A reads Diamond A\'s own file',
		!!own.out && String(own.out.stdout || '').includes(MINE),
		JSON.stringify(own).slice(0, 300));

	const theirs = await send(['/bin/cat', path.join(dirB, 'secret.txt')], fenced.req.fence);
	check('and the same command cannot read Diamond B\'s file',
		!own.refused && !(theirs.out && String(theirs.out.stdout || '').includes(THEIRS)),
		JSON.stringify(theirs).slice(0, 300));
	check('and it is the KERNEL that refuses it, not a string check',
		!!theirs.out && /Permission denied/i.test(String(theirs.out.stderr || '')),
		JSON.stringify(theirs).slice(0, 300));
	check('and Diamond B\'s secret never came back at all',
		!JSON.stringify(theirs).includes(THEIRS), JSON.stringify(theirs).slice(0, 200));

	const wrote = await send(
		['/bin/sh', '-c', `echo x > ${path.join(dirB, 'planted.txt')}`], fenced.req.fence);
	check('nor write into Diamond B', !fs.existsSync(path.join(dirB, 'planted.txt')),
		JSON.stringify(wrote).slice(0, 200));

	// The control, without which every refusal above proves nothing: the same
	// file, with the fence the code used to compose — the whole granted root.
	const unscoped = await send(['/bin/cat', path.join(dirB, 'secret.txt')],
		{ rw: [GRANT], ro: [], deny: [], net: false });
	check('while the UNSCOPED fence — the one every agent had until today — reads it freely',
		!!unscoped.out && String(unscoped.out.stdout || '').includes(THEIRS),
		JSON.stringify(unscoped).slice(0, 200));

	// ── The toolkit grant, which only exists through this same call ──
	const kits = await page.evaluate(async (id) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1:9099/v1/chat/completions', 'k', 'mock', 256, '', true);
		await app.set_toolkits(id, JSON.stringify(['rust', 'nonsense']));
		const list = JSON.parse(await app.list_diamonds());
		const row = list.find((d) => d.id === id) || {};
		app.set_diamond_scope('diamonds/' + id, '[]', '[]', JSON.stringify(row.toolkits || []));
		return { stored: row.toolkits || [], scope: JSON.parse(app.diamond_scope()) };
	}, ids.a);
	check('a toolkit grant is stored, and an unknown name is dropped rather than kept',
		JSON.stringify(kits.stored) === '["rust"]', JSON.stringify(kits.stored));
	check('and it reaches the turn\'s bounds, which is the only way a fence ever sees one',
		JSON.stringify(kits.scope.toolkits) === '["rust"]', JSON.stringify(kits.scope));

	const noise = s.errs.filter((e) => !/favicon|ERR_ABORTED|502|Bad Gateway/i.test(e));
	check('the page threw nothing along the way', noise.length === 0, noise.slice(0, 3).join(' | '));
} finally {
	await b.close().catch(() => {});
	for (const p of started) { try { p.kill(); } catch (e) { /* already gone */ } }
	if (!KEEP) fs.rmSync(BASE, { recursive: true, force: true });
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
