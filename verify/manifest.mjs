// verify/manifest.mjs — seal a built bundle so it can be verified.
//
// Run at deploy time, AFTER `wasm-pack build --target web --out-dir www/pkg`
// and `dev/stamp-build.mjs`, and BEFORE the files leave for the server:
//
//   wasm-pack build --target web --out-dir www/pkg
//   node dev/stamp-build.mjs            # www/build.json — the staleness id
//   node verify/manifest.mjs            # www/manifest.json + transparency entry
//
// It writes `www/manifest.json` — a SHA-256 for every served file and one bundle
// hash over them all — and appends a chained entry to `verify/transparency.jsonl`,
// the public, tamper-evident history of what has been shipped. A verifier
// (verify/check.mjs) then confirms a served site matches the manifest, and that
// the manifest's bundle hash is in the chain. The browser confirms the same of
// itself (www/js/verify.js).
//
// The manifest is a pure function of the bundle: no timestamps, so an identical
// build seals to an identical manifest, and two people who build the source get
// the byte-for-byte same file. When was a build shipped lives in the log's `ts`,
// where it belongs.
//
// No dependencies. `--root <dir>` seals a directory other than www/; `--no-log`
// writes the manifest without touching the chain (for a dry run).

import { readFile, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashTree, bundleHash, parseLog, nextEntry } from './lib.mjs';

const HERE = normalize(join(fileURLToPath(import.meta.url), '..'));
const args = process.argv.slice(2);
const rootArg = (() => { const i = args.indexOf('--root'); return i >= 0 ? args[i + 1] : null; })();
const ROOT = rootArg ? normalize(rootArg) : normalize(join(HERE, '..', 'www'));
const LOG  = join(HERE, 'transparency.jsonl');
const noLog = args.includes('--no-log');

/// The one-line "what changed" from build.json, if it carries one.
async function buildNote() {
	try {
		const j = JSON.parse(await readFile(join(ROOT, 'build.json'), 'utf8'));
		return typeof j.note === 'string' ? j.note.trim() : '';
	} catch (e) { return ''; }
}

/// The staleness id from build.json, so the manifest and the update chip name
/// the same build. Falls back to the head of the bundle hash if it is absent —
/// a seal without a stamp is still a valid seal.
async function buildId(bundle) {
	try {
		const j = JSON.parse(await readFile(join(ROOT, 'build.json'), 'utf8'));
		if (j && typeof j.build === 'string' && j.build) return j.build;
	} catch (e) { /* no stamp: derive one */ }
	return bundle.slice(0, 12);
}

const files  = await hashTree(ROOT);
const bundle = bundleHash(files);
const build  = await buildId(bundle);

const manifest = { algo: 'sha-256', build, bundle, files };
await writeFile(join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 0) + '\n');
console.log(`manifest.json → ${Object.keys(files).length} files, bundle ${bundle.slice(0, 16)}… (build ${build})`);

if (noLog) { console.log('--no-log: chain untouched.'); process.exit(0); }

// Append to the transparency chain, unless this exact bundle is already its tip
// — redeploying an identical bundle is not a new release and must not pad the
// log with a duplicate a verifier would then expect to see served.
let text = '';
try { text = await readFile(LOG, 'utf8'); } catch (e) { text = ''; }
const entries = parseLog(text);
if (entries.length && entries[entries.length - 1].bundle === bundle) {
	console.log(`transparency: bundle already at tip (seq ${entries.length - 1}); nothing appended.`);
	process.exit(0);
}
const ts    = new Date().toISOString();
// The "what changed" line comes from build.json, where dev/stamp-build.mjs put
// it. build.json is overwritten by the next deploy, so the log is where that
// line has to end up if it is to survive -- and the log being the changelog is
// what keeps there from being a second file to maintain and forget.
const entry = nextEntry(entries, { ts, build, bundle, note: await buildNote() });
await writeFile(LOG, text + (text && !text.endsWith('\n') ? '\n' : '') + JSON.stringify(entry) + '\n');
console.log(`transparency: appended seq ${entry.seq} (entry ${entry.entry.slice(0, 16)}…)`);
