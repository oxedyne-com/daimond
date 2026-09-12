// verify_runner_launcher.mjs — dev/runner-chrome.sh, driven rather than read.
//
// The launcher is the half of the runner that lives outside the browser: a
// dedicated Chrome profile with every throttle Chrome offers a switch for turned
// off. It is never RUN here (it would open a window and sit there); it is driven
// through its two side-effect-free paths -- `--dry-run`, which prints the command
// it would run, and `--install`, which writes a systemd unit into a HOME this
// file hands it.
//
// What is locked down:
//   a. `bash -n` is clean.
//   b. the dry run names a real browser binary and EVERY flag the throttles need;
//   c. `--remote-debugging-port` appears only when asked for;
//   d. `--url` and `--profile` reach the command;
//   e. `--install` writes daimond-runner.service with Restart=always, the
//      graphical-session install target, an ABSOLUTE ExecStart, and NO cap slice
//      -- a runner killed to make room for a build is not a runner;
//   f. the note about Memory Saver and a minimised window is printed, because
//      those are the two things no flag can do;
//   g. an unknown argument is refused rather than passed to Chrome.
//
//   node dev/verify_runner_launcher.mjs
//
// No server, no browser, no gateway.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SH   = path.join(HERE, 'runner-chrome.sh');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	// The detail is for a FAILURE. Printed on a pass it buries the run in the output
	// of everything that went right.
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (!pass && detail ? ' — ' + detail : ''));
};

const run = (args, env) => {
	try {
		return { out: execFileSync('bash', [SH, ...args],
			{ encoding: 'utf8', env: { ...process.env, ...(env || {}) } }), code: 0 };
	} catch (e) {
		return { out: (e.stdout || '') + (e.stderr || ''), code: e.status == null ? -1 : e.status };
	}
};

// ── a. the script parses ────────────────────────────────────────────────
{
	let clean = true, why = '';
	try { execFileSync('bash', ['-n', SH], { encoding: 'utf8' }); }
	catch (e) { clean = false; why = String(e.stderr || e.message).slice(0, 200); }
	check('bash -n is clean', clean, why);
	check('the script is executable', (fs.statSync(SH).mode & 0o111) !== 0);
}

// ── b, c, d. the command it would run ───────────────────────────────────
const FLAGS = [
	'--disable-background-timer-throttling',
	'--disable-backgrounding-occluded-windows',
	'--disable-renderer-backgrounding',
	'--disable-ipc-flooding-protection',
	'--no-first-run',
];
const FEATURES = ['IntensiveWakeUpThrottling', 'CalculateNativeWinOcclusion',
	'HighEfficiencyModeAvailable'];
{
	const r = run(['--dry-run']);
	check('the dry run succeeds', r.code === 0, r.out.slice(0, 200));
	check('it prints one command and does not start a browser',
		r.out.trim().split('\n').length === 1);
	check('it names a browser binary', /chrom(e|ium)/i.test(r.out));
	for (const f of FLAGS) check('the dry run carries ' + f, r.out.includes(f));
	for (const f of FEATURES) check('the disabled features include ' + f, r.out.includes(f));
	check('it opens the app in app mode, not a tab', /--app=/.test(r.out));
	check('it uses a profile of its own', /--user-data-dir=/.test(r.out));
	check('the default profile is not the daily browser\'s',
		/google-chrome-daimond-runner/.test(r.out));
	check('no remote debugging port unless asked for', !/--remote-debugging-port/.test(r.out));
}
{
	const r = run(['--dry-run', '--debug-port', '9333']);
	check('--debug-port reaches the command', r.out.includes('--remote-debugging-port=9333'));
	const e = run(['--dry-run'], { DAIMOND_RUNNER_DEBUG: '9444' });
	check('so does DAIMOND_RUNNER_DEBUG', e.out.includes('--remote-debugging-port=9444'));
}
{
	const r = run(['--dry-run', '--url', 'https://example.test/app', '--profile', '/tmp/p-x']);
	check('--url reaches the command', r.out.includes('--app=https://example.test/app'));
	check('--profile reaches the command', r.out.includes('--user-data-dir=/tmp/p-x'));
}

// ── g. a wrong argument stops, rather than reaching Chrome ──────────────
{
	const r = run(['--definitely-not-a-flag']);
	check('an unknown argument is refused', r.code === 2, 'exit ' + r.code);
	check('and it says which one', /definitely-not-a-flag/.test(r.out));
}

// ── e, f. the systemd unit ──────────────────────────────────────────────
{
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daimond-runner-home-'));
	const r = run(['--install'], { HOME: home });
	check('--install succeeds', r.code === 0, r.out.slice(0, 200));
	const unit = path.join(home, '.config/systemd/user/daimond-runner.service');
	check('it writes daimond-runner.service', fs.existsSync(unit));
	const u = fs.existsSync(unit) ? fs.readFileSync(unit, 'utf8') : '';
	check('the unit restarts always', /^Restart=always$/m.test(u));
	check('it is wanted by the graphical session', /^WantedBy=graphical-session\.target$/m.test(u));
	check('ExecStart is an absolute path to this script',
		new RegExp('^ExecStart=/.*runner-chrome\\.sh$', 'm').test(u), u.match(/^ExecStart=.*$/m));
	// The whole point of the note in the script: a runner killed to make room for a
	// build is not a runner.
	check('the unit is in NO cap slice', !/^Slice=/m.test(u));
	check('and carries no MemoryMax directive', !/^MemoryMax=/m.test(u));
	check('the url and profile are carried as environment',
		/^Environment=DAIMOND_RUNNER_URL=/m.test(u) && /^Environment=DAIMOND_RUNNER_PROFILE=/m.test(u));
	check('it points at the guide page', /guide\/runner\.html/.test(u));
	check('the output tells the user to reload and enable it',
		/daemon-reload/.test(r.out) && /enable --now/.test(r.out));
	check('it says Memory Saver must be off', /Memory Saver/i.test(r.out));
	check('it says the window must not be minimised', /minimised/i.test(r.out));
	check('and that the runner has to be signed in', /signed in/i.test(r.out));
	fs.rmSync(home, { recursive: true, force: true });
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { bad.forEach((b) => console.log('  failed: ' + b)); process.exit(1); }
console.log('all runner launcher checks passed');
