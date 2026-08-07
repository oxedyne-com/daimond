// dev/extdev.mjs — the DEVELOPMENT build of the extension, which is the only one
// that will talk to a page on localhost.
//
// `ext/manifest.json` is the SHIPPED manifest, and it names one origin:
// `https://daimond.oxedyne.com`. It did not always. Until 2026-08-02 it also
// listed `http://127.0.0.1:8777` and `http://localhost:8777`, in
// `externally_connectable` AND in the content-script matches, and both shipped
// to users. A reviewer served a bare hostile HTML page from that port, opened it,
// and completed an exec with a fence of its own choosing. Anything that binds
// 8777 on a user's machine -- a stray dev server, a static server rooted in
// ~/Downloads, another account on a shared box, user-level malware -- was one
// `chrome.runtime.connect` away from running programs as them.
//
// The origins cannot simply be deleted, because local end-to-end testing on
// 127.0.0.1:8777 is how the machine hand is developed. So they live HERE, in a
// generated tree, and never in the file a release is carved from:
//
//	node dev/extdev.mjs		# build it, print the path
//	node dev/extdev.mjs --print	# print the path only, build nothing
//
// The generated tree is a COPY of `ext/`, plus a `manifest.json` that is the
// shipped one with the dev origins added back. It was a symlink farm first,
// which would have made every edit live -- but Chrome will not inject a content
// script whose file resolves outside the extension root, so `announce.js` was
// silently never injected and the page could not find the extension at all. A
// copy, rebuilt on every call, is the version that works.
//
// A developer opts in by loading THAT directory from chrome://extensions
// instead of `ext/`. The pinned key is in the manifest, so the extension id is
// the same either way and the native messaging host's `allowed_origins` needs no
// second entry. After editing anything under `ext/`, run this again before
// pressing Reload -- the copy is what the browser is holding. Every harness
// rebuilds it as it launches, so only a hand-loaded browser needs the habit.
//
// A release is `ext/` exactly as it sits in the tree. `dev/publish.mjs` refuses
// to carve a manifest that names a loopback origin, so the dev variant cannot
// reach the public mirror even if someone patches the shipped file by hand.

import { readdir, readFile, writeFile, mkdir, cp, rm, lstat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT	= normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const EXT	= join(ROOT, 'ext');
// Not /tmp -- it is a tmpfs, and what is written there is RAM charged to this
// machine's agent fleet. See the SCRATCH note in harness.mjs.
const SCRATCH	= process.env.DAIMOND_SCRATCH || join(os.homedir(), '.cache/daimond');
const OUT	= join(SCRATCH, 'ext-dev');

/// The port `dev/serve.mjs` binds, and therefore the one the dev build trusts.
///
/// It follows `DAIMOND_PORT`, so a dev build made inside a numbered world (see
/// `dev/world.sh`) trusts that world's server rather than the default one.
export const DEV_PORT = Number(process.env.DAIMOND_DEV_PORT || process.env.DAIMOND_PORT || 8777);

/// The origins a developer needs and a user must never have.
///
/// Chrome matches the origin STRING, so the two spellings of loopback are two
/// origins and both are needed.
///
/// # Arguments
/// * `port` - Which port, for a test that cannot have the usual one.
export function devOrigins(port = DEV_PORT) {
	return [
		`http://127.0.0.1:${port}/*`,
		`http://localhost:${port}/*`,
	];
}

/// The default pair, for a caller that does not care.
export const DEV_ORIGINS = devOrigins();

/// Anything in the shipped manifest that looks like one of these has been
/// patched by hand, and the point of the split has been lost.
export const LOOPBACK = /(^|\/\/)(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/)/;

/// Reads the shipped manifest, refusing one that already carries a dev origin.
async function shipped() {
	const text = await readFile(join(EXT, 'manifest.json'), 'utf8');
	const pats = [].concat(
		(JSON.parse(text).externally_connectable || {}).matches || [],
		...(JSON.parse(text).content_scripts || []).map((cs) => cs.matches || []));
	const bad = pats.filter((p) => LOOPBACK.test(p));
	if (bad.length) {
		throw new Error(`ext/manifest.json already names ${bad.join(', ')}. That file is what ships: `
			+ `take the loopback origins out of it and let this script add them to the dev build instead.`);
	}
	return JSON.parse(text);
}

/// Builds the dev tree and returns its path.
///
/// # Arguments
/// * `port` - The dev server's port. A test that cannot have the world's -- because
///   a developer is already serving on it -- gets a build of its own rather than
///   fighting for the port.
///
/// # Returns
/// The absolute path to load unpacked.
export async function extDev(port = DEV_PORT) {
	const m		= await shipped();
	const origins	= devOrigins(port);
	const out	= port === DEV_PORT ? OUT : `${OUT}-${port}`;

	m.externally_connectable		= m.externally_connectable || { matches: [] };
	m.externally_connectable.matches	= m.externally_connectable.matches.concat(origins);
	for (const cs of m.content_scripts || []) {
		cs.matches = (cs.matches || []).concat(origins);
	}
	// Nothing else is touched. `name`, `version` and the pinned `key` are the
	// shipped ones, so the extension id is the same in both builds and the
	// native messaging host's allowed_origins needs no second entry -- and a
	// test that reads the manifest reads what a user would.
	await rm(out, { recursive: true, force: true });
	await mkdir(out, { recursive: true });
	for (const ent of await readdir(EXT, { withFileTypes: true })) {
		if (ent.name === 'manifest.json') { continue; }
		await cp(join(EXT, ent.name), join(out, ent.name), { recursive: true });
	}
	await writeFile(join(out, 'manifest.json'), JSON.stringify(m, null, '\t') + '\n');
	return out;
}

/// Whether a path is the extension source directory, so a caller that asked for
/// `ext/` can be handed the dev build instead.
///
/// # Arguments
/// * `p` - The path a test asked to load.
export function isExtSource(p) {
	return !!p && normalize(String(p)).replace(/\/+$/, '') === EXT;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
	if (process.argv.includes('--print')) {
		console.log(OUT);
	} else {
		const where = await extDev();
		await lstat(join(where, 'manifest.json'));
		console.log(where);
		console.error(`Load unpacked from that directory, not from ext/. It adds ${DEV_ORIGINS.join(' and ')} `
			+ `to the shipped manifest and copies everything else. Run this again after editing ext/, then Reload.`);
	}
}
