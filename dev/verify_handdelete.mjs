// verify_handdelete.mjs — the deletion fence, against the real hand binary, no browser.
//
// `daimond_hand_delete_fence_design_20260923.md`, step 8. The same device
// `dev/verify_verifyverb.mjs` uses: the real `daimond-hand` binary, spawned as a
// process, spoken to over Chrome's native messaging framing (a 4-byte native-endian
// length prefix and UTF-8 JSON). No browser, no extension, no mock LLM — `ext/hand.js`
// is a second line that never decides any of the four properties below; the hand does.
//
//   (a) a fence root, or a mark nested inside one, cannot be removed or moved
//   (b) `rm -rf` of more than 64 pre-existing files in one turn is HELD and asks
//   (c) what the meter takes lands in a hard-link trash and comes back whole
//   (d) a removal under the budget proceeds without being asked
//
// and, from the audit of 2026-09-23 (`daimond_hand_delete_fence_audit_20260923.md`):
//
//   (e) a page older than the meter sends no `meter` field, and is metered all the same (F7)
//   (f) a rename onto a file that was there before the turn counts it and keeps it (F3)
//   (g) a folder kept inside a toolchain cache is metered (F5)
//   (h) THE KNOWN HOLE, pinned: a file emptied in place is neither counted nor kept (F1,
//       Phase 2). It passes while the hole is there, so the day the meter learns `O_TRUNC`
//       this check fails and the copy that states the hole is looked at with it (F7)
//   (i) a held command nobody answers is stopped by the hand on its own (F7)
//   (j) a file the trash cannot link is copied only while small; a larger one is not
//       removed at all (F6). Needs a directory on a second filesystem for the trash
//   (k) the PAGE'S gate (F2): each hand is sent the fence `command_fence` composes from
//       that hand's own `hello`, exactly as the page sends it, meter field and all. A hand
//       that does not say `meter:deletes` must write, create, remove and rename NOTHING
//       under its granted root; a hand that does gets the fence it always had, and its
//       metered writes work. The fence the page sent BEFORE the gate is sent to the old
//       hand too, as the baseline the gate exists to close
//
// Run against TWO binaries: this branch's, and `../lane-bc-base`'s (pre-fence,
// 48aa5913). The branch must pass all four; the base binary has no `meter.rs` at
// all, so (a)'s nested-mark half, (b) and (c) are expected to FAIL there — that
// failure is itself the evidence, not a bug in this file. See "WHY NOT UNDER
// ~/.cache/daimond" below for the one place this file departs from its brief.
//
// ── WHY NOT UNDER ~/.cache/daimond ───────────────────────────────────
//
// The task that wrote this file named `~/.cache/daimond/$RC_SLOT/handdelete` as the
// fixture root. That path cannot be used: `meter_marks` (`hand/src/exec.rs:2166`)
// drops any `rw` root that starts with `~/.cache/daimond`, because that is
// `TOOLKIT_ROOTS`' `node` cache tail (`exec.rs:3063`) and the meter is never
// attached to a toolkit cache — `metered = ... && !marks.is_empty()` (`exec.rs:569`)
// goes false for every case in this file if the fixture lives there, so `rm -rf`
// would run unmetered on BOTH binaries and every one of (a)-(c) would read as a
// false pass. `hand/tests/delete_fence.rs` hit the same wall and moved its
// fixtures to `~/.cache/daimond-hand-delete-fence` — a SIBLING of `~/.cache/daimond`,
// not a child of it. This file does the same, scoped to the slot AND the run so no
// two runs collide: `~/.cache/daimond-handdelete/$RC_SLOT/run-<run>`. Slot-scoped alone
// was not enough: two runs sharing a slot wiped each other's fixtures mid-run on
// 2026-09-24. Still not `/tmp`, still never under `~/usr`.
//
// ── Running it ────────────────────────────────────────────────────────
//
//	node dev/verify_handdelete.mjs
//	  --no-build   skip the cargo build and use whatever is already on disk
//	  --keep       leave the scratch tree behind for inspection
//
// The build is NOT done here (see the header of `dev/verify_verifyverb.mjs` for
// why an ambient CARGO_TARGET_DIR is wrong for the hand's own workspace); it is
// the caller's job, with the fleet's own `rc-build`, under the slot's build lock:
//
//	flock ~/.cache/cargo-targets/$RC_SLOT/.build.lock ~/usr/code/bash/rc-build 4G -- bash -c \
//	  'CARGO_BUILD_JOBS=4 CARGO_TARGET_DIR=~/.cache/cargo-targets/$RC_SLOT/lane-hand \
//	   cargo build --release --manifest-path hand/Cargo.toml'
//
// and, for the base comparison, the same command with `../lane-bc-base` as the
// working directory and `lane-bc-base` as the target dir. Both are RELEASE builds of
// the hand's own workspace; the app's native tests build DEBUG, so a slot's target
// directory never holds two workspace roots' artefacts in one profile (CLAUDE.md,
// "shared target dir lies").
//
//	HD_BRANCH_BIN=<path>   drive that binary as the branch side instead — an older
//	                       build of this branch, to show a check failing before its fix
//	HD_BASE_BIN=<path>     drive that binary as the base side, rather than building
//	                       `../lane-bc-base`, or, with no such sibling, the one already built
//	                       in the slot's `lane-bc-base` target. Found by none of the three, the
//	                       run FAILS rather than skipping the base
//	HD_OLD_BINS=<a:b:...>  more hands older than the meter, driven through (k) only; default
//	                       the hand this machine actually has installed
//	                       (~/.local/share/daimond/hand/bin/daimond-hand). With the base, that is
//	                       both old hands, and a named one that is not there FAILS the run: on
//	                       2026-09-24 a run without them read 58/0 where they read 66/0
//	HD_XDEV_DIR=<path>     where (j) keeps its trash; it must be on a different filesystem
//	                       from the fixtures. Default /dev/shm/daimond-handdelete-$RC_SLOT-<run>
//
// (k) composes its fences with the page's own function, built as a native example into the
// slot's `lane-hand` target (DEBUG, the app's own profile):
//
//	cargo build --offline --example command_fence
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const BASE_ROOT = path.join(ROOT, '..', 'lane-bc-base');
// Seconds a held command waits for an answer before the hand stops it: `meter::HOLD_MS`.
const HOLD_MS = 120000;
// The largest file the trash keeps by copying: `meter::COPY_MAX`.
const COPY_MAX = 512 * 1024;

const argv = process.argv.slice(2);
const NO_BUILD = argv.includes('--no-build');
const KEEP = argv.includes('--keep');

