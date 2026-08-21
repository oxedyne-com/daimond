// verify_verifyverb.mjs — the `verify` verb, against the real hand binary.
//
// The verb exists because a daimon cannot produce browser evidence: `listen()` is
// refused by the hand's seccomp filter, a browser needs the display server's unix
// socket and the filter takes that away, so every `dev/verify_*.mjs` that drives a
// real page dies under the fence a command gets. What replaces the fence here is
// PROVENANCE: the verb takes a NAME, looks it up in the granted tree, and builds
// the command itself, so nothing the model wrote reaches a process.
//
// ── What this drives, and what it does not ──────────────────────────
//
// The real `daimond-hand` binary, spawned as a process, spoken to over Chrome's
// native messaging framing — a 4-byte native-endian length prefix and UTF-8 JSON.
// No browser and no extension: `ext/hand.js` is a second line that refuses a
// message type it does not know, and it is not what decides any of the properties
// below. The hand is.
//
// The verifiers it runs are FIXTURES this file writes into a scratch git
// repository, never the real ones — the real suite takes hours and half of it
// wants a browser. What is being measured is the verb, not the suite.
//
// ── THE ONE PROPERTY THIS FILE EXISTS FOR ───────────────────────────
//
// A verb that runs a verifier clean and reports "27 checks passed" is exactly the
// evidence that has been lying. So the fixture repository contains a DELIBERATELY
// DEAD BREAK: `verify_fixdead.mjs` declares `--break dead` and its `dead` mode
// does nothing whatsoever. A run of that verifier must come back saying, in its
// own trailer, that one break proved nothing — and must name it. That is check 7,
// and it is the whole feature.
//
//   node dev/verify_verifyverb.mjs                     the checks
//   node dev/verify_verifyverb.mjs --break realname    3 fails: a real name is sent where a bad one is expected
//   node dev/verify_verifyverb.mjs --break declaredbreak  5 fails: a declared break is sent where an invented one is expected
//   node dev/verify_verifyverb.mjs --break proveclean  6 fails: every break is run where clean_only is expected
//   node dev/verify_verifyverb.mjs --break liveinstrument 7 fails: the dead break is made to bite
//   node dev/verify_verifyverb.mjs --break silentdead  8 fails: the dead break prints an extra line
//   node dev/verify_verifyverb.mjs --break noshot      9 fails: the fixture writes no picture
//   node dev/verify_verifyverb.mjs --break tracked     10 fails: the untracked fixture is added to git
//   node dev/verify_verifyverb.mjs --break untrack     10b fails: the tracked fixture is taken out of git
//   node dev/verify_verifyverb.mjs --break nodev       1 fails: the dev directory is out of the way at the handshake
//   node dev/verify_verifyverb.mjs --break deadlive    7d fails: the control verifier's second break is made dead
//   node dev/verify_verifyverb.mjs --break ghost       12 fails: the fixture leaves no trace on disk
//   node dev/verify_verifyverb.mjs --break wrongjournal 14 fails: the journal is read from an empty directory
//
// Each break damages ONE thing and reddens the check named beside it. TWO checks
// have no break, and it is worth saying which rather than leaving a reader to
// count. Check 11 -- that the report says it ran outside the command fence -- is a
// constant in `hand/src/verify.rs` and nothing out here can reach it. Check 1a --
// that the binary being driven is this source and not an older build -- has been
// demonstrated by hand (`DAIMOND_HAND_BIN=hand/target/release/daimond-hand` turns
// eighteen checks red against a binary from three days before the verb existed)
// and is deliberately NOT a break mode: a break that aborts the run leaves every
// later check missing rather than failing, which is the shape of instrument this
// whole file exists to warn about.
//
// The hand binary: `DAIMOND_HAND_BIN` if set, else the first of
// `hand/target/{release,debug}` or this slot's cache that is NEWER than `hand/src`,
// else built. A stale binary is refused rather than driven -- see `newestSource`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Derived, never written down: gate.sh runs the suite inside a git worktree at a
// different path, and an absolute path here would measure the main tree.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

