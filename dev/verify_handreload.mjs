// verify_handreload.mjs — what a daimon left running, after the page is reloaded.
//
// WHY THIS FILE EXISTS. `dev/verify_handstop.mjs` proved that a command which
// outlives itself comes back: a `sleep` left standing by a finished run is listed
// under that run's identifier and can be stopped by it. Every one of its checks
// happens in ONE page load. Nothing anywhere asks the next question, which is the
// one a person actually meets:
//
//	a daimon starts a dev server, the turn ends, the user reloads the page —
//	and asks what is still running.
//
// A reload is not an exotic event. It is what F5 does, what a crash does, what
// `dev/serve.mjs` restarting does, and what the app itself does after an update
// (the 426 heal). It is also a COLD START, which is the moment the owner named:
// "every time I start using it I bump into a bug or things I hate."
//
// ── The property, which is not the one I set out to check ───────────
//
// I wrote this file expecting to find the record lost and the leak orphaned:
// `Runner.left` (hand/src/exec.rs:417) is an `Arc<Mutex<HashMap<..>>>` — memory in
// the hand process and nowhere else — and `ext/hand.js`'s `stop()` (ext/hand.js:556)
// sends `bye` and disconnects the native host when the page goes. Both true, and
// the conclusion drawn from them was wrong. MEASURED (2026-08-24, first run of this
// file): the teardown kills the standing group with it, so the process is gone and
// the empty listing that follows is honest.
//
// So the check is not "the record survives". It is the property that has to hold
// whichever way the teardown behaves, and the only one worth asserting:
//
//	AFTER A RELOAD, THE LISTING AND THE KERNEL AGREE.
//
// A listing that says "Nothing this hand started is still running" while a server
// holds a port is the exact defect `runs_report` was written to make impossible
// (`src/tools.rs:5279`: reporting a kill as done because the message went out "is
// the defect that left two servers holding ports with nothing able to reach them").
// An empty listing and a true nothing-there are indistinguishable from the daimon's
// side, and only one of them is honest.
//
// ── AND THEN THE OWNER DECIDED WHICH WAY IT SHOULD GO ───────────────
//
// The line above used to end "which way the teardown goes is reported as a NOTE,
// because it is a design fact that may legitimately change". It changed, on
// 2026-08-25, and it is now the design: a page that goes away holds what it left
// running for ABOUT THIRTY SECONDS and the same tab, reloaded, re-attaches. So
// the note becomes three more checks, and the agreement check stays exactly where
// it was, because agreement is what has to hold whichever way the design goes.
//
//	A RELOAD INSIDE THE GRACE FINDS THE PROCESS STILL RUNNING, ON THE SAME
//	HAND, WITH THE OUTPUT THAT ARRIVED WHILE THE PAGE WAS AWAY INTACT.
//
//	A RELOAD AFTER IT FINDS THE PROCESS STOPPED AND IS TOLD SO.
//
// The second is the half that is easy to leave out and is the more important. A
// process killed at thirty seconds and not mentioned is the teardown that
// swallowed a failed kill, in a new place: the listing is honestly empty and
// nothing anywhere says why. So the lapse is asserted to reach the page as WORDS,
// not merely to have happened.
//
// THE KERNEL IS THE ORACLE, at every step and from OUTSIDE the browser. The pid is
// read out of the command's own output and `/proc` is asked directly from node,
// before the reload and after it. A listing that agreed with itself would prove
// nothing; a process that is alive is alive.
//
// ── What this does NOT prove ────────────────────────────────────────
//
// There is no app and no model here: the page calls `DaimondHand.runs()` where
// `Tool::runs` would, exactly as `verify_handstop.mjs` does and for the same
// reason. What the model is HANDED is decided by `runs_step` and `runs_report`,
// which are pure and tested natively. This proves the transport and the record
// those two sit on top of, across a page load.
//
//	xvfb-run -a -s "-screen 0 1400x900x24" node dev/verify_handreload.mjs
//
//	  --break orphan     the reloaded page never adopts what was held for it, so
//	                     the parked relay keeps the standing group ALIVE while the
//	                     new page's new hand knows nothing about it. That is the
//	                     world this file exists to refuse — a process holding a
//	                     port with an empty listing beside it.
//	  --break nograce    the page going away stops everything on the spot, as it
//	                     did until 2026-08-25. The listing and the kernel still
//	                     AGREE, which is exactly why the agreement check was never
//	                     enough on its own.
//	  --break dropheld   the hold keeps the processes and throws the output away.
//	  --break silentlapse  the grace runs out and nothing is written down, so the
//	                     page that comes back late meets an empty listing with no
//	                     explanation — the swallowed teardown, in a new place.
//	  --break nolisten   the page's `runs` reply is dropped, as it was at 3e9ac52
//	  --keep             leave the scratch tree behind
//
// WHAT EACH BREAK REDDENS, established by running all four rather than reasoned
// about. A break whose reach is not stated is a break whose reach is not known.
//
//	orphan       7 — the reloaded page reaches no hand at all, because the
//	                 parked relay still holds the journal and a second host
//	                 exits on the lock. So everything downstream of "there is a
//	                 hand" goes with it, the agreement check among them.
//	nograce      6 — the reload kills what it found, as it did before, and a
//	                 SECOND hand answers. The agreement check stays GREEN
//	                 throughout, which is exactly why it was never enough alone.
//	dropheld     2 — the two output checks, and NOTHING else. The processes
//	                 survive, the hand is the same one, the lapse still reports
//	                 itself; only the words the command said in the gap are gone.
//	                 That isolation is what establishes that the output checks
//	                 measure the hold rather than the grace.
//	silentlapse  1 — the lapse check alone. The kill still happens, so "the
//	                 grace runs out and the standing group is stopped" stays
//	                 green: the split between doing it and saying it is the
//	                 whole point of that pair.
//
// Headed, because Chromium loads an unpacked extension in no other mode. Needs
// nothing else running: it serves its own two files, on its own port from 8837,
// into its own profile, journal and granted folder, and takes all of it down again.
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Chromium's ozone platform is chosen by autodetection and prefers Wayland whenever
// `WAYLAND_DISPLAY` is set -- which it is in every rc session on argonaut -- so a headed
// run under `xvfb-run` still went to the compositor and opened a window on the owner's
// desktop. Importing this strips the two variables from `process.env`, which is all a
// launcher that spreads `process.env` needs. See dev/display.mjs.
import './display.mjs';
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

