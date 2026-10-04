// gwbin.mjs — the gateway binary the verifiers drive: whether it is the one the
// source describes, and what it says while they drive it.
//
// Ten verifiers spawn `gateway/target/release/daimond_gateway` and measure what
// it does. None of them checked that it had been built since the code they are
// testing was written, and on 2026-08-10 that binary was three days old: seven
// sources were newer, `secrets.rs` among them, so the operator console asked for
// a view the running gateway had never heard of and got back "Unknown admin view
// 'secrets'". That reads as a console defect. It was a stale build.
//
// SYSTEM.md already warns about the mechanism: agents build with
// `CARGO_TARGET_DIR` pointed at their own slot directory, which leaves
// `gateway/target/release/` holding whatever was last built WITHOUT the
// override -- possibly from days earlier. The warning was written about shipping
// that binary. Testing against it is the same error one step earlier, and it is
// worse, because the suite is the release gate and a gate that measures the
// wrong artefact passes things it never examined.
//
// So this refuses rather than warns. A verifier that runs anyway produces
// numbers about a build nobody is shipping, and those numbers are harder to
// disbelieve than an absent result.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const ROOT  = path.join(HERE, '..');

/// The gateway's source directory.
export const GWDIR = path.join(ROOT, 'gateway');
/// The binary every gateway-driving verifier spawns.
export const GWBIN = path.join(GWDIR, 'target/release/daimond_gateway');

