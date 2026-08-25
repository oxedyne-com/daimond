// verify_reflux.mjs — the door a daimon reaches `dev/reflux.mjs` through.
//
// `dev/BLOCKERS.md` B13, in the two sentences two lanes wrote it in:
//
//	A daimon spends the user's own key on its own turn; there is no tool that lets
//	it hold a budget and send a request outside it.
//
//	It drives a headed browser under xvfb.  `run` cannot: the fence has no display
//	and the harness's own `displayFault()` refuses a forwarded one, correctly.
//
// Together those put `dev/reflux.mjs` -- the instrument OBJECTIVES §1 is scored on
// -- outside a daimon's reach, so a daimon can fix its own blockers, land the
// change, and never see the number move.  This file is the reach.
//
// ── Why a verifier, and not a command and not another machine ────────
//
// `run` is not a door and cannot be made into one.  `hand/src/verify.rs` says why
// in its own opening: `listen()` is refused by `crate::seccomp`, a browser needs
// the display server's unix socket and `seccomp::Unix::Refuse` takes that away.
// A browser under the command fence is not a thing that is missing a display; it
// is a thing the fence exists to prevent.  So no amount of display arranging
// reaches `reflux` through `run`.
//
// Reaching it over ssh on a machine with no seat -- gilgamesh -- would work, and
// it needs a chromium and an xvfb installed on a machine that is not this one, a
// built wasm bundle over there, and an ssh private key within a daimon's reach.
// Three new things to trust, to get somewhere this tree already goes.
//
// `verify` already goes there.  It runs a TRACKED script outside the command
// fence, deliberately and on the record -- `fence:none` in the journal, the
// bytes checked against the commit before every spawn -- with the network open
// and a budget up to four hours.  That is the trust class this measurement wants
// and it was built for exactly this reason.  What it did not have was a display
// it could hand on and a key of its own, and those are the two halves below.
//
// ── The display this file starts for itself ─────────────────────────
//
// `verify` spawns with the hand's own environment.  Start the hand from a desktop
// session and that environment carries `DISPLAY=:0`, which `displayFault` allowed
// -- rightly, for a person watching their own run, and disastrously for a run
// nobody asked for.  So this file starts an Xvfb of its OWN, on a display number
// it picked because nothing held it, and hands the child that and nothing it
// inherited.  `dev/display.mjs` refuses the difference: see `UNATTENDED_VAR`
// there, and `dev/verify_harness.mjs`'s `oldguard` break for the same guard with
// the rule cut back out of it.  Spelled without the flag ON PURPOSE: the hand reads
// break declarations out of a verifier's own source by scanning for the flag, and it
// cannot tell a file naming its own break from a file naming somebody else's -- so a
// cross-reference written the obvious way made `verify` offer this file a break it
// does not have, which it refused, ending the run with no checks at all.  Found by
// running the verb over this tree rather than by reading either file.
//
// ── The key this file spends from ───────────────────────────────────
//
// NOT the owner's.  `~/.config/oxedyne/daimond/openrouter.key` is his; the daimon
// holds its own beside its own ssh key, at
//
//	~/.config/oxedyne/daimond-hand/openrouter.key      0600, in a 0700 directory
//
// OpenRouter enforces a limit per key, so a key of its own IS a budget of its own
// -- the first half of B13 is a second key and always was.  Outside `~/usr`
// because that tree is a Syncthing folder and a candidate for `ore init`, and a
// credential inside it is copied to another machine whether or not any source
// ever holds its value.  Nothing in this repository holds the value, here or as a
// fallback: an example that runs with no configuration is how a live key reached
// a public repository from this tree on 2026-07-10 and was used by somebody else
// nine days later.  Absent, this file SKIPS and prints the one line that fixes it.
//
//	node dev/verify_reflux.mjs
//	node dev/verify_reflux.mjs --break nodisplay   # 1: no display at all, which is B13's own world
//	node dev/verify_reflux.mjs --break inheritseat # 2: the child is handed the seat it inherited
//	node dev/verify_reflux.mjs --break ownerkey    # 3: no key of its own, so reflux reaches for his
//
//	  DAIMOND_REFLUX_BUDGET   dollars for the paid run (default 0.35)
//	  DAIMOND_REFLUX_TASK     which reflux tasks to run (default homerun)
//	  DAIMOND_REFLUX_WORLD    world number, ports 8777+n and 9700+n (default 6)
//
// The paid run is ONE task by default and not the whole table.  A verifier is run
// by a suite as well as by a daimon, and a file that spent a dollar every time
// anybody typed its name would be turned off within the week.  `dev/run_all.sh`
// skips it outright unless `DAIMOND_REFLUX_PAID` is set; a daimon asking for it by
// name gets the run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	displayFault,
	cleanDisplayEnv,
	INHERITED_ENV,
	UNATTENDED_VAR,
	OWNED_VAR,
	SEAT_DISPLAY,
} from './display.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/// Every break this file declares, so an unknown one is refused by name.
const BREAKS = ['nodisplay', 'inheritseat', 'ownerkey'];

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	const b = i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : '';
	if (b && !BREAKS.includes(b)) {
		console.log(`no such break: ${b}. This file declares: ${BREAKS.join(', ')}.`);
		process.exit(1);
	}
	return b;
})();