// The extension's own `HOLD_MS`, read from the file rather than repeated here: a
// wait that disagreed with the hold would pass or fail for a reason that is not
// the property.
const HOLD_S = (() => {
	const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../ext/hand.js'), 'utf8');
	const m = /const HOLD_MS = (\d+);/.exec(src);
	if (!m) { console.error('ext/hand.js no longer names HOLD_MS; the wait cannot be aimed'); process.exit(2); }
	return Number(m[1]) / 1000;
})();

const argv	= process.argv.slice(2);
const KEEP	= argv.includes('--keep');
const BREAK	= (() => { const i = argv.indexOf('--break'); return i >= 0 ? String(argv[i + 1] || '') : ''; })();

// Each break is applied to a COPY of the file it is in, never to the tree. `must`
// is what it has to redden: a break that reddens none of the checks aimed at it has
// proved that those checks are measuring nothing.
const BREAKS = {
	// THE ONE THIS FILE IS FOR. The extension stops tearing the native host down
	// when the page goes, so the OLD hand stays alive holding the standing group,
	// and the reloaded page gets a NEW hand that has never heard of it. The process
	// is then alive on the machine and absent from the listing — and a daimon
	// reading that listing will tell the user nothing is running. It is not a
	// hypothetical: it is what the whole `Runner.left` mechanism was built to stop,
	// one layer up, where nothing had looked.
	orphan: {
		file: 'ext',
		find: "\t\tconst waiting = tab ? parked.get(tab) : null;",
		with: "\t\tconst waiting = null;\t/* break 'orphan': nothing is ever adopted */",
		must: ['the listing after the reload agrees with the kernel'],
	},
	// The world as it was until the grace landed: the page goes and everything
	// goes with it. Kept as a break because it is the one that shows why the
	// agreement check could never have caught this on its own — under it the
	// listing and the kernel agree perfectly, about a process that has been
	// killed by a keypress.
	nograce: {
		file: 'ext',
		find: "\t\tfunction park() {\n\t\t\tif (closing) return;",
		with: "\t\tfunction park() {\n\t\t\tif (closing) return;\n\t\t\tstop(''); return;\t/* break 'nograce' */",
		must: ['a reload inside the grace leaves the standing group running'],
	},
	// The processes are held and their output is not. This is the break the
	// output checks exist for: a daimon that re-attaches and silently misses
	// thirty seconds of a build is worse off than one whose build was killed.
	dropheld: {
		file: 'ext',
		find: "\t\t\tlet size = 0;\n\t\t\ttry { size = JSON.stringify(m).length; } catch (e) { size = 0; }\n\t\t\theld.push({ m, size });",
		with: "\t\t\tlet size = 0;\n\t\t\treturn;\t/* break 'dropheld': held output is thrown away */\n\t\t\theld.push({ m, size });",
		must: ['output that arrived while the page was away is held rather than dropped'],
	},
	// The grace runs out, the group is killed, and nothing is written down. The
	// kill still HAPPENS -- so the check about the process is green and only the
	// check about the words moves, which is the split that matters.
	silentlapse: {
		file: 'ext',
		find: "\t\t\tlapses.set(tabId, {\n\t\t\t\tat:      Date.now(),\n\t\t\t\taway:    HOLD_MS,",
		with: "\t\t\tif (false) lapses.set(tabId, {\n\t\t\t\tat:      Date.now(),\n\t\t\t\taway:    HOLD_MS,",
		must: ['a page that comes back after the grace is told what was stopped'],
	},
	// The page's drop-for-no-id, as it stood at 3e9ac52 — the seam that made `runs`
	// unreachable from the browser at all. It reddens the listing checks either
	// side of the reload rather than the agreement, and it is kept because a file
	// that can only be reddened one way has only been shown to measure one thing.
	nolisten: {
		file: 'www',
		find: "\t\tif (msg.t === 'runs') {",
		with: "\t\tif (false && msg.t === 'runs') {",
		must: ['a background process is listed as standing before the reload'],
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

/// Every `daimond-hand` this run's own installer registered that is alive now.
///
/// Read from `/proc` rather than from `pgrep`, and matched on THIS run's binary
/// path, so a hand belonging to another lane on this machine is never counted.
function handPids() {
	const out = [];
	for (const d of fs.readdirSync('/proc')) {
		if (!/^\d+$/.test(d)) continue;
		try {
			if (fs.readlinkSync(`/proc/${d}/exe`) === HAND) out.push(Number(d));
		} catch (e) { /* gone, or not ours to read */ }
	}
	return out;
}

// ── One tree, and nothing of this run survives it ───────────────────
const BASE	= path.join(SCRATCH, `handreload-${process.pid}`);
const PROFILE	= path.join(BASE, 'profile');
const JOURNAL	= path.join(BASE, 'journal');
const GRANT	= path.join(BASE, 'work');
const HOSTS	= path.join(PROFILE, 'NativeMessagingHosts');
fs.rmSync(BASE, { recursive: true, force: true });
for (const d of [PROFILE, JOURNAL, GRANT, HOSTS]) fs.mkdirSync(d, { recursive: true });
// 0700, and it is load-bearing: `root.txt` beside the journal makes
// `journal::is_ours` answer no, so the hand will not tighten the directory itself
// and a mode anyone else can read is a refusal to start.
fs.chmodSync(JOURNAL, 0o700);

// ── The extension, and the page, as this run will serve them ────────
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
/// line it names is not there — a break whose anchor has moved damages nothing and
/// passes quietly, which is worse than not running at all.
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

const PAGE = `<!doctype html><meta charset="utf-8"><title>handreload</title>
<body><h1>handreload</h1>
<script src="/js/hand.js"></script>
<script>
window.__why = function (e) { return 'ERR ' + ((e && e.message) || e); };
window.__status = function () { return DaimondHand.status().then(function (s) { return String(s); }, window.__why); };
window.__runs   = function () { return DaimondHand.runs().then(function (s) { return JSON.stringify(s); }, window.__why); };
window.__signal = function (id, sig) { return DaimondHand.signal(id, sig).then(function () { return 'sent'; }, window.__why); };
window.__run    = function (spec) { return DaimondHand.run(JSON.stringify(spec)).then(function (r) { return r; }, window.__why); };
/* Started and NOT awaited: the point is a command still printing when the page
   goes away, so the promise is parked on window and the caller returns at once. */
window.__start  = function (spec) { window.__pending = DaimondHand.run(JSON.stringify(spec)); return 'started'; };
window.__held   = function (id) { return DaimondHand.held(id).then(function (h) { return JSON.stringify(h); }, window.__why); };
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
// therefore runs — would still be whatever was built last.
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

// The granted root, named the way a browser-launched hand actually reads it: a line
// in `root.txt` beside the journal. Chrome hands a native messaging host its OWN
// environment, so a variable exported in a terminal is not there.
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
let page = await b.newPage();
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

// The first message is what raises the grant window, so the answer is armed before
// it is sent and awaited after.
const statusP = page.evaluate(() => window.__status());
const granted = await grant('allow');
check('the grant window opened and was answered', granted);
const status = JSON.parse((await statusP) || '{}');
check('the real hand answered and named the folder it was granted',
	status && status.transport === 'machine' && status.root === GRANT,
	JSON.stringify(status).slice(0, 300));

const handsBefore = handPids();
check('exactly one hand of this run\'s own binary is running',
	handsBefore.length === 1, JSON.stringify(handsBefore));

// ── 1. A COMMAND THAT OUTLIVES ITSELF ───────────────────────────────
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
check('and the process it left is alive on the machine', alive(leftPid), `pid ${leftPid}`);

// The hand looks at a group after the command ends, so the listing is asked for a
// moment later rather than in the same breath.
await sleep(600);
const before = await page.evaluate(() => window.__runs());
const rowsBefore = (() => { try { return JSON.parse(before).runs || []; } catch (e) { return []; } })();
check('a background process is listed as standing before the reload',
	rowsBefore.some((r) => r && r.id === RUN_ID && r.state === 'standing'),
	String(before).slice(0, 400));

// ── 2. THE RELOAD ───────────────────────────────────────────────────
//
// A plain reload of the same page, which is what F5 does and what the app's own
// update heal does. Nothing else is touched: the same browser, the same profile,
// the same extension, the same granted folder, and the same journal.
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(800);

// A reloaded page raises the grant window again on its first message, because the
// grant is held per page and not per profile. Armed the same way as the first.
const status2P = page.evaluate(() => window.__status());
await grant('allow', 8000);
const status2 = JSON.parse((await status2P) || '{}');
check('the reloaded page reaches a hand again',
	status2 && status2.transport === 'machine' && status2.root === GRANT,
	JSON.stringify(status2).slice(0, 200));

const handsAfter = handPids();
note(`hand pids before ${JSON.stringify(handsBefore)}, after ${JSON.stringify(handsAfter)}`);

// ── 3. THE LISTING AND THE KERNEL MUST AGREE ────────────────────────
//
// THIS IS THE FILE'S REASON, and it is one check because it is one property. Which
// way the teardown goes is a design fact and is REPORTED rather than asserted; that
// the two answers agree is not negotiable, because a daimon has no third source.
const after = await page.evaluate(() => window.__runs());
const rowsAfter = (() => { try { return JSON.parse(after).runs || []; } catch (e) { return null; } })();
const stillAlive = alive(leftPid);
const listed = Array.isArray(rowsAfter) && rowsAfter.some((r) => r && r.id === RUN_ID);
note(stillAlive
	? `the reload LEFT the process running (pid ${leftPid})`
	: `the reload TOOK the standing group with it (pid ${leftPid} is gone)`);
check('the listing after the reload agrees with the kernel',
	rowsAfter !== null && listed === stillAlive,
	`kernel says ${stillAlive ? 'alive' : 'gone'}, listing says `
	+ `${rowsAfter === null ? 'UNREADABLE' : (listed ? 'listed' : 'nothing')}`
	+ ` — ${String(after).slice(0, 240)}`);

// ── 4. THE GRACE, WHICH IS NOW WHICH WAY IT GOES ────────────────────
//
// The kernel is still the oracle. `stillAlive` above was read from `/proc`, from
// node, outside the browser; this is the same fact asserted rather than noted.
check('a reload inside the grace leaves the standing group running',
	stillAlive, `pid ${leftPid}`);

// ONE HAND, NOT TWO. A new host that happened to find the old group would look
// identical from the listing and would be a different thing entirely — the group
// would be reachable by luck rather than because the relay was handed back.
check('and the SAME machine hand answered, rather than a second one being started',
	handsAfter.length === 1 && handsBefore.length === 1 && handsAfter[0] === handsBefore[0],
	`before ${JSON.stringify(handsBefore)}, after ${JSON.stringify(handsAfter)}`);

// AND THE RE-ATTACH IS SAID, not merely done. A gap nobody mentions is a gap the
// reader assumes was not there.
const listing = (() => { try { return JSON.parse(after); } catch (e) { return null; } })();
check('a reload inside the grace says so, rather than saying nothing at all',
	!!listing && typeof listing.note === 'string' && /picked the machine hand back up/.test(listing.note),
	`note: ${String(listing && listing.note).slice(0, 200)}`);

// And, where it did survive, being told is no use unless it can then be stopped.
// Skipped rather than faked where the teardown already cleared it: a check that
// asserts a dead process is dead measures nothing.
if (stillAlive) {
	const sent = await page.evaluate((id) => window.__signal(id, 'term'), RUN_ID);
	await sleep(800);
	check('and a run that outlived the reload can still be stopped by its identifier',
		!alive(leftPid), `pid ${leftPid}, signal said: ${String(sent).slice(0, 80)}`);
} else {
	note('nothing survived the reload, so there is nothing to stop — check skipped');
}

// ── 4b. WHAT IT SAID WHILE NOBODY WAS LISTENING ─────────────────────
//
// The process surviving proves nothing about its OUTPUT, and the two are not the
// same promise. A daimon that re-attaches and silently misses part of a build is
// being lied to, which outranks a process that was honestly killed.
//
// THE MARKER IS PRINTED INSIDE THE GAP AND NOWHERE ELSE, which is what makes this
// a measurement rather than a coincidence. The command says nothing for four
// seconds, prints one line, and then goes quiet again; the page is away for eight.
// So the line exists only in the hold. A test that watched a command printing
// CONTINUOUSLY would pass with the hold gutted, because the output arriving after
// the re-attach looks exactly like the output the hold kept — measured, on
// 2026-08-25, by a `--break dropheld` that reddened nothing at all.
const AWAY_ID  = 'run-4-marker';
const AWAY_MS  = 8000;
await page.evaluate((s) => window.__start(s), {
	t: 'exec', id: AWAY_ID,
	argv: ['bash', '-c', 'echo BEFORE-MARKER; sleep 4; echo AWAY-MARKER; sleep 200'],
	cwd: GRANT, env: [], stdin: null, timeout_ms: 240000, capture: 'both',
	fence: { rw: [GRANT], ro: [], deny: [], net: false }, toolkits: [],
});
await sleep(1200);	// long enough for BEFORE-MARKER to reach the page that is here
await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
await sleep(AWAY_MS);
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await sleep(600);
const backP = page.evaluate(() => window.__status());
await grant('allow', 8000);
await backP;

const back = await page.evaluate(() => window.__runs());
// Read BEFORE anything is stopped: handing the output over lets go of it, and a
// stop would end the run it belongs to.
const heldAway = await page.evaluate((id) => window.__held(id), AWAY_ID);
const backList = (() => { try { return JSON.parse(back); } catch (e) { return null; } })();
const carried  = (backList && Array.isArray(backList.carried)) ? backList.carried : [];
check('the listing names the output being held and which run it belongs to',
	carried.some((c) => c && c.id === AWAY_ID && c.bytes > 0),
	`carried: ${JSON.stringify(carried)}`);

const twiceRaw = await page.evaluate((id) => window.__held(id), AWAY_ID);
const readBack = (() => { try { return JSON.parse(heldAway); } catch (e) { return null; } })();
check('output that arrived while the page was away is held rather than dropped',
	!!readBack && readBack.found === true && /AWAY-MARKER/.test(String(readBack.out || '')),
	`held: ${String(heldAway).slice(0, 300)}`);

// SPENT ON READING. A second copy of a build's output in a tab is one nobody will
// look at again, and a reader who is told it is held twice would believe the
// second answer as much as the first.
const twice = (() => { try { return JSON.parse(twiceRaw); } catch (e) { return null; } })();
check('and it is handed over once, not held for a second reader',
	!!twice && twice.found === false, `second read: ${String(twiceRaw).slice(0, 200)}`);

// ── 5. AND WHEN NOTHING COMES BACK FOR IT ───────────────────────────
//
// The other half, and the one that is easy to leave out. The page goes away and
// STAYS away past the hold, so what it left is stopped — and the page that comes
// back afterwards has to be TOLD, in words, that something was stopped and why.
// A kill nobody mentions is the teardown that swallowed a failed kill, in a new
// place: the listing is honestly empty and nothing anywhere says the reason.
//
// A second standing group, because the first was stopped by the check above.
const LATE_ID = 'run-3-late';
const lateRaw = await page.evaluate((s) => window.__run(s), {
	t: 'exec', id: LATE_ID,
	argv: ['bash', '-c', 'sleep 300 </dev/null >/dev/null 2>&1 & echo LEFT=$!'],
	cwd: GRANT, env: [], stdin: null, timeout_ms: 30000, capture: 'both',
	fence: { rw: [GRANT], ro: [], deny: [], net: false }, toolkits: [],
});
// Not `JSON.parse` outright: under a break the hand may be gone and `__run`
// answers a SENTENCE, and a verifier that died there would report nothing about
// the checks below rather than reddening them.
const late = (() => { try { return JSON.parse(lateRaw) || {}; } catch (e) { return {}; } })();
const latePid = Number((/LEFT=(\d+)/.exec(late.stdout || '') || [])[1] || 0);
check('a second background process is left standing for the grace to run out on',
	late.exit === 0 && alive(latePid), `pid ${latePid}`);

// Away, and away for longer than the hold. The SAME TAB, because the tab is what
// the hold is keyed by — a hold offered to whichever page connected next would be
// somebody else's compartment.
await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
note(`waiting out the ${Math.round(HOLD_S)}s hold with the page away`);
await sleep(HOLD_S * 1000 + 6000);

check('the grace runs out and the standing group is stopped', !alive(latePid), `pid ${latePid}`);

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await sleep(600);
const status3P = page.evaluate(() => window.__status());
await grant('allow', 8000);
await status3P;
const late2 = await page.evaluate(() => window.__runs());
const lateList = (() => { try { return JSON.parse(late2); } catch (e) { return null; } })();
check('a page that comes back after the grace is told what was stopped and why',
	!!lateList && typeof lateList.note === 'string'
		&& /STOPPED/.test(lateList.note) && /did not come back/.test(lateList.note),
	`note: ${String(lateList && lateList.note).slice(0, 300)} — ${String(late2).slice(0, 200)}`);

// ── The verdict ─────────────────────────────────────────────────────
//
// Whatever was left standing is cleared from NODE, outside the browser and outside
// the fence, so a red run does not leave a `sleep` behind for somebody else to find.
if (alive(leftPid)) { spawnSync('kill', ['-9', String(leftPid)]); note(`cleared pid ${leftPid} from outside`); }
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
