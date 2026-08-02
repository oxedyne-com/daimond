// verify/hand.mjs — seal the machine hand's published source.
//
// The served bundle is sealed by `verify/manifest.mjs`, and the claim it carries is strong: the
// wasm rebuilds byte for byte, so the code a browser runs can be shown to BE the public source.
// The hand cannot make that claim and this file does not pretend otherwise. It is a native binary
// built by whoever installs it, on their own toolchain, on their own machine; there is no
// published binary to compare against, and a Rust release build is not bit-identical across
// toolchain versions anyway.
//
// What can be claimed is narrower and still worth having: **this is exactly the source, and this
// is exactly how it is built.** So this writes `verify/hand.json` — a SHA-256 for every file of
// the published hand, one `source` hash over them all, the pinned toolchain, and the one command
// that turns the first into a binary. A reader who clones the mirror can confirm their copy is
// the sealed one (`node verify/check.mjs --hand`) before they build and install a program that
// runs commands on their computer.
//
//   node verify/hand.mjs                 # seal ../daimond-oss/hand
//   node verify/hand.mjs --root DIR      # some other tree
//   node verify/hand.mjs --no-lock       # do not regenerate the lock first
//
// **It reads the PUBLIC tree, not this one**, for the same reason the bundle is built there: the
// two differ where it matters. This tree's `hand/Cargo.toml` depends on fe2o3 by path, into a
// working copy that exists on no machine but the author's; the mirror's pins it by git revision.
// Sealing the development copy would seal a manifest nobody outside can build, and every reader's
// check would fail against an honest tree. So the order at release time is: carve, seal the hand
// from what the carve produced, carve again to carry `hand.json` across.
//
// Regenerating `Cargo.lock` is part of sealing rather than part of carving. The lock is the
// mirror's own file — it follows from the mirror's git pin, not from this tree's paths — and it
// records the exact dependency versions this release resolved to, which is the difference between
// "the same source" and "the same build inputs".

import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hashTree, bundleHash } from './lib.mjs';

const HERE	= normalize(join(fileURLToPath(import.meta.url), '..'));
const DEV	= normalize(join(HERE, '..'));
const MIRROR	= process.env.MIRROR || normalize(join(DEV, '..', 'daimond-oss'));
const args	= process.argv.slice(2);
const opt	= (name, def = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const ROOT	= resolve(opt('--root', join(MIRROR, 'hand')));
const NO_LOCK	= args.includes('--no-lock');

/// Everything under the hand except its build output. `target/` is its own cargo workspace's, so
/// it does not fall under the root `target/` the rest of the repository ignores.
const EXCLUDE_DIRS = ['target/'];

/// The exact command that turns this source into the binary a browser starts.
///
/// `--manifest-path`, never `-p`: the hand is its own cargo workspace, so `-p daimond-hand` from
/// the repository root fails with "package not found" — which reads like a missing crate rather
/// than like the workspace boundary it is.
const BUILD = 'cargo build --release --manifest-path hand/Cargo.toml';
const BINARY = 'hand/target/release/daimond-hand';

/// The toolchain the repository pins, which is what `rustup` will select for the build above.
async function toolchain(dir) {
	try {
		const text = await readFile(join(dir, 'rust-toolchain.toml'), 'utf8');
		const m = /^\s*channel\s*=\s*"([^"]+)"/m.exec(text);
		return m ? m[1] : '';
	} catch (e) { return ''; }
}

if (!await stat(ROOT).then(s => s.isDirectory(), () => false)) {
	console.error(`no hand to seal at ${ROOT}`);
	console.error(`Carve first — \`node dev/publish.mjs\` — then seal what it produced.`);
	process.exit(2);
}

// The same refusal the carve makes, at the second place it matters. A `path` dependency here
// means the development tree got sealed by mistake, and the resulting hand.json would describe a
// build that resolves only inside one working copy.
{
	const man = await readFile(join(ROOT, 'Cargo.toml'), 'utf8');
	const paths = man.split('\n').filter(l => /^\s*[A-Za-z0-9_-]+\s*=.*\bpath\s*=/.test(l));
	if (paths.length) {
		console.error(`REFUSING TO SEAL ${ROOT}/Cargo.toml — it depends on a path:`);
		for (const l of paths) { console.error(`  ${l.trim()}`); }
		console.error(`\nThat resolves only inside the tree it was written in, so a reader could not build it.`);
		console.error(`Seal the PUBLIC tree: \`node dev/publish.mjs\` rewrites those into git pins.`);
		process.exit(2);
	}
}

if (!NO_LOCK) {
	const r = spawnSync('cargo', ['generate-lockfile', '--manifest-path', join(ROOT, 'Cargo.toml')],
		{ encoding: 'utf8' });
	if (r.status !== 0) {
		console.error(`could not resolve the hand's dependencies, so there is nothing honest to seal:`);
		console.error((r.stderr || '').trim().split('\n').slice(-8).join('\n'));
		console.error(`\n(--no-lock seals the lock already there, if that is what you meant.)`);
		process.exit(1);
	}
	console.log(`Cargo.lock  resolved against ${ROOT}/Cargo.toml`);
}

const files	= await hashTree(ROOT, { exclude: new Set(), excludeDirs: EXCLUDE_DIRS, excludeSuffixes: [] });
const source	= bundleHash(files);
const sealed	= {
	algo:      'sha-256',
	source,
	toolchain: await toolchain(MIRROR),
	build:     BUILD,
	binary:    BINARY,
	files,
};

// Indented and key-sorted, unlike `www/manifest.json`, because this file is READ. A change to the
// hand shows up in a commit diff as the one line that moved, which is the whole point of sealing
// a component nobody can reproduce bit for bit: the record has to be legible to be useful.
await writeFile(join(HERE, 'hand.json'), JSON.stringify(sealed, null, '\t') + '\n');

console.log(`hand.json   → ${Object.keys(files).length} files, source ${source.slice(0, 16)}…`);
console.log(`  toolchain ${sealed.toolchain || '(none pinned)'}`);
console.log(`  build     ${BUILD}`);
console.log(`\nThis seals the SOURCE and the build recipe. It does not seal a binary, and no`);
console.log(`reproducibility is claimed for one — see "The machine hand" in verify/README.md.`);
console.log(`Carry it across with a second \`node dev/publish.mjs\`, then commit both trees.`);