const BI    = process.argv.indexOf('--break');
const BEQ   = process.argv.find(a => a.startsWith('--break='));
const BREAK = BEQ ? BEQ.split('=')[1] : (BI >= 0 ? (process.argv[BI + 1] || '') : '');
const KNOWN = ['nodev', 'realname', 'declaredbreak', 'proveclean', 'liveinstrument', 'deadlive',
	'silentdead', 'noshot', 'ghost', 'tracked', 'untrack', 'wrongjournal'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error(`unknown break '${BREAK}'; known: ${KNOWN.join(', ')}`);
	process.exit(2);
}
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const note = (line) => console.log('  ..   ' + line);

// ── The scratch tree ────────────────────────────────────────────────
//
// Under the home cache and never /tmp: that is a tmpfs here, its pages are charged
// to whoever wrote them, and filling it has taken this machine down before.
const BASE    = path.join(os.homedir(), '.cache/daimond/lane-verifyverb/run');
const GRANT   = path.join(BASE, 'grant');          // what the hand is granted
const JOURNAL = path.join(BASE, 'journal');        // OUTSIDE the grant, as the hand requires
const DEV     = path.join(GRANT, 'dev');

fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(DEV, { recursive: true });

// A nonce this run generated a moment ago. A fixture that prints it cannot have
// been stood in for: nothing but a process that read this file could know it.
const NONCE = 'n' + Math.random().toString(36).slice(2) + Date.now().toString(36);
fs.writeFileSync(path.join(DEV, 'nonce.txt'), NONCE + '\n');

/// The line every fixture prints its checks with, copied from the real ones.
const HELPER = `const say = (n, pass, detail) => console.log((pass ? '  ok   ' : '  FAIL ') + n + (detail ? ' \\u2014 ' + detail : ''));
const bi = process.argv.indexOf('--break');
const BRK = bi >= 0 ? (process.argv[bi + 1] || '') : '';
`;

// A fixture whose breaks BOTH BITE. The control: it is what proves that the verb
// can tell a live instrument from a dead one, and that check 7 is not simply
// reporting "dead" about everything.
fs.writeFileSync(path.join(DEV, 'verify_fixlive.mjs'), `// A fixture. Not a check of anything.
//   node dev/verify_fixlive.mjs --break bites   # 'the nonce is read' goes red
//   node dev/verify_fixlive.mjs --break second  # 'the second check' goes red
import fs from 'node:fs';
${HELPER}const nonce = fs.readFileSync('dev/nonce.txt', 'utf8').trim();
say('the fixture ran', true);
say('the nonce is read', BRK !== 'bites', BRK === 'bites' ? 'not read' : nonce);
${BREAK === 'deadlive' ? "say('the second check', true);" : "say('the second check', BRK !== 'second');"}
`);

// **THE POINT OF THE FILE.** `dead` is declared and does nothing at all, so its
// run is byte-for-byte the clean run's. An instrument that cannot fail.
const deadBody = BREAK === 'liveinstrument'
	? `say('the second check', BRK !== 'dead');`              // now it bites, so nothing is dead
	: (BREAK === 'silentdead'
		? `if (BRK === 'dead') console.log('a line the clean run does not print');\nsay('the second check', true);`
		: `say('the second check', true);`);
const shotBody = BREAK === 'noshot'
	? ''
	: `fs.mkdirSync('dev/shots', { recursive: true });\nfs.writeFileSync('dev/shots/fixture.png', nonce);`;
fs.writeFileSync(path.join(DEV, 'verify_fixdead.mjs'), `// A fixture with a DELIBERATELY DEAD BREAK. Not a check of anything.
//   node dev/verify_fixdead.mjs --break bites  # 'the nonce is read' goes red
//   node dev/verify_fixdead.mjs --break dead   # does nothing at all, on purpose
import fs from 'node:fs';
${HELPER}const nonce = fs.readFileSync('dev/nonce.txt', 'utf8').trim();
say('the fixture ran', true);
say('the nonce is read', BRK !== 'bites', BRK === 'bites' ? 'not read' : nonce);
${deadBody}
${BREAK === 'ghost' ? '' : "fs.writeFileSync('dev/ran-' + (BRK || 'clean') + '.txt', nonce);"}
${shotBody}
`);