/// Where `dev/run_all.sh` puts the gateway it starts for phase 2.
///
/// A verifier that does NOT start its own -- `verify_passkey_blob` is the one
/// -- has no log of its own to quote, and the reason it was answered 500 is in
/// this file. Named here so the two halves cannot drift apart silently; the
/// script names this constant in return.
export const SUITE_GW_LOG = path.join(
	process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond'), 'suite-gw.log');

/// The pids of the gateway `dev/run_all.sh` started for phase 2, one per line, which
/// its `stop_gateway` stops and nothing else. A verifier that RESTARTS that gateway
/// (`verify_sync` (13b), the only one) writes its new pid here in place of the one it
/// stopped, so the suite still owns what is on its port and stops it at the end of the
/// phase. Until 2026-09-27 it did not: the suite then refused to stop "a gateway this
/// suite did not start", and every later run in that world failed in two seconds on
/// the port it left held.
export const SUITE_GW_PID = path.join(
	process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond'), 'suite-gw.pid');

/// Where a verifier that starts its OWN gateway must start it from.
///
/// The gateway reads `./app.jdat` relative to its working directory, so the
/// directory a verifier spawns it in decides which configuration it gets.
/// `gateway/` holds the DEPLOYED one, and on 2026-08-14 that config's
/// `beta_only` went "false" -> "true" to stop a deploy opening a closed beta.
/// Eleven verifiers spawn their own gateway, every one of them mints a fresh
/// keypair, and a closed beta answers a fresh keypair `403 the beta is closed`
/// -- so eleven went red at "a session exists to begin with" and took the whole
/// offload surface and the passcode minting path down with them.
///
/// `dev/devgw.sh` already builds the answer for `dev/run_all.sh`'s shared phase
/// 2 gateway: the shipped config with the dev flags flipped, beside symlinks to
/// the real keys and the real store. This is that same directory, named here so
/// a verifier's own gateway reads the same config the suite's does. The fix does
/// not belong in `gateway/app.jdat`: production must stay closed.
export const GWCWD = path.join(ROOT, 'dev/devgw');

/// Build `GWCWD`, and refuse to go on if it is not open for registration.
///
/// Loud rather than quiet, for the reason `devgw.sh`'s own `dev_insecure` and
/// `beta_only` checks are loud: if the key is renamed or moved out of the route,
/// the substitution silently does nothing, and the verifier that follows reports
/// a shut door as a broken app. That misdiagnosis is the whole cost being
/// avoided here, so it is not worth trading for a soft failure.
function requireDevGateway() {
	const r = spawnSync('bash', [path.join(ROOT, 'dev/devgw.sh')],
		{ cwd: ROOT, encoding: 'utf8' });
	if (r.status !== 0) {
		console.log('  FAIL dev/devgw.sh could not build the dev gateway directory, so this '
			+ 'would run against the deployed config');
		console.log('       ' + String(r.stderr || r.stdout || '').trim());
		process.exit(1);
	}
	const cfg = path.join(GWCWD, 'app.jdat');
	const txt = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';
	if (!/"beta_only":\s*"false"/.test(txt)) {
		console.log('  FAIL ' + path.relative(ROOT, cfg) + ' is not open for registration, so '
			+ 'every fresh keypair here would be answered 403 the beta is closed');
		console.log('       has "beta_only" moved or been renamed in gateway/app.jdat? '
			+ 'dev/devgw.sh is where it is opened.');
		process.exit(1);
	}
}

/// Open a COPY of the deployed `app.jdat` for registration.
///
/// For the two verifiers that build a gateway directory of their own rather than
/// using `GWCWD` -- they change the listen port, so they cannot share one. Same
/// refusal for the same reason: a substitution that quietly matched nothing is
/// how a shut door gets read as a broken app.
///
/// # Arguments
/// * `cfg` - The text of a copied `app.jdat`.
/// * `who` - The verifier's name, for the message.
///
/// # Returns
/// The same text with `beta_only` set to "false".
export function openBeta(cfg, who) {
	const next = cfg.replace(/"beta_only":\s*"true"/, '"beta_only": "false"');
	if (next === cfg && !/"beta_only":\s*"false"/.test(cfg)) {
		console.log('  FAIL ' + who + ': could not open registration in the copied app.jdat — '
			+ 'has "beta_only" moved or been renamed?');
		process.exit(1);
	}
	return next;
}

/// A log for a process a verifier spawns, and the `stdio` array that fills it.
///
/// Nine verifiers spawned the gateway with `['ignore', 'ignore', 'ignore']`, so
/// when an admin view answered `500 api handler error` the real reason -- which
/// `app_main` had logged next to it, on the way to returning that generic
/// message -- went nowhere at all. This exists so no verifier spells the
/// arrangement out for itself, and so none of them can get it half right.
///
/// BOTH streams, which is the half that was got wrong: the first attempt at
/// this took stderr alone, and fe2o3's log macros write to STDOUT, so the file
/// sat at zero bytes through the very failure it had been written to explain.
///
/// Opened lazily, so a verifier that reuses a process someone else started
/// leaves no empty file to be mistaken for a silent one. Appended rather than
/// truncated, because two of these files restart the gateway to pin an owner,
/// and what the previous process said on its way out is usually the answer.
///
/// It lands under `$DAIMOND_SCRATCH`, so each world keeps its own -- and where
/// that is unset, under the same `~/.cache/daimond` every other dev script
/// uses. NOT the OS temp dir, which the hand-rolled version of this reached
/// for: `/tmp` is a tmpfs here, so anything left there is resident memory
/// charged to the agent fleet's cgroup, and `run_all.sh` says as much at the
/// top of itself.
///
/// # Arguments
/// * `name` - The verifier, which names the file.
/// * `what` - Which process, for a verifier that starts more than one.
export function procLog(name, what = 'gateway') {
	const scratch = process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond');
	const file = path.join(scratch, name + '-' + what + '.log');
	let fd = null;
	const open = () => {
		if (fd === null) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fd = fs.openSync(file, 'a');
		}
		return fd;
	};
	return {
		/// Where it lands, so a failure can name it.
		path: file,
		/// The `stdio` array for `spawn`: both streams into the one file.
		get stdio() { const f = open(); return ['ignore', f, f]; },
		/// Every line, with the terminal colouring taken out.
		///
		/// The gateway writes ANSI escapes because it expects a terminal. Left
		/// in, they make the file awkward to grep and unreadable once a suite
		/// summary has passed it through `tee`.
		lines() {
			let text = '';
			try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
			return text.split('\n')
				.map(l => l.replace(/\u001b\[[0-9;]*m/g, ''))	// a literal escape byte in source is fragile.
				.filter(l => l.trim() !== '');
		},
		/// The last `n` lines, or '' when it said nothing.
		tail(n = 20) { return this.lines().slice(-n).join('\n'); },
		/// The lines that carry a complaint, wherever they are in the file.
		///
		/// A tail alone is not enough and the first run of this proved it: the
		/// gateway explained two 500s at `app_main.rs:448`, then wrote another
		/// thirty seconds of routine dispatch lines over the top of them, so the
		/// last twenty held nothing but chatter. The reason is not usually the
		/// last thing said -- it is the last thing said ABOUT THE FAILURE.
		problems(n = 10) {
			return this.lines()
				.filter(l => /\bWARN\b|\bERRO\b|ERROR|FATAL|panic/.test(l))
				.slice(-n);
		},
		/// Print what it said, indented, under a heading naming the file.
		///
		/// Called on the way out of a failing run. Where this run DID spawn the
		/// process, silence is reported rather than skipped: a gateway that
		/// logged nothing at all is a different diagnosis from one that logged a
		/// reason, and both beat a blank space where the explanation should be.
		/// Where it did not -- a verifier reusing a gateway someone else
		/// started, a dev server already up -- there is nothing to answer for
		/// and nothing is said.
		report(n = 20) {
			if (fd === null) return;
			const t = this.tail(n);
			if (!t) {
				console.log('  ── ' + what + ' wrote nothing to ' + file + ' ──');
				return;
			}
			const why = this.problems();
			if (why.length) {
				console.log('  ── what ' + what + ' complained about, in ' + file + ' ──');
				for (const line of why) console.log('     ' + line);
			}
			console.log('  ── ' + what + ' said (last ' + n + ' lines of ' + file + ') ──');
			for (const line of t.split('\n')) console.log('     ' + line);
		},
	};
}

/// Walk a directory for Rust sources, and say so loudly if it is not there.
///
/// A swallowed `readdirSync` would return nothing, nothing is newer than the
/// binary, and the check passes -- silent success, which is the one failure mode
/// this file exists to prevent.
function walkRust(dir, out) {
	let ents;
	try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
	catch (e) {
		console.log('  FAIL cannot read ' + dir + ' to tell whether the gateway is current — ' + e.message);
		process.exit(1);
	}
	for (const e of ents) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walkRust(p, out);
		else if (e.name.endsWith('.rs')) out.push(p);
	}
}

/// The fe2o3 crates the gateway depends on BY PATH.
///
/// The gateway is built from eleven crates under `rust/fe2o3/` that are not
/// packaged, not versioned and not in any registry: they are the working tree.
/// Editing `fe2o3_steel` and rebuilding nothing leaves the binary as stale as
/// editing `admin.rs` does, and `Cargo.lock` cannot see it -- a path
/// dependency's lock entry does not change when its source does. So the paths
/// are read out of `Cargo.toml` and their sources walked with the gateway's own.
///
/// Loud in both directions, for the reason `walkRust` is: a manifest that
/// cannot be read, or a crate whose sources have moved, yields a SHORTER list,
/// and a shorter list means nothing is newer, which means everything is fine.
/// The one case that is not a crate is a `[[bin]]` target -- `path =
/// "src/app_main.rs"` -- which names a file rather than a directory and is
/// skipped by that shape rather than by whether it happens to exist.
function pathDeps() {
	const toml = path.join(GWDIR, 'Cargo.toml');
	let text = '';
	try { text = fs.readFileSync(toml, 'utf8'); }
	catch (e) {
		console.log('  FAIL cannot read ' + toml + ' to find the crates the gateway is built from — '
			+ e.message);
		process.exit(1);
	}
	const out = [];
	const re = /path\s*=\s*"([^"]+)"/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		if (m[1].endsWith('.rs')) continue;			// a [[bin]] target, not a crate.
		const src = path.resolve(GWDIR, m[1], 'src');
		if (!fs.existsSync(src)) {
			console.log('  FAIL ' + src + ' is named in the gateway\'s Cargo.toml but is not there, '
				+ 'so its changes could not be seen');
			process.exit(1);
		}
		out.push(src);
	}
	return out;
}

