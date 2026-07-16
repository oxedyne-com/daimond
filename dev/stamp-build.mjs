// dev/stamp-build.mjs — stamp the bundle with a version, so a running tab can tell it is stale.
//
// A browser that loaded Daimond an hour ago has no way to know a new build was deployed. The
// fix is a tiny file, `www/build.json`, whose `build` id changes whenever the shipped code
// changes; `updater.js` reads it, remembers it, and re-reads it to notice a new version.
//
// The id is a content hash over everything under `www/` (the whole bundle, JS + CSS + wasm),
// so it changes if and only if the bundle changes: redeploying identical files does not nag a
// user with a version that is not new. The optional `note` is a one-line "what changed", shown
// on the chip; by default it is the subject of the latest daimond commit, which is already
// written in a person's language.
//
//   node dev/stamp-build.mjs                 # note = latest commit subject
//   node dev/stamp-build.mjs "Faster mail"   # note = given text
//
// Run this immediately before bundling www/ for deploy. No dependencies; plain Node.

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, relative, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT  = normalize(join(fileURLToPath(import.meta.url), '..', '..', 'www'));
const STAMP = join(ROOT, 'build.json');

/// Every file under www/, sorted, so the hash is deterministic regardless of walk order. The
/// stamp itself is excluded -- its own id must not depend on the last id.
async function walk(dir, out) {
	for (const ent of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) { await walk(p, out); }
		else if (p !== STAMP)  { out.push(p); }
	}
	return out;
}

/// A short content hash: the relative path and bytes of every file fold into one digest, so a
/// change to any file -- or a rename -- moves the id.
async function contentHash() {
	const files = (await walk(ROOT, [])).sort();
	const h = createHash('sha256');
	for (const f of files) {
		h.update(relative(ROOT, f));
		h.update('\0');
		h.update(await readFile(f));
		h.update('\0');
	}
	return h.digest('hex').slice(0, 12);
}

/// The latest commit subject, as a default "what changed". Empty if git is unavailable.
function latestSubject() {
	try { return execSync('git log -1 --format=%s', { cwd: ROOT }).toString().trim(); }
	catch (e) { return ''; }
}

const build = await contentHash();
const note  = (process.argv[2] || latestSubject() || '').slice(0, 120);
await writeFile(STAMP, JSON.stringify({ build, note }) + '\n');
console.log(`build.json → ${build}${note ? '  (' + note + ')' : ''}`);
