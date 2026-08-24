// verify_handstop.mjs — a daimon can stop what it started, through the real chain.
//
// WHY THIS FILE EXISTS. On 2026-08-23 a daimon started two servers in front of
// the owner and could not stop either. That was not one defect but four in a
// line, and three of them were still there after the first was fixed:
//
//   the hand	kept no record of a group a finished run left standing, and
//	scoped signals to the Landlock domain that sent them, so a LATER
//	command's `kill` answered "Operation not permitted". FIXED 2026-08-23
//	in `hand/`: `Runner.left`, `Req::Runs`, `Req::Signal` by identifier.
//   ext/hand.js	default-DENIED `{"t":"runs"}` at its message switch, so the
//	question never left the browser.
//   www/js/hand.js	dropped the answer for having no `id` — and it has no id
//	by design, because a filter on that message would be a selector.
//   src/tools.rs	offered no daimon-facing tool that could send either.
//
// Each of the three was invisible to every existing test, because each sits in a
// different file and none of them is reached by the one below it. `hand/`'s own
// unit tests drive the runner in process and never meet the browser;
// `dev/verify_hand.mjs` drives the extension from a stub page that speaks the
// port directly and never loads `www/js/hand.js`; and the Rust tests cannot
// reach a wasm-only call site at all. So this file is the join: REAL Chrome, the
// REAL extension, the REAL `www/js/hand.js`, and the REAL `daimond-hand` binary
// with the REAL Landlock fence, and it asks the one question none of them can —
// does a command that outlives itself come back?
//
// WHAT IT DOES NOT PROVE. There is no app and no model here: the page calls
// `DaimondHand.runs()` where `Tool::runs` would. What the model is HANDED is
// decided by `runs_step` and `runs_report`, which are pure and tested natively
// in `src/tools.rs`. This file proves the transport those two sit on top of.
//
// THE PROOF THAT A LEAK IS A LEAK. A `sleep` is started in the background by a
// command that then exits, so the run ENDS and its process group does not. The
// pid is read out of the command's own output and checked FROM NODE, outside the
// browser and outside the fence, at every step: it is alive after the run has
// ended, and it is gone after the stop. A listing that agreed with itself would
// prove nothing; the kernel is the oracle.
//
//	xvfb-run -a -s "-screen 0 1400x900x24" node dev/verify_handstop.mjs
//
//	  --break denyruns   put the extension's default-deny back  (ext/hand.js)
//	  --break dropruns   put the page's drop-for-no-id back     (www/js/hand.js)
//	  --keep             leave the scratch tree behind
//
// Both breaks are the code as it stood at commit 3e9ac52, restored into a COPY of
// the file and never into the tree. Each names the checks it must redden, and a
// break that reddens none of them fails the run: a check that has never been seen
// failing is not a check.
//
// Headed, because Chromium loads an unpacked extension in no other mode. Needs
// nothing else running: it serves its own two files.
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PW = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;

const HERE	= path.dirname(fileURLToPath(import.meta.url));
const ROOT	= path.join(HERE, '..');
const WWW	= path.join(ROOT, 'www');
const INSTALL	= path.join(ROOT, 'hand/install/install.sh');
const HAND	= path.join(ROOT, 'hand/target/release/daimond-hand');
const EXTID	= 'mpliijponglmmffjnonahhignkpkhmij';
// Not /tmp -- it is a tmpfs, and what is written there is RAM charged to this
// machine's agent fleet. See the SCRATCH note in harness.mjs.
const SCRATCH	= process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond');

const argv	= process.argv.slice(2);
const KEEP	= argv.includes('--keep');
const BREAK	= (() => { const i = argv.indexOf('--break'); return i >= 0 ? String(argv[i + 1] || '') : ''; })();