/// Every file whose change should mean a rebuild.
function sources() {
	const out = [];
	walkRust(path.join(GWDIR, 'src'), out);
	for (const dir of pathDeps()) walkRust(dir, out);
	for (const f of ['Cargo.toml', 'Cargo.lock']) {
		const p = path.join(GWDIR, f);
		if (fs.existsSync(p)) out.push(p);
	}
	return out;
}

/// Which sources are newer than the built binary, newest first.
///
/// Returns `null` when the binary is not there at all, which is a different
/// message from a stale one and deserves its own.
export function staleSources(bin = GWBIN) {
	if (!fs.existsSync(bin)) return null;
	const built = fs.statSync(bin).mtimeMs;
	return sources()
		.map(p => ({ p, at: fs.statSync(p).mtimeMs }))
		.filter(s => s.at > built)
		.sort((a, b) => b.at - a.at)
		.map(s => path.relative(ROOT, s.p));
}

/// Refuse to measure a gateway that is older than the code under test.
///
/// Called by every verifier that spawns one, before it spawns it. The message
/// names the rebuild command in the form that matters -- `CARGO_TARGET_DIR`
/// unset -- because building it into a slot directory is what leaves this one
/// behind in the first place.
///
/// It checks `GWBIN` and nothing else, because that is the only binary any
/// verifier now runs. `verify_chunkgw` used to prefer whichever of two paths
/// was newer, which would have let one verifier in a gate measure a different
/// build from all the others.
///
/// This is the cheap net for a verifier run by hand. `dev/run_all.sh` builds
/// the gateway once before it runs anything, so the suite should not reach
/// here -- and if it does, an edit landed mid-run and the refusal is right.
///
/// It also builds `GWCWD`, the directory that gateway must be spawned IN, since
/// every caller of this is about to spawn one and none of them should have to
/// remember to ask for it separately.
export function requireFreshGateway() {
	const stale = staleSources(GWBIN);
	if (stale === null) {
		console.log('  FAIL the gateway binary has not been built — ' + path.relative(ROOT, GWBIN));
		console.log('       cd gateway && env -u CARGO_TARGET_DIR cargo build --release');
		process.exit(1);
	}
	if (stale.length === 0) { requireDevGateway(); return; }
	console.log('  FAIL the gateway binary is older than ' + stale.length
		+ ' of its sources, so this would measure a build nobody is shipping');
	console.log('       newest first: ' + stale.slice(0, 5).join(', ')
		+ (stale.length > 5 ? ', …' : ''));
	console.log('       cd gateway && env -u CARGO_TARGET_DIR cargo build --release');
	process.exit(1);
}

