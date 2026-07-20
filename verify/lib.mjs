// verify/lib.mjs — the canonical shape of a Daimond bundle fingerprint.
//
// Daimond's whole privacy claim is checkable rather than promised: the client
// is public, so anyone can read it, build it, and confirm the code their
// browser is running IS that source. This module is the one definition of how a
// build is fingerprinted, shared by the generator (writes the manifest), the
// verifier (checks a served site against it) and the tests. The browser's own
// `www/js/verify.js` recomputes the SAME fingerprint with Web Crypto, and a test
// asserts the two agree — because a fingerprint two tools compute differently
// verifies nothing.
//
// The algorithm, stated once so it can be reproduced anywhere:
//
//   file hash   = SHA-256(file bytes), lower-case hex.
//   manifest    = each covered file as "<relpath>\n<filehash>\n", relpaths in
//                 POSIX form, sorted byte-wise, concatenated.
//   bundle hash = SHA-256(manifest), lower-case hex — one figure for the whole
//                 served surface, which changes if and only if any file does.
//
// The transparency log chains those bundle hashes so a served build must
// correspond to a public, tamper-evident history — you cannot quietly serve one
// user a different build without it showing up as an entry nobody else has.
//
// No dependencies: Node's own crypto and fs. Plain data in, plain data out, so
// every function here is exercised without a browser or a network.

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/// The files under `www/` that are NOT part of the fingerprint.
///
/// `build.json` carries the staleness id and its own note, which move on their
/// own schedule; `manifest.json` is the fingerprint itself and cannot contain
/// its own hash. Everything else served — every script, style, page and the
/// wasm that is the privacy-critical code — is covered.
export const EXCLUDE = new Set([
	'build.json', 'manifest.json',
	// `releases.json` says which release a user is told they are running. That is
	// editorial, not attestation: the chain attests what CODE shipped, and this
	// only carries the name someone chose for it. It is excluded so a release can
	// be declared on the server -- by an operator pulling the trigger -- without
	// a redeploy, and so that renaming one does not false-fail an honest rebuild.
	// The security claim is untouched: an attacker who could rewrite this could
	// change a label and nothing else, and every byte the browser EXECUTES is
	// still covered.
	'releases.json',
	// wasm-pack packaging metadata, not executed browser code: `pkg/LICENSE` is
	// copied from the crate (so it differs between the proprietary dev build and
	// the FSL public build), `pkg/package.json` carries the wasm-pack version (so
	// it differs between toolchain versions), and `pkg/README.md` is a copy of the
	// crate README (so it changes whenever the README is edited, coupling a prose
	// change to the sealed bundle and false-failing an honest rebuild built after
	// one). Covering any of them would false-fail an honest rebuild. What runs in
	// the browser — the wasm and its .js glue — is covered; these are not.
	'pkg/LICENSE', 'pkg/package.json', 'pkg/README.md',
]);

/// File suffixes left out of the fingerprint: TypeScript type stubs, which the
/// browser never executes and which exist only for editor tooling.
export const EXCLUDE_SUFFIXES = ['.d.ts'];

/// Directory prefixes left out of the fingerprint.
///
/// `vendor/` holds third-party downloadable tooling (the Typst compiler wasm and
/// its fonts) — not built from Daimond's source, and gitignored, so a fresh
/// clone could never reproduce it. It carries its own integrity story as a
/// signed tool-library download. `console/` is the operator console, which is
/// NOT part of the public client (it is pruned from the open-source repo) and
/// which a normal user's browser never loads. What this manifest covers is the
/// user-facing client — every byte of which is public and rebuilds byte-for-byte
/// from that source; so a reader can confirm the code THEIR browser runs is the
/// published source, which is the whole claim.
export const EXCLUDE_DIRS = ['vendor/', 'console/'];

/// The genesis predecessor: a chain's first entry points at nothing.
export const GENESIS_PREV = '0'.repeat(64);

/// SHA-256 of a buffer or string, lower-case hex.
export function sha256(data) {
	return createHash('sha256').update(data).digest('hex');
}

/// A relative path in POSIX form, so a manifest built on Windows and one built
/// on Linux fingerprint identically.
export function posix(rel) {
	return sep === '/' ? rel : rel.split(sep).join('/');
}