// Each break is the line as it stood before this work, put back in a copy. The
// `must` list is what it has to redden; a break that reddens none of them has
// proved that the checks aimed at it are measuring nothing.
const BREAKS = {
	// ext/hand.js:783 — `runs` reached the default arm, which refuses.
	denyruns: {
		file: 'ext',
		find: "\t\t\tcase 'runs':\n\t\t\t\tbreak;",
		with: "\t\t\tcase '__runs_never':\n\t\t\t\tbreak;",
		must: ['the hand answers what it is running', 'a background process is listed as standing'],
	},
	// www/js/hand.js:360 — the answer carries no id, so the run switch dropped it.
	dropruns: {
		file: 'www',
		find: "\t\tif (msg.t === 'runs') {",
		with: "\t\tif (false && msg.t === 'runs') {",
		must: ['the hand answers what it is running', 'a background process is listed as standing'],
	},
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; there are: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const note = (s) => console.log('  ·    ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Is this pid a process that is still going, asked of the kernel and not of the
/// hand? A zombie does not count: a reaped child keeps its `/proc` entry for a
/// moment and counting it would make every successful stop look like a failure.
function alive(pid) {
	if (!pid || !Number.isInteger(pid)) return false;
	try {
		const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
		return st.slice(st.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
	} catch (e) { return false; }
}

// ── One tree, and nothing of this run survives it ───────────────────
const BASE	= path.join(SCRATCH, `handstop-${process.pid}`);
const PROFILE	= path.join(BASE, 'profile');
const JOURNAL	= path.join(BASE, 'journal');
const GRANT	= path.join(BASE, 'work');
const HOSTS	= path.join(PROFILE, 'NativeMessagingHosts');
fs.rmSync(BASE, { recursive: true, force: true });
for (const d of [PROFILE, JOURNAL, GRANT, HOSTS]) fs.mkdirSync(d, { recursive: true });
// 0700, and it is load-bearing: `root.txt` beside the journal makes
// `journal::is_ours` answer no, so the hand will not tighten the directory
// itself and a mode anyone else can read is a refusal to start.
fs.chmodSync(JOURNAL, 0o700);

// ── The extension, and the page, as this run will serve them ────────
//
// The dev build is the only one that will speak to a page on loopback. It is
// written to a shared directory, so it is COPIED here before a break touches it:
// patching the shared one would damage every other harness on this machine.
const { extDev } = await import(pathToFileURL(path.join(HERE, 'extdev.mjs')).href);
const PORT = await (async () => {
	for (let p = 8837; p < 8877; p++) {
		try {
			await new Promise((res, rej) => {
				const s = http.createServer(() => {});
				s.once('error', rej);
				s.listen(p, '127.0.0.1', () => s.close(res));
			});
			return p;
		} catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
	}
	console.error('no free port from 8837');
	process.exit(2);
})();
const SHARED_EXT = await extDev(PORT);
const EXT = path.join(BASE, 'ext');
fs.cpSync(SHARED_EXT, EXT, { recursive: true });

/// Puts one break back into a copy of the file it was in, and refuses where the
/// line it names is not there — a break whose anchor has moved damages nothing
/// and passes quietly, which is worse than not running at all.
function damage(text, name) {
	const b = BREAKS[name];
	if (!text.includes(b.find)) {
		console.error(`\nbreak '${name}' cannot be applied: its anchor is not in the file.\n${b.find}`);
		process.exit(2);
	}
	return text.replace(b.find, b.with);
}
if (BREAK && BREAKS[BREAK].file === 'ext') {
	const f = path.join(EXT, 'hand.js');
	fs.writeFileSync(f, damage(fs.readFileSync(f, 'utf8'), BREAK));
	note(`break '${BREAK}' applied to the extension copy`);
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>handstop</title>
<body><h1>handstop</h1>
<script src="/js/hand.js"></script>
<script>
window.__why = function (e) { return 'ERR ' + ((e && e.message) || e); };
window.__status = function () { return DaimondHand.status().then(function (s) { return String(s); }, window.__why); };
window.__runs   = function () { return DaimondHand.runs().then(function (s) { return JSON.stringify(s); }, window.__why); };
window.__signal = function (id, sig) { return DaimondHand.signal(id, sig).then(function () { return 'sent'; }, window.__why); };
window.__run    = function (spec) { return DaimondHand.run(JSON.stringify(spec)).then(function (r) { return r; }, window.__why); };
</script></body>`;

const server = http.createServer((req, res) => {
	if (/^\/js\/hand\.js/.test(req.url || '')) {
		let js = fs.readFileSync(path.join(WWW, 'js/hand.js'), 'utf8');
		if (BREAK && BREAKS[BREAK].file === 'www') js = damage(js, BREAK);
		res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
		res.end(js);
		return;
	}
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
	res.end(PAGE);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
if (BREAK && BREAKS[BREAK].file === 'www') note(`break '${BREAK}' applied to the page's copy of hand.js`);

// ── The hand: built, granted a folder, and registered ───────────────
//
// `CARGO_TARGET_DIR` is removed from the build's environment, and that is not
// tidying: an agent working in this tree usually has one set, cargo would write
// the binary there, and `HAND` — the path `install.sh` registers and this file
// therefore runs — would still be whatever was built last. See the same note in
// verify_handreal.mjs, where an inherited one made a security test pass against a
// binary from before the fix.
const buildEnv = { ...process.env };
delete buildEnv.CARGO_TARGET_DIR;
if (!process.env.DAIMOND_NO_BUILD) {
	const r = spawnSync('cargo', ['build', '--release', '--manifest-path', 'hand/Cargo.toml'],
		{ cwd: ROOT, encoding: 'utf8', env: buildEnv });
	if (r.status !== 0) {
		console.log((r.stderr || '').split('\n').filter((l) => /^error/.test(l)).slice(0, 5).join('\n'));
	}
}
check('the hand is built', fs.existsSync(HAND), HAND);
if (!fs.existsSync(HAND)) { console.log(`\n${ok.length} ok, ${bad.length} failed`); process.exit(1); }

// The granted root, named the way a browser-launched hand actually reads it: a
// line in `root.txt` beside the journal. Chrome hands a native messaging host
// its OWN environment, so a variable exported in a terminal is not there.
fs.writeFileSync(path.join(JOURNAL, 'root.txt'),
	`# The one folder Daimond's machine hand may work in.\n${GRANT}\n`);
process.env.DAIMOND_HAND_JOURNAL_DIR = JOURNAL;
delete process.env.DAIMOND_HAND_ROOT;

const inst = spawnSync('bash', [INSTALL, '--dir', HOSTS, HAND], { cwd: ROOT, encoding: 'utf8' });
check('install.sh registers the real binary in this run\'s own profile',
	inst.status === 0 && fs.existsSync(path.join(HOSTS, 'com.oxedyne.daimond.hand.json')),
	(inst.stderr || inst.stdout || '').trim().split('\n').slice(-2).join(' '));

// ── The browser ─────────────────────────────────────────────────────
const b = await chromium.launchPersistentContext(PROFILE, {
	executablePath:	CHROME,
	headless:	false,
	args: ['--no-sandbox', '--disable-dev-shm-usage',
		`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
	viewport: { width: 1100, height: 700 },
});
const page = await b.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await sleep(500);

/// Finds the grant window and answers it. It is the extension's own page, so the
/// click is a real one and there is no second Chrome prompt behind it.
async function grant(answer = 'allow', ms = 15000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		for (const p of b.pages()) {
			if (/grant\.html/.test(p.url())) {
				await p.waitForLoadState('domcontentloaded');
				await sleep(250);
				await p.click(answer === 'allow' ? '#allow' : '#deny');
				return true;
			}
		}
		await sleep(150);
	}
	return false;
}

const found = await page.evaluate(() => document.documentElement.dataset.daimondHands || '');
check('the page finds the extension the way the app finds it', found === EXTID, found || '(no stamp)');

// The first message is what raises the grant window, so the answer is armed
// before it is sent and awaited after.
const statusP = page.evaluate(() => window.__status());
const granted = await grant('allow');
check('the grant window opened and was answered', granted);
const status = JSON.parse((await statusP) || '{}');
check('the real hand answered and named the folder it was granted',
	status && status.transport === 'machine' && status.root === GRANT,
	JSON.stringify(status).slice(0, 300));
// `paired` is FALSE here and that is correct, not a fault: `hand/REVIEW.md` §1.14
// refuses a command where the page cannot prove that the folder it has open is
// the folder the hand was granted, and a stub page holds no folder at all. It is
// asserted rather than worked around, because everything below happens IN SPITE
// of it -- `Tool::runs` deliberately does not gate on the folder proof, since it
// runs nothing and reads nothing, and gating on it would make a leaked server
// unstoppable on exactly the workspaces where one is easiest to leak.
check('the folder proof refuses this page, and stopping a run works regardless',
	status && status.paired === false && /folder|workspace/i.test(String(status.reason || '')),
	JSON.stringify(status.reason || '(no reason)').slice(0, 200));
// The hand's own home, which is how a granted toolchain's roots are expressed and
// how the extension recognises one. Without it a CORRECTLY granted toolchain is
// refused too -- a second, independent way to be told a fence reaches outside the
// grant, and one that would not show in the sentence the first produces.
check('the hand reports the home a granted toolchain would sit in',
	(status.caps || []).some((c) => typeof c === 'string' && c.indexOf('home:/') === 0),
	JSON.stringify(status.caps || []).slice(0, 300));

// ── 1. THE QUESTION ITSELF REACHES THE HAND ─────────────────────────
//
// Red against the extension's default-deny AND against the page's drop, and it
// is the cheapest of the three checks that are: nothing has been started yet, so
// what it measures is only whether the message can make the round trip at all.
const idle = await page.evaluate(() => window.__runs());
check('the hand answers what it is running',
	!String(idle).startsWith('ERR') && Array.isArray(JSON.parse(idle || '{}').runs),
	String(idle).slice(0, 300));
check('and it is running nothing before anything is started',
	(() => { try { return JSON.parse(idle).runs.length === 0; } catch (e) { return false; } })(),
	String(idle).slice(0, 200));

// ── 2. A COMMAND THAT OUTLIVES ITSELF ───────────────────────────────
//
// `sleep` is put in the background and the shell exits, so the RUN ends and its
// process group does not. Output is redirected, or the survivor holds the write
// end of the pipe open and the run cannot be reported as ended at all.
const RUN_ID = 'run-1-bash';
const spec = {
	t: 'exec', id: RUN_ID,
	argv: ['bash', '-c', 'sleep 300 </dev/null >/dev/null 2>&1 & echo LEFT=$!'],
	cwd: GRANT, env: [], stdin: null, timeout_ms: 30000, capture: 'both',
	fence: { rw: [GRANT], ro: [], deny: [], net: false }, toolkits: [],
};
const ran = JSON.parse(await page.evaluate((s) => window.__run(s), spec));
const leftPid = Number((/LEFT=(\d+)/.exec(ran.stdout || '') || [])[1] || 0);
check('a command that backgrounds a process runs and ends',
	ran.exit === 0 && leftPid > 0, JSON.stringify(ran).slice(0, 300));
check('and the daimon is TOLD the run left something standing',
	/standing|still running|left/i.test(String(ran.note || '')),
	JSON.stringify(ran.note || '(no note)').slice(0, 300));
// The kernel, not the listing: at this point the run is over and the process it
// left is alive, which is the whole shape of the leak.
check('and the process it left is alive on the machine', alive(leftPid), `pid ${leftPid}`);

// The hand looks at a group after the command ends, so the listing is asked for
// a moment later rather than in the same breath.
await sleep(600);
const standing = await page.evaluate(() => window.__runs());
const rows = (() => { try { return JSON.parse(standing).runs || []; } catch (e) { return []; } })();
const row = rows.find((r) => r && r.id === RUN_ID);
check('a background process is listed as standing, under the run\'s own identifier',
	!!row && row.state === 'standing', String(standing).slice(0, 400));
check('and the listing names the command line it came from',
	!!row && /sleep 300/.test(String(row.what || '')), row ? String(row.what) : '(no row)');

// ── 3. AND IT CAN BE STOPPED, BY THAT IDENTIFIER ────────────────────
const sent = await page.evaluate((id) => window.__signal(id, 'term'), RUN_ID);
check('the signal is accepted by the identifier the run was given', sent === 'sent', String(sent));
await sleep(800);
const after = await page.evaluate(() => window.__runs());
const left = (() => { try { return (JSON.parse(after).runs || []); } catch (e) { return [{ id: 'unreadable' }]; } })();
check('the run is gone from the listing after it is stopped',
	!left.some((r) => r && r.id === RUN_ID), String(after).slice(0, 400));
// And the oracle again, which is the half that cannot be faked by bookkeeping.
check('AND THE PROCESS IS GONE FROM THE MACHINE', !alive(leftPid), `pid ${leftPid}`);

// ── 4. AND ONLY WHAT THIS HAND STARTED CAN BE NAMED ─────────────────
//
// Not a check on the argument: the fence is that the argument cannot express
// anything else. A pid is not an identifier this hand ever issued, so naming one
// reaches nothing — and a `sleep` started by THIS PROCESS, which the hand never
// launched, is untouched by it.
const mine = spawnSync('bash', ['-c', 'setsid sleep 120 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' });
const minePid = Number((mine.stdout || '').trim());
await sleep(200);
if (alive(minePid)) {
	await page.evaluate((p) => window.__signal(String(p), 'kill'), minePid);
	await sleep(600);
	check('a pid is not a name this hand answers to, so a process it did not start survives',
		alive(minePid), `pid ${minePid}`);
	spawnSync('kill', ['-9', String(minePid)]);
} else {
	check('a pid is not a name this hand answers to', false, 'the fixture process never started');
}

// ── The verdict ─────────────────────────────────────────────────────
await b.close();
server.close();
if (!KEEP) fs.rmSync(BASE, { recursive: true, force: true });

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (BREAK) {
	const must = BREAKS[BREAK].must;
	const missed = must.filter((m) => !bad.some((n) => n.startsWith(m)));
	if (missed.length) {
		console.log(`THE BREAK PROVED NOTHING about: ${missed.join('; ')}`);
		process.exit(1);
	}
	console.log(`break '${BREAK}' reddened every check it names, and ${bad.length} in all`);
	process.exit(0);
}
process.exit(bad.length ? 1 : 0);