/// Stop a gateway this run started so that its store is CLOSED, not abandoned.
///
/// `gateway/src/app_main.rs:743` says what a SIGKILL costs and says it about
/// this caller: "a harness that kills a database process outright is choosing
/// the torn tail on purpose". `Database::insert` returns on the cache bot's
/// acknowledgement, not the file bot's, so whatever is in flight at the moment
/// of the kill is in memory and not on disk, and the next process to read that
/// prefix meets a data file whose last record fails its checksum. The gateway
/// answers SIGTERM by returning from the accept loop and calling `Store::close`
/// (`app_main.rs:850`), which is the whole of the difference.
///
/// The cost is real and is why this is a signal and not a wish: closing a 3.4 GB
/// store takes seconds, so a run that must have the port back waits for it. The
/// SIGKILL is still here as the last resort, and when it is reached it SAYS so
/// -- a torn tail that nobody was told about is how one came to sit in the
/// shared dev store from 2026-08-25 until somebody read a gateway log.
///
/// # Arguments
/// * `proc`   - The child this run spawned, never a pid found by searching.
/// * `health` - The gateway's `/api/health` URL, waited on so the port is free
///              before anything binds it again.
/// * `ms`     - How long to allow the close before falling back to SIGKILL.
///
/// # Returns
/// A line naming what went wrong, or `''` where the store closed on its own.
export async function stopGatewayCleanly(proc, health, ms = 45000) {
	const nap = (t) => new Promise(r => setTimeout(r, t));
	const gone = () => proc.exitCode !== null || proc.signalCode !== null;
	if (!proc || gone()) return '';
	let note = '';
	try { proc.kill('SIGTERM'); } catch (e) { return `gateway pid ${proc.pid}: ${e.message}`; }
	for (let waited = 0; waited < ms && !gone(); waited += 100) await nap(100);
	if (!gone()) {
		try { proc.kill('SIGKILL'); } catch (e) { /* it may have gone between the two */ }
		note = `  note  the gateway did not close its store within ${Math.round(ms / 1000)}s `
			+ 'and was killed; a record written just before the stop may have a torn tail';
		await nap(500);
	}
	// The port, not the process: a gateway started on the strength of a kill
	// that had returned meets `AddrInUse` and dies, and the run that follows
	// measures nothing.
	for (let waited = 0; waited < 15000; waited += 200) {
		try { await fetch(health); } catch (e) { return note; }
		await nap(200);
	}
	return note || `  note  something is still answering ${health} after the gateway was stopped`;
}