/// Every covered file under `root`, as POSIX relpaths, sorted byte-wise.
export async function coveredFiles(root) {
	const out = [];
	async function walk(dir) {
		const ents = await readdir(dir, { withFileTypes: true });
		for (const ent of ents) {
			const p   = join(dir, ent.name);
			const rel = posix(relative(root, p));
			if (ent.isDirectory()) { await walk(p); continue; }
			if (EXCLUDE.has(rel)) continue;
			if (EXCLUDE_DIRS.some(d => rel.startsWith(d))) continue;
			if (EXCLUDE_SUFFIXES.some(s => rel.endsWith(s))) continue;
			out.push(rel);
		}
	}
	await walk(root);
	out.sort();
	return out;
}

/// The `{ relpath: filehash }` map for a directory tree.
export async function hashTree(root) {
	const files = await coveredFiles(root);
	const map = {};
	for (const rel of files) {
		map[rel] = sha256(await readFile(join(root, rel)));
	}
	return map;
}

/// The canonical manifest text for a `{ relpath: filehash }` map: sorted
/// "<relpath>\n<filehash>\n" lines. This is the exact preimage the bundle hash
/// is taken over, and the browser builds the identical string.
export function manifestText(files) {
	const rels = Object.keys(files).sort();
	let s = '';
	for (const rel of rels) s += rel + '\n' + files[rel] + '\n';
	return s;
}

/// The one-figure fingerprint of a whole bundle, from its file map.
export function bundleHash(files) {
	return sha256(manifestText(files));
}

/// The chained hash of one transparency entry. Any change to a past entry —
/// its build, its bundle, its order — moves this, and therefore every entry
/// after it, so a rewritten history cannot stay self-consistent.
export function entryHash({ seq, ts, build, bundle, prev }) {
	return sha256(`${seq}|${ts}|${build}|${bundle}|${prev}`);
}

/// Parse a transparency log (JSON-lines text) into entries, skipping blanks.
export function parseLog(text) {
	return text.split('\n')
		.map(l => l.trim())
		.filter(Boolean)
		.map(l => JSON.parse(l));
}

/// Check a transparency log is a well-formed, unbroken chain from genesis.
///
/// Returns `{ ok, error, seq }`. A log verifies when every entry's `prev` is
/// the entry before it (genesis for the first), its `seq` is its position, and
/// its recomputed `entry` hash matches what is stored. A single altered byte in
/// any past entry fails one of these.
export function verifyChain(entries) {
	let prev = GENESIS_PREV;
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (e.seq !== i) return { ok: false, error: `entry ${i} has seq ${e.seq}`, seq: i };
		if (e.prev !== prev) return { ok: false, error: `entry ${i} does not chain onto ${i - 1}`, seq: i };
		const want = entryHash(e);
		if (e.entry !== want) return { ok: false, error: `entry ${i} hash does not match its contents`, seq: i };
		prev = e.entry;
	}
	return { ok: true, error: '', seq: entries.length };
}

/// The next entry to append to a chain, given the current entries.
export function nextEntry(entries, { ts, build, bundle, note }) {
	const seq  = entries.length;
	const prev = entries.length ? entries[entries.length - 1].entry : GENESIS_PREV;
	const base = { seq, ts, build, bundle, prev };
	// The note rides OUTSIDE the hashed preimage, deliberately. `entryHash`
	// covers seq|ts|build|bundle|prev and nothing else, so a note can be added
	// to an entry -- including one sealed long ago -- without moving its hash,
	// and every entry after it stays valid. What the chain attests is what was
	// shipped; the note is only what a human called it, and it must never be
	// able to invalidate the attestation.
	const out = { ...base, entry: entryHash(base) };
	if (note) out.note = String(note).slice(0, 200);
	return out;
}

/// Compare an expected file map against an actual one, returning the
/// mismatches: files missing from what was served, files served that the
/// manifest does not list, and files whose hash differs.
export function diffFiles(expected, actual) {
	const out = { missing: [], unexpected: [], changed: [] };
	for (const rel of Object.keys(expected)) {
		if (!(rel in actual)) out.missing.push(rel);
		else if (actual[rel] !== expected[rel]) out.changed.push(rel);
	}
	for (const rel of Object.keys(actual)) {
		if (!(rel in expected)) out.unexpected.push(rel);
	}
	return out;
}