// Present in the tree and NOT in git, which is the case that once let four
// verifiers be promoted into dev/ and never run by a gate that builds its tree
// with `git worktree add`.
fs.writeFileSync(path.join(DEV, 'verify_fixloose.mjs'), `// A fixture that is not tracked.
import fs from 'node:fs';
${HELPER}say('the loose fixture ran', true);
`);

const git = (...args) => spawnSync('git', ['-C', GRANT, ...args],
	{ stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
git('init', '-q');
git('config', 'user.email', 'fixture@example.invalid');
git('config', 'user.name', 'Fixture');
git('add', 'dev/verify_fixlive.mjs', 'dev/verify_fixdead.mjs', 'dev/nonce.txt');
if (BREAK === 'tracked') git('add', 'dev/verify_fixloose.mjs');
git('commit', '-q', '-m', 'fixtures');
if (BREAK === 'untrack') git('rm', '-q', '--cached', 'dev/verify_fixlive.mjs');

// ── The hand ────────────────────────────────────────────────────────

/// When the newest of the hand's own sources was last changed.
///
/// **The staleness guard, and it is not decoration.** `hand/target/release/daimond-hand`
/// on this machine was three days older than the verb, and a stale binary answers
/// `verify` with "there is no request called verify" — which every check below would
/// have read as a refusal and half of them would have PASSED on. A test that measures
/// the wrong binary proves nothing in either direction, and it fails silently towards
/// green, which is the worst way for it to fail.
function newestSource() {
	let newest = 0;
	const look = (dir) => {
		let names = [];
		try { names = fs.readdirSync(dir); } catch (e) { return; }
		for (const n of names) {
			const f = path.join(dir, n);
			let st;
			try { st = fs.statSync(f); } catch (e) { continue; }
			if (st.isDirectory()) look(f);
			else if (/\.(rs|toml)$/.test(n)) newest = Math.max(newest, st.mtimeMs);
		}
	};
	look(path.join(ROOT, 'hand/src'));
	try { newest = Math.max(newest, fs.statSync(path.join(ROOT, 'hand/Cargo.toml')).mtimeMs); }
	catch (e) { /* no manifest, and the build below will say so */ }
	return newest;
}

/// The hand binary to drive, built if the ones lying about are older than the source.
///
/// **The ambient CARGO_TARGET_DIR is deliberately NOT used.** The hand is its own
/// workspace root; building it into a target directory the app is also built into
/// puts two differently resolved copies of one crate in the same place, and the
/// binary then links a mix. The tell is rustc's "multiple different versions of
/// crate X" while `cargo tree -d` shows one. So the hand gets a directory of its
/// own, named for it, and `DAIMOND_HAND_BIN` skips the question entirely.
function handBinary() {
	if (process.env.DAIMOND_HAND_BIN) return { bin: process.env.DAIMOND_HAND_BIN, fresh: true, why: 'named by DAIMOND_HAND_BIN' };
	const src    = newestSource();
	const target = process.env.DAIMOND_HAND_TARGET_DIR
		|| path.join(os.homedir(), '.cache/cargo-targets', process.env.RC_SLOT || 'solo', 'daimond-hand');
	// What `hand/install/README.md` names and what verify_handreal.mjs builds, reused
	// where it is already there AND newer than the source.
	const seen = [];
	for (const c of [
		path.join(ROOT, 'hand/target/release/daimond-hand'),
		path.join(ROOT, 'hand/target/debug/daimond-hand'),
		path.join(target, 'debug', 'daimond-hand'),
	]) {
		let st;
		try { st = fs.statSync(c); } catch (e) { continue; }
		if (st.mtimeMs >= src) return { bin: c, fresh: true, why: 'newer than hand/src' };
		seen.push(`${c} is ${Math.round((src - st.mtimeMs) / 1000)}s older than hand/src`);
	}
	note('the hand binaries here are older than its source; building into ' + target);
	const r = spawnSync('cargo', ['build', '--manifest-path', path.join(ROOT, 'hand/Cargo.toml')],
		{ cwd: ROOT, stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: target } });
	const built = path.join(target, 'debug', 'daimond-hand');
	if (r.status !== 0 || !fs.existsSync(built)) {
		return { bin: null, fresh: false, why: seen.join('; ') || 'the hand did not build' };
	}
	return { bin: built, fresh: true, why: 'built here' };
}

const { bin: HAND, fresh: FRESH, why: WHY } = handBinary();
check('1a the hand binary is there, and is this source rather than an older one',
	!!HAND && fs.existsSync(HAND) && FRESH, `${HAND || 'none'} — ${WHY}`);
if (!HAND || !fs.existsSync(HAND) || !FRESH) {
	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	process.exit(1);
}

const LE = os.endianness() === 'LE';

/// One conversation with a fresh hand process.
///
/// A process per exchange, which is what Chrome does: it starts a host for each
/// port and kills it when the port closes. It also means one request cannot leave
/// state behind for the next, so a check that passed because of an earlier one is
/// not a failure mode this file has.
function talk(messages, ms = 60000) {
	return new Promise((resolve) => {
		const child = spawn(HAND, [], {
			cwd: BASE,
			env: {
				...process.env,
				DAIMOND_HAND_ROOT: GRANT,
				DAIMOND_HAND_JOURNAL_DIR: JOURNAL,
			},
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const got = [];
		let buf = Buffer.alloc(0);
		let err = '';
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
			resolve({ msgs: got, stderr: err });
		};
		const timer = setTimeout(finish, ms);
		child.stderr.on('data', (d) => { err += d.toString(); });
		child.stdout.on('data', (d) => {
			buf = Buffer.concat([buf, d]);
			for (;;) {
				if (buf.length < 4) return;
				const n = LE ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
				if (buf.length < 4 + n) return;
				const body = buf.subarray(4, 4 + n).toString('utf8');
				buf = buf.subarray(4 + n);
				try { got.push(JSON.parse(body)); } catch (e) { got.push({ t: '__unparseable', body }); }
				// `ended` and `refused` are the two ways an answer finishes.
				const last = got[got.length - 1];
				// `error` is terminal here as well as `ended` and `refused`: a hand that does
				// not know the message answers with one and never with an ending, and waiting
				// for an ending that is not coming is a test that hangs rather than fails.
				if (last && (last.t === 'ended' || last.t === 'refused' || last.t === 'error')) {
					// Give the writer a moment to flush anything queued behind it.
					setTimeout(finish, 150);
				}
			}
		});
		child.on('error', finish);
		child.on('exit', () => setTimeout(finish, 50));
		for (const m of messages) {
			const body = Buffer.from(JSON.stringify(m), 'utf8');
			const head = Buffer.alloc(4);
			if (LE) head.writeUInt32LE(body.length, 0); else head.writeUInt32BE(body.length, 0);
			child.stdin.write(Buffer.concat([head, body]));
		}
	});
}

const HELLO = { t: 'hello', proto: 1, client: 'verify_verifyverb' };

/// One verify request, and everything the hand said about it.
async function verify(req, ms) {
	const r = await talk([HELLO, { t: 'verify', id: 'v1', timeout_ms: 60000, break: null, ...req }], ms);
	const hello   = r.msgs.find(m => m.t === 'hello');
	const refused = r.msgs.find(m => m.t === 'refused');
	const ended   = r.msgs.find(m => m.t === 'ended');
	const out     = r.msgs.filter(m => m.t === 'chunk' && m.stream === 'out').map(m => m.data).join('');
	const progress = r.msgs.filter(m => m.t === 'chunk' && m.stream === 'err').map(m => m.data).join('');
	return { hello, refused, ended, out, progress, stderr: r.stderr, msgs: r.msgs };
}

/// The trailer line, which is where all three numbers live.
const trailerOf = (out) =>
	(out.split('\n').reverse().find(l => l.trim().startsWith('[verify:')) || '').trim();

// ── 1. The handshake says whether this folder has verifiers ─────────
//
// No caller break: the capability is computed in the hand from the directory, and
// there is nothing out here that can make it lie.

{
	// Surgical: the directory goes back before anything else asks about it, so this
	// break reddens check 1 and nothing else.
	const aside = path.join(GRANT, 'dev-aside');
	if (BREAK === 'nodev') fs.renameSync(DEV, aside);
	const r = await talk([HELLO, { t: 'bye' }]);
	if (BREAK === 'nodev') fs.renameSync(aside, DEV);
	const caps = (r.msgs.find(m => m.t === 'hello') || {}).caps || [];
	check('1 the handshake says this folder has verifiers', caps.includes('verify:dev'),
		JSON.stringify(caps));
}

// ── 2, 3, 4. A name is a selector, and nothing else ─────────────────

{
	const r = await verify({ name: BREAK === 'realname' ? 'fixlive' : 'nosuchthing', breaks: 'none' });
	check('2 a name that is not a verifier is refused',
		!!r.refused && /Refused:/.test(r.refused.reason || ''),
		r.refused ? r.refused.reason.slice(0, 110) : `no refusal; ended=${JSON.stringify(r.ended)}`);
	check('3 the refusal says nothing was run',
		!!r.refused && /Nothing was run/.test(r.refused.reason || ''),
		r.refused ? r.refused.reason.slice(0, 110) : 'no refusal');
}

{
	// A path, which is the shape a model reaches for first. Refused on its
	// alphabet, before the directory is read at all.
	const r = await verify({ name: BREAK === 'realname' ? 'fixlive' : 'dev/verify_fixlive.mjs', breaks: 'none' });
	check('4 a path is refused as a name',
		!!r.refused && /not a verifier name|does not know the message/.test(r.refused.reason || ''),
		r.refused ? r.refused.reason.slice(0, 110) : 'no refusal');
}

// ── 5. A break must be one the verifier itself declares ─────────────

{
	const r = await verify({
		name: 'fixdead',
		breaks: 'one',
		break: BREAK === 'declaredbreak' ? 'bites' : 'inventedbreak',
	});
	const why = r.refused ? r.refused.reason : '';
	check('5 a break the verifier does not declare is refused',
		!!r.refused && /does not declare a break/.test(why),
		r.refused ? why.slice(0, 120) : `no refusal; trailer=${trailerOf(r.out)}`);
	check('5b the refusal lists the breaks it does declare',
		/\bbites\b/.test(why) && /\bdead\b/.test(why),
		why.slice(0, 160) || 'no refusal');
}

// ── 6. A clean-only run is labelled, in the words a model repeats ───

{
	const r = await verify({ name: 'fixlive', breaks: BREAK === 'proveclean' ? 'all' : 'none' });
	const t = trailerOf(r.out);
	check('6 a clean-only run is labelled NOT PROVEN', /NOT PROVEN/.test(t), t || r.out.slice(0, 200));
	check('6b and says it is not evidence', /not evidence/i.test(r.out),
		t || r.out.slice(0, 200));
}

// ── 7. THE FEATURE: a dead break is counted and named ───────────────

{
	const r = await verify({ name: 'fixdead', breaks: 'all' }, 120000);
	const t = trailerOf(r.out);
	check('7 a break that reddens nothing is counted in the third number',
		/1 breaks proved nothing/.test(t), t || r.out.slice(0, 300));
	check('7b the live break beside it is counted red',
		/1 breaks confirmed red/.test(t), t || r.out.slice(0, 300));
	check('7c the dead break is named so the check it aims at can be disowned',
		/PROVED NOTHING/.test(r.out) && /^BREAK dead\b/m.test(r.out),
		(r.out.match(/^BREAK .*$/gm) || []).join(' | ').slice(0, 200));
	check('8 a dead break whose output is the clean run\'s is said to be exactly that',
		/its output was the clean run's/.test(r.out),
		(r.out.match(/^BREAK dead.*$/m) || ['(no dead line)'])[0].slice(0, 200));
	check('9 pictures the run wrote are named by path',
		/dev\/shots\/fixture\.png/.test(r.out),
		(r.out.match(/dev\/shots\/[^\s]*/g) || []).join(' ') || 'none named');
	check('11 the report says it ran outside the command fence',
		/OUTSIDE the command fence/.test(r.out), r.out.slice(0, 120));
	// A report is text and text can be fabricated. What cannot is a file on this
	// disk holding a nonce generated seconds ago: only a process that read
	// dev/nonce.txt could have written it, and there is one per run, so the
	// sequence really made three of them.
	const ran = ['clean', 'bites', 'dead']
		.map(w => path.join(DEV, `ran-${w}.txt`))
		.map(f => { try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { return ''; } });
	check('12 all three runs really happened, each leaving this run\'s nonce on disk',
		ran.length === 3 && ran.every(v => v === NONCE),
		`clean=${ran[0] === NONCE} bites=${ran[1] === NONCE} dead=${ran[2] === NONCE}`);
	// The exit status is the tri-state: 0 proved, 1 the code failed, 2 unproven.
	check('13 a sequence holding a dead break does not exit as proved',
		!!r.ended && r.ended.exit === 2,
		r.ended ? `exit ${r.ended.exit}` : 'no ending');
}

// ── 7d. The control: every break biting IS reported as proved ───────
//
// Without this, check 7 would pass just as well on a verb that called everything
// dead. Both halves are needed and only both together mean anything.

{
	const r = await verify({ name: 'fixlive', breaks: 'all' }, 120000);
	const t = trailerOf(r.out);
	check('7d a verifier whose breaks all bite is reported as proved',
		/2 breaks confirmed red/.test(t) && /0 breaks proved nothing/.test(t),
		t || r.out.slice(0, 300));
	check('13b and it exits as proved',
		!!r.ended && r.ended.exit === 0, r.ended ? `exit ${r.ended.exit}` : 'no ending');
}

// ── 10. Trackedness is asked of git, not assumed ────────────────────

{
	const r = await verify({ name: 'fixloose', breaks: 'none' });
	check('10 a verifier git does not know is reported as NOT TRACKED',
		/NOT TRACKED/.test(r.out), (r.out.split('\n')[0] || '').slice(0, 160));
}
{
	const r = await verify({ name: 'fixlive', breaks: 'none' });
	check('10b and a tracked one is not slandered',
		/tracked/.test(r.out) && !/NOT TRACKED/.test(r.out),
		(r.out.split('\n')[0] || '').slice(0, 160));
}

// ── 14. The journal holds the node command, not a verb ──────────────

{
	const where = BREAK === 'wrongjournal' ? path.join(BASE, 'empty') : JOURNAL;
	if (BREAK === 'wrongjournal') fs.mkdirSync(where, { recursive: true });
	const files = fs.existsSync(where)
		? fs.readdirSync(where).filter(f => f.endsWith('.jsonl') || f.includes('journal'))
		: [];
	const text = files.map(f => {
		try { return fs.readFileSync(path.join(where, f), 'utf8'); } catch (e) { return ''; }
	}).join('\n');
	check('14 the journal records the real node command line',
		/verify_fixdead\.mjs/.test(text) && /"?fence:none"?/.test(text),
		files.join(', ') || 'no journal files found');
}

// ── The summary ─────────────────────────────────────────────────────

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must.`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
	process.exit(bad.length ? 0 : 1);
}
process.exit(bad.length ? 1 : 0);
