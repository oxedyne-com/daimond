// staleguard.mjs — the one answer to "is the artefact under test this tree's?".
//
// ── The defect this closes ──────────────────────────────────────────
//
// A verifier that measures an artefact somebody's earlier build left behind
// reports on code that no longer exists. Both directions are wrong and only one
// of them is noisy: a false RED wastes a morning, and a false GREEN says a
// boundary holds when nothing has looked at it. Everything here fences a model
// off from a user's filesystem, so the silent one is the one that matters.
//
// It has happened twice in one day, both times because the artefact was reached
// by a hardcoded path and taken on trust:
//
//   * `exec::tests::the_shipping_launcher_fences_a_real_command` execs
//     `hand/target/debug/daimond-hand`, which `cargo test` never builds. With
//     that binary MOVED OFF DISK the suite still reported `193 passed`.
//   * `dev/verify_ptyedge.mjs`, the same shape against `hand/target/release`.
//   * `dev/verify_kitfence.mjs` records the live version of it: with a
//     `CARGO_TARGET_DIR` inherited from the shell, cargo wrote the new binary
//     somewhere else, the test ran the old one, and a security test passed
//     against a binary from before the fix.
//
// ── The oracles ─────────────────────────────────────────────────────
//
// A cargo binary carries its own: the dep-info file `<bin>.d` written beside it
// names every source that went into the link — this crate's and every fe2o3
// crate's — so nothing is hardcoded and a change anywhere upstream counts as
// staleness. [`whyStaleBinary`] reads it.
//
// A wasm bundle does NOT. `www/pkg` is written by wasm-bindgen out of whichever
// cargo target directory the builder happened to have set, and this tree has
// been built into a dozen of them, so the dep-info that describes the shipped
// bundle cannot be found from the bundle. [`whyStaleWasm`] therefore uses the
// coarser oracle `dev/verify_ptyedge.mjs` settled on: EVERY `.rs` under `src/`,
// which is a superset of what a hand-picked list would catch and needs no
// maintenance when a file is added. Its blind spot is a change inside fe2o3,
// which is named here rather than left to be discovered.
//
// Neither returns a boolean. A guard that says only "stale" leaves the reader to
// work out which file and what to run, so each returns the SENTENCE, or '' when
// there is nothing wrong. [`refuse`] is how a caller acts on one.
//
// ── A CLOCK IS A PROXY; CONTENT IS THE PROPERTY ─────────────────────
//
// The property wanted of a bundle is "it was built from THIS source". An mtime
// answers a different question — "was it written after the source was?" — and
// the two part company the moment a bundle legitimately moves between trees.
// `dev/gate.sh` runs the suite in a `git worktree`, and rather than spend a wasm
// build per bisect step it BORROWS the main tree's bundle when the commit under
// test has byte-identical Rust. A fresh checkout stamps every `.rs` with the
// moment it was written, so the borrowed bundle is necessarily older than the
// source it was in fact built from, and from 488f2d5 (2026-08-11) every
// wasm-guarded verifier refused under the gate — three of them for the whole of
// the first full run. Nothing was wrong with either half; the COMPARISON was.
//
// So a bundle may carry a record of the source it was built from: [`certifyWasm`]
// writes `www/pkg/source.json` — a SHA-256 per engine source file, plus one over
// the wasm itself — and [`whyStaleWasm`] prefers it to the clock. The record is
// not taken on trust: the guard rehashes the tree in front of it and compares,
// so a certificate can only vouch for source that is still byte-for-byte what it
// names, and an edit made after it was written is caught exactly as a rebuild
// would be. It names the FILE that differs, which an mtime never could.
//
// Two properties keep the record from becoming a second thing to go stale:
//
//   * It records the bundle's own hash, so a bundle rebuilt by any means at all
//     no longer matches the record beside it. A record about some other bundle is
//     IGNORED, and the clock takes over again — a stale certificate can never
//     launder a stale bundle, and can never false-refuse a fresh one.
//   * It is optional. No record, no cost: an ordinary tree has none, the mtime
//     oracle runs exactly as before, and the developer who edited `web.rs` and
//     forgot to rebuild is refused as they always were.
//
// `dev/build-wasm.sh` writes one too, since 2026-08-13, so the strong oracle
// covers the main tree as well as the gate's worktrees. That is HALF a change,
// and the other half is not optional: `pkg/source.json` is in `EXCLUDE` in
// `verify/lib.mjs`, beside `pkg/package.json`, so a provenance note never enters
// a sealed manifest. A record of when and where a bundle was built moves on
// every build; sealed, it would put a figure nobody else can reproduce inside
// the one artefact whose whole purpose is that a stranger can reproduce it, and
// `dev/repro-check.sh` is what catches that.
//
// What it does NOT do is make a rebuild rarer than it should be. The record is
// SHA-256 per file, and a comment added to `src/web.rs` moves that file's hash
// exactly as a changed fence does. Nothing short of compiling can tell the two
// apart, so a comment still costs a build; what stops costing a build is source
// that did not change at all and only looks like it did.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, posix, bundleHash } from '../verify/lib.mjs';

