// dev/stamp-build.mjs — stamp the bundle with a version and a written note.
//
// A browser that loaded Daimond an hour ago has no way to know a new build was deployed. The
// fix is a tiny file, `www/build.json`, whose `build` id changes whenever the shipped code
// changes; `updater.js` reads it, remembers it, and re-reads it to notice a new version.
//
// The id is a content hash over everything under `www/` (the whole bundle, JS + CSS + wasm),
// so it changes if and only if the bundle changes: redeploying identical files does not nag a
// user with a version that is not new. The `note` beside it is the one-line "what changed",
// shown on the chip and carried into the PUBLIC transparency chain.
//
//   node dev/stamp-build.mjs "Faster mail"              write build.json with that note
//   node dev/stamp-build.mjs --check-note "Faster mail" say whether it will do, write nothing
//
// THE NOTE IS REQUIRED, since 2026-08-21. It used to fall back to the latest commit subject,
// and on a release day the latest commit is the one that sealed the LAST release -- so the
// public chain filled up with "The seal as shipped: build 4b59501ce711", a sentence about the
// previous release's bookkeeping, standing where the description of this release should be.
// The fallback is gone rather than fixed: a default that is right some of the time is what
// stops anyone noticing it is wrong the rest of the time.
//
// Run this immediately before bundling www/ for deploy. No dependencies; plain Node.

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, relative, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ── What will not do as a release note ──────────────────────────────────────
//
// WHY A PREDICATE AND NOT A JUDGEMENT. The note is the sentence the public
// transparency chain gives for what a release changed, and the failure it has
// actually suffered is mechanical: an id copied out of the previous release
// standing where a description should be. SIX of the last twenty commit subjects
// in this repo (at fb69f76, 2026-08-21) are `The seal as shipped: build <id>`,
// written by the commit that seals a release -- and every one of them was a
// candidate to become the next release's note while the note defaulted to the
// latest subject.
//
// So the rule is drawn around THAT, and no wider. A note is refused when it
// names a build id, when it is too short to be a sentence, or when it is longer
// than the chip shows. It is NOT refused for containing a word from a list of
// housekeeping words: "Fixed the typo" is a perfectly good release note on the
// release that fixed a typo, and a checker that argues about wording is a
// checker somebody routes around. Measured against this repo's own last twenty
// subjects, the rule refuses those six and accepts the other fourteen; that
// measurement is `dev/verify_deploy.mjs` check 3, run against the real log.
//
// The note may still be a commit subject -- these are good ones -- but it has to
// be CHOSEN. What is gone is the default that chose for you.

/// The build id `contentHash` produces: exactly twelve hex characters.
const ID_RE = /\b[0-9a-f]{12}\b/;

/// The chip and the chain entry both show this much of the note.
export const NOTE_MAX = 120;

/// Why `note` will not do as a release note, as a sentence, or null where it will.
export function noteFault(note) {
	const n = typeof note === 'string' ? note.trim() : '';
	if (!n)                 return 'is empty. It is the one line that says what this release changed.';
	// Before the length rules, so `Build 424677355732` is refused for the reason it
	// is really wrong rather than for being short.
	const id = n.match(ID_RE);
	if (id)                 return `names a build id (${id[0]}). build.json already carries the id in its own `
		+ '`build` field, so a note repeating it says nothing the file does not. Say what changed.';
	if (n.length > NOTE_MAX) return `is ${n.length} characters; the chip and the chain entry show ${NOTE_MAX}. `
		+ 'A note silently cut in half is a transparency chain telling half a truth.';
	if (n.length < 12)      return `is ${n.length} characters. A release note is a sentence, not a tag.`;
	if (n.split(/\s+/).length < 2) return 'is one word. A release note is a sentence, not a tag.';
	return null;
}

const GUIDANCE = 'A release note is what a stranger reading the public transparency chain\n'
	+ 'learns about this release. One line, in a person\'s language, about what changed.';

/// Run only when this file IS the command, so a test can import `noteFault` without
/// stamping a build over the top of the bundle.
const isMain = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
	const args  = process.argv.slice(2);
	const check = args[0] === '--check-note';
	const rest  = check ? args.slice(1) : args;
	if (rest.length > 1) {
		console.error(`stamp-build: ${rest.length} arguments where one note was wanted. Quote it:`);
		console.error(`  node dev/stamp-build.mjs ${check ? '--check-note ' : ''}"${rest.join(' ')}"`);
		process.exit(2);
	}
	const note  = rest[0] ?? '';
	const fault = noteFault(note);
	if (fault) {
		console.error(`stamp-build: that note ${fault}`);
		console.error(GUIDANCE);
		process.exit(1);
	}
	if (check) {
		console.log(`stamp-build: that note will do — ${note}`);
	} else {
		const build = await contentHash();
		await writeFile(STAMP, JSON.stringify({ build, note }) + '\n');
		console.log(`build.json → ${build}  (${note})`);
	}
}