const SLOT = process.env.RC_SLOT || 'solo';
const RUN = process.pid.toString(36) + '-' + Date.now().toString(36);
// A SIBLING of ~/.cache/daimond, never a child of it — see the header.
const SCRATCH = path.join(os.homedir(), '.cache/daimond-handdelete', SLOT, 'run-' + RUN);
// (j)'s trash, on another filesystem so the hard link fails and the copy is what is tried.
const XDEV = process.env.HD_XDEV_DIR || path.join('/dev/shm', `daimond-handdelete-${SLOT}-${RUN}`);
// The hand this machine actually has installed, which predates the meter.
const INSTALLED = path.join(os.homedir(), '.local/share/daimond/hand/bin/daimond-hand');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const note = (s) => console.log('  ·    ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The hand binary, one per side ────────────────────────────────────

const LE = os.endianness() === 'LE';

function newestSource(root) {
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
	look(path.join(root, 'hand/src'));
	try { newest = Math.max(newest, fs.statSync(path.join(root, 'hand/Cargo.toml')).mtimeMs); }
	catch (e) { /* no manifest */ }
	return newest;
}

/// The binary for one worktree, built with the fleet's capped `rc-build` if it is
/// missing or stale. Never built here when `--no-build` is passed — the caller is
/// trusted to have run it, and the staleness check still runs either way, so a
/// stale binary is refused rather than silently measured.
function handBinary(root, targetName) {
	const src = newestSource(root);
	const target = path.join(os.homedir(), '.cache/cargo-targets', SLOT, targetName);
	const rel = path.join(target, 'release/daimond-hand');
	let st;
	try { st = fs.statSync(rel); } catch (e) { st = null; }
	if (st && st.mtimeMs >= src) return { bin: rel, why: 'newer than hand/src' };
	if (NO_BUILD) return { bin: st ? rel : null, why: st
		? `${Math.round((src - st.mtimeMs) / 1000)}s older than hand/src, but --no-build was passed`
		: 'not built, and --no-build was passed' };
	note(`building ${targetName} with rc-build (this can take a while)`);
	const lock = path.join(os.homedir(), '.cache/cargo-targets', SLOT, '.build.lock');
	const r = spawnSync('bash', ['-lc',
		`flock ${lock} ~/usr/code/bash/rc-build 4G -- bash -c ` +
		`'CARGO_BUILD_JOBS=4 CARGO_TARGET_DIR=${target} cargo build --release --manifest-path hand/Cargo.toml'`],
		{ cwd: root, stdio: 'inherit' });
	if (r.status !== 0 || !fs.existsSync(rel)) return { bin: null, why: 'the hand did not build' };
	return { bin: rel, why: 'built here' };
}

// ── The wire ──────────────────────────────────────────────────────────

/// One conversation with one hand process: `Hello`, then whatever `Req`s the
/// caller sends, over the real framing. A test answers a `held` the moment it
/// is seen — the exact shape a page has to cope with, since the command is
/// genuinely blocked in the kernel until it is answered.
///
/// `until` is a CURSOR over the stream, not a scan of everything ever seen.
/// The first cut of this file matched `pred` against the whole history on
/// every call, so a message already consumed — the `Resp::Error` note the
/// meter sends alongside a root refusal, in particular — matched again on the
/// next call, resolved instantly, and the caller's loop spun synchronously
/// forever: measured at 3.7 GB RSS with no cap, in well under three minutes.
/// Each call here takes the index it left off at and returns the one after
/// its match, so nothing already handled can be handed back a second time.
function session(bin, env) {
	const child = spawn(bin, [], { cwd: SCRATCH, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
	let buf = Buffer.alloc(0);
	let stderr = '';
	const msgs = [];
	const waiters = [];	// { pred, after, resolve(index) }
	child.stderr.on('data', (d) => { stderr += d.toString(); });
	child.stdout.on('data', (d) => {
		buf = Buffer.concat([buf, d]);
		for (;;) {
			if (buf.length < 4) return;
			const n = LE ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
			if (buf.length < 4 + n) return;
			const body = buf.subarray(4, 4 + n).toString('utf8');
			buf = buf.subarray(4 + n);
			let m;
			try { m = JSON.parse(body); } catch (e) { m = { t: '__unparseable', body }; }
			if (process.env.HD_DEBUG) console.error('[wire]', m.t, m.id || '', m.stream || '', m.counted !== undefined ? `counted=${m.counted}` : '', m.t === 'chunk' ? JSON.stringify(m.data).slice(0, 80) : '');
			const index = msgs.push(m) - 1;
			for (let i = waiters.length - 1; i >= 0; i--) {
				const w = waiters[i];
				if (index >= w.after && w.pred(m)) { w.resolve(index); waiters.splice(i, 1); }
			}
		}
	});
	const send = (m) => {
		const body = Buffer.from(JSON.stringify(m), 'utf8');
		const head = Buffer.alloc(4);
		if (LE) head.writeUInt32LE(body.length, 0); else head.writeUInt32BE(body.length, 0);
		child.stdin.write(Buffer.concat([head, body]));
	};
	/// Waits for the next message at or after index `after` matching `pred`,
	/// among what has already arrived or what arrives next, and returns
	/// `{ msg, index }` — `index + 1` is the `after` the NEXT call must use.
	const until = (pred, ms = 30000, after = 0) => new Promise((resolve, reject) => {
		for (let i = after; i < msgs.length; i++) {
			if (pred(msgs[i])) { resolve({ msg: msgs[i], index: i }); return; }
		}
		const w = { pred, after, resolve: (i) => { clearTimeout(timer); resolve({ msg: msgs[i], index: i }); } };
		waiters.push(w);
		const timer = setTimeout(() => {
			const i = waiters.indexOf(w);
			if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timed out waiting from index ${after}; last messages: ${JSON.stringify(msgs.slice(-4))}; stderr: ${stderr.slice(-400)}`)); }
		}, ms);
	});
	const close = async () => {
		try { send({ t: 'bye' }); } catch (e) { /* already gone */ }
		await sleep(200);
		try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
	};
	return { send, until, close, msgs, get stderr() { return stderr; } };
}

// ── Fixtures ──────────────────────────────────────────────────────────

const PLANTED = 100;	// more than the 64-file budget
const UNDER = 5;		// well under it

/// A mark with `n` files spread over three subdirectories, mirroring the shape
/// `hand/tests/delete_fence.rs` plants.
function plant(mark, n) {
	fs.mkdirSync(mark, { recursive: true });
	for (let i = 0; i < n; i++) {
		const sub = path.join(mark, ['src', 'docs', 'sub/deep'][i % 3]);
		fs.mkdirSync(sub, { recursive: true });
		fs.writeFileSync(path.join(sub, `f${String(i).padStart(3, '0')}.txt`), `file ${i}\n`);
	}
}

/// How many regular files sit under `dir`, not following links.
function filesUnder(dir) {
	let n = 0;
	let names;
	try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
	for (const d of names) {
		const p = path.join(dir, d.name);
		if (d.isSymbolicLink()) continue;
		if (d.isDirectory()) n += filesUnder(p);
		else if (d.isFile()) n += 1;
	}
	return n;
}

/// How many regular files under `dir` hold no bytes at all.
function emptyUnder(dir) {
	let n = 0;
	let names;
	try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
	for (const d of names) {
		const p = path.join(dir, d.name);
		if (d.isSymbolicLink()) continue;
		if (d.isDirectory()) n += emptyUnder(p);
		else if (d.isFile() && fs.statSync(p).size === 0) n += 1;
	}
	return n;
}

/// Every name under `dir` and what it holds -- its type, and for a file its size and a hash of
/// its bytes -- with its mode and modification time kept apart in `meta`. The first half is what
/// a command could destroy. The second is metadata Landlock does not govern at all (`chmod` that
/// only tightens, and the timestamps, both of which the hand's own filter lets through), so (k)
/// measures it and reports it rather than calling it a write.
function snapshot(dir) {
	const names = {}, meta = {};
	const walk = (d) => {
		let list = [];
		try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
		for (const e of list) {
			const p = path.join(d, e.name);
			const rel = path.relative(dir, p);
			let st;
			try { st = fs.lstatSync(p); } catch (x) { continue; }
			if (e.isSymbolicLink()) names[rel] = 'link:' + fs.readlinkSync(p);
			else if (e.isDirectory()) { names[rel] = 'dir'; walk(p); }
			else if (e.isFile()) {
				let body = Buffer.alloc(0);
				try { body = fs.readFileSync(p); } catch (x) { /* a mode the command tightened */ }
				names[rel] = `file:${st.size}:` + crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
			} else names[rel] = 'other';
			meta[rel] = (st.mode & 0o7777).toString(8) + '@' + Math.round(st.mtimeMs);
		}
	};
	walk(dir);
	return { names, meta };
}

/// The keys whose value differs between two snapshots' halves, either way round.
function changedKeys(a, b) {
	const out = [];
	for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (a[k] !== b[k]) out.push(`${k} (${a[k] || 'absent'} -> ${b[k] || 'absent'})`);
	}
	return out;
}

const sameSet = (a, b) => {
	const x = [...new Set(a)].sort(), y = [...new Set(b)].sort();
	return JSON.stringify(x) === JSON.stringify(y);
};

// ── The page's own fence ──────────────────────────────────────────────

/// `examples/command_fence.rs`, which composes a fence with the page's `command_fence` and prints
/// it beside `fence_spec`'s. Built into the slot's `lane-hand` target in the app's DEBUG profile
/// when it is missing or older than the code that composes a fence; refused, never measured,
/// when it is stale under `--no-build`.
function exampleBinary() {
	const target = path.join(os.homedir(), '.cache/cargo-targets', SLOT, 'lane-hand');
	const bin = path.join(target, 'debug/examples/command_fence');
	const src = Math.max(...['src/tools.rs', 'examples/command_fence.rs']
		.map((f) => fs.statSync(path.join(ROOT, f)).mtimeMs));
	let st = null;
	try { st = fs.statSync(bin); } catch (e) { /* not built */ }
	if (st && st.mtimeMs >= src) return { bin, why: 'newer than src/tools.rs' };
	if (NO_BUILD) return { bin: null, why: st
		? 'older than src/tools.rs, and --no-build was passed'
		: 'not built, and --no-build was passed' };
	note('building the command_fence example with rc-build (this can take a while)');
	const lock = path.join(os.homedir(), '.cache/cargo-targets', SLOT, '.build.lock');
	const r = spawnSync('bash', ['-lc',
		`flock ${lock} ~/usr/code/bash/rc-build 4G -- bash -c ` +
		`'CARGO_BUILD_JOBS=4 CARGO_TARGET_DIR=${target} cargo build --offline --example command_fence'`],
		{ cwd: ROOT, stdio: 'inherit' });
	if (r.status !== 0 || !fs.existsSync(bin)) return { bin: null, why: 'the example did not build' };
	return { bin, why: 'built here' };
}

/// The fence the page composes for a hand, from that hand's own `hello`, unscoped or for a
/// Diamond with `marks` attached: `{ command, spec }`, where `command` is what the page sends and
/// `spec` what it sent before the gate.
function fences(exBin, hello, marks = []) {
	const caps = hello.caps || [];
	const root = (caps.find((c) => c.startsWith('root:')) || '').slice(5);
	const status = JSON.stringify({ paired: true, root, caps });
	const r = spawnSync(exBin, [status, ...marks], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`command_fence failed: ${(r.stderr || '').slice(0, 400)}`);
	return JSON.parse(r.stdout);
}

// ── Driving one side ──────────────────────────────────────────────────

/// The turn's start, a safe margin after whatever the caller just planted.
///
/// `hand/tests/delete_fence.rs`'s own `turn()` sleeps 5 ms before reading the
/// clock, for the same reason: a file's `statx` birth time and `since_ms` taken
/// in the same millisecond can round either way, and the meter's step 5
/// (`meter.rs`) reads a file born AT OR AFTER `since_ms` as "born this turn" and
/// frees it — uncounted, unheld, un-trashed. Without this margin, planting
/// `UNDER` files and reading the clock landed close enough that one of five was
/// misread as free on a `rm -rf` that should have counted and removed all five,
/// and the same misreading widened the budget case's "how many are left" by as
/// much as 19 of the PLANTED 100.
async function turnStart() { await sleep(20); return Date.now(); }

/// One hand process for one side, and the `run` every case below goes through.
///
/// The hand's grant, journal, trash and per-run scratch all live under `root`, so
/// nothing here writes into the real `~/.local/share`. `extra` is laid over that
/// environment: a case that needs its own `HOME` or its own trash opens a second
/// hand rather than bending the first.
async function openHand(label, bin, expectFence, root, extra = {}) {
	const env = {
		DAIMOND_HAND_ROOT:        path.join(root, 'grant'),
		DAIMOND_HAND_JOURNAL_DIR: path.join(root, 'journal'),
		DAIMOND_HAND_TRASH_DIR:   path.join(root, 'trash'),
		DAIMOND_HAND_SCRATCH_DIR: path.join(root, 'scratch'),
		...extra,
	};
	for (const k of ['DAIMOND_HAND_ROOT', 'DAIMOND_HAND_JOURNAL_DIR', 'DAIMOND_HAND_TRASH_DIR', 'DAIMOND_HAND_SCRATCH_DIR']) {
		fs.mkdirSync(env[k], { recursive: true });
	}
	const s = session(bin, env);
	// A monotonic read cursor, shared by every wait below. Each `until` starts
	// where the last one left off, so a message this file has already acted on
	// can never be matched a second time — see `session`'s doc comment.
	let cur = 0;
	const nextOf = (pred, ms) => s.until(pred, ms, cur).then(({ msg, index }) => { cur = index + 1; return msg; });
	s.send({ t: 'hello', proto: 2, client: 'verify_handdelete' });
	const hello = await nextOf((m) => m.t === 'hello' || m.t === 'fault' || m.t === 'error');
	// Every hand this file drives, a machine's installed one included, is granted a FIXTURE and
	// nothing else. Read off the hand's own word before anything is sent to it, so a hand that
	// ignored DAIMOND_HAND_ROOT and fell back to its installed grant is refused rather than driven.
	const granted = ((hello.caps || []).find((c) => c.startsWith('root:')) || '').slice(5);
	if (hello.t === 'hello' && granted !== env.DAIMOND_HAND_ROOT) {
		await s.close();
		throw new Error(`${label}: the hand says it is granted ${JSON.stringify(granted)}, not the fixture `
			+ `${env.DAIMOND_HAND_ROOT}, so nothing is sent to it`);
	}
	let seq = 0;

	/// Runs one command to completion, answering a `held` the way `release` says
	/// (`true` waves it through, `false` stops it), and returns what happened.
	///
	/// The exec is the wire's own. `fence` defaults to `{rw, ro}`; `meter` defaults
	/// to the page's field for this turn and is sent to the branch only, since the
	/// base binary predates it — unless `page` is set, which sends exactly what the
	/// page sends, field and all, whichever hand is listening. `meter: null` is a
	/// page older than the meter, which sends no field at all.
	///
	/// **`error` is NOT terminal.** The meter's own belt refusal for a root
	/// (design §4.2 step 3) sends a `Resp::Error` note ALONGSIDE the run's
	/// ordinary `Started`/`Metered`/`Ended` sequence, not instead of it — the
	/// command still ran, and the syscall inside it was the one refused. Ending
	/// the wait on `error` here made this file end a run three messages early,
	/// send the NEXT one while the first was still finishing, and paper over the
	/// gap by matching stray messages against the wrong id forever: measured at
	/// 3.7 GB RSS with no cap. Only `ended` (or a pre-run `refused`) ends a run;
	/// `delete_fence.rs`'s own harness treats `Resp::Error` the same way.
	async function run(argv, cwd, rw, { release = false, sinceMs = null, ro = [], fence = null,
		meter, page = false, answer = true, waitMs = 30000, timeoutMs = 60000 } = {}) {
		if (sinceMs === null) sinceMs = await turnStart();
		const id = `h${++seq}`;
		const m = {
			t: 'exec', id, argv, cwd, env: [], stdin: null, timeout_ms: timeoutMs,
			capture: 'both', fence: fence || { rw, ro, deny: [], net: false }, toolkits: [],
		};
		const field = meter === undefined ? { budget: 64, since_ms: sinceMs } : meter;
		if (field && (expectFence || page)) m.meter = field;
		s.send(m);
		let held = null, metered = null;
		const notes = [];
		let stdout = '', stderr = '';
		for (;;) {
			// `waitMs` is per MESSAGE: an unanswered hold is two minutes of silence between
			// the `held` and the stop that follows it, and (i) waits it out on purpose.
			const r = await nextOf((x) => x.id === id
				&& (x.t === 'held' || x.t === 'metered' || x.t === 'ended' || x.t === 'refused'
					|| x.t === 'error' || x.t === 'chunk'), waitMs);
			if (r.t === 'chunk') {
				if (r.stream === 'err') stderr += String(r.data || ''); else stdout += String(r.data || '');
				continue;
			}
			// `answer: false` is a page with nobody at it: the hold is left for the hand's own
			// clock to end.
			if (r.t === 'held') { held = held || r; if (answer) s.send({ t: 'release', id, allow: release }); continue; }
			if (r.t === 'metered') { metered = r; continue; }
			if (r.t === 'error') { notes.push(r.message || ''); continue; }
			// A settling pause before the caller reads the filesystem. `Ended` is
			// sent the moment the hand's supervisor sees the child exit; a held
			// command's own exit is a `SIGKILL`, and the trash's hard links and the
			// kernel's own last unlinks were observed, on this machine, to still be
			// landing for a short window after that signal — reading `filesUnder`
			// with no pause here undercounted survivors by as much as 20 of the
			// PLANTED 100 files, non-deterministically. `hand/tests/delete_fence.rs`
			// never meets this: it calls `Runner::spawn` and `release` in-process, on
			// the same executor, which is naturally slower to observe `Ended` than a
			// real OS pipe is here.
			if (r.t === 'ended') await sleep(300);
			return { id, term: r, held, metered, notes, sinceMs, stdout, stderr };
		}
	}

	return { hello, grant: env.DAIMOND_HAND_ROOT, trash: env.DAIMOND_HAND_TRASH_DIR, run, nextOf, send: s.send,
		close: () => s.close() };
}

/// Runs every check against one binary. `expectFence` is false for the base
/// binary, where the meter does not exist at all and the assertions invert.
async function driveSide(label, bin, expectFence) {
	console.log(`\n── ${label} (${expectFence ? 'branch, fence expected' : 'base, no fence expected'}) ──`);
	const root = path.join(SCRATCH, label);
	fs.rmSync(root, { recursive: true, force: true });
	const h = await openHand(label, bin, expectFence, root);
	const hello = h.hello;
	check(`${label}: the hand answers the handshake`, hello.t === 'hello', JSON.stringify(hello).slice(0, 200));
	if (hello.t !== 'hello') { await h.close(); return; }
	const grant = h.grant;
	const run = h.run;
	const nextOf = h.nextOf;
	let seq = 0;

	// ── (i) a held command nobody answers is stopped by the hand (F7) ──
	//
	// Every other case answers its hold at once, which is the one thing a real page cannot
	// promise: the person may be away, and the page's own deadline is a page's. So here nothing
	// answers, and the hand's own clock (`meter::HOLD_MS`) must stop the command. Started FIRST, on
	// a hand of its own, and awaited LAST, so its two minutes run beside everything else.
	const unanswered = !expectFence ? null : (async () => {
		const hu = await openHand(label, bin, expectFence, path.join(root, 'unanswered'));
		const mark = path.join(hu.grant, 'mark');
		plant(mark, PLANTED);
		const sinceMs = await turnStart();
		const began = Date.now();
		// The command's own limit well past the hold's, or the run's timeout stops it first and
		// the hand's hold clock is never what is measured.
		const r = await hu.run(['rm', '-rf', path.join(mark, 'src'), path.join(mark, 'docs'), path.join(mark, 'sub')],
			mark, [mark], { sinceMs, answer: false, waitMs: HOLD_MS + 60000, timeoutMs: 3 * HOLD_MS });
		const waited = Date.now() - began;
		const left = filesUnder(mark);
		hu.send({ t: 'restore', id: 'restore-u', since_ms: sinceMs });
		const restored = await hu.nextOf((m) => m.id === 'restore-u' && (m.t === 'restored' || m.t === 'error'), 15000)
			.catch(() => ({ t: '__timeout' }));
		const whole = filesUnder(mark);
		await hu.close();
		return { r, waited, left, restored, whole };
	})();

	// ── (a) a nested mark cannot be removed or moved ────────────────
	//
	// The vulnerable shape from `daimond_hand_delete_fence_design_20260923.md`
	// §2.3: `GRANT` is rw as the unscoped fallback, and `mark` is ALSO named rw
	// in its own right, nested inside it — exactly what a Diamond attached
	// inside the granted root produces. On a fence with no root immunity, `mv`
	// and `rmdir` of `mark` are ordinary operations on a child of `GRANT`; the
	// fix carves `GRANT` down to `Keep` for everything but `mark`'s own siblings.
	{
		const mark = path.join(grant, 'proj');
		plant(mark, 10);
		const rw = [grant, mark];
		const mv = await run(['mv', mark, path.join(grant, 'away')], grant, rw);
		const markSurvivedMv = fs.existsSync(mark) && fs.statSync(mark).isDirectory()
			&& !fs.existsSync(path.join(grant, 'away'));
		if (expectFence) {
			check(`${label}: mv of a nested mark is refused`,
				mv.term.t !== 'ended' || mv.term.exit !== 0, JSON.stringify(mv.term));
			check(`${label}: and the mark is still where it was, whole`,
				markSurvivedMv && filesUnder(mark) === 10, `${markSurvivedMv} ${filesUnder(mark)}/10`);
		} else {
			check(`${label}: (baseline) mv of a nested mark is NOT refused — the vulnerability this fixes`,
				!markSurvivedMv, JSON.stringify(mv.term));
		}

		const empty = path.join(grant, 'empty');
		fs.mkdirSync(empty, { recursive: true });
		const rd = await run(['rmdir', empty], grant, [grant, empty]);
		const emptySurvived = fs.existsSync(empty);
		if (expectFence) {
			check(`${label}: rmdir of an empty nested mark is refused`,
				(rd.term.t !== 'ended' || rd.term.exit !== 0) && emptySurvived, JSON.stringify(rd.term));
		} else {
			check(`${label}: (baseline) rmdir of an empty nested mark is NOT refused`,
				!emptySurvived, JSON.stringify(rd.term));
		}
	}

	// ── (b) more than 64 pre-existing files in one turn is held ─────
	// ── (c) what the meter took is in the trash, and restorable ─────
	{
		const mark = path.join(grant, 'budget');
		plant(mark, PLANTED);
		const sinceMs = await turnStart();
		const r = await run(['rm', '-rf', mark], grant, [grant, mark], { release: false, sinceMs });
		const left = filesUnder(mark);
		if (expectFence) {
			check(`${label}: rm -rf of ${PLANTED} pre-existing files is held once`, !!r.held,
				JSON.stringify(r.term));
			check(`${label}: the hold names the 64-file budget and the mark`,
				!!r.held && r.held.counted === 64 && r.held.mark === mark,
				JSON.stringify(r.held));
			check(`${label}: answering "stop" leaves at least ${PLANTED - 64} files behind`,
				left >= PLANTED - 64, `${left} left of ${PLANTED}`);
			// The stricter half `hand/tests/delete_fence.rs` calls "a file went
			// uncounted": every planted file is either still there or was one of the
			// 64 the meter counted (and so is in the trash) — never neither.
			check(`${label}: and nothing vanished uncounted`,
				left + (r.metered ? r.metered.counted : 0) === PLANTED,
				`${left} left + ${r.metered && r.metered.counted} counted, of ${PLANTED}`);
			check(`${label}: and the meter reports exactly what it counted`,
				!!r.metered && r.metered.counted === 64 && r.metered.stopped === true,
				JSON.stringify(r.metered));

			// (c) restore: what the meter took comes back.
			const rid = `restore-${++seq}`;
			h.send({ t: 'restore', id: rid, since_ms: sinceMs });
			const restored = await nextOf((m) => m.id === rid && (m.t === 'restored' || m.t === 'error'), 15000);
			check(`${label}: the 64 counted removals are restorable`,
				restored.t === 'restored' && restored.restored === 64 && restored.skipped === 0,
				JSON.stringify(restored));
			check(`${label}: and the mark is whole again`,
				filesUnder(mark) === PLANTED, `${filesUnder(mark)}/${PLANTED}`);
		} else {
			// No meter at all: the base binary does not know "held" or "restore".
			check(`${label}: (baseline) rm -rf of ${PLANTED} files is never held — nothing asks`,
				!r.held, JSON.stringify(r.held));
			check(`${label}: (baseline) the whole mark is gone, which is the incident this design fixes`,
				left === 0, `${left} left of ${PLANTED}`);
			const rid = `restore-${++seq}`;
			h.send({ t: 'restore', id: rid, since_ms: sinceMs });
			const said = await nextOf((m) => m.id === rid || m.t === 'error', 15000).catch((e) => ({ t: '__timeout' }));
			check(`${label}: (baseline) restore is not a request this binary knows`,
				said.t !== 'restored', JSON.stringify(said).slice(0, 200));
		}
	}

	// ── (d) a removal under the budget proceeds, asking nothing ─────
	//
	// The CONTENTS are targeted (`src`, `docs`, `sub`), never the mark itself: `rm -rf
	// <mark>` always exits nonzero on the branch, root immunity refusing the final
	// `rmdir` of the mark's own entry regardless of how few files were inside it —
	// `hand/tests/delete_fence.rs`'s own harness never asserts `exit == 0` on a
	// mark-targeted removal for exactly this reason.
	{
		const mark = path.join(grant, 'under');
		plant(mark, UNDER);
		const r = await run(['rm', '-rf', path.join(mark, 'src'), path.join(mark, 'docs'), path.join(mark, 'sub')],
			grant, [grant, mark]);
		check(`${label}: a removal of ${UNDER} pre-existing files (under the budget) is never held`,
			!r.held, JSON.stringify(r.held));
		check(`${label}: and it proceeds — the contents are gone, the mark itself untouched`,
			r.term.t === 'ended' && r.term.exit === 0 && fs.existsSync(mark) && filesUnder(mark) === 0,
			JSON.stringify(r.term));
		if (expectFence) {
			check(`${label}: the meter still reports what it counted, even though nothing was held`,
				!!r.metered && r.metered.counted === UNDER && r.metered.stopped === false,
				JSON.stringify(r.metered));
		}
	}

	// ── (g) a folder kept inside a toolchain cache is metered (audit F5) ──
	//
	// `meter_marks` used to drop every root that merely STARTED WITH a toolchain
	// tail, so a Diamond's folder under `~/.cache/daimond` (the node toolkit's
	// scratch) ran unmetered and `rm -rf` there emptied it. A hand of its own, with
	// HOME pointed at a fixture home, so the tail is a fixture too and the real
	// `~/.cache/daimond` is never touched.
	{
		const home = path.join(root, 'f5-home');
		const mark = path.join(home, '.cache/daimond/proj');
		plant(mark, PLANTED);
		fs.mkdirSync(path.join(home, '.cache/cargo-targets'), { recursive: true });
		const h5 = await openHand(label, bin, expectFence, path.join(root, 'f5'),
			{ HOME: home, DAIMOND_HAND_ROOT: home });
		const r = await h5.run(['rm', '-rf', path.join(mark, 'src'), path.join(mark, 'docs'), path.join(mark, 'sub')],
			mark, [mark]);
		const left = filesUnder(mark);
		if (expectFence) {
			check(`${label}: (F5) rm -rf in a folder kept inside ~/.cache/daimond is held once, at 64`,
				!!r.held && r.held.counted === 64, JSON.stringify(r.held || r.term));
			check(`${label}: (F5) and nothing under it vanished uncounted`,
				!!r.metered && left + r.metered.counted === PLANTED,
				`${left} left + ${r.metered && r.metered.counted} counted, of ${PLANTED}`);
		} else {
			check(`${label}: (baseline, F5) rm -rf there is never held and empties it`,
				!r.held && left === 0, `${left} left of ${PLANTED}`);
		}
		await h5.close();
	}

	// ── (e) a page older than the meter sends no field, and is metered all the same (F7) ──
	//
	// The other half of F2's window: an OLD page on a NEW hand. The exec goes exactly as a page
	// from before the meter sent it -- no `meter` at all -- and the hand meters it as a turn of
	// its own, at the full budget, keyed by a turn start it names in the hold.
	{
		const mark = path.join(grant, 'oldpage');
		plant(mark, PLANTED);
		const r = await run(['rm', '-rf', path.join(mark, 'src'), path.join(mark, 'docs'), path.join(mark, 'sub')],
			mark, [grant, mark], { meter: null, page: true });
		const left = filesUnder(mark);
		if (expectFence) {
			check(`${label}: (e) an exec with no meter field, as an old page sends it, is still held at 64`,
				!!r.held && r.held.counted === 64, JSON.stringify(r.held || r.term));
			check(`${label}: (e) and nothing vanished uncounted`,
				!!r.metered && left + r.metered.counted === PLANTED,
				`${left} left + ${r.metered && r.metered.counted} counted, of ${PLANTED}`);
			const rid = `restore-${++seq}`;
			h.send({ t: 'restore', id: rid, since_ms: r.held ? r.held.since_ms : 0 });
			const back = await nextOf((m) => m.id === rid && (m.t === 'restored' || m.t === 'error'), 15000);
			check(`${label}: (e) and the turn the hand named restores it`,
				back.t === 'restored' && back.restored === 64 && filesUnder(mark) === PLANTED, JSON.stringify(back));
		} else {
			check(`${label}: (baseline, e) with no meter at either end it is never held and empties the folder`,
				!r.held && left === 0, `${left} left of ${PLANTED}`);
		}
	}

	// ── (f) a rename onto a file that was there before the turn counts and keeps it (F3) ──
	{
		const mark = path.join(grant, 'over');
		fs.mkdirSync(mark, { recursive: true });
		const keep = path.join(mark, 'keep.txt');
		fs.writeFileSync(keep, 'precious\n');
		const sinceMs = await turnStart();
		const r = await run(['/bin/sh', '-c', 'echo junk > junk.tmp && mv -f junk.tmp keep.txt'],
			mark, [grant, mark], { sinceMs });
		const now = fs.readFileSync(keep, 'utf8');
		const kept = path.join(h.trash, String(sinceMs), '0', ...keep.split(path.sep).filter(Boolean));
		if (expectFence) {
			check(`${label}: (f) mv -f of a new file over an old one counts the old one, unasked`,
				now === 'junk\n' && !!r.metered && r.metered.counted === 1 && !r.held,
				`${JSON.stringify(now)} ${JSON.stringify(r.metered)}`);
			check(`${label}: (f) and the old bytes are in the trash`,
				fs.existsSync(kept) && fs.readFileSync(kept, 'utf8') === 'precious\n', kept);
		} else {
			check(`${label}: (baseline, f) the old file's bytes are gone and nothing kept them`,
				now === 'junk\n' && !r.metered && !fs.existsSync(kept), JSON.stringify(r.metered));
		}
	}

	// ── (h) THE KNOWN HOLE, pinned: emptying a file in place is not metered (F1) ──
	//
	// `truncate`, `> f`, `dd` and an `O_TRUNC` open lose a file's bytes through no call the
	// meter holds, so nothing is counted, held or kept (`meter.rs` header, design §4.5: Phase 2).
	// This check PASSES WHILE THE HOLE IS THERE. The day the meter learns `O_TRUNC` it fails, and
	// whoever made it fail updates it together with every sentence that states the hole -- the
	// result note in `run_result`, the Dev Guide -- rather than leaving them to go false quietly.
	{
		const mark = path.join(grant, 'hole');
		plant(mark, 80);
		const r = await run(['find', mark, '-type', 'f', '-exec', 'truncate', '-s', '0', '{}', '+'],
			mark, [grant, mark]);
		const emptied = emptyUnder(mark);
		check(`${label}: (h) KNOWN HOLE, Phase 2: emptying 80 pre-existing files in place is neither counted nor held`,
			!r.held && (!r.metered || r.metered.counted === 0) && emptied === 80 && filesUnder(mark) === 80,
			`${emptied} of 80 emptied, held ${!!r.held}, counted ${r.metered ? r.metered.counted : 'none'}`);
	}

	// ── (j) a file the trash cannot link is copied only while small (F6) ──
	//
	// The trash on a second filesystem, so the hard link fails with EXDEV and a copy is the only
	// way to keep a file. Three small files and one of twice `meter::COPY_MAX`: the small ones are
	// copied, counted and restorable; the large one would stall the command and fill the trash, so
	// it is NOT removed -- a removal the trash does not hold could never be put back.
	{
		let xdev = false;
		try {
			fs.mkdirSync(XDEV, { recursive: true });
			xdev = fs.statSync(XDEV).dev !== fs.statSync(SCRATCH).dev;
		} catch (e) { /* no such directory to be had */ }
		if (!xdev) {
			check(`${label}: (j) a trash on a second filesystem exists for the copy case`, false,
				`${XDEV} is not on a different filesystem from ${SCRATCH}; set HD_XDEV_DIR`);
		} else {
			const xtrash = path.join(XDEV, label);
			fs.rmSync(xtrash, { recursive: true, force: true });
			const hx = await openHand(label, bin, expectFence, path.join(root, 'xdev'),
				{ DAIMOND_HAND_TRASH_DIR: xtrash });
			const mark = path.join(hx.grant, 'mark');
			fs.mkdirSync(mark, { recursive: true });
			const small = ['s0.txt', 's1.txt', 's2.txt'].map((n) => path.join(mark, n));
			for (const f of small) fs.writeFileSync(f, 'a small file\n');
			const big = path.join(mark, 'big.bin');
			fs.writeFileSync(big, Buffer.alloc(2 * COPY_MAX, 7));
			const sinceMs = await turnStart();
			const r = await hx.run(['rm', '-f', ...small, big], mark, [mark], { sinceMs });
			const bigLeft = fs.existsSync(big) ? fs.statSync(big).size : -1;
			if (expectFence) {
				check(`${label}: (j) a file over ${COPY_MAX} bytes the trash cannot link is not removed`,
					bigLeft === 2 * COPY_MAX, `big.bin ${bigLeft < 0 ? 'removed' : bigLeft + ' bytes'}`);
				check(`${label}: (j) and the command is told why`,
					r.notes.some((n) => /copies nothing over/.test(n)), JSON.stringify(r.notes).slice(0, 300));
				check(`${label}: (j) while the small ones are copied into the trash, counted and removed`,
					small.every((f) => !fs.existsSync(f)) && !!r.metered && r.metered.counted === 3,
					JSON.stringify(r.metered));
				hx.send({ t: 'restore', id: 'restore-x', since_ms: sinceMs });
				const back = await hx.nextOf((m) => m.id === 'restore-x' && (m.t === 'restored' || m.t === 'error'), 15000);
				check(`${label}: (j) and come back from it`,
					back.t === 'restored' && back.restored === 3 && small.every((f) => fs.existsSync(f)),
					JSON.stringify(back));
			} else {
				check(`${label}: (baseline, j) all four are removed and nothing kept them`,
					bigLeft < 0 && small.every((f) => !fs.existsSync(f)) && !r.metered, `big.bin ${bigLeft}`);
			}
			await hx.close();
			fs.rmSync(xtrash, { recursive: true, force: true });
		}
	}

	if (unanswered) {
		const u = await unanswered;
		const m = u.r.metered;
		check(`${label}: (i) a hold nobody answers stops the command on the hand's own clock`,
			!!u.r.held && u.r.held.counted === 64 && !!m && m.stopped === true && u.waited >= HOLD_MS - 5000,
			`held at ${u.r.held && u.r.held.counted}, metered ${JSON.stringify(m)}, after ${Math.round(u.waited / 1000)} s`);
		check(`${label}: (i) and it took no more than the allowance, nothing uncounted`,
			!!m && u.left === PLANTED - 64 && u.left + m.counted === PLANTED, `${u.left} left of ${PLANTED}`);
		check(`${label}: (i) and the command is told it was stopped`,
			u.r.notes.some((n) => /stopped this command/.test(n)), JSON.stringify(u.r.notes).slice(0, 300));
		check(`${label}: (i) and what it took comes back`,
			u.restored.t === 'restored' && u.restored.restored === 64 && u.whole === PLANTED,
			JSON.stringify(u.restored));
	}

	await h.close();
}

// ── (k) the page's gate (audit F2) ────────────────────────────────────

/// What (k) asks a hand to do, as one shell line. Every step is its own SUBSHELL, so one refusal
/// cannot end the rest: a failed redirection on `:`, a special built-in, makes a POSIX shell exit
/// outright, and a first cut written with `{ ...; }` stopped at step seven and never tried the
/// six after it. Three steps prove the command RAN -- it prints a nonce read from the grant,
/// writes its own scratch, and says it reached the end.
function battery(g) {
	return [
		`cat ${g}/nonce.txt`,
		`echo probe > "$TMPDIR/probe" && echo scratch-ok`,
		`rm -rf ${g}/proj`,
		`rm -f ${g}/top.txt`,
		`mv ${g}/other ${g}/moved`,
		`echo x > ${g}/new.txt`,
		`: > ${g}/other/a.txt`,
		`truncate -s 0 ${g}/top.txt`,
		`mkdir ${g}/newdir`,
		`ln -s top.txt ${g}/link`,
		`cp ${g}/top.txt ${g}/copy.txt`,
		`chmod 600 ${g}/top.txt`,
		`touch -d 2001-01-01 ${g}/top.txt`,
		`echo battery-done`,
	].map((c) => `( ${c} ) 2>/dev/null`).join('; ');
}

/// One hand, sent the fence the PAGE composes from that hand's own `hello`, exactly as the page
/// sends it. `expectMeter` is what the hand should say about itself; a hand that says otherwise
/// is the wrong binary for the side it was put on, and nothing past that is measured.
async function driveGate(label, bin, exBin, expectMeter) {
	console.log(`\n── ${label} (k: the page's fence, composed from this hand's own caps) ──`);
	const root = path.join(SCRATCH, `gate-${label}`);
	fs.rmSync(root, { recursive: true, force: true });
	const h = await openHand(label, bin, expectMeter, root);
	if (h.hello.t !== 'hello') {
		check(`${label}: (k) the hand answers the handshake`, false, JSON.stringify(h.hello).slice(0, 200));
		await h.close();
		return;
	}
	const caps = h.hello.caps || [];
	const metered = caps.includes('meter:deletes');
	check(`${label}: (k) the hand ${expectMeter ? 'says' : 'does not say'} meter:deletes`, metered === expectMeter,
		caps.filter((c) => /^(fence|meter|landlock):/.test(c)).join(' '));
	if (metered !== expectMeter) { await h.close(); return; }
	const g = h.grant;
	const proj = path.join(g, 'proj');
	const nonce = `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	plant(proj, PLANTED);
	fs.writeFileSync(path.join(g, 'nonce.txt'), nonce + '\n');
	fs.writeFileSync(path.join(g, 'top.txt'), 'top\n');
	fs.chmodSync(path.join(g, 'top.txt'), 0o644);
	fs.mkdirSync(path.join(g, 'other'), { recursive: true });
	fs.writeFileSync(path.join(g, 'other/a.txt'), 'a\n');
	let un, mk;
	try {
		un = fences(exBin, h.hello);
		mk = fences(exBin, h.hello, ['proj']);
	} catch (e) {
		check(`${label}: (k) the page's composer answers for this hand`, false, e.message);
		await h.close();
		return;
	}
	if (!expectMeter) {
		check(`${label}: (k) the page gives this hand nothing writable, unscoped or marked`,
			un.command.rw.length === 0 && mk.command.rw.length === 0,
			`unscoped rw ${JSON.stringify(un.command.rw)}, marked rw ${JSON.stringify(mk.command.rw)}`);
		check(`${label}: (k) and every place the fence named is still there to read`,
			sameSet(un.command.ro, [...un.spec.rw, ...un.spec.ro]) && sameSet(mk.command.ro, [...mk.spec.rw, ...mk.spec.ro]),
			`${JSON.stringify(un.command.ro)} for ${JSON.stringify(un.spec.rw)}`);
		const before = snapshot(g);
		const a = await h.run(['/bin/sh', '-c', battery(g)], g, null, { fence: un.command, page: true });
		const b = await h.run(['/bin/sh', '-c', battery(g)], proj, null, { fence: mk.command, page: true });
		const after = snapshot(g);
		check(`${label}: (k) the unscoped command ran as the page sent it: it read the grant and wrote its own scratch`,
			a.term.t === 'ended' && a.stdout.includes(nonce) && a.stdout.includes('scratch-ok') && a.stdout.includes('battery-done'),
			`${a.term.t} ${JSON.stringify(a.stdout).slice(0, 160)}`);
		check(`${label}: (k) and so did the marked one, which cannot read outside its mark`,
			b.term.t === 'ended' && b.stdout.includes('scratch-ok') && b.stdout.includes('battery-done') && !b.stdout.includes(nonce),
			`${b.term.t} ${JSON.stringify(b.stdout).slice(0, 160)}`);
		const lost = changedKeys(before.names, after.names);
		check(`${label}: (k) and neither wrote, created, removed nor renamed ANYTHING under the granted root`,
			lost.length === 0, lost.slice(0, 6).join('; '));
		const meta = changedKeys(before.meta, after.meta);
		note(`${label}: (k) metadata a read-only fence does not govern, measured: ${meta.length ? meta.join('; ') : 'nothing changed'}`);
		// The window the gate closes: the same command, fenced as the page fenced it before.
		// `proj` itself survives, empty: the fence carves the grant around its denied
		// `.daimond`, so the grant's own entries cannot be removed -- but everything inside
		// them can, and that is the incident.
		const c = await h.run(['/bin/sh', '-c', battery(g)], g, null, { fence: un.spec, page: true });
		const gone = changedKeys(after.names, snapshot(g).names);
		check(`${label}: (baseline, k) fenced as the page fenced it BEFORE the gate, the same command empties the folder`,
			c.term.t === 'ended' && filesUnder(proj) === 0 && gone.length >= PLANTED,
			`${gone.length} names changed; ${filesUnder(proj)} of ${PLANTED} files left in proj`);
	} else {
		check(`${label}: (k) a hand that meters is sent the fence it always was`,
			JSON.stringify(un.command) === JSON.stringify(un.spec) && JSON.stringify(mk.command) === JSON.stringify(mk.spec)
				&& mk.command.rw.length > 0,
			JSON.stringify(mk.command.rw));
		const w = await h.run(['/bin/sh', '-c',
			`echo made > ${proj}/made.txt && rm -f ${proj}/src/f000.txt ${proj}/docs/f001.txt && cat ${proj}/made.txt`],
			proj, null, { fence: mk.command, page: true });
		check(`${label}: (k) through the page's fence a command writes, and removes under the budget unasked`,
			w.term.t === 'ended' && w.term.exit === 0 && w.stdout.includes('made') && !w.held
				&& !!w.metered && w.metered.counted === 2,
			`${JSON.stringify(w.term)} ${JSON.stringify(w.metered)}`);
		const had = filesUnder(proj);
		const sinceMs = await turnStart();
		const r = await h.run(['rm', '-rf', path.join(proj, 'src'), path.join(proj, 'docs'), path.join(proj, 'sub')],
			proj, null, { fence: mk.command, page: true, sinceMs });
		const left = filesUnder(proj);
		check(`${label}: (k) and past the budget it is held at 64 and stopped, nothing uncounted`,
			!!r.held && r.held.counted === 64 && !!r.metered && left + r.metered.counted === had,
			`${left} left + ${r.metered && r.metered.counted} counted, of ${had}`);
		h.send({ t: 'restore', id: 'restore-k', since_ms: sinceMs });
		const back = await h.nextOf((m) => m.id === 'restore-k' && (m.t === 'restored' || m.t === 'error'), 15000);
		check(`${label}: (k) and what it took comes back`,
			back.t === 'restored' && back.restored === 64 && filesUnder(proj) === had, JSON.stringify(back));
	}
	await h.close();
}

// ── Run ───────────────────────────────────────────────────────────────

fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });

const branch = process.env.HD_BRANCH_BIN
	? { bin: fs.existsSync(process.env.HD_BRANCH_BIN) ? process.env.HD_BRANCH_BIN : null,
		why: `HD_BRANCH_BIN=${process.env.HD_BRANCH_BIN}` }
	: handBinary(ROOT, 'lane-hand');
check('the branch hand builds and is current', !!branch.bin, branch.why);

let base = { bin: null, why: 'skipped' };
if (process.env.HD_BASE_BIN) {
	base = { bin: fs.existsSync(process.env.HD_BASE_BIN) ? process.env.HD_BASE_BIN : null,
		why: `HD_BASE_BIN=${process.env.HD_BASE_BIN}` };
	check('the base hand (HD_BASE_BIN) is there', !!base.bin, base.why);
} else if (fs.existsSync(BASE_ROOT)) {
	base = handBinary(BASE_ROOT, 'lane-bc-base');
	check('the base hand (../lane-bc-base) builds and is current', !!base.bin, base.why);
} else {
	// No sibling to build from: the base already built in the slot's target, and a FAILED
	// check where there is none. A base comparison that quietly did not run is how this
	// suite read 58 where it reads 66 (2026-09-24).
	const built = path.join(os.homedir(), '.cache/cargo-targets', SLOT, 'lane-bc-base/release/daimond-hand');
	base = { bin: fs.existsSync(built) ? built : null,
		why: `${BASE_ROOT} is not there and HD_BASE_BIN is not set; looked for ${built}` };
	check('the base hand (the slot\'s lane-bc-base build) is there', !!base.bin, base.why);
}

// More hands older than the meter, for (k) alone: by default the one this machine has installed.
const OLD_BINS = (process.env.HD_OLD_BINS !== undefined ? process.env.HD_OLD_BINS : INSTALLED)
	.split(':').filter(Boolean);
for (const b of OLD_BINS) check(`the old hand ${b} is there`, fs.existsSync(b), b);

const ex = exampleBinary();
check('the page\'s fence composer (examples/command_fence) builds and is current', !!ex.bin, ex.why);

try {
	if (branch.bin) await driveSide('branch', branch.bin, true);
	if (base.bin) await driveSide('base', base.bin, false);
	if (ex.bin) {
		if (branch.bin) await driveGate('branch', branch.bin, ex.bin, true);
		if (base.bin) await driveGate('base', base.bin, ex.bin, false);
		for (const [i, b] of OLD_BINS.entries()) {
			if (fs.existsSync(b)) await driveGate(`old${i + 1}`, b, ex.bin, false);
		}
	}
} finally {
	if (!KEEP) {
		fs.rmSync(SCRATCH, { recursive: true, force: true });
		fs.rmSync(XDEV, { recursive: true, force: true });
	} else note(`left fixtures at ${SCRATCH} and ${XDEV}`);
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