/// The prerequisites named on one line of a cargo dep-info file.
///
/// Make's escaping, which is what the format is: a backslash makes the character
/// after it ordinary, so a path containing a space survives being split on
/// whitespace. The same reading as `dep_sources` in `hand/src/exec.rs`.
export function depSources(list) {
	const out = [];
	let cur = '', esc = false;
	for (const c of list) {
		if (esc) { cur += c; esc = false; }
		else if (c === '\\') { esc = true; }
		else if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } }
		else { cur += c; }
	}
	if (cur) out.push(cur);
	return out;
}

/// Why the binary at `bin` is not this tree's, or '' when there is no reason.
///
/// # Arguments
/// * `bin` - The artefact under test.
/// * `subject` - What cannot be verified, as the head of a sentence.
/// * `rebuild` - The command that makes the refusal go away.
/// * `what` - What the artefact is, for the sentence. Defaults to `binary`.
///
/// # Returns
/// The refusal, or '' when the binary is newer than every source cargo says
/// went into it.
export function whyStaleBinary(bin, { subject, rebuild, what = 'binary' }) {
	let built;
	try { built = fs.statSync(bin).mtimeMs; }
	catch (e) {
		return `${subject} cannot be verified, because there is no ${what} at ${bin} `
			+ `to verify it against. Run \`${rebuild}\` and try again.`;
	}
	const record = `${bin}.d`;
	let listed;
	try { listed = fs.readFileSync(record, 'utf8'); }
	catch (e) {
		return `${subject} cannot be verified, because ${bin} has no dep-info file at `
			+ `${record}, so there is no record of what went into it and its vintage `
			+ `cannot be established. Run \`${rebuild}\` and try again.`;
	}
	let described = false;
	let newest = null;
	for (const line of listed.split('\n')) {
		const at = line.indexOf(':');
		if (at < 0) continue;
		if (path.resolve(line.slice(0, at).trim()) !== path.resolve(bin)) continue;
		described = true;
		for (const src of depSources(line.slice(at + 1))) {
			let t;
			try { t = fs.statSync(src).mtimeMs; }
			catch (e) {
				return `${subject} cannot be verified, because ${bin} was built from `
					+ `${src}, which can no longer be read, so what is inside the ${what} `
					+ `cannot be established. Run \`${rebuild}\` and try again.`;
			}
			if (!newest || t > newest.t) newest = { src, t };
		}
	}
	if (!described) {
		return `${subject} cannot be verified, because ${record} says nothing about `
			+ `${bin}, so that ${what} is not the one this build produced. Run `
			+ `\`${rebuild}\` and try again.`;
	}
	if (newest && newest.t > built) {
		const by = Math.round((newest.t - built) / 1000);
		return `${subject} would have been verified against a stale ${what}, which proves `
			+ `nothing about it in either direction: ${newest.src} was last changed ${by} `
			+ `second(s) after ${bin} was linked, so that ${what} is not this source. Run `
			+ `\`${rebuild}\` and try again.`;
	}
	return '';
}

/// Every Rust source under `dir`, which is everything the bundle is built from.
export function rustSources(dir) {
	const out = [];
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const f = path.join(dir, ent.name);
		if (ent.isDirectory()) out.push(...rustSources(f));
		else if (ent.name.endsWith('.rs')) out.push(f);
	}
	return out;
}

