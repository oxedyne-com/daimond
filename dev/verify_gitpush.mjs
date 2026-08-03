// Verify the push configuration against the real `git` binary.
//
// The Rust tests in `src/tools.rs` prove that Daimond builds the strings it means to build.  They
// cannot prove that git DOES anything with them, and every one of those strings is load-bearing:
// if `GIT_CONFIG_COUNT` were not read on this git, the push would go out unauthenticated; if
// `credential.helper=""` did not reset the list, a helper written into a repository's own config
// would still run with the credential in its environment; if `protocol.allow=never` did not close
// `ext::`, the remote's URL would be a command.
//
// So this asks git.  Nothing here reaches the network and no credential is used: the token is a
// literal `NOT-A-REAL-TOKEN`, the remotes are never contacted, and every check is answered by git
// reading its own configuration.
//
// Run: node dev/verify_gitpush.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WORK = join(homedir(), '.cache', 'daimond-verify', 'gitpush');
const HOST = 'github.com';
const TOKEN = 'NOT-A-REAL-TOKEN';                                  // allowlist secret
const USER = 'x-access-token';

/// The environment `PushCred::git_env` builds, restated here so a drift between the two shows up
/// as this verifier passing while the Rust test fails, or the reverse.
function pushEnv(root) {
	const base = `https://${HOST}/`;
	const cfg = [
		[`url.${base}.insteadOf`,    `git@${HOST}:`],
		[`url.${base}.insteadOf`,    `ssh://git@${HOST}/`],
		[`http.${base}.extraHeader`, `Authorization: Basic ${Buffer.from(`${USER}:${TOKEN}`).toString('base64')}`],
		['credential.helper',        ''],
		['protocol.allow',           'never'],
		['protocol.https.allow',     'always'],
		['core.hooksPath',           `${root}/.daimond/no-hooks`],
	];
	const env = { GIT_CONFIG_COUNT: String(cfg.length), GIT_TERMINAL_PROMPT: '0' };
	cfg.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
	return env;
}

let failed = 0;
function check(name, fn) {
	try {
		fn();
		console.log(`  ok    ${name}`);
	} catch (e) {
		failed += 1;
		console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').join('\n        ')}`);
	}
}

function git(args, opts = {}) {
	return execFileSync('git', args, {
		cwd: opts.cwd || WORK,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		// A clean slate: the verifier's own shell environment must not decide any of this.
		env: { PATH: process.env.PATH, HOME: WORK, ...(opts.env || {}) },
	}).trim();
}