/// Where the daimon's own provider key lives.
///
/// Beside its own ssh key, in the directory that is already the machine hand's
/// and already 0700.  Absolute, and built from the home directory rather than
/// written down twice, so a scratch home in a break resolves to a scratch path.
function daimonKeyFile(home = os.homedir()) {
	return path.join(home, '.config/oxedyne/daimond-hand/openrouter.key');
}

/// Where the OWNER's key lives, which is the one this file must never reach for.
///
/// Named only to be compared against.  Nothing here opens it.
function ownerKeyFile(home = os.homedir()) {
	return path.join(home, '.config/oxedyne/daimond/openrouter.key');
}

const SCRATCH = path.join(process.env.DAIMOND_SCRATCH
	|| path.join(os.homedir(), '.cache/daimond'), 'refluxdoor');
const BUDGET  = Number(process.env.DAIMOND_REFLUX_BUDGET || '0.35');
const TASK    = process.env.DAIMOND_REFLUX_TASK || 'homerun';
const WORLD   = Number(process.env.DAIMOND_REFLUX_WORLD || '6');

let ok = 0, bad = 0;

/// One check, named as a property rather than as a step.
function check(name, pass, detail) {
	if (pass) { ok++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function note(s) { console.log(`  ·    ${s}`); }

// ── The display ─────────────────────────────────────────────────────

/// Is an X lock file the record of a server that is still there?
///
/// A LOCK IS NOT A HOLD.  An X server writes its process id into `/tmp/.X<n>-lock`
/// and removes the file on the way out -- and a process killed with `SIGKILL` gets
/// no way out, so the file stays and the number is burned until somebody notices.
/// Nine of them in one session, on 2026-08-25, from this very file: the first
/// version of `stopXvfb` reached for `SIGKILL` and every run cost a display.  Both
/// halves are fixed, and this is the half that survives somebody else's crash.
///
/// # Arguments
/// * `n` - The display number.
function lockIsLive(n) {
	let pid;
	try { pid = Number(fs.readFileSync(`/tmp/.X${n}-lock`, 'utf8').trim()); }
	catch { return false; }		// no lock at all
	if (!Number.isInteger(pid) || pid <= 0) return true;	// unreadable: leave it alone
	// `/proc` rather than `kill(0)`, which answers yes for a zombie and for a
	// process this one may not signal.
	return fs.existsSync(`/proc/${pid}`);
}

/// A display number nothing on this machine holds.
///
/// The socket is asked about as well as the lock, because either one alone leaves
/// a race with the other half of an X server that is still coming up, and two
/// verifiers starting at once is ordinary.  From 90 rather than from 99, so a run
/// of this file does not fight `xvfb-run -a`, which starts at 99 and counts up.
function freeDisplay() {
	for (let n = 90; n < 99; n++) {
		if (lockIsLive(n)) continue;
		// A socket outlives its server too, and the same reasoning applies: it is
		// evidence of a lock, and the lock has already been read.
		if (!fs.existsSync(`/tmp/.X${n}-lock`) && fs.existsSync(`/tmp/.X11-unix/X${n}`)) continue;
		return n;
	}
	return -1;
}

/// An Xvfb this process started, and the display it answers on.
///
/// Killed on every way out of this file -- an ordinary return, a throw, and the
/// signals the hand's `kill_on_drop` sends when a `verify` budget is spent.  An X
/// server left behind holds its display number against the next run, which is the
/// same collision `freeDisplay` walks past nine times before giving up.
async function startXvfb() {
	const n = freeDisplay();
	if (n < 0) return { display: '', proc: null, why: 'displays :90 to :98 are all held' };
	const sock = `/tmp/.X11-unix/X${n}`;
	const p = spawn('Xvfb', [`:${n}`, '-screen', '0', '1500x950x24', '-nolisten', 'tcp'],
		{ stdio: ['ignore', 'ignore', 'pipe'] });
	let died = '';
	p.on('error', (e) => { died = String(e && e.message); });
	p.stderr.on('data', (d) => { died += String(d); });
	for (let i = 0; i < 100; i++) {
		if (fs.existsSync(sock)) return { display: `:${n}`, proc: p, why: '' };
		if (p.exitCode !== null) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	try { p.kill('SIGKILL'); } catch { /* already gone */ }
	return { display: '', proc: null, why: `Xvfb :${n} did not come up. ${died.trim()}` };
}

let XVFB = null;

/// Ends this run's X server and takes its lock with it.
///
/// SIGTERM FIRST, and the difference is a display number.  Xvfb removes its own
/// lock file on a clean exit and cannot on a `SIGKILL`, so the impatient version of
/// this function burned nine numbers in one session before `freeDisplay` ran out
/// and the clean run failed.  The lock is removed here as well, because this
/// function is also called from a signal handler where there is no waiting.
function stopXvfb() {
	if (!XVFB || !XVFB.proc) { XVFB = null; return; }
	const { proc, display } = XVFB;
	XVFB = null;
	try { proc.kill('SIGTERM'); } catch { /* already gone */ }
	// Synchronous, because `process.on('exit')` runs nothing asynchronous.
	const until = Date.now() + 2000;
	while (proc.exitCode === null && proc.signalCode === null && Date.now() < until) {
		try { spawnSync('sleep', ['0.05']); } catch { break; }
	}
	try { proc.kill('SIGKILL'); } catch { /* already gone */ }
	const n = display.replace(':', '');
	// Ours by construction: `freeDisplay` would not have offered the number if
	// anything else had held it, and nothing else can have taken it since.
	for (const f of [`/tmp/.X${n}-lock`, `/tmp/.X11-unix/X${n}`]) {
		try { fs.rmSync(f, { force: true }); } catch { /* not ours to remove */ }
	}
}
process.on('exit', stopXvfb);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
	process.on(sig, () => { stopXvfb(); process.exit(1); });
}

/// The environment a child of this file is given.
///
/// The single place the two halves are decided, so a check can be put to the
/// decision rather than to a copy of it -- and so a break changes the world and
/// not the assertion about it.
///
/// # Arguments
/// * `display` - The display this file started, or `''` where it started none.
/// * `keyFile` - The key file to name, or `''` to name none and let `reflux` pick.
function childEnv(display, keyFile) {
	const env = cleanDisplayEnv(process.env);
	// Whatever this process inherited, gone, and only then this file's own. A
	// deletion rather than an assignment because the assignment alone reads as a
	// default, and the difference is the seat.
	delete env.DISPLAY;
	if (BREAK === 'inheritseat') {
		// B13's world before the guard could see it: a run nobody asked for, given
		// whatever display the hand happened to hold.
		env.DISPLAY = (INHERITED_ENV.DISPLAY || '').trim() || SEAT_DISPLAY;
	} else if (display) {
		env.DISPLAY = display;
	}
	env[UNATTENDED_VAR] = '1';
	if (display) env[OWNED_VAR] = display;
	// A key IN THE ENVIRONMENT is a key this file did not choose. `readKey` reads
	// this name before it reads any file, so leaving it would let whatever started
	// the hand decide what a daimon spends.
	delete env.DAIMOND_PROBE_KEY;
	if (keyFile) env.DAIMOND_PROBE_KEY_FILE = keyFile;
	else delete env.DAIMOND_PROBE_KEY_FILE;
	env.DAIMOND_SCRATCH = SCRATCH;
	return env;
}

// ── The run ─────────────────────────────────────────────────────────

console.log('\n== verify_reflux: the door a daimon reaches the instrument through ==');
if (BREAK) console.log(`   BREAK ${BREAK} — checks below are EXPECTED to fail`);

fs.mkdirSync(SCRATCH, { recursive: true });

console.log('\n── A display this file started for itself ────────────');

XVFB = BREAK === 'nodisplay'
	? { display: '', proc: null, why: 'the break started none, which is B13\'s own world' }
	: await startXvfb();
const DISPLAY = XVFB.display;

check('an Xvfb of this run\'s own is up, on a display number nothing else held',
	!!DISPLAY, DISPLAY || XVFB.why);

const KEY_FILE = BREAK === 'ownerkey' ? '' : daimonKeyFile();
const ENV = childEnv(DISPLAY, KEY_FILE);

// ASKED OF WHAT IS HANDED ON, not of what was started. The two differ by exactly
// one accident -- a display inherited from whatever launched the hand, quietly
// winning over the one this file went to the trouble of starting -- and that
// accident is B13's whole second half.
check('the display handed to the child is the one this file started, and neither the '
	+ 'seat nor what it inherited',
	!!DISPLAY && ENV.DISPLAY === DISPLAY && DISPLAY !== SEAT_DISPLAY
		&& DISPLAY !== (INHERITED_ENV.DISPLAY || '').trim(),
	`started ${DISPLAY || '<none>'}, handed ${ENV.DISPLAY || '<none>'}, `
	+ `inherited ${(INHERITED_ENV.DISPLAY || '').trim() || '<none>'}`);

{
	const said = displayFault(ENV);
	check('the environment this file hands on is one the guard accepts',
		said === null, JSON.stringify(said));
}

{
	// The refusal put to the REAL module with the REAL environment, differing from
	// the one above in the display alone. Not a launch: a browser started to find
	// out where a browser would appear is a check nobody dares run.
	const said = displayFault({ ...ENV, DISPLAY: SEAT_DISPLAY });
	check('the same environment carrying the seat instead is refused, and the seat named',
		typeof said === 'string' && said.includes('OWN SEAT'), JSON.stringify(said));
}


// A real headed browser, on the display this file started, and on no other. This
// is the one check that asks the X server rather than the guard: a headed Chromium
// with nowhere to paint does not start at all, so a browser that answers is a
// browser that connected to THIS display.
if (DISPLAY && BREAK !== 'inheritseat') {
	let why = '';
	let landed = false;
	try {
		// The same playwright and the same Chrome `dev/harness.mjs` uses, taken from
		// it rather than written down again: a browser proved to land on this display
		// is only evidence if it is the browser everything else here launches.
		const { PW, CHROME } = await import('./harness.mjs');
		const { chromium } = await import(pathToFileURL(PW).href);
		const prof = path.join(SCRATCH, 'guard-profile');
		fs.rmSync(prof, { recursive: true, force: true });
		const b = await chromium.launchPersistentContext(prof, {
			executablePath: CHROME,
			headless: false,
			env: ENV,
			args: ['--no-sandbox', '--no-first-run'],
			viewport: { width: 800, height: 600 },
		});
		const pg = b.pages()[0] || await b.newPage();
		await pg.goto('about:blank');
		landed = true;
		await b.close();
	} catch (e) {
		why = String(e && e.message).split('\n')[0];
	}
	check('a real headed Chromium starts on that display and on nothing else',
		landed, why || `DISPLAY=${DISPLAY}`);
} else if (BREAK === 'inheritseat') {
	// NOT LAUNCHED, AND THIS IS THE ONE PLACE THAT MATTERS. The break's whole
	// content is a display that belongs to somebody else -- on this machine, over
	// an ssh forward to the owner's laptop. Starting a browser to watch a break
	// work would put the window on his screen, which is the accident the guard
	// exists to prevent.
	note('the browser was not launched: the break\'s display is somebody else\'s');
} else {
	check('a real headed Chromium starts on that display and on nothing else',
		false, XVFB.why || 'there is no display to start it on');
}

console.log('\n── A key of its own ──────────────────────────────────');

const NAMED = ENV.DAIMOND_PROBE_KEY_FILE || '';

check('the key named to the child is the daimon\'s, not the owner\'s',
	!!NAMED && NAMED !== ownerKeyFile() && /daimond-hand/.test(NAMED),
	NAMED || '<none named, so reflux picks -- and its default is his>');

check('and it lives outside ~/usr, which is replicated and is a candidate for ore init',
	!!NAMED && !NAMED.startsWith(path.join(os.homedir(), 'usr')) && !NAMED.startsWith(ROOT),
	NAMED || '<none named>');

// The child is told WHERE the key is and never what it is. `readKey` reads
// `DAIMOND_PROBE_KEY` before it reads any file, so a value left in the environment
// would let whatever started the hand decide what a daimon spends -- and an
// environment is copied into every child of every child.
check('the child is handed a path to the key and never the key itself',
	ENV.DAIMOND_PROBE_KEY === undefined && !!NAMED,
	`DAIMOND_PROBE_KEY ${ENV.DAIMOND_PROBE_KEY === undefined ? 'unset' : 'SET'}, `
	+ `DAIMOND_PROBE_KEY_FILE ${ENV.DAIMOND_PROBE_KEY_FILE || '<unset>'}`);

// What `reflux` actually does when the key it is pointed at is not there. The real
// file, the real `readKey`, and a home directory of this run's own so that neither
// the owner's key nor the daimon's is anywhere near the answer.
{
	const home = path.join(SCRATCH, 'home');
	fs.mkdirSync(home, { recursive: true });
	const env = childEnv(DISPLAY, KEY_FILE ? daimonKeyFile(home) : '');
	env.HOME = home;
	const r = spawnSync(process.execPath, ['dev/reflux.mjs', '--task', TASK, '--no-build'],
		{ cwd: ROOT, encoding: 'utf8', env, timeout: 60_000 });
	const said = `${r.stdout || ''}${r.stderr || ''}`;
	check('with no key of its own, reflux stops rather than spending, and names the file',
		r.status !== 0 && said.includes(daimonKeyFile(home)),
		(said.split('\n').find((l) => l.includes('openrouter.key')) || said.split('\n')[0] || '')
			.trim().slice(0, 160));
	check('and the file it names is not the owner\'s',
		!said.includes(ownerKeyFile(home)),
		said.includes(ownerKeyFile(home)) ? 'it reached for the owner\'s key' : 'it did not');
}

// ── The number ──────────────────────────────────────────────────────

console.log('\n── The run, and the number it comes back with ────────');

const HAVE_KEY = !!KEY_FILE && fs.existsSync(KEY_FILE);
let paid = false;

if (BREAK) {
	note(`no paid run under a break: a break spends money to watch a check redden, `
		+ 'and every check this file declares reddens for free.');
} else if (!DISPLAY) {
	note('no paid run: there is no display to run it on.');
} else if (!HAVE_KEY) {
	// A CHECK AND NOT A SKIP, and the difference is what a daimon is told.
	//
	// The tree's idiom for "cannot be given what it needs" is exit 2 and a SKIPPED
	// line -- `verify_droots_real` does exactly that. It is right for `run_all.sh`,
	// which reads exit codes, and it is silent through `verify`: the hand's report
	// carries the check lines and the FAIL lines and nothing else, so this file
	// exiting 2 with ten green checks reached a daimon as "10 checks passed, 0
	// failed, 3 breaks confirmed red" -- a clean bill of health for a run that never
	// happened. Measured on 2026-08-25 by conducting this file through the verb.
	//
	// So the missing key is a check, it is red because it is false, and the whole of
	// what to do about it rides in the detail, which is the part `fails` keeps whole.
	check('the run behind this door has a key of its own to spend',
		false,
		`there is no key at ${KEY_FILE}. Only the owner can mint one: a NEW key at `
		+ 'openrouter.ai/settings/keys with a credit limit of its own, then `install -d '
		+ '-m 700 ~/.config/oxedyne/daimond-hand && install -m 600 /dev/stdin '
		+ '~/.config/oxedyne/daimond-hand/openrouter.key`. This file WILL NOT reach for '
		+ 'his. The door above is proved; the run behind it did not run.');
	console.log('');
	console.log('  The checks above are real. The run is not run, and that is not a pass.');
	console.log('');
} else {
	const args = ['dev/reflux.mjs', '--task', TASK, '--budget', BUDGET.toFixed(2),
		'--world', String(WORLD)];
	note(`reflux ${args.slice(1).join(' ')} on ${DISPLAY}, from ${KEY_FILE}`);
	const r = spawnSync(process.execPath, args,
		{ cwd: ROOT, encoding: 'utf8', env: ENV, maxBuffer: 64 * 1024 * 1024 });
	const said = `${r.stdout || ''}${r.stderr || ''}`;
	for (const line of said.split('\n')) {
		if (/^(task|TOTAL|\s{2}\S+\s+(pass|FAIL))/.test(line)) console.log(`  |  ${line}`);
	}
	const total = said.split('\n').find((l) => l.startsWith('TOTAL')) || '';
	const spent = Number((total.match(/\$([0-9.]+)/) || [])[1] || 'NaN');
	check('reflux ran to its end inside the fence-free door and reported',
		r.status === 0, `exit ${r.status}` + (r.status === 0 ? '' : `: ${said.slice(-400)}`));
	check('it came back with a number, and the number is inside the budget it was given',
		Number.isFinite(spent) && spent <= BUDGET,
		total.trim() || said.split('\n').slice(-3).join(' | ').slice(0, 200));
	paid = true;
}

stopXvfb();

console.log(`\n${ok} ok, ${bad} failed.`);
if (bad) { console.log('failed checks above.'); process.exit(1); }
if (!paid && !BREAK) {
	// Reached only where there IS a key and the run was skipped for another reason
	// -- no display, which is already a red above. Kept so that no path out of this
	// file can report a pass without the run having happened.
	console.log('The door is proved; the run behind it was not run. Exit 2 is not a pass.');
	process.exit(2);
}