/// The command that builds the bundle. Named in every wasm refusal, because a
/// verifier that stops without saying what to run has only moved the problem.
export const WASM_REBUILD = 'dev/build-wasm.sh';

/// Where a tree keeps the three things this file needs, relative to its root.
export const SRC_REL	= 'src';
export const PKG_REL	= 'www/pkg';
export const WASM_REL	= 'www/pkg/oxedyne_daimond_bg.wasm';

/// The name of the record a bundle carries about the source it was built from.
/// It sits in the bundle's own directory so that copying the bundle copies its
/// provenance with it.
export const WASM_SOURCE_RECORD = 'source.json';

/// The `{ relpath: sha256 }` map of everything that goes into the bundle.
///
/// The same set the mtime oracle walks — every `.rs` under `src/` — plus
/// `Cargo.toml` and `Cargo.lock`, which decide what is compiled in and which
/// `dev/gate.sh` already compares before it borrows. Paths are relative to
/// `root` and POSIX, so two trees in different directories compare equal.
export function sourceMap(root, srcDir = path.join(root, SRC_REL)) {
	const map = {};
	for (const f of rustSources(srcDir)) {
		try { map[posix(path.relative(root, f))] = sha256(fs.readFileSync(f)); }
		catch (e) { /* removed under us; the next build will say so */ }
	}
	for (const extra of ['Cargo.toml', 'Cargo.lock']) {
		try { map[extra] = sha256(fs.readFileSync(path.join(root, extra))); }
		catch (e) { /* a tree without one is described by not naming it */ }
	}
	return map;
}

/// One figure for a whole engine source tree, by the same algorithm
/// `verify/lib.mjs` fingerprints a bundle with. Two trees agree on it if and
/// only if every file this bundle is built from is byte-identical.
export function sourceHash(root, srcDir) {
	return bundleHash(sourceMap(root, srcDir));
}

