// dev/testcfg.mjs -- the real-provider test configuration, read from outside the source tree.
//
// The file holds a live provider key. It used to sit in `dev/.secrets/`, inside the working tree:
// gitignored, and so correctly kept out of every commit, but still copied wherever the tree is
// replicated. It lives in `~/.config/oxedyne/daimond/` now (directory 700, file 600), and every
// reader of it comes through here.
//
// There is no fallback to a path inside the tree, on purpose. A reader that finds the file
// wherever it happens to be is how a key comes to live in a tree again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TESTCFG_VAR = 'DAIMOND_TESTCFG';

/// Where the file is: the absolute path `DAIMOND_TESTCFG` names, else the one under
/// `~/.config/oxedyne/daimond/`.
export function testCfgPath() {
	const named = (process.env[TESTCFG_VAR] || '').trim();
	if (!named) { return path.join(os.homedir(), '.config/oxedyne/daimond/testcfg.json'); }
	if (!path.isAbsolute(named)) {
		throw new Error(`${TESTCFG_VAR} must be an absolute path to the test config, got '${named}'.`);
	}
	return named;
}

/// The parsed file. The messages name the path and say how to set it, and never quote the
/// file: a JSON parse error carries a snippet of the text, and this text is a credential.
export function testCfg() {
	const p = testCfgPath();
	let text;
	try { text = fs.readFileSync(p, 'utf8'); }
	catch (e) {
		throw new Error(`the real-provider test config is not readable at ${p} (${e && e.code || 'error'}). `
			+ `Put it there (directory 700, file 600) or set ${TESTCFG_VAR} to its absolute path. `
			+ `It is kept outside the source tree on purpose, so there is no in-tree default.`);
	}
	try { return JSON.parse(text); }
	catch (e) { throw new Error(`the real-provider test config at ${p} is not valid JSON.`); }
}
