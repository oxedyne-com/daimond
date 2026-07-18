// verify/check.mjs — confirm a Daimond build is the published source.
//
// This is the trustworthy end of "Don't trust us, check": an independent
// program, run from the source you cloned, that hashes a bundle and confirms it
// matches the manifest AND that the manifest's bundle hash is in the public
// transparency chain. It trusts nothing the server says beyond the bytes it
// serves — the authority is the source in your hands and the chain in the repo.
//
//   Build the source, then check the build you produced:
//     wasm-pack build --target web --out-dir www/pkg
//     node verify/check.mjs --dir www
//
//   Or check the RUNNING site against the chain you cloned:
//     node verify/check.mjs --url https://daimond.oxedyne.com
//
// Green means: every covered file's hash matches the manifest, the bundle hash
// is the manifest's own, and that bundle is a sealed entry in an unbroken chain.
// Red names exactly what differs. Exit 0 on green, 1 on red — so CI can gate on
// it. No dependencies; Node's fetch and crypto only.
//
//   Guard against a roll-back (an older, still-sealed build served in place of a
//   newer one). By default a served bundle that is sealed but not the chain's tip
//   is a warning; make it strict, or pin an exact build:
//     node verify/check.mjs --url … --latest              # fail if not the tip
//     node verify/check.mjs --url … --expect <bundlehash>  # fail if not this one

import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashTree, bundleHash, diffFiles, parseLog, verifyChain, sha256 } from './lib.mjs';

const HERE = normalize(join(fileURLToPath(import.meta.url), '..'));
const args = process.argv.slice(2);
const opt  = (name, def = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const LOG  = normalize(opt('--log', join(HERE, 'transparency.jsonl')));

// The build the caller expects to be served, if they name one. Being in the
// chain proves a bundle was published SOMETIME; it does not prove it is the
// build meant to be live now, so a server (or a stale CDN) could serve an older,
// still-sealed, still-green build -- a rollback. `--expect <bundle>` closes that
// for a caller who knows the current hash (fail on anything else); with no
// `--expect`, a served bundle that is sealed but NOT the chain's tip is reported
// as a warning, and `--latest` promotes that warning to a failure.
const EXPECT = opt('--expect');
const STRICT_LATEST = args.includes('--latest');

const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

/// Read and chain-verify the local transparency log. A broken chain is fatal on
/// its own: if the history is not self-consistent, nothing it contains can be
/// trusted to say what was shipped.
async function loadChain() {
	let text = '';
	try { text = await readFile(LOG, 'utf8'); }
	catch (e) { return { entries: [], chain: { ok: false, error: `no transparency log at ${LOG}` } }; }
	const entries = parseLog(text);
	return { entries, chain: verifyChain(entries) };
}

/// The manifest and the actual file hashes for a LOCAL directory.
async function fromDir(dir) {
	const root = normalize(dir);
	const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
	const actual = await hashTree(root);   // excludes manifest.json + build.json, as the manifest did
	return { manifest, actual };
}

/// The manifest and the actual file hashes for a SERVED origin. Only the files
/// the manifest lists can be fetched — a remote directory cannot be enumerated —
/// so an extra file smuggled onto the server is invisible here; a changed one is
/// not, which is what a delivery check is for.
async function fromUrl(origin) {
	const base = origin.replace(/\/+$/, '');
	const manifest = await (await fetch(base + '/manifest.json')).json();
	const actual = {};
	for (const rel of Object.keys(manifest.files)) {
		const res = await fetch(base + '/' + rel);
		if (!res.ok) continue;   // left absent, so it shows as "missing" below
		actual[rel] = sha256(Buffer.from(await res.arrayBuffer()));
	}
	return { manifest, actual };
}

function report(where, manifest, actual, chain, entries) {
	const problems = [];
	const warnings = [];

	// 1. The manifest's own bundle hash must be the hash of its file list.
	const recomputed = bundleHash(manifest.files);
	if (recomputed !== manifest.bundle) {
		problems.push(`the manifest's bundle hash does not match its own file list`);
	}

	// 2. Every served file must hash to what the manifest says. With (1) holding
	//    and no file missing, changed or unexpected, the served bundle IS the
	//    manifest's bundle -- the single figure the chain is keyed on -- so it is
	//    established here rather than recomputed separately.
	const diff = diffFiles(manifest.files, actual);
	for (const f of diff.changed)    problems.push(`changed: ${f}`);
	for (const f of diff.missing)    problems.push(`missing: ${f}`);
	for (const f of diff.unexpected) problems.push(`unexpected (not in manifest): ${f}`);

	// 3. That bundle must be a sealed entry in an unbroken chain.
	const sealedAt = chain.ok ? entries.findIndex(e => e.bundle === manifest.bundle) : -1;
	if (!chain.ok) {
		problems.push(`transparency chain: ${chain.error}`);
	} else if (sealedAt === -1) {
		problems.push(`the manifest's bundle is not in the transparency log — it was never sealed`);
	}

	// 4. Freshness. A sealed build that is not the chain's tip is an OLDER
	//    published build being served in place of a newer one -- legitimate for a
	//    deliberate roll-back, but indistinguishable from a malicious one, so it
	//    is surfaced. `--expect` pins the exact bundle; `--latest` demands the tip.
	if (EXPECT && manifest.bundle !== EXPECT) {
		problems.push(`served bundle is not the expected one\n        expected ${EXPECT}\n        served   ${manifest.bundle}`);
	}
	if (chain.ok && sealedAt !== -1 && sealedAt !== entries.length - 1) {
		const tip = entries[entries.length - 1];
		const msg = `a newer build has been sealed since this one — you are being served seq ${sealedAt}, but the chain tip is seq ${tip.seq} (bundle ${tip.bundle.slice(0, 16)}…). This is a roll-back unless it was intended.`;
		if (STRICT_LATEST) problems.push(msg); else warnings.push(msg);
	}

	console.log(`\nDaimond delivery check — ${where}`);
	console.log(`  build       ${manifest.build}`);
	console.log(`  bundle      ${manifest.bundle}`);
	console.log(`  files       ${Object.keys(manifest.files).length} covered`);
	console.log(`  chain       ${chain.ok ? green(entries.length + ' entries, intact') : red(chain.error)}`);
	if (EXPECT) console.log(`  expect      ${EXPECT === manifest.bundle ? green('matches') : red('MISMATCH')}`);
	for (const w of warnings) console.log(yellow(`  warning     ${w}`));
	if (problems.length === 0) {
		console.log(green(`\n  OK — this build is the published source, and it was sealed.\n`));
		return true;
	}
	console.log(red(`\n  FAILED — ${problems.length} problem(s):`));
	for (const p of problems.slice(0, 40)) console.log(red(`    · ${p}`));
	console.log('');
	return false;
}

const { entries, chain } = await loadChain();
const dir = opt('--dir', args.includes('--url') ? null : 'www');
const url = opt('--url');

let src;
try {
	src = url ? await fromUrl(url) : await fromDir(dir);
} catch (e) {
	console.error(red(`could not read the bundle to check: ${e.message}`));
	process.exit(2);
}

const ok = report(url || dir, src.manifest, src.actual, chain, entries);
process.exit(ok ? 0 : 1);