function gitFails(args, opts = {}) {
	try {
		git(args, opts);
	} catch (e) {
		return `${e.stderr || ''}${e.stdout || ''}`;
	}
	throw new Error('the command succeeded, and it was supposed to be refused');
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
git(['init', '-q', '.']);
git(['remote', 'add', 'origin', `git@${HOST}:oxedyne-com/fe2o3.git`]);
const ENV = pushEnv(WORK);

console.log(`git ${git(['--version'])}\n`);

// GIT_CONFIG_COUNT is the whole channel. Git 2.31 introduced it; an older git would read none of
// this and push with no credential and no protocol restriction at all.
check('git reads configuration from the environment at all', () => {
	const listed = git(['config', '--list'], { env: ENV });
	if (!listed.includes('protocol.allow=never')) {
		throw new Error(`GIT_CONFIG_COUNT was not honoured -- this git is too old.\n${listed}`);
	}
});

// The user's remote is SSH and must be rewritten for the push. `--get-url` applies `insteadOf`
// and contacts nothing.
check('an SSH remote is rewritten to HTTPS for the push', () => {
	const url = git(['ls-remote', '--get-url', 'origin'], { env: ENV });
	if (url !== `https://${HOST}/oxedyne-com/fe2o3.git`) {
		throw new Error(`insteadOf did not rewrite the remote: ${url}`);
	}
});

check('the same rewrite covers the ssh:// spelling', () => {
	git(['remote', 'add', 'alt', `ssh://git@${HOST}/o/r.git`]);
	const url = git(['ls-remote', '--get-url', 'alt'], { env: ENV });
	git(['remote', 'remove', 'alt']);
	if (url !== `https://${HOST}/o/r.git`) {
		throw new Error(`the ssh:// spelling was not rewritten: ${url}`);
	}
});

// Untouched without the environment, which is what "nothing is written to .git/config" means.
check('nothing is written to the repository: the remote is unchanged without the environment', () => {
	const url = git(['ls-remote', '--get-url', 'origin']);
	if (url !== `git@${HOST}:oxedyne-com/fe2o3.git`) {
		throw new Error(`the repository's own configuration was changed: ${url}`);
	}
	const listed = git(['config', '--list', '--local']);
	if (/extraheader|credential|protocol\.allow|hookspath/i.test(listed)) {
		throw new Error(`push configuration was persisted to disc:\n${listed}`);
	}
});

// The credential is scoped to one host. This is the check that matters most: `.git/config` is a
// file the model can WRITE, so `remote.origin.pushurl` can name a host of its own choosing, and an
// unscoped `http.extraHeader` would follow it there.
check('the credential is scoped to one host and does not follow a redirected push', () => {
	const mine = git(['config', '--get-urlmatch', 'http', `https://${HOST}/o/r`], { env: ENV });
	if (!mine.includes('Authorization: Basic')) {
		throw new Error(`the header does not apply to its own host:\n${mine}`);
	}
	let theirs = '';
	try {
		theirs = git(['config', '--get-urlmatch', 'http', 'https://evil.test/o/r'], { env: ENV });
	} catch (e) {
		theirs = ''; // no match at all, which is the right answer
	}
	if (theirs.includes('Authorization')) {
		throw new Error(`the credential would be sent to another host:\n${theirs}`);
	}
});

// A helper in the repository's own config would run with the credential in its environment. An
// empty value resets the list, and the environment is read last, so it clears what came before.
//
// Asked by RUNNING the credential machinery and not by listing the configuration: `git config
// --get-all credential.helper` prints the raw values in file order and knows nothing about the
// reset, so it reports the helper as present whether or not git would ever call it. That reading
// is what this check first made, and it was wrong in the safe direction only by luck.
check('a credential helper written into the repository is cleared, not run', () => {
	const ask = ['credential', 'fill'];
	const stdin = 'protocol=https\nhost=example.invalid\n\n';
	git(['config', '--local', 'credential.helper', '!f() { echo username=stolen; echo password=stolen; }; f']);
	// The control: without the environment the helper IS called, so a check that saw nothing
	// would be seeing a helper that never ran rather than one that was reset.
	let control = '';
	try {
		control = execFileSync('git', ask, {
			cwd: WORK, input: stdin, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
			env: { PATH: process.env.PATH, HOME: WORK, GIT_TERMINAL_PROMPT: '0' },
		});
	} catch (e) {
		control = `${e.stdout || ''}${e.stderr || ''}`;
	}
	let withEnv = '';
	try {
		withEnv = execFileSync('git', ask, {
			cwd: WORK, input: stdin, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
			env: { PATH: process.env.PATH, HOME: WORK, ...ENV },
		});
	} catch (e) {
		withEnv = `${e.stdout || ''}${e.stderr || ''}`;
	}
	git(['config', '--local', '--unset-all', 'credential.helper']);
	if (!control.includes('stolen')) {
		throw new Error(`the control did not run the helper, so this check proves nothing:\n${control}`);
	}
	if (withEnv.includes('stolen')) {
		throw new Error(`a helper in the repository's own config still ran:\n${withEnv}`);
	}
});

// `ext::` runs a command named in the remote's URL, and the remote's URL is in a file the model
// can write. Nothing here contacts anything: the refusal happens before the transport starts.
check('the ext:: transport is closed, so a remote URL cannot be a command', () => {
	const err = gitFails(['ls-remote', 'ext::sh -c "echo pwned"'], { env: ENV });
	if (!/transport.*not allowed|protocol.*not supported|not allowed/i.test(err)) {
		throw new Error(`ext:: was not refused for the right reason:\n${err}`);
	}
	// And the one protocol a push needs is still allowed, which is what makes this a fence and
	// not an outage: `--get-url` on the rewritten HTTPS remote resolves without complaint.
	git(['ls-remote', '--get-url', 'origin'], { env: ENV });
});

// A fence nothing can go out through is not a fence but an outage, so the one protocol a push
// needs must still be open. Aimed at a port nothing listens on, so the answer distinguishes "the
// transport was refused" from "the transport ran and could not connect" without leaving the
// machine.
check('https is still open, so the push itself is not what got closed', () => {
	const err = gitFails(['ls-remote', 'https://127.0.0.1:1/x.git'], { env: ENV });
	if (/not allowed|not supported/i.test(err)) {
		throw new Error(`protocol.allow closed the one protocol a push needs:\n${err}`);
	}
	if (!/connect|refused|could not read|unable to access|port/i.test(err)) {
		throw new Error(`https failed for a reason that is not a connection failure:\n${err}`);
	}
});

check('the file:: transport is closed too', () => {
	const err = gitFails(['ls-remote', `file://${WORK}`], { env: ENV });
	if (!/not allowed|not supported/i.test(err)) {
		throw new Error(`file:: was not refused:\n${err}`);
	}
});

// A pre-push hook is a script in the repository, and it would run with the credential in its
// environment. The hooks path is pointed inside `.daimond`, which every fence denies.
check('hooks are pointed at the one directory every fence denies', () => {
	const p = git(['config', 'core.hooksPath'], { env: ENV });
	if (!p.endsWith('/.daimond/no-hooks')) {
		throw new Error(`hooks are not disabled for a push: ${p}`);
	}
	mkdirSync(join(WORK, '.git', 'hooks'), { recursive: true });
	writeFileSync(join(WORK, '.git', 'hooks', 'pre-push'), '#!/bin/sh\necho PWNED\nexit 1\n',
		{ mode: 0o755 });
	// git resolves the hook through core.hooksPath, so the repository's own is not found.
	const found = git(['rev-parse', '--git-path', 'hooks/pre-push'], { env: ENV });
	if (found.includes('.git/hooks/')) {
		throw new Error(`the repository's own hook is still the one git would run: ${found}`);
	}
});

// Without a terminal git would sit on a password prompt until the timeout rather than fail.
check('a failed authentication fails rather than waiting for a prompt', () => {
	if (ENV.GIT_TERMINAL_PROMPT !== '0') {
		throw new Error('GIT_TERMINAL_PROMPT is not disabled');
	}
});

// And the header itself, against the shell's own base64 rather than against the encoder that
// produced it.
check('the Authorization header is what base64 says it is', () => {
	const want = execFileSync('base64', { input: `${USER}:${TOKEN}`, encoding: 'utf8' }).trim();
	const got = git(['config', '--get-urlmatch', 'http', `https://${HOST}/o/r`], { env: ENV });
	if (!got.includes(want)) {
		throw new Error(`the header is not base64 of '${USER}:<token>':\n${got}`);
	}
});

rmSync(WORK, { recursive: true, force: true });
console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