/// A path with this machine's home directory written as `~`.
///
/// The record is written into `www/pkg`, and `www/` is what gets rsync'd to the
/// server, so every field in it is served to the public. Nothing COMPARES this
/// one -- `files` and `bundle` are what the guard rehashes, and `from` only ever
/// reaches a sentence a developer reads -- so the tree can be named without
/// naming whoever owns it. `~/usr/.../daimond` and `~/usr/.../daimond-oss` still
/// tell the two trees apart, which is the only thing the sentence needs.
function homeless(p) {
	const home = os.homedir();
	return home && p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

/// Record, beside the bundle in `pkgDir`, the source it was built from.
///
/// `from` is the root of the tree that BUILT it, which is not necessarily the
/// tree the bundle now sits in — that is the whole point when `dev/gate.sh`
/// borrows one. The record also carries the bundle's own hash, so it is silently
/// disregarded the moment that bundle is replaced.
///
/// # Arguments
/// * `pkgDir` - The bundle's directory, `www/pkg`.
/// * `from` - Root of the tree whose source went into it.
/// * `by` - What wrote the record, for the sentence a later refusal prints.
///
/// # Returns
/// The source hash written down.
export function certifyWasm(pkgDir, from, { by = 'dev/gate.sh' } = {}) {
	const files = sourceMap(from);
	const wasm = path.join(pkgDir, path.basename(WASM_REL));
	const record = {
		version:	1,
		source:		bundleHash(files),
		bundle:		sha256(fs.readFileSync(wasm)),
		files,
		from:		homeless(path.resolve(from)),
		by,
		when:		new Date().toISOString(),
	};
	fs.writeFileSync(path.join(pkgDir, WASM_SOURCE_RECORD), JSON.stringify(record, null, '\t') + '\n');
	return record.source;
}

/// The record beside `wasm` if there is one that is about `wasm`, else null.
///
/// A record naming a different bundle hash is not this bundle's, so it is
/// dropped rather than believed: whatever rebuilt the bundle — `wasm-pack` by
/// hand, the mirror, a copy from somewhere else — left the note behind, and a
/// note about a bundle that no longer exists must not be able to speak for the
/// one that does.
export function wasmRecord(wasm) {
	let rec;
	try { rec = JSON.parse(fs.readFileSync(path.join(path.dirname(wasm), WASM_SOURCE_RECORD), 'utf8')); }
	catch (e) { return null; }
	if (!rec || rec.version !== 1 || !rec.files || typeof rec.bundle !== 'string') return null;
	try { if (sha256(fs.readFileSync(wasm)) !== rec.bundle) return null; }
	catch (e) { return null; }
	return rec;
}

/// The first way this tree's source differs from what `rec` names, or '' when
/// it does not differ at all. Sorted, so the same tree always names the same
/// file rather than whichever the filesystem happened to hand back first.
function firstDifference(rec, root, srcDir) {
	const now = sourceMap(root, srcDir);
	for (const rel of Object.keys(rec.files).sort()) {
		if (!(rel in now)) return `${rel} is gone from this tree, though it is in the copy`;
		if (now[rel] !== rec.files[rel]) return `${rel} differs from the copy`;
	}
	for (const rel of Object.keys(now).sort()) {
		if (!(rel in rec.files)) return `${rel} is in this tree and not in the copy`;
	}
	return '';
}

/// Why the wasm bundle at `wasm` is not `srcDir`'s, or '' when there is no
/// reason.
///
/// A hand-picked list of sources is what three of these guards had, and each
/// missed files that changed the same day: `src/wasm/opfs.rs`,
/// `src/wasm/diamond.rs`, `src/prompts.rs`, `src/skills.rs`. So the list is not
/// picked — it is every `.rs` there is.
///
/// Two oracles, in order of strength. A bundle carrying a source record is
/// judged on CONTENT: every file rehashed against what the record names. One
/// without is judged on the clock, as before, which is all there is to go on
/// and enough for the case it was written for — a source edited after the last
/// build, in the tree that build happened in.
///
/// # Arguments
/// * `wasm` - The bundle under test, `www/pkg/oxedyne_daimond_bg.wasm`.
/// * `srcDir` - The engine's source tree, `src/`.
/// * `subject` - What cannot be verified, as the head of a sentence.
/// * `holds` - What lives in the bundle, for the sentence. Optional.
/// * `quiet` - Suppress the line saying a borrowed bundle was accepted.
///
/// # Returns
/// The refusal, or '' when the bundle is this source's.
export function whyStaleWasm(wasm, srcDir, { subject, holds = '', quiet = false }) {
	let built;
	try { built = fs.statSync(wasm).mtimeMs; }
	catch (e) {
		return `${subject} cannot be verified, because there is no wasm bundle at `
			+ `${wasm}${holds ? ` and ${holds} lives in it` : ''}. Run `
			+ `\`${WASM_REBUILD}\` and try again.`;
	}
	const root = path.dirname(srcDir);
	const rec = wasmRecord(wasm);
	if (rec) {
		const diff = firstDifference(rec, root, srcDir);
		if (diff) {
			return `${subject} would have been verified against a stale engine, which proves `
				+ `nothing about it in either direction: ${diff} ${wasm} was built from `
				+ `(${rec.by} recorded ${rec.from} at ${rec.when}), so that bundle is not this `
				+ `source. Run \`${WASM_REBUILD}\` and try again.`;
		}
		// Said out loud, in every log that carries a wasm-guarded verifier: a
		// bundle that was not built here is exactly the thing a reader wants to
		// know about before they read anything else in the file.
		if (!quiet) {
			console.log(`engine: ${wasm} was built from ${rec.from}, not from this tree, and every `
				+ `file it was built from still hashes the same here (${rec.by}, ${rec.when}).`);
		}
		return '';
	}
	let newest = null;
	for (const f of rustSources(srcDir)) {
		let t;
		try { t = fs.statSync(f).mtimeMs; }
		catch (e) { continue; }		// removed under us; the next build will say so
		if (!newest || t > newest.t) newest = { f, t };
	}
	if (newest && newest.t > built) {
		return `${subject} would have been verified against a stale engine, which proves `
			+ `nothing about it in either direction: ${newest.f} was last changed `
			+ `${Math.round((newest.t - built) / 1000)} second(s) after ${wasm} was built, `
			+ `so that bundle is not this source. Run \`${WASM_REBUILD}\` and try again.`;
	}
	return '';
}

/// Whether `wt` can use `main`'s bundle rather than spend a build on its own.
///
/// Two questions, and both must be answered before a bundle is copied anywhere.
/// Is the bundle in `main` this source's at all — because borrowing a stale
/// bundle would carry the staleness into the gate under a certificate saying it
/// is fine. And is `wt`'s engine source byte-for-byte `main`'s. Content both
/// times: what git says about two commits is a good pre-filter and not the
/// property, since the tree the bundle was actually built in is a WORKING tree
/// and may hold things no commit does.
///
/// # Returns
/// `''` when the bundle may be borrowed, else the reason it may not, phrased to
/// be printed after "building this commit's bundle (".
export function whyNotBorrow(main, wt) {
	const wasm = path.join(main, WASM_REL);
	if (!fs.existsSync(path.join(main, PKG_REL, 'oxedyne_daimond.js'))) {
		return 'the main tree has no bundle to lend';
	}
	const stale = whyStaleWasm(wasm, path.join(main, SRC_REL), {
		subject: 'The bundle about to be lent', quiet: true,
	});
	if (stale) return 'the main tree\'s own bundle is not the main tree\'s source';
	const here = sourceMap(wt);
	const there = sourceMap(main);
	for (const rel of new Set([...Object.keys(here), ...Object.keys(there)].sort())) {
		if (here[rel] !== there[rel]) return `${rel} differs from the main tree`;
	}
	return '';
}

/// Print a refusal and stop, or return where there is nothing to refuse.
///
/// Exit 2, never 1: a suite reads 1 as "the code under test is wrong" and this
/// is "nothing was measured". `dev/run_all.sh` reports it as a failure either
/// way, which is right — a verifier that did not run is not a pass.
export function refuse(...reasons) {
	for (const why of reasons) {
		if (!why) continue;
		console.error(why);
		process.exit(2);
	}
}

// ── The same oracle, for a caller that is not JavaScript ────────────
//
// `dev/gate.sh` decides whether to borrow a bundle and then has to live with a
// verifier's opinion of what it decided. Those were two separate pieces of
// reasoning, one in bash about git and one here about clocks, and they
// disagreed. There is one now, and bash asks it:
//
//   node dev/staleguard.mjs hash <root>            # one figure for its engine source
//   node dev/staleguard.mjs borrow <main> <wt>     # '' to borrow, else why not
//   node dev/staleguard.mjs certify <pkgdir> <builtFrom> [by]
//   node dev/staleguard.mjs why-stale <root>       # the refusal a verifier would print
//
// `by` is what a later refusal names as the author of the record, and it is
// worth passing: two things write one now, and "dev/gate.sh recorded this" on a
// bundle `dev/build-wasm.sh` built sends a reader to the wrong file.
//
// Each prints one line or nothing, and exits 0 whatever the answer: the answer
// is the output, and an exit code would only give a caller a second thing to
// read. `why-stale` is the exception — 2 when it refuses, so `gate.sh` can stop
// before a two-hour suite that every wasm-guarded verifier would refuse.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	const [cmd, a, b, c] = process.argv.slice(2);
	switch (cmd) {
	case 'hash':
		console.log(sourceHash(path.resolve(a)));
		break;
	case 'borrow':
		console.log(whyNotBorrow(path.resolve(a), path.resolve(b)));
		break;
	case 'certify':
		console.log(certifyWasm(path.resolve(a), path.resolve(b), c ? { by: c } : {}));
		break;
	case 'why-stale': {
		const root = path.resolve(a);
		const why = whyStaleWasm(path.join(root, WASM_REL), path.join(root, SRC_REL), {
			subject: 'Every verifier in this run that loads the app',
			holds:   'the engine they all measure',
			quiet:   true,
		});
		if (why) { console.log(why); process.exit(2); }
		break;
	}
	default:
		console.error(`staleguard: no such command "${cmd}". `
			+ `Try hash, borrow, certify or why-stale.`);
		process.exit(2);
	}
}
